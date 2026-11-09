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
  store.insertAgent({ id: 'lunch', ownerId: OWNER, name: 'Lunch Picker', slug: 'lunch-picker', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, webOnly: false, createdAt: 'now', updatedAt: 'now' } as never);
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

  // Eleventh review of fix/r3-cli: the post sent again (a proxy lost the
  // first answer) is answered as the first only where it was this answer.
  it('sent again: 202 for an agent whose step was answered so, 409 for one made web-only that never waited', async () => {
    const b = await box();
    b.store.insertAgent({ id: 'never', ownerId: OWNER, name: 'Recipe Box', slug: 'recipe-box', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    const skip = (id: string) => b.f.inject({ method: 'POST', url: `/v1/agents/${id}/channel-token`, headers: H, payload: { webOnly: true } });
    const never = await skip('never');
    expect(never.statusCode).toBe(409);
    expect(never.json().error).toMatch(/not waiting for a bot token/);
    expect((await skip('lunch')).statusCode).toBe(202);
    b.store.setAgentPendingAction('lunch', null); // setup took the answer
    const again = await skip('lunch');
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual({ webOnly: true });
  });
});
