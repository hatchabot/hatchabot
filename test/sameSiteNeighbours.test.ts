import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { _resetLoginThrottle, registerAuth } from '../src/api/auth.js';
import { hashPassword } from '../src/api/accountsAuth.js';
import { principalOf } from '../src/api/principal.js';
import { foreignRequest } from '../src/api/requestOrigin.js';
import { readSessionCookie, requestIsHttps } from '../src/api/sessionCookie.js';
import { registerRoutes } from '../src/api/routes.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * A hosted Hatchabot lives at <name>.my.hatchabot.com. Until that suffix is on
 * the Public Suffix List every tenant is the SAME site as every other, so
 * SameSite=Strict does not keep a neighbour's page from sending this tenant's
 * cookie, and the neighbour can plant cookies on the parent domain. Found by
 * a real-browser check (2026-10-01): a neighbour's page minted a CLI token and
 * signed the owner out everywhere with no-cors fetches, opened the console's
 * WebSocket, signed a fresh visitor in as another account by planting its
 * cookie on the parent domain, and signed the owner out by shadowing theirs.
 */

const SECRET = Buffer.alloc(32, 7);
const pw = (who: string) => [who, 'neighbour', 'test', '4'].join('-'); // made up, assembled at runtime
const HOST = 'maria.my.example.net';
const ENV = ['HATCHABOT_MANAGED_BY', 'HATCHABOT_PUBLIC_URL'];
beforeEach(() => _resetLoginThrottle());
afterEach(() => { for (const k of ENV) delete process.env[k]; });

const HTTPS = { 'x-forwarded-proto': 'https', host: HOST };
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', origin: `https://${HOST}` };
const NEIGHBOUR = { 'sec-fetch-site': 'same-site', origin: 'https://evil.my.example.net' };

async function accountsApp() {
  const store = new Store(new Database(':memory:'));
  const f = Fastify();
  const mk = async (username: string, hostOwner: boolean) => {
    const { hash, salt } = await hashPassword(pw(username));
    const id = `acct-${randomUUID()}`;
    store.insertLocalAccount({ id, username, pwHash: hash, pwSalt: salt, hostOwner, disabled: false, createdAt: new Date().toISOString() });
    return id;
  };
  const ownerId = await mk('owner', true);
  const memberId = await mk('member', false);
  await registerAuth(f, { secret: SECRET, mode: 'accounts', store, cliTokenOwner: (t) => store.ownerForCliToken(t) });
  f.get('/v1/whoami', async (req) => principalOf(req));
  f.post('/v1/change-something', async (req) => ({ by: principalOf(req).ownerId }));
  return { f, store, ownerId, memberId };
}
const login = (f: FastifyInstance, username: string, headers: Record<string, string> = {}) =>
  f.inject({ method: 'POST', url: '/v1/login', headers, payload: { username, password: pw(username) } });
const jar = (res: { cookies: Array<{ name: string; value: string }> }) =>
  res.cookies.filter((c) => c.value).map((c) => `${c.name}=${c.value}`).join('; ');

describe('requests a page on another site makes the browser send', () => {
  it('Sec-Fetch-Site decides when the browser sends it', () => {
    expect(foreignRequest({ headers: { 'sec-fetch-site': 'same-origin' } })).toBeUndefined();
    expect(foreignRequest({ headers: { 'sec-fetch-site': 'none' } })).toBeUndefined();
    expect(foreignRequest({ headers: { 'sec-fetch-site': 'same-site' } })).toMatch(/same-site/);
    expect(foreignRequest({ headers: { 'sec-fetch-site': 'cross-site' } })).toMatch(/cross-site/);
    // A proxy that rewrites Host does not make our own pages look foreign.
    expect(foreignRequest({ headers: { 'sec-fetch-site': 'same-origin', origin: 'https://app.example.com', host: '127.0.0.1:8080' } })).toBeUndefined();
  });

  it('without it, Origin must name this machine: its Host, a proxy\'s X-Forwarded-Host, or the public URL', () => {
    expect(foreignRequest({ headers: { origin: `https://${HOST}`, host: HOST } })).toBeUndefined();
    expect(foreignRequest({ headers: { origin: 'http://192.168.1.20:8080', host: '192.168.1.20:8080' } })).toBeUndefined();
    expect(foreignRequest({ headers: { origin: `https://${HOST}`, host: `${HOST}:443` } })).toBeUndefined();
    expect(foreignRequest({ headers: { origin: 'HTTPS://Maria.My.Example.Net', host: HOST } })).toBeUndefined();
    expect(foreignRequest({ headers: { origin: `https://${HOST}`, host: '127.0.0.1:8080', 'x-forwarded-host': HOST } })).toBeUndefined();
    expect(foreignRequest({ headers: { origin: `https://${HOST}`, host: '127.0.0.1:8080' } }, { HATCHABOT_PUBLIC_URL: `https://${HOST}/` })).toBeUndefined();
    expect(foreignRequest({ headers: { origin: 'https://evil.my.example.net', host: HOST } })).toMatch(/evil/);
    expect(foreignRequest({ headers: { origin: `https://${HOST}:8443`, host: HOST } })).toMatch(/origin/);
    expect(foreignRequest({ headers: { origin: 'null', host: HOST } })).toMatch(/null/);
  });

  it('no browser headers at all (the CLI, a runner, another Hatchabot, an agent) is not a browser: it passes', () => {
    expect(foreignRequest({ headers: { host: HOST } })).toBeUndefined();
  });

  it('a neighbour\'s state-changing request is refused before it is signed in or acted on', async () => {
    const { f, ownerId } = await accountsApp();
    const cookie = jar(await login(f, 'owner'));
    const theirs = await f.inject({ method: 'POST', url: '/v1/change-something', headers: { cookie, ...NEIGHBOUR } });
    expect(theirs.statusCode).toBe(403);
    expect(theirs.json().error).toMatch(/another site/);
    const cross = await f.inject({ method: 'DELETE', url: '/v1/change-something', headers: { cookie, 'sec-fetch-site': 'cross-site' } });
    expect(cross.statusCode).toBe(403);
    // Signing out everywhere from a neighbour's page: refused, and the session lives.
    expect((await f.inject({ method: 'POST', url: '/v1/logout/everywhere', headers: { cookie, ...NEIGHBOUR } })).statusCode).toBe(403);
    expect((await f.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie } })).json().ownerId).toBe(ownerId);
    // An older browser (no Sec-Fetch-Site) with a foreign Origin: refused too.
    expect((await f.inject({ method: 'POST', url: '/v1/change-something', headers: { cookie, host: HOST, origin: 'https://evil.my.example.net' } })).statusCode).toBe(403);
    // The app's own page, and a non-browser caller: as before.
    const mine = await f.inject({ method: 'POST', url: '/v1/change-something', headers: { cookie, host: HOST, ...SAME_ORIGIN } });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().by).toBe(ownerId);
    expect((await f.inject({ method: 'POST', url: '/v1/change-something', headers: { cookie } })).statusCode).toBe(200);
  });

  it('signing in from a neighbour\'s page (login CSRF) is refused; reads and the sign-in link (a GET) are not affected', async () => {
    const { f } = await accountsApp();
    const r = await login(f, 'member', NEIGHBOUR);
    expect(r.statusCode).toBe(403);
    expect(r.cookies.filter((c) => c.value)).toEqual([]);
    expect((await login(f, 'owner', SAME_ORIGIN)).statusCode).toBe(200);
    expect((await f.inject({ method: 'GET', url: '/v1/config', headers: NEIGHBOUR })).statusCode).not.toBe(403);
  });
});

describe('the session cookie is __Host- over HTTPS', () => {
  it('over HTTPS: __Host-hatchabot_session, Secure, Path=/, no Domain; over HTTP: hatchabot_session as before', async () => {
    const { f } = await accountsApp();
    const s = await login(f, 'owner', HTTPS);
    expect(s.statusCode).toBe(200);
    const c = s.cookies.find((x) => x.value)!;
    expect(c).toMatchObject({ name: '__Host-hatchabot_session', secure: true, path: '/', httpOnly: true, sameSite: 'Strict' });
    expect(c.domain).toBeUndefined();
    const h = (await login(f, 'owner')).cookies.find((x) => x.value)!;
    expect(h.name).toBe('hatchabot_session');
    expect(h.secure).toBeFalsy();
  });

  it('a __Host- cookie signs in, and is the only one looked at: a planted plain cookie for someone else is ignored', async () => {
    const { f, ownerId } = await accountsApp();
    const mine = jar(await login(f, 'owner', HTTPS));
    const planted = jar(await login(f, 'member')); // plain-named, as one planted on the parent domain would be
    // The browser sends the parent-domain cookie first when its Path is longer; order must not matter.
    for (const cookie of [`${planted}; ${mine}`, `${mine}; ${planted}`]) {
      const r = await f.inject({ method: 'GET', url: '/v1/whoami', headers: { ...HTTPS, cookie } });
      expect(r.json().ownerId).toBe(ownerId);
    }
    // …and a junk one with a longer Path does not sign the owner out (shadowing).
    expect((await f.inject({ method: 'GET', url: '/v1/whoami', headers: { ...HTTPS, cookie: `hatchabot_session=junk; ${mine}` } })).json().ownerId).toBe(ownerId);
  });

  it('hosted (managed) over HTTPS: a plain-named cookie — the one a neighbour can plant — signs nobody in (no fixation)', async () => {
    process.env.HATCHABOT_MANAGED_BY = 'Example Cloud';
    const { f } = await accountsApp();
    const planted = jar(await login(f, 'member')); // a real session, as a neighbour with an account here could plant
    expect(planted).toMatch(/^hatchabot_session=/);
    const r = await f.inject({ method: 'GET', url: '/v1/whoami', headers: { ...HTTPS, cookie: planted } });
    expect(r.statusCode).toBe(401);
    // Over plain HTTP the prefix is impossible, so the plain name still works there.
    expect((await f.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie: planted } })).statusCode).toBe(200);
  });

  it('a home install over HTTPS keeps a session from before the change, and moves it to the new name on first use', async () => {
    const { f, ownerId } = await accountsApp();
    const old = jar(await login(f, 'owner')); // minted under the plain name
    const r = await f.inject({ method: 'GET', url: '/v1/whoami', headers: { ...HTTPS, cookie: old } });
    expect(r.json().ownerId).toBe(ownerId);
    const moved = r.cookies.find((c) => c.name === '__Host-hatchabot_session')!;
    expect(moved).toMatchObject({ secure: true, path: '/', httpOnly: true, sameSite: 'Strict' });
    expect(moved.value).toBe(old.split('=').slice(1).join('='));
    expect(r.cookies.find((c) => c.name === 'hatchabot_session')?.value).toBe(''); // cleared
    const next = await f.inject({ method: 'GET', url: '/v1/whoami', headers: { ...HTTPS, cookie: `__Host-hatchabot_session=${moved.value}` } });
    expect(next.json().ownerId).toBe(ownerId);
    expect(next.cookies).toEqual([]); // nothing more to move
  });

  it('signing out over HTTPS clears the __Host- cookie (with the attributes the browser needs to accept that) and the old names', async () => {
    const { f } = await accountsApp();
    const cookie = jar(await login(f, 'owner', HTTPS));
    const out = await f.inject({ method: 'POST', url: '/v1/logout', headers: { ...HTTPS, cookie } });
    const cleared = Object.fromEntries(out.cookies.map((c) => [c.name, c]));
    expect(cleared['__Host-hatchabot_session']).toMatchObject({ value: '', secure: true, path: '/' });
    expect(cleared['hatchabot_session']?.value).toBe('');
    expect(cleared['agentclaw_session']?.value).toBe('');
  });

  it('password and identity modes name it the same way', async () => {
    const p = Fastify();
    await registerAuth(p, { password: pw('shared'), secret: SECRET, mode: 'password' });
    p.get('/v1/whoami', async (req) => principalOf(req));
    const pr = await p.inject({ method: 'POST', url: '/v1/login', headers: HTTPS, payload: { password: pw('shared') } });
    expect(pr.cookies.find((c) => c.value)?.name).toBe('__Host-hatchabot_session');
    expect((await p.inject({ method: 'GET', url: '/v1/whoami', headers: { ...HTTPS, cookie: jar(pr) } })).statusCode).toBe(200);

    const i = Fastify();
    const verifier = { verify: async () => ({ sub: 'g1', email: 'g1@example.com', emailVerified: true, expMs: Date.now() + 3600_000 }) };
    await registerAuth(i, { secret: SECRET, mode: 'identity', store: new Store(new Database(':memory:')), verifier: verifier as never });
    i.get('/v1/whoami', async (req) => principalOf(req));
    const ir = await i.inject({ method: 'POST', url: '/v1/session', headers: HTTPS, payload: { idToken: 'made-up' } });
    expect(ir.statusCode).toBe(200);
    expect(ir.cookies.find((c) => c.value)?.name).toBe('__Host-hatchabot_session');
    expect((await i.inject({ method: 'GET', url: '/v1/whoami', headers: { ...HTTPS, cookie: jar(ir) } })).json().ownerId).toBe('user-g1');
    // Identity sign-in from a neighbour's page: refused.
    expect((await i.inject({ method: 'POST', url: '/v1/session', headers: { ...HTTPS, ...NEIGHBOUR }, payload: { idToken: 'made-up' } })).statusCode).toBe(403);
  });

  it('what counts as HTTPS: the proxy\'s word, a TLS socket, or the https public URL\'s own host', () => {
    expect(requestIsHttps({ headers: { 'x-forwarded-proto': 'https' } }, {})).toBe(true);
    expect(requestIsHttps({ headers: { 'x-forwarded-proto': 'http', host: HOST } }, { HATCHABOT_PUBLIC_URL: `https://${HOST}` })).toBe(false);
    expect(requestIsHttps({ headers: {}, socket: { encrypted: true } }, {})).toBe(true);
    expect(requestIsHttps({ headers: { host: HOST } }, { HATCHABOT_PUBLIC_URL: `https://${HOST}` })).toBe(true);
    expect(requestIsHttps({ headers: { host: '192.168.1.20:8080' } }, { HATCHABOT_PUBLIC_URL: `https://${HOST}` })).toBe(false);
    expect(readSessionCookie('hatchabot_session=a', true, { HATCHABOT_MANAGED_BY: 'X' })).toBeUndefined();
    expect(readSessionCookie('hatchabot_session=a', true, {})).toEqual({ value: 'a', plainOverHttps: true });
    expect(readSessionCookie('hatchabot_session=a; __Host-hatchabot_session=b', true, {})).toEqual({ value: 'b', plainOverHttps: false });
  });
});

// ---- the console proxy ------------------------------------------------------

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}
const OWNER = 'user-owner';
let toClose: Array<FastifyInstance | Server> = [];
afterEach(() => {
  for (const s of toClose) {
    const raw: any = (s as any).server ?? s;
    try { raw.closeAllConnections?.(); raw.close?.(() => {}); raw.unref?.(); } catch { /* gone */ }
  }
  toClose = [];
});
let gatewaySaw: Record<string, string | string[] | undefined> = {};
async function consoleWorld() {
  const gw = createServer((req, res) => { gatewaySaw = req.headers; res.end('ok'); });
  gw.on('upgrade', (req, socket) => {
    gatewaySaw = req.headers;
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('echo:'), d])));
  });
  await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r));
  toClose.push(gw);
  const db = new Database(':memory:');
  const store = new Store(db);
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'A', slug: 'a', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'mock://a1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  db.prepare('UPDATE agents SET gateway_port = ?, gateway_token = ? WHERE id = ?').run((gw.address() as any).port, 'gw-token', 'a1');
  const app = Fastify();
  const calls: Array<{ cookie: string | undefined; https: boolean }> = [];
  app.decorate('principalFromCookieHeader', (cookie: string | undefined, https: boolean) => { calls.push({ cookie, https }); return { ownerId: OWNER, via: 'identity' } as any; });
  await registerRoutes(app, { store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  await app.listen({ port: 0, host: '127.0.0.1' });
  toClose.push(app);
  return { port: (app.server.address() as any).port as number, calls };
}
function upgrade(port: number, extra: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(`GET /v1/agents/a1/ui/ HTTP/1.1\r\nHost: ${HOST}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => { buf += d.toString(); if (buf.includes('101') && !buf.includes('echo:')) sock.write('ping'); if (buf.includes('echo:')) { sock.destroy(); resolve('OPEN'); } });
    sock.on('error', () => resolve('DESTROYED'));
    sock.on('close', () => resolve(buf.includes('echo:') ? 'OPEN' : 'DESTROYED'));
    setTimeout(() => { sock.destroy(); resolve('TIMEOUT'); }, 3000);
  });
}

describe('the console proxy', () => {
  it('a neighbour\'s page cannot open the console\'s WebSocket with this browser\'s cookie; the app\'s own page can', async () => {
    const { port, calls } = await consoleWorld();
    expect(await upgrade(port, 'Sec-Fetch-Site: same-site\r\nOrigin: https://evil.my.example.net\r\nCookie: __Host-hatchabot_session=x\r\n')).toBe('DESTROYED');
    expect(await upgrade(port, `Origin: https://evil.my.example.net\r\nCookie: __Host-hatchabot_session=x\r\n`)).toBe('DESTROYED');
    expect(calls).toEqual([]); // refused before the cookie was even read
    expect(await upgrade(port, `Sec-Fetch-Site: same-origin\r\nOrigin: https://${HOST}\r\nX-Forwarded-Proto: https\r\nCookie: __Host-hatchabot_session=x\r\n`)).toBe('OPEN');
    expect(calls.at(-1)).toEqual({ cookie: '__Host-hatchabot_session=x', https: true });
  });

  it('the gateway never sees the session cookie under either name', async () => {
    const { port } = await consoleWorld();
    const prev = process.env.HATCHABOT_ALLOW_OWNER_HEADER;
    process.env.HATCHABOT_ALLOW_OWNER_HEADER = '1';
    try {
      await fetch(`http://127.0.0.1:${port}/v1/agents/a1/ui/index.html`, { headers: { 'x-hatchabot-owner': OWNER, cookie: '__Host-hatchabot_session=s1; hatchabot_session=s2; agentclaw_session=s3; openclaw_pref=kept' } });
    } finally { if (prev === undefined) delete process.env.HATCHABOT_ALLOW_OWNER_HEADER; else process.env.HATCHABOT_ALLOW_OWNER_HEADER = prev; }
    expect(gatewaySaw.cookie).toBe('openclaw_pref=kept');
    await upgrade(port, `Sec-Fetch-Site: same-origin\r\nCookie: __Host-hatchabot_session=s1; openclaw_pref=kept\r\n`);
    expect(gatewaySaw.cookie).toBe('openclaw_pref=kept');
  });
});
