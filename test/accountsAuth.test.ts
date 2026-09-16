import { beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { _resetLoginThrottle, authIsEnabled, authModeFromEnv, bindHostFor, registerAuth } from '../src/api/auth.js';
import { hashPassword, verifyPassword } from '../src/api/accountsAuth.js';
import { principalOf } from '../src/api/principal.js';
import { Store } from '../src/store/store.js';

const SECRET = Buffer.alloc(32, 9);

async function app(store = new Store(new Database(':memory:'))) {
  const f = Fastify();
  await registerAuth(f, { secret: SECRET, mode: 'accounts', store });
  f.get('/v1/whoami', async (req) => principalOf(req));
  return { f, store };
}

const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }) => {
  const c = res.cookies.find((x) => x.name === 'hatchabot_session');
  return c ? `hatchabot_session=${c.value}` : '';
};

const bootstrap = (f: any, username = 'chris', password = 'correct-horse') =>
  f.inject({ method: 'POST', url: '/v1/local-accounts/bootstrap', payload: { username, password } });

const signIn = (f: any, username: string, password: string) =>
  f.inject({ method: 'POST', url: '/v1/login', payload: { username, password } });

beforeEach(() => _resetLoginThrottle());

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const { hash, salt } = await hashPassword('correct-horse');
    expect(hash).not.toContain('correct-horse'); // stored, never reversible
    expect(await verifyPassword('correct-horse', hash, salt)).toBe(true);
    expect(await verifyPassword('Correct-Horse', hash, salt)).toBe(false);
  });

  it('salts: the same password hashes differently for two accounts', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('HATCHABOT_AUTH=accounts', () => {
  it('is a recognised mode', () => {
    expect(authModeFromEnv({ HATCHABOT_AUTH: 'accounts' } as NodeJS.ProcessEnv)).toBe('accounts');
    expect(() => authModeFromEnv({ HATCHABOT_AUTH: 'acounts' } as NodeJS.ProcessEnv)).toThrow();
  });
});

describe('first run', () => {
  it('creates account #1 as host owner, then refuses a second bootstrap', async () => {
    const { f } = await app();
    const res = await bootstrap(f);
    expect(res.statusCode).toBe(201);
    expect(res.json().hostOwner).toBe(true);
    // The open window closes the moment an account exists — otherwise anyone
    // who reached the port later could mint themselves an owner.
    const again = await f.inject({
      method: 'POST', url: '/v1/local-accounts/bootstrap', payload: { username: 'intruder', password: 'password123' },
    });
    expect(again.statusCode).toBe(403);
  });

  it('account #1 adopts what password mode owned', async () => {
    const store = new Store(new Database(':memory:'));
    store.insertAIProfile({
      id: 'p1', ownerId: 'dev-owner', name: 'Claude', vendor: 'anthropic',
      kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now',
    });
    const { f } = await app(store);
    const res = await bootstrap(f);
    const id = res.json().id as string;
    expect(res.json().adopted).toBeGreaterThan(0);
    expect(store.getAIProfile('p1')!.ownerId).toBe(id);
  });

  it('rejects a short password and a malformed username', async () => {
    const { f } = await app();
    expect((await bootstrap(f, 'chris', 'short')).statusCode).toBe(400);
    expect((await bootstrap(f, 'no spaces allowed', 'password123')).statusCode).toBe(400);
  });
});

describe('sign in', () => {
  it('issues a session for the right password and 401s for the wrong one', async () => {
    const { f } = await app();
    await bootstrap(f);
    const ok = await signIn(f, 'chris', 'correct-horse');
    expect(ok.statusCode).toBe(200);
    const who = await f.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie: cookieOf(ok) } });
    expect(who.json().ownerId).toMatch(/^acct-/);

    const bad = await signIn(f, 'chris', 'wrong-password');
    expect(bad.statusCode).toBe(401);
    // Same answer for an unknown user: no username oracle.
    const unknown = await signIn(f, 'nobody', 'wrong-password');
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error).toBe(bad.json().error);
  });

  it('matches the username case-insensitively', async () => {
    const { f } = await app();
    await bootstrap(f);
    expect((await signIn(f, 'CHRIS', 'correct-horse')).statusCode).toBe(200);
  });

  it('refuses an unauthenticated request and a forged cookie', async () => {
    const { f } = await app();
    await bootstrap(f);
    expect((await f.inject({ method: 'GET', url: '/v1/whoami' })).statusCode).toBe(401);
    const forged = await f.inject({
      method: 'GET', url: '/v1/whoami',
      headers: { cookie: `hatchabot_session=acct-forged:${Date.now() + 1e6}.deadbeef` },
    });
    expect(forged.statusCode).toBe(401);
  });
});

describe('two accounts are two owners', () => {
  it('each sees only its own scope, and the second is not host owner', async () => {
    const { f, store } = await app();
    const first = await bootstrap(f);
    const hostCookie = cookieOf(first);
    const made = await f.inject({
      method: 'POST', url: '/v1/local-accounts', headers: { cookie: hostCookie },
      payload: { username: 'partner', password: 'their-password' },
    });
    expect(made.statusCode).toBe(201);
    expect(made.json().hostOwner).toBe(false);

    const theirs = await signIn(f, 'partner', 'their-password');
    const mine = await f.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie: hostCookie } });
    const them = await f.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie: cookieOf(theirs) } });
    expect(them.json().ownerId).not.toBe(mine.json().ownerId);

    // A non-host account may not see or manage the roster.
    const roster = await f.inject({ method: 'GET', url: '/v1/local-accounts', headers: { cookie: cookieOf(theirs) } });
    expect(roster.statusCode).toBe(403);
    const add = await f.inject({
      method: 'POST', url: '/v1/local-accounts', headers: { cookie: cookieOf(theirs) },
      payload: { username: 'sneaky', password: 'password123' },
    });
    expect(add.statusCode).toBe(403);
    expect(store.countLocalAccounts()).toBe(2);
  });

  it('refuses a duplicate username', async () => {
    const { f } = await app();
    const first = await bootstrap(f);
    const dup = await f.inject({
      method: 'POST', url: '/v1/local-accounts', headers: { cookie: cookieOf(first) },
      payload: { username: 'CHRIS', password: 'another-password' },
    });
    expect(dup.statusCode).toBe(409);
  });
});

describe('passwords and removal', () => {
  it('changing a password invalidates that account\'s other sessions', async () => {
    const { f } = await app();
    const first = await bootstrap(f);
    const old = cookieOf(first);
    const changed = await f.inject({
      method: 'POST', url: '/v1/local-accounts/me/password', headers: { cookie: old },
      payload: { current: 'correct-horse', password: 'brand-new-password' },
    });
    expect(changed.statusCode).toBe(200);
    // The caller gets a fresh cookie; the old one is dead everywhere else.
    expect((await f.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie: old } })).statusCode).toBe(401);
    expect((await f.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie: cookieOf(changed) } })).statusCode).toBe(200);
    expect((await signIn(f, 'chris', 'brand-new-password')).statusCode).toBe(200);
  });

  it('needs the current password to change your own', async () => {
    const { f } = await app();
    const first = await bootstrap(f);
    const res = await f.inject({
      method: 'POST', url: '/v1/local-accounts/me/password', headers: { cookie: cookieOf(first) },
      payload: { current: 'not-it', password: 'brand-new-password' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lets the host owner reset someone else, and refuses the reverse', async () => {
    const { f } = await app();
    const first = await bootstrap(f);
    await f.inject({
      method: 'POST', url: '/v1/local-accounts', headers: { cookie: cookieOf(first) },
      payload: { username: 'partner', password: 'their-password' },
    });
    const roster = await f.inject({ method: 'GET', url: '/v1/local-accounts', headers: { cookie: cookieOf(first) } });
    const partner = (roster.json() as Array<{ id: string; username: string }>).find((a) => a.username === 'partner')!;
    const reset = await f.inject({
      method: 'POST', url: `/v1/local-accounts/${partner.id}/password`, headers: { cookie: cookieOf(first) },
      payload: { password: 'reset-by-owner' },
    });
    expect(reset.statusCode).toBe(200);
    expect((await signIn(f, 'partner', 'reset-by-owner')).statusCode).toBe(200);

    const theirs = await signIn(f, 'partner', 'reset-by-owner');
    const hostRow = (roster.json() as Array<{ id: string; hostOwner: boolean }>).find((a) => a.hostOwner)!;
    const attack = await f.inject({
      method: 'POST', url: `/v1/local-accounts/${hostRow.id}/password`, headers: { cookie: cookieOf(theirs) },
      payload: { password: 'owned-by-them' },
    });
    expect(attack.statusCode).toBe(403);
  });

  it('never removes the host owner, and keeps an account that still has agents', async () => {
    const { f, store } = await app();
    const first = await bootstrap(f);
    const cookie = cookieOf(first);
    await f.inject({ method: 'POST', url: '/v1/local-accounts', headers: { cookie }, payload: { username: 'partner', password: 'their-password' } });
    const roster = (await f.inject({ method: 'GET', url: '/v1/local-accounts', headers: { cookie } })).json() as Array<{ id: string; username: string; hostOwner: boolean }>;
    const host = roster.find((a) => a.hostOwner)!;
    const partner = roster.find((a) => !a.hostOwner)!;
    expect((await f.inject({ method: 'DELETE', url: `/v1/local-accounts/${host.id}`, headers: { cookie } })).statusCode).toBe(400);

    store.insertAgent({
      id: 'a1', ownerId: partner.id, name: 'Theirs', slug: 'theirs', state: 'RUNNING',
      aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now',
    });
    const busy = await f.inject({ method: 'DELETE', url: `/v1/local-accounts/${partner.id}`, headers: { cookie } });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toMatch(/still has 1 agent/);

    store.setAgentState('a1', 'STOPPED');
    store.setAgentState('a1', 'DELETING');
    store.setAgentState('a1', 'DELETED');
    expect((await f.inject({ method: 'DELETE', url: `/v1/local-accounts/${partner.id}`, headers: { cookie } })).statusCode).toBe(200);
    expect(store.countLocalAccounts()).toBe(1);
  });
});

describe('where the server listens', () => {
  // The bind decision used to read HATCHABOT_PASSWORD alone, which accounts
  // mode ignores: an accounts install that dropped the password line bound
  // loopback only and logged "auth is disabled" — both wrong.
  it('binds beyond loopback whenever auth is actually on', () => {
    expect(bindHostFor({} as NodeJS.ProcessEnv, 'password')).toBe('127.0.0.1');
    expect(bindHostFor({ HATCHABOT_PASSWORD: 'x' } as NodeJS.ProcessEnv, 'password')).toBe('0.0.0.0');
    expect(bindHostFor({} as NodeJS.ProcessEnv, 'accounts')).toBe('0.0.0.0');
    expect(bindHostFor({} as NodeJS.ProcessEnv, 'identity')).toBe('0.0.0.0');
    expect(authIsEnabled('accounts', undefined)).toBe(true);
    expect(authIsEnabled('password', undefined)).toBe(false);
  });

  it('always honours an explicit HATCHABOT_BIND', () => {
    expect(bindHostFor({ HATCHABOT_BIND: '127.0.0.1' } as NodeJS.ProcessEnv, 'accounts')).toBe('127.0.0.1');
    expect(bindHostFor({ HATCHABOT_BIND: '100.64.0.2', HATCHABOT_PASSWORD: 'x' } as NodeJS.ProcessEnv, 'password')).toBe('100.64.0.2');
  });
});

describe('the whole server boots in accounts mode', () => {
  // The first accounts build crashed on startup: registerAccountRoutes claimed
  // GET /v1/accounts, which routes.ts has served for months (share
  // recipients), and Fastify refuses a duplicate route at registration. The
  // unit tests above register auth ALONE, so nothing caught it until a real
  // install died on boot. This boots both halves together, as index.ts does.
  it('registers auth and every route together without a collision', async () => {
    const { registerRoutes } = await import('../src/api/routes.js');
    const { MockProvider } = await import('../src/providers/mockProvider.js');
    const store = new Store(new Database(':memory:'));
    const f = Fastify();
    const secrets = {
      map: new Map<string, string>(),
      async put(ref: string, v: string) { this.map.set(ref, v); },
      async get(ref: string) { const v = this.map.get(ref); if (v === undefined) throw new Error(ref); return v; },
      async delete(ref: string) { this.map.delete(ref); },
    };
    await registerAuth(f, { secret: SECRET, mode: 'accounts', store });
    await registerRoutes(f, {
      store,
      secrets: secrets as never,
      providers: new Map([['mock', new MockProvider()]]),
      channel: { pool: { availableCount: () => 0 } } as never,
      authMode: 'accounts',
    });
    await f.ready(); // the boot that used to throw FST_ERR_DUPLICATED_ROUTE

    // And the two namespaces stay distinct: the roster is the new one.
    const made = await f.inject({
      method: 'POST', url: '/v1/local-accounts/bootstrap', payload: { username: 'chris', password: 'correct-horse' },
    });
    expect(made.statusCode).toBe(201);
    const cookie = cookieOf(made);
    expect((await f.inject({ method: 'GET', url: '/v1/local-accounts', headers: { cookie } })).statusCode).toBe(200);
    // …while /v1/accounts still answers with share recipients.
    const share = await f.inject({ method: 'GET', url: '/v1/accounts', headers: { cookie } });
    expect(share.statusCode).toBe(200);
    expect(share.json()).toHaveProperty('accounts');
    // The login screen must be told setup is done, or it offers bootstrap forever.
    const cfg = await f.inject({ method: 'GET', url: '/v1/config' });
    expect(cfg.json()).toMatchObject({ authMode: 'accounts', needsSetup: false });
  });
});

describe('recovery when nobody can sign in', () => {
  // No email means no "forgot password" link, so a forgotten host-owner
  // password would be an unrecoverable lockout. Write access to the database
  // is the proof of ownership instead — the same trust as editing .env.
  it('a password set directly on the store lets that account back in', async () => {
    const store = new Store(new Database(':memory:'));
    const { f } = await app(store);
    const made = await f.inject({
      method: 'POST', url: '/v1/local-accounts/bootstrap', payload: { username: 'chris', password: 'forgotten-one' },
    });
    expect(made.statusCode).toBe(201);

    // What `hatchabot accounts reset-password` does, without the process boundary.
    const account = store.localAccountByUsername('chris')!;
    const { hash, salt } = await hashPassword('recovered-password');
    store.setLocalAccountPassword(account.id, hash, salt);

    expect((await signIn(f, 'chris', 'recovered-password')).statusCode).toBe(200);
    expect((await signIn(f, 'chris', 'forgotten-one')).statusCode).toBe(401);
    // And the reset killed the session minted before it.
    expect((await f.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie: cookieOf(made) } })).statusCode).toBe(401);
  });

  it('usernames are looked up case-insensitively by the recovery path too', async () => {
    const store = new Store(new Database(':memory:'));
    const { f } = await app(store);
    await f.inject({ method: 'POST', url: '/v1/local-accounts/bootstrap', payload: { username: 'Chris', password: 'first-password' } });
    expect(store.localAccountByUsername('chris')?.username).toBe('Chris');
  });
});
