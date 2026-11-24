import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { createAgentMemory, type AgentMemory } from '../src/orchestrator/memory/agentMemory.js';
import { createProposals } from '../src/orchestrator/memory/proposals.js';
import { compactingNow } from '../src/orchestrator/memory/compactionState.js';
import { createConsults, type Consults } from '../src/orchestrator/consult/consults.js';
import { createAiSources } from '../src/orchestrator/sources/aiSources.js';
import { createSourceHolds } from '../src/orchestrator/lifecycle/sourceHolds.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { TurnRefused } from '../src/orchestrator/files/coreFileTurns.js';
import { clearBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import type { ChangeMeta } from '../src/orchestrator/usage/modelLedger.js';
import type { Agent } from '../src/domain/types.js';
import type { ExecResult } from '../src/providers/provider.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * The memory service (HB-0808 step 13, part 2c), driven as
 * src/api/memoryRoutes.ts drives it, with no HTTP server: a real store on an
 * in-memory database, the real consult service for the one turn per agent,
 * and a container with a few files that answers turns as the test says.
 */
const OWNER = 'user-owner';
const META: ChangeMeta = { by: 'owner', via: 'app', source: 'test' };
afterEach(() => { vi.useRealTimers(); });

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) {
    const v = this.map.get(ref);
    if (v === undefined) throw new Error(`no secret ${ref}`);
    return v;
  }
  async delete(ref: string) { this.map.delete(ref); }
}

interface World {
  store: Store; m: AgentMemory; consults: Consults;
  /** Each agent's files, by their path in the container. */
  files: Map<string, string>;
  turns: string[]; shells: string[]; fileTurns: string[]; told: string[];
  /** What a turn in a container answers. */
  answer: (slug: string, argv: string[]) => Promise<ExecResult>;
  /** What staging a recovery finds. */
  staged: { conversations: number; messages: number };
  /** What the launch of a recovery turn prints about its process ('' when nothing), and what a look at it answers. */
  launched: string; turnLook: ExecResult;
  /** Staging a recovery waits for this (the render of a long history), when set. */
  staging?: Promise<void>;
  rebuilding: Map<string, Promise<void>>;
  /** The fingerprint of its memory files, as the checkpoint reads it before and after. */
  memoryPrint: string;
  agent(id: string, o?: { state?: Agent['state']; parent?: string; vendor?: 'local' }): Agent;
  /** Hatchabot restarts: a new store and new services over the same database and containers; this one is never asked again. */
  restart(): World;
}

function world(from?: { db: Database.Database; files: Map<string, string> }): World {
  const db = from?.db ?? new Database(':memory:');
  const store = new Store(db);
  if (!from) {
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    store.insertAIProfile({ id: 'local', ownerId: OWNER, name: 'Local', vendor: 'local', kind: 'api_key', model: 'small', secretRef: 'ai/local', createdAt: 'now' } as never);
  }
  const w = { store, files: from?.files ?? new Map(), turns: [], shells: [], fileTurns: [], told: [], rebuilding: new Map() } as unknown as World;
  w.restart = () => world({ db, files: w.files });
  w.answer = async () => ({ code: 0, stdout: 'DONE', stderr: '' });
  w.staged = { conversations: 2, messages: 12 };
  w.launched = '';
  w.turnLook = { code: 0, stdout: 'running\n', stderr: '' };
  w.memoryPrint = 'a'.repeat(64);
  const provider = {
    exec: async (_ref: string, argv: string[]) => { w.turns.push(argv[2]!); return w.answer(argv[2]!, argv); },
    execShell: async (_ref: string, script: string): Promise<ExecResult> => {
      if (script.startsWith('head -c ')) {
        const path = JSON.parse(/^head -c \d+ ("[^"]*")/.exec(script)![1]!) as string;
        const text = w.files.get(path);
        return { code: 0, stdout: text ?? '', stderr: text === '' ? 'EMPTY' : '' };
      }
      if (script.includes('mv -fT -- ')) {
        const b64 = JSON.parse(/echo ("[^"]*") \| base64 -d/.exec(script)![1]!) as string;
        const path = JSON.parse(/mv -fT -- \S+ ("[^"]*")$/.exec(script)![1]!) as string;
        w.files.set(path, Buffer.from(b64, 'base64').toString('utf8'));
        w.shells.push(`write ${path}`);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (script.includes("MODE='recover'")) { w.shells.push('stage'); await w.staging; return { code: 0, stdout: JSON.stringify(w.staged), stderr: '' }; }
      if (script.includes("MODE='export'")) { w.shells.push('export'); return { code: 0, stdout: JSON.stringify({ text: '# history', conversations: 1, messages: 3, unreadable: 0 }), stderr: '' }; }
      if (script.includes('sha256sum') && script.includes('MEMORY.md')) return { code: 0, stdout: w.memoryPrint, stderr: '' };
      if (script.startsWith('nohup ')) { w.shells.push('recovery turn'); return { code: 0, stdout: w.launched, stderr: '' }; }
      if (script.includes('/proc/') && script.includes('echo running')) { w.shells.push('look at the turn'); return w.turnLook; }
      w.shells.push('other');
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  const secrets = new MemSecrets();
  const trace = () => () => {};
  w.consults = createConsults({
    store, secrets, providerFor: () => provider as never, trace, agentGone: () => false, warn: () => {},
    ensureAwake: async (a) => a, forgetSessions: () => {}, unreadFor: async () => false,
    maxConcurrent: 8, perHour: 60, timeoutMs: 120_000,
    // As routes.ts hands it in.
    alsoAnswering: (id) => w.m.history.answering(id),
  });
  w.m = createAgentMemory({
    store, secrets, providerFor: () => provider as never, trace,
    turns: w.consults.turns,
    ensureAwake: async (a) => store.setAgentState(a.id, 'RUNNING'),
    tell: async (_o, _a, text) => { w.told.push(text); return true; },
    forgetSessions: () => {},
    inFlight: (id) => w.rebuilding.get(id),
    withCoreFilesTurn: (id, fn) => { w.fileTurns.push(id); return fn(); },
    freshRunning: (id, notRunning) => {
      const a = store.getAgent(id);
      if (!a || a.state !== 'RUNNING' || !a.runtimeRef) throw new TurnRefused(409, notRunning(a!));
      return a as Agent & { runtimeRef: string };
    },
    askTimeoutMs: 280_000,
  });
  w.agent = (id, o = {}) => {
    store.insertAgent({
      id, ownerId: OWNER, name: `Agent ${id}`, slug: id, state: 'PROVISIONING', aiProfileId: o.vendor === 'local' ? 'local' : 'p1', hostId: 'h1',
      persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
    } as unknown as Agent);
    store.setAgentRuntimeRef(id, `ref-${id}`);
    store.setAgentState(id, 'RUNNING');
    if (o.state === 'STOPPED') store.setAgentState(id, 'STOPPED');
    if (o.parent) store.setAgentParent(id, o.parent);
    return store.getAgent(id)!;
  };
  return w;
}

/** A turn that waits until the test lets it answer. */
function held(): { promise: Promise<ExecResult>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<ExecResult>((r) => { release = () => r({ code: 0, stdout: 'done', stderr: '' }); });
  return { promise, release };
}

describe('the turns in an agent\'s conversation', () => {
  it('a checkpoint and an ask are refused while the agent answers a consult, and run after it', async () => {
    const w = world();
    const a = w.agent('a'); w.agent('b');
    w.store.setAgentPeers('b', ['a']);
    const turn = held();
    w.answer = () => turn.promise;
    const consult = w.consults.consult(w.store.createAgentCallToken('b', OWNER), 'a', 'hello');
    await new Promise((r) => setImmediate(r));
    const busy = { ok: false, status: 429, error: 'It is already answering something — try again when that finishes.' };
    expect(await w.m.turns.checkpoint(a)).toEqual(busy);
    expect(await w.m.turns.ask(a, 'hi', 'password', OWNER)).toEqual(busy);
    turn.release(); await consult;
    w.answer = async () => ({ code: 0, stdout: 'Hello there\n', stderr: '' });
    expect(await w.m.turns.ask(a, 'hi', 'password', OWNER)).toEqual({ ok: true, body: { reply: 'Hello there' } });
    expect(w.consults.turns.inFlight('a')).toBe(false);
  });

  it('a consult is refused while an ask runs', async () => {
    const w = world();
    const a = w.agent('a'); w.agent('b');
    w.store.setAgentPeers('b', ['a']);
    const turn = held();
    w.answer = () => turn.promise;
    const ask = w.m.turns.ask(a, 'a long question', 'password', OWNER);
    await new Promise((r) => setImmediate(r));
    expect(await w.consults.consult(w.store.createAgentCallToken('b', OWNER), 'a', 'hello')).toMatchObject({ status: 429 });
    turn.release();
    expect(await ask).toEqual({ ok: true, body: { reply: 'done' } });
  });

  it('an ask says what is wrong with what it was given, and with its turn', async () => {
    const w = world();
    const a = w.agent('a');
    expect(await w.m.turns.ask(a, '  ', 'password', OWNER)).toMatchObject({ status: 400, error: 'Say something.' });
    expect(await w.m.turns.ask(a, 'x'.repeat(8001), 'password', OWNER)).toMatchObject({ status: 413 });
    markBusy('a');
    try { expect(await w.m.turns.ask(a, 'hi', 'password', OWNER)).toMatchObject({ status: 409 }); } finally { clearBusy('a'); }
    w.answer = async () => ({ code: 0, stdout: '', stderr: '', timedOut: true });
    expect(await w.m.turns.ask(a, 'hi', 'password', OWNER)).toMatchObject({ status: 504, error: 'No answer within 280 s.' });
    w.answer = async () => ({ code: 1, stdout: '', stderr: '' });
    expect(await w.m.turns.ask(a, 'hi', 'password', OWNER)).toMatchObject({ status: 502, error: 'The turn did not complete — see: hatchabot logs a' });
  });

  it('an ask that fails or runs out of time leaves what was unread unread; one answered marks it read (HB-1014)', async () => {
    const w = world();
    const a = w.agent('a');
    w.store.setAgentSeen(OWNER, 'a', 1);
    w.answer = async () => ({ code: 0, stdout: '', stderr: '', timedOut: true });
    expect(await w.m.turns.ask(a, 'hi', 'password', OWNER)).toMatchObject({ status: 504 });
    expect(w.store.getAgentSeen(OWNER, 'a')).toBe(1);
    w.answer = async () => ({ code: 1, stdout: '', stderr: 'gateway closed' });
    expect(await w.m.turns.ask(a, 'hi', 'password', OWNER)).toMatchObject({ status: 502 });
    expect(w.store.getAgentSeen(OWNER, 'a')).toBe(1);
    w.answer = async () => ({ code: 0, stdout: 'Hello there', stderr: '' });
    const before = Date.now();
    expect(await w.m.turns.ask(a, 'hi', 'password', OWNER)).toEqual({ ok: true, body: { reply: 'Hello there' } });
    expect(w.store.getAgentSeen(OWNER, 'a')).toBeGreaterThanOrEqual(before);
  });

  it('a checkpoint says when it saved, when nothing could be saved, and when nothing was new', async () => {
    const w = world();
    const a = w.agent('a');
    w.answer = async () => ({ code: 1, stdout: '', stderr: 'out of credits' });
    const failed = await w.m.turns.checkpoint(a);
    expect(failed.ok && failed.body).toMatchObject({ ok: false, saved: false });
    w.answer = async () => ({ code: 0, stdout: 'DONE', stderr: '' });
    const same = await w.m.turns.checkpoint(a);
    expect(same).toEqual({ ok: true, body: { ok: true, saved: false, nothingNew: true, note: 'It found nothing new to save — its memory files are unchanged.' } });
    w.answer = async () => { w.memoryPrint = 'b'.repeat(64); return { code: 0, stdout: 'DONE', stderr: '' }; };
    expect(await w.m.turns.checkpoint(a)).toEqual({ ok: true, body: { ok: true, saved: true } });
    expect(w.consults.turns.inFlight('a')).toBe(false);
  });

  it('wakes a sleeping agent to be asked, and leaves any other as it is', async () => {
    const w = world();
    const a = w.agent('a', { state: 'STOPPED' });
    await w.m.turns.wakeToAsk(a);
    expect(w.store.getAgent('a')!.state).toBe('STOPPED'); // stopped by hand: not asleep
    w.store.setHibernated('a', new Date().toISOString(), 7);
    await w.m.turns.wakeToAsk(w.store.getAgent('a'));
    expect(w.store.getAgent('a')!.state).toBe('RUNNING');
    await w.m.turns.wakeToAsk(undefined);
  });
});

describe('Recover context', () => {
  it('is started once per agent, and its slot freed after fifteen minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = world();
    const a = w.agent('a');
    const r = await w.m.history.recover(a, false);
    expect(r).toEqual({ ok: true, body: { started: true, conversations: 2, messages: 12, file: expect.stringMatching(/^recovered\/chat-history-/) } });
    expect(w.m.history.recovering('a')).toBe(true);
    expect(await w.m.history.recover(a, false)).toEqual({ ok: false, status: 409, error: 'A recovery is already running for this agent — it will confirm in its chat when done.' });
    vi.advanceTimersByTime(15 * 60_000);
    expect(w.m.history.recovering('a')).toBe(false);
    w.m.stop();
  });

  it('an earlier recovery that found nothing never frees the slot of the one after it (HB-0886)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = world();
    const a = w.agent('a');
    w.staged = { conversations: 0, messages: 0 };
    expect(await w.m.history.recover(a, true)).toMatchObject({ ok: true, body: { started: false } });
    expect(vi.getTimerCount()).toBe(0); // its timer went with its slot
    vi.advanceTimersByTime(14 * 60_000);
    w.staged = { conversations: 1, messages: 10 };
    expect(await w.m.history.recover(a, true)).toMatchObject({ ok: true, body: { started: true } });
    vi.advanceTimersByTime(60_000); // when the first one's fifteen minutes were up
    expect(w.m.history.recovering('a')).toBe(true);
    expect(await w.m.history.recover(a, true)).toMatchObject({ status: 409 });
    expect(w.shells.filter((s) => s === 'recovery turn')).toHaveLength(1);
    vi.advanceTimersByTime(14 * 60_000); // the second one's own fifteen minutes
    expect(w.m.history.recovering('a')).toBe(false);
    w.m.stop();
  });

  it('is not started while an ask, a checkpoint or a consult is answering (HB-0887)', async () => {
    const w = world();
    const a = w.agent('a');
    expect(w.consults.turns.take('a')).toBe(true); // an ask, say
    expect(await w.m.history.recover(a, true)).toEqual({ ok: false, status: 429, error: 'It is already answering something — try again when that finishes.' });
    expect(w.shells).not.toContain('stage');
    expect(w.m.history.recovering('a')).toBe(false); // no slot left taken
    w.consults.turns.release('a');
    expect(await w.m.history.recover(a, true)).toMatchObject({ ok: true, body: { started: true } });
    w.m.stop();
  });

  it('holds its slot, and the agent\'s turn, while its process runs, and frees both at the first look after it ended (HB-0887)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = world();
    const a = w.agent('a');
    w.launched = 'hatchabot-recovery 4242 98765\n';
    expect(await w.m.history.recover(a, true)).toEqual({ ok: true, body: { started: true, conversations: 2, messages: 12, file: expect.any(String) } });
    expect(w.m.history.recovering('a')).toBe(true);
    // An ask, a checkpoint or a consult would go into the same conversation: they wait.
    expect(w.consults.turns.take('a')).toBe(false);
    expect(w.consults.turns.inFlight('a')).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.shells.filter((s) => s === 'look at the turn')).toHaveLength(1);
    expect(w.m.history.recovering('a')).toBe(true); // still running
    w.turnLook = { code: 1, stdout: '', stderr: 'no such container' };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.m.history.recovering('a')).toBe(true); // not known: the ceiling stands
    w.turnLook = { code: 0, stdout: 'gone\n', stderr: '' };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.m.history.recovering('a')).toBe(false); // ninety seconds in, not fifteen minutes
    expect(w.m.history.answering('a')).toBe(false);
    expect(w.consults.turns.take('a')).toBe(true);
    w.consults.turns.release('a');
    expect(vi.getTimerCount()).toBe(0); // its ceiling and its looks went with it
    expect(await w.m.history.recover(a, true)).toMatchObject({ ok: true, body: { started: true } });
    w.m.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds the agent\'s turn while its history is staged, before its launch (HB-0887)', async () => {
    const w = world();
    const a = w.agent('a');
    let staged!: () => void;
    w.staging = new Promise<void>((r) => { staged = r; });
    const recovery = w.m.history.recover(a, true);
    await vi.waitFor(() => expect(w.shells).toContain('stage'));
    const busy = { ok: false, status: 429, error: 'It is already answering something — try again when that finishes.' };
    expect(await w.m.turns.ask(a, 'hi', 'password', OWNER)).toEqual(busy);
    expect(w.turns).toEqual([]); // the ask never reached the conversation
    staged();
    expect(await recovery).toMatchObject({ ok: true, body: { started: true } });
    // Its launch failing gives the turn back.
    w.m.stop();
    const v = world();
    const b = v.agent('b');
    v.staged = { conversations: 0, messages: 0 };
    await v.m.history.recover(b, true);
    expect(v.consults.turns.inFlight('b')).toBe(false);
    v.m.stop();
  });

  it('after a switch\'s rebuild, its recovery is not launched beside an ask that came meanwhile (HB-0887)', async () => {
    const w = world();
    w.agent('a');
    let rebuilt!: () => void;
    w.rebuilding.set('a', new Promise<void>((r) => { rebuilt = r; }));
    w.m.history.afterRebuild('a');
    w.store.setAgentApplied('a', 'p1', 'claude-opus-4-8');
    expect(w.consults.turns.take('a')).toBe(true); // an ask to the rebuilt agent
    rebuilt();
    await vi.waitFor(() => expect(w.m.history.recovering('a')).toBe(false));
    expect(w.shells).not.toContain('stage');
    expect(w.shells).not.toContain('recovery turn');
    w.consults.turns.release('a');
    w.m.stop();
  });

  it('a reservation with no rebuild to wait for leaves a recovery that holds the slot alone (HB-0887)', async () => {
    const w = world();
    const a = w.agent('a');
    w.launched = 'hatchabot-recovery 4242 98765\n';
    expect(await w.m.history.recover(a, true)).toMatchObject({ ok: true, body: { started: true } });
    w.m.history.afterRebuild('a'); // no rebuild in flight
    expect(w.m.history.recovering('a')).toBe(true);
    expect(w.m.history.answering('a')).toBe(true);
    expect(await w.m.history.recover(a, true)).toMatchObject({ status: 409 });
    w.turnLook = { code: 0, stdout: 'gone\n', stderr: '' };
    await w.m.history.settle('a'); // and its own look still frees it
    expect(w.m.history.recovering('a')).toBe(false);
    w.m.stop();
  });

  it('frees its slot at the next look when its container stopped or was replaced (HB-0887)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = world();
    const a = w.agent('a');
    w.launched = 'hatchabot-recovery 4242 98765\n';
    await w.m.history.recover(a, true);
    w.store.setAgentState('a', 'STOPPED');
    await w.m.history.settle('a');
    expect(w.m.history.recovering('a')).toBe(false);
    expect(w.shells).not.toContain('look at the turn'); // nothing to ask a stopped container
    w.m.stop();
  });

  it('a slot reserved for after a switch\'s rebuild does not take the agent\'s turn until its recovery starts (HB-0887)', async () => {
    const w = world();
    w.agent('a');
    w.rebuilding.set('a', new Promise<void>(() => {}));
    w.m.history.afterRebuild('a');
    expect(w.m.history.recovering('a')).toBe(true);
    expect(w.consults.turns.inFlight('a')).toBe(false); // asks still reach the running container
    // And with no rebuild to wait for, the reservation is not left for ever.
    w.rebuilding.delete('b');
    w.agent('b');
    w.m.history.afterRebuild('b');
    expect(w.m.history.recovering('b')).toBe(false);
    w.m.stop();
  });

  it('frees its slot when there is nothing to recover', async () => {
    const w = world();
    const a = w.agent('a');
    w.staged = { conversations: 0, messages: 0 };
    expect(await w.m.history.recover(a, true)).toEqual({ ok: true, body: { started: false, reason: 'Nothing to recover — no chat history found.' } });
    expect(w.m.history.recovering('a')).toBe(false);
    w.m.stop();
  });

  it('is the same slot a source switch reserves for after its rebuild', async () => {
    const w = world();
    const a = w.agent('a');
    let rebuilt!: () => void;
    w.rebuilding.set('a', new Promise<void>((r) => { rebuilt = r; }));
    w.m.history.afterRebuild('a');
    expect(w.m.history.recovering('a')).toBe(true);
    expect(await w.m.history.recover(a, false)).toMatchObject({ status: 409 });
    w.store.setAgentApplied('a', 'p1', 'claude-opus-4-8'); // the rebuild put it on its source
    rebuilt();
    await vi.waitFor(() => expect(w.shells).toContain('recovery turn'));
    expect(await w.m.history.recover(a, false)).toMatchObject({ status: 409 }); // the slot is held for the turn
    w.m.stop();
  });

  it('is not run on the old source when the switch\'s rebuild was refused (HB-0892)', async () => {
    const w = world();
    w.agent('a');
    w.store.setAgentApplied('a', 'p1', 'claude-opus-4-8');
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Other source', vendor: 'google', kind: 'api_key', model: 'gemini-example', secretRef: 'ai/p2', createdAt: 'now' });
    w.store.setAgentAIProfile('a', 'p2'); // switched; its rebuild is kicked
    let rebuilt!: () => void;
    w.rebuilding.set('a', new Promise<void>((r) => { rebuilt = r; }));
    w.m.history.afterRebuild('a');
    // The queue answers a refused render as done: the old container keeps running on the old source.
    rebuilt();
    await vi.waitFor(() => expect(w.m.history.recovering('a')).toBe(false));
    expect(w.shells).not.toContain('stage');
    expect(w.shells).not.toContain('recovery turn');
    expect(w.store.getAgent('a')!.appliedProfileId).toBe('p1');
    // And a rebuild that did put it on the new source runs it there.
    w.rebuilding.set('a', Promise.resolve());
    w.m.history.afterRebuild('a');
    w.store.setAgentApplied('a', 'p2', 'gemini-example');
    await vi.waitFor(() => expect(w.shells).toContain('recovery turn'));
    w.m.stop();
  });

  it('is reserved by the AI sources service when a switch asks for a recovery after its rebuild', async () => {
    const w = world();
    const a = w.agent('a');
    w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Other key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p2', createdAt: 'now' });
    w.rebuilding.set('a', new Promise<void>(() => {}));
    const sources = createAiSources({
      store: w.store, secretOf: async (ref) => `secret-for-${ref}`, providerFor: () => new MockProvider(), agentGone: () => false,
      models: {
        sourceSwitchRuntime: async () => ({}), subscriptionRuntimeProblem: async () => undefined,
        applyModelToRuntime: async () => 'live', askToApply: () => {}, pushModelList: async () => {},
      },
      detachClassIfDrifted: () => ({ detached: false }),
      withSourceHold: createSourceHolds({ holdMs: 600_000, warn: () => {} }).withSourceHold,
      kickRebuild: () => true, oweRebuild: () => '',
      // As routes.ts hands it in: the memory service's one slot per agent.
      recoverAfterRebuild: (id) => w.m.history.afterRebuild(id),
    });
    await sources.switchAgentToSource(a, w.store.getAIProfile('p2')!, { rebuild: true, recoverAfter: true },
      { switched: 0, rebuilding: 0, atNextStart: 0, notRecovered: 0, classDetached: 0, skipped: [] }, []);
    expect(w.m.history.recovering('a')).toBe(true);
    expect(await w.m.history.recover(w.store.getAgent('a')!, false)).toMatchObject({ status: 409 });
    expect(w.shells).not.toContain('stage');
    w.m.stop();
  });

  it('frees a slot whose agent is not running after its rebuild', async () => {
    const w = world();
    w.agent('a', { state: 'STOPPED' });
    w.rebuilding.set('a', Promise.resolve());
    w.m.history.afterRebuild('a');
    await vi.waitFor(() => expect(w.m.history.recovering('a')).toBe(false));
    expect(w.shells).not.toContain('stage');
  });

  it('stop() ends the slots\' timers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = world();
    await w.m.history.recover(w.agent('a'), false);
    expect(vi.getTimerCount()).toBe(1);
    w.m.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the chat history', () => {
  it('is read, and refused while the agent is busy', async () => {
    const w = world();
    const a = w.agent('a');
    const r = await w.m.history.transcript(a);
    expect(r.ok && r.body.t).toMatchObject({ text: '# history', conversations: 1, messages: 3 });
    expect(r.ok && r.body.file).toMatch(/^a-chat-history-\d{4}-\d{2}-\d{2}\.md$/);
    markBusy('a');
    try { expect(await w.m.history.transcript(a)).toMatchObject({ status: 409, error: "Can't read the history while the agent is busy — try again in a moment." }); }
    finally { clearBusy('a'); }
  });
});

describe('the token steward', () => {
  it('sets a context cap, stored and recorded, and takes it away', async () => {
    const w = world();
    const a = w.agent('a', { state: 'STOPPED' });
    expect(await w.m.steward.setContextCap(a, 'big', META)).toMatchObject({ status: 400, error: expect.stringMatching(/^tokens: a whole number from \d+ to \d+, or null to remove the cap\.$/) });
    expect(await w.m.steward.setContextCap(a, undefined, META)).toMatchObject({ status: 400 });
    const set = await w.m.steward.setContextCap(a, 100_000, META);
    expect(set).toEqual({ ok: true, body: { tokens: 100_000, outcome: 'pending', compactsAt: 80_000, message: 'Stored; it is written into "Agent a"\'s settings when it is next running (or at its next rebuild).' } });
    expect(w.store.getContextCap('a')?.tokens).toBe(100_000);
    expect(w.store.listTokenActions({ ownerId: OWNER, limit: 5 }).map((t) => t.kind)).toEqual(['context-cap']);
    const off = await w.m.steward.setContextCap(a, null, META);
    expect(off.ok && off.body).toMatchObject({ tokens: null, message: '"Agent a"\'s cap comes off when it is next running.' });
  });

  it('a compaction a restart cut off is finished in the ledger as interrupted, and never run again by itself (HB-1087)', async () => {
    const w = world();
    const a = w.agent('a');
    w.answer = () => new Promise<never>(() => {}); // the process ends while it runs in the agent
    const started = await w.m.steward.compact(a, 'summarise', undefined, META);
    expect(started.ok && started.body).toMatchObject({ background: true, action: { outcome: 'running' } });
    // One accepted that had not been sent yet (waiting for a looping retry's next stall).
    w.store.addTokenAction({ id: 'ta_waiting', agentId: 'b', ownerId: OWNER, kind: 'compaction', at: new Date().toISOString(), by: 'owner', via: 'app', detail: { mode: 'summarise', session: 'main' }, outcome: 'running' });
    // The restart: what the process held in memory is gone with it.
    compactingNow.clear();
    const next = w.restart();
    const rows = next.store.listTokenActions({ ownerId: OWNER });
    expect(rows.find((r) => r.agentId === 'a')).toMatchObject({ outcome: 'interrupted', detail: { mode: 'summarise', reason: expect.stringMatching(/restarted while it ran; it may have finished/) } });
    expect(rows.find((r) => r.agentId === 'a')!.detail.dispatched).toBeUndefined();
    expect(rows.find((r) => r.id === 'ta_waiting')).toMatchObject({ outcome: 'interrupted', detail: { reason: 'Hatchabot restarted before it started; nothing was compacted' } });
    expect(next.turns).toEqual([]); // nothing sent again
    // A new one may start (it is not left "already running").
    next.answer = async () => ({ code: 0, stdout: JSON.stringify({ ok: true, compacted: true, kept: 200 }), stderr: '' });
    expect(await next.m.steward.compact(next.store.getAgent('a')!, 'lines', 200, META)).toMatchObject({ ok: true, body: { action: { outcome: 'ok' } } });
  });

  it('while a switch of source waits for its rebuild, the cap is judged and recorded for the source still running (HB-1170)', async () => {
    const w = world();
    // Saved onto the local source, still running the cloud one: the cap still matters until the rebuild.
    const toLocal = w.agent('a', { state: 'STOPPED', vendor: 'local' });
    w.store.setAgentApplied('a', 'p1', 'claude-opus-4-8');
    const set = await w.m.steward.setContextCap(w.store.getAgent('a')!, 100_000, META);
    expect(set.ok).toBe(true);
    expect(w.store.getContextCap('a')?.tokens).toBe(100_000);
    expect(w.store.listTokenActions({ ownerId: OWNER, limit: 5 })[0]!.detail).toMatchObject({ model: 'anthropic/claude-opus-4-8' });
    expect(toLocal.aiProfileId).toBe('local');
    // Saved onto the cloud source, still running the local one: no cap until it runs the cloud one.
    w.agent('b', { state: 'STOPPED' });
    w.store.setAgentApplied('b', 'local', 'small');
    expect(await w.m.steward.setContextCap(w.store.getAgent('b')!, 100_000, META)).toEqual({
      ok: false, status: 400,
      error: 'It runs a local model until its rebuild onto its new source, and a local model costs nothing per token: set a cap after the rebuild.',
    });
    expect(w.store.getContextCap('b')).toBeUndefined();
  });

  it('a switch from one local model to another waiting for its rebuild needs no cap either, and says so (HB-1170)', async () => {
    const w = world();
    w.store.insertAIProfile({ id: 'local2', ownerId: OWNER, name: 'Second box', vendor: 'local', kind: 'api_key', model: 'other', secretRef: 'ai/local2', createdAt: 'now' } as never);
    w.agent('a', { state: 'STOPPED', vendor: 'local' });
    w.store.setAgentApplied('a', 'local', 'small');
    expect(w.store.setAgentAIProfile('a', 'local2')).toBe('ok');
    expect(await w.m.steward.setContextCap(w.store.getAgent('a')!, 100_000, META)).toEqual({ ok: false, status: 400, error: 'A local model costs nothing per token: no cap is needed.' });
  });

  it('needs no cap for a local model', async () => {
    const w = world();
    const a = w.agent('a', { vendor: 'local' });
    expect(await w.m.steward.setContextCap(a, 100_000, META)).toEqual({ ok: false, status: 400, error: 'A local model costs nothing per token: no cap is needed.' });
  });

  it('compacts only an agent that is not busy, and says why not', async () => {
    const w = world();
    const a = w.agent('a');
    markBusy('a');
    try { expect(await w.m.steward.compact(a, 'lines', 100, META)).toEqual({ ok: false, status: 409, error: 'It is busy (rebuilding or moving) — try again shortly.' }); }
    finally { clearBusy('a'); }
    const stopped = w.agent('s', { state: 'STOPPED' });
    expect(await w.m.steward.compact(stopped, 'lines', 100, META)).toEqual({ ok: false, status: 409, error: '"Agent s" is not running. Wake it first: compaction needs its gateway.' });
  });
});

describe('a child\'s distillation and its merge', () => {
  const AGENTS = '/home/node/.openclaw/agents/m/agent/AGENTS.md';

  it('is refused with no master, with three waiting, and while its turn is taken', async () => {
    const w = world();
    const orphan = w.agent('o');
    expect(w.m.proposals.cannotDistill(orphan)).toEqual({ ok: false, status: 400, error: 'This agent has no master to propose to.' });
    w.agent('m');
    const c = w.agent('c', { parent: 'm' });
    expect(w.m.proposals.cannotDistill(c)).toBeUndefined();
    for (const n of [1, 2, 3]) w.store.insertProposal({ id: `p${n}`, masterAgentId: 'm', childAgentId: 'c', childName: 'Agent c', text: 'x' });
    expect(w.m.proposals.cannotDistill(c)).toMatchObject({ status: 409 });
    expect(w.consults.turns.take('c')).toBe(true);
    expect(await w.m.proposals.distill(c, '')).toMatchObject({ status: 429 });
    w.consults.turns.release('c');
  });

  it('a master deleted, or a child taken off it, while the child writes gets no proposal, and says so (HB-1015)', async () => {
    const lesson = '## Check the boiler\nAsk for the meter reading before booking a visit.';
    for (const meanwhile of [
      (w: World) => { w.store.setAgentState('m', 'DELETING'); w.store.scrubAgentResidue('m'); w.store.setAgentState('m', 'DELETED'); },
      (w: World) => { w.store.setAgentState('m', 'DELETING'); },
      (w: World) => { w.store.setAgentParent('c', null); },
    ]) {
      const w = world();
      w.agent('m');
      const c = w.agent('c', { parent: 'm' });
      let answer!: (r: ExecResult) => void;
      w.answer = () => new Promise<ExecResult>((r) => { answer = r; });
      const distilling = w.m.proposals.distill(c, '');
      await vi.waitFor(() => expect(w.turns).toEqual(['c']));
      meanwhile(w);
      answer({ code: 0, stdout: lesson, stderr: '' });
      expect(await distilling).toEqual({ ok: false, status: 409, error: 'Its master was deleted, or it was taken off it, while it wrote this: nothing was proposed.' });
      expect(w.store.listProposals('m')).toEqual([]);
      // Its turn is free again.
      expect(w.consults.turns.take('c')).toBe(true);
    }
  });

  it('parks the child\'s text on the master, and the merge appends it once in the master\'s files turn', async () => {
    const w = world();
    w.agent('m');
    const c = w.agent('c', { parent: 'm' });
    w.files.set(AGENTS, '# Playbook\n');
    const lesson = '## Check the boiler\nAsk for the meter reading before booking a visit.';
    w.answer = async () => ({ code: 0, stdout: lesson, stderr: '' });
    const d = await w.m.proposals.distill(c, '  heating  ');
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(w.turns).toEqual(['c']);
    const [proposal] = w.store.listProposals('m');
    expect(proposal).toMatchObject({ id: d.body.id, childAgentId: 'c', text: lesson });
    const merged = await w.m.proposals.merge(w.store.getAgent('m')!, proposal!);
    expect(merged).toEqual({ ok: true, body: { merged: true } });
    expect(w.fileTurns).toEqual(['m']);
    expect(w.files.get(AGENTS)).toContain(`(proposal ${proposal!.id}) -->\n${lesson}`);
    expect(w.store.listProposals('m')).toEqual([]);
    // The loser of a race (or a second click) finds it claimed.
    expect(await w.m.proposals.merge(w.store.getAgent('m')!, proposal!)).toEqual({ ok: false, status: 404, error: 'No such pending proposal.' });
  });

  it('a merge a restart cut off before its write is waiting again at the next start, and merges once (HB-0888)', async () => {
    const w = world();
    w.agent('m');
    w.files.set(AGENTS, '# Playbook\n');
    w.store.insertProposal({ id: 'p1', masterAgentId: 'm', childAgentId: 'c', childName: 'Agent c', text: '## A lesson\nWrite the reading down first.' });
    const [proposal] = w.store.listProposals('m');
    // The first process claims the merge, and is gone before its files turn writes anything.
    const before = createProposals({
      store: w.store, providerFor: () => { throw new Error('never reached'); }, trace: () => () => {}, turns: w.consults.turns,
      withCoreFilesTurn: () => new Promise<never>(() => {}), freshRunning: () => { throw new Error('never reached'); }, askTimeoutMs: 1000,
    });
    void before.merge(w.store.getAgent('m')!, proposal!);
    expect(w.store.listProposals('m')).toEqual([]);
    const next = w.restart();
    expect(next.store.listProposals('m')).toEqual([proposal]);
    expect(await next.m.proposals.merge(next.store.getAgent('m')!, proposal!)).toEqual({ ok: true, body: { merged: true } });
    expect(next.files.get(AGENTS)!.split('(proposal p1) -->')).toHaveLength(2);
    expect(next.store.listProposals('m')).toEqual([]);
    // Merged for good: the start after that leaves it merged.
    expect(next.restart().store.listProposals('m')).toEqual([]);
  });

  it('a merge whose write landed before a restart is not appended again (HB-0888)', async () => {
    const w = world();
    w.agent('m');
    w.store.insertProposal({ id: 'p1', masterAgentId: 'm', childAgentId: 'c', childName: 'Agent c', text: 'a lesson' });
    const [proposal] = w.store.listProposals('m');
    w.files.set(AGENTS, '# Playbook\n\n<!-- distilled from Agent c, 2026-01-01 (proposal p1) -->\na lesson\n');
    expect(w.store.resolveProposal('m', 'p1', 'merging')).toBe(true); // claimed; the process ended after its write
    const next = w.restart();
    expect(await next.m.proposals.merge(next.store.getAgent('m')!, proposal!)).toEqual({ ok: true, body: { merged: true } });
    expect(next.files.get(AGENTS)!.split('(proposal p1) -->')).toHaveLength(2);
  });

  it('reopens the proposal when its turn refuses it', async () => {
    const w = world();
    const m = w.agent('m');
    w.store.insertProposal({ id: 'p1', masterAgentId: 'm', childAgentId: 'c', childName: 'Agent c', text: 'a lesson' });
    const [proposal] = w.store.listProposals('m');
    w.store.setAgentState('m', 'STOPPED');
    expect(await w.m.proposals.merge(m, proposal!)).toEqual({ ok: false, status: 409, error: 'Start the master to merge into its playbook.' });
    expect(w.store.listProposals('m').map((p) => p.id)).toEqual(['p1']);
  });
});
