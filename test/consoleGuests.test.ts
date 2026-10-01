import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { FrameReader, encodeFrame } from '../src/api/consoleProxy.js';
import { consoleIdentity, guestConsoleSessionKey, OWNER_ROLE } from '../src/openclaw/consoleIdentity.js';
import { ConsoleAccess, consoleAllowUsers, consoleSyncBatch, parseConsoleState } from '../src/orchestrator/consoleAccess.js';

/**
 * The console with identities, end to end through the real routes: who may
 * open an agent's OpenClaw console, as whom the gateway is told they are,
 * what a guest's socket may carry, and that a removal closes it. The gateway
 * here is a stand-in that speaks just enough of OpenClaw's protocol (the
 * behaviour of the real one was proven on a throwaway 2026.9.6 agent).
 */

const OWNER = 'user-owner';
const GUEST = 'user-guest';
const OTHER = 'user-other-guest';
let prevHeader: string | undefined;
beforeAll(() => { prevHeader = process.env.HATCHABOT_ALLOW_OWNER_HEADER; process.env.HATCHABOT_ALLOW_OWNER_HEADER = '1'; });
afterAll(() => { if (prevHeader === undefined) delete process.env.HATCHABOT_ALLOW_OWNER_HEADER; else process.env.HATCHABOT_ALLOW_OWNER_HEADER = prevHeader; });

let toClose: Array<{ close: () => void }> = [];
afterEach(() => { for (const c of toClose) { try { c.close(); } catch { /* gone */ } } toClose = []; });

interface FakeGateway {
  port: number;
  http: IncomingHttpHeaders[];
  upgrades: Array<{ url: string; headers: IncomingHttpHeaders }>;
  received: Array<{ identity?: string; method: string; params: any }>;
  /** Scopes the hello grants, by the name Hatchabot sent. */
  scopes: (identity: string | undefined) => string[];
  /** When set, the names admitted (trusted-proxy allowUsers): anyone else's connect is refused, as OpenClaw does. */
  allow?: Set<string>;
  /** Every connect the gateway refused, by name. */
  refusedConnects: string[];
  /** A reload of its auth: every open connection drops (OpenClaw: 4001 "gateway policy changed"). */
  dropAll: () => void;
  /** Connections dropped by reloads, by name. */
  dropped: string[];
}

/** The app's document and its boot settings, as 2026.9 serves them (just the parts the proxy touches). */
const FAKE_DOCUMENT = '<!doctype html><html data-openclaw-control-ui-base-path=""><head><meta charset="UTF-8" /><script>theme()</script><script type="module" src="/assets/app.js"></script></head><body></body></html>';
const FAKE_UI_CONFIG = JSON.stringify({ basePath: '', communityInvite: true, terminalEnabled: true, cliAgentsEnabled: true });

/** An OpenClaw gateway stand-in: HTTP answers "ok"; a WebSocket gets a challenge, a hello, and an echo per request. */
async function fakeGateway(): Promise<FakeGateway> {
  const g: FakeGateway = { port: 0, http: [], upgrades: [], received: [], scopes: () => [], refusedConnects: [], dropAll: () => {}, dropped: [] };
  const server: Server = createServer((req, res) => {
    g.http.push(req.headers);
    const path = (req.url ?? '').split('?')[0];
    if (path === '/chat') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('etag', '"doc"'); res.end(FAKE_DOCUMENT); return; }
    if (path === '/control-ui-config.json') { res.setHeader('content-type', 'application/json'); res.end(FAKE_UI_CONFIG); return; }
    res.setHeader('content-type', 'text/plain'); res.end('ok');
  });
  const sockets = new Set<import('node:net').Socket>();
  const names = new Map<unknown, string>();
  g.dropAll = () => { for (const s of sockets) { if (!s.destroyed) { g.dropped.push(names.get(s) ?? ''); s.destroy(); } } };
  server.on('upgrade', (req, socket) => {
    sockets.add(socket as never);
    names.set(socket, String(req.headers['x-hatchabot-user'] ?? ''));
    socket.on('close', () => sockets.delete(socket as never));
    g.upgrades.push({ url: req.url ?? '', headers: req.headers });
    const identity = req.headers['x-hatchabot-user'] as string | undefined;
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = (o: unknown) => socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(o)), false));
    send({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n' } });
    const reader = new FrameReader(1 << 20);
    socket.on('data', (d: Buffer) => {
      for (const f of reader.push(d)) {
        if (f.opcode === 0x8) { socket.end(); continue; }
        if (f.opcode !== 0x1) continue;
        const m = JSON.parse(f.payload.toString());
        g.received.push({ identity, method: m.method, params: m.params });
        if (m.method === 'connect' && g.allow && !g.allow.has(identity ?? '')) {
          g.refusedConnects.push(identity ?? '');
          send({ type: 'res', id: m.id, ok: false, error: { code: 'INVALID_REQUEST', message: 'unauthorized', details: { code: 'AUTH_UNAUTHORIZED' } } });
          socket.end();
        } else if (m.method === 'connect') {
          send({ type: 'res', id: m.id, ok: true, payload: { type: 'hello-ok', auth: { scopes: g.scopes(identity) }, snapshot: {
            presence: [{ mode: 'gateway', reason: 'self' }, { mode: 'webchat', user: { email: ['owner-somebody', 'hatchabot.invalid'].join('@') } }],
          } } });
        } else {
          send({ type: 'res', id: m.id, ok: true, payload: { method: m.method } });
        }
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  g.port = (server.address() as { port: number }).port;
  toClose.push({ close: () => { for (const s of sockets) s.destroy(); server.close(); } });
  return g;
}

async function world(opts: {
  mode?: 'trusted-proxy' | 'token'; allowUsers?: 'in-step' | 'missing-guest'; ownerAdmin?: boolean;
  /** Accounts sign-in (web chat invites need it). */
  authMode?: 'accounts';
  /**
   * The gateway as it really behaves: its list of names is what the last
   * `config set` wrote, it refuses anyone else, and a new list takes effect a
   * moment after the write (the reload) — every open console dropping then.
   */
  liveList?: { reloadMs: number };
} = {}) {
  const gw = await fakeGateway();
  const db = new Database(':memory:');
  const store = new Store(db);
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'taco', workspace: { files: {}, configPatch: { agentId: 'taco', authMode: 'api-key' } as never }, env: {} } as never);
  await provider.start(runtimeRef);
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Taco', slug: 'taco', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  const token = randomBytes(16).toString('hex'); // made at run time: never a real-looking token in the repo
  db.prepare('UPDATE agents SET gateway_port = ?, gateway_token = ? WHERE id = ?').run(gw.port, token, 'a1');
  const now = new Date().toISOString();
  store.insertMembership({ id: 'm1', agentId: 'a1', userId: GUEST, role: 'user' as never, status: 'active', joinedAt: now, webChat: true, displayName: 'Anna' });
  store.insertMembership({ id: 'm2', agentId: 'a1', userId: OTHER, role: 'user' as never, status: 'active', joinedAt: now, webChat: false, displayName: 'Bob' });
  const agent = store.getAgent('a1')!;
  const want = consoleAllowUsers(store, agent, token);
  const setListed = (allowUsers: string[]) => provider.execResponses.set('sh', { code: 0, stderr: '', stdout: JSON.stringify({
    mode: opts.mode ?? 'trusted-proxy', roles: (opts.mode ?? 'trusted-proxy') === 'trusted-proxy',
    allowUsers, trustedProxies: ['172.18.0.1'], route: '172.18.0.1',
  }) });
  const initial = opts.allowUsers === 'missing-guest' ? want.slice(0, 1) : want;
  setListed(initial);
  /** Each list written, with when it was written and when it took effect. */
  const writes: Array<{ names: string[]; at: number; effective?: number }> = [];
  if (opts.liveList) {
    gw.allow = new Set(initial);
    const origExec = provider.exec.bind(provider);
    (provider as any).exec = async (ref: string, argv: string[], o?: any) => {
      const r = await origExec(ref, argv, o);
      if (argv[0] === 'config' && argv[1] === 'set') {
        const names = (JSON.parse(argv[3]!) as Array<{ path: string; value: unknown }>).find((b) => b.path === 'gateway.auth.trustedProxy.allowUsers')?.value as string[] | undefined;
        if (names) {
          setListed(names);
          const w: { names: string[]; at: number; effective?: number } = { names, at: Date.now() };
          writes.push(w);
          setTimeout(() => { gw.allow = new Set(names); w.effective = Date.now(); gw.dropAll(); }, opts.liveList!.reloadMs);
        }
      }
      return r;
    };
  }
  const ownerId = consoleIdentity(token, 'owner', OWNER);
  let ownerHasRole = opts.ownerAdmin !== false;
  gw.scopes = (id) => (id === ownerId && ownerHasRole ? ['operator.admin'] : id?.startsWith('guest-') ? ['operator.read', 'operator.write'] : []);
  provider.execResponses.set('gateway call users.list', { code: 0, stderr: '', stdout: JSON.stringify({ profiles: [
    { id: 'p-owner', emails: [ownerId] }, { id: 'p-old-owner', emails: [['owner-000000000000000000000000', 'hatchabot.invalid'].join('@')], role: OWNER_ROLE },
  ] }) });
  const setRole = { code: 0, stderr: '', stdout: '{}' };
  provider.execResponses.set('gateway call users.setRole', setRole);
  const app: FastifyInstance = Fastify();
  // The cookie names the caller: the one thing the upgrade path trusts (auth.ts's resolver in production).
  app.decorate('principalFromCookieHeader', (h: string | undefined) => {
    const u = /hbu=([\w-]+)/.exec(h ?? '')?.[1];
    return u ? { ownerId: u, via: 'identity' as const } : undefined;
  });
  await registerRoutes(app, { store, secrets: { get: async () => '', put: async () => {}, delete: async () => {} } as never, providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never, ...(opts.authMode ? { authMode: opts.authMode } : {}) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  toClose.push({ close: () => { const raw = app.server as Server; raw.closeAllConnections?.(); raw.close(); } });
  const port = (app.server.address() as { port: number }).port;
  const access = (app as unknown as { consoleAccess: ConsoleAccess }).consoleAccess;
  return { app, port, gw, store, provider, token, ownerId, guestId: consoleIdentity(token, 'guest', GUEST), access, writes, grantOwnerRole: () => { ownerHasRole = true; } };
}

/** A browser-side socket to the proxy, as `user`; resolves once the hello came back. */
function openConsole(port: number, user: string, extraHeaders: Record<string, string> = {}, path = '/v1/agents/a1/ui') {
  const WS = (globalThis as any).WebSocket;
  const ws = new WS(`ws://127.0.0.1:${port}${path}`, { headers: { cookie: `hbu=${user}`, ...extraHeaders } });
  const got: any[] = [];
  let closed = false;
  const waiters: Array<() => void> = [];
  ws.onmessage = (ev: { data: unknown }) => { got.push(JSON.parse(String(ev.data))); for (const w of waiters.splice(0)) w(); };
  ws.onclose = () => { closed = true; for (const w of waiters.splice(0)) w(); };
  // Node's WebSocket reports a refused handshake as an error, with no close event.
  ws.onerror = () => { closed = true; for (const w of waiters.splice(0)) w(); };
  const until = async (pred: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
    return pred();
  };
  const call = async (id: string, method: string, params: unknown = {}) => {
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
    await until(() => got.some((m) => m.id === id));
    return got.find((m) => m.id === id);
  };
  const ready = until(() => got.some((m) => m.event === 'connect.challenge') || closed).then(async () => {
    if (closed) return undefined;
    return call('c', 'connect', { role: 'operator', client: { id: 'openclaw-control-ui', mode: 'webchat' } });
  });
  toClose.push({ close: () => { try { ws.close(); } catch { /* */ } } });
  return { ws, got, call, until, ready, isClosed: () => closed };
}

describe('who may open the console, and what it is', () => {
  it('the owner and a web-chat guest; nobody else; a guest opens on their own conversation', async () => {
    const { app, token } = await world();
    const as = (u: string) => app.inject({ method: 'GET', url: '/v1/agents/a1/console/access', headers: { 'x-hatchabot-owner': u } });
    expect((await as(OWNER)).json()).toEqual({ role: 'owner', console: 'identity' });
    expect((await as(GUEST)).json()).toEqual({ role: 'guest', console: 'identity', session: guestConsoleSessionKey(token, 'taco', GUEST) });
    expect((await as(OTHER)).statusCode).toBe(404); // a member without web chat
    expect((await as('user-stranger')).statusCode).toBe(404);
  });

  it('an agent not rebuilt yet: the owner keeps the token console, a guest is told to use the chat here', async () => {
    const { app } = await world({ mode: 'token' });
    const owner = await app.inject({ method: 'GET', url: '/v1/agents/a1/console/access', headers: { 'x-hatchabot-owner': OWNER } });
    expect(owner.json()).toMatchObject({ role: 'owner', console: 'token' });
    const guest = await app.inject({ method: 'GET', url: '/v1/agents/a1/console/access', headers: { 'x-hatchabot-owner': GUEST } });
    expect(guest.json()).toMatchObject({ role: 'guest', console: 'needs-rebuild' });
    expect(guest.json().reason).toMatch(/rebuild/);
    const page = await app.inject({ method: 'GET', url: '/v1/agents/a1/ui/', headers: { 'x-hatchabot-owner': GUEST } });
    expect(page.statusCode).toBe(409);
  });
});

describe('what the gateway is told about the person (HTTP)', () => {
  it('the owner: their name and a forwarded address; never what the browser claimed', async () => {
    const { port, gw, ownerId, guestId } = await world();
    const res = await fetch(`http://127.0.0.1:${port}/v1/agents/a1/ui/assets/app.js`, { headers: {
      'x-hatchabot-owner': OWNER, 'x-hatchabot-user': guestId, 'x-openclaw-scopes': 'operator.read', 'x-forwarded-for': '203.0.113.9',
    } });
    expect(res.status).toBe(200);
    const h = gw.http.at(-1)!;
    expect(h['x-hatchabot-user']).toBe(ownerId);
    expect(h['x-openclaw-scopes']).toBeUndefined();
    expect(h['x-forwarded-for']).toBe('198.51.100.1'); // the proxy's own report of a local browser
    expect(h['x-hatchabot-owner']).toBeUndefined();
  });

  it('a guest: their own name, capped at read + write — even when they claim to be the owner', async () => {
    const { port, gw, ownerId, guestId } = await world();
    const res = await fetch(`http://127.0.0.1:${port}/v1/agents/a1/ui/chat`, { headers: {
      'x-hatchabot-owner': GUEST, 'x-hatchabot-user': ownerId, 'x-openclaw-scopes': 'operator.admin',
    } });
    expect(res.status).toBe(200);
    const h = gw.http.at(-1)!;
    expect(h['x-hatchabot-user']).toBe(guestId);
    expect(h['x-openclaw-scopes']).toBe('operator.read,operator.write');
  });

  it("a guest's request for an operator surface is refused here and never reaches the gateway", async () => {
    const { port, gw } = await world();
    const before = gw.http.length;
    for (const [m, p] of [['POST', '/tools/invoke'], ['GET', '/v1/models'], ['GET', '/mcp'], ['GET', '/systems']] as const) {
      const res = await fetch(`http://127.0.0.1:${port}/v1/agents/a1/ui${p}`, { method: m, headers: { 'x-hatchabot-owner': GUEST } });
      expect(res.status).toBe(403);
    }
    expect(gw.http.length).toBe(before);
  });

  it('a token gateway (not rebuilt): the owner is sent exactly as before — no name, nothing forwarded', async () => {
    const { port, gw } = await world({ mode: 'token' });
    await fetch(`http://127.0.0.1:${port}/v1/agents/a1/ui/assets/app.js`, { headers: { 'x-hatchabot-owner': OWNER, 'x-hatchabot-user': 'x' } });
    const h = gw.http.at(-1)!;
    expect(h['x-hatchabot-user']).toBeUndefined();
    expect(h['x-forwarded-for']).toBeUndefined();
  });
});

describe("a guest's socket", () => {
  it('is named as the guest, capped, uncompressed; chat passes, operator calls are answered by the proxy', async () => {
    const { port, gw, guestId, ownerId } = await world();
    const c = openConsole(port, GUEST, { 'x-hatchabot-user': ownerId, 'x-openclaw-scopes': 'operator.admin', 'sec-websocket-extensions': 'permessage-deflate' });
    const hello = await c.ready;
    expect(hello?.ok).toBe(true);
    // (The proxy's own connections as the owner — keeping the gateway in step — come and go too.)
    const up = gw.upgrades.find((u) => u.headers['x-hatchabot-user'] !== ownerId)!;
    expect(up.headers['x-hatchabot-user']).toBe(guestId);
    expect(up.headers['x-openclaw-scopes']).toBe('operator.read,operator.write');
    expect(up.headers['sec-websocket-extensions']).toBeUndefined();
    // Other people are not in what comes back.
    expect(JSON.stringify(hello)).not.toContain('owner-somebody');
    expect((await c.call('1', 'chat.send', { sessionKey: 'k', message: 'hi' })).ok).toBe(true);
    for (const [i, m] of ['logs.tail', 'config.get', 'users.list', 'audit.list', 'tools.invoke', 'cron.add'].entries()) {
      const r = await c.call(`x${i}`, m);
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('FORBIDDEN');
    }
    expect(gw.received.filter((r) => r.identity === guestId).map((r) => r.method)).toEqual(['connect', 'chat.send']);
  });

  it('closes the moment web chat is turned off for them', async () => {
    const { port, app, access } = await world();
    const c = openConsole(port, GUEST);
    expect((await c.ready)?.ok).toBe(true);
    expect(access.openGuests('a1')).toBe(1);
    const off = await app.inject({ method: 'PUT', url: `/v1/agents/a1/members/${GUEST}/web-chat`, headers: { 'x-hatchabot-owner': OWNER }, payload: { on: false } });
    expect(off.statusCode).toBe(200);
    expect(await c.until(() => c.isClosed())).toBe(true);
    expect(access.openGuests('a1')).toBe(0);
    // And it cannot come back.
    const again = openConsole(port, GUEST);
    expect(await again.ready).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: '/v1/agents/a1/ui/', headers: { 'x-hatchabot-owner': GUEST } })).statusCode).toBe(404);
  });

  it('closes when they are removed some other way (the sweep)', async () => {
    const { port, store, access } = await world();
    const c = openConsole(port, GUEST);
    expect((await c.ready)?.ok).toBe(true);
    store.revokeMembership('a1', GUEST);
    expect(access.sweepNow()).toBe(1);
    expect(await c.until(() => c.isClosed())).toBe(true);
  });

  it('is refused on a token gateway, for a stranger, and anywhere but the app root', async () => {
    const t = await world({ mode: 'token' });
    expect(await openConsole(t.port, GUEST).ready).toBeUndefined();
    const w = await world();
    expect(await openConsole(w.port, 'user-stranger').ready).toBeUndefined();
    expect(await openConsole(w.port, OTHER).ready).toBeUndefined();
    expect(await openConsole(w.port, GUEST, {}, '/v1/agents/a1/ui/__openclaw__/worker').ready).toBeUndefined();
  });

  it("the owner's socket is named, uncapped and passed through untouched", async () => {
    const { port, gw, ownerId } = await world();
    const c = openConsole(port, OWNER);
    const hello = await c.ready;
    expect(hello?.ok).toBe(true);
    expect(gw.upgrades.at(-1)!.headers['x-hatchabot-user']).toBe(ownerId);
    expect(gw.upgrades.at(-1)!.headers['x-openclaw-scopes']).toBeUndefined();
    expect(JSON.stringify(hello)).toContain('owner-somebody'); // nothing scrubbed for the owner
    expect((await c.call('1', 'config.get')).ok).toBe(true);
  });
});

describe('keeping the gateway in step', () => {
  it("adds a new guest's name before they connect", async () => {
    const { app, provider, guestId, ownerId } = await world({ allowUsers: 'missing-guest' });
    const res = await app.inject({ method: 'GET', url: '/v1/agents/a1/console/access', headers: { 'x-hatchabot-owner': GUEST } });
    expect(res.json().console).toBe('identity');
    const set = provider.execLog.find((a) => a[0] === 'config' && a[1] === 'set' && a[2] === '--batch-json');
    expect(set).toBeTruthy();
    expect(JSON.parse(set![3]!)).toEqual([{ path: 'gateway.auth.trustedProxy.allowUsers', value: [ownerId, guestId] }]);
  });

  it("gives the owner's profile the owner role on the first open, and takes it from anyone else", async () => {
    const w = await world({ ownerAdmin: false });
    // The stand-in gateway grants admin once the role is set.
    w.provider.execResponses.set('gateway call users.setRole', { code: 0, stderr: '', stdout: '{}' });
    const origExec = w.provider.exec.bind(w.provider);
    (w.provider as any).exec = async (ref: string, argv: string[], o?: any) => {
      const r = await origExec(ref, argv, o);
      if (argv.join(' ').startsWith('gateway call users.setRole') && argv[4]?.includes('"p-owner"')) w.grantOwnerRole();
      return r;
    };
    const res = await w.app.inject({ method: 'GET', url: '/v1/agents/a1/console/access', headers: { 'x-hatchabot-owner': OWNER } });
    expect(res.json()).toEqual({ role: 'owner', console: 'identity' });
    const roles = w.provider.execLog.filter((a) => a.slice(0, 3).join(' ') === 'gateway call users.setRole').map((a) => JSON.parse(a[4]!));
    expect(roles).toEqual([{ profileId: 'p-old-owner', role: null }, { profileId: 'p-owner', role: OWNER_ROLE }]);
  });
});

describe('the list of names changes when access changes, not at a first open (2026-09-30)', () => {
  const NEW = 'user-new-guest';
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (pred: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await sleep(20); return pred(); };
  const owner = { 'x-hatchabot-owner': OWNER };

  it("a web chat invite lists the guest when they join; their first open is let in at once and drops nobody's console", async () => {
    const w = await world({ authMode: 'accounts', liveList: { reloadMs: 250 } });
    const o = openConsole(w.port, OWNER);
    expect((await o.ready)?.ok).toBe(true);
    const inv = await w.app.inject({ method: 'POST', url: '/v1/agents/a1/invites', headers: owner, payload: { webChat: true } });
    expect(inv.statusCode).toBe(201);
    const join = await w.app.inject({ method: 'POST', url: '/v1/join', headers: { 'x-hatchabot-owner': NEW }, payload: { code: inv.json().code, name: 'Cara' } });
    expect(join.statusCode).toBe(201);
    const newId = consoleIdentity(w.token, 'guest', NEW);
    // Written at the join, before anyone asked for the console…
    expect(await until(() => w.writes.length === 1)).toBe(true);
    expect(w.writes[0]!.names).toContain(newId);
    // …and the console/access their page asks first waits until the gateway took it.
    const acc = await w.app.inject({ method: 'GET', url: '/v1/agents/a1/console/access', headers: { 'x-hatchabot-owner': NEW } });
    expect(acc.json()).toMatchObject({ role: 'guest', console: 'identity' });
    expect(w.writes[0]!.effective).toBeDefined();
    // The reload happened then: the owner's console dropped at the grant, while the guest was not connected.
    expect(w.gw.dropped).toContain(w.ownerId);
    const o2 = openConsole(w.port, OWNER);
    expect((await o2.ready)?.ok).toBe(true);
    const dropped = w.gw.dropped.length;
    // Their first open: in on the first try, nothing written, nobody dropped.
    const g = openConsole(w.port, NEW);
    const hello = await g.ready;
    expect(hello?.ok).toBe(true);
    await sleep(400);
    expect(w.writes).toHaveLength(1);
    expect(w.gw.dropped.length).toBe(dropped);
    expect(o2.isClosed()).toBe(false);
    expect(g.isClosed()).toBe(false);
  });

  it('an open that finds the list out of step (the grant missed it) fixes it — and lets them in only once it took effect', async () => {
    const w = await world({ allowUsers: 'missing-guest', liveList: { reloadMs: 250 } });
    const g = openConsole(w.port, GUEST);
    const hello = await g.ready;
    expect(hello?.ok).toBe(true); // never the "unauthorized" of the old first open
    expect(w.writes.map((x) => x.names)).toEqual([[w.ownerId, w.guestId]]);
    const browserConnect = w.gw.received.filter((r) => r.identity === w.guestId && r.method === 'connect' && r.params?.client?.id === 'openclaw-control-ui');
    expect(browserConnect).toHaveLength(1);
    expect(w.gw.refusedConnects.filter((n) => n === w.guestId).length).toBeGreaterThan(0); // only the proxy's own probes met the old list
  });

  it('a grant made while an older run is in flight gets its own run (not the older list)', async () => {
    const w = await world({ liveList: { reloadMs: 50 } });
    const agent = w.store.getAgent('a1')!;
    const first = w.access.ensureReady(agent);
    const on = await w.app.inject({ method: 'PUT', url: `/v1/agents/a1/members/${OTHER}/web-chat`, headers: owner, payload: { on: true } });
    expect(on.statusCode).toBe(200);
    expect((await first).mode).toBe('identity');
    const otherId = consoleIdentity(w.token, 'guest', OTHER);
    expect(await until(() => w.writes.some((x) => x.names.includes(otherId) && x.effective !== undefined))).toBe(true);
  });

  it('a removal takes the name off at once (the switch, and removing them)', async () => {
    const w = await world({ liveList: { reloadMs: 50 } });
    const off = await w.app.inject({ method: 'PUT', url: `/v1/agents/a1/members/${GUEST}/web-chat`, headers: owner, payload: { on: false } });
    expect(off.statusCode).toBe(200);
    expect(await until(() => w.writes.length === 1)).toBe(true);
    expect(w.writes[0]!.names).toEqual([w.ownerId]);
    const on = await w.app.inject({ method: 'PUT', url: `/v1/agents/a1/members/${GUEST}/web-chat`, headers: owner, payload: { on: true } });
    expect(on.statusCode).toBe(200);
    expect(await until(() => w.writes.length === 2)).toBe(true);
    const del = await w.app.inject({ method: 'DELETE', url: `/v1/agents/a1/members/${GUEST}`, headers: owner });
    expect(del.statusCode).toBe(200);
    expect(await until(() => w.writes.length === 3)).toBe(true);
    expect(w.writes[2]!.names).toEqual([w.ownerId]);
  });

  it('a grant while it was stopped is listed when it starts, before anyone opens the console', async () => {
    const w = await world({ liveList: { reloadMs: 50 } });
    const agent = w.store.getAgent('a1')!;
    await w.provider.stop(agent.runtimeRef!);
    w.store.setAgentState('a1', 'STOPPED');
    const on = await w.app.inject({ method: 'PUT', url: `/v1/agents/a1/members/${OTHER}/web-chat`, headers: owner, payload: { on: true } });
    expect(on.statusCode).toBe(200);
    await sleep(100);
    expect(w.writes).toHaveLength(0); // nothing to reach while it is down
    const start = await w.app.inject({ method: 'POST', url: '/v1/agents/a1/start', headers: owner });
    expect(start.statusCode).toBe(200);
    const otherId = consoleIdentity(w.token, 'guest', OTHER);
    expect(await until(() => w.writes.some((x) => x.names.includes(otherId)))).toBe(true);
    // In step already: a start reads the state and does nothing more.
    const writes = w.writes.length;
    expect(await w.access.syncWhenUp('a1', { sleep: async () => {} })).toBeUndefined();
    expect(w.writes.length).toBe(writes);
  });
});

describe("a guest's page over HTTP (2026-09-30)", () => {
  it("a guest's document loads the view script first; the owner's does not; the script is Hatchabot's own", async () => {
    const { port, gw } = await world();
    const g = await fetch(`http://127.0.0.1:${port}/v1/agents/a1/ui/chat`, { headers: { 'x-hatchabot-owner': GUEST, 'if-none-match': '"doc"' } });
    const page = await g.text();
    expect(g.status).toBe(200);
    expect(g.headers.get('etag')).toBeNull(); // not the gateway's bytes: no validator to mix them up by
    expect(gw.http.at(-1)!['if-none-match']).toBeUndefined();
    const tag = '<script src="/v1/agents/a1/ui/__hatchabot/guest-view.js"></script>';
    expect(page.indexOf(tag)).toBeGreaterThan(-1);
    expect(page.indexOf(tag)).toBeLessThan(page.indexOf('<script>theme()'));
    expect(page).toContain('src="/v1/agents/a1/ui/assets/app.js"'); // rebased as before
    const o = await fetch(`http://127.0.0.1:${port}/v1/agents/a1/ui/chat`, { headers: { 'x-hatchabot-owner': OWNER } });
    expect(await o.text()).not.toContain('guest-view.js');
    const before = gw.http.length;
    const s = await fetch(`http://127.0.0.1:${port}/v1/agents/a1/ui/__hatchabot/guest-view.js`, { headers: { 'x-hatchabot-owner': GUEST } });
    expect(s.status).toBe(200);
    expect(s.headers.get('content-type')).toMatch(/javascript/);
    expect(await s.text()).toContain('openclaw.control.settings.v1:');
    expect(gw.http.length).toBe(before); // never the gateway's
    const stranger = await fetch(`http://127.0.0.1:${port}/v1/agents/a1/ui/__hatchabot/guest-view.js`, { headers: { 'x-hatchabot-owner': 'user-stranger' } });
    expect(stranger.status).toBe(404);
  });

  it("a guest's boot settings have no community invite; the owner's are the gateway's own", async () => {
    const { port } = await world();
    const g = await (await fetch(`http://127.0.0.1:${port}/v1/agents/a1/ui/control-ui-config.json`, { headers: { 'x-hatchabot-owner': GUEST } })).json();
    expect(g).toMatchObject({ communityInvite: false, terminalEnabled: true });
    const o = await (await fetch(`http://127.0.0.1:${port}/v1/agents/a1/ui/control-ui-config.json`, { headers: { 'x-hatchabot-owner': OWNER } })).json() as { communityInvite?: boolean };
    expect(o.communityInvite).toBe(true);
  });
});

describe('the state read and the sync (pure)', () => {
  it('reads a gateway as identity only with trusted-proxy AND roles', () => {
    expect(parseConsoleState('{"mode":"trusted-proxy","roles":true,"allowUsers":["a"],"trustedProxies":["1.2.3.4"],"route":"172.18.0.1"}'))
      .toEqual({ mode: 'identity', allowUsers: ['a'], trustedProxies: ['1.2.3.4'], route: '172.18.0.1' });
    expect(parseConsoleState('{"mode":"trusted-proxy","roles":false}')?.mode).toBe('token');
    expect(parseConsoleState('{"mode":"token"}')?.mode).toBe('token');
    expect(parseConsoleState('nope')).toBeUndefined();
  });
  it('syncs names and the real proxy address, dropping the placeholder; nothing when in step', () => {
    const s = { mode: 'identity' as const, allowUsers: ['o', 'g1'], trustedProxies: ['192.0.2.1'], route: '172.18.0.1' };
    expect(consoleSyncBatch(s, ['o', 'g2'])).toEqual([
      { path: 'gateway.auth.trustedProxy.allowUsers', value: ['o', 'g2'] },
      { path: 'gateway.trustedProxies', value: ['172.18.0.1'] },
    ]);
    expect(consoleSyncBatch({ ...s, trustedProxies: ['172.18.0.1'] }, ['g1', 'o'])).toBeUndefined();
  });
});
