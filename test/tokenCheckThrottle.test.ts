import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { _resetLoginThrottle } from '../src/api/auth.js';
import { ConnectorError, type ChannelConnector } from '../src/channels/connector.js';
import { discordConnector } from '../src/channels/discord.js';

/**
 * A pasted token is checked with the platform, so the routes that take one
 * were an unthrottled oracle for anyone with an account here. They share the
 * login throttle now: a refused token counts like a wrong password
 * (2026-09-25). Its own file: the counter is module state.
 */
const OWNER = 'o';
const H = { 'x-hatchabot-owner': OWNER };
const connector: ChannelConnector = {
  kind: 'discord', label: 'Discord',
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

  it('parking a bot while the platform is busy does not count against the allowance; a refused token still does (HB-0993)', async () => {
    const prev = process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW; process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW = '2';
    _resetLoginThrottle();
    try {
      const store = new Store(new Database(':memory:'));
      store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
      let busy = true;
      const f = Fastify();
      await registerRoutes(f, {
        store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} } as never,
        providers: new Map([['mock', new MockProvider()]]),
        channel: { kind: 'telegram', pool: { owns: () => false } } as never,
        connectors: {
          discord: {
            ...connector,
            async verify(c: Record<string, string>) {
              if (busy) throw new ConnectorError('Discord is busy right now (503) — try again in a minute.', true);
              return connector.verify(c);
            },
          },
        },
      } as never);
      const park = (token: string) => f.inject({ method: 'POST', url: '/v1/discord-bots', headers: H, payload: { token } });
      for (let i = 0; i < 4; i++) expect((await park('ok-good')).statusCode).toBe(400);
      busy = false;
      // The platform is back: the good token is asked about, not refused unasked.
      const after = await park('ok-good');
      expect(after.statusCode, after.body).toBe(200);
      expect(after.json().bot.applicationId).toBe('1234567890123456789');
      // Refused tokens still count, on this route as on the others.
      expect((await park('ok-bad')).statusCode).toBe(400);
      expect((await park('ok-worse')).statusCode).toBe(400);
      expect((await park('ok-good')).statusCode).toBe(429);
    } finally {
      _resetLoginThrottle();
      if (prev === undefined) delete process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW; else process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW = prev;
    }
  });

  it('a machine that cannot reach the platform does not count against the allowance either (HB-1155)', async () => {
    const prev = process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW; process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW = '2';
    _resetLoginThrottle();
    try {
      const store = new Store(new Database(':memory:'));
      store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
      // The real Discord connector, over a link that is down and then back.
      let down = true;
      const reach = async (url: string) => {
        if (down) throw new TypeError('fetch failed');
        const body = url.endsWith('/users/@me') ? { id: '999000999000999000', username: 'budgetbot', bot: true }
          : url.endsWith('/applications/@me') ? { id: '1234567890123456789', name: 'Budget Tracker', flags: 1 << 19 }
          : [];
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const f = Fastify();
      await registerRoutes(f, {
        store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} } as never,
        providers: new Map([['mock', new MockProvider()]]),
        channel: { kind: 'telegram', pool: { owns: () => false } } as never,
        connectors: { discord: discordConnector(reach as never) },
      } as never);
      // Made up, in the shape the connector checks first.
      const token = 'TESTtestTESTtestTESTtest.test00.not-a-real-token-not-a-real';
      const park = () => f.inject({ method: 'POST', url: '/v1/discord-bots', headers: H, payload: { token } });
      for (let i = 0; i < 4; i++) {
        const r = await park();
        expect(r.statusCode).toBe(400);
        expect(r.json().error).toMatch(/Couldn't reach Discord/);
      }
      down = false;
      const after = await park();
      expect(after.statusCode, after.body).toBe(200);
    } finally {
      _resetLoginThrottle();
      if (prev === undefined) delete process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW; else process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW = prev;
    }
  });

  it('Slack rate-limiting or down does not count against the allowance either, and says it was not checked (HB-1262)', async () => {
    const prev = process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW; process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW = '2';
    _resetLoginThrottle();
    try {
      const store = new Store(new Database(':memory:'));
      store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
      // The real Slack connector: a 429, then an outage page, then Slack back.
      let answer: 'limit' | 'down' | 'up' = 'limit';
      const reach = async (url: string) => {
        if (answer === 'limit') return new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), { status: 429, headers: { 'retry-after': '30' } });
        if (answer === 'down') return new Response('<html>made-up outage page</html>', { status: 503, headers: { 'content-type': 'text/html' } });
        const body = url.endsWith('/auth.test') ? { ok: true, team: 'Example Household', team_id: 'T01', user: 'budget_tracker', user_id: 'U0BOT', bot_id: 'B01' }
          : url.includes('/bots.info') ? { ok: true, bot: { app_id: 'A0APPID123' } }
          : url.endsWith('/apps.connections.open') ? { ok: true, url: 'wss://made-up' }
          : { ok: false, error: 'missing_scope' };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const { slackConnector } = await import('../src/channels/slack.js');
      const f = Fastify();
      await registerRoutes(f, {
        store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} } as never,
        providers: new Map([['mock', new MockProvider()]]),
        channel: { kind: 'telegram', pool: { owns: () => false } } as never,
        connectors: { slack: slackConnector(reach as never) },
      } as never);
      // Made up, in the shapes the connector checks first.
      const park = () => f.inject({ method: 'POST', url: '/v1/slack-apps', headers: H, payload: { botToken: 'xoxb-test-not-a-real-token-0000', appToken: 'xapp-1-A0APPID123-test-not-a-real-token' } });
      for (const state of ['limit', 'down'] as const) {
        answer = state;
        for (let i = 0; i < 3; i++) {
          const r = await park();
          expect(r.statusCode).toBe(400);
          expect(r.json().error).toMatch(/^Slack did not answer properly just now \((too many requests|HTTP 503)\), so the bot token was not checked\. Try again in a minute\.$/);
        }
      }
      answer = 'up';
      const after = await park();
      expect(after.statusCode, after.body).toBe(200);
    } finally {
      _resetLoginThrottle();
      if (prev === undefined) delete process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW; else process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW = prev;
    }
  });
});
