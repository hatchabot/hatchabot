import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';

/**
 * The pool is empty and there is no spare token: an agent parked on "paste a
 * bot token" can go on without Telegram (web-only), and only then.
 */
const OWNER = 'o';
const H = { 'x-hatchabot-owner': OWNER };

async function box() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
  store.insertAgent({ id: 'lunch', ownerId: OWNER, name: 'Lunch Agent', slug: 'lunch-agent', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, webOnly: false, createdAt: 'now', updatedAt: 'now' } as never);
  store.setAgentPendingAction('lunch', { type: 'bot_token', instructions: 'paste it' } as never);
  const f = Fastify();
  await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', new MockProvider()]]), channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } } } as never);
  return { store, f };
}

describe('continuing without Telegram', () => {
  it('a parked agent becomes web-only and provisioning resumes', async () => {
    const b = await box();
    const r = await b.f.inject({ method: 'POST', url: '/v1/agents/lunch/channel-token', headers: H, payload: { webOnly: true } });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ webOnly: true });
    const a = b.store.getAgent('lunch')!;
    expect(a.webOnly).toBe(true);
    expect(a.pendingAction).toBeUndefined();
  });

  it('only while it is waiting for a token; only its owner', async () => {
    const b = await box();
    expect((await b.f.inject({ method: 'POST', url: '/v1/agents/lunch/channel-token', headers: { 'x-hatchabot-owner': 'other' }, payload: { webOnly: true } })).statusCode).toBe(404);
    b.store.setAgentPendingAction('lunch', null);
    expect((await b.f.inject({ method: 'POST', url: '/v1/agents/lunch/channel-token', headers: H, payload: { webOnly: true } })).statusCode).toBe(409);
  });
});
