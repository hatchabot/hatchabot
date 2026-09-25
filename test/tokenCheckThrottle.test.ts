import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { ConnectorError, type ChannelConnector } from '../src/channels/connector.js';

/**
 * A pasted token is checked with the platform, so the routes that take one
 * were an unthrottled oracle for anyone with an account here. They share the
 * login throttle now: a refused token counts like a wrong password
 * (2026-09-25). Its own file: the counter is module state.
 */
const OWNER = 'o';
const H = { 'x-hatchabot-owner': OWNER };
const connector: ChannelConnector = {
  kind: 'discord', label: 'Discord', hosts: [],
  fields: [{ key: 'token', label: 'Token', pattern: /^ok-/, help: '' }],
  secretValue: (c) => String(c.token), credsFromSecret: (s) => ({ token: s }),
  async verify(c) {
    if (c.token !== 'ok-good') throw new ConnectorError('The platform refused it.');
    return { accountId: '1234567890123456789', displayName: '@Bot', deepLink: 'https://x', settings: {}, warnings: [] };
  },
};

describe('token checks share the login throttle', () => {
  it('after the limit of refused tokens the routes answer 429 until the window passes; a good token before that still works', async () => {
    const prev = process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW; process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW = '2';
    try {
      const store = new Store(new Database(':memory:'));
      store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
      const f = Fastify();
      const secrets = new Map<string, string>();
      await registerRoutes(f, {
        store, secrets: { put: async (r: string, v: string) => { secrets.set(r, v); }, get: async (r: string) => secrets.get(r)!, delete: async () => {} } as never,
        providers: new Map([['mock', new MockProvider()]]),
        channel: { kind: 'telegram', pool: { owns: () => false } } as never,
        connectors: { discord: connector },
      } as never);
      const park = (token: string) => f.inject({ method: 'POST', url: '/v1/discord-bots', headers: H, payload: { token } });
      expect((await park('ok-bad')).statusCode).toBe(400);
      expect((await park('ok-worse')).statusCode).toBe(400);
      const third = await park('ok-good');
      expect(third.statusCode).toBe(429);
      expect(third.json().error).toContain('Too many token checks');
      // The other token-taking routes are behind the same counter.
      store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' });
      store.insertAgent({ id: 'ag', ownerId: OWNER, name: 'A', slug: 'ag', state: 'STOPPED', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'mock://ag', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
      expect((await f.inject({ method: 'POST', url: '/v1/agents/ag/channels/discord', headers: H, payload: { token: 'ok-good' } })).statusCode).toBe(429);
      expect((await f.inject({ method: 'POST', url: '/v1/pool', headers: H, payload: { token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi' } })).statusCode).toBe(429);
    } finally { if (prev === undefined) delete process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW; else process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW = prev; }
  });
});
