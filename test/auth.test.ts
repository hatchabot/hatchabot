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
  return res.cookies[0]?.value ? `agentclaw_session=${res.cookies[0].value}` : '';
};

describe('auth mode switch', () => {
  it('defaults to password mode and rejects unknown values', () => {
    expect(authModeFromEnv({} as NodeJS.ProcessEnv)).toBe('password');
    expect(authModeFromEnv({ AGENTCLAW_AUTH: 'identity' } as any)).toBe('identity');
    expect(() => authModeFromEnv({ AGENTCLAW_AUTH: 'nope' } as any)).toThrow(/password.*identity/i);
  });

  it('refuses to boot in identity mode until the verifier exists', async () => {
    const app = Fastify();
    await expect(
      registerAuth(app, { password: 'pw', secret: SECRET, mode: 'identity' }),
    ).rejects.toThrow(/not implemented/i);
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

  it('leaves the invitee join surface unauthenticated', async () => {
    const app = await appWith('pw');
    app.get('/v1/invites/:code', async () => ({ valid: false }));
    expect((await app.inject({ method: 'GET', url: '/v1/invites/ABC' })).statusCode).toBe(200);
  });
});

describe('principalOf', () => {
  it('honours the legacy owner header when no session principal is set', () => {
    const req = { headers: { 'x-agentclaw-owner': 'someone-else' } } as any;
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

    const asOther = { 'x-agentclaw-owner': 'owner-b' };
    for (const url of ['/v1/agents/a1', '/v1/agents/a1/logs', '/v1/agents/a1/members', '/v1/agents/a1/bot-token', '/v1/agents/a1/export']) {
      const res = await app.inject({ method: 'GET', url, headers: asOther });
      expect(res.statusCode, url).toBe(404);
    }
    const del = await app.inject({ method: 'DELETE', url: '/v1/agents/a1', headers: asOther });
    expect(del.statusCode).toBe(404);
    // and the rightful owner still sees it
    const mine = await app.inject({ method: 'GET', url: '/v1/agents/a1', headers: { 'x-agentclaw-owner': 'owner-a' } });
    expect(mine.statusCode).toBe(200);
  });
});
