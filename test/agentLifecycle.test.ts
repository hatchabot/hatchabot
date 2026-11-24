import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '../src/domain/types.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { clearBusy, isBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import type { HibernateDeps } from '../src/orchestrator/lifecycle/hibernate.js';
import { createAgentLifecycle, type AgentLifecycle, type AgentLifecycleDeps } from '../src/orchestrator/lifecycle/agentLifecycle.js';
import { beginOperation } from '../src/orchestrator/lifecycle/operations.js';
import { semaphore } from '../src/util/queues.js';

/**
 * The agent lifecycle service (HB-0808 step 11): the setup and rebuild
 * queue, the machine's own rebuilds and their settings, Start, Stop, sleep and
 * wake, driven with no HTTP server. A real store on an in-memory database, a
 * MockProvider for the machine, and plain functions for what the service asks
 * of its process.
 */
const OWNER = 'user-owner';

interface World {
  store: Store;
  provider: MockProvider;
  life: AgentLifecycle;
  events: Array<{ agentId?: string; event: string; detail: Record<string, unknown> }>;
  calls: string[];
  /** An agent with a container on the machine. */
  agent(id: string, over?: Partial<Agent>): Agent;
}

const built: AgentLifecycle[] = [];
const busyIds: string[] = [];
let worldNo = 0;
afterEach(() => {
  for (const l of built.splice(0)) l.stop();
  for (const id of busyIds.splice(0)) clearBusy(id);
  vi.restoreAllMocks();
  delete process.env.HATCHABOT_REBUILD_CONCURRENCY;
  delete process.env.HATCHABOT_REBUILD_POLICY;
  delete process.env.HATCHABOT_ENV_FILE;
});

function world(over: Partial<AgentLifecycleDeps> = {}): World {
  // Ids unique per world: the busy flag is process-wide.
  const tag = ++worldNo;
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
  const events: World['events'] = [];
  const calls: string[] = [];
  const secrets = { put: async () => {}, get: async () => 'x', delete: async () => {} } as never;
  const providerFor = (hostId: string) => { if (hostId !== 'h1') throw new Error(`no host ${hostId}`); return provider; };
  const trace = (agentId?: string) => (event: string, detail: Record<string, unknown>) => { events.push({ agentId, event, detail }); };
  const hibernateDeps: HibernateDeps = {
    store, secrets, providerFor,
    lastActiveFor: async () => undefined,
    ownCrons: async () => [],
    isBusy: (id) => isBusy(id),
    log: (id) => (event, detail) => trace(id)(event, detail ?? {}),
  };
  const life = createAgentLifecycle({
    store, secrets, providerFor, trace,
    channel: { kind: 'telegram', pool: { owns: () => false } } as never,
    embedder: () => undefined,
    runPendingApp: async (id) => { calls.push(`app ${id}`); },
    priorChatIdsOf: () => [],
    browsersNow: async () => undefined,
    logError: () => {},
    peersNotInstalled: () => false,
    inLimitsTurn: (_id, fn) => fn(),
    applyCurrentLimits: async (id) => { calls.push(`limits ${id}`); },
    tellMemoryBudget: async (id) => { calls.push(`budget ${id}`); },
    clearPinsWhenUp: (a) => { calls.push(`up ${a.id}`); },
    disownPauseOnStop: (id) => { calls.push(`disown ${id}`); },
    hibernateDeps: () => hibernateDeps,
    switchPendingFor: () => false,
    activityEvidence: async () => ({ read: true }),
    recoverOperation: async (opId, action) => { calls.push(`recover ${opId} ${action}`); return store.getOperation(opId)!; },
    warn: () => {},
    sweepEveryMs: 0,
    hostGoing: () => undefined,
    connectorFor: () => undefined,
    dmChannelPeople: async () => 0,
    parkArchivedChannels: async () => {},
    forgetSettings: (id) => { calls.push(`forget ${id}`); },
    forgetConversations: (id) => { calls.push(`forget conversations ${id}`); },
    publicAgent: (a, extra = {}) => ({ id: a.id, state: a.state, ...extra }),
    noteSelfRestart: () => {},
    swapViewOf: async () => ({}),
    defaultAliasesFor: async () => new Set<string>(),
    lastActiveFor: async () => undefined,
    unreadFor: async () => false,
    botDisplayNameFor: async () => undefined,
    warmLocalModels: async () => [],
    peakSinceClear: () => undefined,
    capHitsSince: () => undefined,
    machineBudgetView: () => ({ spent: 0, lastMonth: 0 }),
    ...over,
  });
  built.push(life);
  const agent = (id: string, o: Partial<Agent> = {}): Agent => {
    const full = `${id}-${tag}`;
    store.insertAgent({
      id: full, ownerId: OWNER, name: id, slug: full, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: `docker://${full}`,
      persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now', ...o,
    } as never);
    if (o.migratedTo) store.setAgentMigratedTo(full, o.migratedTo);
    // Its container on the mock machine, in the state the record says.
    if (o.runtimeRef !== undefined || !('runtimeRef' in o)) {
      (provider as unknown as { runtimes: Map<string, unknown> }).runtimes.set(`docker://${full}`, { spec: { agentId: full, slug: full }, phase: (o.state ?? 'RUNNING') === 'RUNNING' ? 'running' : 'stopped', purged: false });
    }
    return store.getAgent(full)!;
  };
  return { store, provider, life, events, calls, agent };
}

/** Hold every container build open until released (then it fails), counting how many run at once and in which order they began. */
function holdBuilds(provider: MockProvider) {
  let running = 0, peak = 0;
  const order: string[] = [];
  const release: Array<() => void> = [];
  vi.spyOn(provider, 'provision').mockImplementation(async (spec) => {
    running++; peak = Math.max(peak, running); order.push(spec.agentId);
    await new Promise<void>((r) => release.push(() => { running--; r(); }));
    // Ended there: what follows a container's build (its health wait) is not the queue's.
    throw new Error('made-up build stop');
  });
  return { peak: () => peak, order, releaseAll: () => release.splice(0).forEach((r) => r()), running: () => running };
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe('the rebuild queue', () => {
  it('runs as many at once as it is set to, in the order asked, and says which wait', async () => {
    process.env.HATCHABOT_REBUILD_CONCURRENCY = '2';
    const w = world();
    const held = holdBuilds(w.provider);
    const ids = ['a', 'b', 'c', 'd'].map((n) => w.agent(n).id);
    try {
      for (const id of ids) expect(w.life.queue.kickRebuild(id)).toBe(true);
      await tick(100);
      expect(held.peak()).toBe(2);
      expect(held.order).toEqual(ids.slice(0, 2));
      expect(ids.filter((id) => w.life.queue.isQueued(id))).toEqual(ids.slice(2));
      expect(w.life.queue.counts()).toEqual({ queued: 2, running: 4 });
      expect(w.life.rebuilds.concurrencyView()).toMatchObject({ atOnce: 2, queued: 2, running: 4, max: 12 });
      // Raised while they wait: the next one goes in at once.
      w.life.queue.setAtOnce(3);
      await tick(100);
      expect(held.order).toEqual(ids.slice(0, 3));
    } finally { held.releaseAll(); }
    // Each build let go as it begins: the last one gets its slot too.
    const letGo = setInterval(() => held.releaseAll(), 20);
    try { await Promise.all(ids.map((id) => w.life.queue.inFlight(id))); } finally { clearInterval(letGo); }
    expect(held.order).toEqual(ids);
    expect(ids.every((id) => !w.life.queue.isInFlight(id))).toBe(true);
  });

  it('refuses a second rebuild in flight, a copy moved away, one with no container, and one under a long operation', async () => {
    const w = world();
    const held = holdBuilds(w.provider);
    try {
      const a = w.agent('a');
      expect(w.life.queue.kickRebuild(a.id)).toBe(true);
      expect(w.life.queue.kickRebuild(a.id)).toBe(false);
      expect(w.life.queue.inFlight(a.id)).toBeInstanceOf(Promise);
      expect(w.life.queue.kickRebuild(w.agent('moved', { migratedTo: 'elsewhere' }).id)).toBe(false);
      expect(w.life.queue.kickRebuild(w.agent('bare', { runtimeRef: undefined }).id)).toBe(false);
      const held2 = w.agent('held');
      beginOperation(w.store, 'move-host', held2.id, {});
      expect(w.life.queue.kickRebuild(held2.id)).toBe(false);
    } finally { held.releaseAll(); }
  });

  it('a rebuild called off while it waits skips itself at its turn', async () => {
    process.env.HATCHABOT_REBUILD_CONCURRENCY = '1';
    const w = world();
    const held = holdBuilds(w.provider);
    const first = w.agent('first'), second = w.agent('second');
    w.life.queue.kickRebuild(first.id);
    w.life.queue.kickRebuild(second.id);
    await tick();
    expect(w.life.queue.isQueued(second.id)).toBe(true);
    w.life.queue.callOff(second.id);
    held.releaseAll();
    await w.life.queue.inFlight(second.id);
    expect(held.order).toEqual([first.id]);
    expect(w.events).toContainEqual({ agentId: second.id, event: 'rebuild.skipped', detail: { why: 'called off by delete or archive' } });
    expect(w.store.listOperations([second.id], 1)[0]).toMatchObject({ kind: 'rebuild', status: 'rolled_back' });
  });

  it('an agent stopped while its rebuild waited is not started: the rebuild is owed to its next start', async () => {
    process.env.HATCHABOT_REBUILD_CONCURRENCY = '1';
    const w = world();
    const held = holdBuilds(w.provider);
    const first = w.agent('first'), second = w.agent('second');
    w.life.queue.kickRebuild(first.id);
    w.life.queue.kickRebuild(second.id);
    await tick();
    w.store.setAgentState(second.id, 'STOPPED');
    held.releaseAll();
    await w.life.queue.inFlight(second.id);
    expect(held.order).toEqual([first.id]);
    expect(w.store.getAgent(second.id)?.rebuildOnStart).toBeTruthy();
    expect(w.store.getAgent(second.id)?.state).toBe('STOPPED');
  });

  it('owes a rebuild with a stamp of its own, and rebuildOrOwe picks now, the next start or nothing', async () => {
    const w = world();
    const held = holdBuilds(w.provider);
    try {
      const stopped = w.agent('s', { state: 'STOPPED' });
      const one = w.life.queue.oweRebuild(stopped.id);
      const two = w.life.queue.oweRebuild(stopped.id);
      expect(Date.parse(two)).toBeGreaterThan(Date.parse(one));
      expect(w.store.getAgent(stopped.id)?.rebuildOnStart).toBe(two);
      expect(w.events.filter((e) => e.event === 'rebuild.owed')).toHaveLength(2);
      expect(w.life.queue.rebuildOrOwe(w.agent('s2', { state: 'STOPPED' }))).toBe('next-start');
      expect(w.life.queue.rebuildOrOwe(w.agent('r'))).toBe('rebuilding');
      expect(w.life.queue.rebuildOrOwe(w.agent('n', { runtimeRef: undefined }))).toBe('not-started');
      const op = w.agent('op', { state: 'STOPPED' });
      beginOperation(w.store, 'move-host', op.id, {});
      expect(w.life.queue.rebuildOrOwe(op)).toBe('not-started');
      expect(w.store.getAgent(op.id)?.rebuildOnStart).toBeFalsy();
    } finally { held.releaseAll(); }
  });

  it('a setup for an answered step waits while another holder has the agent, and stop() ends the wait', async () => {
    const w = world();
    const a = w.agent('p', { state: 'PROVISIONING', pendingAction: { kind: 'telegram_token', received: true } as never });
    markBusy(a.id); busyIds.push(a.id);
    const spy = vi.spyOn(global, 'setTimeout');
    w.life.queue.provisionWhenFree(a.id);
    expect(spy.mock.calls.some((c) => c[1] === 2_000)).toBe(true);
    const clear = vi.spyOn(global, 'clearTimeout');
    w.life.queue.stop();
    expect(clear).toHaveBeenCalled();
    clearBusy(a.id);
    await tick(50);
    expect(w.life.queue.isInFlight(a.id)).toBe(false);
  });

  it('semaphore: at most its limit at once, resizable', async () => {
    const gate = semaphore(1);
    await gate.acquire();
    let second = false;
    void gate.acquire().then(() => { second = true; });
    await tick(5);
    expect(second).toBe(false);
    gate.setLimit(2);
    await tick(5);
    expect(second).toBe(true);
    expect(gate.limit).toBe(2);
  });
});

describe('the machine\'s own rebuilds', () => {
  it('under the manual policy the sweep rebuilds nothing', async () => {
    process.env.HATCHABOT_REBUILD_POLICY = 'manual';
    const w = world();
    w.agent('a');
    expect(await w.life.rebuilds.rebuildSweep()).toEqual([]);
  });

  it('writes the policy and how many at once to .env, and the queue follows at once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-life-'));
    try {
      process.env.HATCHABOT_ENV_FILE = join(dir, '.env');
      writeFileSync(join(dir, '.env'), '# made up\n');
      const w = world();
      expect(await w.life.rebuilds.setAtOnce(4)).toEqual({ ok: true });
      expect(w.life.queue.atOnce()).toBe(4);
      expect(process.env.HATCHABOT_REBUILD_CONCURRENCY).toBe('4');
      expect(await w.life.rebuilds.setPolicy('manual')).toEqual({ ok: true });
      expect(readFileSync(join(dir, '.env'), 'utf8')).toMatch(/HATCHABOT_REBUILD_CONCURRENCY=4[\s\S]*HATCHABOT_REBUILD_POLICY=manual/);
      expect(w.events.map((e) => e.event)).toEqual(['rebuild.concurrency_set', 'rebuild.policy_set']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the sweep\'s interval starts only when asked, and stop() ends it', () => {
    const set = vi.spyOn(global, 'setInterval');
    const clear = vi.spyOn(global, 'clearInterval');
    world();
    expect(set.mock.calls.some((c) => c[1] === 123_000)).toBe(false);
    const w = world({ sweepEveryMs: 123_000 });
    const timer = set.mock.results[set.mock.calls.findIndex((c) => c[1] === 123_000)]?.value;
    expect(timer).toBeTruthy();
    w.life.stop();
    expect(clear).toHaveBeenCalledWith(timer);
  });
});

describe('start, stop, sleep and wake', () => {
  it('starts a stopped agent: its limits first, then what runs once it is up', async () => {
    const w = world();
    const a = w.agent('a', { state: 'STOPPED', hibernatedAt: 'then' } as never);
    const r = await w.life.power.startStopped(a, { ownerAsked: true });
    expect(r).toMatchObject({ ok: true, agent: { state: 'RUNNING' } });
    expect(r.rebuilding).toBeUndefined();
    expect(w.store.getAgent(a.id)?.hibernatedAt).toBeFalsy();
    expect(w.calls).toEqual([`limits ${a.id}`, `up ${a.id}`, `budget ${a.id}`]);
  });

  it('a start owed a rebuild is that rebuild', async () => {
    process.env.HATCHABOT_REBUILD_CONCURRENCY = '1';
    const w = world();
    const held = holdBuilds(w.provider);
    try {
      // Another rebuild holds the one slot, so this one waits its turn.
      w.life.queue.kickRebuild(w.agent('first').id);
      await tick();
      const a = w.agent('a', { state: 'STOPPED' });
      w.life.queue.oweRebuild(a.id);
      const r = await w.life.power.startStopped(w.store.getAgent(a.id)!, { ownerAsked: true });
      expect(r).toMatchObject({ ok: true, rebuilding: true });
      expect(w.events.find((e) => e.event === 'rebuild.on_start')?.detail).toEqual({ reasons: ['a change made while it was down'] });
      // While that rebuild waits its turn, Start is refused in its own words.
      expect(w.life.power.startRefusal(w.store.getAgent(a.id))).toBe('It is being rebuilt; it starts by itself when that is done.');
    } finally { held.releaseAll(); }
  });

  it('refuses a start under a long operation, while busy or archiving, and when not stopped', async () => {
    const w = world();
    const a = w.agent('a', { state: 'STOPPED' });
    expect(w.life.power.startRefusal(undefined)).toBe('Not found');
    expect(w.life.power.startRefusal(w.agent('m', { state: 'STOPPED', migratedTo: 'there' }))).toBe('It moved to there.');
    expect(w.life.power.startRefusal(w.agent('r'))).toBe('Cannot start while RUNNING');
    // The archive's marker is set before its first wait, and Start is refused meanwhile.
    const z = w.agent('z', { state: 'STOPPED' });
    const archived = w.life.records.archive(z, { checkpoint: false, requestedBy: OWNER }, () => 'done');
    expect(w.life.records.isArchiving(z.id)).toBe(true);
    expect(w.life.power.startRefusal(w.store.getAgent(z.id))).toBeTruthy();
    await archived;
    expect(w.life.records.isArchiving(z.id)).toBe(false);
    markBusy(a.id); busyIds.push(a.id);
    expect(w.life.power.startRefusal(a)).toBe('Another operation is already running on this agent.');
    expect(w.life.power.startRefusal(a, true)).toBeUndefined();
    clearBusy(a.id);
    beginOperation(w.store, 'move-host', a.id, {});
    expect(w.life.power.startRefusal(a)).toMatch(/./);
    expect(w.life.power.startRefusal(a)).not.toBe('Another operation is already running on this agent.');
  });

  it('stops a running agent under its lock, the answer made while the lock is held', async () => {
    const w = world();
    const a = w.agent('a');
    let busyInAnswer = false;
    const r = await w.life.power.stopRunning(a.id, (stopped) => { busyInAnswer = isBusy(a.id); return stopped.state; });
    expect(r).toEqual({ ok: true, value: 'STOPPED' });
    expect(busyInAnswer).toBe(true);
    expect(isBusy(a.id)).toBe(false);
    expect(w.calls).toEqual([`disown ${a.id}`]);
    expect(await w.life.power.stopRunning(a.id, () => 'x')).toEqual({ ok: false, error: 'Cannot stop while STOPPED' });
  });

  it('puts an agent to sleep and wakes it', async () => {
    const w = world();
    const a = w.agent('a');
    const slept = await w.life.power.hibernate(a, 'by hand');
    expect(slept).toMatchObject({ state: 'STOPPED' });
    expect(slept.hibernatedAt).toBeTruthy();
    const woken = await w.life.power.wake(slept, 'by hand');
    expect(woken.state).toBe('RUNNING');
    expect(woken.hibernatedAt).toBeFalsy();
  });

  it('says why it does not sleep when hibernation is off', async () => {
    const before = process.env.HATCHABOT_HIBERNATE_AFTER;
    delete process.env.HATCHABOT_HIBERNATE_AFTER;
    try {
      const w = world();
      expect(await w.life.power.sleepView(w.agent('a'))).toEqual({ afterMs: 0, asleep: false, policy: null, blocker: 'hibernation is off on this machine (HATCHABOT_HIBERNATE_AFTER)' });
    } finally { if (before !== undefined) process.env.HATCHABOT_HIBERNATE_AFTER = before; }
  });
});

describe('a held operation', () => {
  it('the owner\'s choice goes to the boot\'s recovery', async () => {
    const w = world();
    const a = w.agent('a');
    const op = beginOperation(w.store, 'move-host', a.id, {});
    const after = await w.life.operations.recover(op.id, 'undo');
    expect(after.id).toBe(op.id);
    expect(w.calls).toEqual([`recover ${op.id} undo`]);
  });
});

describe('an agent\'s record: create, archive, unarchive, delete', () => {
  const newAgent = (o: Record<string, unknown> = {}) => ({ name: 'Helper', aiProfileId: 'p1', hostId: 'h1', ...o });
  const open = { capProblem: () => undefined, holdName: () => true };

  it('refuses in order: the source, the machine, a machine going, the cap, the name, a rename under way', () => {
    let going: string | undefined;
    const w = world({ hostGoing: () => going });
    const asked: string[] = [];
    const guards = { capProblem: () => { asked.push('cap'); return undefined; }, holdName: (k: string) => { asked.push(k); return true; } };
    expect(w.life.records.create(OWNER, newAgent({ aiProfileId: 'nope' }), guards)).toEqual({ ok: false, status: 400, error: 'Unknown AI profile' });
    expect(w.life.records.create(OWNER, newAgent({ hostId: 'nope' }), guards)).toEqual({ ok: false, status: 400, error: 'Unknown host' });
    going = 'That host is being removed.';
    expect(w.life.records.create(OWNER, newAgent(), guards)).toEqual({ ok: false, status: 409, error: going });
    going = undefined;
    // Nothing above asked for the cap's place or held the name.
    expect(asked).toEqual([]);
    expect(w.life.records.create(OWNER, newAgent(), { ...guards, capProblem: () => 'made-up cap words' })).toEqual({ ok: false, status: 429, error: 'made-up cap words' });
    w.agent('helper');
    w.store.setAgentName(w.store.listAgents(OWNER)[0]!.id, 'Helper');
    expect(w.life.records.create(OWNER, newAgent({ name: `helper-${worldNo}` }), guards)).toMatchObject({ ok: false, status: 409 });
    expect(w.life.records.create(OWNER, newAgent({ name: 'Other' }), { ...guards, holdName: () => false }))
      .toEqual({ ok: false, status: 409, error: 'An agent of yours is being renamed "Other" right now. Pick another name, or try again in a moment.' });
    expect(w.store.listAgents(OWNER)).toHaveLength(1);
  });

  it('makes the record with what its first setup must know, seeds its members once, and starts setup', async () => {
    const w = world();
    const made = w.life.records.create(OWNER, newAgent({ telegram: false, skipPool: true, seedMembers: ['101', '101', '202'] }), open);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const a = w.store.getAgent(made.agent.id)!;
    expect(a.webOnly).toBe(true);
    expect(w.store.agentHold(a.id, 'skip-pool')).toBe('1');
    expect(w.store.listMemberships(a.id).filter((m) => m.channelUserId).map((m) => m.channelUserId).sort()).toEqual(['101', '202']);
    // Setup is under way (the queue's).
    expect(w.life.queue.isInFlight(a.id)).toBe(true);
    await w.life.queue.inFlight(a.id);
  });

  it('shows the archive\'s step from the click, makes its answer while it shows, and clears it after', async () => {
    const w = world();
    const a = w.agent('a', { state: 'STOPPED' });
    let seenInAnswer: boolean | undefined;
    const p = w.life.records.archive(a, { checkpoint: false, requestedBy: OWNER }, () => { seenInAnswer = w.life.records.isArchiving(a.id); return 'answer'; });
    expect(w.life.records.archivingNow(a.id)?.step).toBe('archiving — stopping it and handing its bot back');
    expect(w.life.records.progressOf(a)).toEqual(w.life.records.archivingNow(a.id));
    const r = await p;
    expect(w.life.records.isArchiving(a.id)).toBe(false);
    if (r.ok) { expect(r.value).toBe('answer'); expect(seenInAnswer).toBe(true); expect(w.store.getAgent(a.id)?.state).toBe('ARCHIVED'); }
    else expect(r.status).toBeGreaterThanOrEqual(409);
    expect(w.events.some((e) => e.event === 'agent.archiving')).toBe(true);
  });

  it('brings an archived agent back: setup kicked before its answer is made, its lock let go', async () => {
    const w = world();
    const a = w.agent('a', { state: 'ARCHIVED', runtimeRef: undefined });
    let setupInAnswer: boolean | undefined;
    await w.life.records.restore(a, () => { setupInAnswer = w.life.queue.isInFlight(a.id); return 'ok'; });
    expect(setupInAnswer).toBe(true);
    expect(w.store.getAgent(a.id)?.state).toBe('PROVISIONING');
    await w.life.queue.inFlight(a.id);
  });

  it('marks a delete under way, and lets an answered setup go on after it', async () => {
    const w = world();
    const a = w.agent('a', { state: 'PROVISIONING' });
    w.store.setAgentPendingAction(a.id, { type: 'bot_token', instructions: 'made up', received: true } as never);
    let during: boolean | undefined;
    await w.life.records.whileDeleting(a.id, async () => { during = w.life.records.isDeleting(a.id); });
    expect(during).toBe(true);
    expect(w.life.records.isDeleting(a.id)).toBe(false);
    expect(w.life.queue.isInFlight(a.id)).toBe(true);
    await w.life.queue.inFlight(a.id);
  });

  it('deletes: refused when busy after the wait, parked FAILED when the runtime will not go, else a tombstone', async () => {
    const w = world();
    const busy = w.agent('busy');
    markBusy(busy.id); busyIds.push(busy.id);
    expect(await w.life.records.remove(busy, {}, () => 'x')).toEqual({ ok: false, status: 409, error: 'Another operation is already running on this agent.' });
    expect(w.store.getAgent(busy.id)?.state).toBe('RUNNING');

    const stuck = w.agent('stuck');
    vi.spyOn(w.provider, 'destroy').mockRejectedValueOnce(new Error('made-up docker refusal'));
    expect(await w.life.records.remove(stuck, {}, () => 'x')).toEqual({ ok: false, status: 502, error: "Couldn't remove the agent's runtime — try Delete again in a moment." });
    expect(w.store.getAgent(stuck.id)?.state).toBe('FAILED');

    const a = w.agent('a');
    const r = await w.life.records.remove(a, {}, (tomb) => tomb.state);
    expect(r).toEqual({ ok: true, value: 'DELETED' });
    expect(w.calls).toContain(`forget ${a.id}`);
    expect(w.calls).toContain(`forget conversations ${a.id}`); // HB-0914
    expect(w.calls).not.toContain(`forget conversations ${stuck.id}`); // parked FAILED: still an agent
  });
});

describe('the agent caps', () => {
  afterEach(() => { delete process.env.HATCHABOT_MAX_AGENTS_PER_ACCOUNT; delete process.env.HATCHABOT_MAX_AGENTS_PER_MEMBER; });

  it('holds a place per request until it is let go, and asks whether the caller owns the machine only for a member\'s ceiling', () => {
    process.env.HATCHABOT_MAX_AGENTS_PER_ACCOUNT = '3';
    const w = world();
    w.agent('a');
    let asked = 0;
    const owner = () => { asked++; return true; };
    expect(w.life.capacity.claim('r1', OWNER, owner)).toBeUndefined();
    // The same request again takes no second place: one more still fits.
    expect(w.life.capacity.claim('r1', OWNER, owner)).toBeUndefined();
    expect(w.life.capacity.claim('r2', OWNER, owner)).toBeUndefined();
    expect(w.life.capacity.claim('r3', OWNER, owner)).toBe("You've reached the limit of 3 agents on this server. Delete one first.");
    expect(asked).toBe(0);
    w.life.capacity.release('r1');
    expect(w.life.capacity.claim('r3', OWNER, owner)).toBeUndefined();
    w.life.capacity.release('r2'); w.life.capacity.release('r3');
    process.env.HATCHABOT_MAX_AGENTS_PER_MEMBER = '1';
    expect(w.life.capacity.claim('r4', OWNER, () => false)).toBe('Members may run up to 1 agents on this server. Delete one first, or ask the host owner.');
    expect(w.life.capacity.claim('r5', OWNER, owner)).toBeUndefined();
    expect(asked).toBe(1);
  });
});

describe('the agent list', () => {
  it('lists the viewer\'s agents with their progress and queue mark, and skips a machine that does not answer', async () => {
    const w = world();
    const a = w.agent('a', { state: 'STOPPED' });
    w.life.queue.oweRebuild(a.id);
    const tiles = await w.life.list.view(OWNER, { all: false, machineOwner: () => true });
    expect(tiles.map((t) => t.id)).toEqual([a.id]);
    expect(tiles[0]).toMatchObject({ state: 'STOPPED', role: 'owner' });
    expect(w.life.list.hostKnownAway('h1')).toBe(false);
    (w.provider as unknown as { awake: boolean }).awake = false;
    await w.life.list.view(OWNER, { all: false, machineOwner: () => true });
    expect(w.life.list.hostKnownAway('h1')).toBe(true);
  });
});
