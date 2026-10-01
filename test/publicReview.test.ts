import { afterEach, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { Jar, PUBLIC_HOST, publicApp, type PublicApp } from './helpers/publicApp.js';
import { _loginThrottleKeys } from '../src/api/auth.js';
import { addressBucket } from '../src/api/trust.js';
import { createInvite } from '../src/orchestrator/invite.js';
import { evaluateSafeguards, failingSafeguards } from '../src/api/safeguards.js';
import { parseFunnelStatus, targetsPort } from '../src/ops/tailnet.js';
import { SESSION_COOKIE_NAME } from '../src/api/sessionCookie.js';

/**
 * What an adversarial review of the public listener found (2026-10-01), one
 * test each, so none of it comes back.
 */
let h: PublicApp | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const raw = (port: number, text: string | Buffer, waitMs = 700): Promise<string> => new Promise((resolve) => {
  const s = connect(port, '127.0.0.1', () => s.write(text));
  let out = ''; s.on('data', (d) => { out += d.toString(); }); s.on('error', () => {});
  s.on('close', () => resolve(out));
  setTimeout(() => { s.destroy(); resolve(out); }, waitMs);
});

describe('before sign-in, the public address reads almost nothing', () => {
  it('a large body is refused by its declared length, whatever its content type; a body with no length is refused', async () => {
    h = await publicApp({ fullRoutes: true });
    await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    const post = (headers: Record<string, string>, body: Buffer | string) => fetch(`http://127.0.0.1:${h!.port}/v1/login`, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9', ...headers }, body });
    // The app accepts hundreds of megabytes of application/octet-stream on any route (imports, uploads).
    expect((await post({ 'content-type': 'application/octet-stream' }, Buffer.alloc(300 * 1024, 0x41))).status).toBe(413);
    expect((await post({ 'content-type': 'application/json' }, JSON.stringify({ username: 'x', password: 'y'.repeat(300 * 1024) }))).status).toBe(413);
    // Never read at all: the answer comes although the body is never sent.
    const lied = await raw(h.port, `POST /v1/login HTTP/1.1\r\nHost: ${PUBLIC_HOST}\r\nContent-Type: application/octet-stream\r\nContent-Length: 250000000\r\n\r\n`);
    expect(lied).toMatch(/^HTTP\/1\.1 413/);
    const chunked = await raw(h.port, `POST /v1/login HTTP/1.1\r\nHost: ${PUBLIC_HOST}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n`);
    expect(chunked).toMatch(/^HTTP\/1\.1 411/);
    // A normal sign-in is untouched, and the private address keeps its own limits.
    expect((await h.pub('/v1/login', { body: { username: 'nobody', password: 'wrong' } })).status).toBe(401);
    const priv = await h.app.inject({ method: 'POST', url: '/v1/login', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(300 * 1024, 0x41) });
    expect(priv.statusCode).not.toBe(413);
  }, 30_000);

  it('an address the router cannot decode gets a bare 400 and never reaches the app', async () => {
    h = await publicApp();
    await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    const bad = await raw(h.port, `GET /%zz HTTP/1.1\r\nHost: ${PUBLIC_HOST}\r\n\r\n`);
    expect(bad).toMatch(/^HTTP\/1\.1 400/);
    expect(bad).not.toContain('FST_ERR');
  });

  it('/v1/config tells a stranger what the sign-in screen needs and no more', async () => {
    h = await publicApp({ fullRoutes: true, env: { HATCHABOT_PUBLIC_URL: 'https://box.example.com', HATCHABOT_NOTICE: 'Maintenance on Sunday' } });
    await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    const pub = (await h.pub('/v1/config')).json;
    expect(pub).toMatchObject({ authMode: 'accounts', publicAddress: true, needsSetup: false });
    for (const k of ['appUrl', 'notice', 'maxAgentsPerAccount', 'rebuildConcurrency', 'setupCodeRequired']) expect(pub, k).not.toHaveProperty(k);
    const priv = (await h.app.inject({ url: '/v1/config' })).json();
    expect(priv).toHaveProperty('rebuildConcurrency');
    expect(priv.notice).toBe('Maintenance on Sunday');
  });
});

describe('sign-in limits cannot be used to fill memory', () => {
  it('a megabyte-long username is counted under a short key', async () => {
    h = await publicApp();
    await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    // (Under the pre-sign-in body limit, so the request itself is read.)
    const long = 'u'.repeat(200_000);
    expect((await h.pub('/v1/login', { body: { username: long, password: 'nope' } })).status).toBe(401);
    expect((await h.app.inject({ method: 'POST', url: '/v1/login', payload: { username: long, password: 'nope' } })).statusCode).toBe(401);
    const keys = _loginThrottleKeys();
    expect(keys.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThan(120);
    // An ordinary name is still its own readable bucket.
    await h.pub('/v1/login', { body: { username: 'Chris', password: 'nope' } });
    expect(_loginThrottleKeys()).toContain('pub:user:chris');
  }, 20_000);

  it('IPv6 visitors are counted by their /64, not by an address they can change at will', async () => {
    expect(addressBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(addressBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(addressBucket('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(addressBucket('2001:0db8:0001:0002:0:0:0:9')).toBe('2001:db8:1:2::/64');
    expect(addressBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressBucket('::1')).toBe('0:0:0:0::/64');
    h = await publicApp({ env: { HATCHABOT_LOGIN_FAILS_PER_WINDOW: '3' } });
    await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    for (let i = 0; i < 3; i++) expect((await h.pub('/v1/login', { body: { username: `n${i}`, password: 'x' }, from: `2001:db8:1:2::${i + 1}` })).status).toBe(401);
    expect((await h.pub('/v1/login', { body: { username: 'n9', password: 'x' }, from: '2001:db8:1:2:ffff::9' })).status).toBe(429);
    expect((await h.pub('/v1/login', { body: { username: 'n9', password: 'x' }, from: '2001:db8:1:3::1' })).status).toBe(401);
  }, 20_000);
});

describe('what a signed-in public session cannot read without the second factor again', () => {
  it('an agent\'s Files tab (its home holds its tokens), and pending invitation codes', async () => {
    h = await publicApp({ fullRoutes: true, env: { HATCHABOT_PUBLIC_STEPUP_MINUTES: '1' } });
    const owner = await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    const jar = await h.signIn('owner', owner.password, { totpSecret: owner.totpSecret });
    const login = await h.app.inject({ method: 'POST', url: '/v1/login', payload: { username: 'owner', password: owner.password } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const made = (await h.app.inject({ method: 'POST', url: '/v1/local-accounts', headers: { cookie }, payload: { username: 'invited' } })).json();
    expect(made.claimPath).toMatch(/^\/\?claim=/);
    // The roster at the private address shows the invitation link; at the public one it does not.
    const privRoster = (await h.app.inject({ url: '/v1/local-accounts', headers: { cookie } })).json();
    expect(privRoster.find((a: any) => a.username === 'invited').claimPath).toBe(made.claimPath);
    const pubRoster = (await h.pub('/v1/local-accounts', { jar })).json;
    const row = pubRoster.find((a: any) => a.username === 'invited');
    expect(row.pending).toBe(true);
    expect(row.claimPath).toBeUndefined();
    expect(JSON.stringify(pubRoster)).not.toContain(made.claimCode);
    // Files: step-up, for reading as for writing.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 2 * 60_000;
      for (const [method, path] of [['GET', '/v1/agents/a1/fs'], ['GET', '/v1/agents/a1/fs/file?path=.openclaw/openclaw.json'], ['PUT', '/v1/agents/a1/fs/file?path=x']] as const) {
        const r = await h.pub(path, { jar, method, ...(method === 'PUT' ? { body: {} } : {}) });
        expect(r.status, path).toBe(401);
        expect(r.json.secondFactor, path).toBe('step-up');
      }
      expect((await h.pub('/v1/agents', { jar })).status).toBe(200);
    } finally { Date.now = realNow; }
  });

  it('an invitation to an agent cannot be accepted by a session the gate has not passed', async () => {
    h = await publicApp({ fullRoutes: true });
    const owner = await h.addAccount('owner', { owner: true });
    const bob = await h.addAccount('bob', { totp: true });
    const carol = await h.addAccount('carol');
    await h.app.publicAccess!.evaluate();
    h.store.insertAgent({ id: 'a1', ownerId: owner.id, name: 'Kitchen', slug: 'kitchen', state: 'STOPPED', aiProfileId: 'p1', hostId: 'host-local', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    const invite = () => createInvite(h!.store, 'a1', owner.id, undefined, { webChat: true }).code;
    // Bob has the password right and has NOT given his second factor.
    const half = new Jar();
    await h.pub('/v1/login', { body: { username: 'bob', password: bob.password }, jar: half });
    const j1 = await h.pub('/v1/join', { body: { code: invite(), name: 'B' }, jar: half });
    expect(j1.status).toBe(401);
    // Carol's session is from the private address: no public pass.
    const priv = await h.app.inject({ method: 'POST', url: '/v1/login', payload: { username: 'carol', password: carol.password }, headers: { 'x-forwarded-proto': 'https' } });
    const j2 = await h.pub('/v1/join', { body: { code: invite(), name: 'C' }, headers: { cookie: String(priv.headers['set-cookie']).split(';')[0]! } });
    expect(j2.status).toBe(401);
    expect(h.store.rawDb().prepare(`SELECT COUNT(*) AS n FROM memberships WHERE agent_id = 'a1'`).get()).toEqual({ n: 0 });
    // Signed in properly at the public address: accepted.
    const full = await h.signIn('carol', carol.password);
    const j3 = await h.pub('/v1/join', { body: { code: invite(), name: 'C' }, jar: full });
    expect(j3.status, JSON.stringify(j3.json)).toBe(201);
  });
});

describe('open sockets do not outlive public access', () => {
  const echo = (app: import('fastify').FastifyInstance) => {
    app.server.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.on('data', (d: Buffer) => socket.write(d)); socket.on('error', () => {});
    });
  };
  const open = async (port: number) => {
    const s = connect(port, '127.0.0.1');
    const state = { got: '', closed: false };
    s.on('data', (d) => { state.got += d.toString(); }); s.on('error', () => {}); s.on('close', () => { state.closed = true; });
    await new Promise((r) => s.once('connect', r));
    s.write('GET /v1/agents/a1/ui/ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    await sleep(300);
    return { s, state };
  };

  it('a console socket is dropped the moment a safeguard goes off', async () => {
    h = await publicApp({ extra: echo });
    await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    const { s, state } = await open(h.port);
    expect(state.got).toContain('101');
    s.write('ping'); await sleep(150);
    expect(state.got).toContain('ping');
    h.app.publicAccess!.setProbes({ autoUpgrade: async () => ({ ok: false, why: 'the timer was removed' }) });
    await h.app.publicAccess!.evaluate();
    await sleep(150);
    expect(state.closed).toBe(true);
  });

  it('turning public access off finishes at once with a socket open, and closes it', async () => {
    h = await publicApp({ extra: echo });
    await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    const { state } = await open(h.port);
    expect(state.got).toContain('101');
    const done = await Promise.race([h.app.publicAccess!.stopListener().then(() => 'stopped'), sleep(3000).then(() => 'hung')]);
    expect(done).toBe('stopped');
    await sleep(100);
    expect(state.closed).toBe(true);
    await expect(fetch(`http://127.0.0.1:${h.port}/healthz`)).rejects.toThrow();
  });

  it('a sign-in used only for a socket is recorded and announced like any other', async () => {
    const sent: string[] = [];
    h = await publicApp({ probes: { telegram: async (to) => { sent.push(to); return true; } }, extra: (app) => {
      app.server.on('upgrade', (req, socket) => {
        const p = app.principalFromCookieHeader!(req.headers.cookie, true);
        if (!p || app.publicAccess!.refuseSession(req, p.ownerId)) { socket.destroy(); return; }
        socket.end('HTTP/1.1 101 Switching Protocols\r\n\r\n');
      });
    } });
    const owner = await h.addAccount('owner', { owner: true });
    const m = await h.addAccount('member');
    await h.app.publicAccess!.evaluate();
    const jar = new Jar();
    await h.pub('/v1/login', { body: { username: 'member', password: m.password }, jar });
    const answer = await raw(h.port, `GET /v1/agents/a1/ui/ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: ${jar.header()}\r\n\r\n`);
    expect(answer).toContain('101');
    expect(h.store.listSecurityLog().find((e) => e.kind === 'public.signin')).toMatchObject({ ownerId: m.id });
    expect(sent.sort()).toEqual([m.id, owner.id].sort());
  });
});

describe('smaller things', () => {
  it('the public pass and the device cookie are among the cookies never forwarded to an agent\'s gateway', () => {
    for (const name of ['__Host-hatchabot_session', 'hatchabot_session', '__Host-hatchabot_pub', '__Host-hatchabot_device']) expect(SESSION_COOKIE_NAME.test(name), name).toBe(true);
    for (const name of ['openclaw_session', 'hatchabot_sessionx', 'theme']) expect(SESSION_COOKIE_NAME.test(name), name).toBe(false);
  });

  it('Funnel pointed at the private port is seen whatever name the target uses; unreadable fails while public access is on', () => {
    const st = (proxy: string) => parseFunnelStatus(JSON.stringify({ AllowFunnel: { 'box.example.com:443': true }, Web: { 'box.example.com:443': { Handlers: { '/': { Proxy: proxy } } } } })).entries[0]!;
    for (const target of ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://192.168.1.20:8080', 'http://100.64.0.1:8080/', 'https+insecure://box:8080', 'http://[::1]:8080']) expect(targetsPort(st(target), 8080), target).toBe(true);
    for (const target of ['http://127.0.0.1:18080', 'http://127.0.0.1:808', 'http://127.0.0.1:8092']) expect(targetsPort(st(target), 8080), target).toBe(false);
    const facts = { authMode: 'accounts', managed: false, admins: [{ id: 'a', name: 'o', totp: 1, passkeyRpIds: [] }], invitedOnly: true, ownerHeader: false,
      ports: { main: 8080, public: 8092, ops: 8091, embed: 8093 }, autoUpgrade: { ok: true }, loginFailLimit: 10 };
    expect(failingSafeguards(evaluateSafeguards({ ...facts, funnelOnPrivatePort: undefined, publicOn: true })).map((c) => c.id)).toEqual(['separate-listener']);
    expect(failingSafeguards(evaluateSafeguards({ ...facts, funnelOnPrivatePort: undefined, publicOn: false }))).toEqual([]); // before it is on, "not known" is not a refusal
    expect(failingSafeguards(evaluateSafeguards({ ...facts, funnelOnPrivatePort: false, publicOn: true }))).toEqual([]);
  });

  it('passkey origins are only addresses this Hatchabot is configured at', async () => {
    h = await publicApp({ off: true, env: { HATCHABOT_PUBLIC_URL: `https://${PUBLIC_HOST}`, HATCHABOT_PUBLIC_ACCESS_URL: `https://${PUBLIC_HOST}:8443` } });
    expect(h.app.publicAccess!.origins().sort()).toEqual([`https://${PUBLIC_HOST}`, `https://${PUBLIC_HOST}:8443`]);
  });

  it('a member whose only passkey is for another address is asked for the password to add a factor here', async () => {
    h = await publicApp();
    await h.addAccount('owner', { owner: true });
    const m = await h.addAccount('member');
    h.store.insertSecondFactor({ id: 'pk-elsewhere', ownerId: m.id, kind: 'passkey', credentialId: 'cred-x', rpId: 'localhost', data: '{}' });
    await h.app.publicAccess!.evaluate();
    const jar = await h.signIn('member', m.password); // not asked for a factor: the passkey does not work here
    expect((await h.pub('/v1/agents', { jar })).status).toBe(200);
    expect((await h.pub('/v1/second-factor/totp', { jar, body: {} })).status).toBe(401); // a session alone is not enough
    expect((await h.pub('/v1/second-factor/totp', { jar, body: { current: m.password } })).status).toBe(200);
  });
});
