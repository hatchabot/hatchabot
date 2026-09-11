import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

const OWNER = 'user-o';
const H = { 'x-agentclaw-owner': OWNER };

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', models: ['claude-sonnet-5', 'claude-fable-5'], secretRef: 'ai/p1', createdAt: 'now' });
  const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } as any }, env: {} });
  await provider.start(runtimeRef);
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
  const f = Fastify();
  await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  return { store, provider, f };
}

describe('agent classes', () => {
  it('creates a class and assigning it applies the class model live (no rebuild)', async () => {
    const { store, provider, f } = await world();
    const created = await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'Light', model: 'claude-sonnet-5' } });
    expect(created.statusCode).toBe(200);
    const classId = created.json().class.id;

    const assign = await f.inject({ method: 'POST', url: '/v1/agents/a1/class', headers: H, payload: { classId } });
    expect(assign.statusCode).toBe(200);
    expect(assign.json()).toMatchObject({ classId, rebuild: false });
    // wrote the override + live-applied via `models set`, no rebuild
    expect(store.getAgent('a1')!.model).toBe('claude-sonnet-5');
    expect(store.getAgent('a1')!.classId).toBe(classId);
    expect(provider.execLog.some((c) => Array.isArray(c) && c[0] === 'models' && c[1] === 'set')).toBe(true);
  });

  it('editing a class re-applies its model to member agents', async () => {
    const { store, f } = await world();
    const classId = (await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'Tier', model: 'claude-sonnet-5' } })).json().class.id;
    await f.inject({ method: 'POST', url: '/v1/agents/a1/class', headers: H, payload: { classId } });
    const edit = await f.inject({ method: 'PUT', url: `/v1/agent-classes/${classId}`, headers: H, payload: { model: 'claude-fable-5' } });
    expect(edit.statusCode).toBe(200);
    expect(edit.json()).toMatchObject({ applied: 1 });
    expect(store.getAgent('a1')!.model).toBe('claude-fable-5'); // propagated
  });

  it('deleting a class clears the tag but leaves the agent model as-is', async () => {
    const { store, f } = await world();
    const classId = (await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'X', model: 'claude-sonnet-5' } })).json().class.id;
    await f.inject({ method: 'POST', url: '/v1/agents/a1/class', headers: H, payload: { classId } });
    await f.inject({ method: 'DELETE', url: `/v1/agent-classes/${classId}`, headers: H });
    expect(store.getAgent('a1')!.classId).toBeUndefined();
    expect(store.getAgent('a1')!.model).toBe('claude-sonnet-5'); // kept
    expect(store.listAgentClasses(OWNER)).toHaveLength(0);
  });

  it('rejects a class model the agent’s source cannot run', async () => {
    const { f } = await world();
    // local source can't take an anthropic model override
    const classId = (await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'Bad', model: 'not-a-real-model' } })).json().class.id;
    const assign = await f.inject({ method: 'POST', url: '/v1/agents/a1/class', headers: H, payload: { classId } });
    expect(assign.statusCode).toBe(400); // modelOverrideProblem: not on this source's menu
  });
});
