/**
 * A cheaper-model budget and a pause budget reached in the same pass (deep
 * audit of v2.166.2, #010): the pause judged the agent as the pass first read
 * it, missed the cheaper model the other budget had just set, and its record
 * replaced the one remembering the agent's own model. The agent came back on
 * the cheaper model for good. Either order of the two budgets.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { MACHINE, runBudgets, type BudgetDeps } from '../src/orchestrator/budgets.js';

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const NOW = Date.parse('2026-10-20T12:00:00Z');
const NEXT_MONTH = Date.parse('2026-11-01T00:05:00Z');
const iso = (n: number) => new Date(n).toISOString();

function world(ownModel: string | undefined) {
  const db = new Database(':memory:'); dbs.push(db);
  const store = new Store(db);
  store.insertHost({ id: 'h1', ownerId: 'owner-household', kind: 'local', provider: 'mock', name: 'Family box', settings: {}, createdAt: iso(NOW) });
  store.insertAIProfile({ id: 'p1', ownerId: 'owner-household', name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: iso(NOW) });
  const add = (id: string, ops = false) => store.insertAgent({ id, ownerId: 'owner-household', name: id, slug: id, state: 'RUNNING', hostId: 'h1', aiProfileId: 'p1',
    runtimeRef: `mock://${id}`, ...(ownModel ? { model: ownModel } : {}), persona: '', sharedMemory: true, webOnly: true, ops, createdAt: iso(NOW - 86_400_000), updatedAt: iso(NOW) });
  add('manager', true);
  add('meal-planner');
  store.setCostDays('meal-planner', new Map([['2026-10-20', 25]]));
  const restored: Array<string | null> = [];
  const deps: BudgetDeps = {
    store, tz: 'UTC', isBusy: () => false, tell: async () => true,
    pause: async (a) => { if (store.getAgent(a.id)?.state !== 'RUNNING') return false; store.setAgentState(a.id, 'STOPPED'); return true; },
    resume: async (a) => { store.setAgentState(a.id, 'RUNNING'); return true; },
    downgrade: async (a) => { const from = a.model ?? null; store.setAgentModel(a.id, 'claude-haiku-4-5'); return { from, to: 'claude-haiku-4-5' }; },
    restoreModel: async (a, pin) => { restored.push(pin); store.setAgentModel(a.id, pin); return true; },
  };
  return { store, deps, restored };
}

describe('cheaper and pause in one pass', () => {
  it.each([
    ['the agent\'s own cheaper budget, then the machine\'s pause', 'meal-planner', MACHINE, 'claude-opus-4-8'],
    ['the machine\'s cheaper budget, then the agent\'s own pause', MACHINE, 'meal-planner', undefined],
  ] as const)('%s: its own model is put back before the pause, and it starts again on it', async (_what, cheaperScope, pauseScope, ownModel) => {
    const { store, deps, restored } = world(ownModel);
    store.setBudget(cheaperScope, 'owner-household', 20, 'cheaper', iso(NOW));
    store.setBudget(pauseScope, 'owner-household', 20, 'pause', iso(NOW));
    const first = await runBudgets(deps, NOW, { record: false });
    expect(first.paused).toContain('meal-planner');
    expect(restored).toEqual([ownModel ?? null]);
    expect(store.getAgent('meal-planner')).toMatchObject({ state: 'STOPPED' });
    expect(store.getAgent('meal-planner')?.model).toBe(ownModel);
    expect(store.getBudgetPause('meal-planner', '2026-10')?.kind).toBe('pause');
    const next = await runBudgets(deps, NEXT_MONTH, { record: false });
    expect(next.resumed).toContain('meal-planner');
    expect(store.getAgent('meal-planner')?.state).toBe('RUNNING');
    expect(store.getAgent('meal-planner')?.model).toBe(ownModel);
  });
});
