import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { createHomeScreen, type HomeScreen } from '../src/orchestrator/homeScreen/homeScreen.js';
import { createModelChanges } from '../src/orchestrator/usage/modelChanges.js';
import type { IconCompleter } from '../src/orchestrator/homeScreen/agentIcons.js';
import type { Agent } from '../src/domain/types.js';

/**
 * The home screen service and the model changes service (HB-0808 step 15,
 * part C), driven as src/api/homeScreenRoutes.ts and
 * src/api/modelChangeRoutes.ts drive them, with no HTTP server: a real store
 * on an in-memory database and a management AI the test answers for.
 */
const OWNER = 'user-owner';
const NEIGHBOUR = 'user-neighbour';

interface World {
  store: Store; h: HomeScreen;
  /** What the management AI answers (none: no AI), and when. */
  ai?: IconCompleter;
  /** When each agent was last active, for a sort by activity. */
  active: Map<string, string>;
  /** Answers a read of an agent's activity in place of `active`, when set (a test that holds the reads). */
  readActivity?: (a: Agent) => Promise<string | undefined>;
  warned: string[];
  agent(id: string, name: string, o?: { owner?: string; archived?: boolean }): Agent;
  /** The owner's agents in their order, by id. */
  order(owner?: string): string[];
}

function world(): World {
  const store = new Store(new Database(':memory:'));
  for (const o of [OWNER, NEIGHBOUR]) store.insertHost({ id: `h-${o}`, ownerId: o, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const w = { store, active: new Map(), warned: [] } as unknown as World;
  w.h = createHomeScreen({
    store,
    lastActiveFor: async (a) => (w.readActivity ? w.readActivity(a) : w.active.get(a.id)),
    completer: () => w.ai,
  });
  let n = 0;
  w.agent = (id, name, o = {}) => {
    const owner = o.owner ?? OWNER;
    store.insertAgent({
      id, ownerId: owner, name, slug: id, state: 'PROVISIONING', aiProfileId: 'p1', hostId: `h-${owner}`,
      persona: '', sharedMemory: false, createdAt: `2026-11-0${++n}T00:00:00Z`, updatedAt: 'now',
    } as unknown as Agent);
    store.setAgentState(id, 'RUNNING');
    if (o.archived) { store.setAgentState(id, 'STOPPED'); store.setAgentState(id, 'ARCHIVED'); }
    return store.getAgent(id)!;
  };
  w.order = (owner = OWNER) => store.listAgents(owner).filter((a) => a.ownerId === owner).map((a) => a.id);
  return w;
}
const warn = (w: World) => (_detail: object, msg: string) => { w.warned.push(msg); };

describe('the home screen\'s order', () => {
  it('moves an agent one place, to an edge, and just before another of the caller\'s', () => {
    const w = world();
    const [a, , c] = [w.agent('a', 'Alpha'), w.agent('b', 'Bravo'), w.agent('c', 'Charlie')];
    const owned = (id: string) => w.store.getAgent(id)?.ownerId === OWNER ? w.store.getAgent(id) : undefined;
    expect(w.h.order.move(c, { dir: 'top' }, owned)).toEqual({ ok: true, body: { ok: true } });
    expect(w.order()[0]).toBe('c');
    expect(w.h.order.move(a, { dir: 'bottom' }, owned)).toEqual({ ok: true, body: { ok: true } });
    expect(w.order().at(-1)).toBe('a');
    expect(w.h.order.move(a, { dir: 'up' }, owned)).toEqual({ ok: true, body: { ok: true } });
    expect(w.order().at(-2)).toBe('a');
    expect(w.h.order.move(a, { before: 'c' }, owned)).toEqual({ ok: true, body: { ok: true, group: null } });
    expect(w.order().slice(0, 2)).toEqual(['a', 'c']);
  });

  it('puts one at the end of a group, and refuses what it cannot read, in its words', () => {
    const w = world();
    const a = w.agent('a', 'Alpha');
    w.agent('x', 'Xray', { owner: NEIGHBOUR });
    const owned = (id: string) => w.store.getAgent(id)?.ownerId === OWNER ? w.store.getAgent(id) : undefined;
    expect(w.h.order.move(a, { before: null, group: '  Kitchen  ' }, owned)).toEqual({ ok: true, body: { ok: true, group: 'Kitchen' } });
    expect(w.h.order.move(a, { before: 'x' }, owned)).toEqual({ ok: false, status: 404, error: 'No such agent to place it before.' });
    expect(w.h.order.move(a, { before: 7 }, owned)).toEqual({ ok: false, status: 400, error: 'before must be an agent id or null.' });
    expect(w.h.order.move(a, { before: null, group: 7 }, owned)).toEqual({ ok: false, status: 400, error: 'group must be a name or null.' });
    expect(w.h.order.move(a, { before: null, group: 'g'.repeat(49) }, owned)).toEqual({ ok: false, status: 400, error: 'Group names are at most 48 characters.' });
    expect(w.h.order.move(a, {}, owned)).toEqual({ ok: false, status: 400, error: 'Send dir ("up" | "down" | "top" | "bottom") or before.' });
    expect(w.h.order.move(a, { dir: 'sideways' }, owned)).toMatchObject({ ok: false, status: 400 });
  });

  it('sorts a section once, by name, by time or by last activity, and every section', async () => {
    const w = world();
    w.agent('c', 'Charlie'); w.agent('a', 'Alpha'); w.agent('b', 'Bravo');
    expect(await w.h.order.sort(OWNER, { group: '' })).toEqual({ ok: true, body: { ok: true, sorted: 3, mode: 'name', desc: false } });
    expect(w.order()).toEqual(['a', 'b', 'c']);
    expect(await w.h.order.sort(OWNER, { group: null, mode: 'time', desc: true })).toMatchObject({ ok: true, body: { mode: 'time', desc: true } });
    expect(w.order()).toEqual(['b', 'a', 'c']);
    w.active.set('c', '2026-11-20T00:00:00Z'); w.active.set('a', '2026-11-21T00:00:00Z');
    expect(await w.h.order.sort(OWNER, { all: true, mode: 'activity' })).toMatchObject({ ok: true, body: { sorted: 3, mode: 'activity' } });
    expect(w.order()[2]).toBe('b'); // none last
    expect(await w.h.order.sort(OWNER, { mode: 'size' })).toEqual({ ok: false, status: 400, error: 'mode must be "name", "time" or "activity".' });
    expect(await w.h.order.sort(OWNER, {})).toEqual({ ok: false, status: 400, error: 'group (a name, or "" for ungrouped) or all: true is required.' });
  });

  it('sorting one group by activity reads only that group\'s agents, six at a time, and a bad request reads none (HB-0902)', async () => {
    const w = world();
    const owned = (id: string) => w.store.getAgent(id);
    const kitchen = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'];
    kitchen.forEach((id, i) => w.h.order.move(w.agent(id, `Kitchen ${i + 1}`), { before: null, group: 'Kitchen' }, owned));
    w.h.order.move(w.agent('g1', 'Garden'), { before: null, group: 'Garden' }, owned);
    w.agent('u1', 'Loose');
    // Each read waits until the test lets it answer.
    const started: string[] = [];
    const answer = new Map<string, () => void>();
    w.readActivity = (a) => new Promise((resolve) => {
      started.push(a.id);
      answer.set(a.id, () => resolve(a.id === 'k7' ? undefined : `2026-11-2${kitchen.indexOf(a.id)}T00:00:00Z`));
    });
    // Refused before anything is read.
    const bad = [w.h.order.sort(OWNER, { mode: 'activity' }), w.h.order.sort(OWNER, { mode: 'activity', group: 7 })];
    await new Promise((r) => setImmediate(r));
    expect(started).toEqual([]);
    expect(await bad[0]).toEqual({ ok: false, status: 400, error: 'group (a name, or "" for ungrouped) or all: true is required.' });
    expect(await bad[1]).toMatchObject({ ok: false, status: 400 });
    const sorting = w.h.order.sort(OWNER, { group: 'Kitchen', mode: 'activity', desc: true });
    await new Promise((r) => setImmediate(r));
    // Six at once, none from another group, the seventh once they have answered.
    expect(started).toEqual(kitchen.slice(0, 6));
    for (const id of kitchen.slice(0, 6)) answer.get(id)!();
    await vi.waitFor(() => expect(started).toEqual(kitchen));
    answer.get('k7')!();
    expect(await sorting).toEqual({ ok: true, body: { ok: true, sorted: 7, mode: 'activity', desc: true } });
    expect(started).not.toContain('g1');
    expect(started).not.toContain('u1');
    // Latest first, the one never active last.
    expect(w.order().filter((id) => id.startsWith('k'))).toEqual(['k6', 'k5', 'k4', 'k3', 'k2', 'k1', 'k7']);
  });

  it('renames a group of the owner\'s, and moves its section', () => {
    const w = world();
    const owned = (id: string) => w.store.getAgent(id);
    w.h.order.move(w.agent('a', 'Alpha'), { before: null, group: 'Kitchen' }, owned);
    w.h.order.move(w.agent('b', 'Bravo'), { before: null, group: 'Garden' }, owned);
    expect(w.h.order.rename(OWNER, 'Kitchen', 'Kitchen')).toEqual({ ok: true, body: { renamed: 0 } });
    expect(w.h.order.rename(NEIGHBOUR, 'Kitchen', 'Pantry')).toEqual({ ok: false, status: 404, error: 'No group called "Kitchen".' });
    expect(w.h.order.rename(OWNER, 'Kitchen', 'Pantry')).toEqual({ ok: true, body: { renamed: 1, group: 'Pantry' } });
    expect(w.store.getAgent('a')!.group).toBe('Pantry');
    const moved = w.h.order.moveGroup(OWNER, 'Pantry', 'down');
    expect(moved.ok).toBe(true);
    expect(typeof moved.moved).toBe('boolean');
  });
});

describe('the home screen\'s icons', () => {
  it('picks from the keyword table without a management AI, only for those with none, and again with redo', async () => {
    const w = world();
    w.agent('a', 'Kitchen helper'); w.agent('b', 'Garden planner');
    w.store.setAgentIcon('b', '🌻', null);
    const r = await w.h.icons.auto(OWNER, {}, warn(w));
    expect(r).toMatchObject({ ok: true, body: { assigned: 1, via: 'keywords', icons: [{ id: 'a' }] } });
    expect(w.store.getAgent('a')!.icon).toBeTruthy();
    expect(w.store.getAgent('b')!.icon).toBe('🌻');
    expect(await w.h.icons.auto(OWNER, { ids: ['b'], redo: true }, warn(w))).toMatchObject({ ok: true, body: { assigned: 1, icons: [{ id: 'b' }] } });
    expect(await w.h.icons.auto(NEIGHBOUR, {}, warn(w))).toEqual({ ok: true, body: { assigned: 0, via: 'none', icons: [] } });
  });

  it('an icon the owner saves while the AI answers stands, a redo\'s too, and only what was written is reported (HB-1007)', async () => {
    const w = world();
    w.agent('a', 'Kitchen helper'); w.agent('b', 'Garden planner'); w.agent('c', 'Pantry list');
    w.store.setAgentIcon('a', '🐱', '#3aa36b');
    // The AI's answer is held until the test gives it.
    let answer!: (text: string) => void;
    w.ai = () => new Promise<string>((r) => { answer = r; });
    const redo = w.h.icons.auto(OWNER, { ids: ['a'], redo: true }, warn(w));
    await new Promise((r) => setImmediate(r));
    w.store.setAgentIcon('a', '🐶', '#3a8fd0'); // the owner's choice, made meanwhile
    answer('[{"id":"a","icon":"🦉","color":"#e0a13a"}]');
    expect(await redo).toEqual({ ok: true, body: { assigned: 0, via: 'ai', icons: [] } });
    expect(w.store.getAgent('a')).toMatchObject({ icon: '🐶', iconColor: '#3a8fd0' });
    // Filling in the missing ones: one chosen meanwhile is left, and not counted.
    const fill = w.h.icons.auto(OWNER, {}, warn(w));
    await new Promise((r) => setImmediate(r));
    w.store.setAgentIcon('b', '🌻', null);
    answer('[{"id":"b","icon":"🥕","color":"#d0703a"},{"id":"c","icon":"🥫","color":"#c9b03a"}]');
    expect(await fill).toEqual({ ok: true, body: { assigned: 1, via: 'ai', icons: [{ id: 'c', icon: '🥫', color: '#c9b03a' }] } });
    expect(w.store.getAgent('b')!.icon).toBe('🌻');
    expect(w.store.getAgent('c')).toMatchObject({ icon: '🥫', iconColor: '#c9b03a' });
    // Untouched meanwhile, a redo writes as before.
    const again = w.h.icons.auto(OWNER, { ids: ['a'], redo: true }, warn(w));
    await new Promise((r) => setImmediate(r));
    answer('[{"id":"a","icon":"🦉","color":"#e0a13a"}]');
    expect(await again).toMatchObject({ ok: true, body: { assigned: 1, icons: [{ id: 'a', icon: '🦉' }] } });
    expect(w.store.getAgent('a')!.icon).toBe('🦉');
  });

  it('runs one pick and one set of ideas at a time per owner', async () => {
    const w = world();
    const a = w.agent('a', 'Kitchen helper');
    let answer!: (text: string) => void;
    w.ai = () => new Promise<string>((r) => { answer = r; });
    const first = w.h.icons.auto(OWNER, {}, warn(w));
    await new Promise((r) => setImmediate(r));
    expect(await w.h.icons.auto(OWNER, {}, warn(w))).toEqual({ ok: false, status: 429, error: 'Already picking icons — give it a moment.' });
    answer('not an answer');
    expect(await first).toMatchObject({ ok: true, body: { assigned: 1 } });
    const ideas = w.h.icons.suggest(a, OWNER, {}, warn(w));
    await new Promise((r) => setImmediate(r));
    expect(await w.h.icons.suggest(a, OWNER, {}, warn(w))).toEqual({ ok: false, status: 429, error: 'Already thinking of icons — give it a moment.' });
    answer('nothing useful');
    const r = await ideas;
    expect(r.ok).toBe(true);
    // Why the AI gave none goes to the log, never the answer.
    expect(r.ok && 'error' in r.body).toBe(false);
    expect(w.warned).toContain('icon ideas: the management AI gave none');
    // Free again afterwards.
    w.ai = undefined;
    expect((await w.h.icons.suggest(a, OWNER, { exclude: ['🍳'] }, warn(w))).ok).toBe(true);
  });
});

describe('planned agents', () => {
  it('plans one per name, says when the name is an agent already (archived too), and removes it', () => {
    const w = world();
    w.agent('a', 'Kitchen helper', { archived: true });
    expect(w.h.plans.add(OWNER, { name: '   ' })).toEqual({ ok: false, status: 400, error: 'Give the planned agent a name.' });
    expect(w.h.plans.add(OWNER, { name: 'kitchen HELPER' })).toEqual({ ok: false, status: 409, error: 'You already have an agent called "Kitchen helper" (archived). Plan another name.' });
    const r = w.h.plans.add(OWNER, { name: '  Garden planner ', note: ' for spring ' });
    expect(r).toMatchObject({ ok: true, body: { todo: { name: 'Garden planner', note: 'for spring' } } });
    expect(w.h.plans.list(OWNER).map((t) => t.name)).toEqual(['Garden planner']);
    expect(w.h.plans.list(NEIGHBOUR)).toEqual([]);
    const id = r.ok ? r.body.todo.id : '';
    expect(w.h.plans.remove(NEIGHBOUR, id)).toBe(false);
    expect(w.h.plans.remove(OWNER, id)).toBe(true);
  });

  it('holds at most 100 plans', () => {
    const w = world();
    for (let i = 0; i < 100; i++) expect(w.h.plans.add(OWNER, { name: `Plan ${i}` }).ok).toBe(true);
    expect(w.h.plans.add(OWNER, { name: 'One more' })).toEqual({ ok: false, status: 400, error: 'That is a lot of plans — create or remove some first.' });
  });
});

describe('the model steward\'s reads', () => {
  it('lists the owner\'s changes and token actions with the notes, and seeds the ledger at start-up without throwing', () => {
    const store = new Store(new Database(':memory:'));
    const logged: string[] = [];
    const m = createModelChanges({ store, log: { info: (_d, msg) => logged.push(msg), warn: (_d, msg) => logged.push(msg) } });
    m.atStart();
    expect(logged).not.toContain('model.ledger_backfill_failed');
    const r = m.changes(OWNER, 30, undefined);
    expect(r).toMatchObject({ changes: [], tokenActions: [] });
    expect(r.notes).toHaveLength(3);
    expect(m.changes(OWNER, 30, 'nobody')).toMatchObject({ changes: [] });
    expect(m.options(OWNER)).toBeTruthy();
  });
});
