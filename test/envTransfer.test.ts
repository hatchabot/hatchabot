/**
 * What an agent may hold must be what its own full export can carry back in:
 * a long AI-source model id (#162), more variables than an import read (#141),
 * and a value Docker cannot be given (#142).
 */
import { describe, expect, it } from 'vitest';
import { makeWorld, seedRunningAgent, as } from './support/world.js';
import { MAX_AGENT_ENV_VARS } from '../src/orchestrator/envPolicy.js';

const octet = (owner?: string) => ({ ...as(owner), 'content-type': 'application/octet-stream' });
const addEnv = (w: Awaited<ReturnType<typeof makeWorld>>, name: string, value: string) =>
  w.f.inject({ method: 'POST', url: '/v1/agents/a1/env', headers: as(), payload: { name, value } });

describe('a full export imports again', () => {
  it('when its AI source names a model longer than 64 characters (#162)', async () => {
    const src = await makeWorld();
    await seedRunningAgent(src);
    const long = `local-lab/recipe-helper-${'q'.repeat(60)}-instruct`;
    src.store.setAIProfileModel('p1', long);
    src.store.setAIProfileModels('p1', [long, 'claude-opus-4-8']);
    const file = (await src.f.inject({ method: 'GET', url: '/v1/agents/a1/backup', headers: as() })).rawPayload;
    const dst = await makeWorld('owner-b');
    const res = await dst.f.inject({ method: 'POST', url: '/v1/agents/restore', headers: octet('owner-b'), payload: file });
    expect(res.statusCode, res.body).toBe(201);
  });

  it('when it was held on an AI source model longer than 64 characters (HB-0321)', async () => {
    const src = await makeWorld();
    await seedRunningAgent(src);
    const long = `local-lab/recipe-helper-${'q'.repeat(60)}-instruct`;
    src.store.setAIProfileModel('p1', long);
    const hold = await src.f.inject({ method: 'POST', url: '/v1/ai-profiles/p1/apply-default-model', headers: as(), payload: { model: 'claude-opus-4-8', apply: [] } });
    expect(hold.statusCode, hold.body).toBe(200);
    expect(src.store.getAgent('a1')!.model).toBe(long);
    const file = (await src.f.inject({ method: 'GET', url: '/v1/agents/a1/backup', headers: as() })).rawPayload;
    // Where the source offers that model, the agent comes back on it.
    const dst = await makeWorld('owner-b');
    dst.store.setAIProfileModels('p1', [long]);
    const res = await dst.f.inject({ method: 'POST', url: '/v1/agents/restore', headers: octet('owner-b'), payload: file });
    expect(res.statusCode, res.body).toBe(201);
    expect(dst.store.getAgent(res.json().id)!.model).toBe(long);
    // Where it does not, the agent comes back on that source's default.
    const other = await makeWorld('owner-c');
    const res2 = await other.f.inject({ method: 'POST', url: '/v1/agents/restore', headers: octet('owner-c'), payload: file });
    expect(res2.statusCode, res2.body).toBe(201);
    expect(other.store.getAgent(res2.json().id)!.model).toBeUndefined();
  });

  it('when it has as many variables as it may have, and the next one is refused (#141)', async () => {
    const src = await makeWorld();
    await seedRunningAgent(src);
    for (let i = 0; i < MAX_AGENT_ENV_VARS; i++) expect((await addEnv(src, `PANTRY_${i}`, `shelf-${i}`)).statusCode).toBe(200);
    const over = await addEnv(src, 'PANTRY_EXTRA', 'one-too-many');
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toMatch(/at most 64 variables/);
    // An agent that went past the limit before it existed still moves.
    for (let i = 0; i < 6; i++) {
      await src.secrets.put(`agent-env/legacy-${i}`, `old-${i}`);
      src.store.insertAgentEnv({ id: `legacy-${i}`, agentId: 'a1', name: `LEGACY_${i}`, secretRef: `agent-env/legacy-${i}`, createdAt: 'now' });
    }
    const file = (await src.f.inject({ method: 'GET', url: '/v1/agents/a1/backup', headers: as() })).rawPayload;
    const dst = await makeWorld('owner-b');
    const res = await dst.f.inject({ method: 'POST', url: '/v1/agents/restore', headers: octet('owner-b'), payload: file });
    expect(res.statusCode, res.body).toBe(201);
    expect(dst.store.listAgentEnv(res.json().id)).toHaveLength(MAX_AGENT_ENV_VARS + 6);
  });
});

describe('two variables added at once stay within the limit (HB-0285)', () => {
  it('the second to finish is refused, and its value leaves the secret store', async () => {
    const src = await makeWorld();
    await seedRunningAgent(src);
    for (let i = 0; i < MAX_AGENT_ENV_VARS - 1; i++) expect((await addEnv(src, `PANTRY_${i}`, `shelf-${i}`)).statusCode).toBe(200);
    // Both requests pass the first count, then wait in the secret store together.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let waiting = 0;
    let bothIn!: () => void;
    const both = new Promise<void>((r) => { bothIn = r; });
    const put = src.secrets.put.bind(src.secrets);
    src.secrets.put = async (ref: string, v: string) => { if (++waiting === 2) bothIn(); await gate; await put(ref, v); };
    const reqs = [addEnv(src, 'SPICE_A', 'cumin'), addEnv(src, 'SPICE_B', 'paprika')];
    await both;
    release();
    const codes = (await Promise.all(reqs)).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    expect(src.store.listAgentEnv('a1')).toHaveLength(MAX_AGENT_ENV_VARS);
    expect([...src.secrets.map.keys()].filter((k) => k.startsWith('agent-env/'))).toHaveLength(MAX_AGENT_ENV_VARS);
  });

  it('the same name twice: one is kept', async () => {
    const src = await makeWorld();
    await seedRunningAgent(src);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let waiting = 0;
    let bothIn!: () => void;
    const both = new Promise<void>((r) => { bothIn = r; });
    const put = src.secrets.put.bind(src.secrets);
    src.secrets.put = async (ref: string, v: string) => { if (++waiting === 2) bothIn(); await gate; await put(ref, v); };
    const reqs = [addEnv(src, 'SPICE', 'cumin'), addEnv(src, 'SPICE', 'paprika')];
    await both;
    release();
    const res = await Promise.all(reqs);
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(res.find((r) => r.statusCode === 409)!.json().error).toMatch(/already set/);
    expect(src.store.listAgentEnv('a1')).toHaveLength(1);
  });
});

describe('a NUL in a variable is refused, not stored to break the next build (#142)', () => {
  it('when set, and when an archive carries one', async () => {
    const src = await makeWorld();
    await seedRunningAgent(src);
    const bad = await addEnv(src, 'GROCERY_NOTE', 'eggs\0milk');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/NUL/);
    expect(src.store.listAgentEnv('a1')).toEqual([]);

    // One stored before this release: its archive is refused with the reason, nothing made.
    await src.secrets.put('agent-env/old', 'eggs\0milk');
    src.store.insertAgentEnv({ id: 'old', agentId: 'a1', name: 'GROCERY_NOTE', secretRef: 'agent-env/old', createdAt: 'now' });
    const file = (await src.f.inject({ method: 'GET', url: '/v1/agents/a1/backup', headers: as() })).rawPayload;
    const dst = await makeWorld('owner-b');
    const res = await dst.f.inject({ method: 'POST', url: '/v1/agents/restore', headers: octet('owner-b'), payload: file });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/GROCERY_NOTE.*NUL/);
    expect(dst.store.listAllActiveAgents()).toEqual([]);
  });
});
