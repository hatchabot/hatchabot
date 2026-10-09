/**
 * Restore drills (docs/recovery-readiness-design.md): the records
 * scripts/restore-drill.sh writes under <backups>/drills/, the opt-in
 * schedule (HATCHABOT_DRILL_EVERY), and running the drill from the app.
 * Nothing here restores anything itself: the script does, in its throwaway
 * containers with no network and no secrets mounted.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupsDir } from './backups.js';

const SCRIPT = resolve(fileURLToPath(import.meta.url), '../../../scripts/restore-drill.sh');

/** How a volume fared in a drill, as the script recorded it. */
export interface DrillVolume {
  volume: string;
  readable: boolean | null;
  layout: boolean | null;
  /** true: restored into a throwaway and its files found; false: that failed; null: not tried. */
  restored: boolean | null;
  /** '' | unreadable | layout | extract | timeout | budget | nodocker */
  note: string;
  passed: boolean;
}

export interface DrillRecord {
  /** The record's file name, newest sorts last. */
  id: string;
  /** The set drilled ('' when none was found). */
  set: string;
  setState: string;
  startedAt: string;
  finishedAt: string;
  durationSec: number;
  trigger: string;
  passed: boolean;
  reason: string;
  database: string;
  key: string;
  volumes: DrillVolume[];
}

export function drillsDir(base = backupsDir()): string {
  return join(base, 'drills');
}

const RECORD = /^20\d\d-\d\d-\d\dT\d\d-\d\d-\d\dZ\.json$/;

/** Every drill record, newest first (at most 30: the script keeps that many). Read defensively: the files are the script's. */
export function listDrills(base = backupsDir()): DrillRecord[] {
  const dir = drillsDir(base);
  if (!existsSync(dir)) return [];
  let files: string[];
  try { files = readdirSync(dir).filter((f) => RECORD.test(f)); } catch { return []; }
  const out: DrillRecord[] = [];
  for (const f of files.sort().reverse().slice(0, 30)) {
    let r: Record<string, unknown>;
    try { r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>; } catch { continue; }
    if (!r || typeof r !== 'object') continue;
    const s = (v: unknown) => (typeof v === 'string' ? v.slice(0, 80) : '');
    const b = (v: unknown) => (typeof v === 'boolean' ? v : null);
    const volumes = (Array.isArray(r.volumes) ? r.volumes : []).slice(0, 500).flatMap((v): DrillVolume[] => {
      if (!v || typeof v !== 'object' || typeof (v as { volume?: unknown }).volume !== 'string') return [];
      const x = v as Record<string, unknown>;
      return [{ volume: s(x.volume), readable: b(x.readable), layout: b(x.layout), restored: b(x.restored), note: s(x.note), passed: x.result === 'passed' }];
    });
    out.push({
      id: f.replace(/\.json$/, ''),
      set: s(r.set), setState: s(r.setState), startedAt: s(r.startedAt), finishedAt: s(r.finishedAt),
      durationSec: Number.isFinite(Number(r.durationSec)) ? Number(r.durationSec) : 0,
      trigger: s(r.trigger), passed: r.result === 'passed', reason: s(r.reason),
      database: s(r.database), key: s(r.key), volumes,
    });
  }
  return out;
}

// ---- the schedule -----------------------------------------------------------

export type DrillEvery = 'off' | 'weekly' | 'daily';
export const DRILL_EVERY: DrillEvery[] = ['off', 'weekly', 'daily'];

/** HATCHABOT_DRILL_EVERY; anything else is off (automated drills are opt-in). */
export function drillEvery(env: NodeJS.ProcessEnv = process.env): DrillEvery {
  const v = (env.HATCHABOT_DRILL_EVERY ?? '').trim().toLowerCase();
  return (DRILL_EVERY as string[]).includes(v) ? (v as DrillEvery) : 'off';
}

/** The quiet hours a scheduled drill starts in, local time: after the 03:30 backup and the 03–05 rebuilds. */
export const DRILL_HOURS = { from: 5, to: 7 };

/**
 * Whether a scheduled drill should start now. Off unless asked for; in the
 * quiet hours; after today's backup has finished (and none is running); one
 * at a time; and not before the period since the last drill has passed.
 */
export function drillDue(o: {
  every: DrillEvery;
  now: Date;
  /** The newest set: its date and whether its run is still going. */
  newestSet?: { date: string; running?: boolean };
  backupRunning: boolean;
  drillRunning: boolean;
  /** When the last drill started (ISO), any trigger. */
  lastDrillAt?: string;
  /** Whether it passed: a failed one is tried again the next morning, not a week later. */
  lastDrillPassed?: boolean;
}): { due: boolean; why: string } {
  if (o.every === 'off') return { due: false, why: 'off' };
  if (o.drillRunning) return { due: false, why: 'a drill is running' };
  if (o.backupRunning || o.newestSet?.running) return { due: false, why: 'a backup is running' };
  const h = o.now.getHours();
  if (h < DRILL_HOURS.from || h >= DRILL_HOURS.to) return { due: false, why: 'outside the quiet hours' };
  const today = `${o.now.getFullYear()}-${String(o.now.getMonth() + 1).padStart(2, '0')}-${String(o.now.getDate()).padStart(2, '0')}`;
  if (!o.newestSet || o.newestSet.date !== today) return { due: false, why: "today's backup has not run" };
  const last = Date.parse(o.lastDrillAt ?? '');
  // A little short of the period, so a drill that started at 05:10 last week is due at 05:00.
  const period = (o.every === 'daily' || o.lastDrillPassed === false ? 1 : 7) * 86_400_000 - 3 * 3600_000;
  if (Number.isFinite(last) && o.now.getTime() - last < period) return { due: false, why: 'drilled recently' };
  return { due: true, why: 'due' };
}

// ---- running one ------------------------------------------------------------

export type DrillRunStatus = 'idle' | 'running' | 'ok' | 'error';
export interface DrillRunState {
  status: DrillRunStatus;
  startedAt?: number;
  trigger?: string;
  /** The tail of the script's output: progress lines, never file contents. */
  summary?: string;
}

let runState: DrillRunState = { status: 'idle' };
export function drillRunState(): DrillRunState {
  return runState;
}

/** A drill is killed after this long (its own restores stop at an hour). */
export const DRILL_KILL_MS = 90 * 60_000;

/**
 * Start a drill unless one is running (then the current state comes back
 * unchanged). The script runs under `nice`, with the server's environment
 * (its HATCHABOT_BACKUP_DIR) and its trigger for the record.
 */
export function startDrill(now: number, trigger: 'app' | 'scheduled', onFinish?: (state: DrillRunState) => void): DrillRunState {
  if (runState.status === 'running') return runState;
  // Under a test runner the real script would drill this machine's real
  // backups (as "Back up now" once did, 2026-10-03): tests name their own.
  const script = process.env.HATCHABOT_DRILL_SCRIPT ?? ((process.env.VITEST || process.env.NODE_ENV === 'test') ? '' : SCRIPT);
  if (!script) {
    runState = { status: 'error', startedAt: now, trigger, summary: 'Drills are not run under a test runner (set HATCHABOT_DRILL_SCRIPT to a test script).' };
    return runState;
  }
  runState = { status: 'running', startedAt: now, trigger };
  const settle = (next: DrillRunState) => {
    runState = next;
    try { onFinish?.(next); } catch { /* the record of a run never breaks the run */ }
  };
  const lines: string[] = [];
  const capture = (buf: Buffer) => {
    for (const l of buf.toString('utf8').split('\n')) if (l.trim()) lines.push(l);
    if (lines.length > 40) lines.splice(0, lines.length - 40);
  };
  let child;
  try {
    child = spawn('bash', ['-c', 'if command -v nice >/dev/null 2>&1; then exec nice -n 10 bash "$0"; else exec bash "$0"; fi', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HATCHABOT_DRILL_TRIGGER: trigger },
    });
  } catch (err) {
    runState = { status: 'error', startedAt: now, trigger, summary: String((err as Error)?.message ?? err) };
    return runState;
  }
  // SIGTERM: the script's EXIT trap removes its throwaway volume and writes its record.
  const killer = setTimeout(() => { lines.push('The drill took longer than 90 minutes and was stopped.'); child.kill('SIGTERM'); }, DRILL_KILL_MS);
  killer.unref?.();
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  child.on('error', (err) => {
    clearTimeout(killer);
    if (runState.status !== 'running') return;
    settle({ status: 'error', startedAt: now, trigger, summary: `Couldn't run the restore drill: ${err.message}` });
  });
  child.on('close', (code) => {
    clearTimeout(killer);
    if (runState.status !== 'running') return;
    settle({
      status: code === 0 ? 'ok' : 'error',
      startedAt: now,
      trigger,
      summary: lines.slice(-15).join('\n') || (code === 0 ? 'Restore drill passed.' : `Restore drill failed (exit ${code}).`),
    });
  });
  return runState;
}

/** Tests: forget a finished run. */
export function resetDrillStateForTests(): void {
  runState = { status: 'idle' };
}
