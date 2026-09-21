import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';

/**
 * Revealing a bot's token from the inventory: the one place that can show a
 * spare's or an orphaned token's, which have no agent to reveal them from.
 */
async function world(hostOwner: boolean) {
  const store = new Store(new Database(':memory:'));
  const secrets = new Map<string, string>([
    ['chan/a1', '111:agent-token'],
    ['pool/sparebot', '222:spare-token'],
    ['telegram/bot/orphanbot', '333:orphan-token'],
  ]);
  store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
  store.insertAgent({
    id: 'a1', ownerId: 'o', name: 'Tax', slug: 'tax', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
    persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
  } as never);
  store.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'TaxBot', secretRef: 'chan/a1', deepLink: 'x', createdAt: 'now' } as never);
  // The orphan exists only as a stored secret, which is how the inventory finds it.
  (store as unknown as { listSecretRefs: (p: string) => string[] }).listSecretRefs = (pat: string) =>
    pat.startsWith('telegram/bot/') ? ['telegram/bot/orphanbot'] : [];
  const f = Fastify();
  await registerRoutes(f, {
    store,
    secrets: { put: async () => {}, get: async (r: string) => { const v = secrets.get(r); if (!v) throw new Error('missing'); return v; }, delete: async () => {} } as never,
    providers: new Map([['mock', new MockProvider()]]),
    channel: { kind: 'telegram', pool: { owns: () => true, availableCount: () => 1, list: () => [{ username: 'sparebot', secretRef: 'pool/sparebot' }] } } as never,
    ...(hostOwner ? {} : { ownsLocalHost: () => false }),
  } as never);
  return f;
}

describe('revealing a bot token from the inventory', () => {
  it('shows an agent’s, a spare’s and an orphaned token — one at a time', async () => {
    const f = await world(true);
    const get = (u: string) => f.inject({ method: 'GET', url: `/v1/bots/${u}/token`, headers: { 'x-hatchabot-owner': 'o' } });
    expect((await get('taxbot')).json()).toMatchObject({ where: 'agent', token: '111:agent-token' });
    expect((await get('@SpareBot')).json()).toMatchObject({ where: 'pool-free', token: '222:spare-token' });
    expect((await get('orphanbot')).json()).toMatchObject({ where: 'orphan-token', token: '333:orphan-token' });
    expect((await get('nobodysbot')).statusCode).toBe(404);
  });
});
