import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { agentUsage } from '../src/orchestrator/usage.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const as = { 'x-agentclaw-owner': OWNER };

const SESSIONS_JSON = JSON.stringify({
  sessions: [
    { totalTokens: 1000, model: 'claude-opus-4-8', updatedAt: 2000 },
    { totalTokens: 500, model: 'claude-opus-4-8', updatedAt: 3000 },
    { totalTokens: 250, model: 'claude-sonnet-5', updatedAt: 1000 },
  ],
});

async function seedRuntime(p: MockProvider, slug = 'kitchen', agentId = 'a1') {
  const { runtimeRef } = await p.provision({
    agentId, slug, workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } }, env: {},
  } as any);
  return runtimeRef;
}

describe('agentUsage aggregation', () => {
  it('sums totalTokens, groups by model (desc), counts sessions, tracks last active', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.execResponses.set('sessions list', { code: 0, stdout: SESSIONS_JSON, stderr: '' });
    const u = await agentUsage(p, ref, 'kitchen');
    expect(u.totalTokens).toBe(1750);
    expect(u.sessions).toBe(3);
    expect(u.lastActive).toBe(new Date(3000).toISOString());
    expect(u.byModel).toEqual([
      { model: 'claude-opus-4-8', tokens: 1500, sessions: 2 },
      { model: 'claude-sonnet-5', tokens: 250, sessions: 1 },
    ]);
    expect(p.execLog).toContainEqual(['sessions', 'list', '--agent', 'kitchen', '--json']);
  });

  it('returns an empty usage on a nonzero exit or bad json', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.execResponses.set('sessions list', { code: 1, stdout: '', stderr: 'down' });
    expect(await agentUsage(p, ref, 'kitchen')).toEqual({ totalTokens: 0, sessions: 0, byModel: [] });
    p.execResponses.set('sessions list', { code: 0, stdout: 'not json', stderr: '' });
    expect(await agentUsage(p, ref, 'kitchen')).toEqual({ totalTokens: 0, sessions: 0, byModel: [] });
  });
});

async function world(state = 'RUNNING') {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const runtimeRef = await seedRuntime(provider);
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: state as any, aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  const f = Fastify();
  await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  return { store, provider, f };
}

describe('GET /v1/agents/:id/usage', () => {
  it('returns aggregated usage for a RUNNING agent', async () => {
    const { provider, f } = await world();
    provider.execResponses.set('sessions list', { code: 0, stdout: SESSIONS_JSON, stderr: '' });
    const res = await f.inject({ method: 'GET', url: '/v1/agents/a1/usage', headers: as });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ totalTokens: 1750, sessions: 3 });
  });

  it('409s when the agent is not RUNNING', async () => {
    const { f } = await world('STOPPED');
    const res = await f.inject({ method: 'GET', url: '/v1/agents/a1/usage', headers: as });
    expect(res.statusCode).toBe(409);
  });

  it('404s for an agent the caller does not own', async () => {
    const { f } = await world();
    const res = await f.inject({ method: 'GET', url: '/v1/agents/a1/usage', headers: { 'x-agentclaw-owner': 'someone-else' } });
    expect(res.statusCode).toBe(404);
  });
});
