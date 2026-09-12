import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { authModeFromEnv, registerAuth } from '../src/api/auth.js';
import { LOCAL_OWNER, ownerIdOf, principalOf } from '../src/api/principal.js';
import { registerRoutes } from '../src/api/routes.js';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

const SECRET = Buffer.alloc(32, 7);

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) {
    const v = this.map.get(ref);
    if (v === undefined) throw new Error(`no secret ${ref}`);
    return v;
  }
  async delete(ref: string) { this.map.delete(ref); }
}

async function appWith(password: string | undefined) {
  const app = Fastify();
  await registerAuth(app, { password, secret: SECRET, mode: 'password' });
  app.get('/v1/whoami', async (req) => principalOf(req));
  return app;
}

const loginCookie = async (app: any, password: string) => {
  const res = await app.inject({
    method: 'POST', url: '/v1/login',
    payload: { password },
  });
  return res.cookies[0]?.value ? `hatchabot_session=${res.cookies[0].value}` : '';
};

describe('auth mode switch', () => {
  it('defaults to password mode and rejects unknown values', () => {
    expect(authModeFromEnv({} as NodeJS.ProcessEnv)).toBe('password');
    expect(authModeFromEnv({ HATCHABOT_AUTH: 'identity' } as any)).toBe('identity');
    expect(() => authModeFromEnv({ HATCHABOT_AUTH: 'nope' } as any)).toThrow(/password.*identity/i);
  });

  it('refuses to boot in identity mode without a configured project', async () => {
    const app = Fastify();
    const saved = process.env.HATCHABOT_GCP_PROJECT;
    delete process.env.HATCHABOT_GCP_PROJECT;
    await expect(
      registerAuth(app, { password: 'pw', secret: SECRET, mode: 'identity' }),
    ).rejects.toThrow(/HATCHABOT_GCP_PROJECT/);
    if (saved) process.env.HATCHABOT_GCP_PROJECT = saved;
  });
});

describe('password sessions', () => {
  it('rejects without a session and accepts with one, as the local owner', async () => {
    const app = await appWith('correct-horse');
    expect((await app.inject({ method: 'GET', url: '/v1/whoami' })).statusCode).toBe(401);

    const cookie = await loginCookie(app, 'correct-horse');
    const ok = await app.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ownerId: LOCAL_OWNER, via: 'password' });
  });

  it('rejects a wrong password', async () => {
    const app = await appWith('correct-horse');
    const res = await app.inject({ method: 'POST', url: '/v1/login', payload: { password: 'nope' } });
    expect(res.statusCode).toBe(401);
  });

  it('invalidates existing sessions when the password is rotated', async () => {
    const before = await appWith('old-password');
    const cookie = await loginCookie(before, 'old-password');
    expect((await before.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie } })).statusCode).toBe(200);

    // same secret key, new password — the old cookie must not survive
    const after = await appWith('new-password');
    expect((await after.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie } })).statusCode).toBe(401);
  });

  it('signs out: the cookie is cleared and works without a live session', async () => {
    const app = await appWith('correct-horse');
    const cookie = await loginCookie(app, 'correct-horse');
    expect(
      (await app.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie } })).statusCode,
    ).toBe(200);

    const out = await app.inject({ method: 'POST', url: '/v1/logout', headers: { cookie } });
    expect(out.statusCode).toBe(200);
    // The clear arrives as a set-cookie that empties/expires the session.
    const cleared = out.cookies.find((c: any) => c.name === 'hatchabot_session');
    expect(cleared?.value).toBe('');

    // Logging out while already logged out must succeed too — a stale tab's
    // button press is not an error.
    expect((await app.inject({ method: 'POST', url: '/v1/logout' })).statusCode).toBe(200);
  });

  it('leaves the invitee join surface unauthenticated', async () => {
    const app = await appWith('pw');
    app.get('/v1/invites/:code', async () => ({ valid: false }));
    expect((await app.inject({ method: 'GET', url: '/v1/invites/ABC' })).statusCode).toBe(200);
  });
});

describe('CLI tokens', () => {
  it('authenticate in password mode and are rejected when unknown', async () => {
    const store = new Store(new Database(':memory:'));
    const { token } = store.createCliToken('user-abc', 'laptop');
    const app = Fastify();
    await registerAuth(app, {
      password: 'pw', secret: SECRET, mode: 'password',
      cliTokenOwner: (t) => store.ownerForCliToken(t),
    });
    app.get('/v1/whoami', async (req) => principalOf(req));

    const ok = await app.inject({
      method: 'GET', url: '/v1/whoami', headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().ownerId).toBe('user-abc');

    const bad = await app.inject({
      method: 'GET', url: '/v1/whoami', headers: { authorization: 'Bearer hatchabot_nope' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('are stored hashed and stop working once revoked', () => {
    const store = new Store(new Database(':memory:'));
    const { id, token } = store.createCliToken('user-abc', 'laptop');
    const row: any = (store as any).db
      .prepare('SELECT token_hash FROM cli_tokens WHERE id = ?').get(id);
    expect(row.token_hash).not.toContain(token); // never stored in the clear
    expect(store.ownerForCliToken(token)).toBe('user-abc');
    expect(store.revokeCliToken('user-abc', id)).toBe(true);
    expect(store.ownerForCliToken(token)).toBeUndefined();
  });

  it("cannot be revoked by a different owner", () => {
    const store = new Store(new Database(':memory:'));
    const { id } = store.createCliToken('user-abc', 'laptop');
    expect(store.revokeCliToken('user-someone-else', id)).toBe(false);
  });
});

describe('principalOf', () => {
  it('honours the legacy owner header when no session principal is set', () => {
    const req = { headers: { 'x-hatchabot-owner': 'someone-else' } } as any;
    expect(ownerIdOf(req)).toBe('someone-else');
    expect(principalOf(req).via).toBe('header');
  });

  it('falls back to the local owner', () => {
    expect(ownerIdOf({ headers: {} } as any)).toBe(LOCAL_OWNER);
  });
});

describe('owner scoping on by-id routes', () => {
  it("hides another owner's agent from every by-id route", async () => {
    const store = new Store(new Database(':memory:'));
    store.insertAgent({
      id: 'a1', ownerId: 'owner-a', name: 'Theirs', slug: 'theirs', state: 'RUNNING',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false,
      createdAt: 'now', updatedAt: 'now',
    });
    const app = Fastify();
    await registerRoutes(app, {
      store,
      secrets: new MemSecrets(),
      providers: new Map([['mock', new MockProvider()]]),
      channel: { pool: { availableCount: () => 0 } } as any,
    });

    const asOther = { 'x-hatchabot-owner': 'owner-b' };
    for (const url of ['/v1/agents/a1', '/v1/agents/a1/logs', '/v1/agents/a1/members', '/v1/agents/a1/bot-token', '/v1/agents/a1/export']) {
      const res = await app.inject({ method: 'GET', url, headers: asOther });
      expect(res.statusCode, url).toBe(404);
    }
    const del = await app.inject({ method: 'DELETE', url: '/v1/agents/a1', headers: asOther });
    expect(del.statusCode).toBe(404);
    // and the rightful owner still sees it
    const mine = await app.inject({ method: 'GET', url: '/v1/agents/a1', headers: { 'x-hatchabot-owner': 'owner-a' } });
    expect(mine.statusCode).toBe(200);
  });
});

describe('agent-to-agent /message auth exemption (audit 2026-09-11)', () => {
  // Exempt paths fall through to the router (404: appWith registers no agent
  // routes); everything else is stopped by the password gate (401).
  it('exempts exactly /v1/agents/<id>/message and nothing adjacent', async () => {
    const app = await appWith('pw');
    const status = async (url: string) => (await app.inject({ method: 'POST', url, payload: {} })).statusCode;
    expect(await status('/v1/agents/abc/message')).toBe(404);          // exempt → router
    expect(await status('/v1/agents/abc/message?x=1')).toBe(404);      // query ignored
    expect(await status('/v1/agents/abc/messages')).toBe(401);
    expect(await status('/v1/agents/abc/message/extra')).toBe(401);
    expect(await status('/v1/agents/abc/model')).toBe(401);
    expect(await status('/v1/agents/a/b/message')).toBe(401);          // [^/]+ can't span segments
    expect(await status('/v1/agents/abc/message/')).toBe(401);         // trailing slash: not exempt
  });
});
