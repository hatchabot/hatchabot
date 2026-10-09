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
  latestUsable?: { date: string; ageDays: number; sizeBytes: number; complete: boolean | null };
  /** The sets a restore can use for it, newest first: the guided restore's choices. */
  restorable: Array<{ date: string; sizeBytes: number; complete: boolean | null; drill?: 'passed' | 'failed' }>;
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
  return Math.max(0, Math.floor((now - Date.parse(`${date}T00:00:00`)) / 86_400_000));
}

/**
 * Whether a restore can use this set for the volume: its archive is there,
 * and the set's record allows it — complete, from before the record, or
 * incomplete with this volume captured whole (and not among the failed).
 */
export function usableFor(set: BackupSet, vol: string): boolean {
  if (set.running) return false;
  if (!set.volumes.some((v) => v.file === `${vol}.tgz`)) return false;
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
  const newest = finished[0];
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
    const restorable = finished.filter((s) => usableFor(s, vol)).slice(0, RESTORABLE_MAX).map((s) => {
      const d = drillOf(s.date);
      return { date: s.date, sizeBytes: s.volumes.find((v) => v.file === `${vol}.tgz`)?.sizeBytes ?? 0, complete: s.complete ?? null, ...(d ? { drill: d } : {}) };
    });
    const best = restorable[0];
    const latestUsable = best ? { date: best.date, ageDays: setAgeDays(best.date, now), sizeBytes: best.sizeBytes, complete: best.complete } : undefined;

    // The recent sets it was due in: made after the agent was.
    const due = finished.slice(0, RECENT_SETS).filter((s) => !Number.isFinite(made) || setStart(s) > made);
    const leftOut: LeftOut = { count: 0, of: due.length, asleep: 0, failed: 0, missing: 0, other: 0 };
    for (const s of due) {
      if (usableFor(s, vol)) continue;
      leftOut.count++;
      if ((s.skipped ?? []).includes(vol)) leftOut.asleep++;
      else if ((s.missing ?? []).includes(vol)) leftOut.missing++;
      else if ((s.failedVolumes ?? []).includes(vol) || s.volumes.some((v) => v.file === `${vol}.tgz`)) leftOut.failed++;
      else leftOut.other++;
    }

    const rec = drills.find((r) => r.volumes.some((v) => v.volume === vol));
    const rv = rec?.volumes.find((v) => v.volume === vol);
    const drill = rec && rv ? { at: rec.finishedAt || rec.startedAt, set: rec.set, passed: rv.passed, restored: rv.restored, checks: drillChecks(rv) } : undefined;

    const newAgent = !best && (!newest || (Number.isFinite(made) && made >= setStart(newest)));
    const status: ReadinessStatus = !best ? (newAgent && newest ? 'new' : 'not covered')
      : latestUsable!.ageDays > STALE_DAYS ? 'stale'
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
    const line = status === 'new' ? 'Not backed up yet — it was made after the last backup.'
      : status === 'not covered' ? `No backup holds it${leftWords}.${runnerWords}`
      : status === 'stale' ? `Its newest backup is from ${best!.date} (${plural(latestUsable!.ageDays, 'day')} ago)${leftWords}.${runnerWords}`
      : `Recoverable from ${best!.date} · ${drillWords}`;

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
      restorable, leftOut,
      ...(drill ? { drill } : {}),
      status, line,
      ...(alert ? { alert } : {}),
    });
  }
  return { agents, ...(newest ? { newestSet: newest.date } : {}), newestFresh, staleDays: STALE_DAYS };
}
