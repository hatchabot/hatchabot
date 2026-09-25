import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { ConnectorError, type ChannelConnector } from '../src/channels/connector.js';
import { MemSecrets, OWNER, as, seedRunningAgent, type World } from './support/world.js';

/**
 * The routes the 2026-09-25 use-case review found with no test at all
 * (docs/use-cases.md): the tailnet screen, the runner key, image copies to a
 * runner, the embedding service's stop/restart, derived-image rebuild + log,
 * pool re-checks, parked Slack apps, group readiness, the volume inspector,
 * peers, account unlinks, in-app send, inbox dismiss, the agent QR and
 * "anyone can knock". Each gets its authorisation edge and its happy path.
 */

const OTHER = 'user-other';
/** A third person on the box: neither the machine owner nor the bot's owner. */
const THIRD = 'user-third';

/** Slack as the fake platform sees it: one token is good, everything else refused. */
function fakeSlack(): ChannelConnector {
  return {
    kind: 'slack', label: 'Slack', hosts: [],
    fields: [{ key: 'token', label: 'Token', pattern: /^ok-/, help: 'starts with ok-' }],
    secretValue: (c) => String(c.token),
    credsFromSecret: (secret) => ({ token: secret }),
    async verify(c) {
      if (c.token !== 'ok-good') throw new ConnectorError('Slack refused this token.');
      return {
        accountId: 'U0BOT', displayName: '@Bot in Home', deepLink: 'https://slack.example/x',
        settings: { team: 'Home', botName: 'Bot Renamed', servers: [{ id: 'C1', name: 'general' }] }, warnings: [],
      };
    },
  };
}

const telegramAnswers = new Map<string, unknown>();
/** Telegram's getMe as the routes' injectable fetch sees it. */
const fakeTelegram: typeof fetch = async (input) => {
  const url = String(input);
  const token = /\/bot([^/]+)\/getMe/.exec(url)?.[1] ?? '';
  const body = telegramAnswers.get(token) ?? { ok: false };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

interface Ctx extends World { builds: string[]; dataDir: string }

async function setup(opts: { authMode?: 'password' | 'accounts' | 'identity'; publicUrl?: string } = {}): Promise<Ctx> {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  await secrets.put('ai/p1', 'sk-test');
  const f = Fastify();
  const entries: Array<{ username: string; token: string; leasedTo?: string; ownerId?: string | null }> = [];
  const pool = {
    entries,
    availableCount: () => entries.filter((e) => !e.leasedTo).length,
    owns: (u: string) => entries.some((e) => e.username === u),
    list: () => entries.map((e) => ({ username: e.username, secretRef: `telegram/bot/${e.username}`, leasedTo: e.leasedTo, ownerId: e.ownerId ?? undefined })),
    addToPool: async () => {}, removeFromPool: async () => {},
  };
  const channel = { kind: 'telegram', pool, release: async () => {}, discardPending: () => {} } as any;
  const providers = new Map<string, MockProvider>([['mock', provider]]);
  const builds: string[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), 'hb-gaps-'));
  process.env.HATCHABOT_DB = join(dataDir, 'hatchabot.sqlite');
  await registerRoutes(f, {
    store, secrets, providers, channel,
    webIndexPath: join(process.cwd(), 'web', 'index.html'),
    connectors: { slack: fakeSlack() },
    oauthFetch: fakeTelegram,
    authMode: opts.authMode,
    publicUrl: opts.publicUrl,
    buildImage: async (o: { name: string }) => { builds.push(o.name); return { ok: true }; },
  } as never);
  return { store, secrets, provider, providers, f, owner: OWNER, channel, builds, dataDir };
}

const worlds: Ctx[] = [];
async function world(opts: Parameters<typeof setup>[0] = {}) { const w = await setup(opts); worlds.push(w); return w; }
afterAll(() => { for (const w of worlds) rmSync(w.dataDir, { recursive: true, force: true }); });

let sshDir = '';
beforeAll(() => { sshDir = mkdtempSync(join(tmpdir(), 'hb-ssh-')); process.env.HATCHABOT_SSH_DIR = sshDir; });
afterAll(() => { rmSync(sshDir, { recursive: true, force: true }); delete process.env.HATCHABOT_SSH_DIR; });

describe('the public legal pages', () => {
  it('privacy and terms are served as HTML', async () => {
    const w = await world();
    for (const p of ['/privacy', '/terms']) {
      const r = await w.f.inject({ method: 'GET', url: p });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toMatch(/text\/html/);
      expect(r.body).toMatch(/<html|<!doctype/i);
    }
  });
});

describe('the tailnet screen', () => {
  it('is the machine owner\'s alone: a co-tenant gets 403 on every route', async () => {
    const w = await world();
    for (const [method, url] of [['GET', '/v1/tailscale'], ['POST', '/v1/tailscale/serve'], ['POST', '/v1/tailscale/use-for-links'], ['GET', '/v1/tailscale/qr.svg']] as const) {
      const r = await w.f.inject({ method, url, headers: as(OTHER) });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
  });
  it('tells the owner the port it listens on and the address links use', async () => {
    const w = await world({ publicUrl: 'https://box.example.com/' });
    const r = await w.f.inject({ method: 'GET', url: '/v1/tailscale', headers: as() });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(typeof j.installed).toBe('boolean');
    expect(typeof j.port).toBe('number');
    expect(j.publicUrl).toBe('https://box.example.com');
  });
  it('the QR encodes the configured address as an SVG', async () => {
    const w = await world({ publicUrl: 'https://box.example.com/' });
    const r = await w.f.inject({ method: 'GET', url: '/v1/tailscale/qr.svg', headers: as() });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/image\/svg\+xml/);
    expect(r.body).toContain('<svg');
  });
});

describe('the runner key', () => {
  it('a co-tenant may not read it; the owner gets a public key and a paste-ready snippet', async () => {
    const w = await world();
    expect((await w.f.inject({ method: 'GET', url: '/v1/runner-setup', headers: as(OTHER) })).statusCode).toBe(403);
    const r = await w.f.inject({ method: 'GET', url: '/v1/runner-setup', headers: as() });
    expect(r.statusCode).toBe(200);
    expect(r.json().pubKey).toMatch(/^ssh-/);
    expect(r.json().snippet).toContain(r.json().pubKey.trim());
    // Idempotent: the same key next time, never a new one.
    const again = await w.f.inject({ method: 'GET', url: '/v1/runner-setup', headers: as() });
    expect(again.json().pubKey).toBe(r.json().pubKey);
  });
});

describe('copying the runtime image to a runner', () => {
  it('owner-only, a real host, and never the local one', async () => {
    const w = await world();
    expect((await w.f.inject({ method: 'POST', url: '/v1/hosts/h1/install-image', headers: as(OTHER) })).statusCode).toBe(403);
    expect((await w.f.inject({ method: 'POST', url: '/v1/hosts/nope/install-image', headers: as() })).statusCode).toBe(404);
    const local = await w.f.inject({ method: 'POST', url: '/v1/hosts/h1/install-image', headers: as() });
    expect(local.statusCode).toBe(400);
    expect(local.json().error).toMatch(/already has the image/);
  });
});

describe('the embedding service: stop and restart', () => {
  it('owner-only; stop takes the containers down and turns the service off', async () => {
    const w = await world();
    expect((await w.f.inject({ method: 'POST', url: '/v1/embedder/stop', headers: as(OTHER) })).statusCode).toBe(403);
    expect((await w.f.inject({ method: 'POST', url: '/v1/embedder/restart', headers: as(OTHER) })).statusCode).toBe(403);
    w.provider.embedder = { embedder: 'running', door: 'running' };
    const stop = await w.f.inject({ method: 'POST', url: '/v1/embedder/stop', headers: as() });
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toMatchObject({ embedder: 'absent', door: 'absent' });
    expect(w.provider.embedder.embedder).toBe('absent');
    // Restart = stop + start; start (model copy, keys file, health) is exercised in embedder.test.ts.
  });
});

describe('derived images: rebuild and build log', () => {
  const rec = { name: 'tcpdump', tag: 'hatchabot-runtime:2026.9.6-plus-tcpdump', base: 'hatchabot-runtime:2026.9.6', dockerfile: 'RUN apt-get install -y tcpdump', createdBy: OWNER };
  it('a co-tenant is refused; an unknown image is 404', async () => {
    const w = await world();
    w.store.upsertDerivedImage(rec);
    expect((await w.f.inject({ method: 'POST', url: '/v1/images/tcpdump/rebuild', headers: as(OTHER) })).statusCode).toBe(403);
    expect((await w.f.inject({ method: 'GET', url: '/v1/images/tcpdump/log', headers: as(OTHER) })).statusCode).toBe(403);
    expect((await w.f.inject({ method: 'POST', url: '/v1/images/nope/rebuild', headers: as() })).statusCode).toBe(404);
    expect((await w.f.inject({ method: 'GET', url: '/v1/images/nope/log', headers: as() })).statusCode).toBe(404);
  });
  it('rebuild kicks a build (optionally onto a newer base) and the log reports the status', async () => {
    const w = await world();
    w.store.upsertDerivedImage(rec);
    const r = await w.f.inject({ method: 'POST', url: '/v1/images/tcpdump/rebuild', headers: as(), payload: { base: 'hatchabot-runtime:2026.9.7' } });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ building: true });
    expect(w.builds).toEqual(['tcpdump']);
    expect(w.store.getDerivedImage('tcpdump')?.base).toBe('hatchabot-runtime:2026.9.7');
    const bad = await w.f.inject({ method: 'POST', url: '/v1/images/tcpdump/rebuild', headers: as(), payload: { base: 'ubuntu:latest' } });
    expect(bad.statusCode).toBe(400);
    const log = await w.f.inject({ method: 'GET', url: '/v1/images/tcpdump/log', headers: as() });
    expect(log.statusCode).toBe(200);
    expect(log.json()).toMatchObject({ log: expect.any(String) });
    expect(['BUILDING', 'READY', 'FAILED']).toContain(log.json().status);
  });
});

describe('re-checking a parked Telegram bot', () => {
  it('asks Telegram with the stored token and reports alive / refused; a missing token is 409; unknown is 404', async () => {
    const w = await world();
    w.channel.pool.entries.push({ username: 'sparebot', token: 't', ownerId: OWNER });
    await w.secrets.put('telegram/bot/sparebot', 'fake-token-A');
    telegramAnswers.set('fake-token-A', { ok: true, result: { username: 'sparebot', first_name: 'Spare', can_join_groups: false } });
    const r = await w.f.inject({ method: 'POST', url: '/v1/pool/sparebot/recheck', headers: as() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ username: 'sparebot', alive: true, botName: 'Spare' });
    expect(r.json().warnings[0]).toMatch(/Groups are off/);

    telegramAnswers.set('fake-token-A', { ok: false });
    expect((await w.f.inject({ method: 'POST', url: '/v1/pool/SpareBot/recheck', headers: as() })).json().alive).toBe(false);

    await w.secrets.delete('telegram/bot/sparebot');
    expect((await w.f.inject({ method: 'POST', url: '/v1/pool/sparebot/recheck', headers: as() })).statusCode).toBe(409);
    expect((await w.f.inject({ method: 'POST', url: '/v1/pool/nobody/recheck', headers: as() })).statusCode).toBe(404);
  });
  it('another owner\'s private bot is invisible to a third person, but the machine owner may check it', async () => {
    const w = await world();
    w.channel.pool.entries.push({ username: 'theirs', token: 't', ownerId: OTHER });
    await w.secrets.put('telegram/bot/theirs', 'fake-token-B');
    telegramAnswers.set('fake-token-B', { ok: true, result: { username: 'theirs', first_name: 'Theirs', can_join_groups: true } });
    expect((await w.f.inject({ method: 'POST', url: '/v1/pool/theirs/recheck', headers: as(THIRD) })).statusCode).toBe(404);
    expect((await w.f.inject({ method: 'POST', url: '/v1/pool/theirs/recheck', headers: as(OTHER) })).json().alive).toBe(true);
    expect((await w.f.inject({ method: 'POST', url: '/v1/pool/theirs/recheck', headers: as() })).json().alive).toBe(true);
  });
});

describe('the chat-app catalogue', () => {
  it('lists each connector with its fields, patterns as strings, never a secret', async () => {
    const w = await world();
    const r = await w.f.inject({ method: 'GET', url: '/v1/channels/connectors', headers: as() });
    expect(r.statusCode).toBe(200);
    const slack = r.json().find((c: { kind: string }) => c.kind === 'slack');
    expect(slack).toMatchObject({ label: 'Slack', fields: [{ key: 'token', pattern: '^ok-' }] });
    expect(r.body).not.toContain('ok-good');
  });
});

describe('parked Slack apps: re-check and delete', () => {
  const park = (w: Ctx, ownerId: string | null, id = 'A0PARKED') => {
    w.store.upsertDiscordBot({ applicationId: id, botName: 'Old Name', secretRef: `slack-pool/${id}`, ownerId, servers: [], warnings: [], addedAt: 'now', kind: 'slack' });
  };
  it('re-check refreshes the name and rooms from Slack; a refused token is 400; a lost token is 409', async () => {
    const w = await world();
    park(w, OWNER);
    await w.secrets.put('slack-pool/A0PARKED', 'ok-good');
    const r = await w.f.inject({ method: 'POST', url: '/v1/slack-apps/A0PARKED/recheck', headers: as() });
    expect(r.statusCode).toBe(200);
    expect(r.json().bot).toMatchObject({ applicationId: 'A0PARKED', botName: 'Bot Renamed', servers: [{ id: 'C1', name: 'general' }], kind: 'slack', mine: true });
    expect(r.body).not.toContain('ok-good');
    await w.secrets.put('slack-pool/A0PARKED', 'ok-revoked');
    expect((await w.f.inject({ method: 'POST', url: '/v1/slack-apps/A0PARKED/recheck', headers: as() })).statusCode).toBe(400);
    await w.secrets.delete('slack-pool/A0PARKED');
    expect((await w.f.inject({ method: 'POST', url: '/v1/slack-apps/A0PARKED/recheck', headers: as() })).statusCode).toBe(409);
  });
  it('a Discord id on the Slack route is 404, like someone else\'s private app to a third person', async () => {
    const w = await world();
    w.store.upsertDiscordBot({ applicationId: '1234567890123456789', secretRef: 'discord-pool/x', ownerId: OWNER, servers: [], warnings: [], addedAt: 'now', kind: 'discord' });
    park(w, OTHER, 'A0THEIRS');
    expect((await w.f.inject({ method: 'POST', url: '/v1/slack-apps/1234567890123456789/recheck', headers: as() })).statusCode).toBe(404);
    expect((await w.f.inject({ method: 'DELETE', url: '/v1/slack-apps/A0THEIRS', headers: as(THIRD) })).statusCode).toBe(404);
    expect(w.store.getDiscordBot('A0THEIRS')).toBeTruthy();
  });
  it('delete forgets the token; a shared app is the machine owner\'s to delete', async () => {
    const w = await world();
    park(w, OWNER);
    await w.secrets.put('slack-pool/A0PARKED', 'ok-good');
    const r = await w.f.inject({ method: 'DELETE', url: '/v1/slack-apps/A0PARKED', headers: as() });
    expect(r.statusCode).toBe(200);
    expect(r.json().deleted).toBe('A0PARKED');
    expect(w.store.getDiscordBot('A0PARKED')).toBeUndefined();
    expect(w.secrets.map.has('slack-pool/A0PARKED')).toBe(false);

    park(w, null, 'A0SHARED');
    expect((await w.f.inject({ method: 'DELETE', url: '/v1/slack-apps/A0SHARED', headers: as(OTHER) })).statusCode).toBe(403);
    expect((await w.f.inject({ method: 'DELETE', url: '/v1/slack-apps/A0SHARED', headers: as() })).statusCode).toBe(200);
  });
});

describe('group readiness (Telegram privacy mode)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  it('reads the bot\'s group flags from Telegram; 502 when Telegram says no; foreign agents are 404', async () => {
    const w = await world();
    const id = await seedRunningAgent(w, { botToken: 'fake-token-C' });
    telegramAnswers.set('fake-token-C', { ok: true, result: { username: 'kitchenbot', can_join_groups: true, can_read_all_group_messages: false } });
    globalThis.fetch = fakeTelegram;
    const r = await w.f.inject({ method: 'GET', url: `/v1/agents/${id}/group-readiness`, headers: as() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ username: 'kitchenbot', canJoinGroups: true, canReadAllGroupMessages: false });
    telegramAnswers.set('fake-token-C', { ok: false });
    expect((await w.f.inject({ method: 'GET', url: `/v1/agents/${id}/group-readiness`, headers: as() })).statusCode).toBe(502);
    expect((await w.f.inject({ method: 'GET', url: `/v1/agents/${id}/group-readiness`, headers: as(OTHER) })).statusCode).toBe(404);
  });
});

describe('the volume inspector', () => {
  /** A volume with a MEMORY.md, a SOUL.md and one session file. */
  function volume(w: Ctx) {
    w.provider.execShellOnVolume = async (_ref: string, script: string) => {
      if (script.startsWith('wc -c')) return { code: 0, stdout: '12 /home/node/.openclaw/agents/kitchen/agent/MEMORY.md\n5 /home/node/.openclaw/agents/kitchen/agent/SOUL.md\n', stderr: '' };
      if (script.startsWith('ls -S')) return { code: 0, stdout: '/home/node/.openclaw/agents/kitchen/sessions/main.jsonl\n', stderr: '' };
      if (script.startsWith('wc -l')) return { code: 0, stdout: '2 /home/node/.openclaw/agents/kitchen/sessions/main.jsonl\n', stderr: '' };
      if (script.startsWith('tail -n')) {
        return { code: 0, stdout: [
          JSON.stringify({ type: 'message', message: { role: 'user', content: 'what is for dinner' } }),
          JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Pasta.' }] } }),
        ].join('\n') + '\n', stderr: '' };
      }
      if (script.startsWith('head -c')) return { code: 0, stdout: script.includes('MEMORY.md') ? 'remembered' : '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
  }
  it('lists the files that exist, counts the transcript, and serves a file and the turns', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    volume(w);
    const r = await w.f.inject({ method: 'GET', url: `/v1/agents/${id}/inspect`, headers: as() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ name: 'Kitchen', state: 'RUNNING', transcriptTurns: 2, files: [{ name: 'MEMORY.md', bytes: 12 }, { name: 'SOUL.md', bytes: 5 }] });
    const file = await w.f.inject({ method: 'GET', url: `/v1/agents/${id}/inspect/file/MEMORY.md`, headers: as() });
    expect(file.json()).toEqual({ name: 'MEMORY.md', content: 'remembered', truncated: false });
    const t = await w.f.inject({ method: 'GET', url: `/v1/agents/${id}/inspect/transcript?maxTurns=50`, headers: as() });
    expect(t.statusCode).toBe(200);
    expect(t.json().totalTurns).toBe(2);
    expect(t.json().turns.map((x: { role: string; text: string }) => [x.role, x.text])).toEqual([['user', 'what is for dinner'], ['assistant', 'Pasta.']]);
  });
  it('only the six known files, only the owner, and only agents with a volume', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    volume(w);
    expect((await w.f.inject({ method: 'GET', url: `/v1/agents/${id}/inspect/file/openclaw.json`, headers: as() })).statusCode).toBe(400);
    expect((await w.f.inject({ method: 'GET', url: `/v1/agents/${id}/inspect/file/..%2Fetc%2Fpasswd`, headers: as() })).statusCode).toBe(400);
    for (const u of ['inspect', 'inspect/file/SOUL.md', 'inspect/transcript']) {
      expect((await w.f.inject({ method: 'GET', url: `/v1/agents/${id}/${u}`, headers: as(OTHER) })).statusCode, u).toBe(404);
    }
    w.store.insertAgent({ id: 'planned', ownerId: OWNER, name: 'Planned', slug: 'planned', state: 'PLANNED', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    w.store.insertMembership({ id: 'm-planned', agentId: 'planned', userId: OWNER, role: 'owner', status: 'active' });
    for (const u of ['inspect', 'inspect/file/SOUL.md', 'inspect/transcript']) {
      expect((await w.f.inject({ method: 'GET', url: `/v1/agents/planned/${u}`, headers: as() })).statusCode, u).toBe(409);
    }
  });
});

describe('forgetting a peer server', () => {
  it('drops the row and its token; another owner\'s peer is 404', async () => {
    const w = await world();
    w.store.insertPeer({ id: 'pe1', ownerId: OWNER, name: 'laptop', url: 'https://laptop.example.com', secretRef: 'peer/pe1', createdAt: 'now' });
    await w.secrets.put('peer/pe1', 'fake-peer-token');
    expect((await w.f.inject({ method: 'DELETE', url: '/v1/peers/pe1', headers: as(OTHER) })).statusCode).toBe(404);
    const r = await w.f.inject({ method: 'DELETE', url: '/v1/peers/pe1', headers: as() });
    expect(r.statusCode).toBe(200);
    expect(w.store.getPeer(OWNER, 'pe1')).toBeUndefined();
    expect(w.secrets.map.has('peer/pe1')).toBe(false);
    expect((await w.f.inject({ method: 'DELETE', url: '/v1/peers/pe1', headers: as() })).statusCode).toBe(404);
  });
});

describe('unlinking my chat identities', () => {
  it('Telegram: the account forgets my id', async () => {
    const w = await world();
    w.store.setAccountTelegram(OWNER, '424242');
    expect(w.store.accountTelegram(OWNER)).toBe('424242');
    const r = await w.f.inject({ method: 'DELETE', url: '/v1/account/telegram', headers: as() });
    expect(r.json()).toEqual({ unlinked: true });
    expect(w.store.accountTelegram(OWNER)).toBeUndefined();
  });
  it('Discord: every agent forgets me, and says how many did', async () => {
    const w = await world();
    const a = await seedRunningAgent(w, { id: 'a1', slug: 'one', accountId: 'onebot' });
    const b = await seedRunningAgent(w, { id: 'a2', slug: 'two', accountId: 'twobot' });
    expect(w.store.bindMemberIdentity(a, OWNER, 'discord', '111111111111111111')).toBe(true);
    expect(w.store.bindMemberIdentity(b, OWNER, 'discord', '111111111111111111')).toBe(true);
    const r = await w.f.inject({ method: 'DELETE', url: '/v1/account/discord', headers: as() });
    expect(r.json()).toEqual({ unlinked: true, agents: 2 });
    expect(w.store.memberIdentities(a, OWNER).discord).toBeUndefined();
    expect(w.store.memberIdentities(b, OWNER).discord).toBeUndefined();
    // Nothing else of mine is touched.
    expect((await w.f.inject({ method: 'DELETE', url: '/v1/account/discord', headers: as(OTHER) })).json().agents).toBe(0);
  });
});

describe('sending an agent to someone\'s inbox', () => {
  it('needs identity mode and a real address; foreign agents are 404', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/send`, headers: as(OTHER), payload: { toEmail: 'bob@example.com' } })).statusCode).toBe(404);
    const noAddr = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/send`, headers: as(), payload: { toEmail: 'not-an-address' } });
    expect(noAddr.statusCode).toBe(400);
    expect(noAddr.json().error).toMatch(/recipient email/);
    const pw = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/send`, headers: as(), payload: { toEmail: 'bob@example.com' } });
    expect(pw.statusCode).toBe(400);
    expect(pw.json().error).toMatch(/identity mode/);
    expect(w.store.listInbox(OTHER, 'bob@example.com')).toHaveLength(0);
  });
  it('in identity mode it lands in the recipient\'s inbox as a secret-free template, and dismiss hides it', async () => {
    const w = await world({ authMode: 'identity' });
    const id = await seedRunningAgent(w, { botToken: 'fake-token-D' });
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/send`, headers: as(), payload: { toEmail: 'Bob@Example.com', message: 'try this' } });
    expect(r.statusCode, r.body).toBe(201);
    const shares = w.store.listInbox(OTHER, 'bob@example.com');
    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({ agentName: 'Kitchen', message: 'try this' });
    const blob = w.store.getShareFor(shares[0]!.id, OTHER, 'bob@example.com')!.blob;
    expect(blob.toString('latin1')).not.toContain('fake-token-D');

    const inbox = await w.f.inject({ method: 'GET', url: '/v1/inbox', headers: as(OTHER) });
    expect(inbox.json().shares).toEqual([]); // unclaimed: it binds to the email on sign-in
    // Dismiss is the recipient's call: claim it for them, then dismiss.
    w.store.claimSharesForEmail(OTHER, 'bob@example.com');
    expect((await w.f.inject({ method: 'POST', url: `/v1/inbox/${shares[0]!.id}/dismiss`, headers: as() })).statusCode).toBe(404);
    const d = await w.f.inject({ method: 'POST', url: `/v1/inbox/${shares[0]!.id}/dismiss`, headers: as(OTHER) });
    expect(d.json()).toEqual({ dismissed: true });
    expect(w.store.getShareFor(shares[0]!.id, OTHER, 'bob@example.com')).toBeUndefined();
    expect((await w.f.inject({ method: 'POST', url: `/v1/inbox/${shares[0]!.id}/dismiss`, headers: as(OTHER) })).statusCode).toBe(404);
  });
});

describe('the agent\'s QR code', () => {
  it('encodes the Telegram deep link; no bot or not mine → 404', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    const r = await w.f.inject({ method: 'GET', url: `/v1/agents/${id}/qr.svg`, headers: as() });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/svg/);
    expect(r.body).toContain('<svg');
    expect((await w.f.inject({ method: 'GET', url: `/v1/agents/${id}/qr.svg`, headers: as(OTHER) })).statusCode).toBe(404);
    w.store.insertAgent({ id: 'web', ownerId: OWNER, name: 'Web', slug: 'web', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    expect((await w.f.inject({ method: 'GET', url: '/v1/agents/web/qr.svg', headers: as() })).statusCode).toBe(404);
  });
});

describe('"anyone can knock"', () => {
  it('flips the flag live on a running agent, refuses junk, and hides foreign agents', async () => {
    const w = await world();
    const id = await seedRunningAgent(w);
    expect(w.store.getAgent(id)?.allowKnocks).toBe(false);
    const before = w.provider.execLog.length;
    const on = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/allow-knocks`, headers: as(), payload: { on: true } });
    expect(on.json()).toEqual({ allowKnocks: true });
    expect(w.store.getAgent(id)?.allowKnocks).toBe(true);
    expect(w.provider.execLog.length).toBeGreaterThan(before); // the door opened now, not at the next rebuild
    const off = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/allow-knocks`, headers: as(), payload: { on: false } });
    expect(off.json()).toEqual({ allowKnocks: false });
    expect(w.store.getAgent(id)?.allowKnocks).toBe(false);
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/allow-knocks`, headers: as(), payload: { on: 'yes' } })).statusCode).toBe(400);
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/allow-knocks`, headers: as(OTHER), payload: { on: true } })).statusCode).toBe(404);
  });
});
