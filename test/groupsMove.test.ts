import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const as = { 'x-agentclaw-owner': OWNER };

async function world() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const add = (id: string, group: string) => store.insertAgent({
    id, ownerId: OWNER, name: id, slug: id, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
    persona: '', sharedMemory: false, group, createdAt: 'now', updatedAt: 'now',
  } as any);
  add('alpha1', 'Alpha');
  add('fin1', 'Finance');
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
  });
  return { store, f };
}

describe('POST /v1/groups/move', () => {
  it('reorders a section and 400s on a bad request', async () => {
    const { store, f } = await world();
    const res = await f.inject({ method: 'POST', url: '/v1/groups/move', headers: as, payload: { group: 'Finance', dir: 'up' } });
    expect(res.statusCode).toBe(200);
    expect(store.listAgents(OWNER).map((a) => a.id)).toEqual(['fin1', 'alpha1']);

    const bad = await f.inject({ method: 'POST', url: '/v1/groups/move', headers: as, payload: { group: 'Finance' } });
    expect(bad.statusCode).toBe(400);
  });
});
