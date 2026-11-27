import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { MACHINE, machineTz, monthKey, monthName, nextMonth } from '../src/orchestrator/usage/budgets.js';

/**
 * An agent's tile and the machine's budget (HB-1315): only a pause marks it
 * paused by the machine's budget. A move to a cheaper model at the machine's
 * limit leaves it running, and its tile said "paused by this Hatchabot's
 * monthly budget" all the same. Such a move is said apart, to the agent's
 * owner (budgetCheaper, HB-1422). Every name and id is made up.
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
  const tile = async (headers: Record<string, string> = as) => ((await f.inject({ method: 'GET', url: '/v1/agents', headers })).json() as Array<{ id: string; budgetPaused?: unknown; budgetCheaper?: unknown; budgetSwitch?: unknown }>).find((a) => a.id === 'g1');
  return { f, store, tile };
}

describe("an agent's tile and the machine's budget (HB-1315)", () => {
  it('a move to a cheaper model by the machine budget is not shown as a pause; a pause is', async () => {
    const { f, store, tile } = await app();
    const month = monthKey(Date.now(), machineTz()), at = new Date().toISOString();
    store.setBudget(MACHINE, OWNER, 40, 'cheaper', at);
    store.addBudgetPause('g1', month, MACHINE, at, { fromModel: null, toModel: 'claude-haiku-4-5' });
    expect(store.getAgent('g1')!.state).toBe('RUNNING');
    expect((await tile())!.budgetPaused).toBeUndefined();
    // The machine's budget pausing it: said on its tile, as before.
    store.setBudget(MACHINE, OWNER, 40, 'pause', at);
    store.addBudgetPause('g1', month, MACHINE, at);
    expect((await tile())!.budgetPaused).toMatchObject({ scope: 'machine', at });
    await f.close();
  });

  it("a move to a cheaper model by the machine's budget is on its owner's tile, with the model and the 1st it ends on (HB-1422)", async () => {
    const { f, store, tile } = await app();
    const month = monthKey(Date.now(), machineTz()), at = new Date().toISOString();
    expect((await tile())!.budgetCheaper).toBeUndefined();
    store.setBudget(MACHINE, OWNER, 40, 'cheaper', at);
    store.setAgentModel('g1', 'claude-haiku-4-5');
    store.addBudgetPause('g1', month, MACHINE, at, { fromModel: null, toModel: 'claude-haiku-4-5' });
    expect((await tile())!.budgetCheaper).toEqual({ scope: 'machine', to: 'claude-haiku-4-5', until: `${monthName(nextMonth(month))} 1` });
    // Not a pause: none is said.
    expect((await tile())!.budgetPaused).toBeUndefined();
    // Its model changed by hand: not said, at once (the next pass closes the switch as the owner's).
    store.setAgentModel('g1', 'claude-opus-4-8');
    expect((await tile())!.budgetCheaper).toBeUndefined();
    store.setAgentModel('g1', 'claude-haiku-4-5');
    // Its own budget's switch is its own budget's line, not this one.
    store.resumeBudgetPause('g1', month, at, 'budget-raised');
    expect((await tile())!.budgetCheaper).toBeUndefined();
    store.setBudget('g1', OWNER, 10, 'cheaper', at);
    store.addBudgetPause('g1', month, 'g1', at, { fromModel: null, toModel: 'claude-haiku-4-5' });
    expect((await tile())!.budgetCheaper).toBeUndefined();
    // Someone who is not its owner is not told (they see no tile of it, or a member's).
    store.addBudgetPause('g1', month, MACHINE, at, { fromModel: null, toModel: 'claude-haiku-4-5' });
    expect((await tile({ 'x-hatchabot-owner': 'someone-else' }))?.budgetCheaper).toBeUndefined();
    // The cheaper model is its class's own, which stays: no day it switches back on (HB-1477 review).
    store.addBudgetPause('g1', month, MACHINE, at, { fromModel: 'claude-haiku-4-5', toModel: 'claude-haiku-4-5' });
    expect((await tile())!.budgetCheaper).toEqual({ scope: 'machine', to: 'claude-haiku-4-5', classModel: true });
    await f.close();
  });

  it("a budget's switch to a cheaper model names the model a download or a move carries instead (HB-1299)", async () => {
    const { f, store, tile } = await app();
    const month = monthKey(Date.now(), machineTz()), at = new Date().toISOString();
    expect((await tile())!.budgetSwitch).toBeUndefined();
    // Its own budget's switch from its source's default: a copy runs the default of its source there, no model named (HB-1299 review).
    store.setBudget('g1', OWNER, 10, 'cheaper', at);
    store.setAgentModel('g1', 'claude-haiku-4-5');
    store.addBudgetPause('g1', month, 'g1', at, { fromModel: null, toModel: 'claude-haiku-4-5' });
    expect((await tile())!.budgetSwitch).toEqual({ to: 'claude-haiku-4-5', scope: 'agent' });
    // The machine's switch, from its own pin.
    store.resumeBudgetPause('g1', month, at, 'budget-raised');
    store.addBudgetPause('g1', month, MACHINE, at, { fromModel: 'claude-opus-4-8', toModel: 'claude-haiku-4-5' });
    expect((await tile())!.budgetSwitch).toEqual({ to: 'claude-haiku-4-5', own: 'claude-opus-4-8', scope: 'machine' });
    // Its model changed since: the switch no longer has it, and a copy carries what it runs.
    store.setAgentModel('g1', 'claude-opus-4-8');
    expect((await tile())!.budgetSwitch).toBeUndefined();
    store.setAgentModel('g1', 'claude-haiku-4-5');
    // Not said to anyone but its owner.
    expect((await tile({ 'x-hatchabot-owner': 'someone-else' }))?.budgetSwitch).toBeUndefined();
    await f.close();
  });
});
