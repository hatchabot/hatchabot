/**
 * Reads and manages the on-disk backup sets that scripts/backup-volumes.sh
 * writes — one dated directory per run, each holding the control-plane DB, the
 * secret key, and one .tgz per agent volume. Nothing here ever serves those
 * files (they hold plaintext bot tokens and the decryption key); it exposes
 * only metadata — dates, sizes, what's present — and lets the machine's owner
 * trigger a run or prune an old one.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A dated backup directory is exactly `YYYY-MM-DD`, matching what the script
// creates (`date +%F`) and prunes. Anything else in the base dir is ignored,
// and this same shape gates prune against path traversal.
const DATE_DIR = /^20\d\d-\d\d-\d\d$/;

const SCRIPT = resolve(fileURLToPath(import.meta.url), '../../../scripts/backup-volumes.sh');

/** Where the script writes, mirroring its own `BASE=` default exactly. */
export function backupsDir(): string {
  return process.env.AGENTCLAW_BACKUP_DIR || join(homedir(), 'agentclaw-backups');
}

/** Retention the script enforces, surfaced so the panel can say how long a
 *  backup will live. */
export function keepDays(): number {
  const n = Number(process.env.AGENTCLAW_BACKUP_KEEP_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 14;
}

export interface BackupVolume {
  /** the agent volume, prefix stripped for readability (e.g. "kitchen-helper") */
  name: string;
  sizeBytes: number;
}

export interface BackupSet {
  date: string;
  sizeBytes: number;
  hasDb: boolean;
  /** whether the secret key rode along — without it the backup can't be decrypted */
  hasKey: boolean;
  volumes: BackupVolume[];
}

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
  const prefix = `${process.env.AGENTCLAW_PREFIX || 'agentclaw'}-`;
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
        volumes.push({ name: stem.startsWith(prefix) ? stem.slice(prefix.length) : stem, sizeBytes: size });
      }
    }
    volumes.sort((a, b) => a.name.localeCompare(b.name));
    sets.push({
      date: entry,
      sizeBytes,
      hasDb: files.includes('agentclaw.sqlite'),
      hasKey: files.includes('secret-key.env'),
      volumes,
    });
  }
  sets.sort((a, b) => b.date.localeCompare(a.date));
  return sets;
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
