import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { _resetLoginThrottle, noteFailure, throttled, registerAuth } from '../src/api/auth.js';
import { principalOf } from '../src/api/principal.js';
import { Store } from '../src/store/store.js';

// Night review, 2026-09-27: sign-in and accounts.

const SECRET = Buffer.alloc(32, 9);
const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }) => {
  const c = res.cookies.find((x) => x.name === 'hatchabot_session');
  return c ? `hatchabot_session=${c.value}` : '';
};
async function accounts() {
  const store = new Store(new Database(':memory:'));
  const f = Fastify();
  await registerAuth(f, { secret: SECRET, mode: 'accounts', store, cliTokenOwner: (t) => store.ownerForCliToken(t), cliTokenScope: (t) => store.cliTokenScope(t) });
  f.get('/v1/whoami', async (req) => principalOf(req));
  const boot = await f.inject({ method: 'POST', url: '/v1/local-accounts/bootstrap', payload: { username: 'chris', password: 'correct-horse' } });
  return { f, store, owner: boot.json().id as string, recoveryCode: boot.json().recoveryCode as string, cookie: cookieOf(boot) };
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

beforeEach(() => _resetLoginThrottle());
afterEach(() => { delete process.env.HATCHABOT_ALLOWED_EMAILS; delete process.env.HATCHABOT_LOCAL_ACCOUNTS; });

describe('command-line tokens die with a reset', () => {
  it('recovering with the code revokes full tokens; a peer\'s rehost token and agent call tokens stay', async () => {
    const { f, store, owner, recoveryCode } = await accounts();
    const full = store.createCliToken(owner, 'stolen').token;
    const rehost = store.createCliToken(owner, 'peer', 90, 'rehost').token;
    expect((await f.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(full) })).statusCode).toBe(200);
    const r = await f.inject({ method: 'POST', url: '/v1/local-accounts/recover-with-code', payload: { username: 'chris', code: recoveryCode, password: 'new-horse-battery' } });
    expect(r.statusCode).toBe(200);
    expect((await f.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(full) })).statusCode).toBe(401);
    expect(store.ownerForCliToken(rehost)).toBe(owner);
  });
  it('the host owner resetting someone\'s password revokes that person\'s tokens', async () => {
    const { f, store, cookie } = await accounts();
    const add = await f.inject({ method: 'POST', url: '/v1/local-accounts', headers: { cookie }, payload: { username: 'maria', password: 'maria-password' } });
    const maria = add.json().id as string;
    const tok = store.createCliToken(maria, 'cli').token;
    expect((await f.inject({ method: 'POST', url: `/v1/local-accounts/${maria}/password`, headers: { cookie }, payload: { password: 'reset-by-owner' } })).statusCode).toBe(200);
    expect(store.ownerForCliToken(tok)).toBeUndefined();
  });
});

describe('recovery beats a lock-out', () => {
  it('ten bad passwords for the owner lock sign-in, but the recovery code still works and ends the lock', async () => {
    const { f, recoveryCode } = await accounts();
    for (let i = 0; i < 12; i++) await f.inject({ method: 'POST', url: '/v1/login', payload: { username: 'chris', password: 'wrong' }, remoteAddress: `10.0.0.${i + 1}` });
    expect((await f.inject({ method: 'POST', url: '/v1/login', payload: { username: 'chris', password: 'correct-horse' }, remoteAddress: '10.0.1.1' })).statusCode).toBe(429);
    const r = await f.inject({ method: 'POST', url: '/v1/local-accounts/recover-with-code', payload: { username: 'chris', code: recoveryCode, password: 'new-horse-battery' }, remoteAddress: '10.0.1.1' });
    expect(r.statusCode).toBe(200);
    expect((await f.inject({ method: 'POST', url: '/v1/login', payload: { username: 'chris', password: 'new-horse-battery' }, remoteAddress: '10.0.1.2' })).statusCode).toBe(200);
  }, 30_000);
});

describe('wrong current passwords count against the account', () => {
  it('a hijacked session guessing the current password is capped even from fresh addresses', async () => {
    const { f, cookie } = await accounts();
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await f.inject({ method: 'POST', url: '/v1/local-accounts/me/password', headers: { cookie }, payload: { current: `guess-${i}`, password: 'another-password' }, remoteAddress: `10.1.0.${i + 1}` })).statusCode;
    }
    expect(last).toBe(429);
  }, 30_000);
});

describe('one claim link, one claimant', () => {
  it('two simultaneous claims of one link: exactly one gets in', async () => {
    const { f, cookie } = await accounts();
    const add = await f.inject({ method: 'POST', url: '/v1/local-accounts', headers: { cookie }, payload: { username: 'maria' } });
    const code = add.json().claimCode as string;
    const [a, b] = await Promise.all([
      f.inject({ method: 'POST', url: '/v1/local-accounts/claim', payload: { code, password: 'first-password' } }),
      f.inject({ method: 'POST', url: '/v1/local-accounts/claim', payload: { code, password: 'second-password' } }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 404]);
  });
});

describe('the throttle map keeps the account being guessed at', () => {
  it('a flood of junk does not evict a live account bucket', () => {
    const req = (ip: string) => ({ ip, headers: {} }) as never;
    for (let i = 0; i < 10; i++) noteFailure(req('10.9.9.9'), 'owner');
    for (let i = 0; i < 6_000; i++) noteFailure(req(`10.${(i >> 8) & 255}.${i & 255}.1`), `junk-${i}`);
    expect(throttled(req('10.200.0.1'), 'owner')).toBe(true);
  });
});

describe('password mode: one bucket for the one password', () => {
  it('forged forwarded-for addresses from a loopback peer do not buy fresh guesses', async () => {
    const f = Fastify();
    await registerAuth(f, { password: 'the-real-one', secret: SECRET, mode: 'password' });
    // The shared bucket is a ceiling at ten times the per-client limit (a lock
    // at the per-client limit let anyone shut the owner out): limit 1 here.
    process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW = '1';
    try {
      let last = 0;
      for (let i = 0; i < 12; i++) {
        last = (await f.inject({ method: 'POST', url: '/v1/login', payload: { password: `guess-${i}` }, remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': `203.0.113.${i + 1}` } })).statusCode;
      }
      expect(last).toBe(429);
    } finally { delete process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW; }
  }, 30_000);
});

describe('Google sign-in with local accounts beside it', () => {
  async function mixed() {
    process.env.HATCHABOT_LOCAL_ACCOUNTS = '1';
    const store = new Store(new Database(':memory:'));
    const verifier = { verify: async () => ({ sub: 'g-owner', email: 'owner@example.com', expMs: Date.now() + 3_600_000 }) };
    const f = Fastify();
    await registerAuth(f, { secret: SECRET, mode: 'identity', store, verifier: verifier as never, cliTokenOwner: (t) => store.ownerForCliToken(t) });
    f.get('/v1/whoami', async (req) => principalOf(req));
    store.insertHost({ id: 'h1', ownerId: 'user-g-owner', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    const s = await f.inject({ method: 'POST', url: '/v1/session', payload: { idToken: 'x' } });
    return { f, store, cookie: cookieOf(s) };
  }
  it('the Google owner of the machine may list and add local accounts; nobody else may', async () => {
    const { f, cookie } = await mixed();
    expect((await f.inject({ method: 'GET', url: '/v1/local-accounts', headers: { cookie } })).statusCode).toBe(200);
    const add = await f.inject({ method: 'POST', url: '/v1/local-accounts', headers: { cookie }, payload: { username: 'maria' } });
    expect(add.statusCode).toBe(201);
    const claim = await f.inject({ method: 'POST', url: '/v1/local-accounts/claim', payload: { code: add.json().claimCode, password: 'maria-password' } });
    const maria = cookieOf(claim);
    expect((await f.inject({ method: 'GET', url: '/v1/local-accounts', headers: { cookie: maria } })).statusCode).toBe(403);
    // …and her console's WebSocket resolves her from the cookie.
    expect((f as any).principalFromCookieHeader(maria)?.ownerId).toBe(claim.json().id);
  });
  it('a Google account taken off the allowlist loses its command-line tokens too', async () => {
    const { f, store } = await mixed();
    store.recordAccount('user-g-owner', 'owner@example.com');
    const tok = store.createCliToken('user-g-owner', 'cli').token;
    process.env.HATCHABOT_ALLOWED_EMAILS = 'owner@example.com';
    expect((await f.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(tok) })).statusCode).toBe(200);
    process.env.HATCHABOT_ALLOWED_EMAILS = 'someone-else@example.com';
    expect((await f.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(tok) })).statusCode).toBe(403);
  });
});
