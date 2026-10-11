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
