import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';

const OWNER = 'user-owner';

/**
 * v2.165.0 recorded a pause on an agent already stopped by hand without
 * already_stopped (the column came in v2.166.0): lifting it started the agent.
 * Its own budget.paused event says which pauses those were (HB-0095).
 */
describe('budget pauses written before already_stopped existed (HB-0095)', () => {
  it('an open pause whose event says the agent was already stopped is marked; the others are left', () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    for (const id of ['a1', 'a2', 'a3']) {
      store.insertAgent({ id, ownerId: OWNER, name: `Helper ${id}`, slug: id, state: 'STOPPED', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as any);
    }
    const at = '2026-10-23T09:00:00.000Z';
    for (const id of ['a1', 'a2', 'a3']) store.addBudgetPause(id, '2026-10', 'machine', at);
    const event = (id: string, detail: Record<string, unknown>, when: string) =>
      db.prepare(`INSERT INTO agent_events (agent_id, at, event, detail) VALUES (?, ?, 'budget.paused', ?)`).run(id, when, JSON.stringify({ agentId: id, ...detail }));
    event('a1', { alreadyStopped: true, usd: 50 }, '2026-10-23T09:00:01.500Z'); // stopped by hand
    event('a2', { usd: 50 }, '2026-10-23T09:00:02.000Z');                       // the budget stopped it
    event('a3', { alreadyStopped: true }, '2026-10-20T09:00:00.000Z');            // another pause, long before
    // As on a machine that ran v2.165.0: the migration has not run yet.
    db.prepare(`DELETE FROM store_migrations WHERE name = '2026-10-26-budget-pause-already-stopped'`).run();
    new Store(db);
    expect(store.getBudgetPause('a1', '2026-10')!.alreadyStopped).toBe(true);
    expect(store.getBudgetPause('a2', '2026-10')!.alreadyStopped).toBeUndefined();
    expect(store.getBudgetPause('a3', '2026-10')!.alreadyStopped).toBeUndefined();
  });
});
