import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { AgentState } from '../src/domain/types.js';
import { clearBusy, markBusy } from '../src/orchestrator/busy.js';
import { beginOperation } from '../src/orchestrator/operations.js';
import { CURATED_SKILLS } from '../src/openclaw/skills.js';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';

const worlds: World[] = [];
afterEach(async () => {
  clearBusy('a1');
  while (worlds.length) await worlds.pop()!.f.close();
});
const db = (w: World) => (w.store as unknown as { db: Database.Database }).db;
const state = (w: World, next: AgentState) => db(w).prepare('UPDATE agents SET state = ? WHERE id = ?').run(next, 'a1');
const read = (w: World, owner = w.owner, id = 'a1') => w.f.inject({ method: 'GET', url: `/v1/agents/${id}/skills`, headers: as(owner) });
const save = (w: World, selected: unknown, owner = w.owner, id = 'a1') => w.f.inject({ method: 'PUT', url: `/v1/agents/${id}/skills`, headers: as(owner), payload: { selected } });
async function ready() {
  const w = await makeWorld();
  worlds.push(w);
  await seedRunningAgent(w, { members: [{ userId: 'member', role: 'user' }, { userId: 'member-owner', role: 'owner' }] });
  w.provider.execLog.length = 0;
  return w;
}

describe('per-agent curated skills', () => {
  it('shows the legacy default without claiming runtime readiness or reading private files', async () => {
    const w = await ready();
    const before = w.store.getAgent('a1');
    const r = await read(w);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json()).toMatchObject({ selected: ['gog'], applied: null, pending: false, managed: false, canEdit: true });
    expect(r.json().skills).toHaveLength(CURATED_SKILLS.length);
    expect(r.json().skills.every((s: Record<string, unknown>) => !('content' in s) && s.applied === null)).toBe(true);
    expect(w.store.getAgent('a1')).toEqual(before);
    expect(w.provider.execLog).toEqual([]);
  });

  it.each(['member', 'member-owner', 'foreign'])('refuses read and write by %s, even with an owner membership', async (owner) => {
    const w = await ready();
    const before = w.store.getAgent('a1');
    expect((await read(w, owner)).statusCode).toBe(404);
    expect((await save(w, [], owner)).statusCode).toBe(404);
    expect(w.store.getAgent('a1')).toEqual(before);
  });

  it.each(['member', 'member-owner'])('does not expose skill selections to %s through the roster or agent details', async (owner) => {
    const w = await ready();
    w.store.setAgentCuratedSkills('a1', ['hatchabot-writing']);
    w.store.setAgentCuratedSkillsApplied('a1', ['gog']);
    for (const url of ['/v1/agents', '/v1/agents/a1']) {
      const r = await w.f.inject({ method: 'GET', url, headers: as(owner) });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.body).not.toContain('curatedSkills');
      expect(r.body).not.toContain('appliedCuratedSkills');
    }
    expect((await read(w, owner)).statusCode).toBe(404);
    expect((await read(w)).json()).toMatchObject({ selected: ['hatchabot-writing'], applied: ['gog'] });
  });

  it.each(['missing', 'DELETING', 'DELETED'] as const)('refuses %s without changing anything', async (kind) => {
    const w = await ready();
    if (kind !== 'missing') state(w, kind);
    const id = kind === 'missing' ? kind : 'a1';
    expect((await read(w, w.owner, id)).statusCode).toBe(404);
    expect((await save(w, [], w.owner, id)).statusCode).toBe(404);
    expect(w.store.getAgent('a1')!.curatedSkills).toBeUndefined();
  });

  it.each([null, 'gog', ['unknown'], ['../gog'], ['gog', 'gog'], [1], ['__proto__']])('rejects invalid selection %j atomically', async (selected) => {
    const w = await ready();
    const before = w.store.getAgent('a1');
    expect((await save(w, selected)).statusCode).toBe(400);
    expect(w.store.getAgent('a1')).toEqual(before);
  });

  it.each(['RUNNING', 'STOPPED', 'FAILED'] as const)('saves a %s agent without waking or rebuilding it', async (s) => {
    const w = await ready();
    state(w, s);
    const r = await save(w, ['hatchabot-writing', 'gog']);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ selected: ['gog', 'hatchabot-writing'], applied: null, pending: true });
    const after = w.store.getAgent('a1')!;
    expect(after.state).toBe(s);
    expect(after.curatedSkills).toEqual(['gog', 'hatchabot-writing']);
    expect(after.rebuildOnStart).toBeTruthy();
    expect(w.provider.execLog).toEqual([]);
    // An identical or reordered save does not renew the rebuild obligation.
    await save(w, ['gog', 'hatchabot-writing']);
    expect(w.store.getAgent('a1')).toEqual(after);
  });

  it('distinguishes an empty selection from legacy defaults and from the last applied choice', async () => {
    const w = await ready();
    w.store.setAgentCuratedSkillsApplied('a1', ['gog']);
    const r = await save(w, []);
    expect(r.json()).toMatchObject({ selected: [], applied: ['gog'], pending: true });
    expect(r.json().skills.find((s: { id: string }) => s.id === 'gog')).toMatchObject({ selected: false, applied: true });
    w.store.setAgentCuratedSkillsApplied('a1', []);
    expect((await read(w)).json()).toMatchObject({ selected: [], applied: [], pending: false });
  });

  it('saving the displayed legacy default explicitly opts into managed selection', async () => {
    const w = await ready();
    await save(w, ['gog']);
    expect(w.store.getAgent('a1')!.curatedSkills).toEqual(['gog']);
    expect(w.store.getAgent('a1')!.rebuildOnStart).toBeTruthy();
  });

  it.each(['PROVISIONING', 'REBUILDING', 'ARCHIVED', 'lock', 'operation'] as const)('keeps %s read-only', async (kind) => {
    const w = await ready();
    if (kind === 'lock') markBusy('a1');
    else if (kind === 'operation') beginOperation(w.store, 'move-host', 'a1', {}, { queued: true }).hold('recovery', { actions: [] });
    else state(w, kind);
    const before = w.store.getAgent('a1');
    expect((await read(w)).json()).toMatchObject({ canEdit: false });
    expect((await save(w, [])).statusCode).toBe(409);
    expect(w.store.getAgent('a1')).toEqual(before);
  });

  it('does not offer the manager a way to change its fixed instructions', async () => {
    const w = await ready();
    db(w).prepare('UPDATE agents SET ops = 1 WHERE id = ?').run('a1');
    expect((await read(w)).statusCode).toBe(400);
    expect((await save(w, ['gog'])).statusCode).toBe(400);
    expect(w.store.getAgent('a1')!.curatedSkills).toBeUndefined();
  });
});
