import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import type { Agent } from '../src/domain/types.js';

const OWNER = 'o';

function make() {
  return new Store(new Database(':memory:'));
}

function add(s: Store, id: string, sortOrder: number, group?: string) {
  s.insertAgent({
    id, ownerId: OWNER, name: id.toUpperCase(), slug: id, state: 'RUNNING',
    aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false,
    sortOrder, group, createdAt: '2026-01-01', updatedAt: '2026-01-01',
  } as Agent);
}

const order = (s: Store) => s.listAgents(OWNER).map((a) => a.id);

describe('agent grouping + ordering', () => {
  it('lists ungrouped first, then groups A→Z, each by sort_order', () => {
    const s = make();
    add(s, 'a1', 1);
    add(s, 'a2', 2);
    add(s, 'fin1', 1, 'Finance');
    add(s, 'fin2', 2, 'Finance');
    add(s, 'alpha', 1, 'Alpha');
    expect(order(s)).toEqual(['a1', 'a2', 'alpha', 'fin1', 'fin2']);
  });

  it('move down / up swaps with the neighbor in the same group', () => {
    const s = make();
    add(s, 'a1', 1);
    add(s, 'a2', 2);
    expect(s.moveAgent('a1', 'down')).toBe(true);
    expect(order(s)).toEqual(['a2', 'a1']);
    expect(s.moveAgent('a1', 'up')).toBe(true);
    expect(order(s)).toEqual(['a1', 'a2']);
  });

  it('no-op at the section boundary', () => {
    const s = make();
    add(s, 'a1', 1);
    add(s, 'a2', 2);
    expect(s.moveAgent('a1', 'up')).toBe(false); // already first
    expect(s.moveAgent('a2', 'down')).toBe(false); // already last
    expect(order(s)).toEqual(['a1', 'a2']);
  });

  it('reorders only within a group — never across the boundary', () => {
    const s = make();
    add(s, 'a1', 1);
    add(s, 'fin1', 1, 'Finance');
    add(s, 'fin2', 2, 'Finance');
    // fin1 is first in Finance; "up" must not pull it into the ungrouped set.
    expect(s.moveAgent('fin1', 'up')).toBe(false);
    expect(order(s)).toEqual(['a1', 'fin1', 'fin2']);
    // within Finance it moves fine
    expect(s.moveAgent('fin1', 'down')).toBe(true);
    expect(order(s)).toEqual(['a1', 'fin2', 'fin1']);
  });

  it('auto-assigns strictly increasing sort_order (no ties) when none is given', () => {
    const s = make();
    const mk = (id: string) =>
      s.insertAgent({
        id, ownerId: OWNER, name: id.toUpperCase(), slug: id, state: 'RUNNING',
        aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false,
        createdAt: '2026-01-01', updatedAt: '2026-01-01',
      } as Agent);
    mk('a1'); mk('a2'); mk('a3');
    // Distinct orders mean the swap is real — with tied stamps this was a no-op.
    expect(s.moveAgent('a3', 'up')).toBe(true);
    expect(order(s)).toEqual(['a1', 'a3', 'a2']);
  });

  it('setAgentGroup drops the agent at the END of the destination group', () => {
    const s = make();
    add(s, 'a1', 1);
    add(s, 'fin1', 1, 'Finance');
    add(s, 'fin2', 2, 'Finance');
    s.setAgentGroup('a1', 'Finance');
    // a1 lands after the existing Finance members, not at a spot implied by its
    // old (unrelated) order value.
    expect(order(s)).toEqual(['fin1', 'fin2', 'a1']);
  });

  it('setAgentGroup moves an agent between sections; null clears it', () => {
    const s = make();
    add(s, 'a1', 5);
    add(s, 'fin1', 1, 'Finance');
    s.setAgentGroup('a1', 'Finance');
    expect(s.getAgent('a1')!.group).toBe('Finance');
    // Now both in Finance, ordered by sort_order (fin1=1, a1=5).
    expect(order(s)).toEqual(['fin1', 'a1']);
    s.setAgentGroup('a1', null);
    expect(s.getAgent('a1')!.group).toBeUndefined();
    expect(order(s)).toEqual(['a1', 'fin1']); // ungrouped first again
  });
});
