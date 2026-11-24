import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, chmodSync, symlinkSync, lstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import {
  discoverOpenclawAgents,
  disableOpenclawBot,
  quiesceOpenclawBots,
  gatewayRestart,
  restartOpenclawGateway,
} from '../src/orchestrator/transfer/openclawImport.js';
import { openclawAgentIdForWorkspace } from '../src/orchestrator/transfer/cronImport.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

class MemSecrets implements SecretStore {
  private m = new Map<string, string>();
  async put(ref: string, val: string) { this.m.set(ref, val); }
  async get(ref: string) { const v = this.m.get(ref); if (v === undefined) throw new Error(`no secret ${ref}`); return v; }
  async delete(ref: string) { this.m.delete(ref); }
}

const root = mkdtempSync(join(tmpdir(), 'acl-oc-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Two real workspace dirs, one deliberately absent.
const wsA1 = join(root, 'workspace-garden-advisor');
const wsAdopted = join(root, 'workspace-stock-watcher');
mkdirSync(wsA1, { recursive: true });
mkdirSync(wsAdopted, { recursive: true });

function writeConfig(path: string) {
  writeFileSync(
    path,
    JSON.stringify({
      agents: {
        list: [
          { id: 'garden-advisor', workspace: wsA1 },
          { id: 'ghost', workspace: join(root, 'workspace-gone') }, // missing dir, no binding
          { id: 'stock-watcher', workspace: wsAdopted },
        ],
      },
      bindings: [
        { agentId: 'garden-advisor', match: { channel: 'telegram', accountId: 'a1bot' } },
        { agentId: 'stock-watcher', match: { accountId: 'adoptedbot' } },
      ],
      channels: {
        telegram: {
          accounts: {
            a1bot: { botToken: '111:aaa', enabled: true, allowFrom: ['123', 'not-a-number'] },
            adoptedbot: { botToken: '222:bbb', enabled: true },
          },
        },
      },
    }),
  );
}

async function storeWithAdopted() {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({ id: 'x1', ownerId: 'o', name: 'Already Here', slug: 'already-here', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: 'x', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
  // The channel's account_id is the REAL @username, deliberately different from
  // OpenClaw's config key "adoptedbot" — but the token has the same bot-id (222),
  // which is what discovery must match on.
  store.insertChannel({ id: 'c1', agentId: 'x1', kind: 'telegram', accountId: 'RealAdoptedName', secretRef: 'chan/x1', deepLink: 'https://t.me/RealAdoptedName', createdAt: 'now' });
  await secrets.put('chan/x1', '222:zzz');
  return { store, secrets };
}

describe('discoverOpenclawAgents', () => {
  it('lists agents, and matches an already-imported one by bot-id even when relabelled', async () => {
    const cfg = join(root, 'discover.json');
    writeConfig(cfg);
    const { store, secrets } = await storeWithAdopted();
    const agents = await discoverOpenclawAgents({ store, secrets }, cfg);
    const by = Object.fromEntries(agents.map((a) => [a.id, a]));

    expect(by['garden-advisor']).toMatchObject({
      name: 'Garden Advisor', // derived from workspace-garden-advisor
      bot: { accountId: 'a1bot', enabledInSource: true, allowFrom: ['123'] }, // junk id filtered
    });
    expect(by['garden-advisor']!.alreadyAdoptedAs).toBeUndefined();
    expect(by['garden-advisor']!.problem).toBeUndefined();

    // no binding → no bot; missing folder → flagged
    expect(by['ghost']!.bot).toBeUndefined();
    expect(by['ghost']!.problem).toMatch(/missing/);

    // config key "adoptedbot" ≠ stored @username "RealAdoptedName", but the
    // bot-id (222) matches → still recognised as already imported
    expect(by['stock-watcher']!.alreadyAdoptedAs).toBe('Already Here');
  });

  it('reads a ~/ workspace from the home folder, not the server checkout (#175)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'acl-home-'));
    mkdirSync(join(home, 'workspace-recipe-keeper'));
    const cfg = join(root, 'tilde.json');
    writeFileSync(cfg, JSON.stringify({ agents: { list: [{ id: 'recipe-keeper', workspace: '~/workspace-recipe-keeper' }] } }));
    const was = process.env.HOME;
    process.env.HOME = home;
    try {
      const { store, secrets } = await storeWithAdopted();
      const [a] = await discoverOpenclawAgents({ store, secrets }, cfg);
      expect(a).toMatchObject({ workspace: join(home, 'workspace-recipe-keeper'), name: 'Recipe Keeper' });
      expect(a!.problem).toBeUndefined();
      expect(openclawAgentIdForWorkspace(join(home, 'workspace-recipe-keeper'), cfg)).toBe('recipe-keeper');
    } finally {
      process.env.HOME = was;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns [] when the config is unreadable', async () => {
    const { store, secrets } = await storeWithAdopted();
    expect(await discoverOpenclawAgents({ store, secrets }, join(root, 'nope.json'))).toEqual([]);
  });
});

describe('disableOpenclawBot', () => {
  it('flips enabled to false, backs the file up, and is idempotent', () => {
    const cfg = join(root, 'disable.json');
    writeConfig(cfg);

    expect(disableOpenclawBot('a1bot', cfg)).toEqual({ changed: true });
    const after = JSON.parse(readFileSync(cfg, 'utf8'));
    expect(after.channels.telegram.accounts.a1bot.enabled).toBe(false);
    expect(existsSync(`${cfg}.agentclaw-bak`)).toBe(true);
    // backup still has the pre-edit value
    expect(JSON.parse(readFileSync(`${cfg}.agentclaw-bak`, 'utf8')).channels.telegram.accounts.a1bot.enabled).toBe(true);
    // second call is a no-op
    expect(disableOpenclawBot('a1bot', cfg)).toEqual({ changed: false });
  });

  it('replaces the file whole by a rename, keeping its mode and a symlink, with no temp file left (HB-0080)', () => {
    const dir = join(root, 'atomic');
    mkdirSync(dir, { recursive: true });
    const real = join(dir, 'real.json');
    writeConfig(real);
    chmodSync(real, 0o600);
    const link = join(dir, 'openclaw.json');
    symlinkSync(real, link);
    const inode = statSync(real).ino;
    expect(disableOpenclawBot('a1bot', link)).toEqual({ changed: true });
    // A new file renamed into place, not the old one rewritten where it stands.
    expect(statSync(real).ino).not.toBe(inode);
    expect(statSync(real).mode & 0o777).toBe(0o600);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf8')).channels.telegram.accounts.a1bot.enabled).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('throws for an unknown account', () => {
    const cfg = join(root, 'disable2.json');
    writeConfig(cfg);
    expect(() => disableOpenclawBot('nope', cfg)).toThrow(/No Telegram account/);
  });
});

describe('quiesceOpenclawBots', () => {
  it('an id that is not an account of its own ("__proto__") is refused up front, and Object.prototype is untouched', async () => {
    const cfg = join(root, 'quiesce-proto.json');
    writeConfig(cfg);
    let restarts = 0;
    for (const id of ['__proto__', 'constructor', 'toString'])
      await expect(quiesceOpenclawBots([id], { configPath: cfg, settleMs: 0, restart: async () => { restarts++; } }), id).rejects.toThrow(/No Telegram account/);
    expect(restarts).toBe(0);
    expect(({} as { enabled?: unknown }).enabled).toBeUndefined();
  });

  it('disables each bot, restarts once, and reports which went quiet', async () => {
    const cfg = join(root, 'quiesce.json');
    writeConfig(cfg);
    // getUpdates stub: a1's token (111) is quiet, adopted's (222) stays busy.
    const fetchImpl = (async (url: string | URL) => {
      const busy = String(url).includes('bot222:');
      return busy
        ? { status: 409, json: async () => ({ error_code: 409 }) }
        : { status: 200, json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch;

    let restarts = 0;
    const res = await quiesceOpenclawBots(['a1bot', 'adoptedbot'], {
      configPath: cfg,
      fetchImpl,
      settleMs: 0,
      restart: async () => {
        restarts++;
      },
    });

    expect(restarts).toBe(1); // ONE restart for the batch
    expect(res.quiet).toEqual(['a1bot']);
    expect(res.stillBusy).toEqual(['adoptedbot']);
    expect(res.unconfirmed).toEqual([]);
    // both were disabled in the file
    const after = JSON.parse(readFileSync(cfg, 'utf8'));
    expect(after.channels.telegram.accounts.a1bot.enabled).toBe(false);
    expect(after.channels.telegram.accounts.adoptedbot.enabled).toBe(false);
  });

  it('a bot Telegram did not answer for is unconfirmed, not quiet (C065)', async () => {
    const cfg = join(root, 'quiesce-unknown.json');
    writeConfig(cfg);
    // a1's token (111): no network at all. adopted's (222): an unreadable reply once, quiet otherwise.
    let flaky = 0;
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).includes('bot111:')) throw new Error('getaddrinfo ENOTFOUND api.telegram.org');
      return flaky++ === 1
        ? { status: 502, json: async () => { throw new Error('not json'); } }
        : { status: 200, json: async () => ({ ok: true }) };
    }) as unknown as typeof fetch;
    const res = await quiesceOpenclawBots(['a1bot', 'adoptedbot'], { configPath: cfg, fetchImpl, settleMs: 0, pollGapMs: 0, restart: async () => {} });
    expect(res).toEqual({ quiet: [], stillBusy: [], unconfirmed: ['a1bot', 'adoptedbot'] });
  });

  it('validates ALL ids before writing — a bad id leaves the config untouched and never restarts', async () => {
    const cfg = join(root, 'quiesce-atomic.json');
    writeConfig(cfg);
    let restarts = 0;
    await expect(
      quiesceOpenclawBots(['a1bot', 'does-not-exist'], { configPath: cfg, settleMs: 0, restart: async () => { restarts++; } }),
    ).rejects.toThrow(/No Telegram account/);
    // a1bot must NOT have been disabled (no partial write), and no restart ran —
    // otherwise a bot would be disabled-in-config yet still polled.
    const after = JSON.parse(readFileSync(cfg, 'utf8'));
    expect(after.channels.telegram.accounts.a1bot.enabled).toBe(true);
    expect(restarts).toBe(0);
  });
});

// The gateway's own restart, run for real against shims: a PATH of them only,
// and a made-up home, so nothing on this machine is restarted.
describe('the gateway restart on each platform (HB-0981)', () => {
  const quietFetch = (async () => ({ status: 200, json: async () => ({ ok: true }) })) as unknown as typeof fetch;
  async function sandboxed(o: { openclaw: boolean; platform: NodeJS.Platform }) {
    const box = mkdtempSync(join(root, 'restart-'));
    const bin = join(box, 'bin');
    mkdirSync(bin);
    const log = join(box, 'calls.log');
    const shim = '#!/bin/sh\nprintf \'%s %s\\n\' "${0##*/}" "$*" >> "$HB_SHIM_LOG"\n';
    for (const name of ['systemctl', ...(o.openclaw ? ['openclaw'] : [])]) {
      writeFileSync(join(bin, name), shim);
      chmodSync(join(bin, name), 0o755);
    }
    const cfg = join(box, 'openclaw.json');
    writeConfig(cfg);
    const saved = { PATH: process.env.PATH, HOME: process.env.HOME, HB_SHIM_LOG: process.env.HB_SHIM_LOG };
    Object.assign(process.env, { PATH: bin, HOME: join(box, 'home'), HB_SHIM_LOG: log });
    try {
      const run = quiesceOpenclawBots(['a1bot'], { configPath: cfg, fetchImpl: quietFetch, settleMs: 0, pollGapMs: 0, platform: o.platform, env: { PATH: bin } });
      const res = await run.then((r) => r, (e: Error) => e);
      return { res, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [], enabled: JSON.parse(readFileSync(cfg, 'utf8')).channels.telegram.accounts.a1bot.enabled };
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }

  it('on a Mac, OpenClaw\'s own command restarts its gateway, not systemctl', async () => {
    const { res, calls, enabled } = await sandboxed({ openclaw: true, platform: 'darwin' });
    expect(res).toEqual({ quiet: ['a1bot'], stillBusy: [], unconfirmed: [] });
    expect(calls).toEqual(['openclaw gateway restart']);
    expect(enabled).toBe(false);
  });

  it('on a Mac without OpenClaw\'s command, nothing is switched off and nothing runs', async () => {
    const { res, calls, enabled } = await sandboxed({ openclaw: false, platform: 'darwin' });
    expect(res).toBeInstanceOf(Error);
    expect((res as Error).message).toMatch(/could not find OpenClaw's own command \(openclaw\).*nothing was changed/);
    expect(calls).toEqual([]);
    expect(enabled).toBe(true);
  });

  it('on Linux, its systemd unit is restarted, as before', async () => {
    const { res, calls, enabled } = await sandboxed({ openclaw: true, platform: 'linux' });
    expect(res).toEqual({ quiet: ['a1bot'], stillBusy: [], unconfirmed: [] });
    expect(calls).toEqual(['systemctl --user restart openclaw-gateway']);
    expect(enabled).toBe(false);
  });

  it('on Linux too, a restart that does not end is stopped, and a failed one says the bots are already off and how to finish (HB-1028)', async () => {
    // Bounded as on a Mac: a stuck service stop held the request for good.
    const how = gatewayRestart('linux', { PATH: '' });
    expect(how).toMatchObject({ cmd: 'systemctl', args: ['--user', 'restart', 'openclaw-gateway'], timeoutMs: 3 * 60_000 });
    // A command that never ends is stopped at its bound, and says so.
    const box = mkdtempSync(join(root, 'stuck-'));
    const stuck = join(box, 'systemctl');
    writeFileSync(stuck, '#!/bin/sh\nexec sleep 30\n');
    chmodSync(stuck, 0o755);
    const t0 = Date.now();
    await expect(restartOpenclawGateway({ cmd: stuck, args: [], name: 'openclaw-gateway', timeoutMs: 200 })).rejects.toThrow(/Couldn't restart openclaw-gateway \(stopped after/);
    expect(Date.now() - t0).toBeLessThan(10_000);
    // The config was changed before the restart failed: the answer says so, and what to run.
    const cfg = join(box, 'openclaw.json');
    writeConfig(cfg);
    const failed = await quiesceOpenclawBots(['a1bot'], { configPath: cfg, settleMs: 0, platform: 'linux', env: { PATH: '' },
      restart: async () => { throw new Error("Couldn't restart openclaw-gateway (exit 1): unit not found"); } }).catch((e: Error) => e);
    expect((failed as Error).message).toBe("Couldn't restart openclaw-gateway (exit 1): unit not found. OpenClaw's Telegram account \"a1bot\" is already switched off in its config: "
      + 'restart its gateway yourself (systemctl --user restart openclaw-gateway), then try again.');
    expect(JSON.parse(readFileSync(cfg, 'utf8')).channels.telegram.accounts.a1bot.enabled).toBe(false);
    // A failure that ends in a full stop gets one, not two; the accounts are named as the config names them, not as @handles.
    writeConfig(cfg);
    const two = await quiesceOpenclawBots(['a1bot', 'adoptedbot'], { configPath: cfg, settleMs: 0, platform: 'linux', env: { PATH: '' },
      restart: async () => { throw new Error("Couldn't restart openclaw-gateway (exit 5): Unit openclaw-gateway.service not found."); } }).catch((e: Error) => e);
    expect((two as Error).message).toBe("Couldn't restart openclaw-gateway (exit 5): Unit openclaw-gateway.service not found. "
      + "OpenClaw's Telegram accounts \"a1bot\", \"adoptedbot\" are already switched off in its config: "
      + 'restart its gateway yourself (systemctl --user restart openclaw-gateway), then try again.');
  });
});
