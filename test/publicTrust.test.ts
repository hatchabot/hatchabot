import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { Jar, PUBLIC_HOST, publicApp, type PublicApp } from './helpers/publicApp.js';
import { internalHeaders } from '../src/api/principal.js';
import { setupCode } from '../src/api/signIn/accountsAuth.js';
import { approximateSource, isPublic, publicClientAddress, publicReplayHeaders } from '../src/api/trust.js';
import { noteFailure, throttled, _loginThrottleKeys } from '../src/api/signIn/auth.js';
import type { Store } from '../src/store/store.js';
import { totp } from '../src/api/signIn/totp.js';
import { privCookie } from './helpers/publicWorld.js';
import { servedRequest, viaServe } from './helpers/viaServe.js';

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
    // In, and (having arrived by an invitation) sent to add a second factor before anything else.
    expect(h.store.localAccount(mid)!.pwHash).not.toBe('');
    expect((await h.pub('/v1/agents', { jar })).json.secondFactor).toBe('enrol');
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

  it('a name typed there with a line break in it is put on the record as that account, not as an address (HB-1389 review)', async () => {
    const { h } = await ready({ env: { HATCHABOT_LOGIN_FAILS_PER_WINDOW: '2' } });
    for (const from of ['198.51.100.41', '198.51.100.42']) {
      expect((await h.pub('/v1/login', { body: { username: 'made-up\nname', password: 'wrong' }, from })).status).toBe(401);
    }
    const bursts = h.store.listSecurityLog().filter((e) => e.kind === 'public.failure_burst').map((e) => e.detail.bucket);
    // Was: "address 198.51.100.x", the address of the miss that filled the name's count.
    expect(bursts).toEqual(['account made-up\nname']);
  }, 20_000);

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

  it('a lockout, and how often there has been one, outlive a restart (HB-0836)', async () => {
    const env = { HATCHABOT_LOGIN_FAILS_PER_WINDOW: '2' };
    let { h: app } = await ready({ env });
    const bad = () => app.pub('/v1/login', { body: { username: 'victim', password: 'wrong' }, from: '198.51.100.41' });
    const badHere = () => app.app.inject({ method: 'POST', url: '/v1/login', payload: { username: 'victim', password: 'wrong' } });
    /** The process ends, and another starts on the same database: nothing of the last one's memory is left. */
    const restart = async () => {
      const store = app.store;
      await app.close();
      app = h = await publicApp({ env, store });
      await app.app.publicAccess!.evaluate();
    };
    const WINDOW = 15 * 60_000;
    const realNow = Date.now;
    try {
      await bad(); await bad();
      expect((await bad()).status).toBe(429);
      // At the private address too: its own count, kept the same way.
      expect((await badHere()).statusCode).toBe(401);
      expect((await badHere()).statusCode).toBe(401);
      expect((await badHere()).statusCode).toBe(429);
      await restart();
      expect((await bad()).status).toBe(429); // still locked out
      expect((await badHere()).statusCode).toBe(429);
      Date.now = () => realNow() + WINDOW + 1000;
      expect((await bad()).status).toBe(401); // the first lock is over
      expect((await bad()).status).toBe(401);
      expect((await bad()).status).toBe(429);
      await restart();
      Date.now = () => realNow() + 2 * WINDOW + 2000;
      expect((await bad()).status).toBe(429); // one window later: still locked, the second lock doubled across the restart
      Date.now = () => realNow() + 3 * WINDOW + 3000;
      expect((await bad()).status).toBe(401);
    } finally { Date.now = realNow; }
  }, 60_000);

  it('a recovered account starts clean: its second factor, and how often it was locked out (HB-0836)', async () => {
    const { h } = await ready({ env: { HATCHABOT_LOGIN_FAILS_PER_WINDOW: '2' } });
    const member = await h.addAccount('member', { totp: true });
    const bad = (from: string) => h.pub('/v1/login', { body: { username: 'member', password: 'wrong' }, from });
    const WINDOW = 15 * 60_000;
    const realNow = Date.now;
    try {
      // Its second factor guessed at by someone who has its password: locked out.
      const jar = new Jar();
      expect((await h.pub('/v1/login', { body: { username: 'member', password: member.password }, jar, from: '198.51.100.70' })).status).toBe(200);
      for (const from of ['198.51.100.70', '198.51.100.71']) expect((await h.pub('/v1/second-factor/verify', { body: { code: '000000' }, jar, from })).status).toBe(401);
      expect((await h.pub('/v1/second-factor/verify', { body: { code: '000000' }, jar, from: '198.51.100.72' })).status).toBe(429);
      // Its password guessed at: locked out, once.
      await bad('198.51.100.73'); await bad('198.51.100.74');
      expect((await bad('198.51.100.75')).status).toBe(429);
      // Recovered with its code, at the public address, as a member may be.
      const cookie = await privCookie(h, 'member', member.password);
      const code: string = (await h.app.inject({ method: 'POST', url: '/v1/local-accounts/me/recovery-code', headers: { cookie }, payload: { current: member.password } })).json().recoveryCode;
      const back = new Jar();
      expect((await h.pub('/v1/local-accounts/recover-with-code', { jar: back, body: { username: 'member', code, password: 'the-member-chose-this' }, from: '198.51.100.76' })).status).toBe(200);
      // Its second factor is taken again at once…
      expect((await h.pub('/v1/second-factor/verify', { body: { code: totp(member.totpSecret!, Date.now() + 30_000) }, jar: back, from: '198.51.100.77' })).status).toBe(200);
      // …and locked out again, its password is for one window, as a first lockout is, not two.
      await bad('198.51.100.78'); await bad('198.51.100.79');
      expect((await bad('198.51.100.80')).status).toBe(429);
      Date.now = () => realNow() + WINDOW + 1000;
      expect((await bad('198.51.100.81')).status).toBe(401);
    } finally { Date.now = realNow; }
  }, 60_000);

  it('a recovery leaves the address\'s own count as it was: a reset button for the address limit is no one\'s (HB-0836)', async () => {
    const { h } = await ready({ env: { HATCHABOT_LOGIN_FAILS_PER_WINDOW: '2' } });
    const member = await h.addAccount('member', { totp: true });
    const WINDOW = 15 * 60_000;
    const realNow = Date.now;
    try {
      // Its second factor guessed at from one address: that address, and the account, locked out.
      const jar = new Jar();
      expect((await h.pub('/v1/login', { body: { username: 'member', password: member.password }, jar, from: '198.51.100.90' })).status).toBe(200);
      for (let i = 0; i < 2; i++) expect((await h.pub('/v1/second-factor/verify', { body: { code: '000000' }, jar, from: '198.51.100.90' })).status).toBe(401);
      // Recovered with its code: the account's count is cleared, the address's is not.
      const cookie = await privCookie(h, 'member', member.password);
      const code: string = (await h.app.inject({ method: 'POST', url: '/v1/local-accounts/me/recovery-code', headers: { cookie }, payload: { current: member.password } })).json().recoveryCode;
      const back = new Jar();
      expect((await h.pub('/v1/local-accounts/recover-with-code', { jar: back, body: { username: 'member', code, password: 'the-member-chose-this' }, from: '198.51.100.91' })).status).toBe(200);
      expect(_loginThrottleKeys()).toEqual(expect.arrayContaining(['2fa:pub:ip:198.51.100.90', '2fa:pub:all'])); // and the public ceiling's count stays too
      const good = () => ({ code: totp(member.totpSecret!, Date.now() + 30_000) });
      expect((await h.pub('/v1/second-factor/verify', { body: good(), jar: back, from: '198.51.100.90' })).status).toBe(429); // the address that ran up the misses, until its window ends
      expect((await h.pub('/v1/second-factor/verify', { body: good(), jar: back, from: '198.51.100.92' })).status).toBe(200); // another address: taken
      Date.now = () => realNow() + WINDOW + 1000;
      expect((await h.pub('/v1/second-factor/verify', { body: good(), jar: back, from: '198.51.100.90' })).status).toBe(200); // and that one, once its window is over
    } finally { Date.now = realNow; }
  }, 60_000);

  it('a ceiling on all public failures together refuses every public sign-in, not the private ones', async () => {
    const { h, owner } = await ready({ env: { HATCHABOT_PUBLIC_FAILS_CEILING: '5', HATCHABOT_LOGIN_FAILS_PER_WINDOW: '10' } });
    for (let i = 0; i < 5; i++) expect((await h.pub('/v1/login', { body: { username: `u${i}`, password: 'x' }, from: `198.51.100.${50 + i}` })).status).toBe(401);
    expect((await h.pub('/v1/login', { body: { username: 'owner', password: owner.password }, from: '198.51.100.99' })).status).toBe(429);
    expect((await h.app.inject({ method: 'POST', url: '/v1/login', payload: { username: 'owner', password: owner.password } })).statusCode).toBe(200);
  }, 30_000);

  it('a ceiling on requests, per address and overall', async () => {
    const { h } = await ready({ env: { HATCHABOT_PUBLIC_REQS_PER_MIN_PER_ADDRESS: '5', HATCHABOT_PUBLIC_REQS_PER_MIN: '12' } });
    // The ceilings count by the clock's minute: requests either side of one start again at
    // nought, and on CI the last answered 200 (HB-0684). The clock is held mid-minute.
    vi.useFakeTimers({ toFake: ['Date'], now: Math.floor(Date.now() / 60_000) * 60_000 + 30_000 });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await h.pub('/healthz', { from: '198.51.100.60' })).status);
      expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(1);
      expect(codes.slice(0, 4).every((c) => c !== 429)).toBe(true);
      const more: number[] = [];
      for (let i = 0; i < 8; i++) more.push((await h.pub('/v1/config', { from: `198.51.100.${70 + i}` })).status);
      expect(more.at(-1)).toBe(429); // different addresses, the overall ceiling
      expect((await h.app.inject({ url: '/v1/config' })).statusCode).toBe(200);
    } finally { vi.useRealTimers(); }
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
    const { onThisMachine } = await import('../src/api/signIn/accountsAuth.js');
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
  it('a secret header of the right length in characters but not in bytes is refused, not a 500 (audit, 2026-10-22)', async () => {
    const { internalPrincipal } = await import('../src/api/principal.js');
    const { isPublic } = await import('../src/api/trust.js');
    const odd = 'é'.repeat(internalHeaders('owner-1')['x-hatchabot-internal']!.length);
    expect(() => internalPrincipal(privateReq({ 'x-hatchabot-internal': odd, 'x-hatchabot-internal-owner': 'owner-1' }))).not.toThrow();
    expect(internalPrincipal(privateReq({ 'x-hatchabot-internal': odd, 'x-hatchabot-internal-owner': 'owner-1' }))).toBeUndefined();
    expect(() => isPublic(privateReq({ 'x-hatchabot-public-replay': 'é'.repeat(64) }))).not.toThrow();
    expect(isPublic(privateReq({ 'x-hatchabot-public-replay': 'é'.repeat(64) }))).toBe(false);
  });
  it('a public request is HTTPS whatever X-Forwarded-Proto says', async () => {
    const { requestIsHttps } = await import('../src/api/signIn/sessionCookie.js');
    expect(requestIsHttps(privateReq(), {})).toBe(false);
    expect(requestIsHttps(await publicReq(), {})).toBe(true);
    expect(requestIsHttps(await publicReq({ 'x-forwarded-proto': 'http' }), {})).toBe(true);
  });
});

describe('who a public request acts as', () => {
  it('a bearer token beside a valid public session is ignored: the session decides', async () => {
    const { h } = await ready();
    const a = await h.addAccount('alice', { totp: true });
    const c = await h.addAccount('carol');
    const { token } = h.store.createCliToken(c.id, 'CLI', 90);
    const jar = await h.signIn('alice', a.password, { totpSecret: a.totpSecret });
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

  it('a member without a second factor can only add one there, and not with the password alone (the default; the old opt-in changes nothing)', async () => {
    const { h } = await ready({ env: { HATCHABOT_PUBLIC_SECOND_FACTOR_FOR_ALL: '1' } });
    const m = await h.addAccount('member');
    const jar = await h.signIn('member', m.password);
    const r = await h.pub('/v1/agents', { jar });
    expect(r.status).toBe(403);
    expect(r.json.secondFactor).toBe('enrol-link'); // told where to get a link, not sent to a page that would refuse them
    expect((await h.pub('/v1/second-factor', { jar })).status).toBe(200);
    expect((await h.pub('/v1/cli-tokens', { jar, body: {} })).status).toBe(403);
    const { base32Decode, totp } = await import('../src/api/signIn/totp.js');
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

/** A miss, or a look, at the private address through tailscale serve's listener naming `from` as the client: a bucket of its own for each address and name. */
const peer = (from: string) => servedRequest(from);
const miss = (from: string, who: string | undefined, scope?: 'link' | '2fa') => noteFailure(peer(from), who, scope);
/** A made-up address of its own for each i. */
const made = (i: number) => `198.18.${(i >> 8) & 255}.${i & 255}`;
const asked = (from: string, who: string, scope?: 'link' | '2fa') => throttled(peer(from), who, scope);

describe('the sign-in counts kept across a restart stay few (HB-0836)', () => {
  const db = (s: Store) => (s as unknown as { db: import('better-sqlite3').Database }).db;
  const kept = (s: Store) => (db(s).prepare(`SELECT COUNT(*) AS n FROM rate_hits WHERE bucket LIKE 'signin:%'`).get() as { n: number }).n;

  it('only a count that refuses is kept, and the table is pruned by an index, once a minute at most', async () => {
    h = await publicApp({ env: { HATCHABOT_LOGIN_FAILS_PER_WINDOW: '3' } });
    // A flood of made-up addresses and names, each missed once: nothing kept, so nothing to read back.
    for (let i = 0; i < 2000; i++) miss(made(i), `made-up-user-${i}`);
    expect(kept(h.store)).toBe(0);
    // A name at its limit: kept, as many misses as it took. Its forwarded-for address is not: a loopback peer makes those up.
    for (let i = 0; i < 3; i++) miss('198.51.100.60', 'victim');
    expect(kept(h.store)).toBe(3);
    // Made-up addresses each locked out by their link and second-factor misses: none kept either.
    for (let i = 0; i < 200; i++) for (const scope of ['link', '2fa'] as const) for (let j = 0; j < 3; j++) miss(made(i), undefined, scope);
    expect(kept(h.store)).toBe(3);
    // Misses past the limit (a burst let through together): no more kept, and written once, not at each.
    const set = vi.spyOn(h.store, 'setRateCount');
    try {
      for (let i = 0; i < 2000; i++) miss(`198.51.100.${100 + (i % 100)}`, 'made-up-burst');
      expect(kept(h.store)).toBe(6);
      expect(set.mock.calls.filter(([bucket]) => bucket === 'signin:fail:user:made-up-burst')).toHaveLength(1);
    } finally { set.mockRestore(); }
    expect(JSON.stringify(db(h.store).prepare('EXPLAIN QUERY PLAN DELETE FROM rate_hits WHERE at < ?').all(0))).toContain('rate_hits_at');
    const prepare = vi.spyOn(db(h.store), 'prepare');
    try {
      for (let i = 0; i < 50; i++) h.store.setRateCount(`signin:fail:made-up-${i}`, 1, Date.now() + 60_000);
      expect(prepare.mock.calls.filter(([sql]) => /WHERE at < \?/.test(String(sql))).length).toBeLessThanOrEqual(1);
    } finally { prepare.mockRestore(); }
  }, 60_000);

  it('read back under the bound the counts in memory are held to, the account being guessed at kept', async () => {
    h = await publicApp();
    const store = h.store;
    const until = Date.now() + 10 * 60_000;
    store.transact(() => {
      for (let i = 0; i < 12_000; i++) store.setRateCount(`signin:fail:pub:ip:203.0.113.${i % 250}-${i}`, 1, until);
      store.setRateCount('signin:fail:user:victim', 10, until);
    });
    await h.close();
    h = await publicApp({ store });
    const keys = _loginThrottleKeys();
    expect(keys.length).toBeLessThanOrEqual(10_000);
    expect(keys).toContain('user:victim');
    expect(asked('198.51.100.61', 'victim')).toBe(true); // still locked out
  }, 60_000);
});

describe('sign-in lockouts for made-up names (HB-1240)', () => {
  const ENV = { HATCHABOT_LOGIN_FAILS_PER_WINDOW: '2' };
  /** /v1/login at the private address, from a client of its own each time (so only the name's count is shared). */
  const login = async (app: PublicApp, username: string, password: string, from: string) =>
    (await viaServe(app.app)).inject({ method: 'POST', url: '/v1/login', payload: { username, password }, headers: { 'x-forwarded-for': from } });
  const restart = async (app: PublicApp): Promise<PublicApp> => {
    const store = app.store;
    await app.close();
    h = await publicApp({ env: ENV, store });
    return h;
  };

  it('today\'s refusals, kept: the same words for a name whether or not it is an account, the limit before the password, and both kept across a restart', async () => {
    let app = h = await publicApp({ env: ENV });
    const victim = await app.addAccount('victim', { totp: false });
    for (const [name, pw] of [['victim', 'wrong-one'], ['nobody-here', 'wrong-one']] as const) {
      for (const from of ['198.51.100.11', '198.51.100.12']) {
        const r = await login(app, name, pw, from);
        expect(r.statusCode).toBe(401);
        expect(r.json()).toEqual({ error: 'Wrong username or password' });
      }
    }
    // Locked: refused before any password is checked, the right one included, in the same words for both.
    for (const [name, pw] of [['victim', victim.password], ['nobody-here', 'wrong-one'], ['VICTIM', victim.password]] as const) {
      const r = await login(app, name, pw, '198.51.100.13');
      expect(r.statusCode).toBe(429);
      expect(r.json()).toEqual({ error: 'Too many failed attempts — try again later.' });
    }
    app = await restart(app);
    for (const name of ['victim', 'nobody-here']) {
      const r = await login(app, name, name === 'victim' ? victim.password : 'x', '198.51.100.14');
      expect(r.statusCode).toBe(429);
      expect(r.json()).toEqual({ error: 'Too many failed attempts — try again later.' });
    }
    // Another account is untouched by both.
    const other = await app.addAccount('other', { totp: false });
    expect((await login(app, 'other', other.password, '198.51.100.15')).statusCode).toBe(200);
  }, 60_000);

  it('the store keeps a bounded number of made-up names, an account\'s count always, and below the bound a restart tells no name from an account', async () => {
    let app = h = await publicApp({ env: ENV });
    const victim = await app.addAccount('victim', { totp: false });
    const kiosk = await app.addAccount('kiosk', { totp: false });
    const rows = () => ((app.store as unknown as { db: import('better-sqlite3').Database }).db
      .prepare(`SELECT COUNT(*) AS n FROM rate_hits WHERE bucket LIKE 'signin:fail:%user:%'`).get() as { n: number }).n;
    /** A typed name missed to its limit (2), as /v1/login counts one, each miss from an address of its own. */
    let n = 0;
    const lockOut = (name: string) => { for (let j = 0; j < 2; j++) noteFailure(peer(`203.0.113.${n++ % 250}`), name, undefined, { typed: true }); };
    // A flood of made-up names: the first 500 kept, as many misses as each took, and no more.
    for (let i = 0; i < 600; i++) lockOut(`made-up-${i}`);
    expect(rows()).toBe(500 * 2);
    // An account locked out after the flood is kept all the same, under any spelling that is its count…
    lockOut('victim');
    lockOut('\u212Aiosk'); // a Kelvin sign: lower-cased, its count is kiosk's
    expect(rows()).toBe(500 * 2 + 2 * 2);
    // …and so through the route, where a made-up name past the bound is not.
    for (const from of ['198.51.100.21', '198.51.100.22']) expect((await login(app, 'route-made-up', 'wrong-one', from)).statusCode).toBe(401);
    expect(rows()).toBe(500 * 2 + 2 * 2);
    app = await restart(app);
    const after = async (name: string, pw: string) => (await login(app, name, pw, `198.51.100.${30 + n++ % 50}`)).statusCode;
    expect(await after('victim', victim.password)).toBe(429);
    expect(await after('kiosk', kiosk.password)).toBe(429);
    expect(await after('made-up-0', 'x')).toBe(429); // below the bound: as an account's would be
    expect(await after('made-up-599', 'x')).toBe(401); // past it: this process's only, so gone with the restart
    expect(await after('route-made-up', 'x')).toBe(401);
  }, 60_000);
});
