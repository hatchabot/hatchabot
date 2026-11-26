import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { clearBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import { createAgentSettings, type AgentSettings } from '../src/orchestrator/lifecycle/agentSettings.js';
import { classChangedThrice, classKey, type ClassEdit } from '../src/orchestrator/lifecycle/classChanges.js';
import { keptSaid, memoryCapProblem, swapAllowanceProblem } from '../src/orchestrator/lifecycle/memoryLimits.js';
import { machineLoginOnly, modelOverrideProblem } from '../src/orchestrator/lifecycle/modelRuntime.js';
import { createSourceHolds } from '../src/orchestrator/lifecycle/sourceHolds.js';
import { keyedLock, sixAtATime } from '../src/util/queues.js';

/**
 * The agent settings service (HB-0807): classes, models and memory limits,
 * driven as the routes drive it but with no HTTP server. A real store on an
 * in-memory database, a MockProvider for the machine, and plain functions
 * for what the service asks of its process (the log, the setup and rebuild
 * queue, the turn a save of AGENTS.md takes).
 */
const OWNER = 'user-owner';
const DEFAULT = 'claude-opus-4-8';
const OTHER = 'claude-haiku-4-5';

interface World {
  store: Store;
  provider: MockProvider;
  settings: AgentSettings;
  events: Array<{ agentId?: string; event: string; detail: Record<string, unknown> }>;
  warned: Array<{ event: string; detail: Record<string, unknown> }>;
  /** The setup or rebuild in flight per agent, as the service is told of it. */
  flights: Map<string, Promise<void>>;
  /** A running agent on the machine. */
  agent(id: string, name?: string): Promise<{ id: string; ref: string }>;
}

const busyIds: string[] = [];
const built: AgentSettings[] = [];
afterEach(() => {
  for (const s of built.splice(0)) s.stop();
  for (const id of busyIds.splice(0)) clearBusy(id);
});

function world(): World {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: DEFAULT, models: [OTHER], secretRef: 'ai/p1', createdAt: 'now' });
  const events: World['events'] = [];
  const warned: World['warned'] = [];
  const flights = new Map<string, Promise<void>>();
  const settings = createAgentSettings({
    store,
    providerFor: (hostId) => { if (hostId !== 'h1') throw new Error(`no host ${hostId}`); return provider; },
    trace: (agentId) => (event, detail) => { events.push({ agentId, event, detail }); },
    warn: (detail, event) => { warned.push({ event, detail }); },
    inFlight: (agentId) => flights.get(agentId),
    agentGone: (id) => { const state = store.getAgent(id)?.state; return !state || state === 'DELETED' || state === 'DELETING'; },
    withAgentsMdTurn: (_agentId, fn) => fn(),
    sourceHoldMs: 600_000,
  });
  built.push(settings);
  const agent = async (id: string, name = 'Kitchen') => {
    store.insertAgent({ id, ownerId: OWNER, name, slug: name.toLowerCase(), state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: 'helps cook', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
    const { runtimeRef } = await provider.provision({ agentId: id, slug: name.toLowerCase(), workspace: { files: {}, configPatch: { agentId: name.toLowerCase(), authMode: 'api-key' } }, env: {} });
    store.setAgentRuntimeRef(id, runtimeRef);
    await provider.start(runtimeRef);
    store.setAgentState(id, 'RUNNING');
    return { id, ref: runtimeRef };
  };
  return { store, provider, settings, events, warned, flights, agent };
}

/** A promise a test settles by hand, to hold a step where it is. */
function gate() {
  let open!: () => void;
  const held = new Promise<void>((r) => { open = r; });
  return { held, open };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const modelsSet = (w: World) => w.provider.execLog.filter((argv) => argv[0] === 'models' && argv[1] === 'set').map((argv) => argv[2]);

describe('the queue helpers (src/util/queues.ts)', () => {
  it('keyedLock runs one at a time per key, in order, and a failure does not stop the next', async () => {
    const queues = keyedLock();
    const ran: string[] = [];
    const g = gate();
    const first = queues.run('a', async () => { ran.push('first starts'); await g.held; ran.push('first ends'); throw new Error('first failed'); });
    const second = queues.run('a', async () => { ran.push('second'); return 2; });
    const other = queues.run('b', async () => { ran.push('other key'); return 'b'; });
    expect(await other).toBe('b');
    expect(ran).toEqual(['first starts', 'other key']);
    g.open();
    await expect(first).rejects.toThrow('first failed');
    expect(await second).toBe(2);
    expect(ran).toEqual(['first starts', 'other key', 'first ends', 'second']);
    await tick();
    expect(queues.size).toBe(0); // a queue that emptied is forgotten
  });

  it('sixAtATime keeps six at work at most and answers in the order asked', async () => {
    let atWork = 0, most = 0;
    const out = await sixAtATime([...Array(14).keys()], async (n) => {
      most = Math.max(most, ++atWork);
      await tick();
      atWork--;
      return n * 2;
    });
    expect(most).toBe(6);
    expect(out).toEqual([...Array(14).keys()].map((n) => n * 2));
  });
});

describe('model application', () => {
  it('puts the stored model on a running agent and records it as applied', async () => {
    const w = world(), a = await w.agent('a1');
    w.store.setAgentModel(a.id, OTHER);
    expect(await w.settings.models.applyModelToRuntime(a.id)).toBe('live');
    expect(modelsSet(w)).toEqual([`anthropic/${OTHER}`]);
    expect(w.store.getAgent(a.id)).toMatchObject({ appliedProfileId: 'p1', appliedModel: OTHER });
  });

  it('stages it on a stopped agent\'s volume', async () => {
    const w = world(), a = await w.agent('a1');
    await w.provider.stop(a.ref);
    w.store.setAgentState(a.id, 'STOPPED');
    w.store.setAgentModel(a.id, OTHER);
    expect(await w.settings.models.applyModelToRuntime(a.id)).toBe('staged');
    expect(w.provider.execLog.some((argv) => argv[0] === 'sh-volume' && argv[1]!.includes(`openclaw models set 'anthropic/${OTHER}'`))).toBe(true);
  });

  it('writes one at a time per agent, each reading the model when its turn comes (HB-0323)', async () => {
    const w = world(), a = await w.agent('a1');
    const g = gate(), exec = w.provider.exec.bind(w.provider);
    let held = false;
    w.provider.exec = async (ref, argv, opts) => {
      if (argv[0] === 'models' && !held) { held = true; await g.held; }
      return exec(ref, argv, opts);
    };
    w.store.setAgentModel(a.id, OTHER);
    const first = w.settings.models.applyModelToRuntime(a.id);
    await tick();
    // A newer choice, saved and asked for while the first write is still on its way.
    w.store.setAgentModel(a.id, null);
    const second = w.settings.models.applyModelToRuntime(a.id);
    await tick();
    expect(modelsSet(w)).toEqual([]); // the second waits for the first
    g.open();
    expect(await first).toBe('live');
    expect(await second).toBe('live');
    expect(modelsSet(w)).toEqual([`anthropic/${OTHER}`, `anthropic/${DEFAULT}`]);
    expect(w.store.getAgent(a.id)?.appliedModel).toBe(DEFAULT);
  });

  it('leaves the runtime alone while a setup or rebuild is in flight, or the agent is busy', async () => {
    const w = world(), a = await w.agent('a1');
    w.store.setAgentModel(a.id, OTHER);
    w.flights.set(a.id, new Promise(() => {}));
    expect(await w.settings.models.applyModelToRuntime(a.id)).toBe('none');
    w.flights.delete(a.id);
    markBusy(a.id); busyIds.push(a.id);
    expect(await w.settings.models.applyModelToRuntime(a.id)).toBe('none');
    expect(modelsSet(w)).toEqual([]);
    expect(w.events.filter((e) => e.event === 'model.apply_deferred')).toHaveLength(2);
  });

  it('says a source switch waits for its rebuild, a runtime that refused, and a volume that is gone', async () => {
    const w = world(), a = await w.agent('a1');
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Second', vendor: 'anthropic', kind: 'api_key', model: DEFAULT, secretRef: 'ai/p2', createdAt: 'now' });
    w.store.setAgentApplied(a.id, 'p2', DEFAULT);
    expect(await w.settings.models.applyModelToRuntime(a.id)).toBe('rebuild');
    w.store.setAgentApplied(a.id, 'p1', DEFAULT);
    w.provider.execResponses.set('models set', { code: 1, stdout: '', stderr: 'no such model' });
    expect(await w.settings.models.applyModelToRuntime(a.id)).toBe('failed');
    expect(w.events.at(-1)).toMatchObject({ agentId: a.id, event: 'model.live_set_failed' });
    await w.provider.stop(a.ref);
    w.store.setAgentState(a.id, 'STOPPED');
    w.provider.goneVolumes.add(a.ref);
    expect(await w.settings.models.applyModelToRuntime(a.id)).toBe('gone');
  });

  it('refuses a model its source does not offer, and any of its own on a local source', async () => {
    const w = world(), a = await w.agent('a1');
    const agent = w.store.getAgent(a.id)!, profile = w.store.getAIProfile('p1')!;
    expect(await w.settings.models.modelChoiceProblem(agent, profile, 'made-up-model')).toMatchObject({ status: 400 });
    expect(await w.settings.models.modelChoiceProblem(agent, profile, OTHER)).toBeUndefined();
    expect(await w.settings.models.modelChoiceProblem(agent, profile, null)).toBeUndefined();
    expect(modelOverrideProblem({ ...profile, vendor: 'local' }, OTHER)).toMatch(/Local sources run one model/);
    expect(modelOverrideProblem(profile, null)).toBeUndefined();
    expect(machineLoginOnly({ ...profile, kind: 'subscription', secretRef: undefined })).toBe(true);
    expect(machineLoginOnly(profile)).toBe(false);
  });
});

describe('memory limits', () => {
  it('puts the limits that apply on the container, as stored or with a change of its own', async () => {
    const w = world(), a = await w.agent('a1');
    w.store.setAgentMemoryCap(a.id, '4g');
    expect(await w.settings.limits.applyCurrentLimits(a.id)).toMatchObject({ applied: { memory: '4g' } });
    expect(await w.settings.limits.applyCurrentLimits(a.id, { change: { memoryCap: '6g' } })).toMatchObject({ applied: { memory: '6g' } });
    expect(w.provider.memoryUpdates.map((u) => u.cap)).toEqual(['4g', '6g']);
    expect(w.store.getAgent(a.id)?.memoryCap).toBe('4g'); // a change is the caller's to store
  });

  it('a class path leaves an agent with a cap and a swap allowance of its own alone', async () => {
    const w = world(), a = await w.agent('a1');
    w.store.setAgentMemoryCap(a.id, '4g');
    w.store.setAgentSwapAllowance(a.id, 'off');
    expect(await w.settings.limits.limitsTold(a.id)).toEqual({});
    expect(w.provider.memoryUpdates).toEqual([]);
  });

  it('keeps a change for a machine that does not answer, and refuses it on one that does', async () => {
    const w = world(), a = await w.agent('a1');
    w.provider.updateMemory = async () => { throw new Error('docker said no'); };
    const refused = await w.settings.limits.applyCurrentLimits(a.id, { change: { memoryCap: '6g' } });
    expect(refused).toHaveProperty('refused');
    w.provider.awake = false;
    const kept = await w.settings.limits.applyCurrentLimits(a.id, { change: { memoryCap: '6g' } });
    expect(kept.memoryPending).toMatch(/kept its old memory limits/);
    expect(keptSaid('Kitchen', kept)).toEqual({ memoryPending: kept.memoryPending, limitsKept: { name: 'Kitchen', why: kept.why } });
    expect(keptSaid('Kitchen', {})).toEqual({});
  });

  it('gives each agent one turn at a time for its limits', async () => {
    const w = world(), a = await w.agent('a1'), b = await w.agent('a2', 'Garden');
    const g = gate(), ran: string[] = [];
    const first = w.settings.limits.inLimitsTurn(a.id, async () => { ran.push('first starts'); await g.held; ran.push('first ends'); });
    const second = w.settings.limits.inLimitsTurn(a.id, async () => { ran.push('second'); });
    await w.settings.limits.inLimitsTurn(b.id, async () => { ran.push('another agent'); });
    expect(ran).toEqual(['first starts', 'another agent']);
    g.open();
    await Promise.all([first, second]);
    expect(ran).toEqual(['first starts', 'another agent', 'first ends', 'second']);
  });

  it('sets an agent\'s own cap on its container and hands back the record to store', async () => {
    const w = world(), a = await w.agent('a1');
    const agent = w.store.getAgent(a.id)!;
    const set = await w.settings.limits.setMemoryCap(agent, '4096m', () => false);
    expect(set).toMatchObject({ applied: '4g', own: '4g', live: true });
    expect(w.store.getAgent(a.id)?.memoryCap).toBeUndefined();
    set.record!();
    expect(w.store.getAgent(a.id)?.memoryCap).toBe('4g');
    expect(w.events.at(-1)).toMatchObject({ agentId: a.id, event: 'memory.cap_set', detail: { cap: '4g' } });
    expect(await w.settings.limits.setMemoryCap(agent, 'lots', () => true)).toMatchObject({ error: expect.stringMatching(/looks like/) });
  });

  it('holds a member to the per-agent maximum, and lets the machine\'s owner past it', async () => {
    const w = world(), a = await w.agent('a1');
    const agent = w.store.getAgent(a.id)!;
    let asked = 0;
    const member = () => { asked++; return false; };
    expect(memoryCapProblem('4g', member)).toBeUndefined();
    expect(asked).toBe(0); // whose machine it is only matters above the maximum
    expect(memoryCapProblem('64g', member)).toMatchObject({ status: 403 });
    expect(memoryCapProblem('64g', () => true)).toBeUndefined();
    expect(memoryCapProblem('a lot', member)).toMatchObject({ status: 400 });
    expect(await w.settings.limits.setMemoryCap(agent, '64g', member)).toMatchObject({ status: 403 });
    expect(w.provider.memoryUpdates).toEqual([]);
    expect(swapAllowanceProblem('2g', '1g', member)).toMatchObject({ status: 400, error: expect.stringMatching(/At most the memory cap/) });
    expect(swapAllowanceProblem('some', '4g', member)).toMatchObject({ status: 400 });
    expect(swapAllowanceProblem('off', '4g', member)).toBeUndefined();
  });

  it('stop() ends the wait for an agent that stays busy, and nothing is told after it', async () => {
    const w = world(), a = await w.agent('a1');
    markBusy(a.id); busyIds.push(a.id);
    const telling = w.settings.limits.tellMemoryBudget(a.id);
    await tick();
    let done = false;
    void telling.then(() => { done = true; });
    await tick();
    expect(done).toBe(false); // it waits for the agent to be free (up to half an hour)
    w.settings.stop();
    await telling;
    const execs = w.provider.execLog.length;
    await w.settings.limits.tellMemoryBudget(a.id);
    expect(w.provider.execLog.length).toBe(execs);
    expect(w.events.filter((e) => e.event === 'memory.budget_not_told')).toEqual([]);
  });
});

describe('class changes', () => {
  const fast = (w: World, extra: { model?: string; memoryCap?: string } = { model: OTHER }) => {
    w.store.upsertAgentClass({ id: 'c1', ownerId: OWNER, name: 'Fast', ...extra });
    return w.store.getAgentClass('c1')!;
  };
  const ledgerOf = () => {
    const seen: Array<Map<string, string | undefined>> = [];
    return { seen, ledger: (before: Map<string, string | undefined>) => { seen.push(before); } };
  };

  it('a join is checked outside the class\'s queue, written in it, and its model put on after', async () => {
    const w = world(), a = await w.agent('a1'), cls = fast(w), { classes } = w.settings, { seen, ledger } = ledgerOf();
    const check = await classes.checkClassFor(w.store.getAgent(a.id)!, cls);
    expect(check).toMatchObject({ for: classKey(cls, false), switching: false, imageChange: false });
    const wrote = await classes.inClassQueue([null, cls.id], async () => classes.applyClassToAgent(w.store.getAgent(a.id)!, cls, check, { from: null, ledger }));
    expect(wrote).toMatchObject({ rebuild: false });
    expect(w.store.getAgent(a.id)).toMatchObject({ classId: 'c1', model: OTHER });
    expect(seen).toHaveLength(1); // the model change goes in the ledger as the class's
    expect(modelsSet(w)).toEqual([]); // nothing in the queue asks its machine
    expect(await wrote.finish!()).toEqual({ rebuild: false });
    expect(modelsSet(w)).toEqual([`anthropic/${OTHER}`]);
    expect(classes.asItsClassWroteIt(a.id)).toBe(true);
  });

  it('a change of its own made since its check stands: nothing of the class is written', async () => {
    const w = world(), a = await w.agent('a1'), cls = fast(w), { classes } = w.settings;
    const check = await classes.checkClassFor(w.store.getAgent(a.id)!, cls);
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Second', vendor: 'anthropic', kind: 'api_key', model: DEFAULT, models: [OTHER], secretRef: 'ai/p2', createdAt: 'now' });
    w.store.setAgentAIProfile(a.id, 'p2');
    expect(classes.applyClassToAgent(w.store.getAgent(a.id)!, cls, check, { from: null })).toEqual({ rebuild: false, changed: true });
    expect(w.store.getAgent(a.id)?.classId).toBeUndefined();
    expect(classes.asItsClassWroteIt(a.id)).toBe(false);
  });

  it('refuses a class whose model its source does not offer, at the check', async () => {
    const w = world(), a = await w.agent('a1'), cls = fast(w, { model: 'made-up-model' });
    const check = await w.settings.classes.checkClassFor(w.store.getAgent(a.id)!, cls);
    expect(check).toMatchObject({ error: expect.stringMatching(/isn’t one of this source’s models/) });
    expect(w.settings.classes.applyClassToAgent(w.store.getAgent(a.id)!, cls, check, { from: null })).toMatchObject({ rebuild: false, error: expect.any(String) });
    expect(w.store.getAgent(a.id)?.classId).toBeUndefined();
  });

  it('an edit writes the class and its members in its turn, and their containers after it', async () => {
    const w = world(), a = await w.agent('a1'), b = await w.agent('a2', 'Garden'), { classes } = w.settings, { seen, ledger } = ledgerOf();
    const cls = fast(w, {});
    for (const id of [a.id, b.id]) w.store.setAgentClassIf(id, null, 'c1');
    const edit: ClassEdit = { cls, row: JSON.stringify(cls), name: 'Fast', model: OTHER, memoryCap: '4g', b: { memoryCap: '4g' } };
    const checks = await classes.checkEditMembers(edit);
    expect([...checks.keys()].sort()).toEqual(['a1', 'a2']);
    const step = await classes.inClassQueue(['c1'], async () => classes.writeClassEdit(edit, checks, false, ledger));
    expect(w.store.getAgentClass('c1')).toMatchObject({ model: OTHER, memoryCap: '4g' });
    expect(w.store.getAgent(a.id)?.model).toBe(OTHER);
    expect(w.store.getAgent(b.id)?.model).toBe(OTHER);
    expect(seen).toHaveLength(2); // each member's model change on its own
    expect(modelsSet(w)).toEqual([]);
    expect(w.provider.memoryUpdates).toEqual([]);
    if (!('later' in step)) throw new Error('the edit was not written');
    expect(await step.later()).toMatchObject({ applied: 2, needRebuild: 0, skipped: [], modelPending: [] });
    expect(modelsSet(w)).toEqual([`anthropic/${OTHER}`, `anthropic/${OTHER}`]);
    expect(w.provider.memoryUpdates.map((u) => u.cap)).toEqual(['4g', '4g']);
  });

  it('an edit whose checks no longer fit asks for them again, and gives up on its last try with nothing written', async () => {
    const w = world(), a = await w.agent('a1'), { classes } = w.settings, { ledger } = ledgerOf();
    const cls = fast(w, {});
    const edit: ClassEdit = { cls, row: JSON.stringify(cls), name: 'Fast', model: OTHER, b: {} };
    const checks = await classes.checkEditMembers(edit); // made before this agent joined
    w.store.setAgentClassIf(a.id, null, 'c1');
    expect(classes.writeClassEdit(edit, checks, false, ledger)).toEqual({ again: true });
    expect(classes.writeClassEdit(edit, checks, true, ledger)).toBe(classChangedThrice);
    expect(w.store.getAgentClass('c1')?.model).toBeUndefined();
    expect(w.store.getAgent(a.id)?.model).toBeUndefined();
  });

  it('an edit tried again keeps a check that still fits, but not for a member with a rebuild under way or busy (HB-0642)', async () => {
    const w = world(), { classes } = w.settings;
    const a = await w.agent('a1'), b = await w.agent('a2', 'Garden'), c = await w.agent('a3', 'Pantry');
    const cls = fast(w, {});
    for (const id of [a.id, b.id, c.id]) w.store.setAgentClassIf(id, null, 'c1');
    w.provider.tags.push({ tag: 'hatchabot-runtime:newer', imageId: 'newer-image', openclawVersion: '2026.9.8' });
    const reads = new Map<string, number>();
    const info = w.provider.info.bind(w.provider);
    w.provider.info = async (r) => { reads.set(r ?? '', (reads.get(r ?? '') ?? 0) + 1); return info(r); };
    const edit: ClassEdit = { cls, row: JSON.stringify(cls), name: 'Fast', image: 'hatchabot-runtime:newer', b: {} };
    const first = await classes.checkEditMembers(edit);
    // Nothing in their records changed since: one is being rebuilt, one is busy (a backup), one has nothing under way.
    const rebuild = gate();
    w.flights.set(a.id, rebuild.held);
    markBusy(b.id); busyIds.push(b.id);
    const second = await classes.checkEditMembers(edit, first);
    expect(second.get(c.id)).toBe(first.get(c.id));
    expect(second.get(a.id)).not.toBe(first.get(a.id));
    expect(second.get(b.id)).not.toBe(first.get(b.id));
    expect([a.ref, b.ref, c.ref].map((r) => reads.get(r))).toEqual([2, 2, 1]);
    rebuild.open();
  });

  it('takes the class off an agent that drifted from it, and puts the limits that apply on its container', async () => {
    const w = world(), a = await w.agent('a1'), { classes } = w.settings;
    fast(w, { model: OTHER, memoryCap: '4g' });
    w.store.setAgentClassIf(a.id, null, 'c1');
    w.store.setAgentModel(a.id, OTHER);
    expect(classes.detachClassIfDrifted(a.id)).toEqual({ detached: false }); // it runs what its class sets
    const dropped = w.store.transact(() => { w.store.setAgentModel(a.id, null); return classes.detachClassIfDrifted(a.id); });
    expect(dropped.detached).toBe(true);
    expect(w.store.getAgent(a.id)?.classId).toBeUndefined();
    expect(await dropped.limits).toMatchObject({ applied: expect.anything() });
    expect(w.provider.memoryUpdates).toHaveLength(1);
  });

  it('decides a detach once an edit of its class under way is done', async () => {
    const w = world(), a = await w.agent('a1'), { classes } = w.settings;
    fast(w);
    w.store.setAgentClassIf(a.id, null, 'c1');
    classes.classEditBegun('c1');
    expect(classes.detachClassIfDrifted(a.id)).toEqual({ detached: 'pending' }); // on the default, the class asks for another
    await tick();
    expect(w.store.getAgent(a.id)?.classId).toBe('c1');
    classes.classEditEnded('c1');
    await tick();
    expect(w.store.getAgent(a.id)?.classId).toBeUndefined();
    expect(w.events.some((e) => e.event === 'class.detached' && e.agentId === a.id)).toBe(true);
  });

  it('queues for several classes in one order, so two moves the other way round do not wait on each other', async () => {
    const w = world(), { classes } = w.settings, ran: string[] = [];
    const one = classes.inClassQueue(['c1', 'c2'], async () => { ran.push('one starts'); await tick(); ran.push('one ends'); });
    const two = classes.inClassQueue(['c2', null, 'c1'], async () => { ran.push('two'); });
    await Promise.all([one, two]);
    expect(ran).toEqual(['one starts', 'one ends', 'two']);
  });

  it('forgets what it kept for an agent that is gone', async () => {
    const w = world(), a = await w.agent('a1'), cls = fast(w), { classes } = w.settings;
    const check = await classes.checkClassFor(w.store.getAgent(a.id)!, cls);
    classes.applyClassToAgent(w.store.getAgent(a.id)!, cls, check, { from: null });
    expect(classes.asItsClassWroteIt(a.id)).toBe(true);
    expect(classes.modelWaitingForImage(a.id)).toBeUndefined();
    w.settings.forgetAgent(a.id);
    expect(classes.asItsClassWroteIt(a.id)).toBe(false);
  });
});

describe('source holds', () => {
  it('holds a source while a switch onto it is written, and lets go when it ends, failed or not', async () => {
    const w = world(), { withSourceHold, sourceHeld } = w.settings.sourceHolds, g = gate();
    const switching = withSourceHold('p1', async () => { await g.held; throw new Error('the switch failed'); });
    expect(sourceHeld('p1')).toBe(true);
    expect(sourceHeld('p2')).toBe(false);
    expect(await withSourceHold(undefined, async () => sourceHeld('p2'))).toBe(false); // no source named, no hold
    g.open();
    await expect(switching).rejects.toThrow('the switch failed');
    expect(sourceHeld('p1')).toBe(false);
  });

  it('a hold that outlived its limit no longer counts, and is logged once', async () => {
    const warned: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const { withSourceHold, sourceHeld } = createSourceHolds({ holdMs: 10, warn: (detail, event) => { warned.push({ event, detail }); } });
    const g = gate();
    const stuck = withSourceHold('p1', () => g.held);
    expect(sourceHeld('p1')).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(sourceHeld('p1')).toBe(false);
    expect(sourceHeld('p1')).toBe(false);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ event: 'source.hold_expired', detail: { source: 'p1' } });
    g.open();
    await stuck;
  });
});
