import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { markBusy } from '../src/orchestrator/lifecycle/busy.js';
import { createSourceHolds, type SourceHolds } from '../src/orchestrator/lifecycle/sourceHolds.js';
import {
  checkLocalServer, createAiSources, CURATED_ANTHROPIC_MODELS, keptLine, limitsSaid, usesSource,
  type AiSources, type KeptLine, type SwitchTally,
} from '../src/orchestrator/sources/aiSources.js';
import type { Agent } from '../src/domain/types.js';

/**
 * The AI sources service (HB-0808): bulk switches onto a source, a default
 * model applied to the agents on one, and a source's model list, driven as
 * the routes drive it but with no HTTP server. A real store on an in-memory
 * database and the real source holds; plain functions for what the service
 * asks of the agent settings service and of the setup and rebuild queue.
 */
const OWNER = 'user-owner';
const NEIGHBOUR = 'user-neighbour';
const DEFAULT = 'claude-opus-4-8';
const OTHER = 'claude-haiku-4-5';

interface World {
  store: Store;
  provider: MockProvider;
  holds: SourceHolds;
  sources: AiSources;
  /** What the service asked for, in order. */
  asked: string[];
  /** What the source-switch runtime check answers (and how long it waits). */
  runtime: { dropPin?: boolean; problem?: string; wait?: Promise<void> };
  /** What the subscription check answers per agent id, and what it waits for first. */
  tooOld: Map<string, string>;
  tooOldWait?: Promise<void>;
  /** Whether a rebuild is queued when asked. */
  rebuildQueued: boolean;
  agent(id: string, opts?: { name?: string; owner?: string; profile?: string; state?: 'RUNNING' | 'STOPPED'; model?: string; ops?: boolean }): Agent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function world(): World {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: DEFAULT, models: [OTHER], secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Other key', vendor: 'anthropic', kind: 'api_key', model: DEFAULT, secretRef: 'ai/p2', createdAt: 'now' });
  const holds = createSourceHolds();
  const w = { store, provider, holds, asked: [] as string[], runtime: {} as World['runtime'], tooOld: new Map<string, string>(), rebuildQueued: true } as World;
  w.sources = createAiSources({
    store,
    secretOf: async (ref) => `secret-for-${ref}`,
    providerFor: (hostId) => { if (hostId !== 'h1') throw new Error(`no host ${hostId}`); return provider; },
    agentGone: (id) => { const state = store.getAgent(id)?.state; return !state || state === 'DELETED' || state === 'DELETING'; },
    models: {
      sourceSwitchRuntime: async () => { await w.runtime.wait; return { dropPin: w.runtime.dropPin, problem: w.runtime.problem }; },
      subscriptionRuntimeProblem: async (a) => { await w.tooOldWait; return w.tooOld.get(a.id); },
      applyModelToRuntime: async (agentId) => { w.asked.push(`apply ${agentId}`); return 'live'; },
      askToApply: (agentId) => { w.asked.push(`ask ${agentId}`); },
      pushModelList: async (profileId) => { w.asked.push(`list ${profileId}`); },
    },
    detachClassIfDrifted: () => ({ detached: false }),
    withSourceHold: holds.withSourceHold,
    kickRebuild: (agentId, opts) => { w.asked.push(`rebuild ${agentId}${opts.checkpoint ? ' checkpoint' : ''}${opts.recoverOn ? ` recover-on ${opts.recoverOn}` : ''}`); return w.rebuildQueued; },
    oweRebuild: (agentId) => { w.asked.push(`owe ${agentId}`); },
    recoverAfterRebuild: (agentId) => { w.asked.push(`recover ${agentId}`); },
  });
  w.agent = (id, opts = {}) => {
    const name = opts.name ?? 'Kitchen';
    store.insertAgent({ id, ownerId: opts.owner ?? OWNER, name, slug: name.toLowerCase(), state: 'PROVISIONING', aiProfileId: opts.profile ?? 'p1', hostId: 'h1', persona: 'helps cook', sharedMemory: true, ...(opts.ops ? { ops: true } : {}), createdAt: 'now', updatedAt: 'now' });
    store.setAgentRuntimeRef(id, `ref-${id}`);
    store.setAgentState(id, 'RUNNING');
    if (opts.state === 'STOPPED') store.setAgentState(id, 'STOPPED');
    if (opts.model) store.setAgentModel(id, opts.model);
    return store.getAgent(id)!;
  };
  return w;
}

const tally = (): SwitchTally => ({ switched: 0, rebuilding: 0, atNextStart: 0, notRecovered: 0, classDetached: 0, skipped: [] });

describe('switchAgentToSource', () => {
  it('moves the agent and holds the source it goes to until it is written', async () => {
    const w = world();
    const a = w.agent('a1');
    let open!: () => void;
    w.runtime.wait = new Promise<void>((r) => { open = r; });
    const t = tally();
    const going = w.sources.switchAgentToSource(a, w.store.getAIProfile('p2')!, {}, t, []);
    // The runtime check is waiting: the source may not be deleted meanwhile.
    expect(w.holds.sourceHeld('p2')).toBe(true);
    open();
    await going;
    expect(w.holds.sourceHeld('p2')).toBe(false);
    expect(w.store.getAgent('a1')!.aiProfileId).toBe('p2');
    expect(t).toMatchObject({ switched: 1, rebuilding: 0, skipped: [] });
    // No rebuild was asked for.
    expect(w.asked).toEqual([]);
  });

  it('takes no hold and changes nothing for an agent already on the source', async () => {
    const w = world();
    const a = w.agent('a1', { profile: 'p2' });
    const t = tally();
    await w.sources.switchAgentToSource(a, w.store.getAIProfile('p2')!, { rebuild: true }, t, []);
    expect(t.switched).toBe(0);
    expect(w.asked).toEqual([]);
  });

  it('skips a busy agent, a deleted one, and one the runtime check refuses, and says why', async () => {
    const w = world();
    const busy = w.agent('a1', { name: 'Busy' });
    markBusy('a1');
    const gone = w.agent('a2', { name: 'Gone' });
    w.store.setAgentState('a2', 'DELETING');
    const t = tally();
    const target = w.store.getAIProfile('p2')!;
    await w.sources.switchAgentToSource(busy, target, {}, t, []);
    await w.sources.switchAgentToSource(gone, target, {}, t, []);
    const refused = w.agent('a3', { name: 'Old' });
    w.runtime.problem = 'its OpenClaw is too old for that model';
    await w.sources.switchAgentToSource(refused, target, {}, t, []);
    expect(t.switched).toBe(0);
    expect(t.skipped).toEqual([
      { name: 'Busy', reason: 'busy (a rebuild, a move or a backup) — switch it when that is done' },
      { name: 'Gone', reason: 'it was deleted' },
      { name: 'Old', reason: 'its OpenClaw is too old for that model' },
    ]);
    expect(w.store.getAgent('a1')!.aiProfileId).toBe('p1');
    expect(w.store.getAgent('a3')!.aiProfileId).toBe('p1');
  });

  it("refuses another account's agent on a machine-login source, and the manager on a local model", async () => {
    const w = world();
    w.store.insertAIProfile({ id: 'login', ownerId: OWNER, name: 'Machine login', vendor: 'anthropic', kind: 'subscription', model: DEFAULT, createdAt: 'now' });
    w.store.insertAIProfile({ id: 'local', ownerId: OWNER, name: 'Local', vendor: 'local', kind: 'api_key', model: 'llama3', baseUrl: 'http://172.17.0.1:11434/v1', createdAt: 'now' });
    const theirs = w.agent('a1', { name: 'Theirs', owner: NEIGHBOUR });
    const t = tally();
    await w.sources.switchAgentToSource(theirs, w.store.getAIProfile('login')!, {}, t, []);
    const ops = w.agent('a2', { name: 'Manager', ops: true });
    await w.sources.switchAgentToSource(ops, w.store.getAIProfile('local')!, {}, t, []);
    expect(t.skipped).toEqual([
      { name: 'Theirs', reason: "a machine-login Max source can't run another account's agent" },
      { name: 'Manager', reason: "the Hatchabot agent can't use a local model" },
    ]);
  });

  it('drops a model pin the new source does not offer, and keeps one it does', async () => {
    const w = world();
    const pinned = w.agent('a1', { model: OTHER });
    await w.sources.switchAgentToSource(pinned, w.store.getAIProfile('p2')!, {}, tally(), []);
    expect(w.store.getAgent('a1')!.model).toBeUndefined();
    const kept = w.agent('a2', { name: 'Garden', profile: 'p2', model: DEFAULT });
    await w.sources.switchAgentToSource(kept, w.store.getAIProfile('p1')!, {}, tally(), []);
    expect(w.store.getAgent('a2')!.model).toBe(DEFAULT);
  });

  it('rebuilds a running agent now (checkpoint first, recovery after) and owes a stopped one its next start', async () => {
    const w = world();
    const running = w.agent('a1');
    const stopped = w.agent('a2', { name: 'Garden', state: 'STOPPED' });
    const t = tally();
    const target = w.store.getAIProfile('p2')!;
    const opts = { rebuild: true, checkpoint: true, recoverAfter: true };
    await w.sources.switchAgentToSource(running, target, opts, t, []);
    await w.sources.switchAgentToSource(stopped, target, opts, t, []);
    // The recovery is kept with the rebuild's record too, for a restart before it runs (HB-0832).
    expect(w.asked).toEqual(['rebuild a1 checkpoint recover-on p2', 'recover a1', 'owe a2']);
    // The stopped one's next start is a plain rebuild: its recovery does not run, and is counted.
    expect(t).toMatchObject({ switched: 2, rebuilding: 1, atNextStart: 1, notRecovered: 1 });
  });

  it('chains no recovery when the rebuild was not queued', async () => {
    const w = world();
    w.rebuildQueued = false;
    const t = tally();
    await w.sources.switchAgentToSource(w.agent('a1'), w.store.getAIProfile('p2')!, { rebuild: true, recoverAfter: true }, t, []);
    expect(w.asked).toEqual(['rebuild a1 recover-on p2']);
    expect(t).toMatchObject({ switched: 1, rebuilding: 0, notRecovered: 1 });
  });
});

describe('applyDefaultModel', () => {
  it('moves the ticked agents to the new default and holds the rest on what they run', async () => {
    const w = world();
    w.agent('a1', { name: 'Ticked', model: OTHER });
    w.agent('a2', { name: 'Held' });
    w.store.setAgentApplied('a2', 'p1', DEFAULT);
    const ledger: string[] = [];
    const out = await w.sources.applyDefaultModel(w.store.getAIProfile('p1')!, OWNER, { model: 'claude-sonnet-5', apply: ['a1'] }, (source, before) => { ledger.push(`${source}:${[...before.keys()].sort().join(',')}`); });
    expect(out).toMatchObject({ applied: 1, held: 1, live: 1, staged: 0, classDetached: 0 });
    expect('profile' in out && out.profile).not.toHaveProperty('secretRef');
    expect(w.store.getAgent('a1')!.model).toBeUndefined();
    expect(w.store.getAgent('a2')!.model).toBe(DEFAULT);
    const p = w.store.getAIProfile('p1')!;
    expect(p.model).toBe('claude-sonnet-5');
    // The held model stays on the menu, so its pin stays valid.
    expect(p.models).toEqual(expect.arrayContaining(['claude-sonnet-5', OTHER, DEFAULT]));
    expect(ledger).toEqual(['default-model:a1,a2', 'source-default:']);
    // The ticked agent's model is asked for with the writes (HB-0832), applied, then every agent on the source gets the list.
    expect(w.asked).toEqual(['ask a1', 'apply a1', 'list p1']);
  });

  it('holds a ticked agent whose OpenClaw is too old for the new default, and says so', async () => {
    const w = world();
    w.agent('a1', { name: 'Old' });
    w.tooOld.set('a1', 'needs OpenClaw 2026.9 or later');
    const out = await w.sources.applyDefaultModel(w.store.getAIProfile('p1')!, OWNER, { model: 'claude-sonnet-5', apply: ['a1'] }, () => {});
    expect(out).toMatchObject({ applied: 0, held: 1, notSwitched: [{ id: 'a1', name: 'Old', reason: 'needs OpenClaw 2026.9 or later' }] });
    expect(w.store.getAgent('a1')!.model).toBe(DEFAULT);
  });

  it("leaves another account's agents unnamed: a follower too old for the new default is pinned and counted", async () => {
    const w = world();
    w.store.setAIProfileShared('p1', true);
    w.agent('a1', { name: 'Theirs', owner: NEIGHBOUR });
    w.tooOld.set('a1', 'too old');
    const out = await w.sources.applyDefaultModel(w.store.getAIProfile('p1')!, OWNER, { model: 'claude-sonnet-5' }, () => {});
    expect(out).toMatchObject({ applied: 0, held: 0, othersHeld: 1 });
    expect(w.store.getAgent('a1')!.model).toBe(DEFAULT);
  });

  // A full list: the default and 15 more, the most a source holds (HB-0907).
  const FIFTEEN = Array.from({ length: 15 }, (_, i) => `claude-extra-${String(i + 1).padStart(2, '0')}`);
  const FIRST = FIFTEEN[0]!;
  const fullList = (w: World) => w.store.setAIProfileModels('p1', [DEFAULT, ...FIFTEEN]);

  it('a new default whose list, with the models kept for agents that stay on theirs, would hold over 16 is refused, and nothing changes (HB-0907)', async () => {
    const w = world();
    fullList(w);
    w.agent('a1', { name: 'Held' });
    w.store.setAgentApplied('a1', 'p1', DEFAULT);
    const before = w.store.getAIProfile('p1')!;
    const ledger: string[] = [];
    const out = await w.sources.applyDefaultModel(before, OWNER, { model: 'claude-new-1', models: ['claude-new-1', ...FIFTEEN], apply: [] }, (source) => { ledger.push(source); });
    expect(out).toEqual({ refused: 'menu-full', error: "This source's list would hold 17 models: the new default, 15 you chose and 1 kept for an agent that stays on its. A source holds 16: remove 1 from Also switchable, then save again." });
    expect(w.store.getAIProfile('p1')).toEqual(before);
    expect(w.store.getAgent('a1')!.model).toBeUndefined();
    expect(ledger).toEqual([]);
    expect(w.asked).toEqual([]);

    // Two agents kept on two models the list leaves off: counted, and said, as theirs.
    w.agent('a2', { name: 'Pinned', model: FIRST });
    expect(await w.sources.applyDefaultModel(before, OWNER, { model: 'claude-new-1', models: ['claude-new-1', ...FIFTEEN.slice(1)], apply: [] }, () => {})).toEqual({
      refused: 'menu-full',
      error: "This source's list would hold 17 models: the new default, 14 you chose and 2 kept for agents that stay on theirs. A source holds 16: remove 1 from Also switchable, then save again.",
    });
    expect(w.store.getAgent('a2')!.model).toBe(FIRST);

    // Kept models that fill the list alone: taking off what no agent keeps
    // is not enough, or there is nothing to take off.
    FIFTEEN.forEach((m, i) => w.agent(`k${i}`, { name: `Kept ${i}`, model: m }));
    expect(await w.sources.applyDefaultModel(before, OWNER, { model: 'claude-new-1', models: ['claude-new-1', 'claude-new-2', FIRST], apply: [] }, () => {})).toEqual({
      refused: 'menu-full',
      error: "This source's list would hold 18 models: the new default, 2 you chose and 15 kept for agents that stay on theirs. A source holds 16: remove 1 from Also switchable and tick more agents to follow the new default, then save again.",
    });
    expect(await w.sources.applyDefaultModel(before, OWNER, { model: 'claude-new-1', models: ['claude-new-1'], apply: [] }, () => {})).toEqual({
      refused: 'menu-full',
      error: "This source's list would hold 17 models: the new default and 16 kept for agents that stay on theirs. A source holds 16: tick more agents to follow the new default, then save again.",
    });
    expect(w.store.getAIProfile('p1')).toEqual(before);
  });

  it("models kept for other accounts' agents are said apart, and only what the caller can do is offered (HB-0907)", async () => {
    const w = world();
    w.store.setAIProfileShared('p1', true);
    fullList(w);
    const before = w.store.getAIProfile('p1')!;
    // Every model on the list is another account's agent's own.
    [DEFAULT, ...FIFTEEN].forEach((m, i) => w.agent(`n${i}`, { name: `Theirs ${i}`, owner: NEIGHBOUR, model: m }));
    expect(await w.sources.applyDefaultModel(before, OWNER, { model: 'claude-new-1', models: ['claude-new-1'], apply: [] }, () => {})).toEqual({
      refused: 'menu-full',
      error: "This source's list would hold 17 models: the new default and 16 kept for other accounts' agents. A source holds 16: choose as the new default a model already on the list, then save again.",
    });
    // One more the caller chose, that no agent stays on: that can come off too.
    expect(await w.sources.applyDefaultModel(before, OWNER, { model: 'claude-new-1', models: ['claude-new-1', 'claude-new-2'], apply: [] }, () => {})).toMatchObject({
      error: "This source's list would hold 18 models: the new default, 1 you chose and 16 kept for other accounts' agents. A source holds 16: remove 1 from Also switchable and choose as the new default a model already on the list, then save again.",
    });
    // Two models only the caller's agents stay on: theirs to tick.
    w.agent('a1', { name: 'Mine', model: 'claude-old-1' });
    w.agent('a2', { name: 'Mine too', model: 'claude-old-2' });
    expect(await w.sources.applyDefaultModel(before, OWNER, { model: 'claude-new-1', models: ['claude-new-1'], apply: [] }, () => {})).toMatchObject({
      error: "This source's list would hold 19 models: the new default, 2 kept for your agents that stay on theirs and 16 kept for other accounts' agents. A source holds 16: tick more of your agents to follow the new default and choose as the new default a model already on the list, then save again.",
    });
    // Over by more than the caller can free: only those accounts can.
    w.agent('n-extra', { name: 'Theirs more', owner: NEIGHBOUR });
    w.store.setAIProfileModels('p1', [DEFAULT, ...FIFTEEN, 'claude-their-1']);
    w.store.setAgentModel('n-extra', 'claude-their-1');
    expect(await w.sources.applyDefaultModel(w.store.getAIProfile('p1')!, OWNER, { model: 'claude-new-1', models: ['claude-new-1'], apply: ['a1', 'a2'] }, () => {})).toMatchObject({
      error: "This source's list would hold 18 models: the new default and 17 kept for other accounts' agents. A source holds 16, and 17 of these stay on it for other accounts' agents until those accounts move them to other models: ask them to, then save again.",
    });
    expect(w.store.getAIProfile('p1')!.model).toBe(DEFAULT);
    expect(w.store.getAgent('a1')!.model).toBe('claude-old-1');
  });

  it("models the caller chose that only their own agents stay on count as theirs to free, by ticking those agents; one too old to follow does not (HB-0907)", async () => {
    const w = world();
    w.store.setAIProfileShared('p1', true);
    fullList(w);
    FIFTEEN.forEach((m, i) => w.agent(`n${i}`, { name: `Theirs ${i}`, owner: NEIGHBOUR, model: m }));
    w.agent('a1', { name: 'Mine follower' }); // held on the old default
    w.agent('a2', { name: 'Mine pinned', model: 'claude-mine-1' });
    const before = w.store.getAIProfile('p1')!;
    expect(await w.sources.applyDefaultModel(before, OWNER, { model: 'claude-new-1', models: ['claude-new-1', DEFAULT, 'claude-mine-1'], apply: [] }, () => {})).toEqual({
      refused: 'menu-full',
      error: "This source's list would hold 18 models: the new default, 2 you chose and 15 kept for other accounts' agents. A source holds 16: remove 2 from Also switchable and tick more of your agents to follow the new default, then save again.",
    });
    // Doing just that fits.
    expect(await w.sources.applyDefaultModel(before, OWNER, { model: 'claude-new-1', models: ['claude-new-1'], apply: ['a1', 'a2'] }, () => {})).toMatchObject({ applied: 2 });
    expect(w.store.getAIProfile('p1')!.models).toHaveLength(16);

    // Ticked, but too old for the new default: held, and ticking it again frees nothing.
    const w2 = world();
    w2.store.setAIProfileShared('p1', true);
    fullList(w2);
    FIFTEEN.forEach((m, i) => w2.agent(`n${i}`, { name: `Theirs ${i}`, owner: NEIGHBOUR, model: m }));
    w2.agent('a1', { name: 'Mine old', model: 'claude-mine-1' });
    w2.tooOld.set('a1', 'needs OpenClaw 2026.9 or later');
    expect(await w2.sources.applyDefaultModel(w2.store.getAIProfile('p1')!, OWNER, { model: 'claude-new-1', models: ['claude-new-1', 'claude-mine-1'], apply: ['a1'] }, () => {})).toEqual({
      refused: 'menu-full',
      error: "This source's list would hold 17 models: the new default, 1 you chose and 15 kept for other accounts' agents. A source holds 16: choose as the new default a model already on the list, then save again.",
    });

    // Only the caller's own agents, every one ticked and too old to follow: nothing to tick, and it says what would help.
    const w3 = world();
    fullList(w3);
    [DEFAULT, ...FIFTEEN, 'claude-mine-2'].forEach((m, i) => { w3.agent(`o${i}`, { name: `Old ${i}`, model: m }); w3.tooOld.set(`o${i}`, 'too old'); });
    expect(await w3.sources.applyDefaultModel(w3.store.getAIProfile('p1')!, OWNER, { model: 'claude-new-1', models: ['claude-new-1'], apply: [DEFAULT, ...FIFTEEN, 'x'].map((_, i) => `o${i}`) }, () => {})).toEqual({
      refused: 'menu-full',
      error: "This source's list would hold 18 models: the new default and 17 kept for agents that stay on theirs. A source holds 16, and what is left stays on it for your agents too old to follow the new default: give them a newer runtime image first, then save again.",
    });
  });

  it('a list of 16 exactly, the kept model among them, is taken; a kept model chosen too counts once (HB-0907)', async () => {
    for (const chosen of [FIFTEEN.slice(1), [DEFAULT, ...FIFTEEN.slice(1)]]) {
      const w = world();
      fullList(w);
      w.agent('a1', { name: 'Held' });
      w.store.setAgentApplied('a1', 'p1', DEFAULT);
      const out = await w.sources.applyDefaultModel(w.store.getAIProfile('p1')!, OWNER, { model: 'claude-new-1', models: ['claude-new-1', ...chosen], apply: [] }, () => {});
      expect(out).toMatchObject({ applied: 0, held: 1 });
      const menu = w.store.getAIProfile('p1')!.models!;
      expect(menu).toHaveLength(16);
      expect(new Set(menu)).toEqual(new Set(['claude-new-1', DEFAULT, ...FIFTEEN.slice(1)]));
      expect(w.store.getAgent('a1')!.model).toBe(DEFAULT);
    }
  });

  it("another account's agent whose pin is cleared, or that joins the source, while the checks wait is held unless its check let it follow (HB-0907, HB-1342)", async () => {
    const w = world();
    w.store.setAIProfileShared('p1', true);
    w.agent('a1', { name: 'Mine' });
    w.agent('n1', { name: 'Theirs', owner: NEIGHBOUR, model: DEFAULT });
    w.agent('n2', { name: 'Current', owner: NEIGHBOUR, model: DEFAULT });
    w.agent('n3', { name: 'Elsewhere', owner: NEIGHBOUR, profile: 'p2' });
    w.tooOld.set('n1', 'too old');
    let go!: () => void;
    w.tooOldWait = new Promise((resolve) => { go = resolve; });
    const applying = w.sources.applyDefaultModel(w.store.getAIProfile('p1')!, OWNER, { model: 'claude-sonnet-5', apply: ['a1'] }, () => {});
    await Promise.resolve();
    // Their owner sets both back to follow the default, and moves a third onto this source.
    w.store.setAgentModel('n1', null);
    w.store.setAgentModel('n2', null);
    w.store.setAgentAIProfile('n3', 'p1');
    go();
    const out = await applying;
    // Too old for the new default: held on what it runs. Checked and current: it follows.
    // Joined meanwhile: checked as well, and it follows (HB-1342; was held unchecked, a pin its owner did not choose).
    expect(w.store.getAgent('n1')!.model).toBe(DEFAULT);
    expect(w.store.getAgent('n2')!.model).toBeUndefined();
    expect(w.store.getAgent('n3')!.model).toBeUndefined();
    expect(out).toMatchObject({ applied: 1, othersHeld: 1 });
  });

  it("an agent that joins the source while the checks wait is checked before it follows the new default, the caller's own and another account's (HB-1342)", async () => {
    const w = world();
    w.store.setAIProfileShared('p1', true);
    w.agent('a1', { name: 'Ticked' });
    w.agent('m2', { name: 'Joins', profile: 'p2' });
    w.agent('m3', { name: 'Joins old', profile: 'p2' });
    w.agent('m4', { name: 'Joins pinned', profile: 'p2' });
    w.agent('n4', { name: 'Theirs joins', owner: NEIGHBOUR, profile: 'p2' });
    w.agent('n5', { name: 'Theirs joins old', owner: NEIGHBOUR, profile: 'p2' });
    w.tooOld.set('m3', 'needs OpenClaw 2026.9 or later');
    w.tooOld.set('n5', 'too old');
    let go!: () => void;
    w.tooOldWait = new Promise((resolve) => { go = resolve; });
    const ledger: Array<[string, string[]]> = [];
    const applying = w.sources.applyDefaultModel(w.store.getAIProfile('p1')!, OWNER, { model: 'claude-sonnet-5', apply: ['a1'] }, (source, before) => { ledger.push([source, [...before.keys()].sort()]); });
    await Promise.resolve();
    // Moved onto this source while the checks wait.
    for (const id of ['m2', 'm3', 'm4', 'n4', 'n5']) w.store.setAgentAIProfile(id, 'p1');
    w.store.setAgentModel('m4', OTHER);
    go();
    const out = await applying;
    // Checked and able: it follows the new default. Too old: held on what it runs, and the caller is told why.
    expect(w.store.getAgent('m2')!.model).toBeUndefined();
    expect(w.store.getAgent('m3')!.model).toBe(DEFAULT);
    expect(w.store.getAgent('m4')!.model).toBe(OTHER);
    expect(w.store.getAgent('n4')!.model).toBeUndefined();
    expect(w.store.getAgent('n5')!.model).toBe(DEFAULT);
    expect(out).toMatchObject({ applied: 1, held: 1, othersHeld: 1, notSwitched: [{ id: 'm3', name: 'Joins old', reason: 'needs OpenClaw 2026.9 or later', why: 'runtime' }] });
    expect(out).not.toHaveProperty('othersUnchecked');
    // Their moves to the new default go in the ledger.
    expect(ledger).toEqual([['default-model', ['a1', 'm2', 'm3', 'm4']], ['source-default', ['n4', 'n5']]]);
    // The models the held ones stay on stay on the list.
    expect(w.store.getAIProfile('p1')!.models).toEqual(expect.arrayContaining(['claude-sonnet-5', OTHER, DEFAULT]));
  });

  it('one of the caller\'s that joins during the last round of checks, too late to be checked, is held on what it runs and named (HB-1342)', async () => {
    const w = world();
    w.agent('a1', { name: 'Ticked' });
    const queue = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'];
    for (const id of queue) w.agent(id, { name: `Joins ${id}`, profile: 'p2' });
    // Each check lets the next one move onto the source.
    const checked = new Set<string>();
    w.tooOld = new (class extends Map<string, string> { override get(k: string) { checked.add(k); return super.get(k); } })();
    w.tooOldWait = { then: (done: () => void) => { const next = queue.shift(); if (next) w.store.setAgentAIProfile(next, 'p1'); done(); } } as never;
    const out = await w.sources.applyDefaultModel(w.store.getAIProfile('p1')!, OWNER, { model: 'claude-sonnet-5', apply: ['a1'] }, () => {});
    const onIt = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'].filter((id) => w.store.getAgent(id)!.aiProfileId === 'p1');
    const late = onIt.filter((id) => !checked.has(id));
    expect(late.length).toBeGreaterThan(0);
    // Checked: it follows the new default. Not checked: held on what it runs, never following unchecked.
    for (const id of onIt) expect([id, w.store.getAgent(id)!.model]).toEqual([id, checked.has(id) ? undefined : DEFAULT]);
    expect(out).toMatchObject({ notSwitched: late.map((id) => ({ id, name: `Joins ${id}`, reason: 'it joined this source while the new default was applied, too late to be checked, so it stays on what it runs', why: 'late' })) });
  });

  it("another account's agent that joins during the last round is kept on its model and counted as never checked, apart from one too old (HB-1342 review)", async () => {
    const w = world();
    w.store.setAIProfileShared('p1', true);
    w.agent('a1', { name: 'Ticked' });
    w.agent('n8', { name: 'Theirs old', owner: NEIGHBOUR });
    w.tooOld.set('n8', 'too old');
    // Two checks a round (and two before them): n9 moves onto it during the last round's.
    const queue = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6', 'j7', 'n9'];
    for (const id of queue) w.agent(id, { name: `Joins ${id}`, profile: 'p2', ...(id.startsWith('n') ? { owner: NEIGHBOUR } : {}) });
    w.tooOldWait = { then: (done: () => void) => { const next = queue.shift(); if (next) w.store.setAgentAIProfile(next, 'p1'); done(); } } as never;
    const out = await w.sources.applyDefaultModel(w.store.getAIProfile('p1')!, OWNER, { model: 'claude-sonnet-5', apply: ['a1'] }, () => {});
    expect(w.store.getAgent('n9')!.aiProfileId).toBe('p1');
    expect(w.store.getAgent('n9')!.model).toBe(DEFAULT);
    // Was: counted with the one too old, and the app said both were too old.
    expect(out).toMatchObject({ othersHeld: 2, othersUnchecked: 1 });
  });

  it('an agent being deleted is neither pinned nor switched, whoever it belongs to (HB-0907)', async () => {
    const w = world();
    w.store.setAIProfileShared('p1', true);
    w.agent('a1', { name: 'Going' });
    w.agent('a2', { name: 'Ticked going' });
    w.agent('n1', { name: 'Theirs going', owner: NEIGHBOUR });
    w.tooOld.set('n1', 'too old');
    for (const id of ['a1', 'a2', 'n1']) w.store.setAgentState(id, 'DELETING');
    const out = await w.sources.applyDefaultModel(w.store.getAIProfile('p1')!, OWNER, { model: 'claude-sonnet-5', apply: ['a2'] }, () => {});
    expect(out).toMatchObject({ applied: 0, held: 0 });
    expect(out).not.toHaveProperty('othersHeld');
    expect(['a1', 'a2', 'n1'].map((id) => w.store.getAgent(id)!.model)).toEqual([undefined, undefined, undefined]);
    expect(w.store.getAIProfile('p1')!.models).toEqual(['claude-sonnet-5', OTHER]);
  });

  it('an agent changed while the runtime checks wait is counted, and held, as it is when the writes begin (HB-0907)', async () => {
    const w = world();
    w.store.setAIProfileShared('p1', true);
    fullList(w);
    w.agent('n1', { name: 'Theirs', owner: NEIGHBOUR });
    w.tooOld.set('n1', 'too old');
    let go!: () => void;
    w.tooOldWait = new Promise((resolve) => { go = resolve; });
    const applying = w.sources.applyDefaultModel(w.store.getAIProfile('p1')!, OWNER, { model: 'claude-new-1', models: ['claude-new-1', ...FIFTEEN], apply: [] }, () => {});
    // Its owner picks a model on the list for it while its check waits: it is
    // held on that, which the list has, and that choice is not written over.
    await Promise.resolve();
    w.store.setAgentModel('n1', FIRST);
    go();
    const out = await applying;
    expect(out).toMatchObject({ applied: 0, held: 0 });
    expect(out).not.toHaveProperty('othersHeld');
    expect(w.store.getAgent('n1')!.model).toBe(FIRST);
    expect(w.store.getAIProfile('p1')!.models).toEqual(['claude-new-1', ...FIFTEEN]);
  });
  it('a list sent with the apply, as the app sends one, keeps a model added or taken off while the checks wait (HB-1340 review)', async () => {
    const w = world();
    w.store.setAIProfileModels('p1', [OTHER, 'claude-extra-03', 'claude-extra-04']);
    w.agent('a1', { name: 'Ticked' });
    let go!: () => void;
    w.tooOldWait = new Promise((resolve) => { go = resolve; });
    // The list as the editor showed it when Save was pressed, the new default first, one model taken off it there.
    const applying = w.sources.applyDefaultModel(w.store.getAIProfile('p1')!, OWNER,
      { model: 'claude-sonnet-5', models: ['claude-sonnet-5', OTHER, 'claude-extra-03'], apply: ['a1'] }, () => {});
    await Promise.resolve();
    // Meanwhile another edit adds a model and takes one off.
    w.store.setAIProfileModels('p1', [OTHER, 'claude-extra-04', 'claude-extra-01']);
    go();
    expect(await applying).toMatchObject({ applied: 1 });
    // Was: the list sent, written over the edit: claude-extra-01 lost and claude-extra-03 back.
    expect([...w.store.getAIProfile('p1')!.models!].sort()).toEqual(['claude-extra-01', 'claude-haiku-4-5', 'claude-sonnet-5']);
  });

  it('a source deleted while the checks wait is answered as gone, with nothing written (HB-1340 review)', async () => {
    const w = world();
    w.agent('a1', { name: 'Ticked' });
    let go!: () => void;
    w.tooOldWait = new Promise((resolve) => { go = resolve; });
    const applying = w.sources.applyDefaultModel(w.store.getAIProfile('p1')!, OWNER, { model: 'claude-sonnet-5', models: ['claude-sonnet-5', OTHER], apply: ['a1'] }, () => {});
    await Promise.resolve();
    w.store.setAgentAIProfile('a1', 'p2');
    w.store.deleteAIProfile('p1');
    go();
    // Was: a TypeError after the writes (a 500).
    expect(await applying).toEqual({ refused: 'gone', error: 'This AI source was deleted while its new default was being applied: nothing was changed.' });
    expect(w.store.getAgent('a1')!.model).toBeUndefined();
  });

  it("an edit of the source while the checks wait is what the new default's list starts from, not the record it was given (HB-1340)", async () => {
    const w = world();
    w.store.setAIProfileShared('p1', true);
    w.agent('a1', { name: 'Ticked' });
    w.agent('a2', { name: 'Held' });
    w.agent('n1', { name: 'Theirs', owner: NEIGHBOUR, model: 'claude-extra-01' });
    let go!: () => void;
    w.tooOldWait = new Promise((resolve) => { go = resolve; });
    const applying = w.sources.applyDefaultModel(w.store.getAIProfile('p1')!, OWNER, { model: 'claude-sonnet-5', apply: ['a1'] }, () => {});
    await Promise.resolve();
    // The source is edited while the checks wait: another model added, and its default changed.
    w.store.setAIProfileModels('p1', [OTHER, 'claude-extra-01']);
    w.store.setAIProfileModel('p1', 'claude-extra-02');
    go();
    const out = await applying;
    expect(out).toMatchObject({ applied: 1, held: 1 });
    const p = w.store.getAIProfile('p1')!;
    // Was: the list it was given ([haiku]) written over the edit, and the held agent pinned to the default before it.
    expect(p.models).toEqual(expect.arrayContaining(['claude-sonnet-5', OTHER, 'claude-extra-01', 'claude-extra-02']));
    expect(w.store.getAgent('a2')!.model).toBe('claude-extra-02');
    // Another account's pin the edit put on the list is valid, so it stays theirs.
    expect(w.store.getAgent('n1')!.model).toBe('claude-extra-01');
    expect(out).not.toHaveProperty('othersHeld');
  });
});

describe('availableModels', () => {
  it('offers the curated Claude list when no running agent can be asked', async () => {
    const w = world();
    expect(await w.sources.availableModels(w.store.getAIProfile('p1')!, OWNER)).toEqual({ models: [...CURATED_ANTHROPIC_MODELS], source: 'curated' });
  });

  it("lists a local server's models, and says when it cannot be reached", async () => {
    const w = world();
    w.store.insertAIProfile({ id: 'local', ownerId: OWNER, name: 'Local', vendor: 'local', kind: 'api_key', model: 'llama3', baseUrl: 'http://172.17.0.1:11434/v1', createdAt: 'now' });
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => { fetched.push(url); return new Response(JSON.stringify({ models: [{ name: 'llama3' }, { name: 'qwen3' }] })); });
    expect(await w.sources.availableModels(w.store.getAIProfile('local')!, OWNER)).toEqual({ models: ['llama3', 'qwen3'] });
    expect(fetched).toEqual(['http://172.17.0.1:11434/api/tags']);
    vi.stubGlobal('fetch', async () => { throw new Error('refused'); });
    expect(await w.sources.availableModels(w.store.getAIProfile('local')!, OWNER)).toEqual({ models: [], error: "Couldn't reach the model server to list its models." });
  });

  it("lists an OpenAI key's chat models only, with the stored key", async () => {
    const w = world();
    w.store.insertAIProfile({ id: 'oa', ownerId: OWNER, name: 'OpenAI', vendor: 'openai', kind: 'api_key', model: 'gpt-5', secretRef: 'ai/oa', createdAt: 'now' });
    let auth = '';
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      auth = String((init.headers as Record<string, string>).authorization);
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5' }, { id: 'text-embedding-3' }, { id: 'gpt-audio' }, { id: 'o3' }] }));
    });
    expect(await w.sources.availableModels(w.store.getAIProfile('oa')!, OWNER)).toEqual({ models: ['gpt-5', 'o3'] });
    expect(auth).toBe('Bearer secret-for-ai/oa');
  });

  it("lists every page of a Google key's models, each once, and says so when a later page cannot be read (HB-1129)", async () => {
    const w = world();
    w.store.insertAIProfile({ id: 'g', ownerId: OWNER, name: 'Gemini', vendor: 'google', kind: 'api_key', model: 'gemini-example-a', secretRef: 'ai/g', createdAt: 'now' });
    const chat = (name: string) => ({ name: `models/${name}`, supportedGenerationMethods: ['generateContent'] });
    const pages: Record<string, unknown> = {
      '': { models: [chat('gemini-example-a'), { name: 'models/embedding-example', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'page-two' },
      'page-two': { models: [chat('gemini-example-b'), chat('gemini-example-a')], nextPageToken: 'page-three' },
      'page-three': { models: [chat('gemini-example-c')] },
    };
    const asked: Array<string | null> = [];
    let failOn: string | undefined;
    vi.stubGlobal('fetch', async (url: string) => {
      const u = new URL(url);
      const token = u.searchParams.get('pageToken');
      asked.push(token);
      expect(u.searchParams.get('key')).toBe('secret-for-ai/g');
      if (failOn !== undefined && (token ?? '') === failOn) {
        if (failOn === 'page-three') throw new Error('The operation was aborted due to timeout');
        return new Response('{}', { status: 503 });
      }
      return new Response(JSON.stringify(pages[token ?? '']));
    });
    expect(await w.sources.availableModels(w.store.getAIProfile('g')!, OWNER)).toEqual({ models: ['gemini-example-a', 'gemini-example-b', 'gemini-example-c'] });
    expect(asked).toEqual([null, 'page-two', 'page-three']);
    // A list read only in part is not offered as the whole: Sync would take the rest off the menu.
    for (failOn of ['page-two', 'page-three']) {
      expect(await w.sources.availableModels(w.store.getAIProfile('g')!, OWNER)).toEqual({ models: [], error: expect.stringContaining('only in part') });
    }
    // The first page refused: no list, as before.
    failOn = '';
    expect(await w.sources.availableModels(w.store.getAIProfile('g')!, OWNER)).toEqual({ models: [] });
    // A server that never stops giving another page is asked a bounded number of times.
    asked.length = 0;
    failOn = undefined;
    vi.stubGlobal('fetch', async (url: string) => { asked.push(new URL(url).searchParams.get('pageToken')); return new Response(JSON.stringify({ models: [chat('gemini-example-a')], nextPageToken: 'again' })); });
    expect(await w.sources.availableModels(w.store.getAIProfile('g')!, OWNER)).toEqual({ models: [], error: expect.stringContaining('only in part') });
    expect(asked).toHaveLength(10);
  });
});

describe('the stateless rules', () => {
  it('usesSource: what an agent will use, or what its container still runs', () => {
    const base = { aiProfileId: 'p2', appliedProfileId: 'p1', state: 'RUNNING', runtimeRef: 'ref' } as Agent;
    expect(usesSource(base, 'p2')).toBe(true);
    expect(usesSource(base, 'p1')).toBe(true);
    expect(usesSource({ ...base, state: 'ARCHIVED' }, 'p1')).toBe(false);
    expect(usesSource({ ...base, runtimeRef: undefined }, 'p1')).toBe(false);
  });

  it('limitsSaid: the kept limits of a batch, in its order, and nothing when none were kept', async () => {
    const lines: Array<Promise<KeptLine | undefined>> = [
      keptLine('Kitchen', Promise.resolve({ memoryPending: 'kept 2g until its rebuild', why: 'busy' })),
      keptLine('Garden', Promise.resolve({})),
      keptLine('Office', Promise.reject(new Error('never said'))),
    ];
    expect(await limitsSaid(lines)).toEqual({ memoryPending: ['Kitchen: kept 2g until its rebuild'], limitsKept: [{ name: 'Kitchen', why: 'busy' }] });
    expect(await limitsSaid([keptLine('Garden', Promise.resolve({}))])).toEqual({});
  });

  it('checkLocalServer: a server that lists no models has none to run; one that lists others names them (HB-1130)', async () => {
    let tags: unknown = { models: [] };
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(tags)));
    const empty = await checkLocalServer('http://172.17.0.1:11434/v1', 'llama3');
    expect(empty.ok).toBe(false);
    expect(!empty.ok && empty.error).toBe('That server has no models yet, so it cannot run "llama3". Pull one there first (Ollama: ollama pull llama3), then add the source.');
    tags = { models: [{ name: 'qwen3' }] };
    expect(await checkLocalServer('http://172.17.0.1:11434/v1', 'llama3')).toEqual({ ok: false, error: 'That server has no model "llama3". It offers: qwen3.' });
    tags = { models: [{ name: 'llama3' }] };
    expect(await checkLocalServer('http://172.17.0.1:11434/v1', 'llama3')).toEqual({ ok: true });
    // An answer that is not a model list says nothing either way: taken, as before.
    tags = {};
    expect(await checkLocalServer('http://172.17.0.1:11434/v1', 'llama3')).toEqual({ ok: true });
  });

  it('checkLocalServer: a model named with no tag is the one the server lists as its :latest, as Ollama serves it (HB-1339)', async () => {
    let tags: unknown = { models: [{ name: 'llama3:latest' }, { name: 'qwen3:8b' }] };
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(tags)));
    expect(await checkLocalServer('http://172.17.0.1:11434/v1', 'llama3')).toEqual({ ok: true });
    expect(await checkLocalServer('http://172.17.0.1:11434/v1', 'llama3:latest')).toEqual({ ok: true });
    // Another tag is another model: Ollama would look for qwen3:latest, which this server lacks.
    expect(await checkLocalServer('http://172.17.0.1:11434/v1', 'qwen3')).toEqual({ ok: false, error: 'That server has no model "qwen3". It offers: llama3:latest, qwen3:8b.' });
    expect(await checkLocalServer('http://172.17.0.1:11434/v1', 'llama3:8b')).toEqual({ ok: false, error: 'That server has no model "llama3:8b". It offers: llama3:latest, qwen3:8b.' });
    // A namespaced name, the same rule.
    tags = { models: [{ name: 'made-up/helper:latest' }] };
    expect(await checkLocalServer('http://172.17.0.1:11434/v1', 'made-up/helper')).toEqual({ ok: true });
  });

  it("checkLocalServer refuses the machine's loopback without asking it", async () => {
    const r = await checkLocalServer('http://127.0.0.1:11434/v1', 'llama3');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("points at this machine's loopback");
  });
});
