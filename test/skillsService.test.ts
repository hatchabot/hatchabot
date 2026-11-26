import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { createSkills, type SkillCaller, type Skills } from '../src/orchestrator/skills/skills.js';
import { createCoreFileTurns } from '../src/orchestrator/files/coreFileTurns.js';
import { clearBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import { mutateSkillFile, readSkillFile, type SkillFileView } from '../src/orchestrator/skills/skillFiles.js';
import { runSkillTrial, SKILL_TRIAL_LIMITS } from '../src/orchestrator/skills/skillTrials.js';
import { readSkillsStatus } from '../src/orchestrator/skills/skillsStatus.js';
import { CURATED_SKILLS } from '../src/openclaw/skills.js';
import type { Agent } from '../src/domain/types.js';
import { dayKey, machineTz, monthKey, monthSpend } from '../src/orchestrator/usage/budgets.js';

vi.mock('../src/orchestrator/skills/skillFiles.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/orchestrator/skills/skillFiles.js')>(),
  readSkillFile: vi.fn(), mutateSkillFile: vi.fn(),
}));
vi.mock('../src/orchestrator/skills/skillTrials.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/orchestrator/skills/skillTrials.js')>(), runSkillTrial: vi.fn(),
}));
vi.mock('../src/orchestrator/skills/skillsStatus.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/orchestrator/skills/skillsStatus.js')>(), readSkillsStatus: vi.fn(),
}));

/**
 * The skills service (HB-0808 step 13), driven as src/api/data/skillRoutes.ts
 * drives it but with no HTTP server: a real store on an in-memory database,
 * the real core-files turn, and the runtime's reads and writes stubbed.
 */
const OWNER = 'user-owner';
const SKILL = 'hatchabot-writing', REVISION = 'a'.repeat(64);
const view = (): SkillFileView => ({
  id: SKILL, revision: REVISION,
  catalog: { version: '1.0.0', hash: 'b'.repeat(64), content: 'Reviewed fixture instructions' },
  installed: { version: '0.9.0', hash: 'c'.repeat(64), content: 'Owner fixture instructions' },
  state: 'update_available', canUpdate: true, canReplace: true, canRollback: true, history: [],
});

interface World { store: Store; skills: Skills; owed: string[]; traced: string[]; archiving: Set<string>; caller: SkillCaller; watched: number; valid: boolean; agent(o?: Partial<Agent>): Agent }
const made: World[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readSkillFile).mockResolvedValue(view());
  vi.mocked(mutateSkillFile).mockResolvedValue(view());
  vi.mocked(runSkillTrial).mockResolvedValue({ status: 'completed', output: 'Fixture answer', limits: SKILL_TRIAL_LIMITS, evidence: { skillRead: true, fixtureRead: true, toolCalls: 1, codeMode: true }, usage: { input: 1, output: 1, total: 2 }, message: 'ok' });
});
afterEach(() => { for (const w of made.splice(0)) w.skills.stop(); clearBusy('a1'); vi.useRealTimers(); });

function world(): World {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const provider = {};
  const agentGone = (id: string) => { const s = store.getAgent(id)?.state; return !s || s === 'DELETED' || s === 'DELETING'; };
  const w = { store, owed: [], traced: [], archiving: new Set<string>(), watched: 0, valid: true } as unknown as World;
  const turns = createCoreFileTurns({ store, agentGone });
  w.skills = createSkills({
    store, providerFor: () => provider as never, trace: () => (event) => { w.traced.push(event); }, agentGone,
    isArchiving: (id) => w.archiving.has(id),
    oweRebuild: (id) => { w.owed.push(id); return 'stamp'; },
    withCoreFilesTurn: turns.withCoreFilesTurn,
  });
  w.caller = { owned: (id) => store.getAgent(id), watch: () => { w.watched++; return { valid: () => w.valid }; } };
  w.agent = (o = {}) => {
    store.insertAgent({
      id: 'a1', ownerId: OWNER, name: 'Agent', slug: 'a1', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
      persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now', runtimeRef: 'docker://hatchabot-a1', ...o,
    } as unknown as Agent);
    return store.getAgent('a1')!;
  };
  made.push(w);
  return w;
}

describe('the library', () => {
  it('saves the choices once, owes a rebuild, and says they are pending', () => {
    const w = world();
    const a = w.agent();
    const r = w.skills.save(a, [SKILL]);
    expect(r.ok && r.body.selected).toEqual([SKILL]);
    expect(r.ok && r.body.pending).toBe(true);
    expect(w.owed).toEqual(['a1']);
    expect(w.traced).toEqual(['skills.selected']);
    // The same choices again: nothing more is written or owed.
    w.skills.save(w.store.getAgent('a1')!, [SKILL]);
    expect(w.owed).toEqual(['a1']);
  });

  it('refuses a save while the agent is busy, archived or being archived, and changes nothing', () => {
    const w = world();
    const a = w.agent();
    markBusy('a1');
    expect(w.skills.save(a, [SKILL])).toEqual({ ok: false, status: 409, error: 'Finish the current operation or restore the archived agent before changing its skills.' });
    clearBusy('a1');
    w.archiving.add('a1');
    expect(w.skills.save(a, [SKILL]).ok).toBe(false);
    expect(w.skills.editable(a)).toBe(false);
    expect(w.store.getAgent('a1')!.curatedSkills).toBeUndefined();
    expect(w.owed).toEqual([]);
  });

  it('a manager is never editable; the view lists the whole catalog without its text', () => {
    const w = world();
    const a = w.agent({ ops: true } as Partial<Agent>);
    expect(w.skills.editable(a)).toBe(false);
    const v = w.skills.view(a);
    expect(v.skills.map((s) => s.id)).toEqual(CURATED_SKILLS.map((s) => s.id));
    expect(v.skills.every((s) => !('content' in s))).toBe(true);
  });
});

describe('the status read', () => {
  it('coalesces reads of one agent in the same context, then reads afresh', async () => {
    const w = world();
    const a = w.agent();
    let finish!: (v: unknown) => void;
    vi.mocked(readSkillsStatus).mockImplementationOnce(() => new Promise((r) => { finish = r as never; }));
    const one = w.skills.status(a, w.caller), two = w.skills.status(a, w.caller);
    await new Promise((r) => setTimeout(r, 0));
    expect(readSkillsStatus).toHaveBeenCalledTimes(1);
    finish({ status: 'checked', skills: [] });
    const [r1, r2] = await Promise.all([one, two]);
    expect(r1.ok && (r1.body as { status: string }).status).toBe('checked');
    expect(r2.ok && 'checkedAt' in (r2.body as object)).toBe(true);
    vi.mocked(readSkillsStatus).mockResolvedValueOnce({ status: 'checked', skills: [] } as never);
    await w.skills.status(a, w.caller);
    expect(readSkillsStatus).toHaveBeenCalledTimes(2);
  });

  it('checks the session and the agent again after the read', async () => {
    const w = world();
    const a = w.agent();
    vi.mocked(readSkillsStatus).mockImplementation(async () => { w.valid = false; return { status: 'checked', skills: [] } as never; });
    expect(await w.skills.status(a, w.caller)).toEqual({ ok: false, status: 404, error: 'Not found' });
    w.valid = true;
    vi.mocked(readSkillsStatus).mockImplementation(async () => { markBusy('a1'); return { status: 'checked', skills: [] } as never; });
    expect(await w.skills.status(a, w.caller)).toEqual({ ok: true, body: { status: 'busy', skills: [] } });
  });

  it('a busy or stopped agent is not read, and no session is watched', async () => {
    const w = world();
    const a = w.agent({ state: 'STOPPED' });
    expect(await w.skills.status(a, w.caller)).toEqual({ ok: true, body: { status: 'not_running', skills: [] } });
    expect(w.watched).toBe(0);
    expect(readSkillsStatus).not.toHaveBeenCalled();
  });
});

describe('a skill file and practice', () => {
  it('writes a file in the core-files turn, touches the agent and traces it', async () => {
    const w = world();
    const a = w.agent();
    const r = await w.skills.changeFile(a, SKILL, { action: 'update', expectedRevision: REVISION }, w.caller);
    expect(r.ok).toBe(true);
    expect(r.ok && r.body.agentUpdatedAt).toBe(w.store.getAgent('a1')!.updatedAt);
    expect(mutateSkillFile).toHaveBeenCalledTimes(1);
    expect(w.traced).toEqual(['skills.file_changed']);
  });

  it('refuses a file change when the agent changed during the write', async () => {
    const w = world();
    const a = w.agent();
    vi.mocked(mutateSkillFile).mockImplementationOnce(async () => { w.archiving.add('a1'); return view(); });
    expect(await w.skills.changeFile(a, SKILL, { action: 'update', expectedRevision: REVISION }, w.caller))
      .toEqual({ ok: false, status: 409, error: 'The agent changed during the operation. Reopen the preview to inspect its current instructions.' });
  });

  it('practice: two minutes apart per agent, with retry-after; stop() ends the cooldown', async () => {
    const w = world();
    const a = w.agent();
    expect((await w.skills.practice(a, SKILL, REVISION, w.caller)).ok).toBe(true);
    const again = await w.skills.practice(w.store.getAgent('a1')!, SKILL, REVISION, w.caller);
    expect(again).toMatchObject({ ok: false, status: 429, error: 'Wait two minutes between practice tasks on this agent.' });
    expect(Number((again as { retryAfter: string }).retryAfter)).toBeGreaterThan(100);
    expect(runSkillTrial).toHaveBeenCalledTimes(1);
    w.skills.stop();
    expect((await w.skills.practice(w.store.getAgent('a1')!, SKILL, REVISION, w.caller)).ok).toBe(true);
  });

  it('practice against stale instructions costs nothing and starts no cooldown', async () => {
    const w = world();
    const a = w.agent();
    expect(await w.skills.practice(a, SKILL, 'f'.repeat(64), w.caller)).toEqual({ ok: false, status: 409, error: 'The instructions changed. Refresh the preview before practice.' });
    expect(runSkillTrial).not.toHaveBeenCalled();
    expect((await w.skills.practice(a, SKILL, REVISION, w.caller)).ok).toBe(true);
  });

  it('practice: what the run spent is recorded before it answers, and left out of the answer (HB-0933)', async () => {
    const w = world();
    const a = w.agent();
    const spent = [{ model: 'claude-opus-4-8', calls: 2, input: 900, output: 120, cacheRead: 3_000, cacheWrite: 400 }];
    vi.mocked(runSkillTrial).mockImplementationOnce(async () => {
      expect(w.store.practiceUsageFor(['a1'])).toEqual([]);
      return { status: 'timeout', limits: SKILL_TRIAL_LIMITS, evidence: { skillRead: false, fixtureRead: false, toolCalls: 0, codeMode: null }, message: 'Practice reached its time limit.',
        spent, spentFrom: 'state' };
    });
    const r = await w.skills.practice(a, SKILL, REVISION, w.caller);
    expect(r.ok && r.body.status).toBe('timeout');
    expect(r.ok && ['spent', 'spentFrom'].some((k) => k in r.body)).toBe(false);
    expect(w.store.practiceUsageFor(['a1'])).toEqual([expect.objectContaining({ agentId: 'a1', skill: SKILL, status: 'timeout', model: 'claude-opus-4-8', profileId: 'p1', calls: 2, input: 900, output: 120, cacheRead: 3_000, cacheWrite: 400 })]);
    expect(monthSpend(w.store, monthKey(Date.now(), machineTz()), ['a1']).get('a1')).toBeGreaterThan(0);
  });

  it('practice: an agent that changed while it ran still has what the run spent recorded (HB-0933)', async () => {
    const w = world();
    const a = w.agent();
    vi.mocked(runSkillTrial).mockImplementationOnce(async () => {
      w.archiving.add('a1');
      return { status: 'completed', output: 'Fixture answer', limits: SKILL_TRIAL_LIMITS, evidence: { skillRead: true, fixtureRead: true, toolCalls: 1, codeMode: true }, message: 'ok',
        spent: [{ model: 'claude-opus-4-8', calls: 1, input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }] };
    });
    expect(await w.skills.practice(a, SKILL, REVISION, w.caller)).toMatchObject({ ok: false, status: 409 });
    expect(w.store.practiceUsageFor(['a1']).map((x) => x.input)).toEqual([10]);
  });

  it('practice waits while the agent is paused by its budget, and costs nothing (HB-0933)', async () => {
    const w = world();
    const a = w.agent();
    const month = monthKey(Date.now(), machineTz());
    w.store.addBudgetPause('a1', month, 'a1', new Date().toISOString());
    const r = await w.skills.practice(a, SKILL, REVISION, w.caller);
    expect(r).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/^This agent is paused by its budget for .*Practice spends from the same budget/) });
    expect(runSkillTrial).not.toHaveBeenCalled();
    expect(readSkillFile).not.toHaveBeenCalled();
    // Paused while it waited for its turn: refused there, before the model is called.
    w.store.resumeBudgetPause('a1', month, new Date().toISOString(), 'owner');
    vi.mocked(readSkillFile).mockImplementationOnce(async () => { w.store.addBudgetPause('a1', month, 'machine', new Date().toISOString()); return view(); });
    expect(await w.skills.practice(w.store.getAgent('a1')!, SKILL, REVISION, w.caller)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/paused by its budget/) });
    expect(runSkillTrial).not.toHaveBeenCalled();
    // Resumed: it practises, and no cooldown was started by the refusals.
    w.store.resumeBudgetPause('a1', month, new Date().toISOString(), 'owner');
    expect((await w.skills.practice(w.store.getAgent('a1')!, SKILL, REVISION, w.caller)).ok).toBe(true);
  });

  it('practice waits as soon as its own pause budget is reached, before the pause is made, and costs nothing (HB-0933 review)', async () => {
    const w = world();
    const a = w.agent();
    const now = new Date().toISOString();
    w.store.setBudget('a1', a.ownerId, 1, 'pause', now);
    w.store.addPracticeUsage([{ agentId: 'a1', run: 'r1', model: 'claude-opus-4-8', at: now, day: dayKey(Date.now(), machineTz()), skill: SKILL, status: 'completed',
      calls: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 2, unpricedTokens: 0 }]);
    expect(w.store.getBudgetPause('a1', monthKey(Date.now(), machineTz()))).toBeUndefined();
    expect(await w.skills.practice(a, SKILL, REVISION, w.caller)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/^This agent is paused by its budget for .*Practice spends from the same budget/) });
    expect(runSkillTrial).not.toHaveBeenCalled();
  });

  it('a preview of an agent with no runtime shows the catalog only, and nothing is read', async () => {
    const w = world();
    const a = w.agent({ runtimeRef: undefined, state: 'STOPPED' } as Partial<Agent>);
    const skill = CURATED_SKILLS.find((s) => s.id === SKILL)!;
    const r = await w.skills.readFile(a, skill, w.caller);
    expect(r.ok && (r.body as { state: string }).state).toBe('unavailable');
    expect(readSkillFile).not.toHaveBeenCalled();
    expect(w.watched).toBe(0);
  });
});
