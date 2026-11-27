import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AgentHoldKind, Store } from './store.js';

/**
 * A rollback, as the next start finds it (HB-0840).
 *
 * What a process has still to do for an agent when it ends is kept in the
 * store (`agent_holds`, HB-0809) for the next process to take up. A release
 * from before that table (v2.190.0 and older) neither serves nor clears it,
 * so after a rollback to one and an upgrade again, the next start took up
 * holds days or weeks old: a model written to a runtime, an agent taken out
 * of a class it had since been left in on purpose. A rollback between two
 * newer releases replayed them in the same way.
 *
 * So whatever rolls a release back (scripts/upgrade.sh and
 * scripts/deploy-release.sh, a rollback asked for by naming an older release
 * or one after a release that did not come up, which the service manager had
 * started; scripts/restart.sh too, when an upgrade's restart of the new
 * release fails under an upgrade.sh of v2.191.0 and older, which writes none
 * itself) writes the time, just before the restart
 * onto the release it goes back to, in `<database>.rolled-back` beside the
 * database. The first start of a release that reads the note lets go of the
 * holds kept before that time whose kind would change an agent if served
 * late (`HOLDS_AFTER_ROLLBACK`), before anything reads them, and then removes
 * the note. A hold kept after it is kept: v2.191.0 knows the table but not
 * the note, so gone back to, it keeps holds of its own that the next release
 * must serve.
 *
 * A note whose time cannot be read (no time in it, or a file that cannot be
 * read) still says a rollback came, and is taken at its file's own time: the
 * scripts write it whole and rename it in, so that is when it was written.
 * One whose file's time cannot be read either lets go of nothing, and says
 * so. Either way the time is the same at every start, so a note that cannot
 * be removed lets go again, at each start, only of holds kept before that
 * time, never of one kept since; taken at the start's own time, it let go of
 * every hold at every start (review of HB-0840). A drop the database refuses
 * (a full disk) is said and leaves the note for the next start, and the
 * start goes on, the holds it would have let go of read as not there until
 * then (Store.hideAgentHoldsBefore); it crashed every start, the note
 * keeping it so, and then served them as if no rollback had come.
 *
 * Each release lets go only of the kinds it knows (`HOLDS_AFTER_ROLLBACK`),
 * so a note is kept while a hold of a kind it does not know, kept before the
 * note's time, is still there: a later release's, gone back from. Removed,
 * that later release installed again took its hold up days late (review of
 * HB-0840). Kept, it is taken again at each start of this release, which
 * lets go again only of what was kept before the same time (nothing of its
 * own since), until a release that knows every kind there takes it, lets go
 * of those, and removes it.
 */
export const ROLLBACK_MARK_SUFFIX = '.rolled-back';

/**
 * What a rollback does with each kind of hold kept before it, and why. Every
 * kind is here, and only here: the type makes one added to `AgentHoldKind`
 * without a place fail the typecheck, and test/rollbackMark.test.ts fails too.
 *
 * - drop: served, it changes an agent's settings or its runtime (a model put
 *   on, a class left, a pause recorded): days late, that is what must not
 *   happen.
 * - keep: a fact or a refusal the owner gave, a watch bounded by its own
 *   clock, a guard that only holds something back, or work whose late run is
 *   harmless and needed.
 */
export const HOLDS_AFTER_ROLLBACK: Record<AgentHoldKind, { fate: 'drop' | 'keep'; why: string }> = {
  'model-apply': { fate: 'drop', why: 'served, it writes a model to the agent\'s runtime' },
  'class-detach': { fate: 'drop', why: 'served, it takes the agent out of its class and changes its limits' },
  'budget-pause': { fate: 'drop', why: 'served, it records a budget pause for the agent and takes over a start owed on it, so a Stop by hand since becomes a pause' },
  'model-waits-image': { fate: 'keep', why: 'a guard: served, it only keeps a model off the runtime until the rebuild with an image that can run it, which clears it, as the next class written does' },
  'skip-pool': { fate: 'keep', why: 'the owner\'s refusal of a pool bot: dropped, a Retry would lease one' },
  'pending-joins': { fate: 'keep', why: 'a join\'s watch for a first message, bounded by its own window' },
  'first-contact': { fate: 'keep', why: 'a watch for a first message, bounded by the time it had left' },
  'embed-reindex': { fate: 'keep', why: 'a memory index to rebuild: late, harmless, and memory search stays paused without it' },
  'docs-sync': { fate: 'keep', why: 'the managed AGENTS.md sections to write again: late, harmless (it writes what the record says now), and needed' },
  'download-stop': { fate: 'drop', why: 'served, it starts the agent: days late, a Stop by hand since would be undone' },
  'knock-door': { fate: 'drop', why: 'served, it writes the agent\'s door open on its runtime: after a rollback it is left to the next build, which writes the door from the setting' },
};
/** The kinds a rollback lets go of (HOLDS_AFTER_ROLLBACK). */
export const ROLLBACK_DROPS: readonly AgentHoldKind[] = (Object.keys(HOLDS_AFTER_ROLLBACK) as AgentHoldKind[]).filter((k) => HOLDS_AFTER_ROLLBACK[k].fate === 'drop');

export const rollbackMarkPath = (dbPath: string): string => `${dbPath}${ROLLBACK_MARK_SUFFIX}`;

export interface RollbackTaken {
  /** Holds of a kind in ROLLBACK_DROPS kept before this time were let go; absent when no time could be read at all. */
  before?: string;
  dropped: Array<{ agentId: string; kind: AgentHoldKind; at: string }>;
  /** The note was there but its time could not be read: why (it was taken at its file's own time, `before`, if that could be read). */
  unread?: string;
  /** The database refused the drop: nothing was let go, the note stays for the next start, and this process does not serve them (Store.hideAgentHoldsBefore). */
  failed?: string;
  /** The note could not be removed: why. */
  leftBehind?: string;
  /** The note was kept on purpose: holds of these kinds, which this release does not know, were kept before its time (a later release's). */
  keptFor?: string[];
}

const why = (err: unknown): string => String((err as Error)?.message ?? err);

/**
 * At start, before anything reads a hold: undefined when no rollback came
 * since the last start. Never throws. `holds`: the kinds this release knows,
 * and what it does with each (a test gives a later release's).
 */
export function takeRollbackMark(store: Store, dbPath: string, holds: Readonly<Record<string, { fate: 'drop' | 'keep' }>> = HOLDS_AFTER_ROLLBACK): RollbackTaken | undefined {
  const file = rollbackMarkPath(dbPath);
  let text: string | undefined, unread: string | undefined;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    unread = why(err);
  }
  let at = text === undefined ? NaN : Date.parse(text.trim());
  if (text !== undefined && !Number.isFinite(at)) unread = `not a time: ${JSON.stringify(text.trim().slice(0, 40))}`;
  if (!Number.isFinite(at)) {
    try {
      at = statSync(file).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return { dropped: [], unread: `${unread}; and its file's time: ${why(err)}` };
    }
  }
  const before = new Date(at).toISOString();
  let dropped: RollbackTaken['dropped'], keptFor: string[];
  const known = Object.keys(holds), drops = known.filter((k) => holds[k]!.fate === 'drop') as AgentHoldKind[];
  try {
    dropped = store.dropAgentHoldsBefore(before, drops);
    keptFor = store.agentHoldKindsBefore(before, known);
  } catch (err) {
    // Not let go of, so not served either while this process runs: the store
    // reads them as not there (Store.hideAgentHoldsBefore), and the note stays.
    store.hideAgentHoldsBefore(before, drops);
    return { before, dropped: [], ...(unread ? { unread } : {}), failed: why(err) };
  }
  if (keptFor.length) return { before, dropped, ...(unread ? { unread } : {}), keptFor };
  let leftBehind: string | undefined;
  try { rmSync(file, { force: true }); } catch (err) { leftBehind = why(err); }
  return { before, dropped, ...(unread ? { unread } : {}), ...(leftBehind ? { leftBehind } : {}) };
}

/**
 * At this process's stop, after its last write: a note written while it ran
 * gets the time it stops (review of HB-0840). The scripts write the note before the restart onto the
 * release gone back to, and the release being left runs on until that
 * restart stops it: through the checkout back, the dependencies put back and
 * the old release's own ensure-deps, when the rollback is a v2.191.0
 * upgrade.sh's and restart.sh wrote the note as the new release failed its
 * health wait. A hold it kept in that time was kept after the note's time,
 * and the next start kept it too. Written at the stop, the note's time is
 * after every hold this process kept. Not when it is stopped by SIGKILL, or
 * before it set its handler; and never a note from before this start (one the
 * start could not take, or remove, or kept for a later release's holds):
 * moved later, it would let go of what this process kept.
 *
 * Written while it ran: both its file's time, to the nanosecond, and the
 * time it holds are after this process's start. The time it holds was
 * compared to the second, so a note written in the second before this start
 * was moved too. And the file's time alone is not enough: the scripts' advice
 * when they cannot write the note gives the rollback's own time to write
 * once there is room, typed perhaps while the release gone back to runs, and
 * moved to its stop that note let go of what it kept (review of HB-0840). Its
 * time, the rollback's, is before the start of whatever runs when it is
 * typed, so it is never moved. A note a script writes holds its time to the
 * second: one written in the second this process started is not moved.
 * Returns the time written, or undefined.
 */
export function restampRollbackMark(dbPath: string, startedAt: Date, now: () => Date = () => new Date()): string | undefined {
  const file = rollbackMarkPath(dbPath);
  let text: string, written: bigint;
  try {
    text = readFileSync(file, 'utf8');
    written = statSync(file, { bigint: true }).mtimeNs;
  } catch { return undefined; }
  const at = Date.parse(text.trim()), start = startedAt.getTime();
  if (!Number.isFinite(at) || at < start || written <= BigInt(start) * 1_000_000n) return undefined;
  const stamp = now().toISOString(), tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, `${stamp}\n`);
    renameSync(tmp, file);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* the note stays as the script wrote it */ }
    return undefined;
  }
  return stamp;
}
