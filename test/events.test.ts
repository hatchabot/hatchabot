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

function world() {
  const store = new Store(new Database(':memory:'));
  store.insertAgent({
    id: 'a1', ownerId: 'o', name: 'A', slug: 'a1', state: 'PROVISIONING',
    aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false,
    createdAt: 'now', updatedAt: 'now',
  });
  return store;
}

describe('agent events', () => {
  it('round-trips a normal detail', () => {
    const store = world();
    store.recordEvent('a1', 'runtime.started', { runtimeRef: 'docker://x' });
    expect(store.listEvents(['a1'])[0]!.detail).toEqual({ runtimeRef: 'docker://x' });
  });

  it('truncates an oversized detail without corrupting the whole timeline', () => {
    const store = world();
    // The real producer of oversized details: provision.failed carrying up to
    // 2000 chars of docker stderr. Truncating the serialized JSON mid-string
    // made listEvents throw on read — the activity feed bricking itself
    // exactly when a long error was worth reading.
    store.recordEvent('a1', 'provision.failed', { error: 'x'.repeat(5000) });
    store.recordEvent('a1', 'runtime.started', { ok: true });
    const events = store.listEvents(['a1']);
    expect(events).toHaveLength(2);
    expect(events[1]!.detail).toMatchObject({ truncated: true });
  });

  it('tolerates a torn row written before truncation kept JSON valid', () => {
    const store = world();
    (store as any).db
      .prepare(`INSERT INTO agent_events (agent_id, at, event, detail) VALUES (?, ?, ?, ?)`)
      .run('a1', 'now', 'old.event', '{"error":"cut off mid-str');
    const events = store.listEvents(['a1']);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({ unparseable: expect.any(String) });
  });
});

const OWNER = 'user-owner';
const as = { 'x-hatchabot-owner': OWNER };

async function routeWorld() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  store.insertAgent({ id: 'a2', ownerId: OWNER, name: 'Garage', slug: 'garage', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  store.recordEvent('a1', 'runtime.started', { ok: true });
  store.recordEvent('a2', 'runtime.rebuilt', {});
  const f = Fastify();
  await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  return { store, f };
}

describe('GET /v1/events', () => {
  it('returns events across all the owner\'s agents, with agentName', async () => {
    const { f } = await routeWorld();
    const res = await f.inject({ method: 'GET', url: '/v1/events', headers: as });
    expect(res.statusCode).toBe(200);
    const evs = res.json();
    expect(evs).toHaveLength(2);
    expect(evs.every((e: any) => e.agentName)).toBe(true);
  });

  it('filters to a single agent with ?agentId=', async () => {
    const { f } = await routeWorld();
    const res = await f.inject({ method: 'GET', url: '/v1/events?agentId=a1', headers: as });
    const evs = res.json();
    expect(evs).toHaveLength(1);
    expect(evs[0].agentId).toBe('a1');
  });

  it('returns empty for an agent the caller cannot see (no cross-owner probing)', async () => {
    const { f } = await routeWorld();
    const res = await f.inject({ method: 'GET', url: '/v1/events?agentId=someone-elses-agent', headers: as });
    expect(res.json()).toEqual([]);
  });
});
