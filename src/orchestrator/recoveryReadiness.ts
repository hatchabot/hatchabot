/**
 * Can I get this agent back? (docs/recovery-readiness-design.md)
 *
 * Per agent, from the nightly sets' own records and the restore drills'
 * records: the newest backup a restore could use, the recent sets that left
 * it out and why, whether its runner answers now, the last drill that checked
 * it, and one status with its line in plain words. A pure function of what it
 * is given, so a test can hand it sets, drills and agents and read the answer.
 */
import { agentArchiveName, type BackupSet } from './backups.js';
import type { DrillRecord } from './drills.js';

/** A newest usable copy older than this many days is stale. */
export const STALE_DAYS = 2;
/** How many recent finished sets "left out of" counts. */
export const RECENT_SETS = 7;
/** How many sets the guided restore offers. */
const RESTORABLE_MAX = 14;

export type ReadinessStatus = 'ready' | 'never drilled' | 'drill failed' | 'stale' | 'not covered' | 'new';

export interface ReadinessAgentIn {
  id: string;
  name: string;
  runtimeRef?: string;
  createdAt: string;
  hostId: string;
  state: string;
}

export interface HostView {
  name: string;
  local: boolean;
  /** The runner's cached answer; undefined when not checked. */
  reachable?: boolean;
}

export interface LeftOut {
  /** Recent finished sets made after the agent that do not hold it usably. */
  count: number;
  /** How many recent finished sets were looked at. */
  of: number;
  asleep: number;
  failed: number;
  missing: number;
  other: number;
}

export interface AgentReadiness {
  agentId: string;
  name: string;
  hostId: string;
  /** The machine it lives on, when that is a runner. */
  runner?: { name: string; reachable?: boolean };
  /**
   * The newest set a restore could use (Restore…'s first choice), otherKey
   * when another install made it. The status reads this install's own sets
   * only (computeReadiness).
   */
  latestUsable?: { date: string; ageDays: number; sizeBytes: number; complete: boolean | null; otherKey?: true };
  /**
   * This install's own newest set a restore could use: what Restore… picks
   * first, before another install's newer one (eighth review).
   */
  ownLatest?: { date: string; ageDays: number; sizeBytes: number; complete: boolean | null };
  /** The sets a restore can use for it, newest first: the guided restore's choices (this install's own kept first, up to 14). */
  restorable: Array<{ date: string; sizeBytes: number; complete: boolean | null; drill?: 'passed' | 'failed'; otherKey?: true }>;
  leftOut: LeftOut;
  drill?: { at: string; set: string; passed: boolean; restored: boolean | null; checks: string[] };
  status: ReadinessStatus;
  /** The status in plain words, for the Recovery row and the table. */
  line: string;
  /** Set when it belongs under Alerts (the fold: see computeReadiness). */
  alert?: { key: string; why: string };
}

export interface ReadinessResult {
  agents: AgentReadiness[];
  /** The newest finished set's date, if any. */
  newestSet?: string;
  /** Whether that set is at most STALE_DAYS old. Not: the machine's own alert says the backups are late. */
  newestFresh: boolean;
  staleDays: number;
}

/** Whole days since a set's date (local midnight), as the machine line counts them. */
export function setAgeDays(date: string, now: number): number {
  // By the calendar: the day the clocks go back has 25 hours.
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.max(0, Math.round((day(new Date(now)) - day(new Date(`${date}T00:00:00`))) / 86_400_000));
}

/**
 * Whether a restore can use this set for the volume: its archive is there,
 * and the set's record allows it — complete, from before the record, or
 * incomplete with this volume captured whole. Captured whole wins over failed:
 * a later run of the same day that failed on it keeps the earlier run's whole
 * archive (the script replaces one only by renaming a whole one over it) and
 * names the volume in both lists; read as failed, the day's good archive was
 * hidden and an older day's offered instead (HB-0471).
 */
export function usableFor(set: BackupSet, vol: string): boolean {
  if (set.running) return false;
  if (!set.volumes.some((v) => v.file === `${vol}.tgz`)) return false;
  if (set.captured?.includes(vol)) return true;
  if ((set.failedVolumes ?? []).includes(vol)) return false;
  if (set.complete !== false) return true;
  // Incomplete: the record must say this one was captured (a record from
  // before the field: an archive there and not failed is a whole one, since
  // the script renames it from .part only once it is).
  return set.captured ? set.captured.includes(vol) : true;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const DRILL_NOTE: Record<string, string> = {
  unreadable: 'its archive could not be read',
  layout: 'its archive holds no OpenClaw files',
  extract: 'it did not restore into a fresh volume',
  timeout: 'restoring it took too long',
  nodocker: 'docker was not answering',
};

function drillChecks(v: DrillRecord['volumes'][number]): string[] {
  const out: string[] = [];
  if (v.readable) out.push('archive read whole');
  else if (v.readable === false) out.push('archive unreadable');
  if (v.layout) out.push('OpenClaw files found');
  else if (v.layout === false) out.push('no OpenClaw files');
  if (v.restored === true) out.push('restored into a throwaway volume with no network');
  else if (v.restored === false) out.push(DRILL_NOTE[v.note] ?? 'restore failed');
  else if (v.note === 'budget') out.push('not restored this time (the hour ran out)');
  else if (v.note === 'nodocker') out.push('not restored (docker was not answering)');
  else if (v.note === 'missing') out.push('its archive is not in the set');
  return out;
}

export function computeReadiness(input: {
  sets: BackupSet[];
  drills: DrillRecord[];
  agents: ReadinessAgentIn[];
  host: (hostId: string) => HostView | undefined;
  now: number;
}): ReadinessResult {
  const { now } = input;
  const finished = input.sets.filter((s) => !s.running).sort((a, b) => b.date.localeCompare(a.date));
  // A set made by another install or under an earlier key (BackupSet.foreign)
  // is a copy a restore can use, labelled, but never this machine's newest
  // set, nor one that "left out" an agent it was never this install's to take.
  const own = finished.filter((s) => !s.foreign);
  const newest = own[0];
  const newestFresh = !!newest && setAgeDays(newest.date, now) <= STALE_DAYS;
  const drills = [...input.drills].sort((a, b) => b.id.localeCompare(a.id));
  const setStart = (s: BackupSet) => Date.parse(s.startedAt ?? '') || Date.parse(`${s.date}T00:00:00`);

  const agents: AgentReadiness[] = [];
  for (const a of input.agents) {
    if (!a.runtimeRef || a.state === 'DELETED') continue;
    const vol = agentArchiveName(a.runtimeRef).replace(/\.tgz$/, '');
    const h = input.host(a.hostId);
    const runner = h && !h.local ? { name: h.name, ...(h.reachable !== undefined ? { reachable: h.reachable } : {}) } : undefined;
    const made = Date.parse(a.createdAt);

    const drillOf = (date: string): 'passed' | 'failed' | undefined => {
      const d = drills.find((r) => r.set === date && r.volumes.some((v) => v.volume === vol));
      return d ? (d.volumes.find((v) => v.volume === vol)!.passed ? 'passed' : 'failed') : undefined;
    };
    // Another install's sets are cut first: this install's own fill the list,
    // up to RESTORABLE_MAX, then the newest of the others. Newest first
    // overall, 15 newer foreign sets cut the own one from it, and Restore…
    // had no own set to pick (tenth review).
    const usable = finished.filter((s) => usableFor(s, vol));
    const kept = new Set([...usable.filter((s) => !s.foreign), ...usable.filter((s) => s.foreign)].slice(0, RESTORABLE_MAX));
    const restorable = usable.filter((s) => kept.has(s)).map((s) => {
      const d = drillOf(s.date);
      return {
        date: s.date, sizeBytes: s.volumes.find((v) => v.file === `${vol}.tgz`)?.sizeBytes ?? 0, complete: s.complete ?? null,
        ...(d ? { drill: d } : {}), ...(s.foreign ? { otherKey: true as const } : {}),
      };
    });
    const first = restorable[0];
    const latestUsable = first ? { date: first.date, ageDays: setAgeDays(first.date, now), sizeBytes: first.sizeBytes, complete: first.complete, ...(first.otherKey ? { otherKey: true as const } : {}) } : undefined;
    // Ready, stale or covered by this install's own sets only: another
    // install's set (or one made under an earlier key) that holds an archive
    // of the same name is a restore choice, labelled, never its proof.
    const ownSet = own.find((s) => usableFor(s, vol));
    const best = ownSet ? { date: ownSet.date, ageDays: setAgeDays(ownSet.date, now), sizeBytes: ownSet.volumes.find((v) => v.file === `${vol}.tgz`)?.sizeBytes ?? 0, complete: ownSet.complete ?? null } : undefined;
    const otherCopy = first?.otherKey && (!best || first.date > best.date) ? first.date : '';

    // The recent sets it was due in: made after the agent was.
    const due = own.slice(0, RECENT_SETS).filter((s) => !Number.isFinite(made) || setStart(s) > made);
    const leftOut: LeftOut = { count: 0, of: due.length, asleep: 0, failed: 0, missing: 0, other: 0 };
    for (const s of due) {
      if (usableFor(s, vol)) continue;
      leftOut.count++;
      if ((s.skipped ?? []).includes(vol)) leftOut.asleep++;
      else if ((s.missing ?? []).includes(vol)) leftOut.missing++;
      else if ((s.failedVolumes ?? []).includes(vol) || s.volumes.some((v) => v.file === `${vol}.tgz`)) leftOut.failed++;
      else leftOut.other++;
    }

    // This install's records only (listDrills filters by owner as the sets
    // are): another install's newest record naming the volume is not its proof.
    const rec = drills.find((r) => r.volumes.some((v) => v.volume === vol));
    const rv = rec?.volumes.find((v) => v.volume === vol);
    const drill = rec && rv ? { at: rec.finishedAt || rec.startedAt, set: rec.set, passed: rv.passed, restored: rv.restored, checks: drillChecks(rv) } : undefined;

    const newAgent = !best && (!newest || (Number.isFinite(made) && made >= setStart(newest)));
    const status: ReadinessStatus = !best ? (newAgent && newest ? 'new' : 'not covered')
      : best.ageDays > STALE_DAYS ? 'stale'
      : drill && !drill.passed ? 'drill failed'
      : !drill ? 'never drilled'
      : 'ready';

    // Why it was left out, in words: "left out of the last 3 backups: its machine (Laptop runner) was asleep or offline".
    const why: string[] = [];
    if (leftOut.asleep) why.push(`${runner ? `its machine (${runner.name})` : 'its machine'} was asleep or offline${leftOut.asleep < leftOut.count ? ` (${leftOut.asleep})` : ''}`);
    if (leftOut.failed) why.push(`its archive failed${leftOut.failed < leftOut.count ? ` (${leftOut.failed})` : ''}`);
    if (leftOut.missing) why.push(`its volume was not there${leftOut.missing < leftOut.count ? ` (${leftOut.missing})` : ''}`);
    if (leftOut.other) why.push(`it was not taken${leftOut.other < leftOut.count ? ` (${leftOut.other})` : ''}`);
    const leftWords = leftOut.count ? ` — left out of ${leftOut.count === leftOut.of ? (leftOut.count === 1 ? 'the last backup' : `the last ${leftOut.count} backups`) : `${leftOut.count} of the last ${plural(leftOut.of, 'backup')}`}: ${why.join('; ')}` : '';
    const runnerWords = runner?.reachable === false ? ` ${runner.name} is not answering now.` : '';
    const drillWords = drill ? (drill.passed ? `last drill ${drill.at.slice(0, 10)} passed` : `the last drill (${drill.at.slice(0, 10)}) failed: ${drill.checks.filter((c) => !/read whole|files found/.test(c)).join(', ') || 'see Settings → Backups'}`) : 'never drilled';
    const otherWords = otherCopy ? ` A ${best ? 'newer ' : ''}copy made by another install, or under an earlier key, is from ${otherCopy}.` : '';
    const line = status === 'new' ? `Not backed up yet — it was made after the last backup.${otherWords}`
      : status === 'not covered' ? `${otherCopy ? 'None of this install\'s backups holds it' : 'No backup holds it'}${leftWords}.${runnerWords}${otherWords}`
      : status === 'stale' ? `Its newest backup is from ${best!.date} (${plural(best!.ageDays, 'day')} ago)${leftWords}.${runnerWords}${otherWords}`
      : `Recoverable from ${best!.date} · ${drillWords}${otherWords ? `.${otherWords}` : ''}`;

    // The fold: an agent's own alert only while the machine's newest set is
    // fresh and left it out. When the whole machine is late, its own alert
    // says so once (web: v2MachineAlerts), not once per agent.
    const alert = (status === 'stale' || status === 'not covered') && newestFresh && !usableFor(newest!, vol) && a.state !== 'ARCHIVED'
      ? { key: `recovery:${best?.date ?? 'none'}`, why: `${line.replace(/\.$/, '')} (its settings → Advanced → Recovery)` }
      : undefined;

    agents.push({
      agentId: a.id, name: a.name, hostId: a.hostId,
      ...(runner ? { runner } : {}),
      ...(latestUsable ? { latestUsable } : {}),
      ...(best ? { ownLatest: best } : {}),
      restorable, leftOut,
      ...(drill ? { drill } : {}),
      status, line,
      ...(alert ? { alert } : {}),
    });
  }
  return { agents, ...(newest ? { newestSet: newest.date } : {}), newestFresh, staleDays: STALE_DAYS };
}
