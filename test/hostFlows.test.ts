/**
 * End-to-end coverage of runner-host registration (Cluster mode): adding a
 * remote Docker endpoint as a host, and removing it. The endpoint used here
 * (tcp://127.0.0.1:1) refuses fast, so the best-effort reachability ping returns
 * quickly with reachable:false without stalling the test.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeWorld, seedRunningAgent, as } from './support/world.js';

const RUNNER = 'tcp://127.0.0.1:1';

// POST /v1/hosts now prepares the runner SSH key/config — keep that away from
// the real ~/.ssh of whoever runs the tests.
beforeAll(() => {
  process.env.AGENTCLAW_SSH_DIR = mkdtempSync(join(tmpdir(), 'acl-hostflows-ssh-'));
});

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

describe('Ping — GET /v1/hosts/:id/ping', () => {
  it('returns the UI shape {reachable, serverVersion, error}, not pingRunner raw {ok, version}', async () => {
    const w = await makeWorld();
    const runner = (await w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as(), payload: { name: 'R', dockerHost: RUNNER } })).json();

    const res = await w.f.inject({ method: 'GET', url: `/v1/hosts/${runner.id}/ping`, headers: as() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The UI reads `reachable`; the raw pingRunner `ok` field would render every
    // probe — success included — as "unreachable — no response". Regression guard.
    expect(body).toHaveProperty('reachable');
    expect(body.ok).toBeUndefined();
    expect(body.reachable).toBe(false); // tcp://127.0.0.1:1 refuses fast

    // The local host answers with the sentinel the UI expects.
    const local = (await w.f.inject({ method: 'GET', url: '/v1/hosts/h1/ping', headers: as() })).json();
    expect(local).toMatchObject({ reachable: true, serverVersion: 'local' });
  });
});

describe('Create — Claude Max on a runner', () => {
  it('refuses a machine-login subscription but allows a setup-token one', async () => {
    const w = await makeWorld();
    const runner = (await w.f.inject({ method: 'POST', url: '/v1/hosts', headers: as(), payload: { name: 'R', dockerHost: RUNNER } })).json();

    // Machine-login subscription (no secretRef) mounts THIS box's ~/.claude,
    // which a remote runner can't see — refused up front, not at provision.
    w.store.insertAIProfile({ id: 'sub-ml', ownerId: w.owner, name: 'Max (login)', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', secretRef: undefined, createdAt: 'now' });
    const ml = await w.f.inject({ method: 'POST', url: '/v1/agents', headers: as(), payload: { name: 'ml', aiProfileId: 'sub-ml', hostId: runner.id } });
    expect(ml.statusCode).toBe(400);
    expect(ml.json().error).toMatch(/setup-token/);

    // Setup-token subscription (secretRef present) is injected as data — it
    // rides to any host, so Claude Max is allowed on the runner.
    w.store.insertAIProfile({ id: 'sub-tok', ownerId: w.owner, name: 'Max (token)', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', secretRef: 'ai/tok', createdAt: 'now' });
    const tok = await w.f.inject({ method: 'POST', url: '/v1/agents', headers: as(), payload: { name: 'tok', aiProfileId: 'sub-tok', hostId: runner.id } });
    expect(tok.statusCode).toBe(202);
  });
});

describe('Move — POST /v1/agents/:id/move-host', () => {
  // A second mock-backed host so the move stays on the MockProvider (a real
  // remote-docker host would make the route dial an actual daemon). Same
  // provider instance on both sides = the same-daemon path: no source retire.
  const addMockHost = (w: Awaited<ReturnType<typeof makeWorld>>) =>
    w.store.insertHost({
      id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock', name: 'Runner Two',
      settings: {}, createdAt: 'now',
    });

  it('moves an agent to another host and back', async () => {
    const w = await makeWorld();
    addMockHost(w);
    const id = await seedRunningAgent(w);

    const res = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host`, headers: as(), payload: { hostId: 'h2' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hostId: 'h2', state: 'RUNNING' });

    const back = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host`, headers: as(), payload: { hostId: 'h1' } });
    expect(back.statusCode).toBe(200);
    expect(w.store.getAgent(id)!.hostId).toBe('h1');
  });

  it('refuses the current host, an unknown host, and a non-owner', async () => {
    const w = await makeWorld();
    addMockHost(w);
    const id = await seedRunningAgent(w);
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host`, headers: as(), payload: { hostId: 'h1' } })).statusCode).toBe(400);
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host`, headers: as(), payload: { hostId: 'nope' } })).statusCode).toBe(400);
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host`, headers: as('intruder'), payload: { hostId: 'h2' } })).statusCode).toBe(404);
  });

  it('refuses a machine-login Max agent onto a non-local host; allows setup-token', async () => {
    const w = await makeWorld();
    addMockHost(w);
    const id = await seedRunningAgent(w);

    w.store.insertAIProfile({ id: 'sub-ml', ownerId: w.owner, name: 'Max login', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', secretRef: undefined, createdAt: 'now' });
    (w.store as any).db.prepare(`UPDATE agents SET ai_profile_id = 'sub-ml' WHERE id = ?`).run(id);
    const ml = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host`, headers: as(), payload: { hostId: 'h2' } });
    expect(ml.statusCode).toBe(400);
    expect(ml.json().error).toMatch(/setup-token/);

    w.store.insertAIProfile({ id: 'sub-tok', ownerId: w.owner, name: 'Max token', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', secretRef: 'ai/tok', createdAt: 'now' });
    await w.secrets.put('ai/tok', 'sk-tok');
    (w.store as any).db.prepare(`UPDATE agents SET ai_profile_id = 'sub-tok' WHERE id = ?`).run(id);
    const tok = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host`, headers: as(), payload: { hostId: 'h2' } });
    expect(tok.statusCode).toBe(200);
    expect(tok.json().hostId).toBe('h2');
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
