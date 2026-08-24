/**
 * End-to-end coverage of runner-host registration (Cluster mode): adding a
 * remote Docker endpoint as a host, and removing it. The endpoint used here
 * (tcp://127.0.0.1:1) refuses fast, so the best-effort reachability ping returns
 * quickly with reachable:false without stalling the test.
 */
import { describe, expect, it } from 'vitest';
import { makeWorld, seedRunningAgent, as } from './support/world.js';

const RUNNER = 'tcp://127.0.0.1:1';

describe('Runner hosts — POST /v1/hosts', () => {
  it('registers a runner and lists it (host owner)', async () => {
    const w = await makeWorld();
    const res = await w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as(), payload: { name: 'Runner 1', dockerHost: RUNNER } });
    expect(res.statusCode).toBe(201);
    const host = res.json();
    expect(host).toMatchObject({ kind: 'cloud', provider: 'remote-docker', name: 'Runner 1' });
    expect(host.settings.dockerHost).toBe(RUNNER);
    // best-effort ping ran and reported the endpoint unreachable — but it saved
    expect(host.reachable).toBe(false);

    const list = (await w.f.inject({ method: 'GET', url: '/v1/hosts', headers: as() })).json();
    expect(list.some((h: any) => h.id === host.id)).toBe(true);
  });

  it('refuses a non-host-owner (403) and a bad endpoint scheme (400)', async () => {
    const w = await makeWorld();
    expect((await w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as('intruder'), payload: { name: 'x', dockerHost: RUNNER } })).statusCode).toBe(403);
    expect((await w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as(), payload: { name: 'x', dockerHost: 'http://nope' } })).statusCode).toBe(400);
  });
});

describe('Runner hosts — DELETE /v1/hosts/:id', () => {
  it('removes an empty runner but protects the local host and non-empty runners', async () => {
    const w = await makeWorld();
    const runner = (await w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as(), payload: { name: 'R', dockerHost: RUNNER } })).json();

    // the local host can't be deleted
    expect((await w.f.inject({ method: 'DELETE', url: '/v1/hosts/h1', headers: as() })).statusCode).toBe(400);

    // a runner with an agent on it is refused
    w.store.insertAgent({ id: 'a1', ownerId: w.owner, name: 'A', slug: 'a', state: 'RUNNING', aiProfileId: 'p1', hostId: runner.id, persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    const busy = await w.f.inject({ method: 'DELETE', url: `/v1/hosts/${runner.id}`, headers: as() });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toMatch(/still run/);

    // once empty, it deletes
    w.store.setAgentState('a1', 'STOPPED');
    w.store.setAgentState('a1', 'DELETING');
    w.store.setAgentState('a1', 'DELETED');
    const gone = await w.f.inject({ method: 'DELETE', url: `/v1/hosts/${runner.id}`, headers: as() });
    expect(gone.statusCode).toBe(200);
    expect(w.store.getHost(runner.id)).toBeUndefined();
  });

  it('is refused to a non-host-owner (403)', async () => {
    const w = await makeWorld();
    const runner = (await w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as(), payload: { name: 'R', dockerHost: RUNNER } })).json();
    expect((await w.f.inject({ method: 'DELETE', url: `/v1/hosts/${runner.id}`, headers: as('intruder') })).statusCode).toBe(403);
  });
});

describe('Drain — POST /v1/hosts/:id/drain', () => {
  it('stops every running agent on a host', async () => {
    const w = await makeWorld(); // h1 uses the mock provider
    await seedRunningAgent(w, { id: 'a1', slug: 'one', accountId: 'onebot' });
    await seedRunningAgent(w, { id: 'a2', slug: 'two', accountId: 'twobot' });
    const res = await w.f.inject({ method: 'POST', url: '/v1/hosts/h1/drain', headers: as(), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stopped: 2, skipped: [] });
    expect(w.store.getAgent('a1')!.state).toBe('STOPPED');
    expect(w.store.getAgent('a2')!.state).toBe('STOPPED');
  });

  it('is refused to a non-host-owner (403)', async () => {
    const w = await makeWorld();
    expect((await w.f.inject({ method: 'POST', url: '/v1/hosts/h1/drain', headers: as('intruder'), payload: {} })).statusCode).toBe(403);
  });
});
