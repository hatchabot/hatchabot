import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { _resetLoginThrottle } from '../src/api/auth.js';
import { installErrorHandler } from '../src/api/errorHandler.js';
import { InvalidBotTokenError, TelegramUnavailableError } from '../src/channels/telegramManual.js';

/**
 * The review of the HB-0552 fix: a token check that Telegram did not answer
 * still counted as a wrong token in the login throttle when adding a bot to
 * the pool, and the routes that let the error through answered 500. Now:
 * 503, "try again", and no strike against the person.
 */

const OWNER = 'o';
const H = { 'x-hatchabot-owner': OWNER };
const TOKEN = '123456:made-up-token-for-the-test';
class MemSecrets {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) { const v = this.map.get(ref); if (v === undefined) throw new Error('missing'); return v; }
  async delete(ref: string) { this.map.delete(ref); }
}

async function box(submitToken: () => Promise<{ username: string }>) {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
  const f = Fastify();
  installErrorHandler(f);
  await registerRoutes(f, {
    store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]),
    channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 }, submitToken, discardPending: () => {}, release: async () => {} },
  } as never);
  const agent = (id: string, extra: Record<string, unknown> = {}) => store.insertAgent({
    id, ownerId: OWNER, name: id, slug: id, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: `docker://${id}`,
    persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now', ...extra,
  } as never);
  return { store, f, agent };
}

const outage = () => { throw new TelegramUnavailableError('made-up outage'); };
const proxyPage = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
  new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));

beforeEach(() => _resetLoginThrottle());
afterEach(() => { vi.restoreAllMocks(); _resetLoginThrottle(); });

describe('Telegram not answering a token check: 503 and try again, no strike', () => {
  it('adding a bot to the pool', async () => {
    const { f } = await box(async () => outage());
    proxyPage();
    for (let i = 0; i < 12; i++) {
      const r = await f.inject({ method: 'POST', url: '/v1/pool', headers: H, payload: { token: TOKEN } });
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toMatch(/Try again/);
    }
  });

  it('pasting a token for an agent waiting for one, checked here or by the channel', async () => {
    const { store, f, agent } = await box(async () => outage());
    agent('park', { state: 'PROVISIONING', runtimeRef: undefined });
    store.setAgentPendingAction('park', { type: 'bot_token' } as never);
    proxyPage();
    const first = await f.inject({ method: 'POST', url: '/v1/agents/park/channel-token', headers: H, payload: { token: TOKEN } });
    expect(first.statusCode).toBe(503);
    expect(first.json().error).toMatch(/Try again/);
    vi.restoreAllMocks();
    // The route's own check passes; the channel's check is the one Telegram misses.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: true, result: { username: 'made_up_bot' } })));
    const second = await f.inject({ method: 'POST', url: '/v1/agents/park/channel-token', headers: H, payload: { token: TOKEN } });
    expect(second.statusCode).toBe(503);
    expect(second.json().error).toMatch(/Try again/);
  });

  it('adding a bot to a web-only agent', async () => {
    const { f, agent } = await box(async () => outage());
    agent('lunch', { state: 'RUNNING' });
    proxyPage(); // the route's own check, before the token is held (twelfth review of fix/r3-cli)
    for (let i = 0; i < 12; i++) {
      const r = await f.inject({ method: 'POST', url: '/v1/agents/lunch/telegram', headers: H, payload: { token: TOKEN } });
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toMatch(/Try again/);
    }
  });

  // The third review: the pool route sent the internal text ("Invalid Telegram bot token: …").
  it('a wrong token added to the pool gets the same words as everywhere else', async () => {
    const { f } = await box(async () => outage());
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const r = await f.inject({ method: 'POST', url: '/v1/pool', headers: H, payload: { token: TOKEN } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe(new InvalidBotTokenError('made up').userMessage);
  });
});
