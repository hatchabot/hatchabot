/**
 * Reads and manages the on-disk backup sets that scripts/backup-volumes.sh
 * writes — one dated directory per run, each holding the control-plane DB, the
 * secret key, and one .tgz per agent volume. Nothing here ever serves those
 * files (they hold plaintext bot tokens and the decryption key); it exposes
 * only metadata — dates, sizes, what's present — and lets the machine's owner
 * trigger a run or prune an old one.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defaultBackupsDir } from '../envCompat.js';
import { fileURLToPath } from 'node:url';
import type { RuntimeProvider } from '../providers/provider.js';
import type { Store } from '../store/store.js';
import { forgetDmPolicy } from './dmPolicyMemo.js';
import { allowlistScrubScript, keepOnlyTelegramAccountScript, RESTORED_ACCESS_SCRIPT, revokedScrubTargets } from './members.js';
import { beginOperation, handleFor, rethrowIfCrash, type OpHandle } from './operations.js';

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
  /** When the run ended (ISO), from the record. */
  finishedAt?: string;
  /** Volumes an agent on this machine uses that docker did not have. */
  missing?: string[];
  /** Volumes on a runner that did not answer (asleep or offline): left out, not failed. */
  skipped?: string[];
  /**
   * Volumes whose archive was written whole (absent in a record from before
   * v2.157.0). What makes an agent recoverable from an incomplete set
   * (recoveryReadiness.ts).
   */
  captured?: string[];
}

type SetRecord = Pick<BackupSet, 'complete' | 'running' | 'failedVolumes' | 'orphans' | 'startedAt' | 'finishedAt' | 'missing' | 'skipped' | 'captured'>;

/** A run that has said "running" this long without a verdict was killed. */
const RUN_STALE_MS = 6 * 3600_000;

/** What a set's backup-status.json says, read defensively (the file is the script's, not ours). */
export function readSetStatus(dir: string, now = Date.now()): SetRecord {
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
  const finishedAt = typeof r.finishedAt === 'string' && r.state !== 'running' ? r.finishedAt : undefined;
  const out: SetRecord = {
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    failedVolumes: names(r.failedVolumes),
    orphans: names(r.orphans),
    ...(Array.isArray(r.missing) ? { missing: names(r.missing) } : {}),
    ...(Array.isArray(r.skipped) ? { skipped: names(r.skipped) } : {}),
    ...(Array.isArray(r.captured) ? { captured: names(r.captured) } : {}),
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
export function startBackup(now: number, onFinish?: (state: BackupRunState) => void): BackupRunState {
  if (runState.status === 'running') return runState;
  runState = { status: 'running', startedAt: now };
  const settle = (next: BackupRunState) => {
    runState = next;
    try { onFinish?.(next); } catch { /* the record of a run never breaks the run */ }
  };

  const lines: string[] = [];
  const capture = (buf: Buffer) => {
    for (const l of buf.toString('utf8').split('\n')) if (l.trim()) lines.push(l);
    // Keep only the tail — a big run shouldn't grow this without bound.
    if (lines.length > 40) lines.splice(0, lines.length - 40);
  };

  // Under a test runner the real script would back up THIS machine into the
  // real ~/hatchabot-backups: run from a checkout it found no database,
  // refused, and its "incomplete, 0 volumes" record replaced the night's real
  // one (2026-10-01 to 10-03, every test run). Tests name a script of their own.
  const script = process.env.HATCHABOT_BACKUP_SCRIPT ?? ((process.env.VITEST || process.env.NODE_ENV === 'test') ? '' : SCRIPT);
  if (!script) {
    runState = { status: 'error', startedAt: runState.startedAt, summary: 'Backups are not run under a test runner (set HATCHABOT_BACKUP_SCRIPT to a test script).' };
    return runState;
  }
  let child;
  try {
    child = spawn('bash', [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    runState = { status: 'error', startedAt: runState.startedAt, summary: String((err as Error)?.message ?? err) };
    return runState;
  }
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  child.on('error', (err) => {
    if (runState.status !== 'running') return;
    settle({
      status: 'error',
      startedAt: runState.startedAt,
      summary: `Couldn't run the backup script: ${err.message}`,
    });
  });
  child.on('close', (code) => {
    // A run that already errored out (spawn error event) stays errored.
    if (runState.status !== 'running') return;
    settle({
      status: code === 0 ? 'ok' : 'error',
      startedAt: runState.startedAt,
      summary: lines.slice(-15).join('\n') || (code === 0 ? 'Backup complete.' : `Backup failed (exit ${code}).`),
    });
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

/**
 * Where a restore keeps the copy it took of an agent's volume first, when
 * neither the restore nor putting that copy back worked: the agent's only
 * good state then lives in that file (issue #12). Beside the dated sets, but
 * not one of them, so listBackups and the nightly prune never touch it.
 */
export function restoreSafetyDir(): string {
  return join(backupsDir(), 'restore-safety');
}

/** Where this restore's copy of the volume goes (decided before it is written, so a restart knows). */
function safetyCopyPath(runtimeRef: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(restoreSafetyDir(), `${agentArchiveName(runtimeRef).replace(/\.tgz$/, '')}-before-restore-${stamp}.tgz`);
}

/** Write the pre-restore copy to disk, owner-only (it holds the agent's secrets). */
function keepSafetyCopy(file: string, safety: Buffer): void {
  const dir = restoreSafetyDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(file, safety, { mode: 0o600 });
}

/** A restore that ended either way no longer needs its copy (it holds secrets); the folder goes when empty. */
function dropSafetyCopy(file: string | undefined): void {
  if (!file || !file.startsWith(restoreSafetyDir())) return;
  try { rmSync(file, { force: true }); } catch { /* best effort */ }
  try { rmdirSync(restoreSafetyDir()); } catch { /* not empty, or gone */ }
}

function short(err: unknown): string {
  return String(err instanceof Error ? err.message : err).replace(/\s+/g, ' ').trim().slice(0, 200);
}

export interface RestoreResult {
  date: string;
  /** whether the agent was running before, and was started again after */
  running: boolean;
  /** What that night's copy had that Hatchabot's current settings undid: people since removed, an old bot. */
  undone?: string[];
}

/**
 * Replace ONE agent's entire volume with the copy from a backup set — the
 * "more complete than a snapshot" restore. Destructive: it overwrites live
 * memory, so the agent is stopped for the swap and only restarted if it was
 * running before. A safety copy of the current volume is taken first and rolled
 * back if the extract fails, so a broken archive can't leave a half-written
 * volume. That copy is written under restoreSafetyDir() BEFORE the volume is
 * replaced (and removed once the restore ends either way), so a restart in the
 * middle can still put it back (resumeBackupRestore). If the rollback fails
 * too, the agent is left stopped and FAILED and the copy stays there for
 * recovery. The caller is responsible for the busy guard and for gating this
 * to the machine's owner.
 */
export interface RestoreDeps {
  store: Store; provider: RuntimeProvider; log?: (e: string, d: Record<string, unknown>) => void;
  /** Put this installation's current settings (bot, members, model) back over the restored config, as Import and Move do. */
  reapply?: (runtimeRef: string) => Promise<void>;
  /** Who asked, for the operation's record. */
  requestedBy?: string;
  /** Told the operation's id once it begins (the route answers 202 with it). */
  onOperation?: (id: string) => void;
}

export async function restoreAgentFromBackup(
  deps: RestoreDeps,
  agentId: string,
  date: string,
): Promise<RestoreResult> {
  const { store } = deps;
  if (!DATE_DIR.test(date)) throw new RestoreError('Not a backup date.');

  const agent = store.getAgent(agentId);
  if (!agent?.runtimeRef) throw new RestoreError('This agent has no runtime to restore into yet.');
  // FAILED too: a restore that could not be undone leaves the agent FAILED
  // (below), and restoring a backup again is how it gets its memory back.
  if (agent.state !== 'RUNNING' && agent.state !== 'STOPPED' && agent.state !== 'FAILED') {
    throw new RestoreError(`Can't restore while the agent is ${agent.state}.`);
  }

  const file = join(backupsDir(), date, agentArchiveName(agent.runtimeRef));
  if (!existsSync(file)) {
    throw new RestoreError(`The ${date} backup doesn't contain this agent.`);
  }
  const data = readFileSync(file);

  const wasRunning = agent.state === 'RUNNING';
  const runtimeRef = agent.runtimeRef;
  // Recorded as it goes (operations.ts): a restart after the copy of how it
  // was is on disk holds the agent stopped for its owner's choice, and the
  // copy is there to put back (resumeBackupRestore).
  const safetyFile = safetyCopyPath(runtimeRef);
  const op = beginOperation(store, 'restore-backup', agentId, { date, wasRunning, safetyFile }, { requestedBy: deps.requestedBy });
  deps.onOperation?.(op.id);
  try {
    return await restoreSteps(deps, op, agentId, runtimeRef, date, data, wasRunning, safetyFile);
  } catch (err) {
    rethrowIfCrash(err);
    // Whatever was not recorded below (an unexpected error) ends the record too.
    const row = op.get();
    if (row.status === 'running') op.fail(err);
    throw err;
  }
}

async function restoreSteps(
  deps: RestoreDeps, op: OpHandle, agentId: string, runtimeRef: string, date: string, data: Buffer, wasRunning: boolean, safetyFile: string,
): Promise<RestoreResult> {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});
  if (wasRunning) {
    await provider.stop(runtimeRef);
    store.setAgentState(agentId, 'STOPPED');
  }
  op.step('stopped');

  const restartIfWasRunning = () => restartAfterRestore(deps, agentId, runtimeRef, wasRunning);
  const nothingChanged = async (why: string): Promise<never> => {
    await restartIfWasRunning();
    dropSafetyCopy(safetyFile);
    op.rolledBack(why);
    throw new RestoreError(why);
  };

  // Safety net: capture the current volume so a failed extract can be undone.
  // No copy, no restore: the extract empties the volume first, so a failure
  // part-way left nothing to go back to (night review, 2026-09-27).
  let safety: Buffer;
  try {
    safety = await provider.exportState(runtimeRef);
  } catch (err) {
    rethrowIfCrash(err);
    log('restore.safety_capture_failed', { agentId, error: String(err) });
    // No pointer at Download copy: it tars the same volume the same way, so it
    // fails for the same reason (review, 2026-09-29).
    return nothingChanged(
      "Its current state could not be copied first, so the restore would not be undoable — nothing was changed. " +
        "Try again in a moment; if it keeps failing, check this machine's free disk space.",
    );
  }
  // On disk BEFORE the volume is replaced: in memory only, a restart in the
  // middle lost the one copy of how it was (design, "After a restart").
  try {
    keepSafetyCopy(safetyFile, safety);
  } catch (err) {
    rethrowIfCrash(err);
    log('restore.safety_keep_failed', { agentId, error: String(err) });
    return nothingChanged(
      `Its current state could not be saved to disk first (${short(err)}), so the restore would not be undoable — nothing was changed. ` +
        "Check this machine's free disk space, then try again.",
    );
  }
  op.step('safety-taken');

  /**
   * Put the pre-restore copy back after `what` failed. Only a rollback that
   * worked restarts the agent and may say it was left as it was. When the
   * rollback fails too, the volume holds neither the old state nor the
   * backup: booting it would run a half-written (and possibly too-open)
   * config, and "left as it was" was false (issue #12). So the agent stays
   * stopped and FAILED, the copy is kept on disk for recovery, and both
   * failures are named.
   */
  const rollBack = async (what: string, cause: unknown, leftAsItWas: string): Promise<never> => {
    let rollbackErr: unknown;
    try {
      await provider.importState(runtimeRef, safety);
    } catch (e) {
      rethrowIfCrash(e);
      rollbackErr = e;
      log('restore.rollback_failed', { agentId, error: String(e) });
    }
    if (rollbackErr === undefined) {
      await restartIfWasRunning();
      dropSafetyCopy(safetyFile);
      op.rolledBack(leftAsItWas);
      throw new RestoreError(leftAsItWas);
    }
    // A re-apply may have started it again; whatever is in its volume now must not run.
    try { await provider.stop(runtimeRef); } catch (e) { log('restore.stop_failed', { agentId, error: String(e) }); }
    const where = `The copy of how it was before the restore is kept at ${safetyFile}.`;
    store.setAgentState(
      agentId,
      'FAILED',
      `A restore from the ${date} backup failed and could not be undone, so its memory may be half-restored. ${where} ` +
        'Restore a backup again, or put that copy back by hand, before tapping Retry.',
    );
    log('restore.left_failed', { agentId, date, kept: safetyFile });
    const msg =
      `${what} (${short(cause)}), and putting it back as it was failed too (${short(rollbackErr)}). ` +
      `The agent could not be put back: it is stopped and marked failed so it does not run on a half-restored memory. ${where} ` +
      'Restore a backup again, or put that copy back by hand, before starting it.';
    op.fail(msg);
    throw new RestoreError(msg);
  };

  forgetDmPolicy(agentId); // the restored config is whatever the archive held
  try {
    await provider.importState(runtimeRef, data);
  } catch (err) {
    rethrowIfCrash(err);
    // The volume may be half-overwritten. Put the pre-restore state back, so a
    // broken archive never corrupts a working agent.
    log('restore.import_failed', { agentId, error: String(err) });
    await rollBack('Restore failed', err, 'Restore failed — the agent was left as it was.');
  }
  op.step('replaced');

  let undone: string[];
  try {
    undone = await applyCurrentSettingsOver(deps, agentId, runtimeRef);
  } catch (err) {
    rethrowIfCrash(err);
    // Never leave that night's access in force: back to how it was before.
    log('restore.reapply_failed', { agentId, error: String(err) });
    return rollBack(
      "The backup was read, but this agent's current settings could not be put back over it",
      err,
      "The backup was read, but this agent's current settings could not be put back over it, so it was left as it was.",
    );
  }
  op.step('reapplied');
  return completeRestore(deps, op, agentId, runtimeRef, date, wasRunning, safetyFile, undone);
}

/** Start it again if the restore stopped it; a failed start is logged, not thrown (the result says what it is). */
async function restartAfterRestore(deps: RestoreDeps, agentId: string, runtimeRef: string, wasRunning: boolean): Promise<void> {
  if (!wasRunning) return;
  try {
    await deps.provider.start(runtimeRef);
    if (deps.store.getAgent(agentId)?.state !== 'RUNNING') deps.store.setAgentState(agentId, 'RUNNING');
  } catch (startErr) {
    (deps.log ?? (() => {}))('restore.restart_failed', { agentId, error: String(startErr) });
  }
}

/**
 * The backup is that night's whole volume, config and approvals included.
 * Memory and files are what a restore is for; who may talk to the agent and
 * which bot it uses follow Hatchabot's records now, or a removed member was
 * let back in where the app could not show it, and a swapped-away bot was
 * polled by two agents (review #5, 2026-09-29; Chris chose this over a
 * whole-volume rollback). What was undone is reported, not silently dropped.
 * Throws when the part that matters for safety could not be done.
 */
async function applyCurrentSettingsOver(deps: RestoreDeps, agentId: string, runtimeRef: string): Promise<string[]> {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});
  const undone: string[] = [];
  try {
    const seen = await provider.execShellOnVolume(runtimeRef, RESTORED_ACCESS_SCRIPT, { readOnly: true });
    const had = JSON.parse(seen.stdout || '{}') as { ids?: string[]; telegramAccounts?: string[] };
    const ids = new Set(had.ids ?? []);
    const back = revokedScrubTargets(store, agentId).people.filter((p) => p.ids.some((id) => ids.has(id))).map((p) => p.name);
    if (back.length) undone.push(`That night's copy still let ${back.join(', ')} in; ${back.length === 1 ? 'they stay' : 'they all stay'} removed.`);
    const current = store.getChannelForAgent(agentId, 'telegram')?.accountId;
    if ((had.telegramAccounts ?? []).some((k) => k !== current)) {
      undone.push(current ? 'It used a different Telegram bot that night; it keeps the one it has now.' : 'It had a Telegram bot that night; it stays without one.');
    }
  } catch (err) {
    rethrowIfCrash(err);
    log('restore.access_read_failed', { agentId, error: String(err) });
  }
  if (deps.reapply) {
    try { await deps.reapply(runtimeRef); }
    catch (err) {
      rethrowIfCrash(err);
      // A full re-apply can fail for reasons a rebuild would too (its AI
      // source gone). The part that matters for safety still runs: only its
      // current bot stays; the rest follows at its next rebuild.
      log('restore.reapply_partial', { agentId, error: String(err).slice(0, 200) });
      const res = await provider.execShellOnVolume(runtimeRef, keepOnlyTelegramAccountScript(store.getChannelForAgent(agentId, 'telegram')?.accountId));
      if (res.code !== 0) throw new Error(`dropping the old bot failed: ${res.stderr.slice(-200)}`);
      undone.push("Its other current settings (model, AI source) couldn't be put back now; they follow at its next rebuild.");
    }
  }
  const { targets } = revokedScrubTargets(store, agentId);
  if (targets.length) {
    const res = await provider.execShellOnVolume(runtimeRef, allowlistScrubScript(targets));
    if (res.code !== 0) throw new Error(`removing people again failed: ${res.stderr.slice(-200)}`);
  }
  return undone;
}

/** The last of a restore: say so, start it again if it ran, and drop the copy of how it was. */
async function completeRestore(
  deps: RestoreDeps, op: OpHandle, agentId: string, runtimeRef: string, date: string, wasRunning: boolean, safetyFile: string | undefined, undone: string[],
): Promise<RestoreResult> {
  const { store } = deps;
  (deps.log ?? (() => {}))('agent.restored', { agentId, date, undone: undone.length });
  // A FAILED agent (an earlier restore that could not be undone) has its
  // memory back now; Retry is what starts it.
  if (store.getAgent(agentId)?.state === 'FAILED') {
    store.setAgentState(agentId, 'FAILED', `Restored from the ${date} backup — tap Retry to start it.`);
  }
  await restartAfterRestore(deps, agentId, runtimeRef, wasRunning);
  dropSafetyCopy(safetyFile);
  // What it IS now, not what it was: a failed restart used to report "restarting".
  const running = store.getAgent(agentId)?.state === 'RUNNING';
  // What it undid rides the outcome: the request no longer waits for the
  // answer that used to carry it (phase 3), so the outcome is what the page
  // and the CLI show.
  op.done(`Restored from the ${date} backup${running ? '' : wasRunning ? '; it could not be started again' : ''}.${undone.map((u) => ` ${u}`).join('')}`);
  return { date, running, ...(undone.length ? { undone } : {}) };
}

/** The choices a restore interrupted with its volume possibly half-written offers. */
const RESTORE_CHOICES = {
  actions: [
    { action: 'finish', label: 'Finish the restore' },
    { action: 'put-back', label: 'Put back the copy from before' },
  ],
  recommended: 'finish',
};

/**
 * A restore a restart cut off (the design's restore-backup row). Before the
 * copy of how it was reached the disk nothing was changed: it is started again
 * if it ran. From then until its settings were put back over that night's
 * copy, its volume may be half-written and only the owner knows which way they
 * want it: held, stopped, with [Finish the restore] [Put back the copy from
 * before]. After that, only the restart was left: finished.
 */
export async function resumeBackupRestore(deps: RestoreDeps, opId: string): Promise<void> {
  const op = handleFor(deps.store, opId);
  const row = op.get();
  const p = row.params as { date?: string; wasRunning?: boolean; safetyFile?: string };
  const agent = row.agentId ? deps.store.getAgent(row.agentId) : undefined;
  if (!agent?.runtimeRef || agent.state === 'DELETED') { op.fail('Interrupted by a restart; the agent is gone.'); return; }
  const date = String(p.date ?? '');
  const step = row.step ?? null;
  if (step === null || step === 'stopped') {
    await restartAfterRestore(deps, agent.id, agent.runtimeRef, p.wasRunning === true);
    dropSafetyCopy(p.safetyFile);
    op.rolledBack(`The restore from the ${date} backup was interrupted by a restart before anything was changed — it is as it was.`);
    return;
  }
  if (step === 'reapplied') {
    await completeRestore(deps, op, agent.id, agent.runtimeRef, date, p.wasRunning === true, p.safetyFile, []);
    return;
  }
  // Whatever its volume holds now must not run until the owner chooses.
  await deps.provider.stop(agent.runtimeRef).catch(() => {});
  if (agent.state === 'RUNNING') deps.store.setAgentState(agent.id, 'STOPPED');
  op.hold(
    `The restore from the ${date} backup was interrupted by a restart, so its memory may be half-restored. It stays stopped until you choose.`,
    RESTORE_CHOICES,
  );
}

/** The owner's choice on a held restore: finish it from that night's copy, or put back the copy from before. */
export async function recoverBackupRestore(deps: RestoreDeps, opId: string, action: string): Promise<void> {
  const op = handleFor(deps.store, opId);
  const row = op.get();
  const p = row.params as { date?: string; wasRunning?: boolean; safetyFile?: string };
  const agent = row.agentId ? deps.store.getAgent(row.agentId) : undefined;
  if (!agent?.runtimeRef) throw new RestoreError('The agent is gone.');
  const date = String(p.date ?? '');
  const ref = agent.runtimeRef;
  if (action === 'put-back') {
    if (!p.safetyFile || !existsSync(p.safetyFile)) {
      throw new RestoreError('The copy from before the restore is no longer on disk, so it cannot be put back. Finish the restore, or restore another backup.');
    }
    await deps.provider.importState(ref, readFileSync(p.safetyFile)).catch((err: unknown) => {
      throw new RestoreError(`The copy from before could not be put back: ${short(err)}. It stays stopped; try again.`);
    });
    forgetDmPolicy(agent.id);
    await restartAfterRestore(deps, agent.id, ref, p.wasRunning === true);
    dropSafetyCopy(p.safetyFile);
    op.rolledBack(`Put back as it was before the restore from the ${date} backup.`);
    return;
  }
  // finish
  if (!DATE_DIR.test(date)) throw new RestoreError('Not a backup date.');
  const file = join(backupsDir(), date, agentArchiveName(ref));
  if (!existsSync(file)) {
    throw new RestoreError(`The ${date} backup is no longer on disk, so the restore cannot be finished. Put back the copy from before instead.`);
  }
  forgetDmPolicy(agent.id);
  await deps.provider.importState(ref, readFileSync(file)).catch((err: unknown) => {
    throw new RestoreError(`The restore could not be finished: ${short(err)}. It stays stopped; put back the copy from before, or try again.`);
  });
  op.step('replaced');
  // A failure here leaves it held and stopped: the owner may still put the copy back.
  const undone = await applyCurrentSettingsOver(deps, agent.id, ref).catch((err: unknown) => {
    deps.provider.stop(ref).catch(() => {});
    throw new RestoreError(`The restore could not be finished: ${short(err)}. It stays stopped; put back the copy from before, or try again.`);
  });
  op.step('reapplied');
  await completeRestore(deps, op, agent.id, ref, date, p.wasRunning === true, p.safetyFile, undone);
}
