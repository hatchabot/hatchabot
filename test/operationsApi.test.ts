/**
 * The operations API (GET /v1/operations, GET /v1/operations/:id, POST
 * /v1/operations/:id/recover) and the on-disk guard: an agent whose long
 * operation was interrupted or is held for a choice refuses Start, Rebuild,
 * Archive, Move, Rehost, Delete, Wake and Retry with the operation's line.
 */
import { describe, expect, it } from 'vitest';
import { MockProvider } from '../src/providers/mockProvider.js';
import { beginOperation } from '../src/orchestrator/operations.js';
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

  it('a move through the route returns its operation id, and the record shows every step', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { name: 'Test Agent' });
    w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock2', name: 'Test Runner', settings: {}, createdAt: 'now' });
    w.providers.set('mock2', new MockProvider());
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host`, headers: as(), payload: { hostId: 'h2' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().operation).toMatch(/^op_/);
    const op = (await w.f.inject({ method: 'GET', url: `/v1/operations/${r.json().operation}`, headers: as() })).json();
    expect(op).toMatchObject({ kind: 'move-host', status: 'succeeded', step: 'source-removed', outcome: 'Moved to Test Runner.' });
    expect(w.store.listEvents([id], 50).filter((e) => e.event === 'op.step')).toHaveLength(10);
  });
});
