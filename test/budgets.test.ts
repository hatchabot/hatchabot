import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { HOUR_FIELDS, type HourField, type WindowModelStats } from '../src/orchestrator/usage.js';
import type { StoredProfile } from '../src/orchestrator/modelScorecard.js';
import type { Agent } from '../src/domain/types.js';
import {
  budgetLine, budgetView, dailyCosts, dayKey, levelOf, MACHINE, monthElapsed, monthKey, nextMonth, prevMonth, runBudgets, suggestBudget, type BudgetDeps,
} from '../src/orchestrator/budgets.js';
import { REST_BY_NAME } from '../src/mgmt/restTools.js';
import { riskOf } from '../src/mgmt/broker.js';
import { COVERAGE } from '../src/mgmt/coverage.js';
import { OPS_AGENTS_MD, OPS_MODEL_REVIEW_MESSAGE } from '../src/ops/opsAgent.js';

/** Budgets (docs/features.md, "Budgets"). Every name, figure and id is made up. */

const HOUR = 3_600_000, DAY = 86_400_000, MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const OWNER = 'owner-budget', OTHER = 'other-budget';
const as = (who: string) => ({ 'x-hatchabot-owner': who });

type Split = Partial<Record<HourField, number>>;
function model(byHour: Record<number, Split>): WindowModelStats {
  const h: Record<string, number[]> = {};
  for (const [ms, c] of Object.entries(byHour)) h[iso(Number(ms)).slice(0, 13)] = HOUR_FIELDS.map((f) => c[f] ?? 0);
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, toolUseCalls: 0, turns: 0, toolTurns: 0, toolCalls: 0, failedTurns: 0, failed7d: 0, first: 0, last: 0, ctxP50: 0, ctxP90: 0, h } as unknown as WindowModelStats;
}
const profile = (now: number, models: Record<string, WindowModelStats>): StoredProfile =>
  ({ since: now - 30 * DAY, models, promptErrors: 0, crons: 0, firstCall: now - 60 * DAY, hourly: true });
/** Opus 4.8 is $5 per million input tokens: `usd` dollars of input in that hour. */
const opus = (at: number, usd: number) => ({ 'claude-opus-4-8': model({ [at]: { input: usd * 200_000 } }) });

describe('the calendar', () => {
  it('days and months in the machine\'s zone; the month so far; next and previous', () => {
    const t = Date.parse('2026-11-01T02:30:00Z');
    expect(dayKey(t, 'UTC')).toBe('2026-11-01');
    expect(dayKey(t, 'America/New_York')).toBe('2026-10-31');
    expect(monthKey(t, 'America/New_York')).toBe('2026-10');
    expect(nextMonth('2026-12')).toBe('2027-01');
    expect(prevMonth('2026-01')).toBe('2025-12');
    expect(monthElapsed(Date.parse('2026-10-01T00:00:00Z'), 'UTC')).toBe(0);
    expect(monthElapsed(Date.parse('2026-10-16T12:00:00Z'), 'UTC')).toBeCloseTo(15.5 / 31, 5);
  });
  it('an hour bucket lands on the local day it started in', () => {
    const t = Date.parse('2026-10-20T03:00:00Z');
    const p = profile(t, { 'claude-opus-4-8': model({ [t]: { input: 1_000_000 } }), 'claude-sonnet-5': model({ [t + HOUR]: { output: 100_000 } }) });
    expect([...dailyCosts(p, 'UTC').days]).toEqual([['2026-10-20', 5 + 1]]);
    const ny = dailyCosts(p, 'America/New_York').days;
    expect(ny.get('2026-10-19')).toBeCloseTo(5, 5); // 23:00 local
    expect(ny.get('2026-10-20')).toBeCloseTo(1, 5);
  });
  it('a suggested budget: a little above the use now, rounded, $5 at least', () => {
    expect(suggestBudget(0)).toBe(5);
    expect(suggestBudget(8)).toBe(10);
    expect(suggestBudget(41)).toBe(75);
    expect(suggestBudget(900)).toBe(1500);
    expect(levelOf(39, 50)).toBe(0);
    expect(levelOf(40, 50)).toBe(80);
    expect(levelOf(50, 50)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

function world() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'API key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/key', createdAt: 'now' } as never);
  const agent = (id: string, name: string, extra: Record<string, unknown> = {}, owner = OWNER) => store.insertAgent({
    id, ownerId: owner, name, slug: id, state: 'RUNNING', aiProfileId: 'key', hostId: 'h1', runtimeRef: `mock://${id}`,
    persona: '', sharedMemory: true, webOnly: true, createdAt: '2026-08-01T00:00:00Z', updatedAt: 'now', ...extra,
  } as never);
  const told: Array<{ owner: string; via: string; text: string }> = [];
  const busy = new Set<string>();
  const deps: BudgetDeps = {
    store, tz: 'UTC',
    tell: async (owner, a, text) => { told.push({ owner, via: a.name, text }); return true; },
    pause: async (a) => { store.setAgentState(a.id, 'STOPPED'); store.setHibernated(a.id, null); return true; },
    resume: async (a) => { store.setAgentState(a.id, 'RUNNING'); return true; },
    isBusy: (id) => busy.has(id),
  };
  return { store, agent, told, busy, deps };
}
const NOW = Date.parse('2026-10-20T12:00:00Z');

describe('runBudgets', () => {
  it('warns once at 80% and once at 100%; a warn budget never pauses', async () => {
    const { store, agent, told, deps } = world();
    agent('a1', 'Garden Notes');
    store.setBudget('a1', OWNER, 50, 'warn', iso(NOW));
    store.setModelProfile('a1', profile(NOW, opus(NOW - 2 * DAY, 42)), iso(NOW));
    await runBudgets(deps, NOW);
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toContain('"Garden Notes" has used 84% of its $50 budget for October ($42.00)');
    await runBudgets(deps, NOW + 10 * MIN);
    expect(told).toHaveLength(1);
    store.setModelProfile('a1', profile(NOW, { 'claude-opus-4-8': model({ [NOW - 2 * DAY]: { input: 42 * 200_000 }, [NOW - HOUR]: { input: 13 * 200_000 } }) }), iso(NOW));
    const r = await runBudgets(deps, NOW + 20 * MIN);
    expect(r.paused).toEqual([]);
    expect(told).toHaveLength(2);
    expect(told[1]!.text).toContain('has used its $50 budget for October ($55.00)');
    expect(told[1]!.text).toContain('It keeps working');
    expect(store.getAgent('a1')!.state).toBe('RUNNING');
    const v = budgetView(store, store.getBudget('a1')!, 55, NOW, 'UTC', 'a1');
    expect(budgetLine(v, 'it')).toMatch(/^Over its \$50 budget for October: \$55\.00 so far, on pace for \$8[0-9]\.\d\d$/);
  });

  it('a pause budget stops the agent at 100% — not mid-turn — and says so once', async () => {
    const { store, agent, told, deps } = world();
    agent('a2', 'Trip Planner');
    store.setBudget('a2', OWNER, 20, 'pause', iso(NOW));
    store.setModelProfile('a2', profile(NOW, opus(NOW - DAY, 25)), iso(NOW));
    store.setUsageCursor('a2', iso(NOW - MIN), iso(NOW - MIN));
    let r = await runBudgets(deps, NOW);
    expect(r.paused).toEqual([]);
    expect(told).toEqual([]); // the message waits for the pause
    r = await runBudgets(deps, NOW + 10 * MIN);
    expect(r.paused).toEqual(['a2']);
    expect(store.getAgent('a2')!.state).toBe('STOPPED');
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toMatch(/^⏸ Hatchabot: "Trip Planner" has used its \$20 budget for October \(\$25\.00\): it is paused until November 1\./);
    await runBudgets(deps, NOW + 20 * MIN);
    expect(told).toHaveLength(1);
    expect(store.listBudgetPauses({ open: true }).map((p) => p.agentId)).toEqual(['a2']);
    const line = budgetLine(budgetView(store, store.getBudget('a2')!, 25, NOW, 'UTC', 'a2'), 'it');
    expect(line).toBe('Paused: it used its $20 budget for October ($25.00). It starts again on November 1 — or raise the budget, or start it now');
  });

  it('a raised budget starts it again; the 1st of the month does too', async () => {
    const { store, agent, deps } = world();
    agent('a3', 'Recipe Box');
    store.setBudget('a3', OWNER, 20, 'pause', iso(NOW));
    store.setModelProfile('a3', profile(NOW, opus(NOW - DAY, 25)), iso(NOW));
    await runBudgets(deps, NOW);
    expect(store.getAgent('a3')!.state).toBe('STOPPED');
    store.setBudget('a3', OWNER, 40, 'pause', iso(NOW));
    const r = await runBudgets(deps, NOW + MIN, { record: false });
    expect(r.resumed).toEqual(['a3']);
    expect(store.getAgent('a3')!.state).toBe('RUNNING');
    expect(store.getBudgetPause('a3', '2026-10')!.resumedBy).toBe('budget-raised');
    // Lowered again: paused again (a resume that was not the owner's own is no exemption).
    store.setBudget('a3', OWNER, 20, 'pause', iso(NOW));
    await runBudgets(deps, NOW + 2 * MIN, { record: false });
    expect(store.getAgent('a3')!.state).toBe('STOPPED');
    // November: started again, and October's spend no longer counts.
    const nov = Date.parse('2026-11-01T00:05:00Z');
    const r2 = await runBudgets(deps, nov, { record: false });
    expect(r2.resumed).toEqual(['a3']);
    expect(store.getBudgetPause('a3', '2026-10')!.resumedBy).toBe('new-month');
    expect(store.getAgent('a3')!.state).toBe('RUNNING');
  });

  it('started by hand after a pause: it runs on until the 1st; an asleep agent is paused without a wake; busy waits', async () => {
    const { store, agent, busy, deps, told } = world();
    agent('a4', 'Book Club');
    agent('a5', 'Tide Tables', { state: 'STOPPED' });
    store.setHibernated('a5', iso(NOW - HOUR));
    agent('a6', 'Moving Day');
    for (const id of ['a4', 'a5', 'a6']) { store.setBudget(id, OWNER, 10, 'pause', iso(NOW)); store.setModelProfile(id, profile(NOW, opus(NOW - DAY, 12)), iso(NOW)); }
    busy.add('a6');
    await runBudgets(deps, NOW);
    expect(store.getAgent('a4')!.state).toBe('STOPPED');
    expect(store.getAgent('a5')!.hibernatedAt).toBeFalsy(); // the wake poll no longer looks at it
    expect(store.getBudgetPause('a5', '2026-10')).toBeTruthy();
    expect(store.getAgent('a6')!.state).toBe('RUNNING');
    expect(told.map((t) => t.via).sort()).toEqual(['Book Club', 'Tide Tables']);
    // The owner starts a4 by hand (the Start route marks it so).
    store.setAgentState('a4', 'RUNNING');
    store.resumeBudgetPause('a4', '2026-10', iso(NOW + MIN), 'owner');
    busy.delete('a6');
    await runBudgets(deps, NOW + 10 * MIN);
    expect(store.getAgent('a4')!.state).toBe('RUNNING');
    expect(store.getAgent('a6')!.state).toBe('STOPPED');
    expect(budgetView(store, store.getBudget('a4')!, 12, NOW, 'UTC', 'a4').resumedByHand).toBe(true);
  });

  it('a rebuild that starts a paused agent: still over, so paused again on the next pass', async () => {
    const { store, agent, deps } = world();
    agent('a7', 'Lab Notes');
    store.setBudget('a7', OWNER, 10, 'pause', iso(NOW));
    store.setModelProfile('a7', profile(NOW, opus(NOW - DAY, 12)), iso(NOW));
    await runBudgets(deps, NOW);
    store.setAgentState('a7', 'RUNNING'); // a rebuild brought it up
    await runBudgets(deps, NOW + 10 * MIN);
    expect(store.getAgent('a7')!.state).toBe('STOPPED');
  });

  it('the machine budget pauses every agent but the manager, and tells the machine owner on the manager\'s chat', async () => {
    const { store, agent, deps, told } = world();
    agent('ops', 'Hatchabot', { ops: true });
    agent('m1', 'Errands');
    agent('m2', 'Theirs', {}, OTHER);
    store.setModelProfile('m1', profile(NOW, opus(NOW - DAY, 60)), iso(NOW));
    store.setModelProfile('m2', profile(NOW, opus(NOW - DAY, 30)), iso(NOW));
    store.setModelProfile('ops', profile(NOW, opus(NOW - DAY, 20)), iso(NOW));
    store.setBudget(MACHINE, OWNER, 100, 'pause', iso(NOW));
    const r = await runBudgets(deps, NOW);
    expect(r.paused.sort()).toEqual(['m1', 'm2']);
    expect(store.getAgent('ops')!.state).toBe('RUNNING');
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ owner: OWNER, via: 'Hatchabot' });
    expect(told[0]!.text).toContain('This Hatchabot has used its $100 budget for October ($110): 2 agents are paused (not me)');
  });

  it('a manager with a budget is never paused, even if a row says pause', async () => {
    const { store, agent, deps } = world();
    agent('ops', 'Hatchabot', { ops: true });
    store.setBudget('ops', OWNER, 5, 'pause', iso(NOW));
    store.setModelProfile('ops', profile(NOW, opus(NOW - DAY, 9)), iso(NOW));
    const r = await runBudgets(deps, NOW);
    expect(r.paused).toEqual([]);
    expect(store.getAgent('ops')!.state).toBe('RUNNING');
  });

  it('cost days outlive the 30-day profile: the month\'s first days still count on the 31st', async () => {
    const { store, agent, deps } = world();
    agent('a8', 'Ledger');
    const early = Date.parse('2026-10-01T09:00:00Z');
    store.setModelProfile('a8', profile(early + DAY, opus(early, 7)), iso(early + DAY));
    await runBudgets(deps, early + DAY);
    const late = Date.parse('2026-10-31T20:00:00Z');
    // The later read no longer reaches October 1st.
    store.setModelProfile('a8', profile(late, opus(late - HOUR, 3)), iso(late));
    await runBudgets(deps, late);
    expect(store.costBetween('2026-10-01', '2026-10-31', ['a8']).get('a8')).toBeCloseTo(10, 5);
  });
});

// ---------------------------------------------------------------------------
// The routes and the chat
// ---------------------------------------------------------------------------

async function app() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'API key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/key', createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'k2', ownerId: OTHER, name: 'Theirs', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/k2', createdAt: 'now' } as never);
  const add = async (id: string, name: string, owner = OWNER, extra: Record<string, unknown> = {}) => {
    const { runtimeRef } = await provider.provision({ agentId: id, slug: id, workspace: { files: {}, configPatch: { agentId: id, authMode: 'api-key' } }, env: {} } as never);
    await provider.start(runtimeRef);
    store.insertAgent({ id, ownerId: owner, name, slug: id, state: 'RUNNING', runtimeRef, aiProfileId: owner === OWNER ? 'key' : 'k2', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: '2026-08-01T00:00:00Z', updatedAt: 'now', ...extra } as never);
  };
  await add('r1', 'Garden Notes');
  await add('rops', 'Hatchabot', OWNER, { ops: true });
  await add('x1', 'Theirs', OTHER);
  const f = Fastify();
  await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } } as never } as never);
  return { f, store };
}

describe('the budget routes', () => {
  it('set, read, pause at once when quiet, start by hand, remove', async () => {
    const { f, store } = await app();
    const now = Date.now();
    store.setModelProfile('r1', { since: now - 30 * DAY, models: opus(now, 30), promptErrors: 0, crons: 0, firstCall: now - 60 * DAY, hourly: true } as StoredProfile, iso(now));
    // The usage pass writes the cost days; here the GET reads them after one pass.
    const { recordCostDays, machineTz } = await import('../src/orchestrator/budgets.js');
    recordCostDays(store, machineTz(), now);

    let r = await f.inject({ method: 'PUT', url: '/v1/agents/r1/budget', headers: as(OWNER), payload: { usd: 0.5 } });
    expect(r.statusCode).toBe(400);
    r = await f.inject({ method: 'PUT', url: '/v1/agents/x1/budget', headers: as(OWNER), payload: { usd: 50 } });
    expect(r.statusCode).toBe(404);
    r = await f.inject({ method: 'PUT', url: '/v1/agents/rops/budget', headers: as(OWNER), payload: { usd: 50, atLimit: 'pause' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('never paused');

    r = await f.inject({ method: 'PUT', url: '/v1/agents/r1/budget', headers: as(OWNER), payload: { usd: 25, atLimit: 'pause' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().budget).toMatchObject({ usd: 25, atLimit: 'pause', level: 100, spent: 30, paused: { at: expect.any(String) } });
    expect(store.getAgent('r1')!.state).toBe('STOPPED');
    expect(store.listTokenActions({ agentId: 'r1' })[0]).toMatchObject({ kind: 'budget', by: 'owner', detail: { from: null, to: { usd: 25, atLimit: 'pause' } } });

    const g = (await f.inject({ method: 'GET', url: '/v1/budgets', headers: as(OWNER) })).json();
    expect(g.machine).toBeDefined();
    expect(g.agents.find((a: { id: string }) => a.id === 'r1')).toMatchObject({ spent: 30, budget: { usd: 25 } });
    expect(g.agents.find((a: { id: string }) => a.id === 'rops')).toMatchObject({ manager: true });
    expect(g.agents.some((a: { id: string }) => a.id === 'x1')).toBe(false);
    const theirs = (await f.inject({ method: 'GET', url: '/v1/budgets', headers: as(OTHER) })).json();
    expect(theirs.machine).toBeUndefined();
    expect((await f.inject({ method: 'PUT', url: '/v1/budgets/machine', headers: as(OTHER), payload: { usd: 10 } })).statusCode).toBe(403);

    const list = (await f.inject({ method: 'GET', url: '/v1/agents', headers: as(OWNER) })).json() as Array<{ id: string; budget?: { line?: string; paused?: unknown } }>;
    expect(list.find((a) => a.id === 'r1')!.budget!.line).toMatch(/^Paused: it used its \$25 budget for /);

    r = await f.inject({ method: 'POST', url: '/v1/agents/r1/start', headers: as(OWNER) });
    expect(r.statusCode).toBe(200);
    expect(store.getAgent('r1')!.state).toBe('RUNNING');
    const month = monthKey(Date.now(), machineTz());
    expect(store.getBudgetPause('r1', month)!.resumedBy).toBe('owner');

    r = await f.inject({ method: 'PUT', url: '/v1/agents/r1/budget', headers: as(OWNER), payload: { usd: null } });
    expect(r.json()).toMatchObject({ budget: null, message: '"Garden Notes" has no budget now.' });
    expect(store.getBudget('r1')).toBeUndefined();
  });

  it('the chat: get_budgets reads, set_budget is a card the owner confirms', () => {
    const get = REST_BY_NAME.get('get_budgets')!;
    const set = REST_BY_NAME.get('set_budget')!;
    expect(get.tier).toBe('read');
    expect(set.tier).toBe('mutate');
    expect(riskOf('set_budget')).toBe('disruptive');
    expect(COVERAGE['PUT /v1/agents/:id/budget']).toBe('set_budget');
    expect(COVERAGE['PUT /v1/budgets/machine']).toMatch(/^app: fleet-wide/);
    const agent = { id: 'r1', name: 'Garden Notes' } as Agent;
    expect(set.call({ agent, input: { usd: 30, at_limit: 'pause' } } as never)).toEqual({ method: 'PUT', path: '/v1/agents/r1/budget', body: { usd: 30, atLimit: 'pause' } });
    expect(set.call({ agent, input: { usd: 0 } } as never)).toMatchObject({ body: { usd: null } });
    expect(() => set.call({ agent, input: { usd: 0.2 } } as never)).toThrow(/from 1/);
    expect(set.card!({ agent, input: { usd: 30, at_limit: 'pause' } } as never)).toContain('at 100% it pauses until the 1st');
    expect(OPS_AGENTS_MD).toContain('8. BUDGETS. get_budgets');
    expect(OPS_AGENTS_MD).not.toContain('does not enforce a budget');
    expect(OPS_MODEL_REVIEW_MESSAGE).toContain('get_budgets');
    expect(OPS_MODEL_REVIEW_MESSAGE).toContain('set_budget');
  });
});
