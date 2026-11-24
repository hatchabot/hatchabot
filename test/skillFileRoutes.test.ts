import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { AgentState } from '../src/domain/types.js';
import { clearBusy, isBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import { beginOperation } from '../src/orchestrator/lifecycle/operations.js';
import { readSkillFile, mutateSkillFile, SkillFileError, type SkillFileView } from '../src/orchestrator/skills/skillFiles.js';
import { runSkillTrial, SKILL_TRIAL_LIMITS, type SkillTrialResult } from '../src/orchestrator/skills/skillTrials.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';

vi.mock('../src/orchestrator/skills/skillFiles.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/orchestrator/skills/skillFiles.js')>(),
  readSkillFile: vi.fn(), mutateSkillFile: vi.fn(),
}));
vi.mock('../src/orchestrator/skills/skillTrials.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/orchestrator/skills/skillTrials.js')>(), runSkillTrial: vi.fn(),
}));

const SKILL = 'hatchabot-writing', REVISION = 'a'.repeat(64);
const worlds: World[] = [], releases: Array<() => void> = [];
beforeEach(() => vi.resetAllMocks());
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  clearBusy('a1');
  while (worlds.length) await worlds.pop()!.f.close();
  vi.restoreAllMocks();
});
const db = (w: World) => (w.store as unknown as { db: Database.Database }).db;
const state = (w: World, next: AgentState) => db(w).prepare('UPDATE agents SET state = ? WHERE id = ?').run(next, 'a1');
const view = (): SkillFileView => ({
  id: SKILL, revision: REVISION,
  catalog: { version: '1.0.0', hash: 'b'.repeat(64), content: 'Reviewed fixture instructions' },
  installed: { version: '0.9.0', hash: 'c'.repeat(64), content: 'Owner fixture instructions' },
  state: 'update_available', canUpdate: true, canReplace: true, canRollback: true,
  history: [{ version: '0.8.0', hash: 'd'.repeat(64), at: '2026-11-01T00:00:00.000Z' }],
});
const read = (w: World, owner = w.owner, skill = SKILL, id = 'a1') =>
  w.f.inject({ method: 'GET', url: `/v1/agents/${id}/skills/${skill}/file`, headers: as(owner) });
const write = (w: World, payload: unknown = { action: 'update', expectedRevision: REVISION }, owner = w.owner, skill = SKILL, id = 'a1') =>
  w.f.inject({ method: 'POST', url: `/v1/agents/${id}/skills/${skill}/file`, headers: { ...as(owner), 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
const practice = (w: World, payload: unknown = { expectedRevision: REVISION }, owner = w.owner, skill = SKILL, id = 'a1') =>
  w.f.inject({ method: 'POST', url: `/v1/agents/${id}/skills/${skill}/try`, headers: { ...as(owner), 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
const trial = (): SkillTrialResult => ({ status: 'completed', output: 'Fixture practice answer', limits: SKILL_TRIAL_LIMITS,
  evidence: { skillRead: true, fixtureRead: true, toolCalls: 2, codeMode: true }, usage: { input: 50, output: 20, total: 70 }, message: 'The local practice used its instructions and sample.' });

async function ready() {
  const w = await makeWorld(); worlds.push(w);
  await seedRunningAgent(w, { members: [{ userId: 'member', role: 'user' }, { userId: 'member-owner', role: 'owner' }] });
  vi.mocked(readSkillFile).mockResolvedValue(view());
  vi.mocked(mutateSkillFile).mockResolvedValue(view());
  vi.mocked(runSkillTrial).mockResolvedValue(trial());
  w.provider.execLog.length = 0;
  return w;
}
async function hold(w: World, mutation = false) {
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const entering = new Promise<void>((resolve) => { entered = resolve; });
  releases.push(release);
  const helper = mutation ? vi.mocked(mutateSkillFile) : vi.mocked(readSkillFile);
  helper.mockImplementationOnce(async () => { entered(); await barrier; return view(); });
  const response = Promise.resolve(mutation ? write(w) : read(w));
  await entering;
  return { response, release };
}

describe('private skill previews and explicit file actions', () => {
  it('returns the actual owner preview without caching or changing the agent', async () => {
    const w = await ready(), before = w.store.getAgent('a1');
    const r = await read(w);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json()).toEqual(view());
    expect(readSkillFile).toHaveBeenCalledWith(w.provider, {
      runtimeRef: before!.runtimeRef, slug: before!.slug, onVolume: false, image: undefined,
    }, SKILL);
    expect(mutateSkillFile).not.toHaveBeenCalled();
    expect(w.store.getAgent('a1')).toEqual(before);
  });

  it.each(['member', 'member-owner', 'foreign'])('denies %s both current content and actions before a helper runs', async (owner) => {
    const w = await ready();
    expect((await read(w, owner)).statusCode).toBe(404);
    expect((await write(w, undefined, owner)).statusCode).toBe(404);
    expect(readSkillFile).not.toHaveBeenCalled(); expect(mutateSkillFile).not.toHaveBeenCalled();
  });

  it.each(['missing', 'DELETING', 'DELETED', 'manager'] as const)('does not inspect or modify %s', async (kind) => {
    const w = await ready();
    if (kind === 'manager') db(w).prepare('UPDATE agents SET ops = 1 WHERE id = ?').run('a1');
    else if (kind !== 'missing') state(w, kind);
    const id = kind === 'missing' ? 'absent' : 'a1', expected = kind === 'manager' ? 400 : 404;
    expect((await read(w, w.owner, SKILL, id)).statusCode).toBe(expected);
    expect((await write(w, undefined, w.owner, SKILL, id)).statusCode).toBe(expected);
    expect(readSkillFile).not.toHaveBeenCalled(); expect(mutateSkillFile).not.toHaveBeenCalled();
  });

  it('rejects an unknown skill before reading or changing files', async () => {
    const w = await ready();
    expect((await read(w, w.owner, 'unknown-skill')).statusCode).toBe(404);
    expect((await write(w, undefined, w.owner, 'unknown-skill')).statusCode).toBe(400);
    expect(readSkillFile).not.toHaveBeenCalled(); expect(mutateSkillFile).not.toHaveBeenCalled();
  });

  it.each([null, {}, { action: 'update' }, { action: 'delete', expectedRevision: REVISION },
    { action: 'update', expectedRevision: 'old' }, { action: 'update', expectedRevision: REVISION.toUpperCase() },
    { action: 'replace', expectedRevision: REVISION, content: 'unreviewed extra content' },
  ])('refuses malformed mutation %# without changing the agent', async (payload) => {
    const w = await ready(), before = w.store.getAgent('a1');
    expect((await write(w, payload)).statusCode).toBe(400);
    expect(mutateSkillFile).not.toHaveBeenCalled(); expect(w.store.getAgent('a1')).toEqual(before);
  });

  it.each(['PROVISIONING', 'REBUILDING', 'lock', 'operation'] as const)('refuses preview and action while %s', async (kind) => {
    const w = await ready();
    if (kind === 'lock') markBusy('a1');
    else if (kind === 'operation') beginOperation(w.store, 'move-host', 'a1', {}, { queued: true });
    else state(w, kind);
    expect((await read(w)).statusCode).toBe(409); expect((await write(w)).statusCode).toBe(409);
    expect(readSkillFile).not.toHaveBeenCalled(); expect(mutateSkillFile).not.toHaveBeenCalled();
  });

  it.each(['STOPPED', 'FAILED', 'ARCHIVED'] as const)('reads %s from its volume without starting it', async (kind) => {
    const w = await ready(); state(w, kind);
    const before = w.store.getAgent('a1'), r = await read(w);
    expect(r.statusCode, r.body).toBe(200);
    expect(readSkillFile).toHaveBeenCalledWith(w.provider, expect.objectContaining({ onVolume: true }), SKILL);
    expect(r.json()).toMatchObject({ canUpdate: kind !== 'ARCHIVED', canReplace: kind !== 'ARCHIVED', canRollback: kind !== 'ARCHIVED' });
    expect(w.store.getAgent('a1')).toEqual(before);
    if (kind === 'ARCHIVED') { expect((await write(w)).statusCode).toBe(409); expect(mutateSkillFile).not.toHaveBeenCalled(); }
  });

  it('shows only reviewed catalog text when no runtime exists, with file actions disabled', async () => {
    const w = await ready(); db(w).prepare('UPDATE agents SET runtime_ref = NULL WHERE id = ?').run('a1');
    const r = await read(w);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ id: SKILL, state: 'unavailable', revision: null,
      installed: { content: null, hash: null, version: null }, canUpdate: false, canReplace: false, canRollback: false, history: [] });
    expect(r.json().catalog.content).toContain('Writing and review');
    expect((await write(w)).statusCode).toBe(409);
    expect(readSkillFile).not.toHaveBeenCalled(); expect(mutateSkillFile).not.toHaveBeenCalled();
  });

  it.each(['RUNNING', 'STOPPED', 'FAILED'] as const)('updates a %s file under a busy lock, touches context, and never rebuilds or wakes it', async (kind) => {
    const w = await ready(); state(w, kind);
    const before = w.store.getAgent('a1')!;
    vi.mocked(mutateSkillFile).mockImplementationOnce(async () => {
      expect(isBusy('a1')).toBe(true); return view();
    });
    const r = await write(w, { action: 'replace', expectedRevision: REVISION });
    expect(r.statusCode, r.body).toBe(200); expect(r.headers['cache-control']).toBe('no-store');
    expect(mutateSkillFile).toHaveBeenCalledWith(w.provider, { runtimeRef: before.runtimeRef, slug: before.slug, onVolume: kind !== 'RUNNING', image: undefined }, SKILL,
      { action: 'replace', expectedRevision: REVISION });
    const after = w.store.getAgent('a1')!;
    expect(after.updatedAt).not.toBe(before.updatedAt);
    expect(after).toEqual({ ...before, updatedAt: after.updatedAt });
    expect(r.json().agentUpdatedAt).toBe(after.updatedAt);
    expect(isBusy('a1')).toBe(false); expect(w.provider.execLog).toEqual([]);
  });

  it('propagates stale revision as conflict without touching state, then releases the lock', async () => {
    const w = await ready(), before = w.store.getAgent('a1');
    vi.mocked(mutateSkillFile).mockRejectedValueOnce(new SkillFileError('conflict'));
    const r = await write(w);
    expect(r.statusCode, r.body).toBe(409); expect(r.json().error).toContain('changed');
    expect(w.store.getAgent('a1')).toEqual(before); expect(isBusy('a1')).toBe(false);
  });

  it('refuses overlapping previews, writes and selection saves while the mutation is running', async () => {
    const w = await ready(), pending = await hold(w, true);
    expect(isBusy('a1')).toBe(true);
    expect((await read(w)).statusCode).toBe(409);
    expect((await write(w)).statusCode).toBe(409);
    const save = await w.f.inject({ method: 'PUT', url: '/v1/agents/a1/skills', headers: as(), payload: { selected: [] } });
    expect(save.statusCode).toBe(409); expect(mutateSkillFile).toHaveBeenCalledTimes(1);
    pending.release(); expect((await pending.response).statusCode).toBe(200); expect(isBusy('a1')).toBe(false);
  });

  it.each(['conflict', 'customized', 'no_history', 'unsafe', 'too_large', 'unavailable', 'volume_missing'] as const)
    ('maps %s failures without returning private runtime details', async (code) => {
      const w = await ready(); vi.mocked(readSkillFile).mockRejectedValueOnce(new SkillFileError(code));
      const r = await read(w);
      expect(r.statusCode).toBe(code === 'too_large' ? 413 : ['unavailable', 'volume_missing'].includes(code) ? 502 : 409);
      expect(r.json()).toEqual({ error: new SkillFileError(code).userMessage });
    });

  it('sanitizes unexpected provider failures', async () => {
    const w = await ready(); vi.mocked(readSkillFile).mockRejectedValueOnce(new Error('private runtime path and contents'));
    const r = await read(w); expect(r.statusCode).toBe(502); expect(r.body).not.toContain('private');
  });
});

describe('opt-in isolated skill practice routes', () => {
  it('uses the reviewed current file exactly once under the busy lock without waking, rebuilding or changing selection', async () => {
    const w = await ready(), before = w.store.getAgent('a1')!;
    vi.mocked(runSkillTrial).mockImplementationOnce(async () => { expect(isBusy('a1')).toBe(true); return trial(); });
    const r = await practice(w);
    expect(r.statusCode, r.body).toBe(200); expect(r.headers['cache-control']).toBe('no-store'); expect(r.json()).toEqual(trial());
    expect(runSkillTrial).toHaveBeenCalledExactlyOnceWith(w.provider, { runtimeRef: before.runtimeRef, slug: before.slug },
      { id: SKILL, content: view().installed.content });
    expect(mutateSkillFile).not.toHaveBeenCalled(); expect(w.store.getAgent('a1')).toEqual(before); expect(isBusy('a1')).toBe(false);
  });

  it.each(['member', 'member-owner', 'foreign'])('refuses practice for %s before reading private instructions or spending tokens', async (owner) => {
    const w = await ready(); expect((await practice(w, undefined, owner)).statusCode).toBe(404);
    expect(readSkillFile).not.toHaveBeenCalled(); expect(runSkillTrial).not.toHaveBeenCalled();
  });

  it.each(['missing', 'DELETING', 'DELETED', 'manager'] as const)('refuses practice for %s', async (kind) => {
    const w = await ready();
    if (kind === 'manager') db(w).prepare('UPDATE agents SET ops = 1 WHERE id = ?').run('a1');
    else if (kind !== 'missing') state(w, kind);
    expect((await practice(w, undefined, w.owner, SKILL, kind === 'missing' ? 'absent' : 'a1')).statusCode).toBe(kind === 'manager' ? 400 : 404);
    expect(readSkillFile).not.toHaveBeenCalled(); expect(runSkillTrial).not.toHaveBeenCalled();
  });

  it.each([null, {}, { expectedRevision: 'stale' }, { expectedRevision: REVISION, prompt: 'unreviewed custom task' }])
    ('refuses malformed practice %# before reading or invoking the runtime', async (body) => {
      const w = await ready(); expect((await practice(w, body)).statusCode).toBe(400);
      expect(readSkillFile).not.toHaveBeenCalled(); expect(runSkillTrial).not.toHaveBeenCalled();
    });

  it('refuses practice for an unknown skill', async () => {
    const w = await ready(); expect((await practice(w, undefined, w.owner, 'unknown-skill')).statusCode).toBe(400);
    expect(readSkillFile).not.toHaveBeenCalled(); expect(runSkillTrial).not.toHaveBeenCalled();
  });

  it.each(['STOPPED', 'FAILED', 'ARCHIVED', 'PROVISIONING', 'REBUILDING', 'no runtime', 'lock', 'operation'] as const)
    ('refuses practice while %s without changing state', async (kind) => {
      const w = await ready();
      if (kind === 'no runtime') db(w).prepare('UPDATE agents SET runtime_ref = NULL WHERE id = ?').run('a1');
      else if (kind === 'lock') markBusy('a1');
      else if (kind === 'operation') beginOperation(w.store, 'move-host', 'a1', {}, { queued: true });
      else state(w, kind);
      const before = w.store.getAgent('a1');
      expect((await practice(w)).statusCode).toBe(409);
      expect(readSkillFile).not.toHaveBeenCalled(); expect(runSkillTrial).not.toHaveBeenCalled(); expect(w.store.getAgent('a1')).toEqual(before);
    });

  it('refuses stale instructions and an absent file without spending tokens or consuming cooldown', async () => {
    const w = await ready();
    expect((await practice(w, { expectedRevision: 'b'.repeat(64) })).statusCode).toBe(409);
    vi.mocked(readSkillFile).mockResolvedValueOnce({ ...view(), installed: { content: null, hash: null, version: null }, state: 'missing' });
    expect((await practice(w)).statusCode).toBe(409); expect(runSkillTrial).not.toHaveBeenCalled(); expect(isBusy('a1')).toBe(false);
    expect((await practice(w)).statusCode).toBe(200); expect(runSkillTrial).toHaveBeenCalledTimes(1);
  });

  it('requires two minutes between practice calls across skills, then permits a new call', async () => {
    const w = await ready(); expect((await practice(w)).statusCode).toBe(200);
    const r = await practice(w, undefined, w.owner, 'hatchabot-jira');
    expect(r.statusCode).toBe(429); expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(120); expect(runSkillTrial).toHaveBeenCalledTimes(1);
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 120_001);
    expect((await practice(w)).statusCode).toBe(200); expect(runSkillTrial).toHaveBeenCalledTimes(2);
  });

  it('keeps cooldown when a started practice fails and releases the busy lock', async () => {
    const w = await ready(); vi.mocked(runSkillTrial).mockRejectedValueOnce(new Error('private execution output'));
    const r = await practice(w);
    expect(r.statusCode).toBe(502); expect(r.body).not.toContain('private'); expect(isBusy('a1')).toBe(false);
    expect((await practice(w)).statusCode).toBe(429); expect(runSkillTrial).toHaveBeenCalledTimes(1);
  });

  it.each(['owner', 'logout', 'runtime', 'STOPPED'] as const)('rechecks %s after reading instructions and before starting a paid task', async (kind) => {
    const w = await ready(); let signedIn = true;
    if (kind === 'logout') w.f.principalFromCookieHeader = () => signedIn ? { ownerId: w.owner } as never : undefined;
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; }), entering = new Promise<void>((resolve) => { entered = resolve; });
    releases.push(release); vi.mocked(readSkillFile).mockImplementationOnce(async () => { entered(); await barrier; return view(); });
    const pending = Promise.resolve(practice(w)); await entering;
    if (kind === 'owner') db(w).prepare('UPDATE agents SET owner_id = ? WHERE id = ?').run('different-owner', 'a1');
    else if (kind === 'logout') signedIn = false;
    else if (kind === 'runtime') w.store.setAgentRuntimeRef('a1', 'mock://replacement');
    else state(w, kind);
    release(); expect((await pending).statusCode).toBe(['owner', 'logout'].includes(kind) ? 404 : 409);
    expect(runSkillTrial).not.toHaveBeenCalled(); expect(isBusy('a1')).toBe(false);
  });

  it.each(['none', 'owner', 'logout', 'runtime', 'provider', 'STOPPED', 'DELETED'] as const)
    ('holds one execution and discards its result after %s changes', async (kind) => {
      const w = await ready(); let signedIn = true;
      if (kind === 'logout') w.f.principalFromCookieHeader = () => signedIn ? { ownerId: w.owner } as never : undefined;
      let release!: () => void, entered!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; }), entering = new Promise<void>((resolve) => { entered = resolve; });
      releases.push(release); vi.mocked(runSkillTrial).mockImplementationOnce(async () => { entered(); await barrier; return trial(); });
      const pending = Promise.resolve(practice(w)); await entering;
      expect((await practice(w)).statusCode).toBe(409); expect((await write(w)).statusCode).toBe(409);
      expect(runSkillTrial).toHaveBeenCalledTimes(1); expect(mutateSkillFile).not.toHaveBeenCalled();
      if (kind === 'owner') db(w).prepare('UPDATE agents SET owner_id = ? WHERE id = ?').run('different-owner', 'a1');
      else if (kind === 'logout') signedIn = false;
      else if (kind === 'runtime') w.store.setAgentRuntimeRef('a1', 'mock://replacement');
      else if (kind === 'provider') w.providers.set('mock', new MockProvider());
      else if (kind !== 'none') state(w, kind);
      const before = w.store.getAgent('a1');
      release(); const r = await pending;
      expect(r.statusCode).toBe(kind === 'none' ? 200 : ['owner', 'logout', 'DELETED'].includes(kind) ? 404 : 409);
      if (kind !== 'none') expect(r.body).not.toContain('Fixture practice answer');
      expect(w.store.getAgent('a1')).toEqual(before); expect(isBusy('a1')).toBe(false);
    });
});

describe('delayed skill file results', () => {
  it.each([false, true])('discards %s mutation results after logout without touching the new context', async (mutation) => {
    const w = await ready(); let signedIn = true;
    w.f.principalFromCookieHeader = () => signedIn ? { ownerId: w.owner } as never : undefined;
    const pending = await hold(w, mutation), before = w.store.getAgent('a1'); signedIn = false;
    pending.release(); expect((await pending.response).statusCode).toBe(404);
    expect(w.store.getAgent('a1')).toEqual(before); expect(isBusy('a1')).toBe(false);
  });

  it.each(['owner', 'DELETING', 'DELETED', 'runtime', 'host', 'profile', 'provider', 'state', 'selection', 'settings'] as const)
    ('discards a preview after %s changes', async (kind) => {
      const w = await ready(), pending = await hold(w);
      if (kind === 'owner') db(w).prepare('UPDATE agents SET owner_id = ? WHERE id = ?').run('different-owner', 'a1');
      else if (kind === 'DELETING' || kind === 'DELETED') state(w, kind);
      else if (kind === 'runtime') w.store.setAgentRuntimeRef('a1', 'mock://replacement');
      else if (kind === 'host') { w.store.insertHost({ ...w.store.getHost('h1')!, id: 'other-host' }); w.store.setAgentHost('a1', 'other-host'); }
      else if (kind === 'profile') { w.store.insertAIProfile({ ...w.store.getAIProfile('p1')!, id: 'other-profile' }); w.store.setAgentAIProfile('a1', 'other-profile'); }
      else if (kind === 'provider') w.providers.set('mock', new MockProvider());
      else if (kind === 'state') state(w, 'STOPPED');
      else if (kind === 'selection') w.store.setAgentCuratedSkills('a1', []);
      else w.store.setAIProfileModel('p1', 'changed-fixture-model');
      const afterChange = w.store.getAgent('a1');
      pending.release(); expect((await pending.response).statusCode).toBe(['owner', 'DELETING', 'DELETED'].includes(kind) ? 404 : 409);
      expect(w.store.getAgent('a1')).toEqual(afterChange);
    });

  it.each(['owner', 'DELETING', 'DELETED', 'runtime', 'host', 'provider', 'state'] as const)
    ('discards a mutation response after %s changes without touching a replacement context', async (kind) => {
      const w = await ready(), pending = await hold(w, true);
      if (kind === 'owner') db(w).prepare('UPDATE agents SET owner_id = ? WHERE id = ?').run('different-owner', 'a1');
      else if (kind === 'DELETING' || kind === 'DELETED') state(w, kind);
      else if (kind === 'runtime') w.store.setAgentRuntimeRef('a1', 'mock://replacement');
      else if (kind === 'host') { w.store.insertHost({ ...w.store.getHost('h1')!, id: 'other-host' }); w.store.setAgentHost('a1', 'other-host'); }
      else if (kind === 'provider') w.providers.set('mock', new MockProvider());
      else state(w, 'STOPPED');
      const afterChange = w.store.getAgent('a1');
      pending.release(); expect((await pending.response).statusCode).toBe(['owner', 'DELETING', 'DELETED'].includes(kind) ? 404 : 409);
      expect(w.store.getAgent('a1')).toEqual(afterChange); expect(isBusy('a1')).toBe(false);
    });
});
