import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerAuth, _resetLoginThrottle } from '../src/api/auth.js';
import { registerRoutes } from '../src/api/routes.js';
import { IdentityVerifier } from '../src/api/identity.js';
import { createInvite, checkInvite } from '../src/orchestrator/invite.js';
import { MemSecrets } from './support/world.js';

describe('invites use the same identity admission as sign-in (HB-0689)', () => {
  afterEach(() => { vi.unstubAllEnvs(); _resetLoginThrottle(); });

  for (const webChat of [true, false]) {
    it.each(['unverified email', 'excluded email'])(`preserves a ${webChat ? 'web-chat' : 'chat-app'} invitation for a refused %s`, async (why) => {
      const store = new Store(new Database(':memory:'));
      const provider = new MockProvider();
      store.insertHost({ id: 'h1', ownerId: 'user-owner', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
      store.insertAgent({ id: 'a1', ownerId: 'user-owner', name: 'Garden', slug: 'garden', state: 'STOPPED', hostId: 'h1', aiProfileId: 'p1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
      let emailVerified = why !== 'unverified email';
      vi.stubEnv('HATCHABOT_ALLOWED_EMAILS', why === 'excluded email' ? 'owner@example.com' : '');
      const verifier = { verify: async () => ({ sub: 'guest', email: 'guest@example.com', emailVerified, expMs: Date.now() + 60_000 }) } as unknown as IdentityVerifier;
      const f = Fastify();
      await registerAuth(f, { store, secret: Buffer.alloc(32, 7), mode: 'identity', verifier });
      await registerRoutes(f, { store, authMode: 'identity', verifier, providers: new Map([['mock', provider]]), secrets: new MemSecrets(), channel: { kind: 'telegram', pool: { availableCount: () => 0, list: () => [] }, release: async () => {} } as never });
      const { code } = createInvite(store, 'a1', 'user-owner', undefined, { webChat });
      const session = () => f.inject({ method: 'POST', url: '/v1/session', payload: { idToken: 'synthetic-identity' } });
      const join = () => f.inject({ method: 'POST', url: '/v1/join', payload: { code, name: 'Guest', idToken: 'synthetic-identity' } });
      try {
        const expected = why === 'unverified email' ? 401 : 403;
        expect((await session()).statusCode).toBe(expected);
        const refused = await join();
        expect(refused.statusCode, refused.body).toBe(expected);
        expect(store.getMembership('a1', 'user-guest')).toBeUndefined();
        expect(checkInvite(store, code)).toMatchObject({ valid: true });
        // The same single-use link works once the policy is satisfied.
        emailVerified = true;
        vi.stubEnv('HATCHABOT_ALLOWED_EMAILS', 'OWNER@example.com, GUEST@example.com');
        expect((await session()).statusCode).toBe(200);
        const joined = await join();
        expect(joined.statusCode, joined.body).toBe(201);
        expect(store.getMembership('a1', 'user-guest')).toMatchObject({ webChat });
        expect(checkInvite(store, code)).toEqual({ valid: false, reason: 'used' });
      } finally { await f.close(); }
    });
  }
});
