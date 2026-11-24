import { join } from 'node:path';
import { writeEnvVar } from '../../ops/tailnet.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { backupRunState, backupsDir, listBackups } from './backupFiles.js';
import { DRILL_HOURS, drillDue, drillEvery, drillRunState, listDrills, startDrill, type DrillEvery, type DrillRecord, type DrillRunState } from './drills.js';
import { beginOperation, type OpHandle } from '../lifecycle/operations.js';
import { computeReadiness, type HostView } from './recoveryReadiness.js';

/**
 * Recovery readiness and restore drills (HB-0808;
 * docs/recovery-readiness-design.md): per agent, the newest backup a restore
 * could use, the sets that left it out, the last drill that checked it, one
 * status; a drill started from the app or on the opt-in schedule, each recorded
 * as an operation of this machine (Activity). The drill itself and its records
 * are src/orchestrator/backups/drills.ts; the readiness maths is
 * src/orchestrator/backups/recoveryReadiness.ts.
 *
 * Its state, sorted (HB-0809):
 *  - the schedule's timer (every `sweepEveryMs`). `stop()` ends it. Whether
 *    a drill is under way is drills.ts's (`drillRunState`), not this.
 *
 * Nothing here knows about HTTP: a route checks who is asking, asks this,
 * and words the answer.
 */
export interface RestoreDrills {
  /**
   * The readiness of the agents the caller may see (`admin`: the machine's
   * owner, every agent; anyone else, their own), and the drill line. With
   * `agentId`, that one agent, with the sets a restore can use.
   */
  readiness(o: { admin: boolean; ownerId: string; agentId?: string }): Promise<Record<string, unknown>>;
  /** Start a drill, recorded as an operation of this machine (Activity). Idempotent while one runs. */
  runDrill(trigger: 'app' | 'scheduled', requestedBy?: string): DrillRunState;
  /** Automatic drills (off, weekly or daily), written to .env and live at once. */
  setDrillEvery(every: DrillEvery): Promise<{ ok: boolean; error?: string }>;
  /** The opt-in schedule: a drill in the quiet hours after today's backup. True when one was started. */
  drillSweep(now?: Date): boolean;
  /** End the schedule's timer: at shutdown. */
  stop(): void;
}

/** What the drills need from the process they run in. Functions only, so a test hands them fakes. */
export interface RestoreDrillsDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** A warning to the log (a schedule check that threw). */
  warn: (detail: Record<string, unknown>, event: string) => void;
  /** How often the schedule is checked; 0 = never (tests). */
  drillSweepEveryMs: number;
}

export function createRestoreDrills(deps: RestoreDrillsDeps): RestoreDrills {
  const { store, providerFor, trace } = deps;

  const readiness: RestoreDrills['readiness'] = async ({ admin, ownerId: me, agentId: one }) => {
    const agents = store.listAllActiveAgents().filter((a) => (admin || a.ownerId === me) && (!one || a.id === one));
    const hostView = new Map<string, HostView>();
    await Promise.all([...new Set(agents.map((a) => a.hostId))].map(async (id) => {
      const h = store.getHost(id);
      if (!h) return;
      const local = h.kind === 'local';
      // The provider's cached probe, as the machine line reads it.
      const reachable = local ? undefined : await (async () => (await providerFor(id).reachable?.()) ?? true)().catch(() => undefined);
      hostView.set(id, { name: h.name, local, ...(reachable !== undefined ? { reachable } : {}) });
    }));
    const drills = listDrills();
    const r = computeReadiness({ sets: listBackups(backupsDir(), { others: true }), drills, agents, host: (id) => hostView.get(id), now: Date.now() });
    const last = drills[0];
    return {
      ...r,
      agents: one ? r.agents : r.agents.map(({ restorable: _r, ...x }) => x),
      canRestore: admin,
      drill: {
        every: drillEvery(),
        hours: DRILL_HOURS,
        ...(admin ? { run: drillRunState(), ...(last ? { last: drillSummary(last) } : {}) } : {}),
      },
    };
  };

  /** A drill record for the page: no volume names (they name other owners' agents), only counts and the verdict. */
  const drillSummary = (d: DrillRecord) => ({
    at: d.finishedAt || d.startedAt, set: d.set, passed: d.passed, trigger: d.trigger, durationSec: d.durationSec,
    checked: d.volumes.length, failed: d.volumes.filter((v) => !v.passed).length,
    restored: d.volumes.filter((v) => v.restored === true).length,
    database: d.database, key: d.key, ...(d.reason ? { reason: d.reason } : {}),
  });
  /** How a drill ended, in the owner's words (its Activity row). */
  const drillOutcome = (d: DrillRecord | undefined, fallback: string): string => {
    if (!d) return fallback;
    const n = d.volumes.length, bad = d.volumes.filter((v) => !v.passed).length;
    if (d.reason === 'no-complete-set') return 'No complete backup set to drill yet.';
    if (d.passed) return `Passed: ${n} agent${n === 1 ? '' : 's'} checked from the ${d.set} backup, ${d.volumes.filter((v) => v.restored).length} restored into a throwaway volume.`;
    const parts = [bad ? `${bad} of ${n} agent${n === 1 ? '' : 's'} did not pass` : '', d.database !== 'ok' ? 'the database copy did not pass' : '', d.key !== 'ok' ? 'the saved key did not pass' : ''].filter(Boolean);
    return `Failed on the ${d.set || 'newest'} backup: ${parts.join('; ') || fallback} (Settings → Backups).`;
  };
  /** Start a drill, recorded as an operation of this machine (Activity). Idempotent while one runs. */
  const runDrill = (trigger: 'app' | 'scheduled', requestedBy?: string) => {
    const already = drillRunState().status === 'running';
    let op: OpHandle | undefined;
    const run = startDrill(Date.now(), trigger, (st) => {
      const rec = listDrills()[0];
      // Only a record written by this run speaks for it.
      const mine = rec && Date.parse(rec.startedAt) >= (st.startedAt ?? 0) - 5_000 ? rec : undefined;
      const tail = st.summary?.split('\n').pop() || 'The restore drill failed.';
      if (st.status === 'ok') op?.done(drillOutcome(mine, 'Restore drill passed.'));
      else op?.fail(drillOutcome(mine, tail));
      trace()('backup.drill_finished', { trigger, status: st.status, ...(mine ? { set: mine.set, checked: mine.volumes.length } : {}) });
    });
    const local = store.localHostId();
    if (!already && local) {
      op = beginOperation(store, 'restore-drill', null, { trigger }, { hostId: local, ...(requestedBy ? { requestedBy } : {}) });
      if (run.status === 'error') op.fail(run.summary || 'The restore drill could not start.');
    }
    return run;
  };

  /** Automatic drills: off (the default), weekly or daily. Lives in .env, like the rebuild policy. */
  const setDrillEvery = async (every: DrillEvery): Promise<{ ok: boolean; error?: string }> => {
    const envFile = process.env.HATCHABOT_ENV_FILE ?? join(process.cwd(), '.env'); // (tests point it elsewhere)
    const wrote = await writeEnvVar(envFile, 'HATCHABOT_DRILL_EVERY', every, () => true,
      'Written by Hatchabot: automatic restore drills (Settings → Backups).')
      .catch((err: unknown) => ({ ok: false, error: String(err) }));
    if (!wrote.ok) return wrote;
    process.env.HATCHABOT_DRILL_EVERY = every; // live: the sweep reads it each time
    trace()('backup.drill_schedule_set', { every });
    return wrote;
  };

  /** The opt-in schedule: a drill in the quiet hours after today's backup (drills.ts, drillDue). */
  const drillSweep = (now = new Date()): boolean => {
    const every = drillEvery();
    if (every === 'off') return false;
    const sets = listBackups(backupsDir(), { limit: 1 }); // only the newest is asked about
    const last = listDrills()[0];
    const d = drillDue({
      every, now, newestSet: sets[0], backupRunning: backupRunState().status === 'running', drillRunning: drillRunState().status === 'running',
      lastDrillAt: last?.startedAt, lastDrillPassed: last?.passed,
    });
    if (!d.due) return false;
    runDrill('scheduled');
    return true;
  };
  // Every fifteen minutes, off in tests (routes.ts passes 0 there).
  const sweepTimer = deps.drillSweepEveryMs > 0
    ? setInterval(() => { try { drillSweep(); } catch (err) { deps.warn({ err: String(err) }, 'drill sweep failed'); } }, deps.drillSweepEveryMs).unref()
    : undefined;

  return {
    readiness, runDrill, setDrillEvery, drillSweep,
    stop: () => { if (sweepTimer) clearInterval(sweepTimer); },
  };
}
