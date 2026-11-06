/**
 * The operations API (GET /v1/operations, GET /v1/operations/:id, POST
 * /v1/operations/:id/recover) and the on-disk guard: an agent whose long
 * operation was interrupted or is held for a choice refuses Start, Rebuild,
 * Archive, Move, Rehost, Delete, Wake and Retry with the operation's line.
 */
import { describe, expect, it, vi } from 'vitest';
import { MockProvider } from '../src/providers/mockProvider.js';
import { beginOperation } from '../src/orchestrator/operations.js';
import { moveAgentToHost } from '../src/orchestrator/moveHost.js';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';

const MEMBER = 'user-member';
const OTHER = 'user-other';

/** A move to Test Runner, interrupted before the flip and held: the agent is stopped on box. */
async function heldMove(w: World, id: string) {
  w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock2', name: 'Test Runner', settings: {}, createdAt: 'now' });
  w.providers.set('mock2', new MockProvider());
  const ref = w.store.getAgent(id)!.runtimeRef!;
  await w.provider.stop(ref);
  w.store.setAgentState(id, 'STOPPED');
  const op = beginOperation(w.store, 'move-host', id, {
    from: 'h1', to: 'h2', fromName: 'box', toName: 'Test Runner', wasRunning: true, oldRef: ref, keyBefore: null,
  });
  op.step('checked');
  op.step('stopped');
  op.hold("The move to Test Runner was interrupted, and Test Runner isn't answering.", {
    actions: [{ action: 'retry', label: 'Try again when Test Runner is back' }, { action: 'put-back', label: 'Put it back on box' }],
    recommended: 'retry',
  });
  return op.id;
}

describe('a change only a new container picks up, while an operation is not over (HB-0411, HB-0420)', () => {
  /** The world's channel row, and the agent with its move held. */
  const held = async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { name: 'Test Agent', accountId: 'testagentbot' });
    const opId = await heldMove(w, id);
    return { w, id, opId };
  };
  const refused = (r: { statusCode: number; json(): { error: string; operation?: string } }, opId: string) => {
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/Choose what to do on its page first/);
    expect(r.json().operation).toBe(opId);
  };

  it('giving its bot back is refused: the undo starts the old container, which would still hold it', async () => {
    const { w, id, opId } = await held();
    refused(await w.f.inject({ method: 'DELETE', url: `/v1/agents/${id}/telegram`, headers: as() }), opId);
    expect(w.store.getChannelForAgent(id)?.accountId).toBe('testagentbot');
    expect(w.store.getAgent(id)!.rebuildOnStart).toBeUndefined();
  });

  it('a browser switch and an image pin are refused, and nothing else in the request is saved', async () => {
    const { w, id, opId } = await held();
    refused(await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(), payload: { browser: true, group: 'Kitchen' } }), opId);
    expect(w.store.getAgent(id)!.browser).toBeFalsy();
    expect(w.store.getAgent(id)!.group).toBeUndefined();
    refused(await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(), payload: { image: 'hatchabot/runtime:other' } }), opId);
    expect(w.store.getAgent(id)!.image).toBeUndefined();
    expect(w.store.getAgent(id)!.rebuildOnStart).toBeUndefined();
    // What needs no new container goes on as before.
    expect((await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(), payload: { group: 'Kitchen' } })).statusCode).toBe(200);
  });

  it('a bot added, a chat app added, changed or removed, and a source switch: none is promised for a next start', async () => {
    const { w, id, opId } = await held();
    w.store.deleteChannelForAgent(id);
    refused(await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/telegram`, headers: as(), payload: {} }), opId);
    for (const kind of ['discord', 'slack']) {
      refused(await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/channels/${kind}`, headers: as(), payload: {} }), opId);
    }
    w.store.insertChannel({ id: 'c1', agentId: id, kind: 'discord', accountId: 'app1', secretRef: 'channel/d', deepLink: 'https://discord.example.org/app1', createdAt: 'now' } as never);
    refused(await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}/channels/discord`, headers: as(), payload: { rooms: { mode: 'off' } } }), opId);
    refused(await w.f.inject({ method: 'DELETE', url: `/v1/agents/${id}/channels/discord`, headers: as() }), opId);
    expect(w.store.getChannelForAgent(id, 'discord')).toBeDefined();
    w.store.insertAIProfile({ id: 'p2', ownerId: w.owner, name: 'Other', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    const before = w.store.getAgent(id)!.aiProfileId;
    const sw = await w.f.inject({ method: 'POST', url: '/v1/ai-profiles/p2/adopt-agents', headers: as(), payload: { apply: [id], rebuild: true } });
    expect(sw.json()).toMatchObject({ switched: 0, atNextStart: 0 });
    expect(sw.json().skipped[0].reason).toMatch(/busy/);
    expect(w.store.getAgent(id)!.aiProfileId).toBe(before);
    expect(w.store.getAgent(id)!.rebuildOnStart).toBeUndefined();
  });

  it('under a move still running, then once it has failed with its source down: refused, then owed to Start', async () => {
    const w = await makeWorld();
    const target = new MockProvider({ failOn: 'provision' });
    w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock2', name: 'Test Runner', settings: {}, createdAt: 'now' });
    w.providers.set('mock2', target);
    const id = await seedRunningAgent(w, { name: 'Test Agent' });
    const start = w.provider.start.bind(w.provider);
    w.provider.start = async () => { throw new Error('the port is taken'); };
    let go!: () => void;
    const held = new Promise<void>((r) => { go = r; });
    let reached!: () => void;
    const there = new Promise<void>((r) => { reached = r; });
    const provision = target.provision.bind(target);
    target.provision = async (spec) => { reached(); await held; return provision(spec); };
    const move = moveAgentToHost({ store: w.store, secrets: w.secrets, channel: w.channel, source: w.provider, target, sleep: async () => {} }, id, 'h2').catch(() => {});
    await there;
    expect(w.store.getAgent(id)!.state).toBe('STOPPED'); // the move's stop, not its owner's
    const r = await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(), payload: { browser: true } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/under way/);
    expect(w.store.getAgent(id)!.browser).toBeFalsy();
    go();
    await move;
    expect(w.store.getAgent(id)).toMatchObject({ hostId: 'h1', state: 'STOPPED' });
    expect(w.store.getAgent(id)!.rebuildOnStart).toBeUndefined();
    // The move is over: a stopped agent like any other. Its next start has the change.
    w.provider.start = start;
    const later = await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(), payload: { browser: true } });
    expect(later.statusCode).toBe(200);
    expect(later.json().browserPending).toMatch(/when it next starts/);
    expect(w.store.getAgent(id)!.rebuildOnStart).toBeTruthy();
  });

  it('a change that passed its checks before the operation began promises nothing: a next start it would not get', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { name: 'Test Agent' });
    await w.provider.stop(w.store.getAgent(id)!.runtimeRef!);
    w.store.setAgentState(id, 'STOPPED');
    // The operation begins in the one await between the route's check and its answer.
    const orig = w.store.setAgentBrowser.bind(w.store);
    w.store.setAgentBrowser = (...a: Parameters<typeof orig>) => { orig(...a); beginOperation(w.store, 'move-host', id, {}); };
    const r = await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(), payload: { browser: true } });
    expect(r.statusCode).toBe(200);
    expect(w.store.getAgent(id)!.rebuildOnStart).toBeUndefined();
    expect(r.json().browserPending ?? '').not.toMatch(/next starts/);
  });

  it('a mark saved while a move ran survives its undo, where the record would have put back its snapshot', async () => {
    const w = await makeWorld();
    const target = new MockProvider({ failOn: 'provision' });
    w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock2', name: 'Test Runner', settings: {}, createdAt: 'now' });
    const id = await seedRunningAgent(w, { name: 'Test Agent' });
    const provision = target.provision.bind(target);
    target.provision = (spec) => { w.store.setRebuildOnStart(id, new Date().toISOString()); return provision(spec); };
    await moveAgentToHost({ store: w.store, secrets: w.secrets, channel: w.channel, source: w.provider, target, sleep: async () => {} }, id, 'h2').catch(() => {});
    expect(w.store.getAgent(id)).toMatchObject({ hostId: 'h1', state: 'RUNNING' });
    expect(w.store.getAgent(id)!.rebuildOnStart).toBeTruthy();
  });
});

describe('a held operation keeps the agent busy on disk', () => {
  it('Start, Rebuild, Archive, Move, Rehost, Delete, Wake and Retry refuse with its line', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { name: 'Test Agent' });
    const opId = await heldMove(w, id);
    w.store.insertPeer({ id: 'peer1', ownerId: w.owner, name: 'Test Peer', url: 'http://peer.example.org', secretRef: 'peer/tok', createdAt: 'now' });
    const calls: Array<[string, string, unknown?]> = [
      ['POST', `/v1/agents/${id}/start`],
      ['POST', `/v1/agents/${id}/rebuild`, {}],
      ['POST', `/v1/agents/${id}/archive`, {}],
      ['POST', `/v1/agents/${id}/move-host`, { hostId: 'h2' }],
      ['POST', `/v1/agents/${id}/rehost`, { peerId: 'peer1' }],
      ['DELETE', `/v1/agents/${id}`],
      ['POST', `/v1/agents/${id}/provision`],
    ];
    for (const [method, url, payload] of calls) {
      const r = await w.f.inject({ method: method as 'POST', url, headers: as(), ...(payload ? { payload } : {}) });
      expect(r.statusCode, `${method} ${url}`).toBe(409);
      expect(r.json().error, `${method} ${url}`).toMatch(/Test Runner isn't answering\. Choose what to do on its page first/);
      expect(r.json().operation).toBe(opId);
    }
    // Asleep, a wake is refused the same way.
    w.store.setHibernated(id, new Date().toISOString());
    const wake = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/wake`, headers: as() });
    expect(wake.statusCode).toBe(409);
    expect(w.store.getAgent(id)!.state).toBe('STOPPED');
    expect(w.store.getAgent(id)!.hostId).toBe('h1');
  });

  it('the agent payload carries the operation and its choices — to its owner only', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { name: 'Test Agent', members: [{ userId: MEMBER, displayName: 'Test Member' }] });
    const opId = await heldMove(w, id);
    const mine = (await w.f.inject({ method: 'GET', url: `/v1/agents/${id}`, headers: as() })).json();
    expect(mine.operation).toMatchObject({ id: opId, kind: 'move-host', status: 'held', stepLabel: 'stopped here', stepN: 2, steps: 10 });
    expect(mine.operation.recovery.actions.map((a: { action: string }) => a.action)).toEqual(['retry', 'put-back']);
    const list = (await w.f.inject({ method: 'GET', url: '/v1/agents', headers: as(MEMBER) })).json() as Array<{ id: string; operation?: Record<string, unknown> }>;
    const theirs = list.find((a) => a.id === id)!;
    expect(theirs.operation).toEqual({ kind: 'move-host', kindLabel: 'Move to another machine', status: 'held' });
  });
});

describe('GET /v1/operations', () => {
  it("lists an agent's operations for its owner; members and others see nothing", async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { name: 'Test Agent', members: [{ userId: MEMBER, displayName: 'Test Member' }] });
    const opId = await heldMove(w, id);
    const r = await w.f.inject({ method: 'GET', url: `/v1/operations?agentId=${id}`, headers: as() });
    expect(r.statusCode).toBe(200);
    expect(r.json().operations.map((o: { id: string }) => o.id)).toEqual([opId]);
    expect((await w.f.inject({ method: 'GET', url: '/v1/operations', headers: as() })).json().operations).toHaveLength(1);
    expect((await w.f.inject({ method: 'GET', url: `/v1/operations/${opId}`, headers: as() })).json()).toMatchObject({ id: opId, status: 'held' });
    for (const who of [MEMBER, OTHER]) {
      expect((await w.f.inject({ method: 'GET', url: `/v1/operations?agentId=${id}`, headers: as(who) })).statusCode).toBe(404);
      expect((await w.f.inject({ method: 'GET', url: `/v1/operations/${opId}`, headers: as(who) })).statusCode).toBe(404);
      expect((await w.f.inject({ method: 'GET', url: '/v1/operations', headers: as(who) })).json().operations).toEqual([]);
      expect((await w.f.inject({ method: 'POST', url: `/v1/operations/${opId}/recover`, headers: as(who), payload: { action: 'put-back' } })).statusCode).toBe(404);
    }
  });
});

describe('POST /v1/operations/:id/recover', () => {
  it("runs the held operation's offered choice — and only that", async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { name: 'Test Agent' });
    const opId = await heldMove(w, id);
    const bad = await w.f.inject({ method: 'POST', url: `/v1/operations/${opId}/recover`, headers: as(), payload: { action: 'finish-anyway' } });
    expect(bad.statusCode).toBe(400);
    expect((await w.f.inject({ method: 'POST', url: `/v1/operations/${opId}/recover`, headers: as(), payload: {} })).statusCode).toBe(400);
    const r = await w.f.inject({ method: 'POST', url: `/v1/operations/${opId}/recover`, headers: as(), payload: { action: 'put-back' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().operation).toMatchObject({ id: opId, status: 'rolled_back' });
    expect(r.json().agent).toMatchObject({ id, state: 'RUNNING', hostId: 'h1' });
    expect(r.json().agent.operation).toBeUndefined();
    // Settled: nothing left to choose, and Start/Stop work again.
    const again = await w.f.inject({ method: 'POST', url: `/v1/operations/${opId}/recover`, headers: as(), payload: { action: 'put-back' } });
    expect(again.statusCode).toBe(409);
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/stop`, headers: as() })).statusCode).toBe(200);
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: as() })).statusCode).toBe(200);
    // Its timeline says what was chosen.
    expect(w.store.listEvents([id], 20).map((e) => e.event)).toContain('op.recover');
  });

  it('a move through the route answers 202 with its operation, and the record shows every step', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { name: 'Test Agent' });
    w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock2', name: 'Test Runner', settings: {}, createdAt: 'now' });
    w.providers.set('mock2', new MockProvider());
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host`, headers: as(), payload: { hostId: 'h2' } });
    expect(r.statusCode).toBe(202);
    const opId = r.json().operation.id as string;
    expect(opId).toMatch(/^op_/);
    await vi.waitFor(async () => {
      const op = (await w.f.inject({ method: 'GET', url: `/v1/operations/${opId}`, headers: as() })).json();
      expect(op).toMatchObject({ kind: 'move-host', status: 'succeeded', step: 'source-removed', outcome: 'Moved to Test Runner.', summary: 'Moved to Test Runner' });
    });
    expect(w.store.listEvents([id], 50).filter((e) => e.event === 'op.step')).toHaveLength(10);
  });
});
