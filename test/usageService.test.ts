import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { clearBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import { beginOperation, oweStart, startOwedIn } from '../src/orchestrator/lifecycle/operations.js';
import { MACHINE, machineTz, monthKey, recordCostDays } from '../src/orchestrator/usage/budgets.js';
import { HOUR_FIELDS, type WindowModelStats } from '../src/orchestrator/usage/usage.js';
import type { StoredProfile } from '../src/orchestrator/usage/modelScorecard.js';
import { createUsageAndBudgets, type UsageAndBudgetsDeps } from '../src/orchestrator/usage/usageAndBudgets.js';
import { NO_CHAT_NOTE } from '../src/orchestrator/usage/monthlyBudgets.js';
import { fakeUsage } from './helpers/usageFake.js';

// The context cap's write, held by the test: what each call answers, and who was asked.
const caps = vi.hoisted(() => ({ calls: [] as string[], answer: 'applied' as string }));
vi.mock('../src/orchestrator/memory/compaction.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/orchestrator/memory/compaction.js')>();
  return { ...real, syncContextCap: async (_deps: unknown, agent: { id: string }) => { caps.calls.push(agent.id); return caps.answer; } };
});

// The reading of every agent's logs, held by the test: each pass waits for `release`.
const reading = vi.hoisted(() => ({ calls: 0, hold: undefined as undefined | Promise<void> }));
vi.mock('../src/orchestrator/usage/sourceUsage.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/orchestrator/usage/sourceUsage.js')>();
  return { ...real, sampleSourceUsage: async () => { reading.calls++; await reading.hold; return { agents: 0, calls: 0, limited: 0 }; } };
});

/**
 * The usage and budgets service (HB-0808): the usage pass and its timers,
 * the token steward's decision about a context cap, the budget pass's pause,
 * a step alarm, the cost badges' cache and Recommended's "Not now", driven
 * as the routes and the timers drive them but with no HTTP server. A real
 * store on an in-memory database; a machine that is a plain object answering
 * what each test sets. Made-up data only.
 */
const OWNER = 'owner-usage', OTHER = 'other-usage';
const HOUR = 3_600_000, MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function model(at: number, input: number): WindowModelStats {
  const h = { [iso(at).slice(0, 13)]: HOUR_FIELDS.map((f) => (f === 'input' ? input : 0)) };
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, toolUseCalls: 0, turns: 0, toolTurns: 0, toolCalls: 0, failedTurns: 0, failed7d: 0, first: 0, last: 0, ctxP50: 0, ctxP90: 0, h } as unknown as WindowModelStats;
}
/** `usd` dollars of Opus 4.8 input ($5 per million tokens) in the hour of `at`. */
const spent = (at: number, usd: number): StoredProfile =>
  ({ since: at - 30 * 24 * HOUR, models: { 'claude-opus-4-8': model(at, usd * 200_000) }, promptErrors: 0, crons: 0, firstCall: at - 60 * 24 * HOUR, hourly: true }) as unknown as StoredProfile;

interface Machine { stops: string[]; phase: string }

function world(over: Partial<UsageAndBudgetsDeps> = {}) {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'API key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', models: ['claude-opus-4-8', 'claude-haiku-4-5'], secretRef: 'ai/key', createdAt: 'now' } as never);
  const agent = (id: string, name: string, extra: Record<string, unknown> = {}) => {
    store.insertAgent({
      id, ownerId: OWNER, name, slug: id, state: 'RUNNING', aiProfileId: 'key', hostId: 'h1', runtimeRef: `mock://${id}`,
      persona: '', sharedMemory: true, webOnly: true, createdAt: '2026-08-01T00:00:00Z', updatedAt: 'now', ...extra,
    } as never);
    return store.getAgent(id)!;
  };
  const machine: Machine = { stops: [], phase: 'stopped' };
  const provider = {
    stop: async (ref: string) => { machine.stops.push(ref); },
    status: async () => ({ phase: machine.phase }),
  };
  const traced: Array<{ agentId: string; event: string }> = [];
  const told: string[] = [];
  const warned: string[] = [];
  const deps: UsageAndBudgetsDeps = {
    store,
    secrets: { put: async () => {}, get: async () => 'made-up', delete: async () => {} } as never,
    providerFor: () => provider as never,
    trace: (agentId) => (event) => { traced.push({ agentId: agentId ?? '', event }); },
    tell: async (_ownerId, _agent, text) => { told.push(text); return true; },
    chatReaches: () => true,
    push: () => {},
    startStopped: async (a) => { store.setAgentState(a.id, 'RUNNING'); return { ok: true }; },
    secretOf: async () => 'made-up',
    inFlight: () => false,
    applyModelToRuntime: async () => 'live',
    subscriptionRuntimeProblem: async () => undefined,
    log: { info: () => {}, warn: (_d, msg) => { warned.push(msg); } },
    warn: (_d, msg) => { warned.push(msg); },
    sampleEveryMs: 0,
    pausedReplyEveryMs: 0,
    ...over,
  };
  const svc = createUsageAndBudgets(deps);
  return { store, deps, agent, svc, machine, traced, told, warned };
}
const fromApp = { by: 'owner' as const, via: 'app' as const, source: 'budget' };

afterEach(() => { vi.useRealTimers(); caps.calls.length = 0; caps.answer = 'applied'; reading.calls = 0; reading.hold = undefined; });

describe('the usage pass', () => {
  it('one pass at a time; it ends with the budget pass, and says when it ended', async () => {
    const w = world();
    w.agent('a1', 'Garden Notes');
    const now = Date.now();
    w.store.setModelProfile('a1', spent(now, 30), iso(now));
    w.store.setBudget('a1', OWNER, 25, 'pause', iso(now));
    let release!: () => void;
    reading.hold = new Promise<void>((r) => { release = r; });
    expect(w.svc.sampler.sampledAt()).toBeUndefined();
    const one = w.svc.sampler.sample(), two = w.svc.sampler.sample();
    expect(two).toBe(one);
    expect(w.svc.sampler.sampling()).toBe(true);
    release();
    await one;
    expect(reading.calls).toBe(1);
    expect(w.svc.sampler.sampling()).toBe(false);
    expect(w.svc.sampler.sampledAt()).toMatch(/^\d{4}-\d\d-\d\dT/);
    // The budget pass ran last, with the cost days the pass recorded: over its budget, paused.
    expect(w.store.getAgent('a1')!.state).toBe('STOPPED');
    expect(w.warned).toEqual([]);
    // And the next pass is a new one.
    await w.svc.sampler.sample();
    expect(reading.calls).toBe(2);
  });

  it('a pass that fails is logged, never thrown, and the next can start', async () => {
    const w = world();
    const failing = Promise.reject(new Error('SQLITE_FULL: database or disk is full'));
    failing.catch(() => {}); // the pass awaits it; this only keeps it from being reported unhandled first
    reading.hold = failing;
    await expect(w.svc.sampler.sample()).resolves.toBeUndefined();
    expect(w.warned).toContain('usage.sample_failed');
    expect(w.svc.sampler.sampling()).toBe(false);
    expect(w.svc.sampler.sampledAt()).toBeUndefined();
    reading.hold = undefined;
    await w.svc.sampler.sample();
    expect(w.svc.sampler.sampledAt()).toBeDefined();
  });

  it('its timers: the first pass 90 seconds after the start, then every sampleEveryMs; stop() ends both', async () => {
    vi.useFakeTimers();
    const w = world({ sampleEveryMs: 10 * MIN });
    const sampled = () => w.svc.sampler.sampledAt();
    await vi.advanceTimersByTimeAsync(89_000);
    expect(sampled()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    const first = sampled();
    expect(first).toBeDefined();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(sampled()).not.toBe(first);
    w.svc.stop();
    const last = sampled();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(sampled()).toBe(last);
  });

  it('no timer at all when sampleEveryMs is 0 (the tests) or not a number', async () => {
    vi.useFakeTimers();
    for (const every of [0, Number('soon')]) {
      const w = world({ sampleEveryMs: every });
      await vi.advanceTimersByTimeAsync(3 * HOUR);
      expect(w.svc.sampler.sampledAt()).toBeUndefined();
      w.svc.stop();
    }
  });
});

describe('the token steward', () => {
  it('writes a context cap that is not yet in a running agent; a refused write waits six hours', async () => {
    const w = world();
    w.agent('a1', 'Garden Notes');
    w.store.setContextCap('a1', 150_000, iso(Date.now()));
    caps.answer = 'failed';
    await w.svc.sampler.stewardTokens();
    expect(caps.calls).toEqual(['a1']);
    await w.svc.sampler.stewardTokens();
    expect(caps.calls).toEqual(['a1']); // backed off, not tried every pass
  });

  it('leaves a stopped agent, a busy one and a cap already written for this model alone', async () => {
    const w = world();
    w.agent('a2', 'Asleep', { state: 'STOPPED' });
    w.agent('a3', 'Rebuilding');
    w.agent('a4', 'Written');
    for (const id of ['a2', 'a3', 'a4']) w.store.setContextCap(id, 150_000, iso(Date.now() - MIN));
    w.store.markContextCapApplied('a4', 'anthropic/claude-opus-4-8', iso(Date.now()));
    markBusy('a3');
    try { await w.svc.sampler.stewardTokens(); } finally { clearBusy('a3'); }
    expect(caps.calls).toEqual([]);
    // Once it is free, the busy one gets its cap; the written one still does not.
    await w.svc.sampler.stewardTokens();
    expect(caps.calls).toEqual(['a3']);
  });
});

describe('the budget pass', () => {
  it('a pause budget set below what it spent: the agent is stopped, the stop confirmed, the pause recorded', async () => {
    const w = world();
    const a = w.agent('a1', 'Garden Notes');
    const now = Date.now();
    w.store.setModelProfile('a1', spent(now, 30), iso(now));
    recordCostDays(w.store, machineTz(), now);
    const r = await w.svc.budgets.setAgentBudget(a, { usd: 25, atLimit: 'pause', why: 'too much this month' }, undefined, fromApp);
    expect(w.machine.stops).toEqual(['mock://a1']);
    expect(w.store.getAgent('a1')!.state).toBe('STOPPED');
    expect(w.store.getBudgetPause('a1', monthKey(now, machineTz()))?.kind).toBe('pause');
    expect(r.budget).toMatchObject({ usd: 25, atLimit: 'pause' });
    expect(r.view?.paused).toBeDefined();
    expect(w.store.listTokenActions({ agentId: 'a1' })).toMatchObject([{ kind: 'budget', by: 'owner', via: 'app', why: 'too much this month', detail: { from: null, to: { usd: 25, atLimit: 'pause' } } }]);
    expect(w.traced.map((t) => t.event)).toContain('budget.set');
  });

  it('a pause takes over a start a restart left owed on the agent, so the boot pass does not start it again (HB-0980)', async () => {
    const w = world();
    const a = w.agent('a1', 'Garden Notes');
    const now = Date.now();
    const op = beginOperation(w.store, 'adopt-workspace', 'a1', { from: '/made/up/workspace', wasRunning: true });
    oweStart(w.store, op.id);
    op.done('Adopted the workspace again.');
    w.store.setModelProfile('a1', spent(now, 30), iso(now));
    recordCostDays(w.store, machineTz(), now);
    await w.svc.budgets.setAgentBudget(a, { usd: 25, atLimit: 'pause' }, undefined, fromApp);
    expect(w.store.getAgent('a1')!.state).toBe('STOPPED');
    const after = w.store.getOperation(op.id)!;
    expect(startOwedIn(after)).toBeUndefined();
    expect(after.outcome).toBe('Adopted the workspace again. Its budget has paused it since, so it stays stopped.');
  });

  it('a stop the machine does not confirm is no pause, and a busy agent is left to the next pass', async () => {
    const w = world();
    w.agent('a1', 'Garden Notes');
    w.agent('a2', 'Trip Planner');
    const now = Date.now();
    for (const id of ['a1', 'a2']) { w.store.setModelProfile(id, spent(now, 30), iso(now)); w.store.setBudget(id, OWNER, 25, 'pause', iso(now)); }
    recordCostDays(w.store, machineTz(), now);
    w.machine.phase = 'running';
    markBusy('a2');
    try { await w.svc.budgets.runPass({ record: false }); } finally { clearBusy('a2'); }
    expect(w.machine.stops).toEqual(['mock://a1']);
    expect(w.store.listBudgetPauses({ open: true })).toEqual([]);
    expect(w.store.getAgent('a1')!.state).toBe('RUNNING');
    expect(w.store.getAgent('a2')!.state).toBe('RUNNING');
  });

  it('a Stop by a person disowns the pause, so the 1st does not start it again (HB-0419)', async () => {
    const w = world();
    const a = w.agent('a1', 'Garden Notes');
    const now = Date.now();
    w.store.setModelProfile('a1', spent(now, 30), iso(now));
    recordCostDays(w.store, machineTz(), now);
    await w.svc.budgets.setAgentBudget(a, { usd: 25, atLimit: 'pause' }, undefined, fromApp);
    w.svc.budgets.disownPauseOnStop('a1');
    expect(w.traced.map((t) => t.event)).toContain('budget.pause_disowned');
    // Raised: an owned pause would be ended and the agent started; this one is the person's.
    await w.svc.budgets.setAgentBudget(w.store.getAgent('a1')!, { usd: 500, atLimit: 'pause' }, w.store.getBudget('a1'), fromApp);
    expect(w.store.getAgent('a1')!.state).toBe('STOPPED');
  });

  it('one pass at a time: a second waits for the first', async () => {
    const w = world();
    w.agent('a1', 'Garden Notes');
    const now = Date.now();
    w.store.setModelProfile('a1', spent(now, 30), iso(now));
    w.store.setBudget('a1', OWNER, 25, 'pause', iso(now));
    recordCostDays(w.store, machineTz(), now);
    // The first pass's stop of the agent is held until the test lets it go.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const stopped = vi.fn();
    w.svc = createUsageAndBudgets({ ...w.deps, providerFor: () => ({ stop: async () => { stopped(); await held; }, status: async () => ({ phase: 'stopped' }) }) as never });
    const looked = vi.spyOn(w.store, 'listAllActiveAgents');
    const first = w.svc.budgets.runPass({ record: false });
    await vi.waitFor(() => expect(stopped).toHaveBeenCalled());
    const before = looked.mock.calls.length;
    const second = w.svc.budgets.runPass({ record: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(looked.mock.calls.length).toBe(before); // the second has not begun
    release();
    await Promise.all([first, second]);
    expect(looked.mock.calls.length).toBeGreaterThan(before);
    expect(stopped).toHaveBeenCalledTimes(1); // the second found it paused
  });
});

describe('"tell me every $X"', () => {
  it('counts from when it is set: multiples already passed are not told, the next one is', async () => {
    const w = world();
    const a = w.agent('a1', 'Garden Notes');
    const now = Date.now();
    w.store.setModelProfile('a1', spent(now, 25), iso(now));
    recordCostDays(w.store, machineTz(), now);
    const { view } = w.svc.budgets.setAgentSpendAlert(a, 10, fromApp);
    expect(view).toMatchObject({ every: 10, passed: 2, next: 30 });
    expect(w.store.listTokenActions({ agentId: 'a1' })).toMatchObject([{ kind: 'budget', detail: { alertEvery: { from: null, to: 10 } } }]);
    await w.svc.budgets.runPass();
    expect(w.told).toEqual([]);
    w.store.setModelProfile('a1', spent(now, 31), iso(now));
    await w.svc.budgets.runPass();
    expect(w.told).toHaveLength(1);
    // null takes it away.
    expect(w.svc.budgets.setAgentSpendAlert(a, null, fromApp).view).toBeUndefined();
    expect(w.store.getSpendAlert('a1')).toBeUndefined();
  });

  it("the machine's: every agent's spend, and its view", () => {
    const w = world();
    w.agent('a1', 'Garden Notes');
    w.agent('a2', 'Trip Planner');
    const now = Date.now();
    w.store.setModelProfile('a1', spent(now, 12), iso(now));
    w.store.setModelProfile('a2', spent(now, 9), iso(now));
    recordCostDays(w.store, machineTz(), now);
    const { view } = w.svc.budgets.setMachineSpendAlert(OWNER, 5, 'owner');
    expect(view).toMatchObject({ every: 5, passed: 4, next: 25, spent: 21 });
    expect(w.svc.budgets.machineBudgetView().alertEvery).toMatchObject({ every: 5 });
    expect(w.store.getSpendAlert(MACHINE)).toBeDefined();
    expect(w.traced.map((t) => t.event)).toContain('budget.machine_step_set');
  });

  it('says no message will come when no chat reaches the owner', () => {
    expect(world({ chatReaches: () => false }).svc.budgets.chatNoteOf(OWNER)).toBe(NO_CHAT_NOTE);
    expect(world().svc.budgets.chatNoteOf(OWNER, 'a1')).toBe('');
  });
});

describe('the paused replies', () => {
  it('a sweep every pausedReplyEveryMs; stop() ends it', async () => {
    vi.useFakeTimers();
    const w = world({ pausedReplyEveryMs: MIN });
    const looked = vi.spyOn(w.store, 'listBudgetPauses');
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(looked).toHaveBeenCalledTimes(3);
    w.svc.stop();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(looked).toHaveBeenCalledTimes(3);
  });

  it('never rejects: a store that fails is logged', async () => {
    const w = world();
    vi.spyOn(w.store, 'listBudgetPauses').mockImplementation(() => { throw new Error('SQLITE_FULL: database or disk is full'); });
    await expect(w.svc.budgets.runPausedReplies()).resolves.toBeUndefined();
    expect(w.warned).toEqual(['budget.reply_failed']);
  });
});

describe('the readings and Recommended', () => {
  it('the cost badges: one answer per person and window for five minutes', () => {
    vi.useFakeTimers();
    const w = world();
    const one = w.svc.readings.costBadges(OWNER, 'd7', 7);
    vi.advanceTimersByTime(4 * MIN);
    expect(w.svc.readings.costBadges(OWNER, 'd7', 7).at).toBe(one.at);
    expect(w.svc.readings.costBadges(OTHER, 'd7', 7).at).not.toBe(one.at);
    vi.advanceTimersByTime(2 * MIN);
    expect(w.svc.readings.costBadges(OWNER, 'd7', 7).at).not.toBe(one.at);
  });

  it('the cost badges: a member whose access is taken away loses the agent at once, cached or not (HB-1098)', () => {
    const w = world();
    w.agent('a1', 'Garden Notes');
    w.store.insertMembership({ id: 'm1', agentId: 'a1', userId: OTHER, role: 'admin', status: 'active' } as never);
    const one = w.svc.readings.costBadges(OTHER, 'd7', 7);
    expect(Object.keys(one.value)).toEqual(['a1']);
    w.store.revokeMembership('a1', OTHER);
    const two = w.svc.readings.costBadges(OTHER, 'd7', 7);
    expect(two.at).toBe(one.at);
    expect(two.value).toEqual({});
  });

  it('the fleet: a source switch still waiting for its rebuild is billed to the source the container runs (HB-1009)', async () => {
    const read = JSON.stringify(fakeUsage([{ model: 'claude-opus-4-8', input: 1_000_000 }]));
    const w = world({ providerFor: () => ({ execShell: async () => ({ code: 0, stdout: read, stderr: '' }) }) as never });
    w.store.insertAIProfile({ id: 'here', ownerId: OWNER, name: 'On this machine', vendor: 'local', kind: 'api_key', model: 'gpt-oss', secretRef: 'ai/here', createdAt: 'now' } as never);
    w.agent('a1', 'Garden Notes');
    w.store.setAgentApplied('a1', 'key', 'claude-opus-4-8');
    expect(w.store.setAgentAIProfile('a1', 'here')).toBe('ok');   // saved; the rebuild has not run
    const fleet = await w.svc.readings.fleetUsage(OWNER);
    expect(fleet.agents).toHaveLength(1);
    expect(fleet.agents[0]).toMatchObject({ billing: 'api', profileName: 'API key' });
    expect(fleet.agents[0]!.cost?.low).toBeCloseTo(5, 6);
    expect(fleet.byBilling).toMatchObject({ api: 1_000_000, local: 0 });
  });

  it('the fleet: a stopped agent is skipped, not counted as zero', async () => {
    const w = world();
    w.agent('a1', 'Asleep', { state: 'STOPPED' });
    expect(await w.svc.readings.fleetUsage(OWNER)).toMatchObject({ agents: [], counted: 0, skipped: 1, totalTokens: 0, cost: null });
  });

  it('Not now: a spike put away, its warning cleared with it; another owner\'s is not theirs to put away', () => {
    const w = world();
    w.agent('a1', 'Garden Notes');
    const now = Date.now();
    w.store.addUsageAlert({ agentId: 'a1', ownerId: OWNER, at: iso(now - HOUR), tokens: 90e6, usual: 20e6, told: true });
    expect(w.svc.recommended.list(OWNER, false).items.map((x) => x.id)).toContain('spike:a1');
    expect(w.svc.recommended.forAgent(OWNER, false, 'a1').items.map((x) => x.id)).toEqual(['spike:a1']);
    expect(w.svc.recommended.dismiss(OTHER, false, 'spike:a1')).toBeUndefined();
    expect(w.svc.recommended.dismiss(OWNER, false, 'spike:a1')).toMatchObject({ id: 'spike:a1', kind: 'spike' });
    expect(w.svc.recommended.list(OWNER, false).items.map((x) => x.id)).not.toContain('spike:a1');
    expect(w.store.usageAlertsSince(iso(now - 2 * HOUR), { ownerId: OWNER })).toEqual([]);
    expect(w.traced).toContainEqual({ agentId: 'a1', event: 'recommendation.dismissed' });
    // Gone: nothing to put away.
    expect(w.svc.recommended.dismiss(OWNER, false, 'spike:a1')).toBeUndefined();
  });
});
