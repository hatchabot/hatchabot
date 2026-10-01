import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { Jar, PUBLIC_HOST, publicApp, type PublicApp } from './helpers/publicApp.js';
import { internalHeaders } from '../src/api/principal.js';
import { setupCode } from '../src/api/accountsAuth.js';
import { approximateSource, isPublic, publicClientAddress, publicReplayHeaders } from '../src/api/trust.js';

/**
 * Trust classes (docs/public-access.md, safeguard d): what arrives on the
 * public listener is a stranger whatever its headers say, and nothing a
 * client sends to the private listener makes it "public" or anything else it
 * was not before.
 */
let h: PublicApp | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const ready = async (o: Parameters<typeof publicApp>[0] = {}) => {
  h = await publicApp(o);
  const owner = await h.addAccount('owner', { owner: true });
  await h.app.publicAccess!.evaluate();
  return { h, owner };
};

describe('public traffic is never "on this machine"', () => {
  it('the listener, not a header, decides: with every proxy header stripped it is still public', async () => {
    const seen: boolean[] = [];
    const { h } = await ready({ extra: (app) => { app.addHook('onResponse', async (req) => { if (req.method === 'GET') seen.push(isPublic(req)); }); } });
    // Exactly what a local process sees from 127.0.0.1 with no forwarding headers at all.
    const bare = { 'x-forwarded-for': '', 'x-forwarded-host': '', 'x-forwarded-proto': '', 'tailscale-funnel-request': '' };
    expect((await h.pub('/v1/config', { headers: bare })).status).toBe(200);
    expect((await h.pub('/v1/unclassified-thing', { headers: bare })).status).toBe(403);
    // …and dressed as the tailnet (Tailscale Serve's identity headers), still public.
    expect((await h.pub('/v1/unclassified-thing', { headers: { 'tailscale-user-login': 'owner@example.com', 'tailscale-user-name': 'Owner' } })).status).toBe(403);
    await h.app.inject({ url: '/v1/config', headers: { 'tailscale-funnel-request': '?1', 'x-forwarded-for': '203.0.113.9' } });
    expect(seen).toEqual([true, true, true, false]); // a Funnel header on the PRIVATE listener changes nothing either
  });

  it('first run: a machine cannot be claimed from the public address, with no headers and even with the right setup code', async () => {
    // Force the listener to serve although nobody owns the machine: the route itself must still refuse.
    h = await publicApp({ extra: (app) => { app.post('/v1/local-accounts/bootstrap-probe', async () => ({})); } });
    const bare = { 'x-forwarded-for': '', 'x-forwarded-host': '', 'x-forwarded-proto': '', 'tailscale-funnel-request': '' };
    const r = await h.pub('/v1/local-accounts/bootstrap', { body: { username: 'thief', password: 'long-enough-pw', setupCode: setupCode() }, headers: bare });
    expect(r.status).toBe(503); // nothing is served: no owner, no second factor
    expect(h.store.countLocalAccounts()).toBe(0);
    // From this machine, with the same body: the private listener creates it (the contrast).
    const ok = await h.app.inject({ method: 'POST', url: '/v1/local-accounts/bootstrap', payload: { username: 'owner', password: 'long-enough-pw' } });
    expect(ok.statusCode).toBe(201);
  });

  it('the in-process secret of the management agent is not accepted there, and no header names an owner', async () => {
    const { h, owner } = await ready({ env: {} });
    const r = await h.pub('/v1/agents', { headers: internalHeaders(owner.id) });
    expect(r.status).toBe(401);
    // (At the private listener the same headers are the management agent's own reads.)
    expect((await h.app.inject({ url: '/v1/agents', headers: internalHeaders(owner.id) })).json().me).toBe(owner.id);
    expect((await h.pub('/v1/agents', { headers: { 'x-hatchabot-owner': owner.id } })).status).toBe(401);
  });

  it('command-line and peer tokens are refused there, however valid elsewhere', async () => {
    const { h, owner } = await ready();
    const { token } = h.store.createCliToken(owner.id, 'CLI', 90);
    expect((await h.app.inject({ url: '/v1/agents', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    expect((await h.pub('/v1/agents', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    const peer = h.store.createCliToken(owner.id, 'peer', 90, 'rehost');
    expect((await h.pub('/v1/agents', { headers: { authorization: `Bearer ${peer.token}` } })).status).toBe(401);
  });

  it('the owner\'s first claim (a machine made from the command line) is refused there; a member\'s invitation works', async () => {
    const { h } = await ready();
    const id = `acct-${randomUUID()}`;
    h.store.insertLocalAccount({ id, username: 'second-owner', pwHash: '', pwSalt: '', hostOwner: true, disabled: false, createdAt: 'now', claimCode: 'owner-claim-code', claimExpires: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await h.pub('/v1/local-accounts/claim?code=owner-claim-code')).status).toBe(403);
    expect((await h.pub('/v1/local-accounts/claim', { body: { code: 'owner-claim-code', password: 'a-long-password' } })).status).toBe(403);
    expect(h.store.localAccount(id)!.pwHash).toBe('');
    const mid = `acct-${randomUUID()}`;
    h.store.insertLocalAccount({ id: mid, username: 'invited', pwHash: '', pwSalt: '', hostOwner: false, disabled: false, createdAt: 'now', claimCode: 'member-claim-code', claimExpires: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await h.pub('/v1/local-accounts/claim?code=member-claim-code')).json.username).toBe('invited');
    const jar = new Jar();
    expect((await h.pub('/v1/local-accounts/claim', { body: { code: 'member-claim-code', password: 'a-long-password' }, jar })).status).toBe(200);
    expect((await h.pub('/v1/agents', { jar })).json.me).toBe(mid);
  });

  it('a request for another host name is refused', async () => {
    const { h } = await ready();
    expect((await h.pub('/', { headers: { 'x-forwarded-host': 'evil.example' } })).status).toBe(421);
    expect((await h.pub('/', { headers: { 'x-forwarded-host': PUBLIC_HOST } })).status).toBe(200);
  });

  it('a replay inside the process of a public request stays public; of a private one, private', async () => {
    let replay: Record<string, string> = {};
    const { h } = await ready({ extra: (app) => { app.addHook('onRequest', async (req) => { if (req.url === '/v1/config') replay = publicReplayHeaders(req); }); } });
    await h.pub('/v1/config');
    expect(Object.keys(replay)).toHaveLength(1);
    // The replay, made the way the management chat makes one, is judged by the public route table.
    expect((await h.app.inject({ url: '/v1/unclassified-thing', headers: replay })).statusCode).toBe(403);
    // A client cannot make the marker up (it lowers trust only, but it must not be forgeable either).
    const forged = await h.app.inject({ url: '/v1/unclassified-thing', headers: { 'x-hatchabot-public-replay': 'f'.repeat(64) } });
    expect(forged.statusCode).toBe(401); // judged as private: "sign in", not the public table's 403
    await h.app.inject({ url: '/v1/config' });
    expect(replay).toEqual({});
  });

  it('the public listener is bound to loopback only', async () => {
    const { h } = await ready();
    const addr = await new Promise<string>((resolve, reject) => {
      const s = connect(h.port, '127.0.0.1', () => { resolve(s.localAddress ?? ''); s.destroy(); });
      s.once('error', reject);
    });
    expect(addr).toBe('127.0.0.1');
    const { networkInterfaces } = await import('node:os');
    const other = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (other) {
      const refused = await new Promise<boolean>((resolve) => {
        const s = connect({ port: h.port, host: other, timeout: 1500 }, () => { s.destroy(); resolve(false); });
        s.once('error', () => resolve(true));
        s.once('timeout', () => { s.destroy(); resolve(true); });
      });
      expect(refused).toBe(true);
    }
  });
});

describe('the visitor\'s address', () => {
  it('is the one tailscaled reports: the LAST forwarded value, and only a well-formed one', () => {
    expect(publicClientAddress({ headers: { 'x-forwarded-for': '203.0.113.7' } })).toBe('203.0.113.7');
    expect(publicClientAddress({ headers: { 'x-forwarded-for': '10.0.0.1, 203.0.113.7' } })).toBe('203.0.113.7');
    expect(publicClientAddress({ headers: { 'x-forwarded-for': ['1.1.1.1', '2001:db8::1'] } })).toBe('2001:db8::1');
    expect(publicClientAddress({ headers: {} })).toBe('unknown');
    expect(publicClientAddress({ headers: { 'x-forwarded-for': 'user:owner' } })).toBe('unknown');
    expect(publicClientAddress({ headers: { 'x-forwarded-for': '<script>' } })).toBe('unknown');
    expect(approximateSource('203.0.113.7')).toBe('203.0.113.x');
    expect(approximateSource('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1::/48');
  });
});

describe('sign-in limits at the public address', () => {
  it('count the visitor\'s real address there, and never lock anyone out of the private address', async () => {
    const { h, owner } = await ready({ env: { HATCHABOT_LOGIN_FAILS_PER_WINDOW: '3' } });
    const bad = (from: string, username = 'nobody') => h.pub('/v1/login', { body: { username, password: 'wrong' }, from });
    for (let i = 0; i < 3; i++) expect((await bad('198.51.100.20')).status).toBe(401);
    expect((await bad('198.51.100.20')).status).toBe(429);
    // Another visitor is not locked out by the first one's misses…
    expect((await bad('198.51.100.21', 'someone-else')).status).toBe(401);
    // …and a forged first value does not buy a fresh bucket: the last one counts.
    expect((await h.pub('/v1/login', { body: { username: 'x', password: 'y' }, headers: { 'x-forwarded-for': '9.9.9.9, 198.51.100.20' } })).status).toBe(429);
    // The account is its own bucket: three misses on "owner" from three addresses lock it at the public address…
    for (const from of ['198.51.100.31', '198.51.100.32', '198.51.100.33']) expect((await bad(from, 'owner')).status).toBe(401);
    expect((await h.pub('/v1/login', { body: { username: 'owner', password: owner.password }, from: '198.51.100.34' })).status).toBe(429);
    // …and the owner still signs in at the private one.
    expect((await h.app.inject({ method: 'POST', url: '/v1/login', payload: { username: 'owner', password: owner.password } })).statusCode).toBe(200);
    const bursts = h.store.listSecurityLog().filter((e) => e.kind === 'public.failure_burst');
    expect(bursts.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(bursts)).toContain('account owner');
  }, 30_000);

  it('a forwarded-for header on the PRIVATE listener from a non-loopback peer is not believed (unchanged)', async () => {
    const { h } = await ready({ env: { HATCHABOT_LOGIN_FAILS_PER_WINDOW: '2' } });
    const bad = (xff: string) => h.app.inject({ method: 'POST', url: '/v1/login', remoteAddress: '192.0.2.50', payload: { username: 'nobody', password: 'x' }, headers: { 'x-forwarded-for': xff } });
    expect((await bad('1.1.1.1')).statusCode).toBe(401);
    expect((await bad('2.2.2.2')).statusCode).toBe(401);
    expect((await bad('3.3.3.3')).statusCode).toBe(429);
  }, 20_000);

  it('lockouts back off: the second one lasts twice as long', async () => {
    const { h } = await ready({ env: { HATCHABOT_LOGIN_FAILS_PER_WINDOW: '2' } });
    const bad = () => h.pub('/v1/login', { body: { username: 'victim', password: 'wrong' }, from: '198.51.100.40' });
    const WINDOW = 15 * 60_000;
    const realNow = Date.now;
    try {
      await bad(); await bad();
      expect((await bad()).status).toBe(429);
      Date.now = () => realNow() + WINDOW + 1000;
      expect((await bad()).status).toBe(401); // the first lock is over
      expect((await bad()).status).toBe(401);
      expect((await bad()).status).toBe(429);
      Date.now = () => realNow() + 2 * WINDOW + 2000;
      expect((await bad()).status).toBe(429); // one window later: still locked (the lock doubled)
      Date.now = () => realNow() + 3 * WINDOW + 3000;
      expect((await bad()).status).toBe(401);
    } finally { Date.now = realNow; }
  }, 30_000);

  it('a ceiling on all public failures together refuses every public sign-in, not the private ones', async () => {
    const { h, owner } = await ready({ env: { HATCHABOT_PUBLIC_FAILS_CEILING: '5', HATCHABOT_LOGIN_FAILS_PER_WINDOW: '10' } });
    for (let i = 0; i < 5; i++) expect((await h.pub('/v1/login', { body: { username: `u${i}`, password: 'x' }, from: `198.51.100.${50 + i}` })).status).toBe(401);
    expect((await h.pub('/v1/login', { body: { username: 'owner', password: owner.password }, from: '198.51.100.99' })).status).toBe(429);
    expect((await h.app.inject({ method: 'POST', url: '/v1/login', payload: { username: 'owner', password: owner.password } })).statusCode).toBe(200);
  }, 30_000);

  it('a ceiling on requests, per address and overall', async () => {
    const { h } = await ready({ env: { HATCHABOT_PUBLIC_REQS_PER_MIN_PER_ADDRESS: '5', HATCHABOT_PUBLIC_REQS_PER_MIN: '12' } });
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await h.pub('/healthz', { from: '198.51.100.60' })).status);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(1);
    expect(codes.slice(0, 4).every((c) => c !== 429)).toBe(true);
    const more: number[] = [];
    for (let i = 0; i < 8; i++) more.push((await h.pub('/v1/config', { from: `198.51.100.${70 + i}` })).status);
    expect(more.at(-1)).toBe(429); // different addresses, the overall ceiling
    expect((await h.app.inject({ url: '/v1/config' })).statusCode).toBe(200);
  });

  it('second-factor guesses are limited per person', async () => {
    const { h, owner } = await ready({ env: { HATCHABOT_LOGIN_FAILS_PER_WINDOW: '3' } });
    const jar = new Jar();
    await h.pub('/v1/login', { body: { username: 'owner', password: owner.password }, jar });
    for (let i = 0; i < 3; i++) expect((await h.pub('/v1/second-factor/verify', { jar, body: { code: '111111' } })).status).toBe(401);
    expect((await h.pub('/v1/second-factor/verify', { jar, body: { code: '111111' } })).status).toBe(429);
  }, 20_000);
});

describe('each lock on its own (a marked socket, no listener)', () => {
  // The same object the listener records for every connection it accepts.
  const publicReq = async (headers: Record<string, string> = {}) => {
    const { markPublicSocket } = await import('../src/api/trust.js');
    const socket = {};
    markPublicSocket(socket as never);
    return { ip: '127.0.0.1', headers, socket, raw: { socket } } as never;
  };
  const privateReq = (headers: Record<string, string> = {}) => ({ ip: '127.0.0.1', headers, socket: {}, raw: { socket: {} } }) as never;

  it('"on this machine" is false for a public request with no forwarding headers at all', async () => {
    const { onThisMachine } = await import('../src/api/accountsAuth.js');
    expect(onThisMachine(privateReq())).toBe(true);
    expect(onThisMachine(await publicReq())).toBe(false);
  });
  it('the in-process principal and the owner header are refused for a public request', async () => {
    const { internalPrincipal, principalOf } = await import('../src/api/principal.js');
    expect(internalPrincipal(privateReq(internalHeaders('owner-1')))?.ownerId).toBe('owner-1');
    expect(internalPrincipal(await publicReq(internalHeaders('owner-1')))).toBeUndefined();
    process.env.HATCHABOT_ALLOW_OWNER_HEADER = '1';
    try {
      expect(principalOf(privateReq({ 'x-hatchabot-owner': 'owner-1' })).ownerId).toBe('owner-1');
      expect(principalOf(await publicReq({ 'x-hatchabot-owner': 'owner-1' })).via).toBe('password'); // the header is not read
    } finally { delete process.env.HATCHABOT_ALLOW_OWNER_HEADER; }
  });
  it('a public request is HTTPS whatever X-Forwarded-Proto says', async () => {
    const { requestIsHttps } = await import('../src/api/sessionCookie.js');
    expect(requestIsHttps(privateReq(), {})).toBe(false);
    expect(requestIsHttps(await publicReq(), {})).toBe(true);
    expect(requestIsHttps(await publicReq({ 'x-forwarded-proto': 'http' }), {})).toBe(true);
  });
});

describe('who a public request acts as', () => {
  it('a bearer token beside a valid public session is ignored: the session decides', async () => {
    const { h } = await ready();
    const a = await h.addAccount('alice');
    const c = await h.addAccount('carol');
    const { token } = h.store.createCliToken(c.id, 'CLI', 90);
    const jar = await h.signIn('alice', a.password);
    const r = await h.pub('/v1/agents', { jar, headers: { authorization: `Bearer ${token}` } });
    expect(r.json.me).toBe(a.id); // not carol, whose token it is
  });

  it('a change confirmed at the public address is executed as a public request (route class and step-up apply to it)', async () => {
    const seen: Array<{ url: string; pub: boolean }> = [];
    h = await publicApp({ fullRoutes: true, extra: (app) => { app.addHook('onRequest', async (req) => { if (/^\/v1\/(backups\/run|peers)$/.test(req.url)) seen.push({ url: req.url, pub: isPublic(req) }); }); } });
    const owner = await h.addAccount('owner', { owner: true });
    await h.app.publicAccess!.evaluate();
    const now = Date.now();
    const card = (id: string, method: string, path: string) => h!.store.putMgmtProposal({
      id, ownerId: owner.id, chatId: 0, fromUserId: 0, messageId: 0, tool: 'x',
      resolved: { rest: { call: { method, path, body: {} }, card: 'A change' } },
      summary: 'A change', createdAtMs: now, expiresAtMs: now + 3600_000, status: 'pending', source: 'agent',
    } as never);
    card('c_backup', 'POST', '/v1/backups/run');
    card('c_peer', 'POST', '/v1/peers');
    card('c_private', 'POST', '/v1/backups/run');
    const jar = await h.signIn('owner', owner.password, { totpSecret: owner.totpSecret });
    expect((await h.pub('/v1/proposals/c_backup/confirm', { jar, body: {} })).status).toBe(200);
    // A card whose change is refused at the public address is refused when confirmed there too.
    const peer = await h.pub('/v1/proposals/c_peer/confirm', { jar, body: {} });
    expect(JSON.stringify(peer.json)).toContain('not available at the public address');
    // The same confirm at the private address runs privately.
    const login = await h.app.inject({ method: 'POST', url: '/v1/login', payload: { username: 'owner', password: owner.password } });
    await h.app.inject({ method: 'POST', url: '/v1/proposals/c_private/confirm', headers: { cookie: String(login.headers['set-cookie']).split(';')[0]! }, payload: {} });
    // (The /v1/peers replay never got as far as this test's hook: the gate refused it first.)
    expect(seen).toEqual([{ url: '/v1/backups/run', pub: true }, { url: '/v1/backups/run', pub: false }]);
  });

  it('with "a second factor for everyone", a member without one can only add one there, and not with the password alone', async () => {
    const { h } = await ready({ env: { HATCHABOT_PUBLIC_SECOND_FACTOR_FOR_ALL: '1' } });
    const m = await h.addAccount('member');
    const jar = await h.signIn('member', m.password);
    const r = await h.pub('/v1/agents', { jar });
    expect(r.status).toBe(403);
    expect(r.json.secondFactor).toBe('enrol');
    expect((await h.pub('/v1/second-factor', { jar })).status).toBe(200);
    expect((await h.pub('/v1/cli-tokens', { jar, body: {} })).status).toBe(403);
    const { base32Decode, totp } = await import('../src/api/totp.js');
    // The password is what a thief would have: it does not enrol a phone here.
    const stolen = await h.pub('/v1/second-factor/totp', { jar, body: { current: m.password } });
    expect(stolen.status).toBe(403);
    expect(stolen.json.secondFactor).toBe('enrol-link');
    expect(h.store.listSecondFactors(m.id, { unconfirmed: true })).toEqual([]);
    // A reset link from the owner (sent to the person out of band), used at the public address: now they may.
    h.store.setLocalAccountClaim(m.id, 'reset-code-from-the-owner', new Date(Date.now() + 60_000).toISOString());
    const linked = new Jar();
    expect((await h.pub('/v1/local-accounts/claim', { jar: linked, body: { code: 'reset-code-from-the-owner', password: 'a-new-password-they-chose' } })).status).toBe(200);
    expect((await h.pub('/v1/agents', { jar: linked })).json.secondFactor).toBe('enrol');
    const start = await h.pub('/v1/second-factor/totp', { jar: linked, body: { current: 'a-new-password-they-chose' } });
    expect(start.status).toBe(200);
    expect((await h.pub('/v1/second-factor/totp/confirm', { jar: linked, body: { id: start.json.id, code: totp(base32Decode(start.json.secret)) } })).status).toBe(200);
    expect((await h.pub('/v1/agents', { jar: linked })).status).toBe(200);
  });
});
