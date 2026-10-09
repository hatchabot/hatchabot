import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type Socket } from 'node:net';
import { Jar, PUBLIC_HOST, PUBLIC_URL, publicApp, type PublicApp } from './helpers/publicApp.js';
import { SoftAuthenticator } from './helpers/softAuthenticator.js';
import { base32Decode, totp } from '../src/api/totp.js';
import { parseFunnelStatus, targetsPort } from '../src/ops/tailnet.js';
import { evaluateSafeguards, failingSafeguards } from '../src/api/safeguards.js';
import { verifyAssertion, verifyRegistration, WebAuthnError } from '../src/api/webauthn.js';

/**
 * What a second, independent review of the public listener found
 * (2026-10-01), one test each, so none of it comes back.
 */
let h: PublicApp | undefined;
let extra: Array<Server | Socket> = [];
afterEach(async () => {
  for (const x of extra) { try { (x as Server).closeAllConnections?.(); (x as Server).close?.(() => {}); (x as Socket).destroy?.(); } catch { /* gone */ } }
  extra = [];
  try { h?.app.server.closeAllConnections(); } catch { /* not listening */ }
  await h?.close(); h = undefined;
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Sign in with the authenticator code of a chosen step (a code is good once; -1, 0 and +1 are three different ones). */
/**
 * A second sign-in with the same authenticator app. A code is good once and
 * the helper's sign-in used the latest step the server accepts, so this one
 * happens 45 seconds "later" (the clock is put back afterwards).
 */
async function signInAgain(app: PublicApp, username: string, password: string, secret: Buffer): Promise<Jar> {
  const realNow = Date.now;
  Date.now = () => realNow() + 45_000;
  try {
    const jar = new Jar();
    expect((await app.pub('/v1/login', { body: { username, password }, jar })).status).toBe(200);
    const v = await app.pub('/v1/second-factor/verify', { body: { code: totp(secret, Date.now() + 30_000) }, jar });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    return jar;
  } finally { Date.now = realNow; }
}

describe('a burst of guesses cannot outrun the sign-in limit', () => {
  it('sixty wrong passwords at once for one account: ten are checked, the rest are refused unchecked', async () => {
    h = await publicApp();
    await h.addAccount('owner', { owner: true });
    const bob = await h.addAccount('bob', { totp: false });
    await h.app.publicAccess!.evaluate();
    const burst = await Promise.all(Array.from({ length: 60 }, (_, i) =>
      h!.pub('/v1/login', { body: { username: 'bob', password: i === 59 ? bob.password : `guess-number-${i}` }, from: '198.51.100.77' })));
    const count = (code: number) => burst.filter((r) => r.status === code).length;
    // Before: every request that arrived while the first ten were still being hashed was checked too.
    expect(count(401)).toBeLessThanOrEqual(10);
    expect(count(401) + count(429)).toBe(60);
    // The right password, sent last in the burst, was not tried.
    expect(burst[59]!.status).toBe(429);
  }, 30_000);

  it('the same at the private address, and for one account from many addresses', async () => {
    h = await publicApp();
    await h.addAccount('owner', { owner: true });
    await h.addAccount('bob', { totp: false });
    await h.app.publicAccess!.evaluate();
    const priv = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      h!.app.inject({ method: 'POST', url: '/v1/login', payload: { username: 'bob', password: `guess-number-${i}` } })));
    expect(priv.filter((r) => r.statusCode === 401).length).toBeLessThanOrEqual(10);
    // Every guess from its own /64: the account's count still holds them to ten.
    const spread = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      h!.pub('/v1/login', { body: { username: 'owner', password: `guess-number-${i}` }, from: `2001:db8:${(i + 1).toString(16)}::1` })));
    expect(spread.filter((r) => r.status === 401).length).toBeLessThanOrEqual(10);
  }, 30_000);

  it('a place is given back: sign-ins one after another are not refused, and a right password still works after misses', async () => {
    h = await publicApp();
    await h.addAccount('owner', { owner: true });
    const bob = await h.addAccount('bob', { totp: false });
    await h.app.publicAccess!.evaluate();
    for (let i = 0; i < 3; i++) expect((await h.pub('/v1/login', { body: { username: 'bob', password: 'wrong-wrong-wrong' } })).status).toBe(401);
    for (let i = 0; i < 12; i++) expect((await h.pub('/v1/login', { body: { username: 'bob', password: bob.password } })).status).toBe(200);
  }, 30_000);
});

describe('Funnel started by hand without --bg is seen', () => {
  const foreground = JSON.stringify({
    Foreground: { 'sess-1': {
      TCP: { 443: { HTTPS: true } },
      Web: { 'box.example.com:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } } } },
      AllowFunnel: { 'box.example.com:443': true },
    } },
  });
  it('`tailscale funnel 8080` (a foreground session) pointed at the private port fails safeguard d', () => {
    const st = parseFunnelStatus(foreground);
    expect(st.readable).toBe(true);
    expect(st.entries.some((e) => targetsPort(e, 8080))).toBe(true);
    const checks = evaluateSafeguards({
      authMode: 'accounts', managed: false, admins: [{ id: 'a', name: 'owner', totp: 1, passkeyRpIds: [] }], invitedOnly: true, ownerHeader: false,
      ports: { main: 8080, public: 8092, ops: 8091, embed: 8093 }, autoUpgrade: { ok: true }, publicOn: true, loginFailLimit: 10,
      funnelOnPrivatePort: st.entries.some((e) => targetsPort(e, 8080)),
    });
    expect(failingSafeguards(checks).map((c) => c.id)).toEqual(['separate-listener']);
  });
  it('a background entry and a foreground one are both read; junk is unreadable, not empty', () => {
    const both = parseFunnelStatus(JSON.stringify({
      AllowFunnel: { 'box.example.com:8443': true }, Web: { 'box.example.com:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8092' } } } },
      Foreground: { s: { AllowFunnel: { 'box.example.com:10000': true }, TCP: { 10000: { TCPForward: '127.0.0.1:8080' } } }, t: null },
    }));
    expect(both.entries.map((e) => e.port).sort((a, b) => a - b)).toEqual([8443, 10000]);
    expect(both.entries.some((e) => targetsPort(e, 8080))).toBe(true);
    expect(parseFunnelStatus('[1]').readable).toBe(false);
  });
});

describe('signing out at the public address ends that sign-in for every copy of its cookies', () => {
  it('cookies copied before "Sign out" stop working, step-up included; the private address and other sign-ins are untouched', async () => {
    h = await publicApp({ fullRoutes: true });
    const owner = await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    const jar = await h.signIn('owner', owner.password, { totpSecret: owner.totpSecret });
    const copied = jar.header();
    expect((await h.pub('/v1/security/log', { headers: { cookie: copied } })).status).toBe(200); // a step-up route
    // Another sign-in by the same person, on another device.
    const other = await signInAgain(h, 'owner', owner.password, owner.totpSecret!);

    expect((await h.pub('/v1/logout', { body: {}, jar })).status).toBe(200);
    for (const path of ['/v1/agents', '/v1/security/log']) {
      const r = await h.pub(path, { headers: { cookie: copied } });
      expect(r.status, path).toBe(401);
      expect(r.json.publicSignIn, path).toBe(true);
    }
    expect((await h.pub('/v1/agents', { jar: other })).status).toBe(200);
    // Kept in the database: a restart does not bring the copy back.
    expect(h.store.revokedPublicPasses(Date.now()).length).toBe(1);
    // The session itself is what plain "sign out" always left alone at the private address.
    const session = copied.split('; ').find((c) => c.startsWith('__Host-hatchabot_session='))!;
    expect((await h.app.inject({ url: '/v1/agents', headers: { cookie: session, 'x-forwarded-proto': 'https' } })).statusCode).toBe(200);
  }, 30_000);

  it('a sign-out with someone else\'s pass, a forged one or none revokes nothing', async () => {
    h = await publicApp({ fullRoutes: true });
    await h.addAccount('owner', { owner: true });
    const bob = await h.addAccount('bob', { totp: true });
    const eve = await h.addAccount('eve', { totp: true });
    await h.app.publicAccess!.evaluate();
    const jb = await h.signIn('bob', bob.password, { totpSecret: bob.totpSecret });
    const je = await h.signIn('eve', eve.password, { totpSecret: eve.totpSecret });
    // Eve's session with Bob's pass; a pass with a bad signature; no cookies at all.
    await h.pub('/v1/logout', { body: {}, headers: { cookie: `__Host-hatchabot_session=${je.cookies.get('__Host-hatchabot_session')}; __Host-hatchabot_pub=${jb.cookies.get('__Host-hatchabot_pub')}` } });
    await h.pub('/v1/logout', { body: {}, headers: { cookie: `__Host-hatchabot_session=${jb.cookies.get('__Host-hatchabot_session')}; __Host-hatchabot_pub=${jb.cookies.get('__Host-hatchabot_pub')}x` } });
    await h.pub('/v1/logout', { body: {} });
    expect(h.store.revokedPublicPasses(Date.now())).toEqual([]);
    expect((await h.pub('/v1/agents', { jar: jb })).status).toBe(200);
  }, 30_000);
});

// ---- open console sockets ------------------------------------------------------

/** A stand-in for an agent's gateway: upgrades, then echoes. */
async function fakeGateway(): Promise<number> {
  const server = createServer((_req, res) => res.end('ok'));
  server.on('upgrade', (_req, socket) => {
    extra.push(socket as Socket); // http's sockets stay half-open: closed by hand when the test ends
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('echo:'), d]))); socket.on('error', () => {});
    socket.on('end', () => socket.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  extra.push(server);
  return (server.address() as { port: number }).port;
}
interface Open { s: Socket; state: { got: string; closed: boolean } }
async function openConsole(port: number, agent: string, cookie: string): Promise<Open> {
  const s = connect(port, '127.0.0.1');
  extra.push(s);
  const state = { got: '', closed: false };
  s.on('data', (d) => { state.got += d.toString(); }); s.on('error', () => {}); s.on('close', () => { state.closed = true; });
  await new Promise((r) => s.once('connect', r));
  s.write(`GET /v1/agents/${agent}/ui/ HTTP/1.1\r\nHost: ${PUBLIC_HOST}\r\nX-Forwarded-For: 203.0.113.7\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: ${cookie}\r\n\r\n`);
  for (let i = 0; i < 40 && !state.got.includes('101') && !state.closed; i++) await sleep(50);
  return { s, state };
}
const alive = async (o: Open): Promise<boolean> => {
  if (o.state.closed) return false;
  const before = o.state.got.length;
  o.s.write('ping');
  for (let i = 0; i < 20 && o.state.got.length === before && !o.state.closed; i++) await sleep(25);
  return !o.state.closed && o.state.got.length > before;
};
const closedSoon = async (o: Open): Promise<boolean> => { for (let i = 0; i < 40 && !o.state.closed; i++) await sleep(25); return o.state.closed; };

async function consoleWorld(env: Record<string, string> = {}) {
  const gw = await fakeGateway();
  h = await publicApp({ fullRoutes: true, env });
  const owner = await h.addAccount('owner', { owner: true });
  const bob = await h.addAccount('bob', { totp: true });
  const dana = await h.addAccount('dana', { totp: true });
  await h.app.publicAccess!.evaluate();
  h.store.insertAIProfile({ id: 'p1', ownerId: owner.id, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' } as never);
  for (const [id, o] of [['a1', owner.id], ['b1', bob.id], ['d1', dana.id]] as const) {
    h.store.insertAgent({ id, ownerId: o, name: id, slug: id, state: 'RUNNING', aiProfileId: 'p1', hostId: 'host-local', runtimeRef: `mock://${id}`, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    h.store.rawDb().prepare('UPDATE agents SET gateway_port = ?, gateway_token = ? WHERE id = ?').run(gw, 'gw-token', id);
  }
  // The private listener, for sockets opened at the private address.
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  const privPort = (h.app.server.address() as { port: number }).port;
  const privLogin = async (username: string, password: string) =>
    String((await h!.app.inject({ method: 'POST', url: '/v1/login', payload: { username, password } })).headers['set-cookie']).split(';')[0]!;
  return { h, owner, bob, dana, privPort, privLogin };
}

describe('an open console socket ends when what let it in ends', () => {
  it('"Sign out on every device" closes the person\'s open consoles, public and private, and nobody else\'s', async () => {
    const { h, owner, bob, privPort, privLogin } = await consoleWorld();
    const jb = await h.signIn('bob', bob.password, { totpSecret: bob.totpSecret });
    const pubSock = await openConsole(h.port, 'b1', jb.header());
    const privSock = await openConsole(privPort, 'b1', await privLogin('bob', bob.password));
    const ownerSock = await openConsole(privPort, 'a1', await privLogin('owner', owner.password));
    expect(await alive(pubSock)).toBe(true);
    expect(await alive(privSock)).toBe(true);
    expect(await alive(ownerSock)).toBe(true);
    expect(h.app.consoleSockets!.size()).toBe(3);

    expect((await h.pub('/v1/logout/everywhere', { body: {}, jar: jb })).status).toBe(200);
    expect(await closedSoon(pubSock)).toBe(true);
    expect(await closedSoon(privSock)).toBe(true);
    expect(await alive(ownerSock)).toBe(true);
    expect(h.app.consoleSockets!.size()).toBe(1);
  }, 30_000);

  it('the owner signing someone out everywhere, a password change, and a plain sign-out at the public address', async () => {
    const { h, owner, bob, dana, privPort, privLogin } = await consoleWorld();
    const ownerCookie = await privLogin('owner', owner.password);
    // The owner signs Bob out.
    const jb = await h.signIn('bob', bob.password, { totpSecret: bob.totpSecret });
    const s1 = await openConsole(h.port, 'b1', jb.header());
    expect(await alive(s1)).toBe(true);
    expect((await h.app.inject({ method: 'POST', url: `/v1/security/sign-out/${bob.id}`, headers: { cookie: ownerCookie }, payload: {} })).statusCode).toBe(200);
    expect(await closedSoon(s1)).toBe(true);
    // Bob changes his password at the private address: his sessions end, his open console too.
    const jb2 = await signInAgain(h, 'bob', bob.password, bob.totpSecret!);
    const s2 = await openConsole(h.port, 'b1', jb2.header());
    expect(await alive(s2)).toBe(true);
    const bobCookie = await privLogin('bob', bob.password);
    expect((await h.app.inject({ method: 'POST', url: '/v1/local-accounts/me/password', headers: { cookie: bobCookie }, payload: { current: bob.password, password: 'a-new-password-for-bob' } })).statusCode).toBe(200);
    expect(await closedSoon(s2)).toBe(true);
    // Dana signs out (this browser only): the console that sign-in opened closes; her other sign-in's does not.
    const jd = await h.signIn('dana', dana.password, { totpSecret: dana.totpSecret });
    const jd2 = await signInAgain(h, 'dana', dana.password, dana.totpSecret!);
    const s3 = await openConsole(h.port, 'd1', jd.header());
    const s4 = await openConsole(h.port, 'd1', jd2.header());
    expect(await alive(s3)).toBe(true);
    expect(await alive(s4)).toBe(true);
    expect((await h.pub('/v1/logout', { body: {}, jar: jd })).status).toBe(200);
    expect(await closedSoon(s3)).toBe(true);
    expect(await alive(s4)).toBe(true);
    void privPort;
  }, 40_000);

  it('a second-factor reset, and removing a factor, close that person\'s public consoles', async () => {
    const { h, owner, dana, privLogin } = await consoleWorld();
    const ownerCookie = await privLogin('owner', owner.password);
    const jd = await h.signIn('dana', dana.password, { totpSecret: dana.totpSecret });
    const s1 = await openConsole(h.port, 'd1', jd.header());
    expect(await alive(s1)).toBe(true);
    // The owner resets Dana's second factor (a lost phone, or a suspicion): what she proved with it is void.
    expect((await h.app.inject({ method: 'POST', url: `/v1/second-factor/reset/${dana.id}`, headers: { cookie: ownerCookie }, payload: {} })).statusCode).toBe(200);
    expect(await closedSoon(s1)).toBe(true);

    // Dana removes a factor herself at the private address: her public consoles close too.
    const danaCookie = await privLogin('dana', dana.password);
    const start = await h.app.inject({ method: 'POST', url: '/v1/second-factor/totp', headers: { cookie: danaCookie }, payload: { current: dana.password } });
    const { id, secret } = start.json() as { id: string; secret: string };
    const { base32Decode } = await import('../src/api/totp.js');
    expect((await h.app.inject({ method: 'POST', url: '/v1/second-factor/totp/confirm', headers: { cookie: danaCookie }, payload: { id, code: totp(base32Decode(secret)) } })).statusCode).toBe(200);
    const jd2 = await h.signIn('dana', dana.password, { totpSecret: base32Decode(secret) });
    const s2 = await openConsole(h.port, 'd1', jd2.header());
    expect(await alive(s2)).toBe(true);
    expect((await h.app.inject({ method: 'DELETE', url: `/v1/second-factor/${id}`, headers: { cookie: danaCookie }, payload: { current: dana.password } })).statusCode).toBe(200);
    expect(await closedSoon(s2)).toBe(true);
    // Each change of someone's factors is on the security record, with where it was made.
    const kinds = h.store.listSecurityLog(50, dana.id).map((e) => `${e.kind}:${String(e.detail.method ?? '')}:${String(e.detail.at ?? '')}`);
    expect(kinds).toContain('second_factor.added:totp:the private address');
    expect(kinds).toContain('second_factor.removed:totp:the private address');
    expect(kinds.some((k) => k.startsWith('second_factor.reset'))).toBe(true);
  }, 40_000);

  it('for a Google account too (which may go on without a factor): a reset, or removing the factor, closes the console it was opened with', async () => {
    const gw = await fakeGateway();
    const verifier = { verify: async (t: string) => ({ sub: t, email: `${t}@example.com`, emailVerified: true, expMs: Date.now() + 3_600_000 }) };
    h = await publicApp({ fullRoutes: true, mode: 'identity', verifier });
    const { _sealForTest } = await import('../src/api/secondFactor.js');
    const secrets = { owner: Buffer.alloc(20, 3), gina: Buffer.alloc(20, 5) };
    h.store.insertHost({ id: 'host-local', ownerId: 'user-owner', kind: 'local', provider: 'mock', name: 'm', settings: {}, createdAt: 'now' });
    for (const who of ['owner', 'gina'] as const) {
      h.store.recordAccount(`user-${who}`, `${who}@example.com`);
      h.store.insertSecondFactor({ id: `f-${who}`, ownerId: `user-${who}`, kind: 'totp', data: _sealForTest(h.secret, secrets[who]) });
    }
    await h.app.publicAccess!.evaluate();
    expect(h.app.publicAccess!.status().failing).toEqual([]);
    h.store.insertAgent({ id: 'g1', ownerId: 'user-gina', name: 'g1', slug: 'g1', state: 'RUNNING', aiProfileId: 'p1', hostId: 'host-local', runtimeRef: 'mock://g1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    h.store.rawDb().prepare('UPDATE agents SET gateway_port = ?, gateway_token = ? WHERE id = ?').run(gw, 'gw-token', 'g1');
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const priv = async (who: string) => String((await h!.app.inject({ method: 'POST', url: '/v1/session', payload: { idToken: who } })).headers['set-cookie']).split(';')[0]!;
    const signIn = async (step: number): Promise<Jar> => {
      const jar = new Jar();
      expect((await h!.pub('/v1/session', { body: { idToken: 'gina' }, jar })).status).toBe(200);
      const v = await h!.pub('/v1/second-factor/verify', { jar, body: { code: totp(secrets.gina, Date.now() + step * 30_000) } });
      expect(v.status, JSON.stringify(v.json)).toBe(200);
      return jar;
    };
    // Gina removes her factor herself, at the private address: she may go on without one, but not on what she proved with it.
    const s1 = await openConsole(h.port, 'g1', (await signIn(0)).header());
    expect(await alive(s1)).toBe(true);
    expect((await h.app.inject({ method: 'DELETE', url: '/v1/second-factor/f-gina', headers: { cookie: await priv('gina') }, payload: {} })).statusCode).toBe(200);
    expect(await closedSoon(s1)).toBe(true);
    // She adds one again; the owner resets it.
    h.store.insertSecondFactor({ id: 'f-gina-2', ownerId: 'user-gina', kind: 'totp', data: _sealForTest(h.secret, secrets.gina) });
    const s2 = await openConsole(h.port, 'g1', (await signIn(1)).header());
    expect(await alive(s2)).toBe(true);
    const reset = await h.app.inject({ method: 'POST', url: '/v1/second-factor/reset/user-gina', headers: { cookie: await priv('owner') }, payload: {} });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(await closedSoon(s2)).toBe(true);
  }, 40_000);

  it('the public idle limit: a console nobody has typed in for that long is closed; one in use stays', async () => {
    const { h, bob } = await consoleWorld({ HATCHABOT_PUBLIC_IDLE_MINUTES: '5' });
    const jb = await h.signIn('bob', bob.password, { totpSecret: bob.totpSecret });
    const idle = await openConsole(h.port, 'b1', jb.header());
    const used = await openConsole(h.port, 'b1', jb.header());
    expect(await alive(idle)).toBe(true);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 6 * 60_000;
      expect(await alive(used)).toBe(true); // the browser sent something: not idle
      expect(h.app.consoleSockets!.revalidate()).toBe(1);
      expect(await closedSoon(idle)).toBe(true);
      expect(await alive(used)).toBe(true);
    } finally { Date.now = realNow; }
  }, 30_000);

  it('an account disabled or removed, and a guest whose web chat is switched off', async () => {
    const { h, owner, bob, privLogin } = await consoleWorld();
    const carol = await h.addAccount('carol', { totp: true });
    const ownerCookie = await privLogin('owner', owner.password);
    // Bob is disabled (as `hatchabot accounts disable` does, in another process): the timer's sweep finds it.
    const jb = await h.signIn('bob', bob.password, { totpSecret: bob.totpSecret });
    const s1 = await openConsole(h.port, 'b1', jb.header());
    expect(await alive(s1)).toBe(true);
    h.store.rawDb().prepare('UPDATE local_accounts SET disabled = 1 WHERE id = ?').run(bob.id);
    expect(h.app.consoleSockets!.revalidate()).toBe(1);
    expect(await closedSoon(s1)).toBe(true);

    // Carol's own agent, then her account is removed by the owner.
    h.store.insertAgent({ id: 'c1', ownerId: carol.id, name: 'c1', slug: 'c1', state: 'RUNNING', aiProfileId: 'p1', hostId: 'host-local', runtimeRef: 'mock://c1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    const gw = h.store.rawDb().prepare('SELECT gateway_port AS p FROM agents WHERE id = ?').get('a1') as { p: number };
    h.store.rawDb().prepare('UPDATE agents SET gateway_port = ?, gateway_token = ? WHERE id = ?').run(gw.p, 'gw-token', 'c1');
    const jc = await h.signIn('carol', carol.password, { totpSecret: carol.totpSecret });
    const s2 = await openConsole(h.port, 'c1', jc.header());
    expect(await alive(s2)).toBe(true);
    h.store.rawDb().prepare(`UPDATE agents SET state = 'DELETED' WHERE id = 'c1'`).run();
    const del = await h.app.inject({ method: 'DELETE', url: `/v1/local-accounts/${carol.id}`, headers: { cookie: ownerCookie } });
    expect(del.statusCode, del.body).toBe(200);
    expect(await closedSoon(s2)).toBe(true);
  }, 40_000);

  it('a socket that could not be re-judged is closed, not kept', async () => {
    const { h, bob } = await consoleWorld();
    const jb = await h.signIn('bob', bob.password, { totpSecret: bob.totpSecret });
    const s1 = await openConsole(h.port, 'b1', jb.header());
    expect(await alive(s1)).toBe(true);
    const real = h.app.principalFromCookieHeader!;
    (h.app as unknown as { principalFromCookieHeader: unknown }).principalFromCookieHeader = () => { throw new Error('database is gone'); };
    try { expect(h.app.consoleSockets!.revalidate()).toBe(1); } finally { (h.app as unknown as { principalFromCookieHeader: unknown }).principalFromCookieHeader = real; }
    expect(await closedSoon(s1)).toBe(true);
  }, 30_000);
});

/**
 * Issue #9: a reset closed the person's open consoles, but their public pass
 * kept its "second factor given" mark, which counted again the moment a new
 * factor was added. The pass now carries the generation of the person's
 * factors it was given under; a reset or a removed factor bumps it.
 */
describe('a second factor given before a reset or a removal', () => {
  /** Enrol a new authenticator app at the private address, as the person does after a reset. */
  const enrolAt = async (app: PublicApp, cookie: string, password: string): Promise<Buffer> => {
    const start = (await app.app.inject({ method: 'POST', url: '/v1/second-factor/totp', headers: { cookie }, payload: { current: password } })).json() as { id: string; secret: string };
    const secret = base32Decode(start.secret);
    const done = await app.app.inject({ method: 'POST', url: '/v1/second-factor/totp/confirm', headers: { cookie }, payload: { id: start.id, code: totp(secret) } });
    expect(done.statusCode, done.body).toBe(200);
    return secret;
  };
  const privCookie = async (app: PublicApp, username: string, password: string) =>
    String((await app.app.inject({ method: 'POST', url: '/v1/login', payload: { username, password } })).headers['set-cookie']).split(';')[0]!;

  it('before a reset: an old cookie is not verified again by re-enrolment; a fresh proof with the new factor is', async () => {
    h = await publicApp();
    const owner = await h.addAccount('owner', { owner: true });
    const dana = await h.addAccount('dana', { totp: true });
    await h.app.publicAccess!.evaluate();
    const old = await h.signIn('dana', dana.password, { totpSecret: dana.totpSecret });
    expect((await h.pub('/v1/agents', { jar: old })).status).toBe(200);
    const reset = await h.app.inject({ method: 'POST', url: `/v1/second-factor/reset/${dana.id}`, headers: { cookie: await privCookie(h, 'owner', owner.password) }, payload: {} });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(h.store.secondFactorGeneration(dana.id)).toBe(1);
    expect((await h.pub('/v1/agents', { jar: old })).json.secondFactor).toBe('enrol-link');
    // She adds a new authenticator app at the private address.
    const fresh = await enrolAt(h, await privCookie(h, 'dana', dana.password), dana.password);
    expect(h.app.publicAccess!.secondFactorNeed(dana.id)).toBe('yes');
    // The cookie verified with the factor that was reset is not verified now.
    const r = await h.pub('/v1/agents', { jar: old });
    expect(r.status).toBe(401);
    expect(r.json.secondFactor).toBe('required');
    expect((await h.pub('/v1/second-factor', { jar: old })).json.hidden).toBe(true);
    // The old app's code is no factor of hers; the new one's is.
    expect((await h.pub('/v1/second-factor/verify', { jar: old, body: { code: totp(dana.totpSecret!, Date.now() + 30_000) } })).status).toBe(401);
    expect((await h.pub('/v1/second-factor/verify', { jar: old, body: { code: totp(fresh, Date.now() + 30_000) } })).status).toBe(200);
    expect((await h.pub('/v1/agents', { jar: old })).status).toBe(200);
  }, 30_000);

  it('removing a factor at the public address voids the other sign-ins\' proof; the one that removed it keeps its own', async () => {
    h = await publicApp();
    await h.addAccount('owner', { owner: true });
    const dana = await h.addAccount('dana', { totp: true });
    const { _sealForTest } = await import('../src/api/secondFactor.js');
    h.store.insertSecondFactor({ id: 'sf-spare', ownerId: dana.id, kind: 'totp', label: 'Spare', data: _sealForTest(h.secret, Buffer.alloc(20, 6)) });
    await h.app.publicAccess!.evaluate();
    const here = await h.signIn('dana', dana.password, { totpSecret: dana.totpSecret });
    const elsewhere = await signInAgain(h, 'dana', dana.password, dana.totpSecret!);
    expect((await h.pub('/v1/agents', { jar: elsewhere })).status).toBe(200);
    expect((await h.pub('/v1/second-factor/sf-spare', { jar: here, method: 'DELETE' })).status).toBe(200);
    expect((await h.pub('/v1/agents', { jar: here })).status).toBe(200);
    const r = await h.pub('/v1/agents', { jar: elsewhere });
    expect(r.status).toBe(401);
    expect(r.json.secondFactor).toBe('required');
  }, 30_000);

  it('consoles: the old cookie cannot open one after reset and re-enrolment, and an open one is closed when the generation moves', async () => {
    const { h, owner, dana, privLogin } = await consoleWorld();
    const old = await h.signIn('dana', dana.password, { totpSecret: dana.totpSecret });
    const s1 = await openConsole(h.port, 'd1', old.header());
    expect(await alive(s1)).toBe(true);
    expect((await h.app.inject({ method: 'POST', url: `/v1/second-factor/reset/${dana.id}`, headers: { cookie: await privLogin('owner', owner.password) }, payload: {} })).statusCode).toBe(200);
    expect(await closedSoon(s1)).toBe(true);
    const fresh = await enrolAt(h, await privLogin('dana', dana.password), dana.password);
    // Re-enrolled: the old cookie still opens nothing.
    const s2 = await openConsole(h.port, 'd1', old.header());
    expect(s2.state.got).not.toContain('101');
    expect(await closedSoon(s2)).toBe(true);
    // A fresh proof with the new factor, on the same sign-in: it opens.
    expect((await h.pub('/v1/second-factor/verify', { jar: old, body: { code: totp(fresh, Date.now() + 30_000) } })).status).toBe(200);
    const s3 = await openConsole(h.port, 'd1', old.header());
    expect(await alive(s3)).toBe(true);
    // The generation moving by any road (here, as another process would) closes it at the next judgement.
    h.store.bumpSecondFactorGeneration(dana.id);
    expect(h.app.consoleSockets!.revalidate()).toBe(1);
    expect(await closedSoon(s3)).toBe(true);
  }, 40_000);
});

describe('what a stranger can hold open', () => {
  it('a sign-in form sent a byte at a time is cut off in seconds, not minutes; a prompt one is untouched', async () => {
    h = await publicApp();
    await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    const started = Date.now();
    const s = connect(h.port, '127.0.0.1', () => s.write(`POST /v1/login HTTP/1.1\r\nHost: ${PUBLIC_HOST}\r\nContent-Type: application/json\r\nContent-Length: 2000\r\n\r\n{"username":"`));
    extra.push(s);
    let closed = false; s.on('close', () => { closed = true; }); s.on('error', () => {});
    for (let i = 0; i < 200 && !closed; i++) await sleep(100);
    expect(closed).toBe(true);
    expect(Date.now() - started).toBeLessThan(19_000);
    expect((await h.pub('/v1/login', { body: { username: 'nobody', password: 'wrong-wrong' } })).status).toBe(401);
  }, 30_000);

  it('the public listener holds a bounded number of connections; the rest are refused at the door', async () => {
    h = await publicApp();
    await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    // 2026-10-09 (#24): a socket is watched from the moment it is made. Close listeners added after
    // Promise.all missed the ones the server had already shut, and counted them as held (572 > 512 under load).
    const closed = new Set<Socket>();
    const open = (): Promise<Socket> => new Promise<Socket>((res) => {
      const s = connect(h!.port, '127.0.0.1', () => res(s));
      s.on('close', () => { closed.add(s); res(s); });
      s.on('error', () => res(s));
      extra.push(s);
    });
    const socks = await Promise.all(Array.from({ length: 600 }, open));
    const held = () => socks.filter((s) => !closed.has(s) && !s.destroyed).length;
    // Settle: the same count three looks in a row (bounded), since refusals arrive a moment after the connect.
    let last = -1;
    for (let i = 0, same = 0; i < 100 && same < 3; i++) { await sleep(100); const n = held(); same = n === last ? same + 1 : 0; last = n; }
    expect(held()).toBeLessThanOrEqual(512);
    expect(held()).toBeGreaterThan(400);
    expect(socks.length - held()).toBeGreaterThanOrEqual(600 - 512); // the excess were refused
    // The cap still holds now: one more is shut at the door while the others are held.
    if (held() === 512) {
      const more = await open();
      for (let i = 0; i < 50 && !closed.has(more); i++) await sleep(100);
      expect(closed.has(more)).toBe(true);
    }
  }, 30_000);
});

describe('smaller things', () => {
  it('a passkey answer whose client data is JSON but not an object is a refusal that counts, not a crash', async () => {
    const key = new SoftAuthenticator('ES256');
    const good = key.get({ challenge: 'abc', origin: PUBLIC_URL, rpId: PUBLIC_HOST });
    for (const cd of ['null', '[]', '1', '"x"', '{"type":"webauthn.get","challenge":["abc"],"origin":"' + PUBLIC_URL + '"}']) {
      expect(() => verifyAssertion({ ...good, clientDataJSON: Buffer.from(cd).toString('base64url') },
        { publicKey: { alg: -7, jwk: { kty: 'EC' } }, signCount: 0 }, { challenge: 'abc', origins: [PUBLIC_URL], rpId: PUBLIC_HOST }), cd).toThrow(WebAuthnError);
    }
    // A challenge or origin wrapped in an array reads as the same text; with a genuine key and signature only the type check refuses it.
    const reg = verifyRegistration(key.create({ challenge: 'c0', origin: PUBLIC_URL, rpId: PUBLIC_HOST }), { challenge: 'c0', origins: [PUBLIC_URL], rpId: PUBLIC_HOST });
    const exp = { challenge: 'abc', origins: [PUBLIC_URL], rpId: PUBLIC_HOST };
    expect(verifyAssertion(key.get({ challenge: 'abc', origin: PUBLIC_URL, rpId: PUBLIC_HOST }), { publicKey: reg.publicKey, signCount: reg.signCount }, exp).signCount).toBeGreaterThan(reg.signCount);
    for (const odd of [{ challenge: ['abc'] }, { origin: [PUBLIC_URL] }]) {
      expect(() => verifyAssertion(key.get({ challenge: 'abc', origin: PUBLIC_URL, rpId: PUBLIC_HOST, clientExtra: odd }), { publicKey: reg.publicKey, signCount: 0 }, exp), JSON.stringify(odd)).toThrow(/malformed/);
    }
    // Through the route: counted as a failed attempt (401), not answered 500.
    h = await publicApp({ fullRoutes: true });
    const owner = await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    const login = await h.app.inject({ method: 'POST', url: '/v1/login', payload: { username: 'owner', password: owner.password } });
    const hdr = { cookie: String(login.headers['set-cookie']).split(';')[0]!, origin: PUBLIC_URL, host: `${PUBLIC_HOST}:8443` };
    const o = await h.app.inject({ method: 'POST', url: '/v1/second-factor/passkey/options', headers: hdr, payload: { current: owner.password } });
    expect((await h.app.inject({ method: 'POST', url: '/v1/second-factor/passkey', headers: hdr, payload: key.create({ challenge: (o.json() as { challenge: string }).challenge, origin: PUBLIC_URL, rpId: PUBLIC_HOST }) })).statusCode).toBe(200);
    const jar = new Jar();
    await h.pub('/v1/login', { body: { username: 'owner', password: owner.password }, jar });
    const ch = await h.pub('/v1/second-factor/challenge', { body: {}, jar });
    const answer = key.get({ challenge: ch.json.challenge, origin: PUBLIC_URL, rpId: PUBLIC_HOST });
    const r = await h.pub('/v1/second-factor/verify', { body: { passkey: { ...answer, clientDataJSON: Buffer.from('null').toString('base64url') } }, jar });
    expect(r.status).toBe(401);
  }, 30_000);

  it('a console socket counts against the request ceiling like any request', async () => {
    const { h, bob } = await consoleWorld({ HATCHABOT_PUBLIC_REQS_PER_MIN_PER_ADDRESS: '8' });
    const jb = await h.signIn('bob', bob.password, { from: '192.0.2.200', totpSecret: bob.totpSecret });
    const opened: Open[] = [];
    // The ceiling counts per calendar minute: twelve opens that straddle a
    // minute's end are counted in two buckets and all get through. Start early
    // in a fresh minute (a flake seen 2026-10-03 under load).
    const left = 60_000 - (Date.now() % 60_000);
    if (left < 20_000) await new Promise((r) => setTimeout(r, left + 50));
    for (let i = 0; i < 12; i++) opened.push(await openConsole(h.port, 'b1', jb.header()));
    // (openConsole sends X-Forwarded-For 203.0.113.7: its own address's count.)
    expect(opened.filter((o) => o.state.got.includes('101')).length).toBe(8);
  }, 45_000);

  it('an agent that no longer belongs to the caller closes its console (the same standing check that opened it)', async () => {
    const { h, owner, bob } = await consoleWorld();
    const jb = await h.signIn('bob', bob.password, { totpSecret: bob.totpSecret });
    const s1 = await openConsole(h.port, 'b1', jb.header());
    expect(await alive(s1)).toBe(true);
    h.store.rawDb().prepare('UPDATE agents SET owner_id = ? WHERE id = ?').run(owner.id, 'b1');
    expect(h.app.consoleSockets!.revalidate()).toBe(1);
    expect(await closedSoon(s1)).toBe(true);
  }, 30_000);

  it('giving an agent a folder of this machine needs the second factor again at the public address; the rest of its settings do not', async () => {
    h = await publicApp({ fullRoutes: true });
    const owner = await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    h.store.insertAgent({ id: 'a1', ownerId: owner.id, name: 'Kitchen', slug: 'kitchen', state: 'STOPPED', aiProfileId: 'p1', hostId: 'host-local', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    const jar = await h.signIn('owner', owner.password, { totpSecret: owner.totpSecret });
    const folder = mkdtempSync(join(tmpdir(), 'hb-folder-'));
    const realNow = Date.now;
    try {
      // Eleven minutes on: signed in, but the second factor was not given in the last ten.
      Date.now = () => realNow() + 11 * 60_000;
      expect((await h.pub('/v1/agents/a1', { method: 'PATCH', body: { group: 'Home' }, jar })).status).toBe(200);
      const r = await h.pub('/v1/agents/a1', { method: 'PATCH', body: { sharedPaths: [folder] }, jar });
      expect(r.status).toBe(401);
      expect(r.json.secondFactor).toBe('step-up');
      expect(h.store.getAgent('a1')!.sharedPaths ?? []).toEqual([]);
      // Taking folders away asks for nothing more.
      expect((await h.pub('/v1/agents/a1', { method: 'PATCH', body: { sharedPaths: [] }, jar })).status).toBe(200);
    } finally { Date.now = realNow; }
    // Within the window it goes through, and the private address never asks.
    const fresh = await signInAgain(h, 'owner', owner.password, owner.totpSecret!);
    const realNow2 = Date.now;
    try {
      Date.now = () => realNow2() + 46_000;
      const ok = await h.pub('/v1/agents/a1', { method: 'PATCH', body: { sharedPaths: [folder] }, jar: fresh });
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    } finally { Date.now = realNow2; }
    expect(h.store.getAgent('a1')!.sharedPaths).toEqual([folder]);
    rmSync(folder, { recursive: true, force: true });
  }, 30_000);

  it('the request ceiling counts an IPv6 visitor by their /64, not by an address they can change at will', async () => {
    h = await publicApp({ env: { HATCHABOT_PUBLIC_REQS_PER_MIN_PER_ADDRESS: '8' } });
    await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await h.pub('/v1/config', { from: `2001:db8:1:2::${(i + 1).toString(16)}` })).status);
    expect(codes.filter((c) => c === 200).length).toBe(8);
    expect(codes.filter((c) => c === 429).length).toBe(4);
    // Another /64 has its own count.
    expect((await h.pub('/v1/config', { from: '2001:db8:1:3::1' })).status).toBe(200);
  });

  it('a judgement that began while public access was on does not say "serving" after it is turned off', async () => {
    let answer!: (v: { ok: boolean }) => void;
    h = await publicApp();
    await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    expect(h.app.publicAccess!.status().serving).toBe(true);
    h.app.publicAccess!.setProbes({ autoUpgrade: () => new Promise((res) => { answer = res; }) });
    const judging = h.app.publicAccess!.evaluate();
    await sleep(20);
    delete process.env.HATCHABOT_PUBLIC_ACCESS; // "off", while the probes are still out
    answer({ ok: true });
    await judging;
    expect(h.app.publicAccess!.status().serving).toBe(false);
  });
});
