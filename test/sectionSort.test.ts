import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import type { Agent } from '../src/domain/types.js';

/**
 * Sorting a group is sticky: press A→Z or ⏳ once and the section keeps that
 * order as agents arrive, instead of the newcomer landing on top and the
 * order quietly decaying. Dragging one by hand ends it.
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

  it('A→Z is case-insensitive and numeric-aware', () => {
    const s = world();
    s.insertAgent(agent('d', 'agent 10', '2026-04-01T00:00:00Z'));
    s.insertAgent(agent('e', 'agent 2', '2026-05-01T00:00:00Z'));
    s.sortSection(OWNER, null, 'name');
    expect(order(s)).toEqual(['agent 2', 'agent 10', 'alpha', 'Bravo', 'Charlie']);
  });

  it('⏳ is newest first', () => {
    const s = world();
    s.sortSection(OWNER, null, 'time');
    expect(order(s)).toEqual(['Bravo', 'alpha', 'Charlie']);
  });

  it('a sticky section re-sorts itself when an agent is added', () => {
    const s = world();
    s.setSectionSort(OWNER, null, 'name');
    s.sortSection(OWNER, null, 'name');
    expect(order(s)).toEqual(['alpha', 'Bravo', 'Charlie']);
    s.insertAgent(agent('d', 'Bandit', '2026-04-01T00:00:00Z'));
    expect(order(s)).toEqual(['alpha', 'Bandit', 'Bravo', 'Charlie']); // not on top
  });

  it('and when an agent is moved into it', () => {
    const s = world();
    s.insertAgent(agent('d', 'Aardvark', '2026-04-01T00:00:00Z', 'Home'));
    s.setSectionSort(OWNER, null, 'name');
    s.sortSection(OWNER, null, 'name');
    s.setAgentGroup('d', null);
    expect(order(s)).toEqual(['Aardvark', 'alpha', 'Bravo', 'Charlie']);
  });

  it('a section without a sticky sort is left alone', () => {
    const s = world();
    s.sortSection(OWNER, null, 'name'); // a one-off sort, not sticky
    s.insertAgent(agent('d', 'Bandit', '2026-04-01T00:00:00Z'));
    expect(order(s)[0]).toBe('Bandit'); // newcomer still lands on top
  });

  it('dragging an agent by hand ends the stickiness', () => {
    const s = world();
    s.setSectionSort(OWNER, null, 'time');
    expect(s.sectionSort(OWNER, null)).toBe('time');
    s.moveAgentBefore('a', 'b'); // put Charlie above alpha by hand
    expect(s.sectionSort(OWNER, null)).toBeNull();
    s.insertAgent(agent('d', 'Bandit', '2026-04-01T00:00:00Z'));
    expect(order(s).indexOf('Charlie')).toBeLessThan(order(s).indexOf('alpha')); // hand order kept
  });

  it('each section keeps its own mode, reported together', () => {
    const s = world();
    s.insertAgent(agent('d', 'Zeta', '2026-04-01T00:00:00Z', 'Home'));
    s.setSectionSort(OWNER, null, 'name');
    s.setSectionSort(OWNER, 'Home', 'time');
    expect(s.sectionSorts(OWNER)).toEqual({ '': 'name', Home: 'time' });
    s.setSectionSort(OWNER, 'Home', null);
    expect(s.sectionSorts(OWNER)).toEqual({ '': 'name' });
  });
});
