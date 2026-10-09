import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import type { Agent } from '../src/domain/types.js';
import type { ExecResult } from '../src/providers/provider.js';
import { accessAlertOf, accessOverview, accessProbeScript, verifyAgentAccess } from '../src/orchestrator/accessOverview.js';
import { syncConnections } from '../src/orchestrator/googleConnections.js';
import { PAIRING_DB } from '../src/orchestrator/claim.js';
import vm from 'node:vm';
import nodePath from 'node:path';
import nodeCrypto from 'node:crypto';

/**
 * The access overview (docs/access-overview-design.md): what each agent can
 * reach, intended against last verified, pending removals, and the limits.
 * gog and the in-container probe are faked at the provider's execShell.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const OTHER = 'user-other';
const H = { 'x-hatchabot-owner': OWNER };
const HO = { 'x-hatchabot-owner': OTHER };
// Made-up values, nothing shaped like a real credential.
const BOT_VALUE = 'fixture-bot-value-one';
const ENV_VALUE = 'fixture-env-value-one';
const REFRESH_VALUE = 'fixture-refresh-value';
const KEY_VALUE = 'fixture-deploy-key-text';
const hash16 = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 16);
const tgId = (n: number) => String(50_000 + n);

interface Inside {
  gog: string[] | null;
  channels: Record<string, { enabled: boolean; accounts: Record<string, { enabled: boolean; h: string | null }> }>;
  env: Record<string, boolean>;
  paths: Record<string, boolean>;
  admitted: Record<string, string[]>;
  probeFails?: boolean;
  /** Run the real generated probe in an isolated VM against this made-up container instead of faking its output. */
  vm?: VmInside;
}

/** A made-up container for the real probe code: files by path, an error code per unreadable path, and node:sqlite. */
interface VmInside {
  files: Record<string, string>;
  dirs: Record<string, string[]>;
  /** A path whose read or stat fails with this code (EACCES, …). */
  fail?: Record<string, string>;
  /** The pairing store's rows, or the error opening it throws (node:sqlite unavailable, unreadable, …). */
  sqlite: Array<{ channel_key: string; entry: string }> | { throws: string } | { queryThrows: string };
}

const STATE = '/home/node/.openclaw';
/** Run the generated probe exactly as it would run in the container, in a VM with a fake fs and node:sqlite. */
function runProbeInVm(script: string, c: VmInside): string {
  const m = /^HB_ACCESS_PROBE=([A-Za-z0-9+/=]+) node -e '([^']*)'$/.exec(script);
  if (!m) throw new Error('probe script not in the expected form');
  const err = (code: string, p: string) => Object.assign(new Error(`${code}: ${p}`), { code });
  const check = (p: string) => { if (c.fail?.[p]) throw err(c.fail[p]!, p); };
  const fs = {
    readFileSync: (p: string) => { check(p); if (p in c.files) return c.files[p]; throw err('ENOENT', p); },
    readdirSync: (p: string) => { check(p); if (p in c.dirs) return c.dirs[p]; throw err('ENOENT', p); },
    statSync: (p: string) => { check(p); if (p in c.files || p in c.dirs) return { isFile: () => p in c.files }; throw err('ENOENT', p); },
    existsSync: (p: string) => { try { check(p); } catch { return false; } return p in c.files || p in c.dirs; },
  };
  const sqlite = {
    DatabaseSync: class {
      constructor() { if ('throws' in c.sqlite) throw err('ERR_SQLITE_ERROR', c.sqlite.throws); }
      prepare() {
        const s = c.sqlite;
        return { all: () => { if ('queryThrows' in s) throw err('ERR_SQLITE_ERROR', s.queryThrows); return s as Array<{ channel_key: string; entry: string }>; } };
      }
      close() {}
    },
  };
  const mods: Record<string, unknown> = { fs, path: nodePath, crypto: nodeCrypto, 'node:sqlite': sqlite };
  let out = '';
  vm.runInNewContext(m[2]!, {
    require: (n: string) => { if (!(n in mods)) throw new Error(`module ${n} not in the fake container`); return mods[n]; },
    process: { env: { HB_ACCESS_PROBE: m[1] }, stdout: { write: (x: string) => { out += x; return true; } } },
    Buffer,
  });
  return out;
}

async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  const secrets = new MemSecrets();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Household AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAIProfile({ id: 'p2', ownerId: OTHER, name: 'Other AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p2', createdAt: 'now' });
  const mk = async (id: string, ownerId: string, aiProfileId: string, name: string) => {
    store.insertAgent({ id, ownerId, name, slug: id, state: 'PROVISIONING', aiProfileId, hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as unknown as Agent);
    const { runtimeRef } = await provider.provision({ agentId: id, slug: id, workspace: { files: {}, configPatch: { agentId: id, authMode: 'api-key' } }, env: {} } as never);
    store.setAgentRuntimeRef(id, runtimeRef);
    store.setAgentState(id, 'RUNNING');
  };
  await mk('a1', OWNER, 'p1', 'Test Agent');
  await mk('b1', OTHER, 'p2', 'Other Agent');

  // What Hatchabot intends for a1: a Google account, a Telegram bot, a folder, a private repo, a variable, members.
  await secrets.put('google-oauth/client', JSON.stringify({ clientId: 'cid.example.org', clientSecret: 'FAKE-FIXTURE-VALUE' }));
  await secrets.put('connection/c1', REFRESH_VALUE);
  await secrets.put('connection/c2', REFRESH_VALUE);
  store.insertConnection({ id: 'c1', ownerId: OWNER, kind: 'google', email: 'mail@example.org', services: ['gmail'], secretRef: 'connection/c1' });
  store.insertConnection({ id: 'c2', ownerId: OWNER, kind: 'google', email: 'drive@example.org', services: ['drive'], secretRef: 'connection/c2' });
  store.attachConnection('a1', 'c1', true);
  await secrets.put('channel/a1/bot', BOT_VALUE);
  store.insertChannel({ id: 'ch1', agentId: 'a1', kind: 'telegram', accountId: 'TestAgentBot', secretRef: 'channel/a1/bot', deepLink: 'https://t.me/TestAgentBot', createdAt: 'now' } as never);
  store.insertDataSource({ id: 'd1', agentId: 'a1', kind: 'folder', access: 'ro', mountName: 'recipes', hostPath: '/srv/example/recipes', createdAt: 'now' } as never);
  await secrets.put('ds/d2', KEY_VALUE);
  store.insertDataSource({ id: 'd2', agentId: 'a1', kind: 'git', access: 'rw', mountName: 'notes', repoUrl: 'git@example.org:house/notes.git', secretRef: 'ds/d2', createdAt: 'now' } as never);
  await secrets.put('env/a1/SEARCH_KEY', ENV_VALUE);
  store.insertAgentEnv({ id: 'e1', agentId: 'a1', name: 'SEARCH_KEY', secretRef: 'env/a1/SEARCH_KEY', createdAt: 'now' });
  store.insertMembership({ id: 'm0', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active' } as never);
  store.bindMembershipChannelUser('a1', OWNER, tgId(1));
  store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u-sam', role: 'member', displayName: 'Sam', channelUserId: tgId(2), status: 'active' } as never);

  // What is inside a1's container, as gog and the probe would report it.
  const inside: Inside = {
    gog: ['mail@example.org'],
    channels: { telegram: { enabled: true, accounts: { TestAgentBot: { enabled: true, h: hash16(BOT_VALUE) } } } },
    env: { SEARCH_KEY: true },
    paths: { '/data/recipes': true, '/home/node/.openclaw/notes': true, '/home/node/.openclaw/.ssh/notes_deploy': true },
    admitted: { telegram: [tgId(1), tgId(2)] },
  };
  const scripts: string[] = [];
  provider.execShell = (async (_ref: string, script: string): Promise<ExecResult> => {
    scripts.push(script);
    if (script.includes('gog auth list')) {
      return inside.gog ? { code: 0, stdout: JSON.stringify({ accounts: inside.gog.map((email) => ({ email })) }), stderr: '' } : { code: 1, stdout: '', stderr: 'no gog' };
    }
    if (script.includes('gog auth remove')) {
      const email = /remove --force -- "([^"]+)"/.exec(script)![1]!;
      if (inside.gog) inside.gog = inside.gog.filter((e) => e !== email);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (script.includes('gog auth import')) {
      const email = /--email "([^"]+)"/.exec(script)![1]!;
      if (inside.gog && !inside.gog.includes(email)) inside.gog.push(email);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (script.startsWith('HB_ACCESS_PROBE=')) {
      if (inside.probeFails) return { code: 1, stdout: '', stderr: 'boom' };
      if (inside.vm) return { code: 0, stdout: runProbeInVm(script, inside.vm), stderr: '' };
      const input = JSON.parse(Buffer.from(/^HB_ACCESS_PROBE=([A-Za-z0-9+/=]+) /.exec(script)![1]!, 'base64').toString('utf8')) as { paths: string[]; env: string[] };
      return {
        code: 0, stderr: '',
        stdout: JSON.stringify({
          config: true, channels: inside.channels, admitted: inside.admitted, unread: { telegram: [], slack: [], discord: [] },
          env: Object.fromEntries(input.env.map((n) => [n, !!inside.env[n]])),
          paths: Object.fromEntries(input.paths.map((p) => [p, !!inside.paths[p]])),
        }),
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  }) as typeof provider.execShell;

  const f = Fastify();
  await registerRoutes(f, {
    store, secrets, providers: new Map([['mock', provider]]),
    channel: { pool: { availableCount: () => 0, owns: () => false }, release: async () => {} } as never,
  } as never);
  const deps = { store, secrets, provider };
  const rows = (a: string) => accessOverview(store, store.getAgent(a)!).groups.flatMap((g) => g.rows);
  const row = (a: string, kind: string, subject: string) => rows(a).find((r) => r.kind === kind && r.subject === subject);
  return { store, provider, secrets, f, inside, scripts, deps, rows, row };
}

afterEach(() => { vi.useRealTimers(); });

describe('Verify now records what is inside the running agent', () => {
  it('everything intended and found: ✓ with a time, nothing to raise', async () => {
    const w = await world();
    const r = await verifyAgentAccess(w.deps, 'a1');
    expect(r.status).toBe('checked');
    for (const [kind, subject] of [['google', 'mail@example.org'], ['telegram', 'TestAgentBot'], ['folder', '/data/recipes'], ['repo', 'notes'], ['repo-key', 'notes'], ['env', 'SEARCH_KEY'], ['person', OWNER], ['person', 'u-sam']]) {
      const x = w.row('a1', kind!, subject!);
      expect(x, `${kind} ${subject}`).toBeDefined();
      expect(x!.verified.status, `${kind} ${subject}`).toBe('present');
      expect(x!.verified.at).toBeTruthy();
      expect(x!.mismatch).toBeUndefined();
    }
    const ov = accessOverview(w.store, w.store.getAgent('a1')!);
    expect(ov.summary.mismatches).toBe(0);
    expect(ov.checkedAt).toBeTruthy();
    expect(accessAlertOf(ov)).toBeUndefined();
    // The limits are said in words.
    expect(ov.notChecked.join(' ')).toMatch(/saved for itself in its workspace/);
  });

  it('the probe carries only paths and names in, and no secret: the token is compared by a hash computed inside', async () => {
    const w = await world();
    await verifyAgentAccess(w.deps, 'a1');
    const probe = w.scripts.find((s) => s.startsWith('HB_ACCESS_PROBE='))!;
    for (const secret of [BOT_VALUE, ENV_VALUE, REFRESH_VALUE, KEY_VALUE, hash16(BOT_VALUE)]) expect(probe).not.toContain(secret);
    const input = JSON.parse(Buffer.from(/^HB_ACCESS_PROBE=([A-Za-z0-9+/=]+) /.exec(probe)![1]!, 'base64').toString('utf8'));
    expect(input).toEqual({ paths: ['/data/recipes', '/home/node/.openclaw/notes', '/home/node/.openclaw/.ssh/notes_deploy'], env: ['SEARCH_KEY'] });
    // The script itself never prints a value: only hash prefixes, booleans and ids.
    expect(accessProbeScript({ paths: [], env: [] })).toContain('digest("hex").slice(0,16)');
    expect(accessProbeScript({ paths: [], env: [] })).not.toMatch(/process\.env\[n\]\b(?!\))/);
  });

  it('finds what it should not have: a connection not attached, another bot, a different token, a removed variable, a removed member', async () => {
    const w = await world();
    await verifyAgentAccess(w.deps, 'a1'); // a first check records SEARCH_KEY present
    w.store.deleteAgentEnv('a1', 'e1'); // removed in Hatchabot; the running container still has it
    w.store.revokeMembership('a1', 'u-sam');
    w.inside.gog = ['mail@example.org', 'drive@example.org', 'self@example.org'];
    w.inside.channels.telegram!.accounts = { TestAgentBot: { enabled: true, h: hash16('another-value') }, OldBot: { enabled: true, h: null } };
    w.inside.paths['/data/recipes'] = false;
    await verifyAgentAccess(w.deps, 'a1');
    expect(w.row('a1', 'google', 'drive@example.org')).toMatchObject({ intended: false, managed: true, mismatch: 'extra' });
    // An account the agent added itself: shown, not managed, not an alert.
    expect(w.row('a1', 'google', 'self@example.org')).toMatchObject({ intended: false, managed: false });
    expect(w.row('a1', 'google', 'self@example.org')!.mismatch).toBeUndefined();
    expect(w.row('a1', 'telegram', 'TestAgentBot')).toMatchObject({ intended: true, mismatch: 'differs' });
    expect(w.row('a1', 'telegram', 'OldBot')).toMatchObject({ intended: false, mismatch: 'extra' });
    expect(w.row('a1', 'env', 'SEARCH_KEY')).toMatchObject({ intended: false, mismatch: 'extra' });
    expect(w.row('a1', 'person', 'u-sam')).toMatchObject({ intended: false, mismatch: 'extra' });
    expect(w.row('a1', 'folder', '/data/recipes')).toMatchObject({ intended: true, mismatch: 'missing' });
    const al = accessAlertOf(accessOverview(w.store, w.store.getAgent('a1')!))!;
    expect(al.line).toMatch(/drive@example\.org: still there/);
    expect(al.line).toMatch(/a different bot token is running/);
    expect(al.line).not.toMatch(/self@example\.org/); // not Hatchabot's to judge
    expect(al.line).not.toMatch(/recipes/); // missing is ⚠ in the section, not an alert
  });

  it('people OpenClaw admits with no member in Hatchabot show as not managed', async () => {
    const w = await world();
    w.inside.admitted = { telegram: [tgId(1), tgId(2), tgId(7), tgId(8)] };
    await verifyAgentAccess(w.deps, 'a1');
    expect(w.row('a1', 'person-unknown', 'telegram')).toMatchObject({ managed: false, label: '2 other people on Telegram' });
  });

  it('a member\'s id is looked for only on the chat apps it is on now: web-only, nothing is "not found" (no false ⚠)', async () => {
    const w = await world();
    w.store.deleteChannelForAgent('a1', 'all');
    expect(w.store.listChannelsForAgent('a1')).toEqual([]);
    w.inside.admitted = {};
    w.inside.channels = {};
    await verifyAgentAccess(w.deps, 'a1');
    expect(w.row('a1', 'person', OWNER)!.mismatch).toBeUndefined();
    expect(w.row('a1', 'person', OWNER)!.verified.status).toBe('unknown');
  });

  it('not checkable: stopped, asleep, or its machine not answering — the last results and their times stay', async () => {
    const w = await world();
    await verifyAgentAccess(w.deps, 'a1');
    const before = w.row('a1', 'google', 'mail@example.org')!.verified;
    w.store.setAgentState('a1', 'STOPPED');
    expect(await verifyAgentAccess(w.deps, 'a1')).toEqual({ status: 'not-checkable', reason: 'it is stopped — start it to check' });
    w.store.setAgentState('a1', 'RUNNING');
    (w.provider as unknown as { reachable: () => Promise<boolean> }).reachable = async () => false;
    expect(await verifyAgentAccess(w.deps, 'a1')).toEqual({ status: 'not-checkable', reason: 'its machine is asleep or offline' });
    expect(w.row('a1', 'google', 'mail@example.org')!.verified).toEqual(before);
  });

  it('half a check: gog answers, the probe does not — Google is recorded, the rest is said to be skipped', async () => {
    const w = await world();
    w.inside.probeFails = true;
    const r = await verifyAgentAccess(w.deps, 'a1');
    expect(r).toMatchObject({ status: 'checked' });
    expect((r as { skipped?: string[] }).skipped?.join(' ')).toMatch(/could not read inside it/);
    expect(w.row('a1', 'google', 'mail@example.org')!.verified.status).toBe('present');
    expect(w.row('a1', 'env', 'SEARCH_KEY')!.verified.status).toBe('unknown');
  });
});

describe('an admission source that cannot be read is no proof that nobody is admitted (#23)', () => {
  /** a1's container as the real probe sees it: a readable openclaw.json admitting the owner; the pairing store as given. */
  const container = (sqlite: VmInside['sqlite'], extra: Partial<VmInside> = {}): VmInside => ({
    files: {
      [`${STATE}/openclaw.json`]: JSON.stringify({ channels: { telegram: { accounts: { TestAgentBot: { enabled: true, botToken: BOT_VALUE, allowFrom: [tgId(1)] } } } } }),
      [PAIRING_DB]: '',
      '/data/recipes': '', '/home/node/.openclaw/notes': '', '/home/node/.openclaw/.ssh/notes_deploy': '',
      ...extra.files,
    },
    dirs: { ...extra.dirs }, // no credentials folder: no legacy allowlist files
    sqlite,
    ...(extra.fail ? { fail: extra.fail } : {}),
  });
  /** A revoked member OpenClaw still admits: the overview flags the extra access. */
  const revokedButAdmitted = async () => {
    const w = await world();
    await verifyAgentAccess(w.deps, 'a1');
    w.store.revokeMembership('a1', 'u-sam');
    w.inside.vm = container([{ channel_key: 'telegram', entry: tgId(2) }]);
    await verifyAgentAccess(w.deps, 'a1');
    expect(w.row('a1', 'person', 'u-sam')).toMatchObject({ intended: false, mismatch: 'extra' });
    return w;
  };

  it('the pairing store cannot be opened (node:sqlite throws): the revoked member\'s warning stays', async () => {
    const w = await revokedButAdmitted();
    const before = w.row('a1', 'person', 'u-sam')!.verified;
    w.inside.vm = container({ throws: 'unable to open database file' });
    const r = await verifyAgentAccess(w.deps, 'a1');
    expect(r.status).toBe('checked');
    expect(w.row('a1', 'person', 'u-sam')).toMatchObject({ intended: false, mismatch: 'extra' });
    expect((r as { skipped?: string[] }).skipped?.join(' ')).toMatch(/people on telegram/);
    expect(w.row('a1', 'person', 'u-sam')!.verified).toEqual(before); // the finding and its time are kept
    expect(accessAlertOf(accessOverview(w.store, w.store.getAgent('a1')!))!.line).toMatch(/Sam: still there/);
    // The owner, admitted by the readable config, is still found.
    expect(w.row('a1', 'person', OWNER)!.verified.status).toBe('present');
  });

  it('a query error, an unreadable store or an unreadable allowlist file: the warning stays too', async () => {
    for (const vmInside of [
      container({ queryThrows: 'no such table: channel_pairing_allow_entries' }),
      container([], { fail: { [PAIRING_DB]: 'EACCES' } }),
      container([], { dirs: { [`${STATE}/credentials`]: ['telegram-default-allowFrom.json'] }, fail: { [`${STATE}/credentials/telegram-default-allowFrom.json`]: 'EACCES' } }),
      container([], { fail: { [`${STATE}/credentials`]: 'EACCES' } }),
      container([], { fail: { [`${STATE}/openclaw.json`]: 'EACCES' } }),
    ]) {
      const w = await revokedButAdmitted();
      w.inside.vm = vmInside;
      await verifyAgentAccess(w.deps, 'a1');
      expect(w.row('a1', 'person', 'u-sam'), JSON.stringify(vmInside.fail ?? vmInside.sqlite)).toMatchObject({ mismatch: 'extra' });
    }
  });

  it('the reason for an unreadable source never quotes the file (openclaw.json holds bot tokens)', async () => {
    const w = await revokedButAdmitted();
    w.inside.vm = container([], { files: { [`${STATE}/openclaw.json`]: `x"${BOT_VALUE}"` } }); // node's message would quote 'x"fixture-'
    const r = await verifyAgentAccess(w.deps, 'a1');
    const said = (r as { skipped?: string[] }).skipped?.join(' ') ?? '';
    expect(said).toMatch(/openclaw\.json: not valid JSON/);
    expect(said).not.toContain(BOT_VALUE.slice(0, 8));
    expect(w.row('a1', 'person', 'u-sam')).toMatchObject({ mismatch: 'extra' });
  });

  it('a complete read that no longer admits them is believed: the warning clears', async () => {
    const w = await revokedButAdmitted();
    w.inside.vm = container([]);
    await verifyAgentAccess(w.deps, 'a1');
    expect(w.row('a1', 'person', 'u-sam')).toBeUndefined();
    expect(w.store.listAccessChecks('a1').find((c) => c.kind === 'person' && c.subject === 'u-sam')!.present).toBe(false);
  });

  it('an active member the agent could not be read for is unknown, not "not found"', async () => {
    const w = await world();
    w.inside.vm = container({ throws: 'unable to open database file' });
    await verifyAgentAccess(w.deps, 'a1');
    expect(w.row('a1', 'person', 'u-sam')!.verified.status).toBe('unknown');
    expect(w.row('a1', 'person', 'u-sam')!.mismatch).toBeUndefined();
  });

  it('a folder that cannot be looked at (stat fails, not "no such file") keeps its finding too', async () => {
    const w = await world();
    w.inside.vm = container([{ channel_key: 'telegram', entry: tgId(2) }]);
    await verifyAgentAccess(w.deps, 'a1');
    w.store.deleteDataSource('a1', 'd1');
    w.inside.vm = container([{ channel_key: 'telegram', entry: tgId(2) }], { fail: { '/data/recipes': 'EACCES' } });
    await verifyAgentAccess(w.deps, 'a1');
    expect(w.store.listAccessChecks('a1').find((c) => c.kind === 'folder' && c.subject === '/data/recipes')!.present).toBe(true);
    // Gone for real (no such file): recorded absent.
    w.inside.vm = container([{ channel_key: 'telegram', entry: tgId(2) }]);
    delete w.inside.vm.files['/data/recipes'];
    await verifyAgentAccess(w.deps, 'a1');
    expect(w.store.listAccessChecks('a1').find((c) => c.kind === 'folder' && c.subject === '/data/recipes')!.present).toBe(false);
  });
});

describe('the connection code records what gog shows', () => {
  it('a live detach records the account gone, and the overview says "removed — verified gone"', async () => {
    const w = await world();
    await verifyAgentAccess(w.deps, 'a1');
    const res = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/connections/detach', headers: H, payload: { connectionId: 'c1' } });
    expect(res.json().removed).toBe(true);
    expect(w.row('a1', 'google', 'mail@example.org')).toMatchObject({ intended: false, verified: { status: 'absent' }, note: 'removed — verified gone' });
  });

  it('a sync (start, wake, rebuild) ends with what gog holds, an extra account included', async () => {
    const w = await world();
    w.inside.gog = ['self@example.org'];
    await syncConnections(w.deps, 'a1', w.store.getAgent('a1')!.runtimeRef!);
    // The attached account was imported, and the agent's own one is recorded too.
    expect(w.row('a1', 'google', 'mail@example.org')!.verified.status).toBe('present');
    expect(w.row('a1', 'google', 'self@example.org')).toMatchObject({ managed: false, verified: { status: 'present' } });
  });

  it('a removal pending for more than a day is a mismatch (stale-removal); a fresh one is not', async () => {
    const w = await world();
    w.store.setAgentState('a1', 'STOPPED');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() - 2 * 24 * 3600_000));
    w.store.addConnectionRemoval('a1', 'old@example.org');
    vi.useRealTimers();
    w.store.addConnectionRemoval('a1', 'new@example.org');
    expect(w.row('a1', 'google', 'old@example.org')).toMatchObject({ pendingRemoval: { since: expect.any(String) }, mismatch: 'stale-removal' });
    expect(w.row('a1', 'google', 'new@example.org')!.mismatch).toBeUndefined();
    expect(w.row('a1', 'google', 'new@example.org')!.pendingRemoval).toBeTruthy();
  });
});

describe('the routes: scoping, no secrets, Alerts', () => {
  it('an owner sees their own agents; another account gets 404; the machine owner sees all', async () => {
    const w = await world();
    expect((await w.f.inject({ method: 'GET', url: '/v1/agents/a1/access', headers: H })).statusCode).toBe(200);
    expect((await w.f.inject({ method: 'GET', url: '/v1/agents/a1/access', headers: HO })).statusCode).toBe(404);
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/a1/access/verify', headers: HO })).statusCode).toBe(404);
    expect((await w.f.inject({ method: 'GET', url: '/v1/agents/b1/access', headers: HO })).statusCode).toBe(200);
    const theirs = (await w.f.inject({ method: 'GET', url: '/v1/access', headers: HO })).json();
    expect(theirs.agents.map((a: { agentId: string }) => a.agentId)).toEqual(['b1']);
    // The machine's owner (OWNER holds the local host) sees every agent.
    const all = (await w.f.inject({ method: 'GET', url: '/v1/access', headers: H })).json();
    expect(all.agents.map((a: { agentId: string }) => a.agentId).sort()).toEqual(['a1', 'b1']);
    expect(all.agents.find((a: { agentId: string }) => a.agentId === 'b1').ownerId).toBe(OTHER);
  });

  it('Verify now answers the result and the overview, and nothing secret leaves', async () => {
    const w = await world();
    w.inside.channels.telegram!.accounts.TestAgentBot!.h = hash16('another-value');
    const res = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/access/verify', headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.status).toBe('checked');
    const body = res.body + (await w.f.inject({ method: 'GET', url: '/v1/access', headers: H })).body;
    for (const secret of [BOT_VALUE, ENV_VALUE, REFRESH_VALUE, KEY_VALUE, hash16(BOT_VALUE), hash16('another-value'), 'channel/a1/bot', 'env/a1/SEARCH_KEY', 'connection/c1']) {
      expect(body).not.toContain(secret);
    }
    // Mismatches first on the machine-wide list.
    expect((await w.f.inject({ method: 'GET', url: '/v1/access', headers: H })).json().agents[0].agentId).toBe('a1');
  });

  it('Verify now on a stopped agent: not checkable, said why', async () => {
    const w = await world();
    w.store.setAgentState('a1', 'STOPPED');
    const res = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/access/verify', headers: H });
    expect(res.json().result).toEqual({ status: 'not-checkable', reason: 'it is stopped — start it to check' });
  });

  it('a mismatch reaches the agent list as an Alerts line (owner only); none without one', async () => {
    const w = await world();
    await verifyAgentAccess(w.deps, 'a1');
    const list0 = (await w.f.inject({ method: 'GET', url: '/v1/agents', headers: H })).json() as Array<{ id: string; accessAlert?: unknown }>;
    expect(list0.find((a) => a.id === 'a1')!.accessAlert).toBeUndefined();
    w.inside.gog = ['mail@example.org', 'drive@example.org'];
    await verifyAgentAccess(w.deps, 'a1');
    const list = (await w.f.inject({ method: 'GET', url: '/v1/agents', headers: H })).json() as Array<{ id: string; accessAlert?: { key: string; line: string } }>;
    const al = list.find((a) => a.id === 'a1')!.accessAlert!;
    expect(al.key).toBe('access:google=drive@example.org:extra');
    expect(al.line).toMatch(/drive@example\.org: still there.*Sharing → Access/);
  });
});
