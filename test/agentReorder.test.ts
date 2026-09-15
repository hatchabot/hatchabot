import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

// Faster reordering: drag-and-drop (move before another agent, across sections),
// jump to top/bottom, and A→Z per section or everywhere.

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}
const OWNER = 'user-owner';
const as = { 'x-hatchabot-owner': OWNER };

async function world() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const add = (id: string, name: string, group?: string, owner = OWNER) => store.insertAgent({
    id, ownerId: owner, name, slug: id, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
    persona: '', sharedMemory: false, group, createdAt: 'now', updatedAt: 'now',
  } as any);
  // Finance section in insertion order; names deliberately out of alphabetical order.
  // New agents land at the TOP of their section, so insert in reverse display order.
  for (const [id, name] of [['b', 'Budget'], ['a2', 'Agent 2'], ['s', 'stocks'], ['a10', 'Agent 10'], ['t', 'Tax']] as const) add(id, name, 'Finance');
  add('h', 'Homework'); add('k', 'Kitchen'); // ungrouped: shows k, h
  add('x', 'Theirs', 'Finance', 'user-other');
  const f = Fastify();
  await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  const order = (group: string | null) => store.listAgents(OWNER).filter((a) => (a.group ?? null) === group).map((a) => a.id);
  const move = (id: string, payload: object) => f.inject({ method: "POST", url: `/v1/agents/${id}/move`, headers: as, payload: payload as any });
  return { store, f, order, move };
}

describe('agent reordering', () => {
  it('moves an agent many places in one call (before another agent)', async () => {
    const { order, move } = await world();
    expect(order('Finance')).toEqual(['t', 'a10', 's', 'a2', 'b']);
    expect((await move('b', { before: 't' })).statusCode).toBe(200);
    expect(order('Finance')).toEqual(['b', 't', 'a10', 's', 'a2']);
    await move('b', { before: null }); // end of its own section
    expect(order('Finance')).toEqual(['t', 'a10', 's', 'a2', 'b']);
  });

  it('jumps to the top or bottom of the section', async () => {
    const { order, move } = await world();
    await move('a2', { dir: 'top' });
    expect(order('Finance')[0]).toBe('a2');
    await move('a2', { dir: 'bottom' });
    expect(order('Finance').at(-1)).toBe('a2');
    await move('t', { dir: 'up' }); // existing one-step moves still work
    expect(order('Finance')[0]).toBe('t');
  });

  it('dropping onto an agent in another section moves it into that section', async () => {
    const { store, order, move } = await world();
    const res = await move('k', { before: 'a10' });
    expect(res.json().group).toBe('Finance');
    expect(store.getAgent('k')!.group).toBe('Finance');
    expect(order('Finance')).toEqual(['t', 'k', 'a10', 's', 'a2', 'b']);
    expect(order(null)).toEqual(['h']);
    // end of a named section, and back to ungrouped via group ''
    await move('k', { before: null, group: '' });
    expect(store.getAgent('k')!.group ?? null).toBeNull();
    expect(order(null)).toEqual(['h', 'k']);
  });

  it('sorts a section A→Z (numbers numerically, case-insensitive) and every section at once', async () => {
    const { f, order } = await world();
    const sort = (payload: object) => f.inject({ method: "POST", url: "/v1/groups/sort", headers: as, payload: payload as any });
    expect((await sort({ group: 'Finance' })).json().sorted).toBe(5);
    expect(order('Finance')).toEqual(['a2', 'a10', 'b', 's', 't']); // Agent 2, Agent 10, Budget, stocks, Tax
    expect(order(null)).toEqual(['k', 'h']); // untouched
    await sort({ all: true });
    expect(order(null)).toEqual(['h', 'k']);
    expect((await sort({})).statusCode).toBe(400);
  });

  it("refuses another owner's agents, itself, and bad shapes", async () => {
    const { move } = await world();
    expect((await move('k', { before: 'x' })).statusCode).toBe(404); // someone else's agent
    expect((await f2(move)).statusCode).toBe(400);
    expect((await move('k', { before: 42 })).statusCode).toBe(400);
    expect((await move('k', { before: null, group: 'x'.repeat(49) })).statusCode).toBe(400);
  });
});

async function f2(move: (id: string, p: object) => Promise<{ statusCode: number }>) { return move("k", { dir: "sideways" }); }
