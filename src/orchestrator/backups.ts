/**
 * Reads and manages the on-disk backup sets that scripts/backup-volumes.sh
 * writes — one dated directory per run, each holding the control-plane DB, the
 * secret key, and one .tgz per agent volume. Nothing here ever serves those
 * files (they hold plaintext bot tokens and the decryption key); it exposes
 * only metadata — dates, sizes, what's present — and lets the machine's owner
 * trigger a run or prune an old one.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defaultBackupsDir } from '../envCompat.js';
import { fileURLToPath } from 'node:url';
import type { RuntimeProvider } from '../providers/provider.js';
import type { Store } from '../store/store.js';
import { forgetDmPolicy } from './dmPolicyMemo.js';

// A dated backup directory is exactly `YYYY-MM-DD`, matching what the script
// creates (`date +%F`) and prunes. Anything else in the base dir is ignored,
// and this same shape gates prune against path traversal.
const DATE_DIR = /^20\d\d-\d\d-\d\d$/;

const SCRIPT = resolve(fileURLToPath(import.meta.url), '../../../scripts/backup-volumes.sh');

/** Where the script writes, mirroring its own `BASE=` default exactly. */
export function backupsDir(): string {
  return process.env.HATCHABOT_BACKUP_DIR || defaultBackupsDir();
}

/** Retention the script enforces, surfaced so the panel can say how long a
 *  backup will live. */
export function keepDays(): number {
  const n = Number(process.env.HATCHABOT_BACKUP_KEEP_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 14;
}

export interface BackupVolume {
  /** the agent volume, prefix stripped for readability (e.g. "kitchen-helper") */
  name: string;
  /** raw tarball basename, so a caller can match it back to a live agent */
  file: string;
  sizeBytes: number;
}

export interface BackupSet {
  date: string;
  sizeBytes: number;
  hasDb: boolean;
  /** whether the secret key rode along — without it the backup can't be decrypted */
  hasKey: boolean;
  volumes: BackupVolume[];
  /**
   * Whether the run that wrote this set finished with every volume in, from
   * its backup-status.json. False: a volume failed, the run refused, or it
   * never finished. Undefined: no record (a set from before the record, or a
   * run still going). The dated directory alone said nothing — it exists
   * before the first volume is in (review, 2026-09-29).
   */
  complete?: boolean;
  /** The run is still writing this set. */
  running?: boolean;
  /** Volumes that failed to archive. */
  failedVolumes?: string[];
  /** Volumes no agent uses, left out of the set (a leftover to remove by hand). */
  orphans?: string[];
  /** When the run started (ISO), from the record. */
  startedAt?: string;
}

/** A run that has said "running" this long without a verdict was killed. */
const RUN_STALE_MS = 6 * 3600_000;

/** What a set's backup-status.json says, read defensively (the file is the script's, not ours). */
export function readSetStatus(dir: string, now = Date.now()): Pick<BackupSet, 'complete' | 'running' | 'failedVolumes' | 'orphans' | 'startedAt'> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, STATUS_FILE), 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 500) : []);
  const startedAt = typeof r.startedAt === 'string' ? r.startedAt : undefined;
  const out: Pick<BackupSet, 'complete' | 'running' | 'failedVolumes' | 'orphans' | 'startedAt'> = {
    ...(startedAt ? { startedAt } : {}),
    failedVolumes: names(r.failedVolumes),
    orphans: names(r.orphans),
  };
  if (r.state === 'complete') out.complete = true;
  else if (r.state === 'running') {
    // Killed outright (no trap ran) reads as unfinished once it is hours old.
    if (now - (Date.parse(startedAt ?? '') || 0) > RUN_STALE_MS) out.complete = false;
    else out.running = true;
  } else out.complete = false;
  return out;
}

export const STATUS_FILE = 'backup-status.json';

function safeStatSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/** Every backup set on disk, newest first. Missing base dir → []. */
export function listBackups(base = backupsDir()): BackupSet[] {
  if (!existsSync(base)) return [];
  const prefixes = [`${process.env.HATCHABOT_PREFIX || 'hatchabot'}-`, 'agentclaw-'];
  const sets: BackupSet[] = [];
  for (const entry of readdirSync(base)) {
    if (!DATE_DIR.test(entry)) continue;
    const dir = join(base, entry);
    let files: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      files = readdirSync(dir);
    } catch {
      continue;
    }
    let sizeBytes = 0;
    const volumes: BackupVolume[] = [];
    for (const f of files) {
      const size = safeStatSize(join(dir, f));
      sizeBytes += size;
      if (f.endsWith('.tgz')) {
        const stem = f.slice(0, -'.tgz'.length);
        volumes.push({
          name: (() => { const p = prefixes.find((x) => stem.startsWith(x)); return p ? stem.slice(p.length) : stem; })(),
          file: f,
          sizeBytes: size,
        });
      }
    }
    volumes.sort((a, b) => a.name.localeCompare(b.name));
    sets.push({
      date: entry,
      sizeBytes,
      hasDb: files.includes('hatchabot.sqlite') || files.includes('agentclaw.sqlite'),
      hasKey: files.includes('secret-key.env'),
      volumes,
      ...readSetStatus(dir),
    });
  }
  sets.sort((a, b) => b.date.localeCompare(a.date));
  return sets;
}

/**
 * Active agents whose volume is not in this set — an agent on another
 * machine (a runner) is never in it, since the nightly script archives only
 * this machine's volumes, and the panel listed only what a set holds, so
 * nothing said so (review, 2026-09-29). Agents made after the run started
 * are not "missing" from it.
 */
export function agentsMissingFromSet(
  set: Pick<BackupSet, 'date' | 'volumes' | 'startedAt'>,
  agents: Array<{ id: string; name: string; runtimeRef?: string; createdAt: string; hostId: string }>,
  hostName: (hostId: string) => string | undefined,
): Array<{ agentId: string; name: string; host?: string }> {
  const have = new Set(set.volumes.map((v) => v.file));
  const cutoff = Date.parse(set.startedAt ?? '') || Date.parse(`${set.date}T00:00:00`);
  const out: Array<{ agentId: string; name: string; host?: string }> = [];
  for (const a of agents) {
    if (!a.runtimeRef || have.has(agentArchiveName(a.runtimeRef))) continue;
    const made = Date.parse(a.createdAt);
    if (Number.isFinite(made) && made >= cutoff) continue;
    const host = hostName(a.hostId);
    out.push({ agentId: a.id, name: a.name, ...(host ? { host } : {}) });
  }
  return out;
}

/** Delete one dated backup set. Refuses anything that isn't a `YYYY-MM-DD`
 *  directory living directly under the base — so a crafted date can never
 *  escape the backups dir. Returns whether something was removed. */
export function pruneBackup(date: string, base = backupsDir()): boolean {
  if (!DATE_DIR.test(date)) throw new Error('Not a backup date.');
  const target = resolve(base, date);
  // Belt to the regex's suspenders: the resolved path must sit exactly one
  // level under the (resolved) base — no `..`, no symlink hop out.
  if (dirname(target) !== resolve(base)) throw new Error('Refusing to delete outside the backups directory.');
  if (!existsSync(target)) return false;
  rmSync(target, { recursive: true, force: true });
  return true;
}

// ---- "Back up now" -------------------------------------------------------
// The script can take minutes on large volumes, far longer than an HTTP
// request should hang. So a run is fire-and-poll: start it, watch a small
// in-memory state, and let the panel ask how it went.

export type BackupRunStatus = 'idle' | 'running' | 'ok' | 'error';

export interface BackupRunState {
  status: BackupRunStatus;
  startedAt?: number;
  /** tail of the script's own output — progress lines, never file contents */
  summary?: string;
}

let runState: BackupRunState = { status: 'idle' };

export function backupRunState(): BackupRunState {
  return runState;
}

/**
 * Start a backup unless one is already running (in which case the current
 * state is returned unchanged — the button is idempotent). `now` is injected
 * so callers can stamp times without this module reaching for the clock.
 */
export function startBackup(now: number): BackupRunState {
  if (runState.status === 'running') return runState;
  runState = { status: 'running', startedAt: now };

  const lines: string[] = [];
  const capture = (buf: Buffer) => {
    for (const l of buf.toString('utf8').split('\n')) if (l.trim()) lines.push(l);
    // Keep only the tail — a big run shouldn't grow this without bound.
    if (lines.length > 40) lines.splice(0, lines.length - 40);
  };

  let child;
  try {
    child = spawn('bash', [SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    runState = { status: 'error', startedAt: runState.startedAt, summary: String((err as Error)?.message ?? err) };
    return runState;
  }
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  child.on('error', (err) => {
    runState = {
      status: 'error',
      startedAt: runState.startedAt,
      summary: `Couldn't run the backup script: ${err.message}`,
    };
  });
  child.on('close', (code) => {
    // A run that already errored out (spawn error event) stays errored.
    if (runState.status !== 'running') return;
    runState = {
      status: code === 0 ? 'ok' : 'error',
      startedAt: runState.startedAt,
      summary: lines.slice(-15).join('\n') || (code === 0 ? 'Backup complete.' : `Backup failed (exit ${code}).`),
    };
  });
  return runState;
}

// ---- restore ONE agent from a backup set ---------------------------------

export class RestoreError extends Error {
  constructor(public userMessage: string) {
    super(userMessage);
    this.name = 'RestoreError';
  }
}

/**
 * The tarball basename the nightly script wrote for a runtime's volume. The
 * backup archives each `${PREFIX}-*` docker volume as `<volume>.tgz`, and the
 * docker provider's volume for `<scheme>://<name>` is `<name>-vol`. This is the
 * one place that convention is re-derived; it's docker-specific by design, like
 * the rest of the backup subsystem (the script, exportState, importState).
 */
export function agentArchiveName(runtimeRef: string): string {
  return `${runtimeRef.replace(/^\w+:\/\//, '')}-vol.tgz`;
}

export interface RestoreResult {
  date: string;
  /** whether the agent was running before, and was started again after */
  running: boolean;
}

/**
 * Replace ONE agent's entire volume with the copy from a backup set — the
 * "more complete than a snapshot" restore. Destructive: it overwrites live
 * memory, so the agent is stopped for the swap and only restarted if it was
 * running before. A safety copy of the current volume is taken first and rolled
 * back if the extract fails, so a broken archive can't leave a half-written
 * volume. The caller is responsible for the busy guard and for gating this to
 * the machine's owner.
 */
export async function restoreAgentFromBackup(
  deps: { store: Store; provider: RuntimeProvider; log?: (e: string, d: Record<string, unknown>) => void },
  agentId: string,
  date: string,
): Promise<RestoreResult> {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});
  if (!DATE_DIR.test(date)) throw new RestoreError('Not a backup date.');

  const agent = store.getAgent(agentId);
  if (!agent?.runtimeRef) throw new RestoreError('This agent has no runtime to restore into yet.');
  if (agent.state !== 'RUNNING' && agent.state !== 'STOPPED') {
    throw new RestoreError(`Can't restore while the agent is ${agent.state}.`);
  }

  const file = join(backupsDir(), date, agentArchiveName(agent.runtimeRef));
  if (!existsSync(file)) {
    throw new RestoreError(`The ${date} backup doesn't contain this agent.`);
  }
  const data = readFileSync(file);

  const wasRunning = agent.state === 'RUNNING';
  if (wasRunning) {
    await provider.stop(agent.runtimeRef);
    store.setAgentState(agentId, 'STOPPED');
  }

  const restartIfWasRunning = async () => {
    if (!wasRunning) return;
    try {
      await provider.start(agent.runtimeRef!);
      store.setAgentState(agentId, 'RUNNING');
    } catch (startErr) {
      log('restore.restart_failed', { agentId, error: String(startErr) });
    }
  };

  // Safety net: capture the current volume so a failed extract can be undone.
  // No copy, no restore: the extract empties the volume first, so a failure
  // part-way left nothing to go back to (night review, 2026-09-27).
  let safety: Buffer | undefined;
  try {
    safety = await provider.exportState(agent.runtimeRef);
  } catch (err) {
    log('restore.safety_capture_failed', { agentId, error: String(err) });
    await restartIfWasRunning();
    // No pointer at Download copy: it tars the same volume the same way, so it
    // fails for the same reason (review, 2026-09-29).
    throw new RestoreError(
      "Its current state could not be copied first, so the restore would not be undoable — nothing was changed. " +
        "Try again in a moment; if it keeps failing, check this machine's free disk space.",
    );
  }

  forgetDmPolicy(agentId); // the restored config is whatever the archive held
  try {
    await provider.importState(agent.runtimeRef, data);
  } catch (err) {
    // The volume may be half-overwritten. Put the pre-restore state back if we
    // captured it, so a broken archive never corrupts a working agent.
    if (safety) {
      try {
        await provider.importState(agent.runtimeRef, safety);
      } catch (rollbackErr) {
        log('restore.rollback_failed', { agentId, error: String(rollbackErr) });
      }
    }
    await restartIfWasRunning();
    throw new RestoreError("Restore failed — the agent was left as it was.");
  }

  log('agent.restored', { agentId, date });
  await restartIfWasRunning();
  // What it IS now, not what it was: a failed restart used to report "restarting".
  return { date, running: deps.store.getAgent(agentId)?.state === 'RUNNING' };
}
