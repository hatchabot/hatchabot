import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { AgentBusyError, clearBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import { CRON_QUICK_CHECK_MS, CronSystemOwnedError } from '../src/orchestrator/schedules/crons.js';
import { createSchedules, type Schedules, type SchedulesDeps } from '../src/orchestrator/schedules/schedules.js';
import type { Agent } from '../src/domain/types.js';

/**
 * The schedules service (HB-0808), driven as the routes and the timers drive
 * it but with no HTTP server: a task added, edited, switched, run now and
 * deleted; the passes that re-point a task and tell the owner of a run; the
 * permission to run event-triggered tasks; and the passes' timers. A real
 * store on an in-memory database and the mock runtime, whose answers stand
 * in for the agent's gateway. The agent and its tasks are made up.
 */
const OWNER = 'user-owner';

interface World {
  store: Store;
  provider: MockProvider;
  schedules: Schedules;
  agent: Agent;
  traced: string[];
  owed: string[];
  told: Array<{ ownerId: string; headline: string; tail?: string }>;
  adoptsFinished: number;
  /** Answer the gateway's `cron …` with this. */
  cron(verb: string, stdout: string, code?: number): void;
  /** What the service was built with (a restart builds another from them). */
  deps: SchedulesDeps;
}

async function world(opts: { state?: Agent['state']; sweepsOn?: boolean; openclaw?: string } = {}): Promise<World> {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: {} }, env: {} } as never);
  if (opts.openclaw) provider.infoOverride.set(runtimeRef, { openclawVersion: opts.openclaw });
  store.insertAgent({
    id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: opts.state ?? 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
    runtimeRef, persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now',
  } as never);
  const w = { store, provider, traced: [], owed: [], told: [], adoptsFinished: 0 } as unknown as World;
  const deps: SchedulesDeps = {
    store,
    providerFor: () => provider,
    trace: () => (event) => { w.traced.push(event); },
    agentGone: (id) => { const s = store.getAgent(id)?.state; return !s || s === 'DELETED' || s === 'DELETING'; },
    oweRebuild: (agentId) => { w.owed.push(agentId); const at = new Date().toISOString(); store.setRebuildOnStart(agentId, at); return at; },
    noteReach: (ownerId) => ownerId === OWNER,
    taskNotePush: {
      waiting: async (ownerId, headline, _detail, o) => {
        if (o?.beforeSend && !o.beforeSend()) return false;
        w.told.push({ ownerId, headline, tail: o?.tail });
        return true;
      },
    },
    appUrl: () => 'https://box.example.org',
    applyFilesCap: async () => ({ applied: 0 }),
    finishDeferredAdopts: async () => { w.adoptsFinished++; },
    warn: () => {},
    sweepsOn: opts.sweepsOn ?? false,
  };
  w.deps = deps;
  w.schedules = createSchedules(deps);
  w.agent = store.getAgent('a1')!;
  w.cron = (verb, stdout, code = 0) => provider.execResponses.set(`cron ${verb}`, { code, stdout, stderr: code ? stdout : '' });
  return w;
}

const LIST = JSON.stringify({
  jobs: [
    { id: 'job-1', name: 'Morning scan', enabled: true, agentId: 'kitchen', schedule: { kind: 'cron', expr: '0 9 * * 1-5', tz: 'UTC' }, payload: { kind: 'agentTurn', message: 'Do the scan' } },
    { id: 'job-2', name: 'Hourly shell', enabled: false, schedule: { kind: 'every', every_ms: 3600000 }, payload: { kind: 'command', command: 'echo hi' } },
  ],
});
const cli = (w: World, verb: string) => w.provider.execLog.filter((a) => a[0] === 'cron' && a[1] === verb);

afterEach(() => { vi.useRealTimers(); clearBusy('a1'); });

describe('a task added', () => {
  it('is added under the agent, quiet until the owner can be reached, and told on the phone when asked', async () => {
    const w = await world();
    w.cron('add', '{"id":"menu-1"}');
    const out = await w.schedules.tasks.add(w.agent, { name: 'Weekly menu', message: 'Plan the dinners', everyMinutes: 1.5, notify: true });
    expect(out).toEqual({ id: 'menu-1', noted: true });
    expect(cli(w, 'add')[0]).toEqual(expect.arrayContaining(['--agent', 'kitchen', '--name', 'Weekly menu', '--message', 'Plan the dinners', '--every', '90s']));
    // This OpenClaw cannot post to a conversation, so the task is quiet and remembered for the repair pass.
    expect(w.store.quietedCrons('a1')).toEqual(['menu-1']);
    expect(w.store.cronNotes('a1').map((n) => n.jobId)).toEqual(['menu-1']);
    expect(w.traced).toContain('cron.created');
  });

  it('says what the gateway said when it refuses, and stores nothing', async () => {
    const w = await world();
    w.cron('add', 'gateway restarting', 1);
    expect(await w.schedules.tasks.add(w.agent, { name: 'Weekly menu', message: 'Plan', cron: '0 9 * * 1', notify: true }))
      .toEqual({ refused: 'failed', error: 'gateway restarting' });
    expect(w.store.cronNotes('a1')).toEqual([]);
    expect(w.traced).not.toContain('cron.created');
  });

  it('is refused while something else holds the agent', async () => {
    const w = await world();
    markBusy('a1');
    await expect(w.schedules.tasks.add(w.agent, { name: 'x', message: 'y', cron: '0 9 * * 1' })).rejects.toBeInstanceOf(AgentBusyError);
    expect(cli(w, 'add')).toEqual([]);
  });
});

describe('a task edited', () => {
  it('patches only what changed, then switches it, and keeps its note once that took', async () => {
    const w = await world();
    w.cron('list', LIST);
    const out = await w.schedules.tasks.edit(w.agent, 'job-1', { name: 'Evening scan' }, false, true);
    expect(out).toEqual({ ok: true, edited: true, enabled: false });
    expect(cli(w, 'edit').map((a) => a.slice(2))).toEqual([['job-1', '--name', 'Evening scan']]);
    expect(cli(w, 'disable').map((a) => a[2])).toEqual(['job-1']);
    expect(w.store.cronNotes('a1').map((n) => n.jobId)).toEqual(['job-1']);
  });

  it('refuses a task that is gone, OpenClaw\'s own, or a shell command, in their words, and leaves the note alone', async () => {
    const w = await world();
    w.cron('list', LIST);
    expect(await w.schedules.tasks.edit(w.agent, 'job-9', { name: 'x' }, undefined, true)).toEqual({ refused: 'not-found', error: 'That task no longer exists.' });
    expect(await w.schedules.tasks.edit(w.agent, 'job-2', { name: 'x' }, undefined, true)).toEqual({ refused: 'conflict', error: 'Shell-command tasks are edited by asking the agent.' });
    w.cron('list', JSON.stringify({ jobs: [{ id: 'sys', name: 'Skill review', enabled: true, declarationKey: 'openclaw.skill-review', payload: { kind: 'agentTurn', message: 'Review' } }] }));
    expect(await w.schedules.tasks.edit(w.agent, 'sys', { name: 'x' }, undefined, true)).toEqual({ refused: 'conflict', error: new CronSystemOwnedError().userMessage });
    expect(cli(w, 'edit')).toEqual([]);
    expect(w.store.cronNotes('a1')).toEqual([]);
  });

  it('an edit that took keeps its note when the switch after it fails', async () => {
    const w = await world();
    w.cron('list', LIST);
    w.cron('enable', 'no such job', 1);
    expect(await w.schedules.tasks.edit(w.agent, 'job-1', { message: 'Scan twice' }, true, true))
      .toEqual({ refused: 'failed', error: 'The task was changed, but couldn\'t be enabled — try that again.' });
    expect(w.store.cronNotes('a1').map((n) => n.jobId)).toEqual(['job-1']);
  });

  it('a move that ends while the tasks are read is seen before the write, and nothing goes to the old runtime (HB-0906)', async () => {
    const w = await world();
    w.cron('list', LIST);
    // Every exec, with the runtime it went to; the list read waits for the test.
    const real = w.provider.exec.bind(w.provider);
    const sent: Array<{ ref: string; verb: string }> = [];
    let answerList!: () => void;
    const listHeld = new Promise<void>((r) => { answerList = r; });
    w.provider.exec = async (ref, argv, opts) => {
      sent.push({ ref, verb: `${argv[0]} ${argv[1]}` });
      if (argv[0] === 'cron' && argv[1] === 'list') await listHeld;
      return real(ref, argv, opts);
    };
    const old = w.agent.runtimeRef!;
    const editing = w.schedules.tasks.edit(w.agent, 'job-1', { name: 'Evening scan' }, false, true);
    await vi.waitFor(() => expect(sent.map((s) => s.verb)).toEqual(['cron list']));
    // A move to another machine runs, holding the agent, and finishes meanwhile.
    w.store.insertHost({ id: 'h2', ownerId: OWNER, kind: 'cloud', provider: 'mock', name: 'runner', settings: {}, createdAt: 'now' });
    markBusy('a1');
    const { runtimeRef: moved } = await w.provider.provision({ agentId: 'a1-on-h2', slug: 'kitchen', workspace: { files: {}, configPatch: {} }, env: {} } as never);
    w.store.setAgentHost('a1', 'h2');
    w.store.setAgentRuntimeRef('a1', moved);
    clearBusy('a1');
    answerList();
    expect(await editing).toEqual({ refused: 'conflict', error: 'The agent was moved to another machine or replaced from a copy while its tasks were being read, so nothing was changed. Open its tasks again and make the change once more.' });
    expect(sent).toEqual([{ ref: old, verb: 'cron list' }]);
    expect(w.store.cronNotes('a1')).toEqual([]);
    expect(w.traced).not.toContain('cron.edited');
    // Read again from the agent as it is now, the edit goes to the runtime it has.
    const edited = await w.schedules.tasks.edit(w.store.getAgent('a1')!, 'job-1', { name: 'Evening scan' }, false, true);
    expect(edited).toEqual({ ok: true, edited: true, enabled: false });
    expect(sent.slice(1).map((s) => `${s.ref} ${s.verb}`)).toEqual([`${moved} cron list`, `${moved} cron edit`, `${moved} cron disable`]);
  });
});

describe('a task switched, run now and deleted', () => {
  it('each says whether OpenClaw did it; a switch keeps the note, a delete forgets it', async () => {
    const w = await world();
    expect(await w.schedules.tasks.setEnabled(w.agent, 'job-1', true, true)).toBe(true);
    expect(w.store.cronNotes('a1').map((n) => n.jobId)).toEqual(['job-1']);
    expect(await w.schedules.tasks.runNow(w.agent, 'job-1')).toBe(true);
    expect(cli(w, 'run').map((a) => a[2])).toEqual(['job-1']);
    w.cron('run', 'unknown job', 1);
    expect(await w.schedules.tasks.runNow(w.agent, 'job-9')).toBe(false);
    expect(await w.schedules.tasks.remove(w.agent, 'job-1')).toBe(true);
    expect(w.store.cronNotes('a1')).toEqual([]);
    w.cron('disable', 'unknown job', 1);
    expect(await w.schedules.tasks.setEnabled(w.agent, 'job-9', false, true)).toBe(false);
    expect(w.store.cronNotes('a1')).toEqual([]);
  });

  it('the list holds the tasks, those still waiting, the noted ones and whether a note can reach the owner', async () => {
    const w = await world();
    w.cron('list', LIST);
    w.store.setPendingSchedules('a1', [{ name: 'Weekly menu', message: 'Plan', cron: '0 9 * * 1', why: 'the gateway was busy' }]);
    w.schedules.tasks.setNote(w.agent, 'job-1', true);
    const list = await w.schedules.tasks.list(w.agent);
    expect(list.crons.map((c) => c.id)).toEqual(['job-1', 'job-2']);
    expect(list.waiting).toEqual([{ name: 'Weekly menu', message: 'Plan', cron: '0 9 * * 1', everyMs: undefined, tz: undefined, why: 'the gateway was busy' }]);
    expect(list.notes).toEqual(['job-1']);
    expect(list.noteReach).toBe(true);
  });
});

describe('the passes', () => {
  const storeRead = (jobs: Array<Record<string, unknown>>) => ({ code: 0, stderr: '', stdout: JSON.stringify({ jobs }) });
  const madeInChat = { id: 'j1', name: 'Market summary', enabled: true, sessionTarget: 'isolated', delivery: { mode: 'announce' }, payload: { kind: 'agentTurn', message: 'Summarise.' }, updatedAtMs: 1000 };

  it('the quick pass gives waiting adopts their turn, re-points a task made in chat once, and not again until it changes', async () => {
    const w = await world({ openclaw: '2026.9.8' });
    w.provider.execResponses.set('sh', storeRead([madeInChat]));
    w.cron('list', JSON.stringify({ jobs: [madeInChat] }));
    await w.schedules.sweeps.quickCronRetarget();
    expect(w.adoptsFinished).toBe(1);
    expect(cli(w, 'edit').map((a) => a.slice(2))).toEqual([['j1', '--session', 'current', '--session-key', 'agent:kitchen:main', '--announce', '--best-effort-deliver']]);
    expect(w.traced).toContain('cron.retargeted');
    w.provider.execLog.length = 0;
    await w.schedules.sweeps.quickCronRetarget();
    expect(cli(w, 'edit')).toEqual([]);
    w.provider.execResponses.set('sh', storeRead([{ ...madeInChat, updatedAtMs: 2000 }]));
    await w.schedules.sweeps.quickCronRetarget();
    expect(cli(w, 'edit')).toHaveLength(1);
  });

  it('the quick pass tells a finished run of a noted task once, with a link, and never the result', async () => {
    const w = await world();
    w.store.setCronNote('a1', 'j1', true, 0);
    const ran = { id: 'j1', name: 'Market report', enabled: true, sessionTarget: 'current', sessionKey: 'agent:kitchen:main', delivery: { mode: 'announce' }, payload: { kind: 'agentTurn', message: 'Write it.' }, updatedAtMs: 1, state: { lastRunAtMs: 5000, lastRunStatus: 'ok' } };
    w.provider.execResponses.set('sh', storeRead([ran]));
    await w.schedules.sweeps.quickCronRetarget();
    expect(w.told).toHaveLength(1);
    expect(w.told[0]!.ownerId).toBe(OWNER);
    expect(`${w.told[0]!.headline} ${w.told[0]!.tail}`).toContain('Market report');
    expect(w.told[0]!.tail).toContain('https://box.example.org/#console=kitchen');
    expect(w.store.cronNotes('a1')[0]!.seenRunMs).toBe(5000);
    await w.schedules.sweeps.quickCronRetarget();
    expect(w.told).toHaveLength(1);
    expect(w.traced.filter((e) => e === 'cron.noted')).toHaveLength(1);
  });

  it('the full pass sets the time zone a running agent lacks, and leaves a busy one alone', async () => {
    const w = await world();
    w.provider.execResponses.set('sh', { code: 0, stdout: '', stderr: '' });
    await w.schedules.sweeps.retargetCronSweep();
    expect(w.provider.execLog.some((a) => a[0] === 'config' && a[1] === 'set' && a[2] === 'agents.defaults.userTimezone')).toBe(true);
    expect(w.traced).toContain('timezone.set');
    expect(w.adoptsFinished).toBe(0);
    w.provider.execLog.length = 0;
    markBusy('a1');
    await w.schedules.sweeps.retargetCronSweep();
    expect(w.provider.execLog).toEqual([]);
  });

  it('a task made quiet as the owner first writes is remembered, and pointed at them by the next pass, restart or not (HB-1086)', async () => {
    const w = await world();
    // A Telegram agent whose owner has not written to it yet: no one to post to.
    w.store.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'kitchenbot', secretRef: 'channel/a1/bot-token', deepLink: 'https://t.me/kitchenbot', createdAt: 'now' });
    const brief = { id: 'j1', name: 'Morning brief', enabled: true, delivery: { mode: 'announce', channel: 'last' }, payload: { kind: 'agentTurn', message: 'Brief me.' } };
    w.cron('list', JSON.stringify({ jobs: [brief] }));
    // The owner's first message lands while the quiet write is under way.
    const exec = w.provider.exec.bind(w.provider);
    w.provider.exec = async (ref, argv, opts) => {
      if (argv[0] === 'cron' && argv[1] === 'edit' && argv.includes('--no-deliver')) {
        w.store.insertMembership({ id: 'm-owner', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active', channelUserId: '4242' });
      }
      return exec(ref, argv, opts);
    };
    await w.schedules.sweeps.retargetCronSweep();
    expect(cli(w, 'edit').map((a) => a.slice(2))).toEqual([['j1', '--no-deliver']]);
    expect(w.store.quietedCrons('a1')).toEqual(['j1']);
    // Hatchabot restarts: a new store and service over the same database. The next pass points it at the owner.
    const db = (w.store as unknown as { db: Database.Database }).db;
    const store = new Store(db);
    const next = createSchedules({ ...w.deps, store });
    w.cron('list', JSON.stringify({ jobs: [{ ...brief, delivery: { mode: 'none' } }] }));
    w.provider.execLog.length = 0;
    await next.sweeps.retargetCronSweep();
    expect(cli(w, 'edit').map((a) => a.slice(2))).toEqual([['j1', '--announce', '--best-effort-deliver', '--channel', 'telegram', '--to', '4242']]);
    expect(store.quietedCrons('a1')).toEqual([]);
  });

  it('a store that fails is not the end of either pass', async () => {
    const w = await world();
    (w.store as unknown as Record<string, unknown>).listAllActiveAgents = () => { throw new Error('SQLITE_FULL: database or disk is full'); };
    await expect(w.schedules.sweeps.retargetCronSweep()).resolves.toBeUndefined();
    await expect(w.schedules.sweeps.quickCronRetarget()).resolves.toBeUndefined();
    await expect(w.schedules.sweeps.quickCronRetarget()).resolves.toBeUndefined();
  });

  it('their timers: none in tests; with sweepsOn, the full pass after three minutes and daily, the quick one every CRON_QUICK_CHECK_MS, and stop() ends them', async () => {
    vi.useFakeTimers();
    const off = await world();
    expect(vi.getTimerCount()).toBe(0);
    off.schedules.stop();
    const w = await world({ sweepsOn: true });
    expect(vi.getTimerCount()).toBe(3);
    const reads = vi.spyOn(w.store, 'listAllActiveAgents');
    // The full pass, three minutes in (the quick one is longer: it gives the adopts their turn first).
    expect(CRON_QUICK_CHECK_MS).toBeGreaterThan(3 * 60_000);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(w.adoptsFinished).toBe(0);
    await vi.advanceTimersByTimeAsync(CRON_QUICK_CHECK_MS - 3 * 60_000);
    expect(w.adoptsFinished).toBe(1);
    // The full pass again a day after the start; the quick one many times by then.
    await vi.advanceTimersByTimeAsync(24 * 3_600_000 - CRON_QUICK_CHECK_MS);
    expect(w.adoptsFinished).toBe(24 * 3_600_000 / CRON_QUICK_CHECK_MS);
    expect(reads).toHaveBeenCalledTimes(2 + 24 * 3_600_000 / CRON_QUICK_CHECK_MS);
    w.schedules.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the permission to run event-triggered tasks', () => {
  it('written to a running agent, live: nothing to say, and only the caller\'s own rebuild mark cleared', async () => {
    const w = await world();
    w.store.setAgentCronTriggers('a1', true);
    w.store.setRebuildOnStart('a1', 'mark-1');
    expect(await w.schedules.triggers.applyCronTriggers('a1', 'mark-1')).toBeUndefined();
    expect(w.provider.execLog).toContainEqual(['config', 'set', 'cron.triggers.enabled', 'true']);
    expect(w.store.getAgent('a1')!.rebuildOnStart ?? null).toBeNull();
    w.store.setRebuildOnStart('a1', 'someone-else');
    expect(await w.schedules.triggers.applyCronTriggers('a1', 'mark-1')).toBeUndefined();
    expect(w.store.getAgent('a1')!.rebuildOnStart).toBe('someone-else');
    expect(w.owed).toEqual([]);
  });

  it('a write that fails owes a rebuild and says so; a stopped agent gets it at its next start', async () => {
    const w = await world();
    w.provider.execResponses.set('config set cron.triggers.enabled', { code: 1, stdout: '', stderr: 'gateway down' });
    expect(await w.schedules.triggers.applyCronTriggers('a1')).toMatch(/^Saved, but its running permission could not be changed\./);
    expect(w.owed).toEqual(['a1']);
    const stopped = await world({ state: 'STOPPED' });
    stopped.store.setAgentCronTriggers('a1', true);
    expect(await stopped.schedules.triggers.applyCronTriggers('a1')).toBe('Saved. Event-triggered tasks will be enabled when the agent next starts.');
    expect(stopped.provider.execLog).toEqual([]);
    expect(stopped.owed).toEqual(['a1']);
  });

  it('nothing for an agent that is gone', async () => {
    const w = await world();
    w.store.setAgentState('a1', 'DELETING');
    expect(await w.schedules.triggers.applyCronTriggers('a1')).toBeUndefined();
    expect(w.provider.execLog).toEqual([]);
    expect(w.owed).toEqual([]);
  });
});
