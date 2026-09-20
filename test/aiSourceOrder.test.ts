import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import type { AIProfile } from '../src/domain/types.js';

/**
 * The order of AI sources is what every list of them shows — the create form,
 * an agent's AI tab, a class. A local model that is seldom the right answer
 * belongs at the bottom; the default belongs at the top.
 */
class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const H = { 'x-hatchabot-owner': OWNER };

function profile(p: Partial<AIProfile> & { id: string }): AIProfile {
  return {
    ownerId: OWNER, name: p.id, vendor: 'anthropic', kind: 'api_key',
    model: 'claude-sonnet-5', secretRef: `ai/${p.id}`, createdAt: new Date().toISOString(),
    ...p,
  } as AIProfile;
}

function world() {
  const store = new Store(new Database(':memory:'));
  ['claude', 'qwen', 'spare'].forEach((id, i) =>
    store.insertAIProfile(profile({ id, name: id, vendor: id === 'qwen' ? 'local' : 'anthropic',
      createdAt: `2026-09-0${i + 1}T00:00:00Z` })));
  return store;
}
const order = (store: Store) => store.listAIProfiles(OWNER).map((p) => p.id);

describe('ordering AI sources', () => {
  it('lists them as they were made until someone moves one', () => {
    expect(order(world())).toEqual(['claude', 'qwen', 'spare']);
  });

  it('down moves a source past the next one, and up brings it back', () => {
    const store = world();
    expect(store.moveAIProfile(OWNER, 'qwen', 'down')).toBe(true);
    expect(order(store)).toEqual(['claude', 'spare', 'qwen']);
    expect(store.moveAIProfile(OWNER, 'qwen', 'up')).toBe(true);
    expect(order(store)).toEqual(['claude', 'qwen', 'spare']);
  });

  it('refuses to move past either end, leaving the order alone', () => {
    const store = world();
    expect(store.moveAIProfile(OWNER, 'claude', 'up')).toBe(false);
    expect(store.moveAIProfile(OWNER, 'spare', 'down')).toBe(false);
    expect(order(store)).toEqual(['claude', 'qwen', 'spare']);
  });

  it('making a source the default lifts it to the top', () => {
    const store = world();
    store.setAIProfileDefault('spare');
    expect(order(store)).toEqual(['spare', 'claude', 'qwen']);
    // and it stays there when another source is added
    store.insertAIProfile(profile({ id: 'later', createdAt: '2026-09-09T00:00:00Z' }));
    expect(order(store)).toEqual(['spare', 'claude', 'qwen', 'later']);
  });

  it('a new source lands at the bottom, not wherever its id sorts', () => {
    const store = world();
    store.insertAIProfile(profile({ id: 'aaa', createdAt: '2026-09-09T00:00:00Z' }));
    expect(order(store)).toEqual(['claude', 'qwen', 'spare', 'aaa']);
  });

  it("a shared source belonging to someone else can be moved PAST but not moved", async () => {
    const store = world();
    store.insertAIProfile(profile({ id: 'theirs', ownerId: 'other', shared: true, createdAt: '2026-09-09T00:00:00Z' }));
    expect(order(store)).toEqual(['claude', 'qwen', 'spare', 'theirs']);
    expect(store.moveAIProfile(OWNER, 'spare', 'down')).toBe(true); // past it
    expect(order(store)).toEqual(['claude', 'qwen', 'theirs', 'spare']);

    const f = Fastify();
    await registerRoutes(f, {
      store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]),
      channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
    });
    const r = await f.inject({ method: 'POST', url: '/v1/ai-profiles/theirs/move', headers: H, payload: { dir: 'up' } });
    expect(r.statusCode).toBe(404); // not yours to reorder
  });

  it('the route moves it and reports the resulting order', async () => {
    const store = world();
    const f = Fastify();
    await registerRoutes(f, {
      store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]),
      channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
    });
    const r = await f.inject({ method: 'POST', url: '/v1/ai-profiles/qwen/move', headers: H, payload: { dir: 'down' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ moved: true, profiles: ['claude', 'spare', 'qwen'] });
    const bad = await f.inject({ method: 'POST', url: '/v1/ai-profiles/qwen/move', headers: H, payload: { dir: 'sideways' } });
    expect(bad.statusCode).toBe(400);
  });
});
