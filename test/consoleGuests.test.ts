import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { FrameReader, GUEST_CONNECT_TIMEOUT_MS, GUEST_IDLE_TO_CLOSE_MS, GUEST_ROOM_EVERY_MS, MAX_GUEST_CONSOLES, encodeFrame } from '../src/api/consoleProxy.js';
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
  /** The path of each HTTP request, as the gateway got it. */
  urls: string[];
  upgrades: Array<{ url: string; headers: IncomingHttpHeaders }>;
  /** Upgrades for this identity are held, not answered (a gateway that hangs mid-handshake) until letIn. */
  holdFor?: string;
  held: import('node:net').Socket[];
  /** Answer every upgrade held and still open. */
  letIn: () => void;
  /** Each connection it accepted, by name, with a way to send it a message. */
  conns: Array<{ identity?: string; send: (o: unknown) => void; write: (b: Buffer) => void; end: () => void }>;
  /** The payload of its answer to a request, when not the echo. */
  answer?: (method: string, params: any) => unknown;
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
  const g: FakeGateway = { port: 0, http: [], urls: [], upgrades: [], held: [], letIn: () => {}, conns: [], received: [], scopes: () => [], refusedConnects: [], dropAll: () => {}, dropped: [] };
  const holding: Array<() => void> = [];
  g.letIn = () => { for (const go of holding.splice(0)) go(); };
  const server: Server = createServer((req, res) => {
    g.http.push(req.headers);
    g.urls.push(req.url ?? '');
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
    if (g.holdFor && identity === g.holdFor) {
      g.held.push(socket as never);
      socket.on('error', () => {});
      socket.on('end', () => socket.destroy()); // the proxy gave up on it
      holding.push(() => { if (!socket.destroyed) answerUpgrade(req, socket, identity); });
      return;
    }
    answerUpgrade(req, socket, identity);
  });
  const answerUpgrade = (req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, identity: string | undefined) => {
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = (o: unknown) => socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(o)), false));
    g.conns.push({ identity, send, write: (b) => socket.write(b), end: () => socket.end() });
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
          send({ type: 'res', id: m.id, ok: true, payload: g.answer?.(m.method, m.params) ?? { method: m.method } });
        }
      }
    });
    socket.on('error', () => {});
  };
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
  const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'recipe', workspace: { files: {}, configPatch: { agentId: 'recipe', authMode: 'api-key' } as never }, env: {} } as never);
  await provider.start(runtimeRef);
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Recipe', slug: 'recipe', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
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
    expect((await as(GUEST)).json()).toEqual({ role: 'guest', console: 'identity', session: guestConsoleSessionKey(token, 'recipe', GUEST) });
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
    for (const [m, p] of [
      ['POST', '/tools/invoke'], ['GET', '/v1/models'], ['GET', '/mcp'], ['GET', '/systems'],
      // Paths the gateway's new URL() reads as an operator surface, though they start in /assets.
      ['GET', '/assets/x%5c..%5c..%5csessions/agent:recipe:main/history'], ['GET', '/assets/..%5C..%5Cmetrics'],
      ['GET', '/assets/.%09./.%09./metrics'],
    ] as const) {
      const res = await fetch(`http://127.0.0.1:${port}/v1/agents/a1/ui${p}`, { method: m, headers: { 'x-hatchabot-owner': GUEST } });
      expect(res.status).toBe(403);
    }
    expect(gw.http.length).toBe(before);
  });

  it("a guest's path reaches the gateway as it was judged: '//' would be read as a host", async () => {
    const { port, gw } = await world();
    const res = await fetch(`http://127.0.0.1:${port}/v1/agents/a1/ui//assets/sessions/agent:recipe:main/history?x=1`, { headers: { 'x-hatchabot-owner': GUEST } });
    expect(res.status).toBe(200);
    expect(gw.urls.at(-1)).toBe('/assets/sessions/agent:recipe:main/history?x=1');
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

  it('what the browser sends in the same packet as its upgrade request goes through the filter, not lost (HB-0593 review)', async () => {
    const { port, gw, guestId } = await world();
    const { connect } = await import('node:net');
    const req = (id: string, method: string, params: unknown = {}) => encodeFrame(0x1, Buffer.from(JSON.stringify({ type: 'req', id, method, params })), true);
    const sock = connect(port, '127.0.0.1');
    toClose.push({ close: () => sock.destroy() });
    await new Promise((r) => sock.once('connect', r));
    let got = Buffer.alloc(0);
    sock.on('data', (d: Buffer) => { got = Buffer.concat([got, d]); });
    sock.on('error', () => {});
    // The upgrade request and two requests after it, in one write: the two arrive as the upgrade's head.
    sock.write(Buffer.concat([
      Buffer.from([
        'GET /v1/agents/a1/ui HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', `Cookie: hbu=${GUEST}`, '', '',
      ].join('\r\n')),
      req('early-1', 'connect', { role: 'operator', client: { id: 'openclaw-control-ui', mode: 'webchat' } }),
      req('early-2', 'logs.tail'),
    ]));
    const replies = () => {
      const at = got.indexOf('\r\n\r\n');
      return at < 0 ? [] : new FrameReader(1 << 20).push(got.subarray(at + 4)).filter((f) => f.opcode === 0x1).map((f) => JSON.parse(f.payload.toString()));
    };
    const end = Date.now() + 3000;
    while (Date.now() < end && !(replies().some((m) => m.id === 'early-1') && replies().some((m) => m.id === 'early-2'))) await new Promise((r) => setTimeout(r, 20));
    expect(got.subarray(0, 12).toString()).toBe('HTTP/1.1 101');
    expect(gw.received.filter((r) => r.identity === guestId).map((r) => r.method)).toEqual(['connect']);
    expect(replies().find((m) => m.id === 'early-1')?.ok).toBe(true);
    expect(replies().find((m) => m.id === 'early-2')?.error?.code).toBe('FORBIDDEN');
  });

  /**
   * Move on the clock a chat's use is timed by (performance.now(); it keeps
   * running), by default past GUEST_IDLE_TO_CLOSE_MS: every chat open now
   * has gone unused that long.
   */
  const realNow = performance.now.bind(performance);
  let ahead = 0;
  const laterOn = (by = GUEST_IDLE_TO_CLOSE_MS + 1000) => {
    if (!vi.isMockFunction(performance.now)) vi.spyOn(performance, 'now').mockImplementation(() => realNow() + ahead);
    ahead += by;
  };
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); ahead = 0; });

  it(`a guest may have ${MAX_GUEST_CONSOLES} chats open at once; the next closes their least recently active one, unused for GUEST_IDLE_TO_CLOSE_MS (1001), and opens`, async () => {
    const { port, access } = await world();
    const open: Array<ReturnType<typeof openConsole>> = [];
    for (let i = 0; i < MAX_GUEST_CONSOLES; i++) {
      const c = openConsole(port, GUEST);
      expect((await c.ready)?.ok).toBe(true);
      open.push(c);
      await new Promise((r) => setTimeout(r, 5)); // each a little later than the last
    }
    expect(access.openGuests('a1', GUEST)).toBe(MAX_GUEST_CONSOLES);
    laterOn();
    // The first is used again: the second is now the least recently active.
    expect((await open[0]!.call('m1', 'chat.history'))?.ok).toBe(true);
    const codes: Array<{ code: number; reason: string }> = [];
    open[1]!.ws.addEventListener('close', (ev: { code: number; reason: string }) => codes.push({ code: ev.code, reason: ev.reason }));
    const ninth = openConsole(port, GUEST);
    expect((await ninth.ready)?.ok).toBe(true);
    expect(await open[1]!.until(() => open[1]!.isClosed())).toBe(true);
    expect(codes).toEqual([{ code: 1001, reason: 'opened in another tab' }]);
    expect(open.filter((c) => c.isClosed())).toEqual([open[1]]);
    expect(access.openGuests('a1', GUEST)).toBe(MAX_GUEST_CONSOLES);
    expect((await ninth.call('m2', 'chat.history'))?.ok).toBe(true);
  });

  it('a console whose browser went without a word (it looks open) never locks the guest out: it is the one closed', async () => {
    const { port, access } = await world();
    const { connect } = await import('node:net');
    // A browser that opened a console and then went silent (a phone asleep):
    // the server sees an open connection that never sends again.
    const silent = connect(port, '127.0.0.1');
    toClose.push({ close: () => silent.destroy() });
    silent.on('error', () => {});
    silent.on('data', () => {});
    await new Promise((r) => silent.once('connect', r));
    silent.write([
      'GET /v1/agents/a1/ui HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', `Cookie: hbu=${GUEST}`, '', '',
    ].join('\r\n'));
    const until = async (pred: () => boolean) => { for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20)); return pred(); };
    expect(await until(() => access.openGuests('a1', GUEST) === 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    const rest: Array<ReturnType<typeof openConsole>> = [];
    for (let i = 1; i < MAX_GUEST_CONSOLES; i++) { const c = openConsole(port, GUEST); expect((await c.ready)?.ok).toBe(true); rest.push(c); }
    laterOn();
    let gone = false;
    silent.on('close', () => { gone = true; });
    expect((await openConsole(port, GUEST).ready)?.ok).toBe(true);
    expect(await until(() => gone)).toBe(true);
    expect(rest.some((c) => c.isClosed())).toBe(false);
    expect(access.openGuests('a1', GUEST)).toBe(MAX_GUEST_CONSOLES);
  });

  it('one chat more is promised room at the door, and their least recently active idle one is closed only once it connects: not while it connects', async () => {
    const { port, gw, guestId, access } = await world();
    const open: Array<ReturnType<typeof openConsole>> = [];
    for (let i = 0; i < MAX_GUEST_CONSOLES; i++) {
      const c = openConsole(port, GUEST);
      expect((await c.ready)?.ok).toBe(true);
      open.push(c);
      await new Promise((r) => setTimeout(r, 5)); // each a little later than the last
    }
    laterOn();
    gw.holdFor = guestId;
    const codes: Array<{ code: number; reason: string }> = [];
    open[0]!.ws.addEventListener('close', (ev: { code: number; reason: string }) => codes.push({ code: ev.code, reason: ev.reason }));
    const ninth = openConsole(port, GUEST);
    expect(await ninth.until(() => gw.held.length === 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    // Promised, counted as gone, but open while the new one connects.
    expect(open.filter((c) => c.isClosed())).toEqual([]);
    expect(access.openGuests('a1', GUEST)).toBe(MAX_GUEST_CONSOLES);
    expect(access.openGuests('a1', GUEST, 'connecting')).toBe(1);
    gw.letIn();
    expect((await ninth.ready)?.ok).toBe(true);
    expect(await open[0]!.until(() => open[0]!.isClosed())).toBe(true);
    expect(codes).toEqual([{ code: 1001, reason: 'opened in another tab' }]);
    expect(open.filter((c) => c.isClosed())).toEqual([open[0]]);
    expect(access.openGuests('a1', GUEST)).toBe(MAX_GUEST_CONSOLES);
  });

  it('a connect that fails, or times out, closes nothing: the room promised goes back, and the next open takes it', async () => {
    const { port, gw, guestId, access } = await world();
    const open: Array<ReturnType<typeof openConsole>> = [];
    for (let i = 0; i < MAX_GUEST_CONSOLES; i++) {
      const c = openConsole(port, GUEST);
      expect((await c.ready)?.ok).toBe(true);
      open.push(c);
      await new Promise((r) => setTimeout(r, 5)); // each a little later than the last
    }
    laterOn();
    gw.holdFor = guestId;
    // The 30 s connect limit is made short here; nothing else waits that long.
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) =>
      (realSetTimeout as unknown as (...a: unknown[]) => NodeJS.Timeout)(fn, ms === GUEST_CONNECT_TIMEOUT_MS ? 300 : ms, ...rest)) as never);
    const { connect } = await import('node:net');
    const knock = async () => {
      const sock = connect(port, '127.0.0.1');
      toClose.push({ close: () => sock.destroy() });
      sock.on('error', () => {});
      const state = { sock, gone: false };
      sock.on('close', () => { state.gone = true; });
      await new Promise((r) => sock.once('connect', r));
      sock.write([
        'GET /v1/agents/a1/ui HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', `Cookie: hbu=${GUEST}`, '', '',
      ].join('\r\n'));
      return state;
    };
    const until = async (pred: () => boolean) => { for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => realSetTimeout(r, 20)); return pred(); };
    // The agent fails it.
    const failed = await knock();
    expect(await until(() => gw.held.length === 1)).toBe(true);
    gw.held[0]!.destroy();
    expect(await until(() => failed.gone)).toBe(true);
    expect(await until(() => access.openGuests('a1', GUEST, 'connecting') === 0)).toBe(true);
    expect(access.openGuests('a1', GUEST)).toBe(MAX_GUEST_CONSOLES); // the one promised counts again
    // The agent does not answer in time.
    const slow = await knock();
    expect(await until(() => gw.held.length === 2)).toBe(true);
    expect(await until(() => slow.gone)).toBe(true);
    expect(await until(() => access.openGuests('a1', GUEST, 'connecting') === 0)).toBe(true);
    expect(access.openGuests('a1', GUEST)).toBe(MAX_GUEST_CONSOLES);
    gw.letIn(); // too late: nothing is spliced
    await new Promise((r) => realSetTimeout(r, 100));
    expect(open.filter((c) => c.isClosed())).toEqual([]);
    // The promise went back, and with it the window: the next open closes the idle one as it would have.
    gw.holdFor = undefined;
    const next = openConsole(port, GUEST);
    expect((await next.ready)?.ok).toBe(true);
    expect(await open[0]!.until(() => open[0]!.isClosed())).toBe(true);
    expect(open.filter((c) => c.isClosed())).toEqual([open[0]]);
  });

  it('a console promised as room but used again before the new one connects stays: the new one is closed with 1008 (rare)', async () => {
    const { port, gw, guestId, access, app } = await world();
    const open: Array<ReturnType<typeof openConsole>> = [];
    for (let i = 0; i < MAX_GUEST_CONSOLES; i++) {
      const c = openConsole(port, GUEST);
      expect((await c.ready)?.ok).toBe(true);
      open.push(c);
      await new Promise((r) => setTimeout(r, 5));
    }
    laterOn();
    gw.holdFor = guestId;
    const ninth = openConsole(port, GUEST);
    const codes: Array<{ code: number; reason: string }> = [];
    ninth.ws.addEventListener('close', (ev: { code: number; reason: string }) => codes.push({ code: ev.code, reason: ev.reason }));
    expect(await ninth.until(() => gw.held.length === 1)).toBe(true);
    expect((await open[0]!.call('back', 'chat.history'))?.ok).toBe(true); // the one promised, used again
    const warn = vi.spyOn(app.log, 'warn');
    gw.letIn();
    expect(await ninth.until(() => ninth.isClosed())).toBe(true);
    expect(codes).toEqual([{ code: 1008, reason: `refused: you have ${MAX_GUEST_CONSOLES} chats open; close one` }]);
    await new Promise((r) => setTimeout(r, 100));
    expect(open.filter((c) => c.isClosed())).toEqual([]);
    expect(access.openGuests('a1', GUEST)).toBe(MAX_GUEST_CONSOLES);
    expect(warn.mock.calls.filter((c) => c.includes('console.guest_too_many' as never))).toHaveLength(1);
    expect(warn.mock.calls.some((c) => c.includes('console.guest_oldest_closed' as never))).toBe(false);
  });

  it(`at most ${MAX_GUEST_CONSOLES} of a guest's chats may be connecting at once; one more is not let in`, async () => {
    const { port, gw, guestId, access } = await world();
    gw.holdFor = guestId;
    const { connect } = await import('node:net');
    const knock = async () => {
      const sock = connect(port, '127.0.0.1');
      toClose.push({ close: () => sock.destroy() });
      sock.on('error', () => {});
      const state = { gone: false, got: Buffer.alloc(0) };
      sock.on('close', () => { state.gone = true; });
      sock.on('data', (d: Buffer) => { state.got = Buffer.concat([state.got, d]); });
      await new Promise((r) => sock.once('connect', r));
      sock.write([
        'GET /v1/agents/a1/ui HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', `Cookie: hbu=${GUEST}`, '', '',
      ].join('\r\n'));
      return state;
    };
    const until = async (pred: () => boolean) => { for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20)); return pred(); };
    const waiting = [];
    for (let i = 0; i < MAX_GUEST_CONSOLES; i++) waiting.push(await knock());
    expect(await until(() => gw.held.length === MAX_GUEST_CONSOLES)).toBe(true);
    const extra = await knock();
    expect(await until(() => extra.gone)).toBe(true);
    expect(extra.got.length).toBe(0);
    expect(gw.held).toHaveLength(MAX_GUEST_CONSOLES);
    expect(access.openGuests('a1', GUEST, 'connecting')).toBe(MAX_GUEST_CONSOLES);
    expect(waiting.some((w) => w.gone)).toBe(false);
  });

  it(`tabs in use do not close each other: with all ${MAX_GUEST_CONSOLES} used within GUEST_IDLE_TO_CLOSE_MS, one more is refused, and the tab closed for room, reconnecting, closes nothing`, async () => {
    const { port, access } = await world();
    const open: Array<ReturnType<typeof openConsole>> = [];
    for (let i = 0; i < MAX_GUEST_CONSOLES; i++) {
      const c = openConsole(port, GUEST);
      expect((await c.ready)?.ok).toBe(true);
      open.push(c);
    }
    laterOn();
    // All but the first are used again.
    for (const [i, c] of open.entries()) if (i) expect((await c.call(`use-${i}`, 'chat.history'))?.ok).toBe(true);
    // A ninth tab: the first, unused, is closed to make room.
    const ninth = openConsole(port, GUEST);
    expect((await ninth.ready)?.ok).toBe(true);
    expect(await open[0]!.until(() => open[0]!.isClosed())).toBe(true);
    // The closed tab reconnects, again and again: the eight open are all in use, so it is refused each time.
    for (let attempt = 0; attempt < 3; attempt++) {
      const again = openConsole(port, GUEST);
      expect(await again.ready).toBeUndefined();
      expect(again.isClosed()).toBe(true);
    }
    await new Promise((r) => setTimeout(r, 200));
    expect([...open.slice(1), ninth].filter((c) => c.isClosed())).toEqual([]);
    expect(access.openGuests('a1', GUEST)).toBe(MAX_GUEST_CONSOLES);
    expect((await ninth.call('still', 'chat.history'))?.ok).toBe(true);
  });

  it('two opens at once with one idle chat: the first is promised its place (closing it once connected), the second is refused at the door, before upgrading, and is not a visit', async () => {
    const { port, access, app, gw, guestId } = await world();
    const guestUpgrades = () => gw.upgrades.filter((u) => u.headers['x-hatchabot-user'] === guestId).length;
    const open: Array<ReturnType<typeof openConsole>> = [];
    for (let i = 0; i < MAX_GUEST_CONSOLES; i++) {
      const c = openConsole(port, GUEST);
      expect((await c.ready)?.ok).toBe(true);
      open.push(c);
    }
    laterOn();
    // All but the first are used again: one idle chat.
    for (const [i, c] of open.entries()) if (i) expect((await c.call(`use-${i}`, 'chat.history'))?.ok).toBe(true);
    const names = vi.spyOn(access, 'nameGuests');
    const info = vi.spyOn(app.log, 'info');
    const both = [openConsole(port, GUEST), openConsole(port, GUEST)];
    const ready = await Promise.all(both.map((c) => c.ready));
    expect(ready.filter((r) => r?.ok)).toHaveLength(1);
    expect(ready.filter((r) => r === undefined)).toHaveLength(1);
    expect(guestUpgrades()).toBe(MAX_GUEST_CONSOLES + 1); // the one refused never reached the agent
    expect(await open[0]!.until(() => open[0]!.isClosed())).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(open.filter((c) => c.isClosed())).toEqual([open[0]]);
    expect(access.openGuests('a1', GUEST)).toBe(MAX_GUEST_CONSOLES);
    expect(info.mock.calls.filter((c) => c.includes('console.guest_opened' as never))).toHaveLength(1);
    expect(names).toHaveBeenCalledTimes(1);
  });

  it(`chats unused for GUEST_ROOM_EVERY_MS or more (a phone that slept) may always be closed for room: three opens within a minute each close one`, async () => {
    const { port, access } = await world();
    const open: Array<ReturnType<typeof openConsole>> = [];
    for (let i = 0; i < MAX_GUEST_CONSOLES; i++) {
      const c = openConsole(port, GUEST);
      expect((await c.ready)?.ok).toBe(true);
      open.push(c);
      await new Promise((r) => setTimeout(r, 5)); // each a little later than the last
    }
    laterOn(GUEST_ROOM_EVERY_MS + 1000);
    for (let k = 0; k < 3; k++) {
      const c = openConsole(port, GUEST);
      expect((await c.ready)?.ok).toBe(true);
      expect(await open[k]!.until(() => open[k]!.isClosed())).toBe(true);
      laterOn(20_000);
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(open.filter((c) => c.isClosed())).toEqual(open.slice(0, 3));
    expect(access.openGuests('a1', GUEST)).toBe(MAX_GUEST_CONSOLES);
  });

  it('a chat being answered is not idle: the tab watching a reply stream for minutes without typing is not the one closed', async () => {
    const { port, gw, guestId, token } = await world();
    const open: Array<ReturnType<typeof openConsole>> = [];
    for (let i = 0; i < MAX_GUEST_CONSOLES; i++) {
      const c = openConsole(port, GUEST);
      expect((await c.ready)?.ok).toBe(true);
      open.push(c);
      await new Promise((r) => setTimeout(r, 5));
    }
    const sessionKey = guestConsoleSessionKey(token, 'recipe', GUEST);
    const conns = gw.conns.filter((c) => c.identity === guestId);
    expect(conns).toHaveLength(MAX_GUEST_CONSOLES);
    const a = open[0]!, toA = conns[0]!.send;
    // Tab A asks; the others are used a little later.
    expect((await a.call('say', 'chat.send', { message: 'plan my week' }))?.ok).toBe(true);
    laterOn(30_000);
    for (const [i, c] of open.entries()) if (i) expect((await c.call(`use-${i}`, 'chat.history'))?.ok).toBe(true);
    // A's answer streams, a piece every 30 s, for five minutes; at minute 3 a ninth opens.
    const stream = async (seq: number) => {
      laterOn(30_000);
      toA({ type: 'event', event: 'chat', payload: { sessionKey, state: 'delta', seq } });
      expect(await a.until(() => a.got.some((m) => m.event === 'chat' && m.payload?.seq === seq))).toBe(true);
    };
    for (let seq = 0; seq < 5; seq++) await stream(seq);
    const ninth = openConsole(port, GUEST);
    expect((await ninth.ready)?.ok).toBe(true);
    expect(await open[1]!.until(() => open[1]!.isClosed())).toBe(true);
    for (let seq = 5; seq < 9; seq++) await stream(seq);
    expect(a.isClosed()).toBe(false);
    expect(open.filter((c) => c.isClosed())).toEqual([open[1]]);
  });

  it('a chat whose answer is a long run, acknowledged and then only agent events for minutes, is being answered: not the one closed', async () => {
    const { port, gw, guestId, token } = await world();
    gw.answer = (method, params) => (method === 'chat.send' ? { runId: params?.idempotencyKey, status: 'started' } : undefined);
    const open: Array<ReturnType<typeof openConsole>> = [];
    for (let i = 0; i < MAX_GUEST_CONSOLES; i++) {
      const c = openConsole(port, GUEST);
      expect((await c.ready)?.ok).toBe(true);
      open.push(c);
      await new Promise((r) => setTimeout(r, 5));
    }
    const sessionKey = guestConsoleSessionKey(token, 'recipe', GUEST);
    const conns = gw.conns.filter((c) => c.identity === guestId);
    const a = open[0]!, toA = conns[0]!.send;
    // Tab A asks; the agent acknowledges at once (the run started); the others are used a little later.
    expect((await a.call('say', 'chat.send', { message: 'plan my week', idempotencyKey: 'run-a' }))?.payload).toEqual({ runId: 'run-a', status: 'started' });
    laterOn(30_000);
    for (const [i, c] of open.entries()) if (i) expect((await c.call(`use-${i}`, 'chat.history'))?.ok).toBe(true);
    // Three minutes of tool work: agent events only, no chat event.
    for (let seq = 0; seq < 6; seq++) {
      laterOn(30_000);
      toA({ type: 'event', event: 'agent', payload: { runId: 'run-a', sessionKey, seq, stream: 'tool', data: {} } });
      expect(await a.until(() => a.got.some((m) => m.event === 'agent' && m.payload?.seq === seq))).toBe(true);
    }
    const ninth = openConsole(port, GUEST);
    expect((await ninth.ready)?.ok).toBe(true);
    expect(await open[1]!.until(() => open[1]!.isClosed())).toBe(true);
    expect(a.isClosed()).toBe(false);
    expect(open.filter((c) => c.isClosed())).toEqual([open[1]]);
  });

  it('a chat still being sent what waits after the agent closed stays counted and closable: web chat turned off then closes it', async () => {
    const { port, app, gw, guestId, access } = await world();
    const { connect } = await import('node:net');
    const sock = connect(port, '127.0.0.1');
    toClose.push({ close: () => sock.destroy() });
    sock.on('error', () => {});
    let got = 0;
    let head = '';
    let gone = false;
    sock.on('data', (d: Buffer) => { got += d.length; if (head.length < 4096) head += d.toString('latin1'); });
    sock.on('close', () => { gone = true; });
    await new Promise((r) => sock.once('connect', r));
    sock.write([
      'GET /v1/agents/a1/ui HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', `Cookie: hbu=${GUEST}`, '', '',
    ].join('\r\n'));
    const until = async (pred: () => boolean) => { for (let i = 0; i < 150 && !pred(); i++) await new Promise((r) => setTimeout(r, 20)); return pred(); };
    expect(await until(() => head.includes('connect.challenge'))).toBe(true);
    const conn = gw.conns.find((c) => c.identity === guestId)!;
    // The browser stops reading; the agent sends 24 MB and closes, its close read with the end of it.
    sock.pause();
    const size = 24 * 1024 * 1024;
    const frame = encodeFrame(0x1, Buffer.from(JSON.stringify({ type: 'event', event: 'chat', payload: { text: 'x'.repeat(size) } })), false);
    conn.write(frame.subarray(0, frame.length - 100));
    await new Promise((r) => setTimeout(r, 300));
    conn.write(Buffer.concat([frame.subarray(frame.length - 100), encodeFrame(0x8, Buffer.from([0x03, 0xe8]), false)]));
    conn.end();
    await new Promise((r) => setTimeout(r, 300));
    expect(access.openGuests('a1', GUEST)).toBe(1); // still counted while it drains
    const off = await app.inject({ method: 'PUT', url: `/v1/agents/a1/members/${GUEST}/web-chat`, headers: { 'x-hatchabot-owner': OWNER }, payload: { on: false } });
    expect(off.statusCode).toBe(200);
    expect(await until(() => access.openGuests('a1', GUEST) === 0)).toBe(true);
    sock.resume();
    expect(await until(() => gone)).toBe(true);
    expect(got).toBeLessThan(size); // closed: the rest never came
  });

  it('an upload refused once whole puts back what its pieces marked: that chat is as idle as before it', async () => {
    const { port } = await world();
    // R: a chat over a plain socket, so its message can arrive in pieces.
    const { connect } = await import('node:net');
    const r = connect(port, '127.0.0.1');
    toClose.push({ close: () => r.destroy() });
    r.on('error', () => {});
    let rGot = '';
    let rGone = false;
    r.on('data', (d: Buffer) => { rGot += d.toString('latin1'); });
    r.on('close', () => { rGone = true; });
    await new Promise((res) => r.once('connect', res));
    r.write([
      'GET /v1/agents/a1/ui HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', `Cookie: hbu=${GUEST}`, '', '',
    ].join('\r\n'));
    const until = async (pred: () => boolean) => { for (let i = 0; i < 100 && !pred(); i++) await new Promise((res) => setTimeout(res, 20)); return pred(); };
    expect(await until(() => rGot.includes('connect.challenge'))).toBe(true);
    await new Promise((res) => setTimeout(res, 5));
    const open: Array<ReturnType<typeof openConsole>> = [];
    for (let i = 1; i < MAX_GUEST_CONSOLES; i++) {
      const c = openConsole(port, GUEST);
      expect((await c.ready)?.ok).toBe(true);
      open.push(c);
      await new Promise((res) => setTimeout(res, 5));
    }
    laterOn();
    // R sends a large message (its pieces count as it arrives), but it is not a request: refused once whole.
    const upload = encodeFrame(0x1, Buffer.from(JSON.stringify({ type: 'event', id: 'u1', method: 'chat.send', params: { message: 'w'.repeat(20_000) } })), true);
    for (let at = 0; at < upload.length; at += 5000) {
      r.write(upload.subarray(at, at + 5000));
      await new Promise((res) => setTimeout(res, 30));
    }
    expect(await until(() => rGot.includes('FORBIDDEN'))).toBe(true);
    // R is the least recently used again: a ninth closes it.
    const ninth = openConsole(port, GUEST);
    expect((await ninth.ready)?.ok).toBe(true);
    expect(await until(() => rGone)).toBe(true);
    expect(open.filter((c) => c.isClosed())).toEqual([]);
  });

  it(`idle tabs reconnecting do not close each other in turn: one is closed for room at most once in GUEST_ROOM_EVERY_MS (${GUEST_ROOM_EVERY_MS / 60_000} min); within it, one more is refused`, async () => {
    const { port, access } = await world();
    const open: Array<ReturnType<typeof openConsole>> = [];
    for (let i = 0; i < MAX_GUEST_CONSOLES; i++) {
      const c = openConsole(port, GUEST);
      expect((await c.ready)?.ok).toBe(true);
      open.push(c);
      await new Promise((r) => setTimeout(r, 5)); // each a little later than the last
    }
    laterOn();
    // A ninth: the first, idle, is closed for it.
    const ninth = openConsole(port, GUEST);
    expect((await ninth.ready)?.ok).toBe(true);
    expect(await open[0]!.until(() => open[0]!.isClosed())).toBe(true);
    // The closed tab reconnects every minute, the others idle (under GUEST_ROOM_EVERY_MS): within the window it is refused each time.
    for (let attempt = 0; attempt < 3; attempt++) {
      laterOn(60_000);
      const again = openConsole(port, GUEST);
      expect(await again.ready).toBeUndefined();
      expect(again.isClosed()).toBe(true);
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(open.filter((c) => c.isClosed())).toEqual([open[0]]);
    expect(ninth.isClosed()).toBe(false);
    // Used again, then idle once more (under GUEST_ROOM_EVERY_MS) past the window: one more may close the least recently used.
    for (const [i, c] of [...open.slice(1), ninth].entries()) expect((await c.call(`again-${i}`, 'chat.history'))?.ok).toBe(true);
    laterOn(GUEST_ROOM_EVERY_MS - 3 * 60_000 + 1000);
    const later = openConsole(port, GUEST);
    expect((await later.ready)?.ok).toBe(true);
    expect(await open[1]!.until(() => open[1]!.isClosed())).toBe(true);
    expect(open.filter((c) => c.isClosed())).toEqual([open[0], open[1]]);
  });

  it('a wall clock set forward makes no chat idle: past the limit, one more is refused and none is closed', async () => {
    const { port, access } = await world();
    const open: Array<ReturnType<typeof openConsole>> = [];
    for (let i = 0; i < MAX_GUEST_CONSOLES; i++) {
      const c = openConsole(port, GUEST);
      expect((await c.ready)?.ok).toBe(true);
      open.push(c);
    }
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(Date.now() + 10 * 60_000);
    const ninth = openConsole(port, GUEST);
    expect(await ninth.ready).toBeUndefined();
    expect(ninth.isClosed()).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(open.filter((c) => c.isClosed())).toEqual([]);
  });

  it(`a chat the agent never answers gives up its place after GUEST_CONNECT_TIMEOUT_MS: both sides are closed, and console.guest_connect_timeout is logged`, async () => {
    const { port, gw, guestId, access, app } = await world();
    gw.holdFor = guestId;
    // The 30 s are made short here; nothing else waits that long.
    const realSetTimeout = globalThis.setTimeout;
    const waited: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === GUEST_CONNECT_TIMEOUT_MS) waited.push(ms);
      return (realSetTimeout as unknown as (...a: unknown[]) => NodeJS.Timeout)(fn, ms === GUEST_CONNECT_TIMEOUT_MS ? 200 : ms, ...rest);
    }) as never);
    const warn = vi.spyOn(app.log, 'warn');
    const { connect } = await import('node:net');
    const sock = connect(port, '127.0.0.1');
    toClose.push({ close: () => sock.destroy() });
    sock.on('error', () => {});
    await new Promise((r) => sock.once('connect', r));
    let gone = false;
    sock.on('close', () => { gone = true; });
    sock.write([
      'GET /v1/agents/a1/ui HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', `Cookie: hbu=${GUEST}`, '', '',
    ].join('\r\n'));
    const until = async (pred: () => boolean) => { for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => realSetTimeout(r, 20)); return pred(); };
    expect(await until(() => gw.held.length === 1)).toBe(true);
    expect(access.openGuests('a1', GUEST, 'connecting')).toBe(1);
    expect(warn.mock.calls.some((c) => c.includes('console.guest_connect_timeout' as never))).toBe(false);
    expect(await until(() => gone)).toBe(true);
    expect(waited).toEqual([GUEST_CONNECT_TIMEOUT_MS]);
    expect(access.openGuests('a1', GUEST)).toBe(0);
    expect(warn.mock.calls.filter((c) => c.includes('console.guest_connect_timeout' as never))).toHaveLength(1);
    expect(await until(() => gw.held[0]!.destroyed)).toBe(true); // the request to the gateway is given up
  });

  it('room promised is their least recently active connected console, counted as gone at once and closed only when kept; released, nothing is; used again or gone meanwhile, nothing is', async () => {
    const { access } = await world();
    const closed: string[] = [];
    const how = { idleFor: 60_000, every: GUEST_ROOM_EVERY_MS };
    const long = performance.now() - 120_000; // two minutes ago
    access.trackGuest('agent-one', 'user-x', () => closed.push('agent-one destroyed'), { lastActive: () => long + 5, evict: () => closed.push('agent-one') });
    access.trackGuest('agent-two', 'user-x', () => {}, { lastActive: () => long + 1, evict: () => closed.push('agent-two'), connecting: () => true });
    access.trackGuest('agent-one', 'user-y', () => {}, { lastActive: () => long, evict: () => closed.push('user-y') });
    access.trackGuest('agent-four', 'user-x', () => {}, { lastActive: () => performance.now(), evict: () => closed.push('agent-four') });
    const first = access.promiseRoom('user-x', how)!;
    expect(first).toBeDefined();
    expect(closed).toEqual([]);
    expect(access.openGuests(undefined, 'user-x')).toBe(2); // agent-one counted as gone
    // A second open at once: the one connecting and the one used lately are passed over, so none.
    expect(access.promiseRoom('user-x', how)).toBeUndefined();
    first.release();
    first.release();
    expect(closed).toEqual([]);
    expect(access.openGuests(undefined, 'user-x')).toBe(3);
    // Released, the window went back too: it may be promised again, and kept.
    const again = access.promiseRoom('user-x', how)!;
    expect(again.keep()).toEqual({ closed: 'agent-one' });
    expect(again.keep()).toEqual({});
    again.release();
    expect(closed).toEqual(['agent-one']);
    expect(access.openGuests(undefined, 'user-x')).toBe(2);
    // Within the window, another idle one is not promised; one unused for GUEST_ROOM_EVERY_MS (a phone that slept) is.
    access.trackGuest('agent-five', 'user-x', () => {}, { lastActive: () => long, evict: () => closed.push('agent-five') });
    expect(access.promiseRoom('user-x', how)).toBeUndefined();
    access.trackGuest('agent-six', 'user-x', () => {}, { lastActive: () => performance.now() - GUEST_ROOM_EVERY_MS - 1000, evict: () => closed.push('agent-six') });
    expect(access.promiseRoom('user-x', how)!.keep()).toEqual({ closed: 'agent-six' });
    // Used again before the new one connects: refused, nothing closed, and promised no more.
    let used = long;
    access.trackGuest('agent-one', 'user-z', () => {}, { lastActive: () => used, evict: () => closed.push('user-z') });
    const z = access.promiseRoom('user-z', how)!;
    expect(access.openGuests(undefined, 'user-z')).toBe(0);
    used = performance.now();
    expect(z.keep()).toEqual({ refused: true });
    expect(access.openGuests(undefined, 'user-z')).toBe(1);
    used = long; // idle again: the window went back
    // Gone meanwhile (it closed by itself): its place is free, nothing more is closed.
    const forgetW = access.trackGuest('agent-one', 'user-w', () => {}, { lastActive: () => long, evict: () => closed.push('user-w') });
    const w = access.promiseRoom('user-w', how)!;
    forgetW();
    expect(w.keep()).toEqual({});
    expect(access.promiseRoom('user-z', how)!.keep()).toEqual({ closed: 'agent-one' });
    expect(closed).toEqual(['agent-one', 'agent-six', 'user-z']);
  });

  it("what a guest's chats hold is kept as a running total of their changes", async () => {
    const { access } = await world();
    expect(access.addGuestHeld('user-x', 100)).toBe(100);
    expect(access.addGuestHeld('user-y', 7)).toBe(7);
    expect(access.addGuestHeld('user-x', 50)).toBe(150);
    expect(access.addGuestHeld('user-x', 0)).toBe(150);
    expect(access.addGuestHeld('user-x', -150)).toBe(0);
    expect(access.addGuestHeld('user-y', -7)).toBe(0);
  });

  it('a guest dropped while the gateway is still answering (web chat switched off) leaves nothing open, and is not counted', async () => {
    const { port, gw, guestId, access } = await world();
    gw.holdFor = guestId;
    const { connect } = await import('node:net');
    const sock = connect(port, '127.0.0.1');
    toClose.push({ close: () => sock.destroy() });
    sock.on('error', () => {});
    await new Promise((r) => sock.once('connect', r));
    sock.write([
      'GET /v1/agents/a1/ui HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', `Cookie: hbu=${GUEST}`, '', '',
    ].join('\r\n'));
    const until = async (pred: () => boolean) => { for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 20)); return pred(); };
    expect(await until(() => gw.held.length === 1)).toBe(true);
    expect(access.openGuests('a1', GUEST)).toBe(1); // counted while it connects
    let closed = false;
    sock.on('close', () => { closed = true; });
    expect(access.dropGuests('a1', GUEST)).toBe(1);
    expect(await until(() => gw.held[0]!.destroyed)).toBe(true); // the request to the gateway is given up
    expect(await until(() => closed)).toBe(true);
    expect(access.openGuests('a1', GUEST)).toBe(0);
  });

  it("a console's forget works once: a late second call leaves a newer one counted", async () => {
    const { access } = await world();
    const forgetA = access.trackGuest('a1', 'user-a', () => {});
    forgetA();
    const forgetB = access.trackGuest('a1', 'user-b', () => {});
    forgetA(); // the socket and its upstream both closing
    expect(access.openGuests('a1', 'user-b')).toBe(1);
    expect(access.openGuests('a1')).toBe(1);
    forgetB();
    expect(access.openGuests('a1')).toBe(0);
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

describe('gatewayCallAs when the gateway cannot be reached', () => {
  it('fails once, without closing itself in a loop (a stack overflow in CI, 2026-10-06)', async () => {
    const { gatewayCallAs } = await import('../src/orchestrator/consoleAccess.js');
    const srv = createServer((_q, s) => { s.writeHead(403); s.end(); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as AddressInfo).port;
    // Count the closes: the loop usually ran out of stack inside a try and was
    // swallowed, so only sometimes did it surface as an uncaught exception.
    const Real = globalThis.WebSocket;
    let closes = 0;
    (globalThis as any).WebSocket = class extends Real { close(...a: any[]) { closes++; return super.close(...a); } };
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      await expect(gatewayCallAs({ host: '127.0.0.1', port } as any, 'test-guest', [], 2000)).rejects.toThrow(/could not reach|closed the connection/);
      await expect(gatewayCallAs({ host: '127.0.0.1', port: 1 } as any, 'test-guest', [], 2000)).rejects.toThrow(/could not reach|closed the connection/);
      await new Promise((r) => setTimeout(r, 100));
      expect(uncaught).toEqual([]);
      // Two calls, settled once each; Node's own WebSocket may close once more inside (seen on GitHub's runner, 2026-10-07). The loop was 1,248.
      expect(closes).toBeLessThanOrEqual(6);
    } finally {
      (globalThis as any).WebSocket = Real;
      process.off('uncaughtException', onUncaught);
      srv.close();
    }
  });
});
