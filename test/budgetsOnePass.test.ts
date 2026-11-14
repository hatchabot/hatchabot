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
  return { store, deps, restored, add };
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

describe('agents changed while a machine budget acts (HB-0706)', () => {
  it('defers restoring a model during deletion and retains it for a failed delete', async () => {
    const { store, deps, restored } = world('claude-opus-4-8');
    store.setBudget('meal-planner', 'owner-household', 20, 'cheaper', iso(NOW));
    await runBudgets(deps, NOW, { record: false });
    store.setAgentState('meal-planner', 'DELETING');
    store.setBudget('meal-planner', 'owner-household', null, 'cheaper', iso(NOW));
    await runBudgets(deps, NOW + 60_000, { record: false });
    expect(restored).toEqual([]);
    expect(store.getBudgetPause('meal-planner', '2026-10')?.resumedAt).toBeUndefined();
    store.setAgentState('meal-planner', 'FAILED');
    await runBudgets(deps, NOW + 120_000, { record: false });
    expect(restored).toEqual(['claude-opus-4-8']);
    expect(store.getAgent('meal-planner')?.model).toBe('claude-opus-4-8');
  });

  it.each(['model', 'ARCHIVED', 'DELETING', 'DELETED'] as const)('rechecks the next agent after an earlier switch waits: %s', async (change) => {
    const { store, deps, add } = world('claude-opus-4-8');
    add('garden-notes');
    store.setBudget(MACHINE, 'owner-household', 20, 'cheaper', iso(NOW));
    let began!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const switched: string[] = [];
    deps.downgrade = async (a, hold) => {
      if (switched.length === 0) { began(); await waiting; }
      switched.push(a.id);
      const from = a.model ?? null;
      store.setAgentModel(a.id, 'claude-haiku-4-5');
      hold(from, 'claude-haiku-4-5');
      return { from, to: 'claude-haiku-4-5' };
    };
    // The machine's list order is deliberately obtained from the same source
    // as the pass; whichever agent waits first, the other can change meanwhile.
    const ids = store.listAllActiveAgents().filter((a) => !a.ops).map((a) => a.id);
    const next = ids[1]!;
    const pass = runBudgets(deps, NOW, { record: false });
    await started;
    if (change === 'model') store.setAgentModel(next, 'claude-sonnet-5');
    else {
      if (change === 'DELETED') store.setAgentState(next, 'DELETING');
      store.setAgentState(next, change);
    }
    release();
    await pass;
    if (change === 'model') {
      expect(store.getBudgetPause(next, '2026-10')?.fromModel).toBe('claude-sonnet-5');
      await runBudgets(deps, NEXT_MONTH, { record: false });
      expect(store.getAgent(next)?.model).toBe('claude-sonnet-5');
    } else {
      expect(switched).not.toContain(next);
      expect(store.getBudgetPause(next, '2026-10')).toBeUndefined();
      expect(store.getAgent(next)?.model).toBe('claude-opus-4-8');
    }
  });
});
