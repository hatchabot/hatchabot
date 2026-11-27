import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { busyWaiters, clearBusy, heldFor, isBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import { createAgentSettings, type AgentSettings } from '../src/orchestrator/lifecycle/agentSettings.js';
import type { OwedRefusal } from '../src/orchestrator/lifecycle/modelRuntime.js';
import type { ClassEdit } from '../src/orchestrator/lifecycle/classChanges.js';
import { buildRuntimeSpec, finishInterruptedRebuild, NAME_TAKEN_WHY, recordApplied, reindexMemoryIfSwitched, runProvisionSteps, SKIP_POOL, waitsForItsOwner, type ProvisionDeps } from '../src/orchestrator/lifecycle/provision.js';
import { ChannelSetupRequired, type ChannelProvisioner } from '../src/channels/channel.js';
import { embedKeyHash } from '../src/embedder/embedder.js';
import { memoryBudgetSection } from '../src/domain/memoryCap.js';
import { as, makeWorld, restartWorld, seedRunningAgent, type World } from './support/world.js';
import { MACHINE, runBudgets, type BudgetDeps } from '../src/orchestrator/usage/budgets.js';
import { createMonthlyBudgets } from '../src/orchestrator/usage/monthlyBudgets.js';
import { HOUR_FIELDS, type WindowModelStats } from '../src/orchestrator/usage/usage.js';
import type { Agent } from '../src/domain/types.js';
import { beginOperation, handleFor, oweStart, startOwedIn } from '../src/orchestrator/lifecycle/operations.js';
import { createAiSources } from '../src/orchestrator/sources/aiSources.js';
import { rollbackMarkPath, takeRollbackMark } from '../src/store/rollbackMark.js';
import { startCutOffDownloads } from '../src/orchestrator/transfer/transfer.js';
import { reconcileAgents } from '../src/orchestrator/lifecycle/reconcile.js';
import { eventLabel } from '../src/orchestrator/health/eventLabels.js';
import { forgetDmPolicy } from '../src/orchestrator/channels/dmPolicyMemo.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * What a restart may not lose (HB-0809; HB-0820, HB-0830).
 *
 * Each test builds a hold in one process, "restarts" Hatchabot in the middle
 * of it, and checks the hold's effect in the next process. A restart here is
 * what it is on a machine: the database and the containers are as they were,
 * and everything the process held in memory is gone. So the next process is
 * a NEW Store over the same database and a NEW service (or new routes) over
 * the same MockProvider; the old one is stopped and never asked again, with
 * whatever it was in the middle of left where it stood.
 *
 * The data is made up.
 */
const OWNER = 'user-owner';
const DEFAULT = 'claude-opus-4-8';
const OTHER = 'claude-haiku-4-5';
const OPUS55 = 'claude-opus-5-5', SONNET = 'claude-sonnet-5';
const NEW_IMAGE = 'hatchabot-runtime:newer-trial';

interface Life {
  store: Store;
  settings: AgentSettings;
  /** The setup or rebuild in flight per agent, as this process's service is told of it. */
  flights: Map<string, Promise<void>>;
}
interface House {
  provider: MockProvider;
  events: Array<{ agentId?: string; event: string; detail: Record<string, unknown> }>;
  /** The process running now. */
  now: Life;
  /** Hatchabot restarts: the process running now is gone, and a new one is built over the same database and machine. */
  restart(): Life;
  /** A running agent on the machine (the owner's, unless another account's is given). */
  agent(id: string, name?: string, owner?: string): Promise<{ id: string; ref: string }>;
  /** The pause between two looks for a container that is not up yet (afterRestart.ts): no real wait here. */
  pause: (ms: number) => Promise<void>;
  /** Told of an owed model the runtime refused at a start (modelRuntime.ts, HB-1404): the budgets' hook, where a test wires one. */
  owedRefused?: (agentId: string, ask: string, how?: OwedRefusal) => void;
  /** What src/index.ts does with the store before anything else at a start, where a test sets it (takeRollbackMark, HB-0840). */
  atStart?: (store: Store) => void;
}

const lives: Life[] = [];
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const l of lives.splice(0)) l.settings.stop();
  for (const c of closers.splice(0)) await c();
});

function house(): House {
  const db = new Database(':memory:');
  const provider = new MockProvider();
  const events: House['events'] = [];
  const boot = (): Life => {
    const store = new Store(db);
    h.atStart?.(store);
    const flights = new Map<string, Promise<void>>();
    const settings = createAgentSettings({
      store,
      providerFor: (hostId) => { if (hostId !== 'h1') throw new Error(`no host ${hostId}`); return provider; },
      trace: (agentId) => (event, detail) => { events.push({ agentId, event, detail }); },
      warn: () => {},
      inFlight: (agentId) => flights.get(agentId),
      agentGone: (id) => { const state = store.getAgent(id)?.state; return !state || state === 'DELETED' || state === 'DELETING'; },
      withAgentsMdTurn: (_agentId, fn) => fn(),
      sleep: (ms) => h.pause(ms),
      owedRefused: (agentId, ask, how) => h.owedRefused?.(agentId, ask, how),
    });
    const life = { store, settings, flights };
    lives.push(life);
    return life;
  };
  const h: House = {
    provider, events,
    pause: async () => {},
    now: undefined as never,
    restart() { h.now.settings.stop(); h.now = boot(); return h.now; },
    async agent(id, name = 'Kitchen', owner = OWNER) {
      const { store } = h.now;
      store.insertAgent({ id, ownerId: owner, name, slug: name.toLowerCase(), state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: 'helps cook', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
      const { runtimeRef } = await provider.provision({ agentId: id, slug: name.toLowerCase(), workspace: { files: {}, configPatch: { agentId: name.toLowerCase(), authMode: 'api-key' } }, env: {} });
      store.setAgentRuntimeRef(id, runtimeRef);
      await provider.start(runtimeRef);
      store.setAgentState(id, 'RUNNING');
      // What its container was made with, as a setup records it.
      store.setAgentApplied(id, 'p1', DEFAULT);
      return { id, ref: runtimeRef };
    },
  };
  h.now = boot();
  h.now.store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  h.now.store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: DEFAULT, models: [OTHER], secretRef: 'ai/p1', createdAt: 'now' });
  return h;
}

/** A promise a test settles by hand, to hold a step where it is. */
function gate() {
  let open!: () => void;
  const held = new Promise<void>((r) => { open = r; });
  return { held, open };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const settle = async (done: () => boolean, ms = 2000) => { for (let i = 0; i < ms / 10 && !done(); i++) await new Promise((r) => setTimeout(r, 10)); };
const modelsSet = (p: MockProvider) => p.execLog.filter((argv) => argv[0] === 'models' && argv[1] === 'set').map((argv) => argv[2]);
describe('the store keeps what a restart may not lose (agent_holds)', () => {
  it('one value per agent and kind, let go by name or only while it is still the value given', () => {
    const h = house(), { store } = h.now;
    store.setAgentHold('a1', 'class-detach', 'c1');
    store.setAgentHold('a1', 'class-detach', 'c2'); // replaces
    store.setAgentHold('a2', 'class-detach', 'c1');
    store.setAgentHold('a1', 'model-waits-image', OTHER);
    expect(store.agentHold('a1', 'class-detach')).toBe('c2');
    expect(store.agentHolds('class-detach').map((x) => [x.agentId, x.value]).sort()).toEqual([['a1', 'c2'], ['a2', 'c1']]);
    expect(store.clearAgentHold('a1', 'class-detach', 'c1')).toBe(false); // another's by now
    expect(store.agentHold('a1', 'class-detach')).toBe('c2');
    expect(store.clearAgentHold('a1', 'class-detach', 'c2')).toBe(true);
    expect(store.clearAgentHold('a2', 'class-detach')).toBe(true);
    expect(store.agentHolds('class-detach')).toEqual([]);
    expect(store.agentHold('a1', 'model-waits-image')).toBe(OTHER);
    // A new process reads what the last one kept.
    expect(h.restart().store.agentHold('a1', 'model-waits-image')).toBe(OTHER);
  });

  it('a deleted agent keeps none', async () => {
    const h = house(), a = await h.agent('a1'), { store } = h.now;
    store.setAgentHold(a.id, 'model-waits-image', OTHER);
    store.setAgentHold(a.id, 'model-apply', 'ask-1');
    store.scrubAgentResidue(a.id);
    expect(store.agentHold(a.id, 'model-waits-image')).toBeUndefined();
    expect(store.agentHold(a.id, 'model-apply')).toBeUndefined();
  });
});

describe('a model stored and not yet on its runtime when the process ends', () => {
  it('HB-0834 review: six agents busy at the boot hold up no other agent\'s model: each waits for its own outside the six', async () => {
    const h = house();
    const agents: Array<{ id: string; ref: string }> = [];
    for (const [i, name] of ['Kitchen', 'Garden', 'Laundry', 'Pantry', 'Porch', 'Attic', 'Cellar'].entries()) agents.push(await h.agent(`a${i + 1}`, name));
    for (const a of agents) h.now.store.setAgentModel(a.id, OTHER, { apply: true });
    const next = h.restart();
    // The first six asked are held by something else (a backup each).
    const order = next.store.agentHolds('model-apply').map((x) => x.agentId);
    const busyOnes = order.slice(0, 6), last = order[6]!;
    for (const id of busyOnes) markBusy(id);
    const resumed = next.settings.resume();
    await settle(() => next.store.getAgent(last)?.appliedModel === OTHER);
    // Was: the seventh waited until the six were free (up to five half hours each).
    expect(next.store.getAgent(last)?.appliedModel).toBe(OTHER);
    expect(busyOnes.map((id) => next.store.getAgent(id)?.appliedModel)).toEqual(busyOnes.map(() => DEFAULT));
    for (const id of busyOnes) clearBusy(id);
    await resumed;
    expect(order.map((id) => next.store.getAgent(id)?.appliedModel)).toEqual(order.map(() => OTHER));
    expect(next.store.agentHolds('model-apply')).toEqual([]);
  });

  it('is put on by the next process: the ask was stored with the model', async () => {
    const h = house(), a = await h.agent('a1');
    // The model route's write, and then the process ends: the runtime was never told.
    h.now.store.setAgentModel(a.id, OTHER, { apply: true });
    expect(h.now.store.agentHold(a.id, 'model-apply')).toBeTruthy();
    expect(modelsSet(h.provider)).toEqual([]);

    const next = h.restart();
    expect(next.store.getAgent(a.id)).toMatchObject({ model: OTHER, appliedModel: DEFAULT }); // waiting, as the page shows it
    await next.settings.resume();
    expect(modelsSet(h.provider)).toEqual([`anthropic/${OTHER}`]);
    expect(next.store.getAgent(a.id)?.appliedModel).toBe(OTHER);
    expect(next.store.agentHold(a.id, 'model-apply')).toBeUndefined();
    expect(h.events.filter((e) => e.event === 'model.after_restart')).toEqual([{ agentId: a.id, event: 'model.after_restart', detail: { model: OTHER, how: 'live' } }]);
    // Once: a third process has nothing left to do.
    await h.restart().settings.resume();
    expect(modelsSet(h.provider)).toEqual([`anthropic/${OTHER}`]);
  });

  it('is put on though its write was under way when the process ended', async () => {
    const h = house(), a = await h.agent('a1');
    const exec = h.provider.exec.bind(h.provider);
    // The first process's `models set` never answers: it ends in the middle of it.
    h.provider.exec = async (ref, argv, opts) => { if (argv[0] === 'models') await new Promise(() => {}); return exec(ref, argv, opts); };
    h.now.store.setAgentModel(a.id, OTHER, { apply: true });
    void h.now.settings.models.applyModelToRuntime(a.id).catch(() => undefined);
    await tick();
    expect(h.now.store.agentHold(a.id, 'model-apply')).toBeTruthy(); // asked until the runtime has answered

    h.provider.exec = exec;
    const next = h.restart();
    await next.settings.resume();
    expect(modelsSet(h.provider)).toEqual([`anthropic/${OTHER}`]);
    expect(next.store.getAgent(a.id)?.appliedModel).toBe(OTHER);
  });

  it('a caller that stored it without asking is covered from the moment it queues the write', async () => {
    const h = house(), a = await h.agent('a1');
    const exec = h.provider.exec.bind(h.provider);
    h.provider.exec = async (ref, argv, opts) => { if (argv[0] === 'models') await new Promise(() => {}); return exec(ref, argv, opts); };
    h.now.store.setAgentModel(a.id, OTHER); // no ask with the write
    expect(h.now.store.agentHold(a.id, 'model-apply')).toBeUndefined();
    void h.now.settings.models.applyModelToRuntime(a.id).catch(() => undefined);
    expect(h.now.store.agentHold(a.id, 'model-apply')).toBeTruthy(); // asked as it is queued, before any wait
    await tick(); // its write is on its way, and never answers

    h.provider.exec = exec;
    await h.restart().settings.resume();
    expect(modelsSet(h.provider)).toEqual([`anthropic/${OTHER}`]);
  });

  it('a model stored with no ask is left for its rebuild, as before: a start applies only what was asked for', async () => {
    const h = house(), a = await h.agent('a1');
    h.now.store.setAgentModel(a.id, OTHER); // PATCH's write: it says "applies at the next rebuild"
    const next = h.restart();
    await next.settings.resume();
    expect(modelsSet(h.provider)).toEqual([]);
    expect(next.store.getAgent(a.id)).toMatchObject({ model: OTHER, appliedModel: DEFAULT });
  });

  it('the ask goes once the runtime was asked, whether it took the model or refused it', async () => {
    const h = house(), a = await h.agent('a1'), { store, settings } = h.now;
    store.setAgentModel(a.id, OTHER, { apply: true });
    expect(await settings.models.applyModelToRuntime(a.id)).toBe('live');
    expect(store.agentHold(a.id, 'model-apply')).toBeUndefined();

    h.provider.execResponses.set('models set', { code: 1, stdout: '', stderr: 'no such model' });
    store.setAgentModel(a.id, null, { apply: true });
    expect(await settings.models.applyModelToRuntime(a.id)).toBe('failed'); // its caller said so
    expect(store.agentHold(a.id, 'model-apply')).toBeUndefined();
    const asked = modelsSet(h.provider).length;
    await h.restart().settings.resume();
    expect(modelsSet(h.provider)).toHaveLength(asked); // a refusal is not tried again at every start
  });

  it('put off because the agent was busy, it stays asked and the next start puts it on', async () => {
    const h = house(), a = await h.agent('a1'), { store, settings } = h.now;
    markBusy(a.id);
    store.setAgentModel(a.id, OTHER, { apply: true });
    expect(await settings.models.applyModelToRuntime(a.id)).toBe('none');
    expect(store.agentHold(a.id, 'model-apply')).toBeTruthy();
    clearBusy(a.id);

    const next = h.restart();
    await next.settings.resume();
    expect(modelsSet(h.provider)).toEqual([`anthropic/${OTHER}`]);
    expect(next.store.agentHold(a.id, 'model-apply')).toBeUndefined();
  });

  it('only the ask it began with goes: one made while it wrote is for the later write', async () => {
    const h = house(), a = await h.agent('a1'), { store, settings } = h.now;
    const g = gate(), exec = h.provider.exec.bind(h.provider);
    let held = false;
    h.provider.exec = async (ref, argv, opts) => { if (argv[0] === 'models' && !held) { held = true; await g.held; } return exec(ref, argv, opts); };
    store.setAgentModel(a.id, OTHER, { apply: true });
    const first = settings.models.applyModelToRuntime(a.id);
    await tick();
    // A newer choice stored while the first write is on its way; the process ends before its own write is queued.
    store.setAgentModel(a.id, null, { apply: true });
    const second = store.agentHold(a.id, 'model-apply');
    g.open();
    expect(await first).toBe('live');
    expect(store.agentHold(a.id, 'model-apply')).toBe(second);

    const next = h.restart();
    await next.settings.resume();
    expect(modelsSet(h.provider)).toEqual([`anthropic/${OTHER}`, `anthropic/${DEFAULT}`]);
    expect(next.store.getAgent(a.id)?.appliedModel).toBe(DEFAULT);
  });

  it('a later write that changes the model without asking ends the ask', async () => {
    const h = house(), a = await h.agent('a1'), { store } = h.now;
    store.setAgentModel(a.id, OTHER, { apply: true });
    store.setAgentModel(a.id, OTHER); // the same model again: the ask stands
    expect(store.agentHold(a.id, 'model-apply')).toBeTruthy();
    store.setAgentModel(a.id, null); // another: that ask was for a model it no longer has
    expect(store.agentHold(a.id, 'model-apply')).toBeUndefined();
    await h.restart().settings.resume();
    expect(modelsSet(h.provider)).toEqual([]);
  });

  it('is not put on a runtime that would refuse it, nor while it waits for the image that can run it', async () => {
    const h = house(), a = await h.agent('a1'), { store } = h.now;
    store.insertAIProfile({ id: 'plan', ownerId: OWNER, name: 'Plan', vendor: 'anthropic', kind: 'subscription', model: SONNET, models: [OPUS55], secretRef: 'ai/plan', createdAt: 'now' });
    store.setAgentAIProfile(a.id, 'plan');
    store.setAgentApplied(a.id, 'plan', SONNET);
    h.provider.infoOverride.set(a.ref, { openclawVersion: '2026.9.6' }); // too old for Opus 5.5 on a subscription
    store.setAgentModel(a.id, OPUS55, { apply: true });
    let next = h.restart();
    await next.settings.resume();
    expect(modelsSet(h.provider)).toEqual([]);
    expect(next.store.agentHold(a.id, 'model-apply')).toBeUndefined();
    expect(h.events.at(-1)).toMatchObject({ agentId: a.id, event: 'model.after_restart', detail: { model: OPUS55, how: 'refused', why: expect.stringMatching(/needs OpenClaw 2026\.9\.7 or newer/) } });

    // Its runtime is new enough now, but its class holds the model back for an image: the rebuild brings it.
    h.provider.infoOverride.set(a.ref, { openclawVersion: '2026.9.8' });
    next.store.setAgentModel(a.id, OPUS55, { apply: true });
    next.store.setAgentHold(a.id, 'model-waits-image', OPUS55);
    next = h.restart();
    await next.settings.resume();
    expect(modelsSet(h.provider)).toEqual([]);
    expect(h.events.at(-1)).toMatchObject({ event: 'model.after_restart', detail: { how: 'refused', why: 'it waits for the image that can run it' } });
  });

  it('on a machine that does not answer it stays asked, quietly, for a later start', async () => {
    const h = house(), a = await h.agent('a1');
    h.now.store.setAgentModel(a.id, OTHER, { apply: true });
    h.provider.awake = false;
    let next = h.restart();
    await next.settings.resume();
    expect(modelsSet(h.provider)).toEqual([]);
    expect(next.store.agentHold(a.id, 'model-apply')).toBeTruthy();
    expect(h.events.filter((e) => e.event === 'model.after_restart')).toEqual([]);
    h.provider.awake = true;
    next = h.restart();
    await next.settings.resume();
    expect(modelsSet(h.provider)).toEqual([`anthropic/${OTHER}`]);
  });

  it('a write the next process replays that its machine never answers stays asked: not taken for a refusal (HB-1084)', async () => {
    const h = house(), a = await h.agent('a1');
    h.now.store.setAgentModel(a.id, OTHER, { apply: true });
    // The machine answers its reachability check, then drops the write itself.
    h.provider.execResponses.set('models set', { code: 255, stdout: '', stderr: 'cannot connect', timedOut: true, unreachable: true });
    let next = h.restart();
    await next.settings.resume();
    expect(modelsSet(h.provider)).toEqual([`anthropic/${OTHER}`]);
    expect(next.store.getAgent(a.id)?.appliedModel).toBe(DEFAULT);
    expect(next.store.agentHold(a.id, 'model-apply')).toBeTruthy();
    // A write that timed out, in this process: still asked too.
    h.provider.execResponses.set('models set', { code: 1, stdout: '', stderr: '', timedOut: true });
    expect(await next.settings.models.applyModelToRuntime(a.id)).toBe('failed');
    expect(next.store.agentHold(a.id, 'model-apply')).toBeTruthy();
    // It answers again: the next start puts the model on.
    h.provider.execResponses.delete('models set');
    next = h.restart();
    await next.settings.resume();
    expect(next.store.getAgent(a.id)?.appliedModel).toBe(OTHER);
    expect(next.store.agentHold(a.id, 'model-apply')).toBeUndefined();
  });

  it('after a restart of the whole machine, waits for a container that is not up yet rather than take that for a refusal', async () => {
    const h = house(), a = await h.agent('a1'), b = await h.agent('a2', 'Garden');
    for (const x of [a, b]) h.now.store.setAgentModel(x.id, OTHER, { apply: true });
    // The machine went down with Hatchabot. Docker has not started the containers again yet; the records say RUNNING.
    await h.provider.stop(a.ref);
    await h.provider.stop(b.ref);
    const next = h.restart();
    let pauses = 0;
    // Kitchen's container comes up during the wait; Garden's does not.
    h.pause = async () => { if (++pauses === 2) await h.provider.start(a.ref); };
    await next.settings.resume();
    expect(modelsSet(h.provider)).toEqual([`anthropic/${OTHER}`]);
    expect(next.store.getAgent(a.id)?.appliedModel).toBe(OTHER);
    expect(next.store.agentHold(a.id, 'model-apply')).toBeUndefined();
    // Garden: nothing was asked of a container that is not there, so nothing reads as refused, and it is still owed.
    expect(next.store.agentHold(b.id, 'model-apply')).toBeTruthy();
    expect(h.events.filter((e) => e.agentId === b.id)).toEqual([]);
    await h.provider.start(b.ref);
    await h.restart().settings.resume();
    expect(modelsSet(h.provider)).toEqual([`anthropic/${OTHER}`, `anthropic/${OTHER}`]);
  });

  it('waits for a rebuild put back in the queue at the start, which writes the model from the record', async () => {
    const h = house(), a = await h.agent('a1');
    h.now.store.setAgentModel(a.id, OTHER, { apply: true });
    const next = h.restart();
    const rebuild = gate();
    next.flights.set(a.id, rebuild.held);
    const resumed = next.settings.resume();
    await tick();
    expect(modelsSet(h.provider)).toEqual([]); // not written under the rebuild
    // The rebuild made its container from the record.
    next.store.setAgentApplied(a.id, 'p1', OTHER);
    next.flights.delete(a.id);
    rebuild.open();
    await resumed;
    expect(modelsSet(h.provider)).toEqual([]); // nothing left to write
    expect(next.store.agentHold(a.id, 'model-apply')).toBeUndefined();
  });

  it('an agent with nothing to write a model to (archived, moved away, mid-setup) is let go of', async () => {
    const h = house(), a = await h.agent('a1'), b = await h.agent('a2', 'Garden'), c = await h.agent('a3', 'Study'), { store } = h.now;
    for (const x of [a, b, c]) store.setAgentModel(x.id, OTHER, { apply: true });
    store.setAgentState(a.id, 'STOPPED'); store.setAgentState(a.id, 'ARCHIVED');
    store.setAgentMigratedTo(b.id, 'another Hatchabot');
    store.setAgentState(c.id, 'REBUILDING'); // its rebuild, or the Retry after it, writes the model from the record
    const next = h.restart();
    await next.settings.resume();
    expect(modelsSet(h.provider)).toEqual([]);
    expect(next.store.agentHolds('model-apply')).toEqual([]);
  });
});

describe("a source's new default applied to the ticked agents, cut off by a restart (HB-0832)", () => {
  /** The AI sources service of a process, over its own store and settings, as routes.ts builds it (no rebuilds here). */
  const sourcesOf = (h: House, life: Life) => createAiSources({
    store: life.store, secretOf: async () => 'made-up-key', providerFor: () => h.provider,
    agentGone: (id) => { const state = life.store.getAgent(id)?.state; return !state || state === 'DELETED' || state === 'DELETING'; },
    models: life.settings.models,
    detachClassIfDrifted: (id) => life.settings.classes.detachClassIfDrifted(id),
    withSourceHold: life.settings.sourceHolds.withSourceHold,
    kickRebuild: () => false, oweRebuild: () => '', recoverAfterRebuild: () => {},
  });

  it('each ticked agent that follows the default is asked for it with the writes: the next start puts it on those the route had not reached', async () => {
    const h = house();
    const ids: string[] = [];
    for (const [i, name] of ['Kitchen', 'Garden', 'Laundry'].entries()) ids.push((await h.agent(`a${i + 1}`, name)).id);
    const exec = h.provider.exec.bind(h.provider);
    // The first agent's `models set` never answers: the process ends there, before the route reaches the other two.
    const asked = gate();
    h.provider.exec = async (ref, argv, opts) => { if (argv[0] === 'models') { asked.open(); await new Promise(() => {}); } return exec(ref, argv, opts); };
    void sourcesOf(h, h.now).applyDefaultModel(h.now.store.getAIProfile('p1')!, OWNER, { model: OTHER, apply: ids }, () => {}).catch(() => undefined);
    await asked.held;
    expect(h.now.store.getAIProfile('p1')!.model).toBe(OTHER);
    // Was: only the first had an ask; the others had no write of their own to carry one.
    expect(ids.map((id) => !!h.now.store.agentHold(id, 'model-apply'))).toEqual([true, true, true]);

    h.provider.exec = exec;
    const next = h.restart();
    await next.settings.resume();
    expect(ids.map((id) => next.store.getAgent(id)?.appliedModel)).toEqual([OTHER, OTHER, OTHER]);
    expect(modelsSet(h.provider)).toEqual(ids.map(() => `anthropic/${OTHER}`));
    expect(ids.map((id) => next.store.agentHold(id, 'model-apply'))).toEqual([undefined, undefined, undefined]);
  });

  it("only the caller's own ticked agents are asked for: another account's named in the list is not", async () => {
    const h = house();
    const mine = await h.agent('a1', 'Kitchen');
    const theirs = await h.agent('a2', 'Garden', 'user-neighbour');
    await sourcesOf(h, h.now).applyDefaultModel(h.now.store.getAIProfile('p1')!, OWNER, { model: OTHER, apply: [mine.id, theirs.id] }, () => {});
    expect(h.now.store.getAgent(mine.id)?.appliedModel).toBe(OTHER);
    expect(h.now.store.agentHold(theirs.id, 'model-apply')).toBeUndefined();
  });
});

describe('a class edit', () => {
  const fast = (store: Store, extra: { model?: string; memoryCap?: string } = { model: OTHER }) => {
    store.upsertAgentClass({ id: 'c1', ownerId: OWNER, name: 'Fast', ...extra });
    return store.getAgentClass('c1')!;
  };

  it("writes the class's row and every member in one transaction: a failure in the middle leaves none of it", async () => {
    const h = house(), a = await h.agent('a1'), b = await h.agent('a2', 'Garden'), { store, settings } = h.now;
    const cls = fast(store, {});
    for (const id of [a.id, b.id]) store.setAgentClassIf(id, null, 'c1');
    const edit: ClassEdit = { cls, row: JSON.stringify(cls), name: 'Faster', model: OTHER, b: {} };
    const checks = await settings.classes.checkEditMembers(edit);
    // The write of the second member fails, as a process killed there would leave it unwritten.
    const setModel = store.setAgentModel.bind(store);
    let writes = 0;
    store.setAgentModel = (id, model, opts) => { if (++writes === 2) throw new Error('the process ended here'); setModel(id, model, opts); };
    const seen: unknown[] = [];
    expect(() => settings.classes.writeClassEdit(edit, checks, false, (before) => { seen.push(before); })).toThrow('the process ended here');
    store.setAgentModel = setModel;

    const next = h.restart();
    expect(next.store.getAgentClass('c1')).toMatchObject({ name: 'Fast' });
    expect(next.store.getAgentClass('c1')?.model).toBeUndefined();
    expect(next.store.getAgent(a.id)?.model).toBeUndefined(); // the first member's write went back with the rest
    expect(next.store.getAgent(b.id)?.model).toBeUndefined();
    expect(next.store.agentHolds('model-apply')).toEqual([]);
    await next.settings.resume();
    expect(modelsSet(h.provider)).toEqual([]);
  });

  it("cut off after its records, before its members' containers: each member's model is put on by the next process", async () => {
    const h = house(), a = await h.agent('a1'), b = await h.agent('a2', 'Garden'), { store, settings } = h.now;
    const cls = fast(store, {});
    for (const id of [a.id, b.id]) store.setAgentClassIf(id, null, 'c1');
    const edit: ClassEdit = { cls, row: JSON.stringify(cls), name: 'Fast', model: OTHER, b: {} };
    const checks = await settings.classes.checkEditMembers(edit);
    const step = await settings.classes.inClassQueue(['c1'], async () => settings.classes.writeClassEdit(edit, checks, false, () => {}));
    expect('later' in step).toBe(true); // written; the process ends before `later` runs
    expect(modelsSet(h.provider)).toEqual([]);

    const next = h.restart();
    await next.settings.resume();
    expect(modelsSet(h.provider)).toEqual([`anthropic/${OTHER}`, `anthropic/${OTHER}`]);
    for (const id of [a.id, b.id]) expect(next.store.getAgent(id)).toMatchObject({ classId: 'c1', model: OTHER, appliedModel: OTHER });
  });

  it("HB-0820: a detach left to be decided after the edit is decided by the next process, before anything is asked of it", async () => {
    const h = house(), a = await h.agent('a1'), { store, settings } = h.now;
    fast(store, { model: OTHER, memoryCap: '4g' });
    store.setAgentClassIf(a.id, null, 'c1');
    store.setAgentModel(a.id, OTHER);
    store.setAgentApplied(a.id, 'p1', OTHER);
    // An edit of the class is under way (its checks wait on a machine), and its owner changes the agent's model by hand.
    settings.classes.classEditBegun('c1');
    const dropped = store.transact(() => { store.setAgentModel(a.id, null, { apply: true }); return settings.classes.detachClassIfDrifted(a.id); });
    expect(dropped).toEqual({ detached: 'pending' });
    expect(store.agentHold(a.id, 'class-detach')).toBe('c1');
    await tick();
    expect(store.getAgent(a.id)?.classId).toBe('c1'); // still in it: the edit has not ended

    // Hatchabot restarts before the edit answers. The edit is gone, and so is the decision it was to be followed by.
    const next = h.restart();
    // Built: the agent has left the class it had drifted from, so the class's next edit does not write over its owner's choice.
    expect(next.store.getAgent(a.id)?.classId).toBeUndefined();
    expect(next.store.agentHold(a.id, 'class-detach')).toBeUndefined();
    expect(h.events.filter((e) => e.event === 'class.detached')).toEqual([
      { agentId: a.id, event: 'class.detached', detail: { after: 'when Hatchabot started again: a restart had cut its class change off' } },
    ]);
    const cls = next.store.getAgentClass('c1')!;
    const edit: ClassEdit = { cls, row: JSON.stringify(cls), name: 'Fast', model: OTHER, b: {} };
    const step = next.settings.classes.writeClassEdit(edit, await next.settings.classes.checkEditMembers(edit), false, () => {});
    expect('later' in step).toBe(true);
    expect(next.store.getAgent(a.id)?.model).toBeUndefined(); // its own choice stands

    // The class set a memory cap: the limits that apply without it go on its container once the machines are asked.
    expect(h.provider.memoryUpdates).toEqual([]);
    await next.settings.resume();
    expect(h.provider.memoryUpdates).toHaveLength(1);
    expect(h.provider.memoryUpdates[0]).toMatchObject({ runtimeRef: a.ref });
    // And its own model, stored just before the restart, is on its runtime.
    expect(modelsSet(h.provider)).toEqual([`anthropic/${DEFAULT}`]);
  });

  it("HB-0839 review: the limits of the agents a restart took out of their class go on one at a time, as before", async () => {
    const h = house();
    const agents = [await h.agent('a1'), await h.agent('a2', 'Garden'), await h.agent('a3', 'Pantry')];
    const { store, settings } = h.now;
    fast(store, { model: OTHER, memoryCap: '4g' });
    settings.classes.classEditBegun('c1');
    for (const a of agents) {
      store.setAgentClassIf(a.id, null, 'c1');
      store.setAgentModel(a.id, OTHER);
      store.setAgentApplied(a.id, 'p1', OTHER);
      store.transact(() => { store.setAgentModel(a.id, null, { apply: true }); return settings.classes.detachClassIfDrifted(a.id); });
    }
    expect(store.agentHolds('class-detach')).toHaveLength(3);
    const next = h.restart();
    // Each docker update takes a moment.
    const update = h.provider.updateMemory.bind(h.provider);
    let running = 0, most = 0;
    h.provider.updateMemory = async (ref, cap, swap) => {
      running++; most = Math.max(most, running);
      try { await new Promise((r) => setTimeout(r, 20)); return await update(ref, cap, swap); } finally { running--; }
    };
    await next.settings.resume();
    expect(h.provider.memoryUpdates).toHaveLength(3);
    expect(most).toBe(1); // was: all three at once
  });

  it('a detach left to be decided for an agent that runs what its class sets again is let go, and it stays', async () => {
    const h = house(), a = await h.agent('a1'), { store, settings } = h.now;
    fast(store);
    store.setAgentClassIf(a.id, null, 'c1');
    settings.classes.classEditBegun('c1');
    expect(store.transact(() => { store.setAgentModel(a.id, null); return settings.classes.detachClassIfDrifted(a.id); })).toEqual({ detached: 'pending' });
    store.setAgentModel(a.id, OTHER); // back on what the class sets, before the restart
    const next = h.restart();
    expect(next.store.getAgent(a.id)?.classId).toBe('c1');
    expect(next.store.agentHold(a.id, 'class-detach')).toBeUndefined();
    expect(h.events.filter((e) => e.event === 'class.detached')).toEqual([]);
  });

  it('decided in the same process, the mark goes with the decision, and with the last of several', async () => {
    const h = house(), a = await h.agent('a1'), { store, settings } = h.now;
    fast(store);
    store.setAgentClassIf(a.id, null, 'c1');
    store.setAgentModel(a.id, OTHER);
    settings.classes.classEditBegun('c1');
    // Two changes of its own while the edit is under way: two decisions wait.
    store.transact(() => { store.setAgentModel(a.id, null); return settings.classes.detachClassIfDrifted(a.id); });
    store.transact(() => { store.setAgentModel(a.id, DEFAULT); return settings.classes.detachClassIfDrifted(a.id); });
    expect(store.agentHold(a.id, 'class-detach')).toBe('c1');
    settings.classes.classEditEnded('c1');
    await settle(() => store.getAgent(a.id)?.classId === undefined && store.agentHold(a.id, 'class-detach') === undefined);
    expect(store.getAgent(a.id)?.classId).toBeUndefined();
    expect(store.agentHold(a.id, 'class-detach')).toBeUndefined();
    expect(h.events.filter((e) => e.event === 'class.detached')).toHaveLength(1);
    // Nothing is left for a next process to decide.
    h.restart();
    expect(h.events.filter((e) => e.event === 'class.detached')).toHaveLength(1);
  });

  it('a decision for a class it has since left does not keep the mark of the class it is in now', async () => {
    const h = house(), a = await h.agent('a1'), { store, settings } = h.now;
    fast(store);
    store.upsertAgentClass({ id: 'c2', ownerId: OWNER, name: 'Careful', model: OTHER });
    store.setAgentClassIf(a.id, null, 'c1');
    store.setAgentModel(a.id, OTHER);
    settings.classes.classEditBegun('c1');
    store.transact(() => { store.setAgentModel(a.id, null); return settings.classes.detachClassIfDrifted(a.id); }); // waits on c1's edit
    // Moved to another class by hand, whose own edit is under way when its model is changed again.
    store.setAgentClassIf(a.id, 'c1', 'c2');
    settings.classes.classEditBegun('c2');
    expect(store.transact(() => { store.setAgentModel(a.id, DEFAULT); return settings.classes.detachClassIfDrifted(a.id); })).toEqual({ detached: 'pending' });
    expect(store.agentHold(a.id, 'class-detach')).toBe('c2');
    store.setAgentModel(a.id, OTHER); // what c2 sets, before c2's edit is done: it stays
    settings.classes.classEditEnded('c2');
    await settle(() => store.agentHold(a.id, 'class-detach') === undefined);
    expect(store.agentHold(a.id, 'class-detach')).toBeUndefined(); // decided, though the older decision still waits
    expect(store.getAgent(a.id)?.classId).toBe('c2');
    settings.classes.classEditEnded('c1');
    await tick();
    await tick();
    expect(store.getAgent(a.id)?.classId).toBe('c2');
    expect(store.agentHold(a.id, 'class-detach')).toBeUndefined();
    // Nothing for a next process to decide: it would have found a mark for c2 and taken the agent out the day it drifted for a reason of its own.
    store.setAgentModel(a.id, null);
    expect(h.restart().store.getAgent(a.id)?.classId).toBe('c2');
  });

  it('a write that drifted it and was rolled back leaves no mark', async () => {
    const h = house(), a = await h.agent('a1'), { store, settings } = h.now;
    fast(store);
    store.setAgentClassIf(a.id, null, 'c1');
    store.setAgentModel(a.id, OTHER);
    settings.classes.classEditBegun('c1');
    expect(() => store.transact(() => { store.setAgentModel(a.id, null); settings.classes.detachClassIfDrifted(a.id); throw new Error('refused at the write'); })).toThrow('refused at the write');
    expect(store.agentHold(a.id, 'class-detach')).toBeUndefined();
    expect(h.restart().store.getAgent(a.id)).toMatchObject({ classId: 'c1', model: OTHER });
  });
});

describe('holds kept before a rollback (HB-0840)', () => {
  it('a model ask and a detach kept before a rollback are let go of at the next start, before anything reads them; a refusal kept before it stays, and a hold kept since is taken up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-holds-rollback-'));
    closers.push(async () => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, 'hatchabot.sqlite');
    const h = house(), a = await h.agent('a1'), b = await h.agent('a2', 'Garden'), { store, settings } = h.now;
    // On the newer release: a1's model is changed while its class is being edited, and the process ends
    // with the model's ask and the detach both kept (as HB-0820's test in 'a class edit').
    store.upsertAgentClass({ id: 'c1', ownerId: OWNER, name: 'Fast', model: OTHER });
    store.setAgentClassIf(a.id, null, 'c1');
    store.setAgentModel(a.id, OTHER);
    store.setAgentApplied(a.id, 'p1', OTHER);
    settings.classes.classEditBegun('c1');
    store.transact(() => { store.setAgentModel(a.id, null, { apply: true }); return settings.classes.detachClassIfDrifted(a.id); });
    expect(store.agentHold(a.id, 'class-detach')).toBe('c1');
    expect(store.agentHold(a.id, 'model-apply')).toBeTruthy();
    // And one that changes nothing when served: the owner's refusal of a pool bot (HOLDS_AFTER_ROLLBACK keeps it).
    store.setAgentHold(b.id, 'skip-pool', '1');
    await tick();

    // Rolled back: the script writes its time beside the database, and the release gone back to runs for a while.
    writeFileSync(rollbackMarkPath(dbPath), new Date().toISOString() + '\n');
    await tick();
    // A hold kept after the rollback (a release gone back to that knows the table): a2's model.
    store.setAgentModel(b.id, OTHER, { apply: true });

    // The next start, as src/index.ts makes it: the note is taken first.
    h.atStart = (s) => { takeRollbackMark(s, dbPath); };
    const next = h.restart();
    expect(next.store.agentHold(a.id, 'class-detach')).toBeUndefined();
    expect(next.store.agentHold(a.id, 'model-apply')).toBeUndefined();
    expect(next.store.agentHold(b.id, 'skip-pool')).toBe('1');
    // The service, built over it, decided nothing: a1 stays in the class it was left in.
    expect(next.store.getAgent(a.id)?.classId).toBe('c1');
    expect(h.events.filter((e) => e.event === 'class.detached')).toEqual([]);
    await next.settings.resume();
    // Only a2's model, kept since, went on a runtime.
    expect(modelsSet(h.provider)).toEqual([`anthropic/${OTHER}`]);
    expect(next.store.getAgent(b.id)?.appliedModel).toBe(OTHER);
    expect(next.store.getAgent(a.id)?.appliedModel).toBe(OTHER); // as it was: no write to its runtime
    expect(next.store.agentHold(b.id, 'model-apply')).toBeUndefined();
  });
});

describe("a class's model waiting for the image that can run it", () => {
  const send = (w: World, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    w.f.inject({ method, url, headers: as(), ...(payload !== undefined ? { payload: payload as object } : {}) });

  it('is listed as waiting for its rebuild after a restart too, and no longer once it is rebuilt', async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    w.store.insertAIProfile({ id: 'plan', ownerId: w.owner, name: 'Plan', vendor: 'anthropic', kind: 'subscription', model: OPUS55, models: [SONNET], secretRef: 'ai/plan', createdAt: 'now' });
    await w.secrets.put('ai/plan', 'made-up-plan-credential');
    const id = await seedRunningAgent(w);
    const ref = w.store.getAgent(id)!.runtimeRef!;
    w.store.setAgentAIProfile(id, 'plan');
    w.store.setAgentModel(id, SONNET);
    w.store.setAgentApplied(id, 'plan', SONNET);
    w.provider.infoOverride.set(ref, { openclawVersion: '2026.9.6' });
    w.provider.tags.push({ tag: NEW_IMAGE, imageId: 'newer-image', openclawVersion: '2026.9.8' });
    w.store.upsertAgentClass({ id: 'c-plan', ownerId: w.owner, name: 'Plan', model: SONNET });
    w.store.setAgentClassIf(id, null, 'c-plan');
    const edit = await send(w, 'PUT', '/v1/agent-classes/c-plan', { model: OPUS55, image: NEW_IMAGE });
    expect(edit.json()).toMatchObject({ applied: 1, needRebuild: 1, skipped: [], modelPending: [] });
    const waits = async () => ((await send(w, 'GET', '/v1/agents')).json() as Array<{ id: string; pendingModel?: string; rebuildWaits?: boolean }>).find((a) => a.id === id);
    expect(await waits()).toMatchObject({ pendingModel: OPUS55, rebuildWaits: true });

    w = await restartWorld(w);
    closers.push(() => w.f.close());
    expect(await waits()).toMatchObject({ pendingModel: OPUS55, rebuildWaits: true }); // was: false, "still on an old model"
    // The start puts nothing on its old runtime: the model was held back for the image.
    await w.routes!.resumeOperations();
    expect(modelsSet(w.provider)).toEqual([]);
    expect(await waits()).toMatchObject({ pendingModel: OPUS55, rebuildWaits: true });

    // Rebuilt onto the image: nothing waits any more, in the list or in the store.
    w.provider.infoOverride.delete(ref);
    expect((await send(w, 'POST', `/v1/agents/${id}/rebuild`, {})).statusCode).toBe(202);
    await settle(() => !w.store.activeOperationFor(id) && !isBusy(id) && w.store.getAgent(id)?.state === 'RUNNING', 10_000);
    expect(w.store.getAgent(id)).toMatchObject({ state: 'RUNNING', appliedModel: OPUS55 });
    expect(w.store.agentHold(id, 'model-waits-image')).toBeUndefined();
    expect((await waits())?.pendingModel).toBeUndefined();
  });
});

describe('a memory budget still to be told when the process ends', () => {
  it('is told by the next process: every running agent is asked once, and one that says its cap is left as it is', async () => {
    const h = house(), a = await h.agent('a1'), b = await h.agent('a2', 'Garden'), { store, settings } = h.now;
    store.setAgentMemoryCap(b.id, '2g'); // Garden's file below says so already
    const bookOf = new Map([[a.ref, `# How I work\n\n${memoryBudgetSection('8g')}\n`], [b.ref, `# How I work\n\n${memoryBudgetSection('2g')}\n`]]);
    const writes: string[] = [];
    const shell = h.provider.execShell.bind(h.provider);
    h.provider.execShell = async (ref, script, opts) => {
      if (script.startsWith('cat ') && script.includes('/AGENTS.md')) return { code: 0, stdout: Buffer.from(bookOf.get(ref)!).toString('base64'), stderr: '' };
      const staged = /echo "([A-Za-z0-9+/=]+)" \| base64 -d > "[^"]*AGENTS\.md\.tmp-[0-9a-f]+"/.exec(script);
      if (staged && / mv -fT -- /.test(script)) { bookOf.set(ref, Buffer.from(staged[1]!, 'base64').toString()); writes.push(ref); return { code: 0, stdout: '', stderr: '' }; }
      return shell(ref, script, opts);
    };
    // Kitchen's cap moves and it is busy (a backup): the ask waits for it to be free. The process ends there.
    markBusy(a.id);
    store.setAgentMemoryCap(a.id, '3g');
    const waiting = settings.limits.tellMemoryBudget(a.id);
    await tick();
    expect(bookOf.get(a.ref)).toContain(memoryBudgetSection('8g'));

    const next = h.restart();
    await waiting; // the old process's wait ended with it
    clearBusy(a.id);
    await next.settings.resume();
    expect(bookOf.get(a.ref)).toContain(memoryBudgetSection('3g', { live: true }));
    expect(writes).toEqual([a.ref]); // Garden's file said its cap: read, not written
    expect(h.events.filter((e) => e.event === 'memory.budget_told').map((e) => e.agentId)).toEqual([a.id]);
  });

  it('leaves an agent on a machine that does not answer to its next start, with nothing on its timeline', async () => {
    const h = house(), a = await h.agent('a1');
    h.now.store.setAgentMemoryCap(a.id, '3g');
    h.provider.awake = false;
    const next = h.restart();
    const before = h.provider.execLog.length;
    await next.settings.resume();
    expect(h.provider.execLog.length).toBe(before);
    expect(h.events).toEqual([]);
  });
});

describe('through the routes, as src/index.ts starts them', () => {
  const send = (w: World, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    w.f.inject({ method, url, headers: as(), ...(payload !== undefined ? { payload: payload as object } : {}) });

  it("POST /v1/agents/:id/model cut off before its runtime answered: the start's pass puts the model on", async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    w.store.setAIProfileModels('p1', [OTHER]);
    const id = await seedRunningAgent(w);
    w.store.setAgentApplied(id, 'p1', DEFAULT);
    const exec = w.provider.exec.bind(w.provider);
    // The runtime never answers the first process: the request is still open when Hatchabot restarts.
    w.provider.exec = async (ref, argv, opts) => { if (argv[0] === 'models' && argv[1] === 'set') await new Promise(() => {}); return exec(ref, argv, opts); };
    void send(w, 'POST', `/v1/agents/${id}/model`, { model: OTHER }).catch(() => undefined);
    await settle(() => w.store.getAgent(id)?.model === OTHER);
    expect(w.store.getAgent(id)).toMatchObject({ model: OTHER, appliedModel: DEFAULT });

    w.provider.exec = exec;
    // The old app's request never answers, so it is left as it is rather than closed.
    w = await restartWorld({ ...w, f: { close: async () => undefined } as never });
    closers.push(() => w.f.close());
    expect((await send(w, 'GET', '/v1/agents')).json()[0]).toMatchObject({ pendingModel: OTHER });
    await w.routes!.resumeOperations();
    expect(modelsSet(w.provider)).toEqual([`anthropic/${OTHER}`]);
    expect(w.store.getAgent(id)?.appliedModel).toBe(OTHER);
    expect((await send(w, 'GET', '/v1/agents')).json()[0].pendingModel).toBeUndefined();
  });

  /**
   * "Anyone can knock" turned on while a rebuild holds the agent, and
   * Hatchabot restarted before it was free: the world after the restart, the
   * rebuild over, with the doors the agent's volume is written (each pass
   * its own: the memo of what was written is the module's, and kept across
   * worlds, so it is forgotten here).
   */
  const knockDoorAcrossRestart = async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    forgetDmPolicy(id);
    const doors: string[] = [];
    let writes: 'take' | 'refuse' = 'take';
    w.provider.execShellOnVolume = (async (_ref: string, script: string) => {
      const t = /const t = (\{.*?\});/.exec(script)?.[1];
      const door = t ? JSON.parse(t) as { channel?: string; policy?: string } : undefined;
      if (door?.policy) {
        if (writes === 'refuse') return { code: 1, stdout: '', stderr: 'made-up failure' };
        doors.push(`${door.channel}:${door.policy}`);
      }
      return { code: 0, stdout: 'set\n', stderr: '' };
    }) as never;
    // A rebuild under way, its config (the door shut) written already.
    w.store.setAgentState(id, 'REBUILDING');
    markBusy(id);
    const r = await send(w, 'POST', `/v1/agents/${id}/allow-knocks`, { on: true });
    expect(r.json()).toEqual({ allowKnocks: true });
    expect(w.store.agentHold(id, 'knock-door')).toBeDefined();
    // Hatchabot restarts: the wait ends with the process, and the agent's flag with it; the rebuild comes to its end.
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    clearBusy(id);
    w.store.setAgentState(id, 'RUNNING');
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(doors, 'the old process opened nothing once it was stopped').toEqual([]);
    return { w, id, doors, refuse: (on: boolean) => { writes = on ? 'refuse' : 'take'; } };
  };
  const failures = (w: World, id: string) => w.store.listEvents([id], 50).filter((e) => e.event === 'agent.knock_door_failed');

  it('HB-1264: "Anyone can knock" turned on while a rebuild held the agent, Hatchabot restarted before it was free: the next process opens the door once it is; turned off, stopped or archived meanwhile, nothing is opened', async () => {
    const meanwhile: Array<[string, (w: World, id: string) => void, boolean]> = [
      ['nothing', () => {}, true],
      ['turned off', (w, id) => w.store.setAllowKnocks(id, false), false],
      ['stopped', (w, id) => w.store.setAgentState(id, 'STOPPED'), false],
      ['archived', (w, id) => w.store.setAgentState(id, 'ARCHIVED'), false],
    ];
    for (const [what, change, opens] of meanwhile) {
      const { w, id, doors } = await knockDoorAcrossRestart();
      change(w, id);
      await w.routes!.resumeOperations();
      await settle(() => w.store.agentHold(id, 'knock-door') === undefined);
      expect(w.store.agentHold(id, 'knock-door'), what).toBeUndefined();
      // Was: lost with the process, the door shut until the next rebuild.
      expect(doors.filter((d) => d.endsWith(':pairing')), what).toEqual(opens ? ['telegram:pairing'] : []);
    }
  });

  it('HB-1264 review: at the start, a door whose container does not answer yet, or whose write fails, stays owed to the next start', async () => {
    const { w, id, doors, refuse } = await knockDoorAcrossRestart();
    // The whole machine restarted: Docker does not answer yet.
    const status = w.provider.status.bind(w.provider);
    let looks = 0;
    w.provider.status = (async () => { looks++; throw new Error('made-up: docker is not answering'); }) as never;
    await w.routes!.resumeOperations();
    await settle(() => looks > 0);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    // Was: written at once, refused, and the hold dropped for good.
    expect(doors).toEqual([]);
    expect(w.store.agentHold(id, 'knock-door')).toBeDefined();
    // The next start: Docker answers, but the write fails. Said, and still owed.
    w.provider.status = status;
    refuse(true);
    let w2 = await restartWorld(w);
    closers.push(() => w2.f.close());
    await w2.routes!.resumeOperations();
    await settle(() => failures(w2, id).length > 0);
    expect(failures(w2, id)).toHaveLength(1);
    expect(w2.store.agentHold(id, 'knock-door')).toBeDefined();
    // The one after: it takes, and is let go.
    refuse(false);
    forgetDmPolicy(id);
    w2 = await restartWorld(w2);
    closers.push(() => w2.f.close());
    await w2.routes!.resumeOperations();
    await settle(() => w2.store.agentHold(id, 'knock-door') === undefined);
    expect(w2.store.agentHold(id, 'knock-door')).toBeUndefined();
    expect(doors).toEqual(['telegram:pairing']);
  });

  it('HB-1264 review: turned off, stopped or rebuilt while the start waits for its container: nothing is opened, and it is let go', async () => {
    const meanwhile: Array<[string, (w: World, id: string) => void]> = [
      ['turned off', (w, id) => w.store.setAllowKnocks(id, false)],
      ['stopped', (w, id) => w.store.setAgentState(id, 'STOPPED')],
      ['rebuilt', (w, id) => w.store.setAgentRuntimeRef(id, 'made-up-new-container')],
    ];
    for (const [what, change] of meanwhile) {
      const { w, id, doors } = await knockDoorAcrossRestart();
      // The container answers only on its second look; the change lands between the two.
      const status = w.provider.status.bind(w.provider);
      let looks = 0;
      w.provider.status = (async (ref: string) => {
        if (++looks === 1) { change(w, id); return { phase: 'starting' }; }
        return status(ref);
      }) as never;
      await w.routes!.resumeOperations();
      await settle(() => w.store.agentHold(id, 'knock-door') === undefined, 10_000);
      expect(looks, what).toBeGreaterThan(1);
      // Was: opened on what it read before the looks.
      expect(doors, what).toEqual([]);
      expect(w.store.agentHold(id, 'knock-door'), what).toBeUndefined();
    }
  });

  it('HB-1264 review: a door owed at the start whose machine is not known here any more is said on its timeline and let go, not tried at every start', async () => {
    const { w, id, doors } = await knockDoorAcrossRestart();
    w.store.insertHost({ id: 'h-gone', ownerId: w.owner, kind: 'local', provider: 'mock', name: 'old box', settings: {}, createdAt: 'now' });
    w.store.setAgentHost(id, 'h-gone');
    w.db!.prepare(`DELETE FROM hosts WHERE id = 'h-gone'`).run();
    await w.routes!.resumeOperations();
    await settle(() => w.store.agentHold(id, 'knock-door') === undefined);
    expect(w.store.agentHold(id, 'knock-door')).toBeUndefined();
    expect(failures(w, id).map((e) => e.detail?.why)).toEqual([expect.stringContaining('No such host')]);
    expect(doors).toEqual([]);
  });

  it('HB-1479: a download cut off by a restart during its copy: the next process starts the agent again; one whose file was made stays stopped', async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    const ref = w.store.getAgent(id)!.runtimeRef!;
    const take = w.provider.exportState.bind(w.provider);
    // The copy never ends in the first process: Hatchabot restarts during it.
    w.provider.exportState = () => new Promise(() => {});
    void send(w, 'GET', `/v1/agents/${id}/backup`).catch(() => undefined);
    await settle(() => w.store.getAgent(id)?.state === 'STOPPED');
    expect((await w.provider.status(ref)).phase).toBe('stopped');
    w.provider.exportState = take;
    w = await restartWorld({ ...w, f: { close: async () => undefined } as never });
    closers.push(() => w.f.close());
    clearBusy(id); // the first process's hold on it went with it
    await w.routes!.resumeOperations();
    // Was: stopped, with no file, until its owner pressed Start.
    expect(w.store.getAgent(id)?.state).toBe('RUNNING');
    expect((await w.provider.status(ref)).phase).toBe('running');
    expect(w.store.agentHold(id, 'download-stop')).toBeUndefined();
    expect(w.store.listEvents([id]).map((e) => e.event)).toContain('export.cut_off');

    // A download whose file was made, and the process ended before it let go: it stays stopped, as after any download.
    const kept = w.store.clearAgentHold.bind(w.store);
    w.store.clearAgentHold = (agentId, kind, onlyIf) => kind === 'download-stop' ? false : kept(agentId, kind, onlyIf);
    const done = await send(w, 'GET', `/v1/agents/${id}/backup`);
    expect(done.statusCode).toBe(200);
    expect(w.store.getAgent(id)?.state).toBe('STOPPED');
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    expect(w.store.agentHold(id, 'download-stop')).toBeDefined();
    await w.routes!.resumeOperations();
    expect(w.store.getAgent(id)?.state).toBe('STOPPED');
    expect((await w.provider.status(ref)).phase).toBe('stopped');
    expect(w.store.agentHold(id, 'download-stop')).toBeUndefined();
  });

  it("HB-1479: two downloads cut off: one its owner started and stopped while the other's start was slow is not started again", async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const a = await seedRunningAgent(w);
    const b = await seedRunningAgent(w, { id: 'a2', name: 'Garden', slug: 'garden', accountId: 'gardenbot' });
    const take = w.provider.exportState.bind(w.provider);
    w.provider.exportState = () => new Promise(() => {});
    for (const id of [a, b]) void send(w, 'GET', `/v1/agents/${id}/backup`).catch(() => undefined);
    await settle(() => [a, b].every((id) => w.store.getAgent(id)?.state === 'STOPPED'));
    w.provider.exportState = take;
    w = await restartWorld({ ...w, f: { close: async () => undefined } as never });
    closers.push(() => w.f.close());
    for (const id of [a, b]) clearBusy(id);
    // Kitchen's start is slow (its machine is slow to answer).
    const refA = w.store.getAgent(a)!.runtimeRef!;
    const start = w.provider.start.bind(w.provider);
    const entered = gate(), slow = gate();
    w.provider.start = async (ref) => { if (ref === refA) { entered.open(); await slow.held; } return start(ref); };
    const pass = w.routes!.resumeOperations();
    await entered.held;
    // Meanwhile Garden's owner presses Start, then Stop.
    await settle(() => !isBusy(b));
    await send(w, 'POST', `/v1/agents/${b}/start`);
    await settle(() => w.store.getAgent(b)?.state === 'RUNNING' && !isBusy(b));
    expect((await send(w, 'POST', `/v1/agents/${b}/stop`)).statusCode).toBe(200);
    slow.open();
    await pass;
    expect(w.store.getAgent(a)?.state).toBe('RUNNING');
    // Was: started by the pass after the owner's Stop.
    expect(w.store.getAgent(b)?.state).toBe('STOPPED');
    expect(w.store.agentHolds('download-stop')).toEqual([]);
  });

  it('HB-1479: a download cut off whose agent has a rebuild queued is left to the rebuild, and its timeline says so', async () => {
    const w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    w.store.setAgentState(id, 'STOPPED');
    w.store.setAgentHold(id, 'download-stop', 'made-up-hold');
    const asked: string[] = [];
    const said: Array<Record<string, unknown>> = [];
    await startCutOffDownloads({
      store: w.store,
      startStopped: async (agentId) => { asked.push(agentId); return { ok: true }; },
      isInFlight: () => true,
      logFor: () => (_event, detail) => { said.push(detail); },
    });
    expect(asked).toEqual([]);
    expect(said).toEqual([{ started: false, rebuilding: true }]);
    expect(eventLabel('export.cut_off', said[0]!)).toBe('a restart cut off its download, and no file was made: its rebuild starts it');
    expect(w.store.agentHold(id, 'download-stop')).toBeUndefined();
  });

  it("HB-1480: an owner's Stop cut off in its docker stop, a budget's pause still open: the pause's end does not start it", async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    // A budget's pause of a month that is over, still open: a rebuild had the agent up again.
    w.store.addBudgetPause(id, '2026-01', id, '2026-01-20T00:00:00.000Z');
    const stop = w.provider.stop.bind(w.provider);
    const reached = gate();
    // Its owner presses Stop. The container stops; the answer never comes back to this process.
    w.provider.stop = async (ref) => { await stop(ref); reached.open(); await new Promise(() => {}); };
    void send(w, 'POST', `/v1/agents/${id}/stop`).catch(() => undefined);
    await reached.held;
    w.provider.stop = stop;
    w = await restartWorld({ ...w, f: { close: async () => undefined } as never });
    closers.push(() => w.f.close());
    clearBusy(id); // the first process's hold on it went with it
    // What src/index.ts does first: the record judged by its container.
    await reconcileAgents(w.store, w.providers, () => {});
    expect(w.store.getAgent(id)?.state).toBe('STOPPED');
    // A budget pass (one runs at once when a budget changes).
    const pass = await send(w, 'PUT', `/v1/agents/${id}/budget`, { usd: null });
    expect(pass.statusCode, pass.body).toBe(200);
    for (let i = 0; i < 20; i++) await tick();
    // Was: the stop read as the budget's, and the pause's end started it again.
    expect(w.store.getAgent(id)?.state).toBe('STOPPED');
    expect(w.store.listBudgetPauses({ open: true }).filter((p) => p.agentId === id)).toEqual([]);
    expect(w.store.listEvents([id], 50).map((e) => e.event)).toEqual(expect.arrayContaining(['budget.pause_disowned', 'budget.pause_closed']));
    expect(w.store.listEvents([id], 50).some((e) => e.event === 'budget.resumed')).toBe(false);
  });

  it("HB-1517: a drain of its machine cut off in its docker stop, a budget's pause still open: the pause's end does not start it", async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    // A budget's pause of a month that is over, still open: a rebuild had the agent up again.
    w.store.addBudgetPause(id, '2026-01', id, '2026-01-20T00:00:00.000Z');
    const stop = w.provider.stop.bind(w.provider);
    const reached = gate();
    // The machine's owner drains it. The container stops; the answer never comes back to this process.
    w.provider.stop = async (ref) => { await stop(ref); reached.open(); await new Promise(() => {}); };
    void send(w, 'POST', '/v1/hosts/h1/drain').catch(() => undefined);
    await reached.held;
    w.provider.stop = stop;
    w = await restartWorld({ ...w, f: { close: async () => undefined } as never });
    closers.push(() => w.f.close());
    clearBusy(id); // the first process's hold on it went with it
    await reconcileAgents(w.store, w.providers, () => {});
    expect(w.store.getAgent(id)?.state).toBe('STOPPED');
    const pass = await send(w, 'PUT', `/v1/agents/${id}/budget`, { usd: null });
    expect(pass.statusCode, pass.body).toBe(200);
    for (let i = 0; i < 20; i++) await tick();
    // Was: the drain's stop read as the budget's, and the pause's end started it again.
    expect(w.store.getAgent(id)?.state).toBe('STOPPED');
    expect(w.store.listBudgetPauses({ open: true }).filter((p) => p.agentId === id)).toEqual([]);
    expect(w.store.listEvents([id], 50).map((e) => e.event)).toEqual(expect.arrayContaining(['budget.pause_disowned', 'budget.pause_closed']));
    expect(w.store.listEvents([id], 50).some((e) => e.event === 'budget.resumed')).toBe(false);
  });

  it("HB-1252: an owner's Start then Stop while the boot's owed start is in its checks: the boot's start is not made, and says nothing", async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    // An adopt finished, owing its start, in the last process's boot; the agent stopped.
    const op = beginOperation(w.store, 'adopt-workspace', id, { from: '/made/up/workspace', wasRunning: true });
    oweStart(w.store, op.id);
    op.done('Adopted the workspace again.');
    w.store.updateOperation(op.id, { params: { ...w.store.getOperation(op.id)!.params, startOwed: 'boot_an-earlier-one' } });
    await w.provider.stop(w.store.getAgent(id)!.runtimeRef!);
    w.store.setAgentState(id, 'STOPPED');
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    // The boot's start asks the machine whether a rebuild is needed first; that answer is slow (a slow runner).
    const info = w.provider.info.bind(w.provider);
    const asked = gate(), slow = gate();
    let first = true;
    w.provider.info = async (ref) => { if (first) { first = false; asked.open(); await slow.held; } return info(ref); };
    const pass = w.routes!.resumeOperations();
    await asked.held;
    // Meanwhile its owner presses Start, then Stop.
    const started = await send(w, 'POST', `/v1/agents/${id}/start`);
    expect(started.statusCode, started.body).toBe(200);
    expect(startOwedIn(w.store.getOperation(op.id)!)).toBeUndefined();
    await settle(() => !isBusy(id));
    expect((await send(w, 'POST', `/v1/agents/${id}/stop`)).statusCode).toBe(200);
    slow.open();
    await pass;
    for (let i = 0; i < 20; i++) await tick();
    // Was: the boot's start took the lock once they were done, and started what its owner had stopped.
    expect(w.store.getAgent(id)?.state).toBe('STOPPED');
    expect(w.store.listEvents([id], 50).some((e) => e.event === 'op.start_failed')).toBe(false);
    expect(w.store.getOperation(op.id)!.outcome).toBe('Adopted the workspace again. Its owner has started it since.');
  });

  it("HB-1252: an owner's Start while the boot's owed start is in its checks: no stray failure on its timeline", async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    const op = beginOperation(w.store, 'adopt-workspace', id, { from: '/made/up/workspace', wasRunning: true });
    oweStart(w.store, op.id);
    op.done('Adopted the workspace again.');
    w.store.updateOperation(op.id, { params: { ...w.store.getOperation(op.id)!.params, startOwed: 'boot_an-earlier-one' } });
    await w.provider.stop(w.store.getAgent(id)!.runtimeRef!);
    w.store.setAgentState(id, 'STOPPED');
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    const info = w.provider.info.bind(w.provider);
    const asked = gate(), slow = gate();
    let first = true;
    w.provider.info = async (ref) => { if (first) { first = false; asked.open(); await slow.held; } return info(ref); };
    const pass = w.routes!.resumeOperations();
    await asked.held;
    expect((await send(w, 'POST', `/v1/agents/${id}/start`)).statusCode).toBe(200);
    slow.open();
    await pass;
    for (let i = 0; i < 20; i++) await tick();
    expect(w.store.getAgent(id)?.state).toBe('RUNNING');
    // Was: "Cannot start while RUNNING", as a failed start, after its owner's own.
    expect(w.store.listEvents([id], 50).filter((e) => e.event === 'op.start_failed')).toEqual([]);
  });

  it('HB-1445: a bulk switch with "recover after", cut off once its rebuild had made the new container: the boot finishes the rebuild, then the recovery runs, on the new source', async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Other key', vendor: 'anthropic', kind: 'api_key', model: DEFAULT, secretRef: 'ai/p2', createdAt: 'now' });
    await w.secrets.put('ai/p2', 'made-up-key');
    const id = await seedRunningAgent(w);
    // Its rebuild had made the new container on the new source, and it was up, when the process ended.
    w.store.setAgentAIProfile(id, 'p2');
    w.store.setAgentState(id, 'REBUILDING');
    recordApplied(w.store, id);
    expect(w.store.getAgent(id)).toMatchObject({ aiProfileId: 'p2', appliedProfileId: 'p2' });
    const op = beginOperation(w.store, 'rebuild', id, { checkpoint: false, was: {}, recoverOn: 'p2' });
    w.store.updateOperation(op.id, { bootId: 'an-earlier-boot' });
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    w.provider.execResponses.set('sh', { code: 0, stderr: '', stdout: JSON.stringify({ conversations: 1, messages: 5 }) });
    await w.routes!.resumeOperations();
    expect(w.store.getOperation(op.id)).toMatchObject({ status: 'succeeded' });
    const recovered = () => w.provider.execLog.find((c) => c[0] === 'sh' && String(c[1]).includes("MODE='recover'"));
    await settle(() => recovered() !== undefined, 10_000);
    // Was: the rebuild was finished, and the recovery its switch asked for never came.
    expect(w.store.getAgent(id)).toMatchObject({ state: 'RUNNING', aiProfileId: 'p2', appliedProfileId: 'p2' });
    expect(String(recovered()?.[1])).toContain("INCLUDE_LIVE='1'");
  });

  it('HB-1445: switched again since, or a rebuild that did not finish: no recovery', async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Other key', vendor: 'anthropic', kind: 'api_key', model: DEFAULT, secretRef: 'ai/p2', createdAt: 'now' });
    await w.secrets.put('ai/p2', 'made-up-key');
    // Switched back to p1 after its rebuild for p2 began.
    const back = await seedRunningAgent(w);
    w.store.setAgentState(back, 'REBUILDING');
    const op = beginOperation(w.store, 'rebuild', back, { checkpoint: false, was: {}, recoverOn: 'p2' });
    w.store.updateOperation(op.id, { bootId: 'an-earlier-boot' });
    // Its container not up: the rebuild is not finished here.
    const down = await seedRunningAgent(w, { id: 'a2', name: 'Garden', slug: 'garden', accountId: 'gardenbot' });
    w.store.setAgentAIProfile(down, 'p2');
    w.store.setAgentState(down, 'REBUILDING');
    await w.provider.stop(w.store.getAgent(down)!.runtimeRef!);
    const op2 = beginOperation(w.store, 'rebuild', down, { checkpoint: false, was: {}, recoverOn: 'p2' });
    w.store.updateOperation(op2.id, { bootId: 'an-earlier-boot' });
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    w.provider.execResponses.set('sh', { code: 0, stderr: '', stdout: JSON.stringify({ conversations: 1, messages: 5 }) });
    await w.routes!.resumeOperations();
    for (let i = 0; i < 20; i++) await tick();
    expect(w.store.getOperation(op.id)).toMatchObject({ status: 'succeeded' });
    expect(w.provider.execLog.some((c) => c[0] === 'sh' && String(c[1]).includes("MODE='recover'"))).toBe(false);
    // No recovery slot left held: one would keep it from sleeping for good (HB-0887).
    const slept = await send(w, 'POST', `/v1/agents/${back}/hibernate`);
    expect(slept.statusCode, slept.body).toBe(200);
  });

  it('HB-0832: a bulk switch with "recover after", cut off before its rebuild ran: the resumed rebuild is followed by the recovery, on the new source', async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Other key', vendor: 'anthropic', kind: 'api_key', model: DEFAULT, secretRef: 'ai/p2', createdAt: 'now' });
    await w.secrets.put('ai/p2', 'made-up-key');
    const id = await seedRunningAgent(w);
    // Telegram as the rebuild asks it, and the recovery's staging answer: nothing reaches the real one.
    vi.stubGlobal('fetch', async (url: string | URL | Request) => {
      const u = String(url instanceof Request ? url.url : url);
      if (u.includes('api.telegram.org')) return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: 'Kitchen', username: 'kitchenbot' } }), { status: 200 });
      throw new Error(`no network in tests: ${u}`);
    });
    closers.push(async () => { vi.unstubAllGlobals(); });
    const exec = w.provider.exec.bind(w.provider);
    // The first process's checkpoint turn never answers: its rebuild had not touched the container when it ended.
    const turn = gate();
    w.provider.exec = async (ref, argv, opts) => { if (argv[0] === 'agent') { turn.open(); await new Promise(() => {}); } return exec(ref, argv, opts); };
    const res = await send(w, 'POST', '/v1/ai-profiles/p2/adopt-agents', { apply: [id], rebuild: true, checkpoint: true, recoverAfter: true });
    expect(res.json()).toMatchObject({ switched: 1, rebuilding: 1 });
    await turn.held;

    w.provider.exec = exec;
    w.provider.execResponses.set('sh', { code: 0, stderr: '', stdout: JSON.stringify({ conversations: 1, messages: 5 }) });
    const [op] = w.store.listOperations([id]);
    expect(op).toMatchObject({ kind: 'rebuild', params: { recoverOn: 'p2' } });
    w.store.updateOperation(op!.id, { bootId: 'an-earlier-boot' }); // its process ended
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    // The first process's hold on the agent (in its memory) went with it.
    clearBusy(id);
    await w.routes!.resumeOperations();
    const recovered = () => w.provider.execLog.find((c) => c[0] === 'sh' && String(c[1]).includes("MODE='recover'"));
    await settle(() => recovered() !== undefined, 10_000);
    // Was: the rebuild ran again, and the recovery chained to it in the first process's memory never came.
    expect(w.store.getAgent(id)).toMatchObject({ state: 'RUNNING', aiProfileId: 'p2', appliedProfileId: 'p2' });
    expect(String(recovered()?.[1])).toContain("INCLUDE_LIVE='1'");
  });

  it('HB-0833: a start cut off after it recorded RUNNING: the next process does what follows a start for what is owed on the record', async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    const other = await seedRunningAgent(w, { id: 'a2', name: 'Garden', slug: 'garden', accountId: 'gardenbot' });
    // Its repo source was removed while it was stopped; then Start recorded
    // RUNNING, and the process ended before what follows a start scrubbed the
    // source's deploy key from its volume.
    w.store.addDataSourceRemoval({ id: 'ds1', agentId: id, mountName: 'recipes' });
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    const scripts: Array<{ ref: string; script: string }> = [];
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = async (ref, script, opts) => { scripts.push({ ref, script }); return shell(ref, script, opts); };
    await w.routes!.resumeOperations();
    await settle(() => w.store.dataSourceRemovals(id).length === 0);
    expect(w.store.dataSourceRemovals(id)).toEqual([]); // was: still owed, the key on its volume, until its next start
    const ref = w.store.getAgent(id)!.runtimeRef!;
    expect(scripts.some((s) => s.ref === ref && s.script.includes('recipes'))).toBe(true);
    // An agent owed nothing is asked only what every running one is at a start
    // (its memory budget's read): what follows a start is several calls each.
    const gardenRef = w.store.getAgent(other)!.runtimeRef!;
    expect(scripts.filter((s) => s.ref === gardenRef).map((s) => s.script)).toEqual(['cat "/home/node/.openclaw/agents/garden/agent/AGENTS.md" 2>/dev/null | base64']);
  });

  it('HB-0833 review: what follows a start, owed at the boot, runs for six agents at a time, for one whose snapshot restore is held once that is over, and not for a task parked as a clash', async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    // Seven agents, each with a repo source removed while it was stopped: its deploy key still to scrub.
    const names = ['Kitchen', 'Garden', 'Laundry', 'Pantry', 'Porch', 'Attic', 'Cellar'];
    const ids: string[] = [];
    for (const [i, name] of names.entries()) {
      const id = await seedRunningAgent(w, { id: `a${i + 1}`, name, slug: name.toLowerCase(), accountId: `${name.toLowerCase()}bot` });
      w.store.addDataSourceRemoval({ id: `ds${i + 1}`, agentId: id, mountName: 'recipes' });
      ids.push(id);
    }
    // An eighth's restore waits for its owner's choice; a ninth has only a task parked as a clash with one of its name.
    const held = await seedRunningAgent(w, { id: 'a8', name: 'Shed', slug: 'shed', accountId: 'shedbot' });
    w.store.addDataSourceRemoval({ id: 'ds8', agentId: held, mountName: 'recipes' });
    const at = new Date().toISOString();
    w.store.insertOperation({ id: 'op_shed', agentId: held, kind: 'restore-snapshot', requestedAt: at, params: { label: 'before the trip' }, step: 'writing', status: 'held', bootId: 'an-earlier-boot', updatedAt: at });
    const clash = await seedRunningAgent(w, { id: 'a9', name: 'Garage', slug: 'garage', accountId: 'garagebot' });
    w.store.setPendingSchedules(clash, [{ name: 'Morning brief', message: 'Post the brief.', everyMs: 3_600_000, why: NAME_TAKEN_WHY }]);
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    const refOf = (id: string) => w.store.getAgent(id)!.runtimeRef!;
    // Each scrub takes a while on its machine: held until the test lets them go.
    const g = gate();
    let running = 0, most = 0;
    const scrubbed: string[] = [];
    const scripts: Array<{ ref: string; script: string }> = [];
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = async (ref, script, opts) => {
      scripts.push({ ref, script });
      if (!script.includes('recipes')) return shell(ref, script, opts);
      running++; most = Math.max(most, running);
      try { await g.held; return await shell(ref, script, opts); } finally { running--; scrubbed.push(ref); }
    };
    const resumed = w.routes!.resumeOperations();
    try {
      await settle(() => running >= 6);
      for (let i = 0; i < 20; i++) await tick();
      expect(running).toBe(6); // was: all seven at once
    } finally { g.open(); }
    await resumed;
    await settle(() => ids.every((id) => w.store.dataSourceRemovals(id).length === 0));
    expect(most).toBe(6);
    expect(ids.map((id) => w.store.dataSourceRemovals(id))).toEqual(ids.map(() => []));
    // The held one's restore is its owner's to choose: nothing is done to it meanwhile.
    expect(scrubbed).not.toContain(refOf(held));
    expect(w.store.dataSourceRemovals(held)).toHaveLength(1);
    // The clash is its owner's to settle: asked only what every running agent is (its memory budget's read).
    expect(scripts.filter((x) => x.ref === refOf(clash)).map((x) => x.script)).toEqual(['cat "/home/node/.openclaw/agents/garage/agent/AGENTS.md" 2>/dev/null | base64']);
    // Its owner chooses, and the restore is over. A snapshot restore never
    // starts it, so what the boot left for it is done now. Was: never, and
    // its deploy key stayed on its volume until its next start.
    handleFor(w.store, 'op_shed').done('Restored its files from "before the trip".');
    await settle(() => w.store.dataSourceRemovals(held).length === 0);
    expect(scrubbed).toContain(refOf(held));
    expect(w.store.dataSourceRemovals(held)).toEqual([]);
  });

  it("HB-1252 review: the boot's owed start done with its checks while its owner's Start is in its docker start: not made, and nothing said", async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    const op = beginOperation(w.store, 'adopt-workspace', id, { from: '/made/up/workspace', wasRunning: true });
    oweStart(w.store, op.id);
    op.done('Adopted the workspace again.');
    w.store.updateOperation(op.id, { params: { ...w.store.getOperation(op.id)!.params, startOwed: 'boot_an-earlier-one' } });
    await w.provider.stop(w.store.getAgent(id)!.runtimeRef!);
    w.store.setAgentState(id, 'STOPPED');
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    // The boot's start is in its checks (a slow machine) ...
    const info = w.provider.info.bind(w.provider);
    const asked = gate(), slow = gate();
    let first = true;
    w.provider.info = async (ref) => { if (first) { first = false; asked.open(); await slow.held; } return info(ref); };
    const pass = w.routes!.resumeOperations();
    await asked.held;
    // ... and its owner presses Start, whose docker start takes a while.
    const start = w.provider.start.bind(w.provider);
    const inStart = gate(), letStart = gate();
    w.provider.start = async (ref) => { inStart.open(); await letStart.held; return start(ref); };
    const pressed = send(w, 'POST', `/v1/agents/${id}/start`);
    await inStart.held;
    // The boot's checks are done while the owner's Start holds the agent.
    slow.open();
    for (let i = 0; i < 20; i++) await tick();
    letStart.open();
    expect((await pressed).statusCode).toBe(200);
    await pass;
    for (let i = 0; i < 20; i++) await tick();
    expect(w.store.getAgent(id)?.state).toBe('RUNNING');
    // Was: "Another operation is already running on this agent." as a failed start, and an outcome saying it was not started.
    expect(w.store.listEvents([id], 50).filter((e) => e.event === 'op.start_failed')).toEqual([]);
    expect(w.store.getOperation(op.id)!.outcome).toBe('Adopted the workspace again. Its owner has started it since.');
  });

  it("HB-1252 review: the boot's owed start that begins while its owner's Start is in its docker start: not made, and nothing said", async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    const op = beginOperation(w.store, 'adopt-workspace', id, { from: '/made/up/workspace', wasRunning: true });
    oweStart(w.store, op.id);
    op.done('Adopted the workspace again.');
    w.store.updateOperation(op.id, { params: { ...w.store.getOperation(op.id)!.params, startOwed: 'boot_an-earlier-one' } });
    await w.provider.stop(w.store.getAgent(id)!.runtimeRef!);
    w.store.setAgentState(id, 'STOPPED');
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    // Its owner presses Start first, whose docker start takes a while ...
    const start = w.provider.start.bind(w.provider);
    const inStart = gate(), letStart = gate();
    w.provider.start = async (ref) => { inStart.open(); await letStart.held; return start(ref); };
    const pressed = send(w, 'POST', `/v1/agents/${id}/start`);
    await inStart.held;
    // ... and the boot's pass comes to the owed start while that Start holds the agent.
    const pass = w.routes!.resumeOperations();
    for (let i = 0; i < 20; i++) await tick();
    letStart.open();
    expect((await pressed).statusCode).toBe(200);
    await pass;
    for (let i = 0; i < 20; i++) await tick();
    expect(w.store.getAgent(id)?.state).toBe('RUNNING');
    // Was: refused at its first look ("Another operation is already running on this agent."), as a failed start, and an outcome saying it was not started.
    expect(w.store.listEvents([id], 50).filter((e) => e.event === 'op.start_failed')).toEqual([]);
    expect(w.store.getOperation(op.id)!.outcome).toBe('Adopted the workspace again. Its owner has started it since.');
  });

  it("HB-1252 review: the boot's owed start held off by the rebuild its owner's Start began: not made, and nothing said", async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    const op = beginOperation(w.store, 'adopt-workspace', id, { from: '/made/up/workspace', wasRunning: true });
    oweStart(w.store, op.id);
    op.done('Adopted the workspace again.');
    w.store.updateOperation(op.id, { params: { ...w.store.getOperation(op.id)!.params, startOwed: 'boot_an-earlier-one' } });
    await w.provider.stop(w.store.getAgent(id)!.runtimeRef!);
    w.store.setAgentState(id, 'STOPPED');
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    // The boot's start is in its checks (a slow machine) ...
    const info = w.provider.info.bind(w.provider);
    const asked = gate(), slow = gate();
    let first = true;
    w.provider.info = async (ref) => { if (first) { first = false; asked.open(); await slow.held; } return info(ref); };
    const pass = w.routes!.resumeOperations();
    await asked.held;
    // ... a change is saved for its next start, and its owner presses Start: a
    // rebuild, whose new container takes a while.
    w.store.setRebuildOnStart(id, new Date().toISOString());
    const provision = w.provider.provision.bind(w.provider);
    const inRebuild = gate(), letRebuild = gate();
    w.provider.provision = async (spec) => { inRebuild.open(); await letRebuild.held; return provision(spec); };
    const pressed = await send(w, 'POST', `/v1/agents/${id}/start`);
    expect(pressed.statusCode, pressed.body).toBe(202);
    expect(startOwedIn(w.store.getOperation(op.id)!)).toBeUndefined();
    await inRebuild.held;
    expect(heldFor(id)).toBe('rebuild');
    // The boot's checks are done while the rebuild holds the agent.
    slow.open();
    for (let i = 0; i < 20; i++) await tick();
    letRebuild.open();
    await pass;
    await settle(() => !isBusy(id) && w.store.getAgent(id)?.state === 'RUNNING');
    expect(w.store.getAgent(id)?.state).toBe('RUNNING');
    // Was: "Another operation is already running on this agent." as a failed start (a rebuild's hold is not one that takes a start over).
    expect(w.store.listEvents([id], 50).filter((e) => e.event === 'op.start_failed')).toEqual([]);
    expect(w.store.getOperation(op.id)!.outcome).toBe('Adopted the workspace again. Its owner has started it since.');
  });

  it("HB-1252 review: the process stopping while the boot's owed start waits for its owner's Start: the wait ends, and the start is still owed, with nothing said", async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    const op = beginOperation(w.store, 'adopt-workspace', id, { from: '/made/up/workspace', wasRunning: true });
    oweStart(w.store, op.id);
    op.done('Adopted the workspace again.');
    w.store.updateOperation(op.id, { params: { ...w.store.getOperation(op.id)!.params, startOwed: 'boot_an-earlier-one' } });
    await w.provider.stop(w.store.getAgent(id)!.runtimeRef!);
    w.store.setAgentState(id, 'STOPPED');
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    const start = w.provider.start.bind(w.provider);
    const inStart = gate(), letStart = gate();
    w.provider.start = async (ref) => { inStart.open(); await letStart.held; return start(ref); };
    const pressed = send(w, 'POST', `/v1/agents/${id}/start`);
    await inStart.held;
    const pass = w.routes!.resumeOperations();
    await settle(() => busyWaiters(id) > 0);
    expect(busyWaiters(id)).toBe(1);
    // The process stops (its routes' stop) while the owed start waits for the owner's Start.
    w.routes!.stop();
    let over = false;
    void pass.then(() => { over = true; });
    await settle(() => over);
    expect(over).toBe(true);
    expect(busyWaiters(id)).toBe(0);
    expect(startOwedIn(w.store.getOperation(op.id)!)).toBe('boot_an-earlier-one');
    expect(w.store.listEvents([id], 50).filter((e) => e.event === 'op.start_failed')).toEqual([]);
    letStart.open();
    expect((await pressed).statusCode).toBe(200);
  });

  it('HB-1409: a template task the agent itself refused is not owed at every boot; one it never answered for still is', async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    // Its answer was a refusal: it waits for its owner (Try again, or remove it), as a clash does.
    const refused = await seedRunningAgent(w, { id: 'a1', name: 'Pantry', slug: 'pantry', accountId: 'pantrybot' });
    w.store.setPendingSchedules(refused, [{ name: 'Weekly menu', message: 'Plan the menu.', cron: '0 9 * * 1', why: 'the agent refused it: Invalid cron expression' }]);
    // The call never reached it (its container did not answer): still owed.
    const unreached = await seedRunningAgent(w, { id: 'a2', name: 'Porch', slug: 'porch', accountId: 'porchbot' });
    w.store.setPendingSchedules(unreached, [{ name: 'Morning brief', message: 'Post the brief.', everyMs: 3_600_000, why: 'the agent refused it: exec failed' }]);
    // Its list of tasks could not be read: still owed.
    const unread = await seedRunningAgent(w, { id: 'a3', name: 'Attic', slug: 'attic', accountId: 'atticbot' });
    w.store.setPendingSchedules(unread, [{ name: 'Morning brief', message: 'Post the brief.', everyMs: 3_600_000, why: 'its list of tasks could not be read, so it was not added (it may be there already)' }]);
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    const execs: Array<{ ref: string; argv: string[] }> = [];
    const exec = w.provider.exec.bind(w.provider);
    w.provider.exec = async (ref, argv, opts) => { execs.push({ ref, argv }); return exec(ref, argv, opts); };
    await w.routes!.resumeOperations();
    const refOf = (id: string) => w.store.getAgent(id)!.runtimeRef!;
    await settle(() => !w.store.getPendingSchedules(unreached).length && !w.store.getPendingSchedules(unread).length);
    for (let i = 0; i < 20; i++) await tick();
    expect(w.store.getPendingSchedules(unreached)).toEqual([]);
    expect(w.store.getPendingSchedules(unread)).toEqual([]);
    // Was: tried again at every boot, with what follows a start, though nothing had changed.
    expect(execs.filter((x) => x.ref === refOf(refused) && x.argv[0] === 'cron')).toEqual([]);
    expect(w.store.getPendingSchedules(refused)).toHaveLength(1);
    // Its owner's Try again still tries it.
    const retried = await send(w, 'POST', `/v1/agents/${refused}/crons/waiting`);
    expect(retried.statusCode, retried.body).toBe(200);
    expect(w.store.getPendingSchedules(refused)).toEqual([]);
  });

  it('HB-1409 review: a task whose add timed out or never reached the agent is recorded as not answered, and still owed at the boot', async () => {
    const w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    const exec = w.provider.exec.bind(w.provider);
    // The docker exec of each add times out, as LocalDockerProvider answers after its 60 s; then the machine does not answer.
    const answers = [
      { code: 1, stdout: '', stderr: 'docker exec timed out', timedOut: true },
      { code: 1, stdout: '', stderr: 'the runner did not answer', unreachable: true },
      { code: 1, stdout: '', stderr: 'Invalid cron expression' },
    ];
    for (const answer of answers) {
      w.store.setPendingSchedules(id, [{ name: 'Weekly menu', message: 'Plan the menu.', cron: '0 9 * * 1' }]);
      w.provider.exec = async (ref, argv, opts) => (argv[0] === 'cron' && argv[1] === 'add' ? answer : exec(ref, argv, opts));
      expect((await send(w, 'POST', `/v1/agents/${id}/crons/waiting`)).statusCode).toBe(200);
      const [why] = w.store.getPendingSchedules(id).map((t) => t.why);
      // Was: "the agent refused it: docker exec timed out", which the boot then left for the owner as a refusal.
      if (answer.timedOut || answer.unreachable) {
        expect(why).toBe('the agent refused it: exec failed');
        expect(waitsForItsOwner(why)).toBe(false);
      } else {
        expect(why).toBe('the agent refused it: Invalid cron expression');
        expect(waitsForItsOwner(why)).toBe(true);
      }
    }
    w.provider.exec = exec;
  });

  it('HB-0834 review: six agents busy at the boot hold up no other agent\'s template tasks: each waits for its own in the background', async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const ids: string[] = [];
    for (const [i, name] of ['Kitchen', 'Garden', 'Laundry', 'Pantry', 'Porch', 'Attic', 'Cellar'].entries()) {
      const id = await seedRunningAgent(w, { id: `a${i + 1}`, name, slug: name.toLowerCase(), accountId: `${name.toLowerCase()}bot` });
      w.store.setPendingSchedules(id, [{ name: 'Morning brief', message: 'Post the brief.', everyMs: 3_600_000 }]);
      ids.push(id);
    }
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    // The first six the boot takes are held by something else (a backup each).
    const order = w.store.listAllActiveAgents().map((a) => a.id).filter((id) => ids.includes(id));
    const busyOnes = order.slice(0, 6), last = order[6]!;
    for (const id of busyOnes) markBusy(id);
    const resumed = w.routes!.resumeOperations();
    try {
      await settle(() => w.store.getPendingSchedules(last).length === 0);
      // Was: still waiting, behind the six that held every slot.
      expect(w.store.getPendingSchedules(last)).toEqual([]);
      expect(busyOnes.map((id) => w.store.getPendingSchedules(id).length)).toEqual(busyOnes.map(() => 1));
    } finally { for (const id of busyOnes) clearBusy(id); }
    await resumed;
    await settle(() => ids.every((id) => w.store.getPendingSchedules(id).length === 0));
    expect(ids.map((id) => w.store.getPendingSchedules(id))).toEqual(ids.map(() => []));
  });

  it("HB-0835 review: a budget's stop cut off before its record, its agent owed a start by an adopt: the boot records the pause first, and starts nothing", async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    const op = beginOperation(w.store, 'adopt-workspace', id, { from: '/made/up/workspace', wasRunning: true });
    oweStart(w.store, op.id);
    op.done('Adopted the workspace again.');
    // Owed in the last process's boot, not this one's (every process here runs in one Node).
    w.store.updateOperation(op.id, { params: { ...w.store.getOperation(op.id)!.params, startOwed: 'boot_an-earlier-one' } });
    // The budget's stop: its hold, then the container stopped and the record
    // STOPPED; the process ends before the pause is recorded.
    const month = new Date().toISOString().slice(0, 7);
    w.store.setAgentHold(id, 'budget-pause', JSON.stringify({ month, scope: 'agent', at: new Date().toISOString() }));
    await w.provider.stop(w.store.getAgent(id)!.runtimeRef!);
    w.store.setAgentState(id, 'STOPPED');
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    await w.routes!.resumeOperations();
    for (let i = 0; i < 20; i++) await tick();
    // Was: started by the boot's pass for the adopt's owed start, for the first budget pass to stop again.
    expect(w.store.getAgent(id)?.state).toBe('STOPPED');
    expect(w.store.getBudgetPause(id, month)).toMatchObject({ kind: 'pause' });
    expect(w.store.agentHold(id, 'budget-pause')).toBeUndefined();
    const after = w.store.getOperation(op.id)!;
    expect(startOwedIn(after)).toBeUndefined();
    expect(after.outcome).toBe('Adopted the workspace again. Its budget has paused it since, so it stays stopped.');
  });

  it('HB-0834 review: shutdown while a template task waits for its busy agent: nothing is added after it', async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    w.store.setPendingSchedules(id, [{ name: 'Morning brief', message: 'Post the brief.', everyMs: 3_600_000 }]);
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    markBusy(id);
    const resumed = w.routes!.resumeOperations();
    await settle(() => busyWaiters(id) > 0);
    const adds = () => w.provider.execLog.filter((c) => c[0] === 'cron' && c[1] === 'add').length;
    const before = adds();
    w.routes!.stop();
    clearBusy(id);
    for (let i = 0; i < 50; i++) await tick();
    // Was: the wait went on past shutdown, and the task was added by a process stopping.
    expect(adds()).toBe(before);
    expect(w.store.getPendingSchedules(id)).toHaveLength(1);
    await resumed.catch(() => undefined);
  });

  it('HB-0834: an operator profile saved just before a restart reaches each running agent its push had not reached', async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    const other = await seedRunningAgent(w, { id: 'a2', name: 'Garden', slug: 'garden', accountId: 'gardenbot' });
    const kitchenRef = w.store.getAgent(id)!.runtimeRef!, gardenRef = w.store.getAgent(other)!.runtimeRef!;
    // The sync's read of AGENTS.md (provision.ts syncDataSourceDocs): one per agent it writes.
    const SYNC_READ = /^cat "[^"]*\/AGENTS\.md" 2>\/dev\/null \|\| true$/;
    // The push reaches its first agent, whose container does not answer: the process ends there.
    const shell = w.provider.execShell.bind(w.provider);
    let reached: string | undefined;
    w.provider.execShell = async (ref, script, opts) => {
      if (SYNC_READ.test(script)) { reached = ref; await new Promise(() => {}); }
      return shell(ref, script, opts);
    };
    const saved = await send(w, 'PUT', '/v1/operator-profile', { content: 'The Example household.' });
    expect(saved.json()).toMatchObject({ pushing: 2 });
    await settle(() => reached !== undefined);

    w.provider.execShell = shell;
    clearBusy(reached === kitchenRef ? id : other); // the busy flags are the module's; a new process has none
    w = await restartWorld({ ...w, f: { close: async () => undefined } as never });
    closers.push(() => w.f.close());
    const synced: string[] = [];
    w.provider.execShell = async (ref, script, opts) => { if (SYNC_READ.test(script)) synced.push(ref); return shell(ref, script, opts); };
    await w.routes!.resumeOperations();
    await settle(() => synced.includes(kitchenRef) && synced.includes(gardenRef));
    // Both: the first one's sync never ended, and the other's turn never came. Was: neither, until their next rebuild.
    expect([...new Set(synced)].sort()).toEqual([kitchenRef, gardenRef].sort());
    await settle(() => !isBusy(id) && !isBusy(other));
    expect(w.store.agentHolds('docs-sync')).toEqual([]);
  });

  it('HB-0834 review: an owed AGENTS.md sync whose container is not up yet at the boot waits for it, and stays owed when it never comes up', async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    const other = await seedRunningAgent(w, { id: 'a2', name: 'Garden', slug: 'garden', accountId: 'gardenbot' });
    w.store.setAgentHold(id, 'docs-sync', 'made-up-ask-1');
    w.store.setAgentHold(other, 'docs-sync', 'made-up-ask-2');
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    const kitchenRef = w.store.getAgent(id)!.runtimeRef!, gardenRef = w.store.getAgent(other)!.runtimeRef!;
    // The whole machine restarted: Docker has not started either container again yet, and the record still says RUNNING.
    await w.provider.stop(kitchenRef);
    await w.provider.stop(gardenRef);
    // Docker starts Kitchen's a few looks in; Garden's never.
    const status = w.provider.status.bind(w.provider);
    let looks = 0;
    w.provider.status = async (ref) => { if (ref === kitchenRef && ++looks === 3) await w.provider.start(kitchenRef); return status(ref); };
    const SYNC_READ = /^cat "[^"]*\/AGENTS\.md" 2>\/dev\/null \|\| true$/;
    const shell = w.provider.execShell.bind(w.provider);
    const synced: string[] = [];
    w.provider.execShell = async (ref, script, opts) => {
      if ((await status(ref)).phase !== 'running') return { code: 1, stdout: '', stderr: 'Error response from daemon: container is not running' };
      if (SYNC_READ.test(script)) synced.push(ref);
      return shell(ref, script, opts);
    };
    await w.routes!.resumeOperations();
    await settle(() => w.store.agentHold(id, 'docs-sync') === undefined);
    // Was: each read once, failed, and let go, its sections not written.
    expect(synced).toEqual([kitchenRef]);
    expect(w.store.agentHold(id, 'docs-sync')).toBeUndefined();
    expect(w.store.agentHold(other, 'docs-sync')).toBe('made-up-ask-2');
  });

  it("HB-0834 review: an AGENTS.md sync refused because its agent is busy stays owed, the boot's own and one a start asks for alike", async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    w.store.setAgentHold(id, 'docs-sync', 'made-up-ask');
    // A Google account detached while it was stopped, still to scrub: what
    // follows its start (owed at this boot, HB-0833) syncs its AGENTS.md too,
    // with an ask of its own over the one owed.
    w.store.addConnectionRemoval(id, 'old@example.org');
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    const SYNC_READ = /^cat "[^"]*\/AGENTS\.md" 2>\/dev\/null \|\| true$/;
    const shell = w.provider.execShell.bind(w.provider);
    const synced: string[] = [];
    w.provider.execShell = async (ref, script, opts) => { if (SYNC_READ.test(script)) synced.push(ref); return shell(ref, script, opts); };
    // Something else holds it the while (a backup, say). Its memory budget's turn waits for it (memoryLimits.ts).
    markBusy(id);
    const resumed = w.routes!.resumeOperations();
    try {
      await settle(() => w.store.agentHold(id, 'docs-sync') !== 'made-up-ask');
      for (let i = 0; i < 20; i++) await tick();
      expect(synced).toEqual([]);
      // Was: let go by each refused sync, and nothing owed for the next start.
      expect(w.store.agentHold(id, 'docs-sync')).toBeDefined();
    } finally { clearBusy(id); await resumed; }
    // Free again: the refused sync's turn comes in this process, not at the next restart.
    await settle(() => w.store.agentHold(id, 'docs-sync') === undefined);
    expect(synced).toEqual([w.store.getAgent(id)!.runtimeRef]);
    expect(w.store.agentHold(id, 'docs-sync')).toBeUndefined();
  });

  it('HB-0834 review: an agent owed its model and an AGENTS.md sync at one boot gets both: the sync holding it puts the model off, not over to the next restart', async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    w.store.setAIProfileModels('p1', [OTHER]);
    const id = await seedRunningAgent(w);
    w.store.setAgentApplied(id, 'p1', DEFAULT);
    w.store.setAgentModel(id, OTHER, { apply: true });
    w.store.setAgentHold(id, 'docs-sync', 'made-up-ask');
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    // A docker exec takes a moment, as it does on a machine: the sync holds the agent while the model's turn comes.
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = async (ref, script, opts) => { await new Promise((r) => setTimeout(r, 40)); return shell(ref, script, opts); };
    await w.routes!.resumeOperations();
    await settle(() => w.store.agentHold(id, 'model-apply') === undefined);
    // Was: put off ("busy"), and still asked until the next restart.
    expect(modelsSet(w.provider)).toEqual([`anthropic/${OTHER}`]);
    expect(w.store.getAgent(id)?.appliedModel).toBe(OTHER);
    expect(w.store.agentHold(id, 'model-apply')).toBeUndefined();
    expect(w.store.agentHolds('docs-sync')).toEqual([]);
  });

  it("HB-0839: an agent's owed model goes on while another agent's interrupted operation is still being settled", async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    w.store.setAIProfileModels('p1', [OTHER]);
    const id = await seedRunningAgent(w);
    const other = await seedRunningAgent(w, { id: 'a2', name: 'Garden', slug: 'garden', accountId: 'gardenbot' });
    w.store.setAgentApplied(id, 'p1', DEFAULT);
    w.store.setAgentApplied(other, 'p1', DEFAULT);
    // Each one's model stored and asked for, its runtime not told yet, and
    // Garden's snapshot restore part-way through its files. The process ended there.
    w.store.setAgentModel(id, OTHER, { apply: true });
    w.store.setAgentModel(other, OTHER, { apply: true });
    const at = new Date().toISOString();
    w.store.insertOperation({ id: 'op_garden', agentId: other, kind: 'restore-snapshot', requestedAt: at, params: { label: 'before the trip' }, step: 'writing', status: 'running', bootId: 'an-earlier-boot', updatedAt: at });

    w = await restartWorld(w);
    closers.push(() => w.f.close());
    // Garden's files are slow to read back (its machine is loaded): its restore is not settled yet.
    const gardenRef = w.store.getAgent(other)!.runtimeRef!;
    const g = gate();
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = async (ref, script, opts) => { if (ref === gardenRef) await g.held; return shell(ref, script, opts); };
    const resumed = w.routes!.resumeOperations();
    try {
      await settle(() => modelsSet(w.provider).length > 0);
      await tick();
      expect(modelsSet(w.provider)).toEqual([`anthropic/${OTHER}`]); // was: [] until Garden's restore was settled
      expect(w.store.getAgent(id)?.appliedModel).toBe(OTHER);
      // Garden's own waits for its restore: nothing is written under it.
      expect(w.store.getAgent(other)?.appliedModel).toBe(DEFAULT);
      expect(w.store.getOperation('op_garden')?.status).toBe('interrupted');
    } finally { g.open(); w.provider.execShell = shell; await resumed; }
    expect(w.store.getOperation('op_garden')?.status).not.toBe('interrupted');
  });

  it('HB-0830: a bot detach cut off after its bot went back leaves a stopped agent whose Start is a rebuild', async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    // The call after the bot has gone back never answers: the process ends before the rebuild is asked for.
    const shell = w.provider.execShell.bind(w.provider);
    const onVolume = w.provider.execShellOnVolume.bind(w.provider);
    let handedBack = false;
    w.provider.execShell = async (r, script, opts) => { if (handedBack) await new Promise(() => {}); return shell(r, script, opts); };
    w.provider.execShellOnVolume = async (r, script, opts) => { if (handedBack) await new Promise(() => {}); return onVolume(r, script, opts); };
    const release = w.channel.release;
    w.channel.release = async (...args: unknown[]) => { await release(...args); handedBack = true; };
    void send(w, 'DELETE', `/v1/agents/${id}/telegram`).catch(() => undefined);
    await settle(() => handedBack && !w.store.getChannelForAgent(id));
    await tick();
    expect(w.store.getChannelForAgent(id)).toBeUndefined();
    expect(w.store.getAgent(id)).toMatchObject({ state: 'STOPPED' });
    // Owed on its record from before the bot went: nothing in memory says so.
    expect(w.store.getAgent(id)?.rebuildOnStart).toBeTruthy();
    expect(w.store.operationsWithStatus(['queued', 'running']).filter((o) => o.kind === 'rebuild')).toEqual([]);

    w.provider.execShell = shell;
    w.provider.execShellOnVolume = onVolume;
    w.channel.release = release;
    clearBusy(id); // the busy flags are the module's; a new process has none
    w = await restartWorld({ ...w, f: { close: async () => undefined } as never });
    closers.push(() => w.f.close());
    await w.routes!.resumeOperations();
    const started = await send(w, 'POST', `/v1/agents/${id}/start`);
    expect(started.statusCode, started.body).toBe(202);
    expect(started.json()).toMatchObject({ rebuilding: true }); // not its old container, which still held the bot it gave back
    await settle(() => !w.store.activeOperationFor(id) && !isBusy(id) && w.store.getAgent(id)?.state === 'RUNNING', 10_000);
    expect(w.store.getAgent(id)).toMatchObject({ state: 'RUNNING' });
    expect(w.store.getAgent(id)?.rebuildOnStart).toBeUndefined();
  });
});

describe('a new agent whose owner declined a pool bot', () => {
  /** A pool with a spare bot; a pool skipped on purpose asks for a token, as the composite does. */
  const withSpare = () => ({
    kind: 'telegram' as const,
    pool: { owns: (u: string) => u === 'sparebot', addToPool: async () => {}, availableCount: () => 1 },
    discardPending: () => {},
    async provision(req: { agentId: string; skipPool?: boolean }) {
      if (req.skipPool) throw new ChannelSetupRequired('paste a token', req.agentId);
      return { accountId: 'sparebot', secretRef: 'chan/spare', deepLink: 'https://t.me/sparebot' };
    },
    async release() {},
  }) as unknown as ChannelProvisioner;
  const send = (w: World, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    w.f.inject({ method, url, headers: as(), ...(payload !== undefined ? { payload: payload as object } : {}) });

  it('is kept with its row, so a setup cut off before it was parked still skips the pool when it is tried again', async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    w.channel.provision = withSpare().provision;
    // The create route's writes, and the process ends before the setup it starts has parked the agent.
    const made = await send(w, 'POST', '/v1/agents', { name: 'Bespoke', aiProfileId: 'p1', hostId: 'h1', skipPool: true });
    expect(made.statusCode, made.body).toBe(202);
    const id = made.json().id as string;
    await settle(() => !!w.store.getAgent(id)?.pendingAction);
    // As the route left it, it is parked and the mark is gone: the record drives every retry.
    expect(w.store.getAgent(id)?.pendingAction?.type).toBe('bot_token');
    expect(w.store.agentHold(id, SKIP_POOL)).toBeUndefined();
    await settle(() => !isBusy(id));

    // The same agent as a process that ended before the park left it: its row and the mark, no step yet.
    w.store.setAgentPendingAction(id, null);
    w.store.setAgentHold(id, SKIP_POOL, '1');
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    w.store.setAgentState(id, 'FAILED', 'Setup was interrupted — tap Retry.'); // what reconcile makes of it
    const again = await runProvisionSteps({ store: w.store, secrets: w.secrets, provider: w.provider, channel: withSpare(), sleep: async () => {} }, id);
    expect(again.setupRequired).toBeDefined(); // asked for its own bot's token
    expect(w.store.getChannelForAgent(id)).toBeUndefined(); // not given the spare pool bot it had declined
    expect(w.store.getAgent(id)?.pendingAction?.type).toBe('bot_token');
    expect(w.store.agentHold(id, SKIP_POOL)).toBeUndefined();
  });
});

describe("a budget's pause cut off between the agent's stop and the pause's record (HB-0835)", () => {
  const NOW = Date.parse('2026-10-20T12:00:00Z');
  const iso = (ms: number) => new Date(ms).toISOString();
  /** $25 of Opus input in the hour a day before NOW: over a $20 budget. */
  const spentOver = (): WindowModelStats => {
    const h: Record<string, number[]> = { [iso(NOW - 86_400_000).slice(0, 13)]: HOUR_FIELDS.map((f) => (f === 'input' ? 25 * 200_000 : 0)) };
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, toolUseCalls: 0, turns: 0, toolTurns: 0, toolCalls: 0, failedTurns: 0, failed7d: 0, first: 0, last: 0, ctxP50: 0, ctxP90: 0, h } as unknown as WindowModelStats;
  };
  const budgetDeps = (store: Store, stop: (a: Agent) => Promise<boolean>, started: string[]): BudgetDeps => ({
    store, tz: 'UTC',
    tell: async () => true,
    pause: stop,
    resume: async (a) => { started.push(a.id); store.setAgentState(a.id, 'RUNNING'); return true; },
    isBusy: () => false,
  });

  it("is the budget's pause after the restart, and ends as one: the agent is started again on the 1st", async () => {
    const db = new Database(':memory:');
    let store = new Store(db);
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'API key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/key', createdAt: 'now' });
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Trip Planner', slug: 'trip', state: 'RUNNING', aiProfileId: 'key', hostId: 'h1', runtimeRef: 'mock://trip', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' });
    store.setBudget('a1', OWNER, 20, 'pause', iso(NOW));
    store.setModelProfile('a1', { since: NOW - 30 * 86_400_000, models: { 'claude-opus-4-8': spentOver() }, promptErrors: 0, crons: 0, firstCall: NOW - 60 * 86_400_000, hourly: true } as never, iso(NOW));
    // The budget's stop: the container stopped and the record says STOPPED, and
    // the process ends there, before the pass writes its pause.
    const cutOff = gate();
    const first = store;
    void runBudgets(budgetDeps(first, async (a) => { first.setAgentState(a.id, 'STOPPED'); cutOff.open(); await new Promise(() => {}); return true; }, []), NOW).catch(() => undefined);
    await cutOff.held;
    expect(store.getAgent('a1')!.state).toBe('STOPPED');
    expect(store.getBudgetPause('a1', '2026-10')).toBeUndefined();

    // Hatchabot restarts: a new store over the same database, and the next pass.
    store = new Store(db);
    const started: string[] = [];
    const stops: string[] = [];
    const deps = budgetDeps(store, async (a) => { stops.push(a.id); return true; }, started);
    await runBudgets(deps, NOW + 10 * 60_000);
    // Its own pause, not a stop by hand: was alreadyStopped, which starts nothing.
    expect(store.getBudgetPause('a1', '2026-10')).toMatchObject({ kind: 'pause' });
    expect(store.getBudgetPause('a1', '2026-10')!.alreadyStopped).toBeUndefined();
    expect(store.agentHold('a1', 'budget-pause')).toBeUndefined();
    expect(stops).toEqual([]);
    // November 1st: the budget's pause ends, and the agent is started again.
    await runBudgets(deps, Date.parse('2026-11-01T00:10:00Z'));
    expect(started).toEqual(['a1']);
    expect(store.getAgent('a1')!.state).toBe('RUNNING');
  });

  it('takes over a start an operation still owes on the agent, as the live pause does (HB-0980), so nothing starts it under the pause', async () => {
    const db = new Database(':memory:');
    let store = new Store(db);
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'API key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/key', createdAt: 'now' });
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Trip Planner', slug: 'trip', state: 'RUNNING', aiProfileId: 'key', hostId: 'h1', runtimeRef: 'mock://trip', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' });
    store.setBudget('a1', OWNER, 20, 'pause', iso(NOW));
    store.setModelProfile('a1', { since: NOW - 30 * 86_400_000, models: { 'claude-opus-4-8': spentOver() }, promptErrors: 0, crons: 0, firstCall: NOW - 60 * 86_400_000, hourly: true } as never, iso(NOW));
    // An adopt of its workspace that owes the agent a start (a restart had cut it off).
    const op = beginOperation(store, 'adopt-workspace', 'a1', { from: '/made/up/workspace', wasRunning: true });
    oweStart(store, op.id);
    op.done('Adopted the workspace again.');
    // The budget's stop, and the process ends before the pause is recorded (or the owed start settled).
    const cutOff = gate();
    const first = store;
    void runBudgets(budgetDeps(first, async (a) => { first.setAgentState(a.id, 'STOPPED'); cutOff.open(); await new Promise(() => {}); return true; }, []), NOW).catch(() => undefined);
    await cutOff.held;
    expect(startOwedIn(store.getOperation(op.id)!)).toBeDefined();

    store = new Store(db);
    await runBudgets(budgetDeps(store, async () => true, []), NOW + 10 * 60_000);
    expect(store.getBudgetPause('a1', '2026-10')).toMatchObject({ kind: 'pause' });
    // Was: still owed, for the boot's pass or the adopt's retry to start the agent under its pause.
    const after = store.getOperation(op.id)!;
    expect(startOwedIn(after)).toBeUndefined();
    expect(after.outcome).toBe('Adopted the workspace again. Its budget has paused it since, so it stays stopped.');
  });

  it('a stop that never came is no pause: the next pass pauses it as usual', async () => {
    const db = new Database(':memory:');
    let store = new Store(db);
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'API key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/key', createdAt: 'now' });
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Trip Planner', slug: 'trip', state: 'RUNNING', aiProfileId: 'key', hostId: 'h1', runtimeRef: 'mock://trip', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' });
    store.setBudget('a1', OWNER, 20, 'pause', iso(NOW));
    store.setModelProfile('a1', { since: NOW - 30 * 86_400_000, models: { 'claude-opus-4-8': spentOver() }, promptErrors: 0, crons: 0, firstCall: NOW - 60 * 86_400_000, hourly: true } as never, iso(NOW));
    // The process ends while the stop is asked for: the container runs on.
    const cutOff = gate();
    void runBudgets(budgetDeps(store, async () => { cutOff.open(); await new Promise(() => {}); return true; }, []), NOW).catch(() => undefined);
    await cutOff.held;
    store = new Store(db);
    const stops: string[] = [];
    await runBudgets(budgetDeps(store, async (a) => { stops.push(a.id); store.setAgentState(a.id, 'STOPPED'); return true; }, []), NOW + 10 * 60_000);
    expect(stops).toEqual(['a1']);
    expect(store.getBudgetPause('a1', '2026-10')).toMatchObject({ kind: 'pause' });
    expect(store.getBudgetPause('a1', '2026-10')!.alreadyStopped).toBeUndefined();
    expect(store.agentHold('a1', 'budget-pause')).toBeUndefined();
  });

  /** The budgets service as the boot and the usage passes use it, on a machine of mock runtimes. */
  const service = (store: Store, provider: MockProvider, started: string[]) => createMonthlyBudgets({
    store, providerFor: () => provider, trace: () => () => {}, tell: async () => true, chatReaches: () => false,
    secretOf: async () => '', inFlight: () => false,
    startStopped: async (a) => { started.push(a.id); store.setAgentState(a.id, 'RUNNING'); return { ok: true }; },
    applyModelToRuntime: async () => 'none', subscriptionRuntimeProblem: async () => undefined, warn: () => {}, pausedReplyEveryMs: 0,
  });

  it("HB-0835 review: the record still says RUNNING at the boot (its first reconcile not done) and STOPPED by the first pass: the pause is the budget's", async () => {
    const db = new Database(':memory:');
    let store = new Store(db);
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'API key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/key', createdAt: 'now' });
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Trip Planner', slug: 'trip', state: 'RUNNING', aiProfileId: 'key', hostId: 'h1', runtimeRef: 'mock://trip', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' });
    store.setBudget('a1', OWNER, 20, 'pause', iso(NOW));
    store.setModelProfile('a1', { since: NOW - 30 * 86_400_000, models: { 'claude-opus-4-8': spentOver() }, promptErrors: 0, crons: 0, firstCall: NOW - 60 * 86_400_000, hourly: true } as never, iso(NOW));
    // The budget's stop: Docker stopped the container, and the process ends
    // before the pause's STOPPED write, so the record still says RUNNING.
    const provider = new MockProvider();
    provider.runtimes.set('mock://trip', { spec: {} as never, phase: 'running', purged: false });
    const cutOff = gate();
    void runBudgets(budgetDeps(store, async (a) => { await provider.stop(a.runtimeRef!); cutOff.open(); await new Promise(() => {}); return true; }, []), NOW).catch(() => undefined);
    await cutOff.held;
    expect(store.getAgent('a1')!.state).toBe('RUNNING');

    // The restart. The boot waits 30 s at most for its first reconcile, and
    // this one has not put the record right by then.
    store = new Store(db);
    const started: string[] = [];
    const budgets = service(store, provider, started);
    budgets.recordCutOffPauses();
    expect(store.agentHold('a1', 'budget-pause')).toBeDefined();
    // Reconcile finds the container stopped, before the first budget pass.
    store.setAgentState('a1', 'STOPPED');
    const stops: string[] = [];
    const deps = budgetDeps(store, async (a) => { stops.push(a.id); return true; }, started);
    await runBudgets(deps, NOW + 90_000);
    // Was: let go at the boot on a record that said RUNNING, and this pass read the stop as one by hand.
    expect(store.getBudgetPause('a1', '2026-10')).toMatchObject({ kind: 'pause' });
    expect(store.getBudgetPause('a1', '2026-10')!.alreadyStopped).toBeUndefined();
    expect(store.agentHold('a1', 'budget-pause')).toBeUndefined();
    expect(stops).toEqual([]);
    // November 1st: the budget's pause ends, and the agent is started again.
    await runBudgets(deps, Date.parse('2026-11-01T00:10:00Z'));
    expect(started).toEqual(['a1']);
    budgets.stop();
  });

  it('HB-0835 review: the record still says RUNNING at the first pass: its hold is let go only for a runtime that is up, and the other is judged once reconcile has caught up', async () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'API key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/key', createdAt: 'now' });
    const provider = new MockProvider();
    // What the last process left, in October: Docker stopped
    // the first before its record said so; the second's stop never came.
    for (const [id, name, slug, phase] of [['a1', 'Trip Planner', 'trip', 'stopped'], ['a2', 'Garden Notes', 'garden', 'running']] as const) {
      store.insertAgent({ id, ownerId: OWNER, name, slug, state: 'RUNNING', aiProfileId: 'key', hostId: 'h1', runtimeRef: `mock://${slug}`, persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' });
      store.setBudget(id, OWNER, 20, 'pause', iso(NOW));
      store.setModelProfile(id, { since: NOW - 30 * 86_400_000, models: { 'claude-opus-4-8': spentOver() }, promptErrors: 0, crons: 0, firstCall: NOW - 60 * 86_400_000, hourly: true } as never, iso(NOW));
      store.setAgentHold(id, 'budget-pause', JSON.stringify({ month: '2026-10', scope: id, at: iso(NOW) }));
      provider.runtimes.set(`mock://${slug}`, { spec: {} as never, phase, purged: false });
    }
    const started: string[] = [];
    const budgets = service(store, provider, started);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // The boot, in November in any time zone (the service's month is the machine's).
      vi.setSystemTime(Date.parse('2026-11-02T12:00:00Z'));
      budgets.recordCutOffPauses();
      // The first pass, with reconcile still on its way (a slow machine).
      vi.setSystemTime(Date.parse('2026-11-02T12:01:30Z'));
      await budgets.runPass();
      // Up: its stop never took, and nothing is recorded.
      expect(store.agentHold('a2', 'budget-pause')).toBeUndefined();
      expect(store.getBudgetPause('a2', '2026-10')).toBeUndefined();
      // Was: let go on its record, as the second's was, and the stop reconcile found next read as one by hand.
      expect(store.agentHold('a1', 'budget-pause')).toBeDefined();
      expect(store.getBudgetPause('a1', '2026-10')).toBeUndefined();
      // Reconcile finds its container stopped, and the next pass judges it.
      store.setAgentState('a1', 'STOPPED');
      vi.setSystemTime(Date.parse('2026-11-02T12:11:30Z'));
      await budgets.runPass();
      expect(store.agentHold('a1', 'budget-pause')).toBeUndefined();
      expect(store.getBudgetPause('a1', '2026-10')).toMatchObject({ kind: 'pause' });
      // A new month: the budget's pause ends, and it is started again.
      expect(started).toEqual(['a1']);
    } finally {
      vi.useRealTimers();
      budgets.stop();
    }
  });

  it("a Stop by hand after the restart, where the budget's stop never came: the stop is the owner's, and the 1st starts nothing", async () => {
    const db = new Database(':memory:');
    let store = new Store(db);
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'API key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/key', createdAt: 'now' });
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Trip Planner', slug: 'trip', state: 'RUNNING', aiProfileId: 'key', hostId: 'h1', runtimeRef: 'mock://trip', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' });
    store.setBudget('a1', OWNER, 20, 'pause', iso(NOW));
    store.setModelProfile('a1', { since: NOW - 30 * 86_400_000, models: { 'claude-opus-4-8': spentOver() }, promptErrors: 0, crons: 0, firstCall: NOW - 60 * 86_400_000, hourly: true } as never, iso(NOW));
    const cutOff = gate();
    void runBudgets(budgetDeps(store, async () => { cutOff.open(); await new Promise(() => {}); return true; }, []), NOW).catch(() => undefined);
    await cutOff.held;
    store = new Store(db);
    // The owner presses Stop (the Stop route's disownPauseOnStop), before the next pass.
    const budgets = createMonthlyBudgets({
      store, providerFor: () => { throw new Error('no machine here'); }, trace: () => () => {}, tell: async () => true, chatReaches: () => false,
      secretOf: async () => '', inFlight: () => false, startStopped: async () => ({ ok: true }), applyModelToRuntime: async () => 'none',
      subscriptionRuntimeProblem: async () => undefined, warn: () => {}, pausedReplyEveryMs: 0,
    });
    store.setAgentState('a1', 'STOPPED');
    budgets.disownPauseOnStop('a1');
    budgets.stop();
    expect(store.agentHold('a1', 'budget-pause')).toBeUndefined();
    const started: string[] = [];
    const deps = budgetDeps(store, async () => true, started);
    await runBudgets(deps, NOW + 10 * 60_000);
    expect(store.getBudgetPause('a1', '2026-10')!.alreadyStopped).toBe(true); // stopped by hand, as it was
    await runBudgets(deps, Date.parse('2026-11-01T00:10:00Z'));
    expect(started).toEqual([]);
    expect(store.getAgent('a1')!.state).toBe('STOPPED');
  });

  it("HB-1416: its machine does not answer after the restart and the budget is still over: the pass's own stop keeps the earlier hold, so the stop found later is the budget's", async () => {
    const db = new Database(':memory:');
    let store = new Store(db);
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'API key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/key', createdAt: 'now' });
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Trip Planner', slug: 'trip', state: 'RUNNING', aiProfileId: 'key', hostId: 'h1', runtimeRef: 'mock://trip', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' });
    store.setBudget('a1', OWNER, 20, 'pause', iso(NOW));
    store.setModelProfile('a1', { since: NOW - 30 * 86_400_000, models: { 'claude-opus-4-8': spentOver() }, promptErrors: 0, crons: 0, firstCall: NOW - 60 * 86_400_000, hourly: true } as never, iso(NOW));
    // The budget's stop: Docker stopped the container, and the process ends
    // before the pause's STOPPED write, so the record still says RUNNING.
    const cutOff = gate();
    void runBudgets(budgetDeps(store, async () => { cutOff.open(); await new Promise(() => {}); return true; }, []), NOW).catch(() => undefined);
    await cutOff.held;
    const kept = store.agentHold('a1', 'budget-pause');
    expect(kept).toBeDefined();

    // The restart. Its machine does not answer: neither the pass's look at its
    // runtime nor the stop the pass tries itself, its budget still over.
    store = new Store(db);
    const asleep = async (): Promise<never> => { throw new Error('the machine did not answer'); };
    await runBudgets({ ...budgetDeps(store, asleep, []), runtimeUp: asleep }, NOW + 90_000);
    // Was: replaced by the pass's own hold, and let go when that stop failed.
    expect(store.agentHold('a1', 'budget-pause')).toBe(kept);
    expect(store.getBudgetPause('a1', '2026-10')).toBeUndefined();
    // Its machine answers again, and reconcile finds the container stopped.
    store.setAgentState('a1', 'STOPPED');
    const started: string[] = [];
    const deps = budgetDeps(store, async () => true, started);
    await runBudgets(deps, NOW + 10 * 60_000);
    // The budget's pause, not a stop by hand (was: alreadyStopped, which starts nothing).
    expect(store.getBudgetPause('a1', '2026-10')).toMatchObject({ kind: 'pause' });
    expect(store.getBudgetPause('a1', '2026-10')!.alreadyStopped).toBeUndefined();
    expect(store.agentHold('a1', 'budget-pause')).toBeUndefined();
    // November 1st: the budget's pause ends, and the agent is started again.
    await runBudgets(deps, Date.parse('2026-11-01T00:10:00Z'));
    expect(started).toEqual(['a1']);
  });

  it("HB-1406: its owner's Start over a budget stop a restart cut off before the pause's record: the next pass leaves it running until the 1st", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      let w = await makeWorld();
      closers.push(() => w.f.close());
      const id = await seedRunningAgent(w);
      w.store.setBudget(id, OWNER, 20, 'pause', iso(NOW));
      w.store.setModelProfile(id, { since: NOW - 30 * 86_400_000, models: { 'claude-opus-4-8': spentOver() }, promptErrors: 0, crons: 0, firstCall: NOW - 60 * 86_400_000, hourly: true } as never, iso(NOW));
      // The budget's stop: its hold, then Docker stopped the container; the
      // process ends before the record says STOPPED or the pause is recorded.
      w.store.setAgentHold(id, 'budget-pause', JSON.stringify({ month: '2026-10', scope: id, at: iso(NOW) }));
      await w.provider.stop(w.store.getAgent(id)!.runtimeRef!);
      w = await restartWorld(w);
      closers.push(() => w.f.close());
      await w.routes!.resumeOperations();
      // The boot leaves the hold of a record that says RUNNING for a pass (HB-0835 review).
      expect(w.store.agentHold(id, 'budget-pause')).toBeDefined();
      // Reconcile finds the container stopped, and its owner presses Start before the first budget pass.
      w.store.setAgentState(id, 'STOPPED');
      const res = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: as() });
      expect(res.statusCode, res.body).toBe(200);
      expect(w.store.getAgent(id)?.state).toBe('RUNNING');
      const stops: string[] = [];
      await runBudgets(budgetDeps(w.store, async (a) => { stops.push(a.id); return true; }, []), NOW + 90_000);
      // Was: no pause was recorded, so nothing marked the Start, and this pass stopped it again.
      expect(stops).toEqual([]);
      expect(w.store.getBudgetPause(id, '2026-10')).toMatchObject({ kind: 'pause', resumedBy: 'owner' });
      expect(w.store.agentHold(id, 'budget-pause')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('HB-1416: a stop the pass makes over an earlier hold that takes is recorded, and the hold goes with it', async () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'API key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/key', createdAt: 'now' });
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Trip Planner', slug: 'trip', state: 'RUNNING', aiProfileId: 'key', hostId: 'h1', runtimeRef: 'mock://trip', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' });
    store.setBudget('a1', OWNER, 20, 'pause', iso(NOW));
    store.setModelProfile('a1', { since: NOW - 30 * 86_400_000, models: { 'claude-opus-4-8': spentOver() }, promptErrors: 0, crons: 0, firstCall: NOW - 60 * 86_400_000, hourly: true } as never, iso(NOW));
    store.setAgentHold('a1', 'budget-pause', JSON.stringify({ month: '2026-10', scope: 'a1', at: iso(NOW - 60_000) }));
    const stops: string[] = [];
    // Its runtime not seen (the look failed), and the stop takes.
    await runBudgets({ ...budgetDeps(store, async (a) => { stops.push(a.id); store.setAgentState(a.id, 'STOPPED'); return true; }, []), runtimeUp: async () => false }, NOW + 90_000);
    expect(stops).toEqual(['a1']);
    expect(store.getBudgetPause('a1', '2026-10')).toMatchObject({ kind: 'pause' });
    expect(store.getBudgetPause('a1', '2026-10')!.alreadyStopped).toBeUndefined();
    expect(store.agentHold('a1', 'budget-pause')).toBeUndefined();
  });
});

describe("a budget's switch to a cheaper model cut off before its runtime answered (HB-1404)", () => {
  const NOW = Date.parse('2026-10-20T12:00:00Z');
  /** $25 of the default model's input in the hour a day before NOW: over a $20 budget. */
  const spentOver = (): WindowModelStats => {
    const hours: Record<string, number[]> = { [new Date(NOW - 86_400_000).toISOString().slice(0, 13)]: HOUR_FIELDS.map((f) => (f === 'input' ? 25 * 200_000 : 0)) };
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, toolUseCalls: 0, turns: 0, toolTurns: 0, toolCalls: 0, failedTurns: 0, failed7d: 0, first: 0, last: 0, ctxP50: 0, ctxP90: 0, h: hours } as unknown as WindowModelStats;
  };
  /** The budgets service of a process, over its own store and settings, as routes.ts builds it. */
  const budgetsOf = (h: House, life: Life) => createMonthlyBudgets({
    store: life.store, providerFor: () => h.provider,
    trace: (agentId) => (event, detail) => { h.events.push({ agentId, event, detail }); },
    tell: async () => true, chatReaches: () => false, secretOf: async () => '', inFlight: () => false,
    startStopped: async () => ({ ok: true }),
    applyModelToRuntime: (id) => life.settings.models.applyModelToRuntime(id),
    subscriptionRuntimeProblem: (a, p, m) => life.settings.models.subscriptionRuntimeProblem(a, p, m),
    warn: () => {}, pausedReplyEveryMs: 0,
  });
  /** One agent over its $20 "cheaper" budget, and the first process's pass cut off while its runtime is told the cheaper model. */
  async function cutOffSwitch() {
    const h = house(), a = await h.agent('a1');
    h.now.store.setBudget(a.id, OWNER, 20, 'cheaper', new Date(NOW).toISOString());
    h.now.store.setModelProfile(a.id, { since: NOW - 30 * 86_400_000, models: { [DEFAULT]: spentOver() }, promptErrors: 0, crons: 0, firstCall: NOW - 60 * 86_400_000, hourly: true } as never, new Date(NOW).toISOString());
    const exec = h.provider.exec.bind(h.provider);
    const asked = gate();
    h.provider.exec = async (ref, argv, opts) => { if (argv[0] === 'models') { asked.open(); await new Promise(() => {}); } return exec(ref, argv, opts); };
    const first = budgetsOf(h, h.now);
    void first.runPass();
    await asked.held;
    first.stop();
    // What the process left: the cheaper model on the record, asked for, and the switch open.
    expect(h.now.store.getAgent(a.id)).toMatchObject({ model: OTHER, appliedModel: DEFAULT });
    expect(h.now.store.agentHold(a.id, 'model-apply')).toBeTruthy();
    expect(h.now.store.openCheaperPause(a.id)).toMatchObject({ toModel: OTHER, fromModel: null });
    h.provider.exec = exec;
    return { h, a };
  }
  afterEach(() => { vi.useRealTimers(); });

  it('refused at the next start: its own model goes back and the switch is dropped, so the next pass tries again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { h, a } = await cutOffSwitch();
    // Hatchabot restarts, and the runtime refuses the cheaper model now.
    h.provider.execResponses.set('models set', { code: 1, stdout: '', stderr: 'no such model' });
    const next = h.restart();
    const budgets = budgetsOf(h, next);
    h.owedRefused = (id, ask, how) => budgets.cheaperRefused(id, ask, how);
    await next.settings.resume();
    // Was: the cheaper model and the open switch stayed, the agent on its dearer model, and no pass tried again.
    expect(next.store.getAgent(a.id)?.model ?? null).toBeNull(); // its own: its source's default
    expect(next.store.getAgent(a.id)?.appliedModel).toBe(DEFAULT);
    expect(next.store.openCheaperPause(a.id)).toBeUndefined();
    expect(next.store.getBudgetPause(a.id, '2026-10')).toBeUndefined();
    expect(h.events.filter((e) => e.event === 'budget.downgrade_failed')).toEqual([
      { agentId: a.id, event: 'budget.downgrade_failed', detail: { agentId: a.id, error: `the runtime did not take ${OTHER} when Hatchabot restarted` } },
    ]);
    // The runtime takes it again, and the next pass makes the switch.
    h.provider.execResponses.delete('models set');
    vi.setSystemTime(NOW + 10 * 60_000);
    await budgets.runPass();
    expect(next.store.getAgent(a.id)).toMatchObject({ model: OTHER, appliedModel: OTHER });
    expect(next.store.openCheaperPause(a.id)).toMatchObject({ toModel: OTHER });
    budgets.stop();
  });

  it('taken at the next start: the switch stands', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { h, a } = await cutOffSwitch();
    const next = h.restart();
    const budgets = budgetsOf(h, next);
    h.owedRefused = (id, ask, how) => budgets.cheaperRefused(id, ask, how);
    await next.settings.resume();
    expect(next.store.getAgent(a.id)).toMatchObject({ model: OTHER, appliedModel: OTHER });
    expect(next.store.openCheaperPause(a.id)).toMatchObject({ toModel: OTHER });
    budgets.stop();
  });

  it("a model the owner chose since, refused at the next start, is theirs: it stays, and so does the switch's record", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { h, a } = await cutOffSwitch();
    // The owner picks the same cheap model on the agent's page before the restart: their ask replaces the budget's.
    h.now.store.setAgentModel(a.id, OTHER, { apply: true });
    h.provider.execResponses.set('models set', { code: 1, stdout: '', stderr: 'no such model' });
    const next = h.restart();
    const budgets = budgetsOf(h, next);
    h.owedRefused = (id, ask, how) => budgets.cheaperRefused(id, ask, how);
    await next.settings.resume();
    expect(next.store.getAgent(a.id)?.model).toBe(OTHER);
    expect(next.store.openCheaperPause(a.id)).toMatchObject({ toModel: OTHER });
    expect(h.events.filter((e) => e.event === 'budget.downgrade_failed')).toEqual([]);
    budgets.stop();
  });

  /** The next process, its budgets told of a refused owed ask, as routes.ts wires them. */
  const nextProcess = (h: House) => {
    const next = h.restart();
    const budgets = budgetsOf(h, next);
    h.owedRefused = (id, ask, how) => budgets.cheaperRefused(id, ask, how);
    return { next, budgets };
  };
  const failed = (h: House, id: string) => h.events.filter((e) => e.event === 'budget.downgrade_failed' && e.agentId === id);

  it('refused before it is tried (it waits for the image that can run it): its own model goes back, as for one the runtime refused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { h, a } = await cutOffSwitch();
    // The cheaper model is held back for an image the agent is not on yet (classChanges.ts).
    h.now.store.setAgentHold(a.id, 'model-waits-image', OTHER);
    const { next, budgets } = nextProcess(h);
    await next.settings.resume();
    expect(modelsSet(h.provider)).not.toContain(`anthropic/${OTHER}`);
    expect(next.store.getAgent(a.id)?.model ?? null).toBeNull();
    expect(next.store.openCheaperPause(a.id)).toBeUndefined();
    expect(failed(h, a.id)).toHaveLength(1);
    budgets.stop();
  });

  it('on a source switched since, the cheaper model stands, as in the pass: only the switch\'s record goes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { h, a } = await cutOffSwitch();
    // Switched to another source that offers the same model, before the restart; its rebuild has not run.
    h.now.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Claude 2', vendor: 'anthropic', kind: 'api_key', model: SONNET, models: [OTHER], secretRef: 'ai/p2', createdAt: 'now' });
    expect(h.now.store.setAgentAIProfile(a.id, 'p2')).toBe('ok');
    h.now.store.setAgentHold(a.id, 'model-waits-image', OTHER);
    const { next, budgets } = nextProcess(h);
    await next.settings.resume();
    // Was: put back to null, so on the new source it followed that source's default.
    expect(next.store.getAgent(a.id)).toMatchObject({ aiProfileId: 'p2', model: OTHER });
    expect(next.store.openCheaperPause(a.id)).toBeUndefined();
    expect(failed(h, a.id)).toHaveLength(1);
    budgets.stop();
  });

  it("a follower whose source's default moved since is held on the default it followed, as the pass holds it", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { h, a } = await cutOffSwitch();
    // Before the restart, the source's default moves on; the one the agent followed is still on its menu.
    h.now.store.setAIProfileModels('p1', [OTHER, DEFAULT]);
    h.now.store.setAIProfileModel('p1', SONNET);
    h.provider.execResponses.set('models set', { code: 1, stdout: '', stderr: 'no such model' });
    const { next, budgets } = nextProcess(h);
    await next.settings.resume();
    // Was: null, which put it on the new default, a model it never ran.
    expect(next.store.getAgent(a.id)?.model).toBe(DEFAULT);
    expect(next.store.openCheaperPause(a.id)).toBeUndefined();
    budgets.stop();
  });

  it('the owner asks for the same cheaper model while the next start waits to try the budget\'s: their choice stands', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { h, a } = await cutOffSwitch();
    h.now.store.setAgentHold(a.id, 'model-waits-image', OTHER);
    const { next, budgets } = nextProcess(h);
    // A rebuild of its, put back in the queue at the start, holds the start's ask where it is.
    const rebuild = gate();
    next.flights.set(a.id, rebuild.held);
    const resumed = next.settings.resume();
    await tick();
    // The owner picks the same model on the agent's page: their write, and their own ask.
    next.store.setAgentModel(a.id, OTHER, { apply: true });
    next.flights.delete(a.id);
    rebuild.open();
    await resumed;
    // Was: the refusal of the budget's ask put back null, over the owner's choice.
    expect(next.store.getAgent(a.id)?.model).toBe(OTHER);
    expect(next.store.openCheaperPause(a.id)).toMatchObject({ toModel: OTHER });
    expect(failed(h, a.id)).toEqual([]);
    budgets.stop();
  });

  it("the owner's choice of the same model, served while the start's write of the budget's was under way, is not undone when that write is refused", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { h, a } = await cutOffSwitch();
    const { next, budgets } = nextProcess(h);
    const exec = h.provider.exec.bind(h.provider);
    const writing = gate(), answer = gate();
    h.provider.exec = async (ref, argv, opts) => {
      if (argv[0] === 'models' && argv[1] === 'set') { writing.open(); await answer.held; return { code: 1, stdout: '', stderr: 'no such model' }; }
      return exec(ref, argv, opts);
    };
    const resumed = next.settings.resume();
    await writing.held;
    // The owner's choice of the same model, asked and served (its ask let go) while the start's write waits.
    next.store.setAgentModel(a.id, OTHER, { apply: true });
    next.store.clearAgentHold(a.id, 'model-apply');
    answer.open();
    await resumed;
    h.provider.exec = exec;
    expect(next.store.getAgent(a.id)?.model).toBe(OTHER);
    expect(next.store.openCheaperPause(a.id)).toMatchObject({ toModel: OTHER });
    expect(failed(h, a.id)).toEqual([]);
    budgets.stop();
  });

  // What HB-1404 left (HB-1444).
  it("HB-1444 (1): the cheaper model put back for a pause that did not take, cut off and then refused at the next start: its own model comes back and the switch closes, as in the pass", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const h = house(), a = await h.agent('a1');
    const { store } = h.now;
    // On the cheaper model its own budget chose, and the machine's budget, set to pause, reached too.
    store.setBudget(a.id, OWNER, 20, 'cheaper', new Date(NOW).toISOString());
    store.setBudget(MACHINE, OWNER, 20, 'pause', new Date(NOW).toISOString());
    store.setModelProfile(a.id, { since: NOW - 30 * 86_400_000, models: { [DEFAULT]: spentOver() }, promptErrors: 0, crons: 0, firstCall: NOW - 60 * 86_400_000, hourly: true } as never, new Date(NOW).toISOString());
    store.setAgentModel(a.id, OTHER, { hatchabot: true });
    store.setAgentApplied(a.id, 'p1', OTHER);
    store.addBudgetPause(a.id, '2026-10', a.id, new Date(NOW - 3_600_000).toISOString(), { fromModel: null, toModel: OTHER });
    // The machine's pause: its own model goes back first, then its stop fails, so the cheaper model goes back
    // on (reapplyCheaper); the process ends while its runtime is told.
    const stop = h.provider.stop.bind(h.provider);
    h.provider.stop = async () => { throw new Error('docker said no'); };
    const exec = h.provider.exec.bind(h.provider);
    const asked = gate();
    h.provider.exec = async (ref, argv, opts) => {
      if (argv[0] === 'models' && argv[1] === 'set' && String(argv[2]).endsWith(OTHER)) { asked.open(); await new Promise(() => {}); }
      return exec(ref, argv, opts);
    };
    const first = budgetsOf(h, h.now);
    void first.runPass();
    await asked.held;
    first.stop();
    h.provider.stop = stop;
    h.provider.exec = exec;
    expect(store.getAgent(a.id)).toMatchObject({ model: OTHER, appliedModel: DEFAULT });
    expect(store.agentHold(a.id, 'model-apply')).toBeTruthy();
    expect(store.openCheaperPause(a.id)).toMatchObject({ toModel: OTHER });
    // Hatchabot restarts, and the runtime refuses the cheaper model now.
    h.provider.execResponses.set('models set', { code: 1, stdout: '', stderr: 'no such model' });
    const { next, budgets } = nextProcess(h);
    await next.settings.resume();
    // Was: the cheaper model stayed on the record and its switch open, the agent on its own, dearer model.
    expect(next.store.getAgent(a.id)?.model ?? null).toBeNull();
    expect(next.store.openCheaperPause(a.id)).toBeUndefined();
    expect(next.store.getBudgetPause(a.id, '2026-10')).toMatchObject({ resumedBy: 'budget-changed' });
    expect(h.events.filter((e) => e.event === 'budget.model_restored' && e.agentId === a.id).map((e) => e.detail.why)).toEqual(['budget-changed']);
    budgets.stop();
  });

  it("HB-1444 (2): answered 'rebuild' at the next start (a source switch waits for its rebuild): taken as refused, its own model back", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { h, a } = await cutOffSwitch();
    // Its container still runs another source's setup, which a rebuild is owed to replace.
    h.now.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Claude 2', vendor: 'anthropic', kind: 'api_key', model: DEFAULT, secretRef: 'ai/p2', createdAt: 'now' });
    h.now.store.setAgentApplied(a.id, 'p2', DEFAULT);
    const { next, budgets } = nextProcess(h);
    await next.settings.resume();
    expect(h.events.some((e) => e.event === 'model.after_restart' && e.detail.how === 'rebuild')).toBe(true);
    // Was: the cheaper model and its switch stood, the budget counting it as made while the agent ran its dearer one.
    expect(next.store.getAgent(a.id)?.model ?? null).toBeNull();
    expect(next.store.openCheaperPause(a.id)).toBeUndefined();
    expect(failed(h, a.id)).toHaveLength(1);
    budgets.stop();
  });

  it("HB-1444 review: answered 'rebuild' because its owner switched it since to a source that offers the cheaper model: the model and the budget's switch stand", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { h, a } = await cutOffSwitch();
    // Switched to another source that offers the same model, before the restart; its rebuild has not run.
    h.now.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Claude 2', vendor: 'anthropic', kind: 'api_key', model: SONNET, models: [OTHER], secretRef: 'ai/p2', createdAt: 'now' });
    expect(h.now.store.setAgentAIProfile(a.id, 'p2')).toBe('ok');
    const { next, budgets } = nextProcess(h);
    await next.settings.resume();
    expect(h.events.some((e) => e.event === 'model.after_restart' && e.detail.how === 'rebuild')).toBe(true);
    // That switch is what waits: its rebuild puts the model on. The budget's row stays, so the 1st puts its own model back.
    expect(next.store.getAgent(a.id)).toMatchObject({ aiProfileId: 'p2', model: OTHER });
    expect(next.store.openCheaperPause(a.id)).toMatchObject({ toModel: OTHER });
    expect(failed(h, a.id)).toEqual([]);
    budgets.stop();
  });

  it("HB-1444 (3): an owner's choice of the same model, without an apply, made while a seventh agent waits for its turn: not undone by the refusal", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const h = house();
    const ids: string[] = [];
    for (const [i, name] of ['Kitchen', 'Garden', 'Laundry', 'Pantry', 'Porch', 'Attic', 'Cellar'].entries()) {
      const { id } = await h.agent(`a${i + 1}`, name);
      // Each on the cheaper model a budget chose, its ask cut off before the runtime answered.
      h.now.store.setAgentModel(id, OTHER, { hatchabot: true, apply: `budget-cheaper:${JSON.stringify({ source: 'p1', defaultThen: DEFAULT, n: `made-up-${i}` })}` });
      h.now.store.addBudgetPause(id, '2026-10', id, new Date(NOW).toISOString(), { fromModel: null, toModel: OTHER });
      ids.push(id);
    }
    const { next, budgets } = nextProcess(h);
    // Each write of the six that go first is slow, then refused.
    const exec = h.provider.exec.bind(h.provider);
    const g = gate();
    const writing = new Set<string>();
    h.provider.exec = async (ref, argv, opts) => {
      if (argv[0] === 'models' && argv[1] === 'set') { writing.add(ref); await g.held; return { code: 1, stdout: '', stderr: 'no such model' }; }
      return exec(ref, argv, opts);
    };
    const resumed = next.settings.resume();
    try {
      for (let i = 0; i < 200 && writing.size < 6; i++) await tick();
      expect(writing.size).toBe(6);
      for (let i = 0; i < 20; i++) await tick();
      expect(writing.size).toBe(6);
      // The seventh, waiting for a slot: its owner chooses the same model on its page, without an apply.
      const seventh = ids.find((id) => !writing.has(next.store.getAgent(id)!.runtimeRef!))!;
      next.store.setAgentModel(seventh, OTHER);
      g.open();
      await resumed;
      // Was: its generation read only in its slot, after their write: the refusal put back null over their choice.
      expect(next.store.getAgent(seventh)?.model).toBe(OTHER);
      expect(next.store.openCheaperPause(seventh)).toMatchObject({ toModel: OTHER });
      // The six refused are undone, as before.
      for (const id of ids.filter((x) => x !== seventh)) expect(next.store.getAgent(id)?.model ?? null).toBeNull();
    } finally { g.open(); h.provider.exec = exec; }
    budgets.stop();
  });

  it('HB-1444 (4): an open switch to a cheaper model is dropped only by the budget that made it', () => {
    const h = house();
    const { store } = h.now;
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    // The machine's budget made it.
    store.addBudgetPause('a1', '2026-10', MACHINE, new Date(NOW).toISOString(), { fromModel: null, toModel: OTHER });
    // Was: the agent's own budget's undoing dropped it all the same.
    store.dropCheaperPause('a1', '2026-10', 'a1');
    expect(store.openCheaperPause('a1')).toMatchObject({ scope: MACHINE, toModel: OTHER });
    store.dropCheaperPause('a1', '2026-10', MACHINE);
    expect(store.openCheaperPause('a1')).toBeUndefined();
  });
});

// Last in the file: these load provision.ts afresh (vi.resetModules), as a new process does.
describe('the memory index to rebuild after a build that changed its engine', () => {
  class MemSecrets {
    map = new Map<string, string>();
    async put(ref: string, v: string) { this.map.set(ref, v); }
    async get(ref: string) { const v = this.map.get(ref); if (v === undefined) throw new Error('missing'); return v; }
    async delete(ref: string) { this.map.delete(ref); }
  }
  /** An agent switched to the shared memory search service, about to be rebuilt onto it. */
  async function switched() {
    const db = new Database(':memory:');
    const store = new Store(db);
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' });
    const secrets = new MemSecrets();
    await secrets.put('ai/p1', 'made-up-key');
    const provider = new MockProvider();
    store.insertAgent({ id: 'todo', ownerId: OWNER, name: 'To Do', slug: 'to-do', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' });
    store.setAgentEmbedMode('todo', 'shared');
    const calls: string[][] = [];
    const exec = provider.exec.bind(provider);
    provider.exec = async (ref, argv, opts) => {
      if (argv[0] === 'memory') { calls.push(argv); return { code: 0, stdout: argv[1] === 'status' ? 'Embeddings: ready\nSemantic vectors: ready' : '', stderr: '' }; }
      return exec(ref, argv, opts);
    };
    const depsOver = (s: Store): ProvisionDeps => ({
      store: s, secrets, provider, channel: { kind: 'telegram', pool: { owns: () => false } } as never, log: () => {}, sleep: async () => {},
      embedder: { async credentialsFor(id) { const t = `key-for-${id}`; s.setEmbedToken(id, embedKeyHash(t)); return { baseUrl: 'http://172.17.0.1:8093/v1', token: t, model: 'embeddinggemma' }; } },
    });
    return { db, store, provider, calls, depsOver };
  }
  /**
   * provision.ts as a new process loads it: what the module itself held in
   * memory (the decision a build hands to its re-index step used to be
   * there) is gone, as after a real restart.
   */
  const nextProcess = async (): Promise<typeof import('../src/orchestrator/lifecycle/provision.js')> => {
    vi.resetModules();
    return import('../src/orchestrator/lifecycle/provision.js');
  };

  it('is rebuilt by the resumed build when a restart came between its new container and that step', async () => {
    const w = await switched();
    // The rebuild as far as its new container, accepted and started: REBUILDING, its steps after health not run.
    const spec = await buildRuntimeSpec(w.depsOver(w.store), 'todo');
    const { runtimeRef } = await w.provider.provision(spec);
    w.store.setAgentRuntimeRef('todo', runtimeRef);
    w.store.setAgentState('todo', 'RUNNING');
    w.store.setAgentState('todo', 'REBUILDING');
    recordApplied(w.store, 'todo', spec);
    await w.provider.start(runtimeRef);
    expect(w.store.getAgent('todo')?.appliedEmbedMode).toBe('shared'); // the record says the switch is made
    expect(w.calls).toEqual([]);

    // Hatchabot restarts. The build is resumed where it stood (operationsResume.ts, a rebuild whose container answers).
    const next = new Store(w.db);
    const fresh = await nextProcess();
    expect(fresh.finishInterruptedRebuild).not.toBe(finishInterruptedRebuild);
    const after = await fresh.finishInterruptedRebuild(w.depsOver(next), 'todo');
    expect(after?.state).toBe('RUNNING');
    expect(w.calls).toEqual([
      ['memory', 'index', '--force', '--agent', 'to-do'],
      ['memory', 'status', '--deep', '--agent', 'to-do'],
    ]);
    expect(next.getAgent('todo')?.embedIndexedAt).toBeTruthy();
    expect(next.agentHold('todo', 'embed-reindex')).toBeUndefined();
    // Done once: asked again with nothing kept, it does nothing.
    await fresh.reindexMemoryIfSwitched(w.depsOver(next), 'todo', runtimeRef, () => {});
    expect(w.calls).toHaveLength(2);
  });

  it('cut off in the middle of the index itself, it is kept and run again', async () => {
    const w = await switched();
    const spec = await buildRuntimeSpec(w.depsOver(w.store), 'todo');
    const { runtimeRef } = await w.provider.provision(spec);
    w.store.setAgentRuntimeRef('todo', runtimeRef);
    recordApplied(w.store, 'todo', spec);
    await w.provider.start(runtimeRef);
    const exec = w.provider.exec;
    // The first process's index never answers: it ends in the middle of it.
    w.provider.exec = async (ref, argv, opts) => { if (argv[0] === 'memory') await new Promise(() => {}); return exec(ref, argv, opts); };
    void reindexMemoryIfSwitched(w.depsOver(w.store), 'todo', runtimeRef, () => {});
    await tick();
    w.provider.exec = exec;

    const next = new Store(w.db);
    expect(next.agentHold('todo', 'embed-reindex')).toBeTruthy();
    await (await nextProcess()).reindexMemoryIfSwitched(w.depsOver(next), 'todo', runtimeRef, () => {});
    expect(w.calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['memory index', 'memory status']);
    expect(next.agentHold('todo', 'embed-reindex')).toBeUndefined();
  });
});

describe('the shutdown, as src/index.ts runs it (HB-1171 review)', () => {
  it("a service whose stop throws keeps none after it from stopping, and a merge the shutdown cuts off is waiting again", async () => {
    const w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    w.store.insertProposal({ id: 'p1', masterAgentId: id, childAgentId: 'c1', childName: 'Homework Helper', text: 'a lesson' });
    expect(w.store.resolveProposal(id, 'p1', 'merging')).toBe(true);
    expect(w.store.listProposals(id)).toEqual([]);
    // One stop throws: the routes' own, which every request in flight hears.
    const errors = vi.spyOn(w.f.log, 'error');
    const abort = vi.spyOn(AbortController.prototype, 'abort').mockImplementation(() => { throw new Error('made-up stop failure'); });
    try { expect(() => w.routes!.stop()).not.toThrow(); } finally { abort.mockRestore(); }
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ service: 'routes', err: 'made-up stop failure' }), 'shutdown: a service did not stop');
    // The stops after it were still run: those that end an abort of their own say so too.
    const failed = errors.mock.calls.map((c) => (c[0] as { service?: string }).service);
    expect(failed[0]).toBe('routes');
    expect(failed.length).toBeGreaterThan(1);
    expect(w.store.listProposals(id).map((p) => p.id)).toEqual(['p1']);
  });
});
