import { beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { _resetLoginThrottle, registerAuth } from '../src/api/auth.js';
import { mintSession } from '../src/api/accountsAuth.js';
import { principalOf } from '../src/api/principal.js';
import { Store } from '../src/store/store.js';

// Review, 2026-09-29 (#38): a 14-day Google session could not be ended from
// the server. Every session now carries its owner's sign-in epoch; "sign out
// everywhere" and removing a person bump it.

const SECRET = Buffer.alloc(32, 5);
// Made-up passwords, assembled here so no credential-shaped literal sits in this file.
const fakePw = (who: string) => [who, 'test', 'pw', '1'].join('-');
const [OWNER_PW, KID_PW, GUEST_PW, LODGER_PW, SHARED_PW] = ['owner', 'kid', 'guest', 'lodger', 'shared'].map(fakePw) as [string, string, string, string, string];
const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }) => {
  const c = res.cookies.find((x) => x.name === 'hatchabot_session');
  return c ? `hatchabot_session=${c.value}` : '';
};
const whoami = (f: any, cookie: string) => f.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie } });
const everywhere = (f: any, cookie: string) => f.inject({ method: 'POST', url: '/v1/logout/everywhere', headers: { cookie } });

beforeEach(() => _resetLoginThrottle());

describe('Google sign-in (identity mode)', () => {
  async function identityApp(store = new Store(new Database(':memory:'))) {
    const verifier = { verify: async () => ({ sub: 'g-person-1', email: 'person@example.com', emailVerified: true, expMs: Date.now() + 3_600_000 }) };
    const f = Fastify();
    await registerAuth(f, { secret: SECRET, mode: 'identity', store, verifier: verifier as never, cliTokenOwner: () => undefined });
    f.get('/v1/whoami', async (req) => principalOf(req));
    return { f, store };
  }
  const signIn = async (f: any) => cookieOf(await f.inject({ method: 'POST', url: '/v1/session', payload: { idToken: 'x' } }));
  /** A cookie as v2.98.0–v2.103.0 minted it: sub:exp:email, no epoch. */
  const oldFormat = (sub: string, email: string) => {
    const payload = `${sub}:${Date.now() + 86_400_000}:${email}`;
    const sig = createHmac('sha256', SECRET).update(payload).digest('hex');
    return `hatchabot_session=${Buffer.from(payload).toString('base64url')}.${sig}`;
  };

  it('a cookie minted before "sign out everywhere" is refused after it; a fresh sign-in works', async () => {
    const { f, store } = await identityApp();
    const phone = await signIn(f);
    const laptop = await signIn(f);
    expect((await whoami(f, phone)).statusCode).toBe(200);
    const out = await everywhere(f, laptop);
    expect(out.statusCode).toBe(200);
    expect(out.cookies.find((c: any) => c.name === 'hatchabot_session')?.value).toBe('');
    expect(store.sessionEpoch('user-g-person-1')).toBe(1);
    expect((await whoami(f, phone)).statusCode).toBe(401);
    expect((await whoami(f, laptop)).statusCode).toBe(401);
    expect((f as any).principalFromCookieHeader(phone)).toBeUndefined(); // the console WebSocket too
    const fresh = await signIn(f);
    expect((await whoami(f, fresh)).json()).toMatchObject({ ownerId: 'user-g-person-1', email: 'person@example.com' });
  });

  it('an old-format cookie (no epoch) keeps working until the first bump', async () => {
    const { f, store } = await identityApp();
    const old = oldFormat('g-person-1', 'person@example.com');
    expect((await whoami(f, old)).json()).toMatchObject({ ownerId: 'user-g-person-1', email: 'person@example.com' });
    // Someone else's bump leaves it alone.
    store.bumpSessionEpoch('user-g-someone-else');
    expect((await whoami(f, old)).statusCode).toBe(200);
    store.bumpSessionEpoch('user-g-person-1');
    expect((await whoami(f, old)).statusCode).toBe(401);
  });

  it('plain logout clears only this browser: the epoch stays and other cookies keep working', async () => {
    const { f, store } = await identityApp();
    const phone = await signIn(f);
    const laptop = await signIn(f);
    expect((await f.inject({ method: 'POST', url: '/v1/logout', headers: { cookie: laptop } })).statusCode).toBe(200);
    expect(store.sessionEpoch('user-g-person-1')).toBe(0);
    expect((await whoami(f, phone)).statusCode).toBe(200);
  });

  it('needs a signed-in person', async () => {
    const { f, store } = await identityApp();
    expect((await f.inject({ method: 'POST', url: '/v1/logout/everywhere' })).statusCode).toBe(401);
    expect(store.sessionEpoch('user-g-person-1')).toBe(0);
  });
});

describe('local accounts (accounts mode)', () => {
  async function accountsApp() {
    const store = new Store(new Database(':memory:'));
    const f = Fastify();
    await registerAuth(f, { secret: SECRET, mode: 'accounts', store });
    f.get('/v1/whoami', async (req) => principalOf(req));
    const boot = await f.inject({ method: 'POST', url: '/v1/local-accounts/bootstrap', payload: { username: 'owner', password: OWNER_PW } });
    return { f, store, ownerCookie: cookieOf(boot), ownerId: boot.json().id as string };
  }
  const login = async (f: any, username: string, password: string) =>
    cookieOf(await f.inject({ method: 'POST', url: '/v1/login', payload: { username, password } }));
  const addPerson = async (f: any, ownerCookie: string, username: string, password: string) =>
    (await f.inject({ method: 'POST', url: '/v1/local-accounts', headers: { cookie: ownerCookie }, payload: { username, password } })).json().id as string;

  it('"sign out everywhere" ends every session of that account, and only that account', async () => {
    const { f, store, ownerCookie, ownerId } = await accountsApp();
    await addPerson(f, ownerCookie, 'kid', KID_PW);
    const kidA = await login(f, 'kid', KID_PW);
    const kidB = await login(f, 'kid', KID_PW);
    expect((await everywhere(f, kidA)).statusCode).toBe(200);
    expect((await whoami(f, kidA)).statusCode).toBe(401);
    expect((await whoami(f, kidB)).statusCode).toBe(401);
    expect((await whoami(f, ownerCookie)).json().ownerId).toBe(ownerId);
    // A fresh sign-in is minted under the new epoch.
    const again = await login(f, 'kid', KID_PW);
    expect((await whoami(f, again)).statusCode).toBe(200);
    expect(store.sessionEpoch(ownerId)).toBe(0);
  });

  it('a cookie from before epochs keeps working until a bump', async () => {
    const { f, store, ownerId } = await accountsApp();
    const acct = store.localAccount(ownerId)!;
    // mintSession with no epoch signs exactly what earlier versions signed.
    const old = `hatchabot_session=${mintSession(SECRET, ownerId, acct.pwHash, Date.now() + 86_400_000)}`;
    expect((await whoami(f, old)).statusCode).toBe(200);
    store.bumpSessionEpoch(ownerId);
    expect((await whoami(f, old)).statusCode).toBe(401);
  });

  it('removing a person ends their sessions', async () => {
    const { f, store, ownerCookie } = await accountsApp();
    const guestId = await addPerson(f, ownerCookie, 'guest', GUEST_PW);
    const guest = await login(f, 'guest', GUEST_PW);
    expect((await whoami(f, guest)).statusCode).toBe(200);
    const del = await f.inject({ method: 'DELETE', url: `/v1/local-accounts/${guestId}`, headers: { cookie: ownerCookie } });
    expect(del.statusCode).toBe(200);
    expect(store.sessionEpoch(guestId)).toBe(1);
    expect((await whoami(f, guest)).statusCode).toBe(401);
    expect((f as any).principalFromCookieHeader(guest)).toBeUndefined();
  });

  it('disabling a person ends their sessions; re-enabling does not revive them', async () => {
    const { f, store, ownerCookie } = await accountsApp();
    const id = await addPerson(f, ownerCookie, 'lodger', LODGER_PW);
    const lodger = await login(f, 'lodger', LODGER_PW);
    store.setLocalAccountDisabled(id, true);
    store.setLocalAccountDisabled(id, false);
    expect((await whoami(f, lodger)).statusCode).toBe(401);
    expect((await whoami(f, await login(f, 'lodger', LODGER_PW))).statusCode).toBe(200);
  });

  it('plain logout does not bump', async () => {
    const { f, store, ownerCookie, ownerId } = await accountsApp();
    const other = await login(f, 'owner', OWNER_PW);
    await f.inject({ method: 'POST', url: '/v1/logout', headers: { cookie: other } });
    expect(store.sessionEpoch(ownerId)).toBe(0);
    expect((await whoami(f, ownerCookie)).statusCode).toBe(200);
  });
});

describe('shared password (password mode)', () => {
  async function passwordApp(password: string | undefined, store = new Store(new Database(':memory:'))) {
    const f = Fastify();
    await registerAuth(f, { password, secret: SECRET, mode: 'password', store });
    f.get('/v1/whoami', async (req) => principalOf(req));
    return { f, store };
  }
  const login = async (f: any) => cookieOf(await f.inject({ method: 'POST', url: '/v1/login', payload: { password: SHARED_PW } }));

  it("ends every device's session without changing the password; old cookies work until then", async () => {
    const { f } = await passwordApp(SHARED_PW);
    // As earlier versions minted it: exp.hmac(session:exp:pwEpoch).
    const pwEpoch = createHmac('sha256', SECRET).update(`pw:${SHARED_PW}`).digest('hex').slice(0, 16);
    const exp = Date.now() + 86_400_000;
    const old = `hatchabot_session=${exp}.${createHmac('sha256', SECRET).update(`session:${exp}:${pwEpoch}`).digest('hex')}`;
    expect((await whoami(f, old)).statusCode).toBe(200);
    const tablet = await login(f);
    expect((await everywhere(f, tablet)).statusCode).toBe(200);
    expect((await whoami(f, old)).statusCode).toBe(401);
    expect((await whoami(f, tablet)).statusCode).toBe(401);
    expect((await whoami(f, await login(f))).statusCode).toBe(200);
  });

  it('with no password set there is nothing to end, and nothing changes', async () => {
    const { f, store } = await passwordApp(undefined);
    const r = await f.inject({ method: 'POST', url: '/v1/logout/everywhere' });
    expect(r.statusCode).toBe(400);
    expect(store.sessionEpoch('dev-owner')).toBe(0);
  });
});
