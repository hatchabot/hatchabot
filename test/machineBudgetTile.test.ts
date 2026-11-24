import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { MACHINE, machineTz, monthKey } from '../src/orchestrator/usage/budgets.js';

/**
 * An agent's tile and the machine's budget (HB-1315): only a pause marks it
 * paused by the machine's budget. A move to a cheaper model at the machine's
 * limit leaves it running, and its tile said "paused by this Hatchabot's
 * monthly budget" all the same. Every name and id is made up.
 */

const OWNER = 'owner-tile';
const as = { 'x-hatchabot-owner': OWNER };

async function app() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'API key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', models: ['claude-opus-4-8', 'claude-haiku-4-5'], secretRef: 'ai/key', createdAt: 'now' } as never);
  const { runtimeRef } = await provider.provision({ agentId: 'g1', slug: 'g1', workspace: { files: {}, configPatch: { agentId: 'g1', authMode: 'api-key' } }, env: {} } as never);
  await provider.start(runtimeRef);
  store.insertAgent({ id: 'g1', ownerId: OWNER, name: 'Garden Notes', slug: 'g1', state: 'RUNNING', runtimeRef, aiProfileId: 'key', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: '2026-08-01T00:00:00Z', updatedAt: 'now' } as never);
  const f = Fastify();
  await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } } as never } as never);
  const tile = async () => ((await f.inject({ method: 'GET', url: '/v1/agents', headers: as })).json() as Array<{ id: string; budgetPaused?: unknown }>).find((a) => a.id === 'g1')!;
  return { f, store, tile };
}

describe("an agent's tile and the machine's budget (HB-1315)", () => {
  it('a move to a cheaper model by the machine budget is not shown as a pause; a pause is', async () => {
    const { f, store, tile } = await app();
    const month = monthKey(Date.now(), machineTz()), at = new Date().toISOString();
    store.setBudget(MACHINE, OWNER, 40, 'cheaper', at);
    store.addBudgetPause('g1', month, MACHINE, at, { fromModel: null, toModel: 'claude-haiku-4-5' });
    expect(store.getAgent('g1')!.state).toBe('RUNNING');
    expect((await tile()).budgetPaused).toBeUndefined();
    // The machine's budget pausing it: said on its tile, as before.
    store.setBudget(MACHINE, OWNER, 40, 'pause', at);
    store.addBudgetPause('g1', month, MACHINE, at);
    expect((await tile()).budgetPaused).toMatchObject({ scope: 'machine', at });
    await f.close();
  });
});
