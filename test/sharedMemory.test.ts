import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * Memory is always shared (2026-09-29). OpenClaw gives an agent one memory,
 * reachable from every conversation — a test agent with a marker in MEMORY.md
 * answered it from a separate direct-message session too — so "private to
 * each person" could never be kept. The switch is gone; asking for it is
 * refused with the reason, and agents that were "private" became shared once.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const as = { 'x-hatchabot-owner': OWNER };

async function world(state = 'RUNNING') {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const { runtimeRef } = await provider.provision({
    agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } }, env: {},
  } as any);
  await provider.start(runtimeRef);
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: state as any, aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  store.insertMembership({ id: 'm1', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active' });
  const f = Fastify();
  await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  return { store, provider, f };
}

const patch = (f: any, body: unknown) => f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: as, payload: body });

describe('memory is always shared', () => {
  it('refuses a request to make an agent private, saying why, and changes nothing', async () => {
    const { store, provider, f } = await world();
    const before = provider.execLog.length;
    const res = await patch(f, { sharedMemory: false });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/always shared/);
    expect(store.getAgent('a1')!.sharedMemory).toBe(true);
    expect(provider.execLog.length).toBe(before);
  });

  it('a new agent is shared even when a client still asks for private', async () => {
    const { store, f } = await world();
    const res = await f.inject({ method: 'POST', url: '/v1/agents', headers: as, payload: { name: 'Den', aiProfileId: 'p1', hostId: 'h1', sharedMemory: false, telegram: false } });
    expect(res.statusCode).toBeLessThan(300);
    expect(store.getAgent(res.json().id)!.sharedMemory).toBe(true);
  });

  it('agents that were "private" become shared once on upgrade; the Hatchabot agent keeps its own', async () => {
    const db = new Database(':memory:');
    const s1 = new Store(db);
    s1.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    s1.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    s1.insertAgent({ id: 'b1', ownerId: OWNER, name: 'Condo', slug: 'condo', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
    s1.insertAgent({ id: 'b2', ownerId: OWNER, name: 'Hatchabot', slug: 'hatchabot', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, ops: true, createdAt: 'now', updatedAt: 'now' } as any);
    db.exec(`DELETE FROM store_migrations WHERE name = '2026-09-29-memory-always-shared'`);
    const s2 = new Store(db);
    expect(s2.getAgent('b1')!.sharedMemory).toBe(true);
    expect(s2.getAgent('b2')!.sharedMemory).toBe(false);
  });
});
