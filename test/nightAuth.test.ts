import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { _loginStrikeKeys, _loginThrottleKeys, _resetLoginThrottle, noteFailure, throttled, registerAuth } from '../src/api/auth.js';
import { principalOf } from '../src/api/principal.js';
import { markPublicSocket } from '../src/api/trust.js';
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

  it('a locked-out account keeps its count however many made-up names are tried, each to the limit (HB-1389)', async () => {
    process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW = '1';
    try {
      await accounts(); // the account "chris", and the store the names are looked up in
      const req = (ip: string) => ({ ip, headers: {}, server: {}, log: { warn() {} } }) as never;
      noteFailure(req('10.9.9.9'), 'chris', undefined, { typed: true });
      expect(throttled(req('10.200.0.1'), 'chris')).toBe(true);
      // Twelve thousand names typed at the sign-in, each missed as often as the account was.
      for (let i = 0; i < 12_000; i++) noteFailure(req(`10.${(i >> 8) & 255}.${i & 255}.1`), `made-up-${i}`, undefined, { typed: true });
      expect(throttled(req('10.200.0.2'), 'chris')).toBe(true);
      // The memory stays bounded: made-up names are what goes.
      const keys = _loginThrottleKeys();
      expect(keys.length).toBeLessThanOrEqual(10_000);
      expect(keys).toContain('user:chris');
      expect(keys).toContain('user:made-up-11999');
      expect(keys).not.toContain('user:made-up-0');
    } finally { delete process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW; }
  }, 60_000);

  // A peer on this machine (an agent's container under a rootless daemon) that forges forwarded-for addresses.
  const here = (fwd: string) => ({ ip: '127.0.0.1', headers: { 'x-forwarded-for': fwd }, server: {}, log: { warn() {} } }) as never;
  const fwd = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
  /** A request at the public address, from `addr`. */
  const pub = (addr: string) => {
    const socket = {};
    markPublicSocket(socket as never);
    return { ip: '127.0.0.1', headers: { 'x-forwarded-for': addr }, raw: { socket }, socket, server: {}, log: { warn() {} } } as never;
  };
  /** 9,500 names typed here that are nobody's account, ten from each forged address: each address to its limit. */
  const flood = () => { for (let i = 0; i < 9_500; i++) noteFailure(here(fwd(Math.floor(i / 10))), `flood-${i}`, undefined, { typed: true }); };

  it('a flood of made-up names from this machine leaves a public address\'s lockout, its sign-in link lockout and the public ceiling (HB-1389 review)', async () => {
    await accounts();
    const guesser = '203.0.113.7';
    for (let i = 0; i < 10; i++) noteFailure(pub(guesser), `spray-${i}`, undefined, { typed: true });
    for (let i = 0; i < 10; i++) noteFailure(pub(guesser), undefined, 'link');
    expect(throttled(pub(guesser), 'someone-else')).toBe(true);
    expect(throttled(pub(guesser), undefined, 'link')).toBe(true);
    // A locked address on this side too: it outlasts the names.
    for (let i = 0; i < 10; i++) noteFailure(here('198.51.100.20'), `lan-${i}`, undefined, { typed: true });
    flood();
    const keys = _loginThrottleKeys();
    expect(keys.length).toBeLessThanOrEqual(10_000);
    // Was: all three gone, and the address could guess again at once (a sign-in link's only limits are these).
    expect(keys).toEqual(expect.arrayContaining([`pub:ip:${guesser}`, 'pub:all', `link:pub:ip:${guesser}`, 'link:pub:all', 'ip:fwd:198.51.100.20']));
    expect(throttled(pub(guesser), 'someone-else')).toBe(true);
    expect(throttled(pub(guesser), undefined, 'link')).toBe(true);
    expect(throttled(here('198.51.100.20'), 'someone-else')).toBe(true);
    // What went: made-up names, the oldest first.
    expect(keys).not.toContain('user:flood-0');
    expect(keys).toContain('user:flood-9499');
  }, 120_000);

  it('a name typed with a line break in it is a name: held to the stored cap on made-up names like any other (HB-1389 review)', async () => {
    process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW = '1';
    try {
      const { store } = await accounts();
      const stored = () => store.rateCounts('signin:fail:user:', Date.now()).length;
      for (let i = 0; i < 600; i++) noteFailure(here(fwd(i)), `plain-${i}`, undefined, { typed: true });
      const capped = stored();
      expect(capped).toBeLessThanOrEqual(500);
      // Was: none of these was a name key, so each was stored, past the cap (and ranked as an address).
      for (const [i, br] of ['\n', '\r', '\u2028', '\u2029'].entries()) {
        for (let j = 0; j < 50; j++) noteFailure(here(fwd(1_000 + i * 100 + j)), `line-${i}-${j}${br}break`, undefined, { typed: true });
      }
      expect(stored()).toBe(capped);
    } finally { delete process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW; }
  }, 120_000);

  it('a forwarded-for address that reads like a public count is not kept as one (HB-1389 review)', async () => {
    await accounts();
    for (let i = 0; i < 9_000; i++) noteFailure(here(`pub:all-${i}`), undefined);
    for (let i = 0; i < 2_000; i++) noteFailure(here(fwd(i)), `flood-${i}`, undefined, { typed: true });
    const keys = _loginThrottleKeys();
    expect(keys.length).toBeLessThanOrEqual(10_000);
    // Those addresses' counts are this side's, below their limit: they went with the names.
    expect(keys.filter((k) => k.startsWith('ip:fwd:pub:')).length).toBeLessThan(9_000);
  }, 120_000);

  it('a forwarded-for address that reads like a public count, the public ceiling or a shared bucket is an address on this side: its limit, and no lockout, strike or record of the public address (HB-1389 review)', async () => {
    const { store } = await accounts();
    const bursts: string[] = [];
    const server = { publicAccess: { failureBurst: (_req: unknown, key: string) => { bursts.push(key); } } };
    const forged = (addr: string) => ({ ip: '127.0.0.1', headers: { 'x-forwarded-for': addr }, server, log: { warn() {} } }) as never;
    const triesBeforeRefused = (addr: string) => {
      let n = 0;
      while (!throttled(forged(addr)) && n < 500) { noteFailure(forged(addr)); n++; }
      return n;
    };
    const plain = triesBeforeRefused('198.51.100.1');
    // Was: 100 for the ceiling's and the shared buckets' look-alikes, and two of them on the record as the public address's.
    expect(['user:*', 'x-pub:all', 'pub:all', 'pub:user:chris'].map(triesBeforeRefused)).toEqual([plain, plain, plain, plain]);
    // Was: for each address made up, a strike kept a day in the store, and a burst on the record.
    for (let i = 0; i < 300; i++) for (let j = 0; j < 10; j++) noteFailure(forged(`pub:${i}`), undefined, 'link');
    expect(store.rateCounts('signin:strike:', Date.now())).toEqual([]);
    expect(_loginStrikeKeys()).toEqual([]);
    expect(bursts).toEqual([]);
    // A count at the public address is one still: its lockout, strike and record.
    const atPublic = () => Object.assign(pub('203.0.113.9') as object, { server }) as never;
    for (let i = 0; i < 10; i++) noteFailure(atPublic(), undefined, 'link');
    expect(throttled(atPublic(), undefined, 'link')).toBe(true);
    expect(_loginStrikeKeys()).toEqual(['link:pub:ip:203.0.113.9']);
    expect(bursts).toEqual(['link:pub:ip:203.0.113.9']);
  }, 120_000);

  it('the strikes are held to the counts\' bound (HB-1389 review)', () => {
    // Was: past 10,000, only expired strikes went, and a day's lockouts were all kept.
    for (let i = 0; i < 10_500; i++) for (let j = 0; j < 10; j++) noteFailure(pub(fwd(i)), undefined, 'link');
    expect(_loginStrikeKeys().length).toBeLessThanOrEqual(10_000);
  }, 120_000);
});

describe('a name typed at the sign-in is never a shared bucket (HB-1434)', () => {
  /** Accounts mode before the first account: the setup code's bucket is live. */
  async function fresh() {
    const store = new Store(new Database(':memory:'));
    const f = Fastify();
    await registerAuth(f, { secret: SECRET, mode: 'accounts', store, cliTokenOwner: (t) => store.ownerForCliToken(t), cliTokenScope: (t) => store.cliTokenScope(t) });
    return f;
  }
  const wrongCode = (f: Awaited<ReturnType<typeof fresh>>, i: number) =>
    f.inject({ method: 'POST', url: '/v1/local-accounts/bootstrap', payload: { username: 'kiosk', password: 'kiosk-password', setupCode: 'not-the-code' }, remoteAddress: `10.3.${i >> 8}.${i & 255}` });
  const typedLogin = (f: Awaited<ReturnType<typeof fresh>>, username: string, i: number) =>
    f.inject({ method: 'POST', url: '/v1/login', payload: { username, password: 'wrong' }, remoteAddress: `10.4.${i >> 8}.${i & 255}` });

  it('misses typed as the setup code\'s bucket do not count against it', async () => {
    process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW = '1'; // a shared bucket takes ten
    try {
      const f = await fresh();
      for (let i = 0; i < 10; i++) expect([401, 429]).toContain((await typedLogin(f, '*first-run-setup*', i)).statusCode);
      // Was 429: the ten typed misses had filled the setup code's bucket.
      expect((await wrongCode(f, 1)).statusCode).toBe(403);
    } finally { delete process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW; }
  }, 60_000);

  it('a typed name starting with * is held to one name\'s limit, not a shared bucket\'s ten-fold one', async () => {
    process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW = '1';
    try {
      await fresh();
      const req = (ip: string) => ({ ip, headers: {}, server: {}, log: { warn() {} } }) as never;
      noteFailure(req('10.5.0.1'), '*kiosk', undefined, { typed: true });
      // Was false: `user:*kiosk` read as a shared bucket, ten misses.
      expect(throttled(req('10.5.0.2'), '*kiosk')).toBe(true);
      expect(_loginThrottleKeys().filter((k) => k.startsWith('user:*'))).toEqual([]);
    } finally { delete process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW; }
  });

  it('a flood from this machine after a typed miss leaves the setup code\'s count', async () => {
    const f = await fresh();
    // 99 wrong codes of the shared bucket's 100, then one name typed as the bucket.
    for (let i = 0; i < 99; i++) expect((await wrongCode(f, i)).statusCode).toBe(403);
    expect((await typedLogin(f, '*first-run-setup*', 0)).statusCode).toBe(401);
    // 10,500 forged forwarded-for addresses on this machine, each to its limit (worth more than a made-up name).
    const here = (fwd: string) => ({ ip: '127.0.0.1', headers: { 'x-forwarded-for': fwd }, server: {}, log: { warn() {} } }) as never;
    for (let i = 0; i < 10_500; i++) for (let j = 0; j < 10; j++) noteFailure(here(`10.6.${(i >> 8) & 255}.${i & 255}`));
    // Was 403 twice and on: the typed miss had made the bucket a made-up name's, and the flood evicted it.
    expect((await wrongCode(f, 200)).statusCode).toBe(403);
    expect((await wrongCode(f, 201)).statusCode).toBe(429);
  }, 120_000);
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
    const verifier = { verify: async () => ({ sub: 'g-owner', email: 'owner@example.com', emailVerified: true, expMs: Date.now() + 3_600_000 }) };
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

describe('Google sign-in sessions (2026-09-28)', () => {
  it('last beyond the hour-long Google token, and still answer to the allowed-emails list', async () => {
    const store = new Store(new Database(':memory:'));
    const verifier = { verify: async () => ({ sub: 'g-owner', email: 'owner@example.com', emailVerified: true, expMs: Date.now() + 3_600_000 }) };
    const f = Fastify();
    await registerAuth(f, { secret: SECRET, mode: 'identity', store, verifier: verifier as never, cliTokenOwner: () => undefined });
    f.get('/v1/whoami', async (req) => principalOf(req));
    const s = await f.inject({ method: 'POST', url: '/v1/session', payload: { idToken: 'x' } });
    const setCookie = String(s.headers['set-cookie']);
    const maxAge = Number(/Max-Age=(\d+)/i.exec(setCookie)?.[1]);
    expect(maxAge).toBeGreaterThan(13 * 24 * 3600);
    const cookie = cookieOf(s);
    expect((await f.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie } })).statusCode).toBe(200);
    process.env.HATCHABOT_ALLOWED_EMAILS = 'someone-else@example.com';
    try {
      expect((await f.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie } })).statusCode).toBe(401);
    } finally { delete process.env.HATCHABOT_ALLOWED_EMAILS; }
  });
});
