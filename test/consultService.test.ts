import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { createConsults, type Consults } from '../src/orchestrator/consult/consults.js';
import { clearBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import type { Agent } from '../src/domain/types.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * The consult service (HB-0808 step 13), driven as src/api/chat/consultRoutes.ts
 * drives it, with no HTTP server: a real store on an in-memory database, and
 * containers that answer a turn as the test says. Call tokens are minted at
 * run time (never written here).
 */
const OWNER = 'user-owner', OTHER = 'user-other';

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
  store: Store; secrets: MemSecrets; c: Consults;
  turns: string[]; warned: string[]; woken: string[];
  /** What a turn in a container does: answer, or wait for `release`. */
  answer: (slug: string, text: string) => Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }>;
  wake: (a: Agent) => Agent;
  agent(id: string, o?: { owner?: string; state?: Agent['state']; ops?: boolean }): Agent;
  /** The call token an agent holds (minted for it at run time). */
  tokenOf(id: string): string;
}

function world(opts: { maxConcurrent?: number; perHour?: number } = {}): World {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const secrets = new MemSecrets();
  const w = { store, secrets, turns: [], warned: [], woken: [] } as unknown as World;
  w.answer = async (slug) => ({ code: 0, stdout: `answer from ${slug}\n`, stderr: '' });
  w.wake = (a) => a;
  const provider = {
    exec: async (_ref: string, argv: string[]) => { w.turns.push(argv[2]!); return w.answer(argv[2]!, argv[4]!); },
  };
  const tokens = new Map<string, string>();
  w.tokenOf = (id) => {
    if (!tokens.has(id)) tokens.set(id, store.createAgentCallToken(id, store.getAgent(id)!.ownerId));
    return tokens.get(id)!;
  };
  w.c = createConsults({
    store, secrets, providerFor: () => provider as never, trace: () => () => {},
    agentGone: (id) => !store.getAgent(id) || store.getAgent(id)!.state === 'DELETED',
    warn: (_d, msg) => { w.warned.push(msg); },
    ensureAwake: async (a) => { w.woken.push(a.id); return w.wake(a); },
    forgetSessions: () => {},
    unreadFor: async () => false,
    maxConcurrent: opts.maxConcurrent ?? 8, perHour: opts.perHour ?? 60, timeoutMs: 120_000,
  });
  w.agent = (id, o = {}) => {
    store.insertAgent({
      id, ownerId: o.owner ?? OWNER, name: `Agent ${id}`, slug: id, state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1',
      persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now', ...(o.ops ? { ops: true } : {}),
    } as unknown as Agent);
    store.setAgentRuntimeRef(id, `ref-${id}`);
    store.setAgentState(id, 'RUNNING');
    if (o.state === 'STOPPED' || o.state === 'ARCHIVED') store.setAgentState(id, 'STOPPED');
    if (o.state === 'ARCHIVED') store.setAgentState(id, 'ARCHIVED');
    return store.getAgent(id)!;
  };
  return w;
}

/** A turn that waits until the test lets it answer. */
function held(): { promise: Promise<{ code: number; stdout: string; stderr: string }>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<{ code: number; stdout: string; stderr: string }>((r) => { release = () => r({ code: 0, stdout: 'done', stderr: '' }); });
  return { promise, release };
}

describe('a consult', () => {
  it('is answered under a grant, and its turn is let go after', async () => {
    const w = world();
    w.agent('a'); w.agent('b');
    w.store.setAgentPeers('a', ['b']);
    const r = await w.c.consult(w.tokenOf('a'), 'b', 'what is for dinner?');
    expect(r).toEqual({ ok: true, body: { reply: 'answer from b' } });
    expect(w.turns).toEqual(['b']);
    expect(w.c.turns.inFlight('a')).toBe(false);
    expect(w.c.turns.inFlight('b')).toBe(false);
  });

  it('is refused without a call token, to an agent that is not there, without a grant, and to the Hatchabot agent', async () => {
    const w = world();
    w.agent('a'); w.agent('b'); w.agent('c'); w.agent('ops', { ops: true }); w.agent('x', { owner: OTHER });
    w.store.setAgentPeers('a', ['b', 'ops', 'x']);
    expect(await w.c.consult('', 'b', 'hi')).toMatchObject({ ok: false, status: 401, error: 'Agent call token required.' });
    expect(await w.c.consult('not-a-token', 'b', 'hi')).toMatchObject({ status: 401 });
    expect(await w.c.consult(w.tokenOf('a'), 'nobody', 'hi')).toMatchObject({ status: 404, error: 'No such agent.' });
    expect(await w.c.consult(w.tokenOf('a'), 'c', 'hi')).toMatchObject({ status: 403, error: 'Not allowed to consult that agent.' });
    expect(await w.c.consult(w.tokenOf('a'), 'x', 'hi')).toMatchObject({ status: 403, error: 'Not allowed to consult that agent.' });
    expect(await w.c.consult(w.tokenOf('a'), 'ops', 'hi')).toMatchObject({ status: 403, error: 'The Hatchabot agent cannot be consulted by other agents.' });
    expect(w.turns).toEqual([]);
  });

  it('refuses an empty message before it wakes anyone, and makes any text a text', async () => {
    const w = world();
    w.agent('a'); w.agent('b');
    w.store.setAgentPeers('a', ['b']);
    expect(await w.c.consult(w.tokenOf('a'), 'b', undefined)).toMatchObject({ status: 400, error: 'Empty message.' });
    expect(await w.c.consult(w.tokenOf('a'), 'b', '   ')).toMatchObject({ status: 400, error: 'Empty message.' });
    expect(w.woken).toEqual([]);
    expect(await w.c.consult(w.tokenOf('a'), 'b', 5)).toMatchObject({ ok: true });
  });

  it('refuses a peer already in a turn, and a consult back to a caller that is waiting (the depth limit)', async () => {
    const w = world();
    w.agent('a'); w.agent('b'); w.agent('c');
    w.store.setAgentPeers('a', ['b']); w.store.setAgentPeers('b', ['a']); w.store.setAgentPeers('c', ['b']);
    const turn = held();
    w.answer = () => turn.promise;
    const first = w.c.consult(w.tokenOf('a'), 'b', 'one');
    await new Promise((r) => setImmediate(r));
    expect(w.c.turns.inFlight('b')).toBe(true);
    expect(w.c.turns.inFlight('a')).toBe(true); // the caller is held while it waits
    expect(await w.c.consult(w.tokenOf('c'), 'b', 'two')).toMatchObject({ status: 429, error: expect.stringContaining('already answering a consult') });
    // B consulting A back while A waits on B: an A→B→A loop.
    expect(await w.c.consult(w.tokenOf('b'), 'a', 'back')).toMatchObject({ status: 429 });
    turn.release();
    expect(await first).toMatchObject({ ok: true });
    expect(w.c.turns.inFlight('a')).toBe(false);
    expect(w.c.turns.inFlight('b')).toBe(false);
  });

  it('holds a caller waiting on two consults until the second is over', async () => {
    const w = world();
    w.agent('a'); w.agent('b'); w.agent('c');
    w.store.setAgentPeers('a', ['b', 'c']);
    const tb = held(), tc = held();
    w.answer = (slug) => (slug === 'b' ? tb.promise : tc.promise);
    const one = w.c.consult(w.tokenOf('a'), 'b', 'one');
    const two = w.c.consult(w.tokenOf('a'), 'c', 'two');
    await new Promise((r) => setImmediate(r));
    tb.release(); await one;
    expect(w.c.turns.inFlight('a')).toBe(true);
    tc.release(); await two;
    expect(w.c.turns.inFlight('a')).toBe(false);
  });

  it('is held to the owner\'s count at once and the caller\'s count an hour', async () => {
    const w = world({ maxConcurrent: 1, perHour: 2 });
    w.agent('a'); w.agent('b'); w.agent('c');
    w.store.setAgentPeers('a', ['b', 'c']);
    const turn = held();
    w.answer = () => turn.promise;
    const first = w.c.consult(w.tokenOf('a'), 'b', 'one');
    await new Promise((r) => setImmediate(r));
    expect(await w.c.consult(w.tokenOf('a'), 'c', 'two')).toMatchObject({ status: 429, error: 'Too many consults in flight for this account — try again shortly.' });
    turn.release(); await first;
    w.answer = async () => ({ code: 0, stdout: 'ok', stderr: '' });
    expect(await w.c.consult(w.tokenOf('a'), 'c', 'three')).toMatchObject({ ok: true });
    expect(await w.c.consult(w.tokenOf('a'), 'c', 'four')).toMatchObject({ status: 429, error: 'This agent has hit its consult limit (2/hour).' });
  });

  it('keeps a peer that waits on its own consult held when the consult it was answering ends (HB-1088)', async () => {
    const w = world();
    w.agent('a'); w.agent('b'); w.agent('c');
    w.store.setAgentPeers('a', ['b']); w.store.setAgentPeers('b', ['c']); w.store.setAgentPeers('c', ['b']);
    const outer = held(), inner = held();
    w.answer = (slug) => (slug === 'b' ? outer.promise : inner.promise);
    const ab = w.c.consult(w.tokenOf('a'), 'b', 'one');
    await new Promise((r) => setImmediate(r));
    const bc = w.c.consult(w.tokenOf('b'), 'c', 'nested'); // B asks C while answering A
    await new Promise((r) => setImmediate(r));
    outer.release(); // A's consult ends (its exec timed out, say) while B still waits on C
    expect(await ab).toMatchObject({ ok: true });
    expect(w.c.turns.inFlight('b')).toBe(true);
    expect(await w.c.consult(w.tokenOf('c'), 'b', 'back')).toMatchObject({ status: 429 }); // C→B→C
    expect(w.c.turns.take('b')).toBe(false); // nor an ask in B
    inner.release();
    expect(await bc).toMatchObject({ ok: true });
    expect(w.c.turns.inFlight('b')).toBe(false);
    expect(w.c.turns.inFlight('c')).toBe(false);
  });

  it('keeps a peer that consults another during an ask held until its consult ends (HB-1088)', async () => {
    const w = world();
    w.agent('b'); w.agent('c');
    w.store.setAgentPeers('b', ['c']);
    expect(w.c.turns.take('b')).toBe(true); // an owner's ask in B
    const turn = held();
    w.answer = () => turn.promise;
    const bc = w.c.consult(w.tokenOf('b'), 'c', 'during the ask');
    await new Promise((r) => setImmediate(r));
    w.c.turns.release('b'); // the ask ends first
    expect(w.c.turns.inFlight('b')).toBe(true);
    expect(w.c.turns.take('b')).toBe(false);
    turn.release(); await bc;
    expect(w.c.turns.inFlight('b')).toBe(false);
    expect(w.c.turns.take('b')).toBe(true);
  });

  it('holds two consults sent at once to the owner\'s count, and gives the place back however one ends (HB-0885)', async () => {
    const w = world({ maxConcurrent: 1 });
    w.agent('a'); w.agent('b'); w.agent('c'); w.agent('d');
    w.store.setAgentPeers('a', ['b']); w.store.setAgentPeers('c', ['d']);
    const turn = held();
    w.answer = () => turn.promise;
    // Both are checked before either one's wake has answered.
    const [one, two] = [w.c.consult(w.tokenOf('a'), 'b', 'one'), w.c.consult(w.tokenOf('c'), 'd', 'two')];
    expect(await two).toEqual({ ok: false, status: 429, error: 'Too many consults in flight for this account — try again shortly.' });
    turn.release();
    expect(await one).toMatchObject({ ok: true });
    expect(w.turns).toEqual(['b']);
    // A consult refused after its wake gives its place back too.
    w.store.setAgentState('d', 'STOPPED');
    expect(await w.c.consult(w.tokenOf('c'), 'd', 'three')).toMatchObject({ status: 409, error: 'That agent is not running.' });
    w.wake = () => { throw new Error('the wake failed'); };
    await expect(w.c.consult(w.tokenOf('c'), 'd', 'four')).rejects.toThrow('the wake failed');
    w.wake = (x) => x;
    w.answer = async () => ({ code: 0, stdout: 'ok', stderr: '' });
    expect(await w.c.consult(w.tokenOf('a'), 'b', 'five')).toMatchObject({ ok: true });
  });

  it('wakes a sleeping peer, and checks the grant, the token and the target again after the wake', async () => {
    const w = world();
    w.agent('a'); w.agent('b', { state: 'STOPPED' });
    w.store.setAgentPeers('a', ['b']);
    // The grant is withdrawn while the peer wakes.
    w.wake = (b) => { w.store.setAgentPeers('a', []); return w.store.setAgentState(b.id, 'RUNNING'); };
    expect(await w.c.consult(w.tokenOf('a'), 'b', 'hi')).toMatchObject({ status: 403, error: 'Not allowed to consult that agent.' });
    expect(w.woken).toEqual(['b']);
    expect(w.turns).toEqual([]);
    // A peer that does not come up.
    w.store.setAgentState('b', 'STOPPED');
    w.store.setAgentPeers('a', ['b']);
    w.wake = (b) => b;
    expect(await w.c.consult(w.tokenOf('a'), 'b', 'hi')).toMatchObject({ status: 409, error: 'That agent is not running.' });
  });

  it('refuses a busy peer, and never hands a failed turn on as an answer', async () => {
    const w = world();
    w.agent('a'); w.agent('b');
    w.store.setAgentPeers('a', ['b']);
    markBusy('b');
    try { expect(await w.c.consult(w.tokenOf('a'), 'b', 'hi')).toMatchObject({ status: 409, error: 'That agent is busy (rebuilding or moving) — try again shortly.' }); }
    finally { clearBusy('b'); }
    w.answer = async () => ({ code: 1, stdout: 'docker said something', stderr: '' });
    expect(await w.c.consult(w.tokenOf('a'), 'b', 'hi')).toEqual({ ok: false, status: 502, error: 'The peer could not complete the turn.' });
    w.answer = async () => ({ code: 0, stdout: '', stderr: '', timedOut: true });
    expect(await w.c.consult(w.tokenOf('a'), 'b', 'hi')).toEqual({ ok: false, status: 504, error: 'The peer did not answer in time.' });
    expect(w.c.turns.inFlight('b')).toBe(false);
  });
});

describe('the one turn per agent', () => {
  it('is taken once, refused while it is held, and let go', () => {
    const w = world();
    expect(w.c.turns.take('a')).toBe(true);
    expect(w.c.turns.take('a')).toBe(false);
    expect(w.c.turns.inFlight('a')).toBe(true);
    w.c.turns.release('a');
    expect(w.c.turns.inFlight('a')).toBe(false);
    expect(w.c.turns.take('a')).toBe(true);
  });
});

describe('peers', () => {
  it('are set to the owner\'s own active agents only, with a call token minted, and listed', async () => {
    const w = world();
    w.agent('a'); w.agent('b'); w.agent('c'); w.agent('ops', { ops: true }); w.agent('x', { owner: OTHER }); w.agent('old', { state: 'ARCHIVED' });
    const r = await w.c.peers.set(w.store.getAgent('a')!, OWNER, ['b', 'c', 'ops', 'x', 'old', 'a', 'nobody'], ['c', 'x']);
    expect(r).toEqual({ peers: ['b', 'c'] });
    expect(w.store.listAgentPeers('a').sort()).toEqual(['b', 'c']);
    expect(w.store.listAgentActionPeers('a')).toEqual(['c']);
    expect(w.warned).toEqual(['a2a.actions_authorized — this agent may ask these peers to act, not just answer']);
    expect(w.store.hasAgentCallToken('a')).toBe(true);
    expect(w.store.agentCallTokenIs('a', await w.secrets.get('agent-call-token/a'))).toBe(true);
    const view = w.c.peers.view(w.store.getAgent('a')!, OWNER);
    expect(view.peers.map((p) => p.id).sort()).toEqual(['b', 'c']);
    expect(view.candidates.map((p) => p.id).sort()).toEqual(['b', 'c']);
    expect(view.candidates.find((p) => p.id === 'c')).toMatchObject({ granted: true, allowActions: true });
  });

  it('mints a token again when its secret no longer matches, and none for no grant', async () => {
    const w = world();
    w.agent('a'); w.agent('b'); w.agent('c');
    await w.c.peers.set(w.store.getAgent('c')!, OWNER, [], undefined);
    expect(w.store.hasAgentCallToken('c')).toBe(false);
    await w.c.peers.set(w.store.getAgent('a')!, OWNER, ['b'], undefined);
    await w.secrets.put('agent-call-token/a', ['made', 'up'].join('-'));
    await w.c.peers.set(w.store.getAgent('a')!, OWNER, ['b'], undefined);
    expect(w.store.agentCallTokenIs('a', await w.secrets.get('agent-call-token/a'))).toBe(true);
  });
});

describe('the mesh', () => {
  it('connects a selection to each other, leaves out who cannot be, and says who needs a rebuild', async () => {
    const w = world();
    const a = w.agent('a'), b = w.agent('b'), c = w.agent('c'), old = w.agent('old', { state: 'ARCHIVED' }), ops = w.agent('ops', { ops: true });
    const r = await w.c.peers.mesh(OWNER, [a, b, c, old, ops], true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toMatchObject({ connected: true, agents: 3, changed: 3, grants: 6 });
    expect(r.body.skipped).toEqual([{ name: 'Agent old', reason: 'archived' }, { name: 'Agent ops', reason: 'the Hatchabot agent is not consulted by other agents' }]);
    expect(r.body.needRebuild.map((x) => x.id).sort()).toEqual(['a', 'b', 'c']);
    expect(w.store.listAgentPeers('a').sort()).toEqual(['b', 'c']);
    for (const id of ['a', 'b', 'c']) expect(w.store.hasAgentCallToken(id)).toBe(true);
    // Disconnected: the grants inside the selection go, one outside stays.
    w.agent('d');
    w.store.setAgentPeers('a', ['b', 'c', 'd']);
    const off = await w.c.peers.mesh(OWNER, [a, b, c], false);
    expect(off.ok && off.body).toMatchObject({ connected: false, grants: 0 });
    expect(w.store.listAgentPeers('a')).toEqual(['d']);
  });

  it('gives a member deleted while it runs no grants and no call token back, and its token calls no one (HB-0965)', async () => {
    const w = world();
    const a = w.agent('a'), b = w.agent('b'), c = w.agent('c');
    // The first member's token waits on the vault; meanwhile b is deleted, its delete scrubbing its grants and token.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const put = w.secrets.put.bind(w.secrets);
    w.secrets.put = async (ref, value) => { if (ref === 'agent-call-token/a') await gate; await put(ref, value); };
    const pending = w.c.peers.mesh(OWNER, [a, b, c], true);
    await new Promise((r) => setImmediate(r));
    w.store.setAgentState('b', 'DELETING');
    w.store.scrubAgentResidue('b');
    await w.secrets.delete('agent-call-token/b');
    w.store.setAgentState('b', 'DELETED');
    release();
    const r = await pending;
    expect(r.ok && r.body.needRebuild.map((x) => x.id).sort()).toEqual(['a', 'c']);
    expect(w.store.listAgentPeers('b')).toEqual([]);
    expect(w.store.listAgentPeers('a')).toEqual(['c']);
    expect(w.store.listAgentPeers('c')).toEqual(['a']);
    expect(w.store.hasAgentCallToken('b')).toBe(false);
    await expect(w.secrets.get('agent-call-token/b')).rejects.toThrow();
    expect(w.store.hasAgentCallToken('a')).toBe(true);
    expect(w.store.hasAgentCallToken('c')).toBe(true);
  });

  it('a disconnect takes the grants of a member archived or moved while it ran (HB-0965)', async () => {
    const w = world();
    const a = w.agent('a'), b = w.agent('b'), c = w.agent('c');
    w.agent('d');
    // Connected before; a also consults d, outside the selection. Its token was
    // minted on the way, and the gate held the disconnect there; a disconnect
    // mints nothing now (HB-1127), so the gate holds only a mint that came back.
    w.store.setAgentPeers('a', ['b', 'c', 'd']);
    w.store.setAgentPeers('b', ['a', 'c']);
    w.store.setAgentPeers('c', ['a', 'b']);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const put = w.secrets.put.bind(w.secrets);
    w.secrets.put = async (ref, value) => { if (ref === 'agent-call-token/a') await gate; await put(ref, value); };
    const pending = w.c.peers.mesh(OWNER, [a, b, c], false);
    await new Promise((r) => setImmediate(r));
    // Meanwhile b is archived (its grants stay with it) and c moves away.
    w.store.setAgentState('b', 'STOPPED');
    w.store.setAgentState('b', 'ARCHIVED');
    w.store.setAgentMigratedTo('c', 'moved to another machine');
    release();
    expect((await pending).ok).toBe(true);
    expect(w.store.listAgentPeers('a')).toEqual(['d']);
    expect(w.store.listAgentPeers('b')).toEqual([]); // unarchived, it calls none of them
    expect(w.store.listAgentPeers('c')).toEqual([]);
    expect(w.store.hasAgentCallToken('b')).toBe(false); // and no token is minted for it
  });

  it('a disconnect takes every grant inside the selection while the vault fails, minting nothing (HB-1127)', async () => {
    const w = world();
    const a = w.agent('a'), b = w.agent('b');
    w.agent('c');
    // a and b consult each other and c; a's token row is there, its secret is not readable now.
    w.store.setAgentPeers('a', ['b', 'c']);
    w.store.setAgentPeers('b', ['a', 'c']);
    w.tokenOf('a'); w.tokenOf('b');
    const touched: string[] = [];
    w.secrets.get = async (ref) => { touched.push(`get ${ref}`); throw new Error('vault unavailable'); };
    w.secrets.put = async (ref) => { touched.push(`put ${ref}`); throw new Error('vault unavailable'); };
    const off = await w.c.peers.mesh(OWNER, [a, b], false);
    expect(off.ok && off.body).toMatchObject({ connected: false, changed: 2 });
    expect(w.store.listAgentPeers('a')).toEqual(['c']);
    expect(w.store.listAgentPeers('b')).toEqual(['c']);
    expect(touched).toEqual([]);
  });

  it('does not make a token live for an agent deleted while its secret was written (HB-0965)', async () => {
    const w = world();
    w.agent('a'); w.agent('b');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const put = w.secrets.put.bind(w.secrets);
    w.secrets.put = async (ref, value) => { await gate; await put(ref, value); };
    const pending = w.c.peers.set(w.store.getAgent('a')!, OWNER, ['b'], undefined);
    await new Promise((r) => setImmediate(r));
    w.store.setAgentState('a', 'DELETING'); w.store.scrubAgentResidue('a'); w.store.setAgentState('a', 'DELETED');
    release(); await pending;
    expect(w.store.hasAgentCallToken('a')).toBe(false);
    await expect(w.secrets.get('agent-call-token/a')).rejects.toThrow();
  });

  it('a call token whose agent is deleted, archived or moved away calls no one (HB-0965)', async () => {
    const w = world();
    w.agent('a'); w.agent('b'); w.agent('gone'); w.agent('old', { state: 'ARCHIVED' }); w.agent('away');
    for (const id of ['a', 'gone', 'old', 'away']) w.store.setAgentPeers(id, ['b']);
    const tokens = Object.fromEntries(['a', 'gone', 'old', 'away'].map((id) => [id, w.tokenOf(id)]));
    expect(await w.c.consult(tokens.a!, 'b', 'hi')).toMatchObject({ ok: true });
    const refusedCall = { ok: false, status: 401, error: 'Agent call token required.' };
    w.store.setAgentState('gone', 'DELETING');
    expect(await w.c.consult(tokens.gone!, 'b', 'hi')).toEqual(refusedCall);
    w.store.setAgentState('gone', 'DELETED');
    expect(await w.c.consult(tokens.gone!, 'b', 'hi')).toEqual(refusedCall);
    expect(await w.c.consult(tokens.old!, 'b', 'hi')).toEqual(refusedCall);
    w.store.setAgentMigratedTo('away', 'moved to another machine');
    expect(await w.c.consult(tokens.away!, 'b', 'hi')).toEqual(refusedCall);
    expect(w.turns).toEqual(['b']);
  });

  it('needs two active agents', async () => {
    const w = world();
    const a = w.agent('a'), old = w.agent('old', { state: 'ARCHIVED' });
    expect(await w.c.peers.mesh(OWNER, [a, old], true)).toEqual({ ok: false, status: 400, error: 'At least two of the selected agents must be active.' });
  });
});
