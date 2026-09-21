import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import type { Agent } from '../src/domain/types.js';

/**
 * Sorting a group is a one-shot: it writes the order and stops, so an agent
 * you dragged somewhere stays there. Pressing the same button again reverses
 * it, the way a table column does.
 */
const OWNER = 'user-owner';
function agent(id: string, name: string, createdAt: string, group: string | null = null): Agent {
  return {
    id, ownerId: OWNER, name, slug: id, group: group ?? undefined, state: 'RUNNING',
    aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false,
    createdAt, updatedAt: createdAt,
  } as unknown as Agent;
}
const order = (s: Store, g: string | null = null) =>
  s.listAgents(OWNER).filter((a) => (a.group ?? null) === g).map((a) => a.name);

function world() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent(agent('a', 'Charlie', '2026-01-01T00:00:00Z'));
  store.insertAgent(agent('b', 'alpha', '2026-02-01T00:00:00Z'));
  store.insertAgent(agent('c', 'Bravo', '2026-03-01T00:00:00Z'));
  return store;
}

describe('sorting a section', () => {
  it('a new agent lands on top until a sort is asked for', () => {
    expect(order(world())).toEqual(['Bravo', 'alpha', 'Charlie']); // newest first, by insert
  });

  it('A→Z is case-insensitive and numeric-aware, and reverses on the second press', () => {
    const s = world();
    s.insertAgent(agent('d', 'agent 10', '2026-04-01T00:00:00Z'));
    s.insertAgent(agent('e', 'agent 2', '2026-05-01T00:00:00Z'));
    s.sortSection(OWNER, null, 'name');
    expect(order(s)).toEqual(['agent 2', 'agent 10', 'alpha', 'Bravo', 'Charlie']);
    s.sortSection(OWNER, null, 'name', true);
    expect(order(s)).toEqual(['Charlie', 'Bravo', 'alpha', 'agent 10', 'agent 2']);
  });

  it('⏳ is earliest first, and latest first reversed', () => {
    const s = world();
    s.sortSection(OWNER, null, 'time');
    expect(order(s)).toEqual(['Charlie', 'alpha', 'Bravo']); // made Jan, Feb, Mar
    s.sortSection(OWNER, null, 'time', true);
    expect(order(s)).toEqual(['Bravo', 'alpha', 'Charlie']);
  });

  it('sorting one section leaves the others alone', () => {
    const s = world();
    s.insertAgent(agent('d', 'Zeta', '2026-04-01T00:00:00Z', 'Home'));
    s.insertAgent(agent('e', 'Alpha House', '2026-05-01T00:00:00Z', 'Home'));
    s.sortSection(OWNER, null, 'name');
    expect(order(s, 'Home')).toEqual(['Alpha House', 'Zeta']); // untouched insert order
    expect(order(s)).toEqual(['alpha', 'Bravo', 'Charlie']);
  });

  it('nothing is remembered: a later agent still lands on top', () => {
    const s = world();
    s.sortSection(OWNER, null, 'name');
    s.insertAgent(agent('d', 'Bandit', '2026-04-01T00:00:00Z'));
    expect(order(s)[0]).toBe('Bandit');
  });

  it('a hand-dragged agent stays where it was put', () => {
    const s = world();
    s.moveAgentBefore('a', 'b'); // Charlie above alpha, by hand
    const after = order(s);
    expect(after.indexOf('Charlie')).toBeLessThan(after.indexOf('alpha'));
  });
});

describe('the sort route', () => {
  async function api() {
    const Fastify = (await import('fastify')).default;
    const { registerRoutes } = await import('../src/api/routes.js');
    const { MockProvider } = await import('../src/providers/mockProvider.js');
    const s = world();
    const f = Fastify();
    await registerRoutes(f, {
      store: s, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} } as never,
      providers: new Map([['mock', new MockProvider()]]),
      channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never,
    } as never);
    const post = (payload: object) => f.inject({ method: 'POST', url: '/v1/groups/sort', headers: { 'x-hatchabot-owner': OWNER }, payload: payload as never });
    return { s, post };
  }

  it('sorts and reports what it did', async () => {
    const { s, post } = await api();
    const r = await post({ group: '', mode: 'name' });
    expect(r.json()).toMatchObject({ ok: true, sorted: 3, mode: 'name', desc: false });
    expect(order(s)).toEqual(['alpha', 'Bravo', 'Charlie']);
  });

  it('desc reverses, and an omitted mode still means A→Z', async () => {
    const { s, post } = await api();
    await post({ group: '', desc: true });
    expect(order(s)).toEqual(['Charlie', 'Bravo', 'alpha']);
  });

  it('all: true covers every section', async () => {
    const { s, post } = await api();
    s.insertAgent(agent('d', 'Zeta', '2026-04-01T00:00:00Z', 'Home'));
    s.insertAgent(agent('e', 'Alpha House', '2026-05-01T00:00:00Z', 'Home'));
    await post({ all: true, mode: 'name' });
    expect(order(s, 'Home')).toEqual(['Alpha House', 'Zeta']);
    expect(order(s)).toEqual(['alpha', 'Bravo', 'Charlie']);
  });

  it('a bad mode is refused', async () => {
    const { post } = await api();
    expect((await post({ group: '', mode: 'sideways' })).statusCode).toBe(400);
  });
});
