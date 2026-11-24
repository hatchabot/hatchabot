import { spawn } from 'node:child_process';
import { existsSync, lstatSync, statSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Store } from '../../store/store.js';
import { sharePathProblem } from '../lifecycle/provision.js';
import type { ProvisionDeps } from '../lifecycle/provision.js';
import { whileBusy } from '../lifecycle/busy.js';
import { VolumeGoneError } from '../../providers/provider.js';
import { openclawConfigPath } from './openclawImport.js';
import { openclawConfigAgents, openclawUserPath } from '../../openclaw/configWriter.js';
import { RUNTIME_STATE_FILES } from '../files/agentFiles.js';
import { stopAndConfirm } from '../lifecycle/quiesce.js';
import { beginOperation, handleFor, oweStart, rethrowIfCrash, type OpHandle, type StartAfter } from '../lifecycle/operations.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import { openclawAgentEntryForWorkspace } from './cronImport.js';

/**
 * Adopt an OpenClaw agent that already exists on this machine — one you built
 * by hand, outside Hatchabot — bringing its whole workspace with it.
 *
 * Deliberately copies the ENTIRE directory rather than the three files
 * Hatchabot seeds. A hand-built agent's knowledge is rarely confined to
 * SOUL/AGENTS/MEMORY: real ones accumulate IDENTITY.md, USER.md, TOOLS.md,
 * HEARTBEAT.md and their own domain files, and taking only three would quietly
 * discard most of what makes the agent useful.
 *
 * The source is only ever READ. The original keeps working until you retire
 * it — which matters, because the two would otherwise both want the same bot.
 */

export class AdoptError extends Error {
  /**
   * `held`: the copy was torn part way and the adopt is held (HB-0980): its
   * operation, and what failed. `copied`: the copy is whole and the adopt
   * done, but the agent could not be started: it is kept, to start once its
   * machine answers, and a new agent made for it is not removed.
   */
  constructor(readonly userMessage: string, readonly held?: { operation: string; detail: string }, readonly copied = false) {
    super(userMessage);
    this.name = 'AdoptError';
  }
}

/** Files that must never be carried into a managed agent. */
const EXCLUDE = [
  // OpenClaw's live state (its database and logins): the same list uploads
  // are refused under (agentFiles.ts).
  ...RUNTIME_STATE_FILES,
  '.git',
  // Build artifacts: compiled for THIS machine, with absolute host paths baked
  // in, and regenerable from the manifests we do copy. Carrying them across is
  // worse than skipping them — you get binaries that don't run in the
  // container. A real workspace here held a 1.2 GB venv/ next to 800 KB of
  // actual notes.
  'node_modules',
  'venv',
  '.venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.DS_Store',
];

/** Above this, adopting is almost certainly a mistake — and the tar would
 *  outgrow the 1 GB buffer and fail with something unreadable. */
const MAX_BYTES = 750 * 1024 * 1024;
const MAX_FILES = 20_000;

export interface WorkspacePreview {
  path: string;
  files: string[];
  markdownFiles: string[];
  bytes: number;
  /** Artifact directories found and deliberately not copied, so the count
   *  never looks like something silently vanished. */
  skipped: string[];
  /**
   * Links (and other non-files) found and NOT copied, each as `path -> target`.
   * The copy is exactly `files`: the archive used to carry links the preview
   * never showed, so what was copied was not what the owner reviewed, and a
   * link means something else (or nothing) inside the agent.
   */
  links: string[];
}

/**
 * Look at a candidate workspace without touching it, so the owner can see
 * what would be adopted before committing.
 */
export function inspectWorkspace(dir: string): WorkspacePreview {
  const path = resolve(dir);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new AdoptError(`No such folder on this machine: ${path}`);
  }
  // The same refusals as a shared folder: never adopt a credential directory.
  const problem = sharePathProblem(path);
  if (problem) throw new AdoptError(problem);

  // Walk the whole tree, because packWorkspace copies the whole tree. Counting
  // only the top level made the preview lie: a real workspace keeps its daily
  // notes in memory/ and its work in projects/, so "8 files" announced a copy
  // that actually moved 17.
  const files: string[] = [];
  const skipped: string[] = [];
  const links: string[] = [];
  let bytes = 0;
  let truncated = false;
  const walk = (dir: string, prefix: string, depth: number): void => {
    // A deep tree must still be COUNTED, or the preview lies and the size/file
    // guards don't fire — packWorkspace tars the whole thing regardless of
    // depth. Treat hitting the depth ceiling as "too deep to vet", same as
    // over-many files, rather than silently ignoring what lies below.
    if (depth > 40) {
      truncated = true;
      return;
    }
    if (files.length >= MAX_FILES) {
      truncated = true;
      return;
    }
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDE.includes(e.name)) {
        if (e.isDirectory()) skipped.push(prefix ? `${prefix}/${e.name}` : e.name);
        continue;
      }
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      // Dirent reflects lstat, so symlinks are neither isFile nor isDirectory:
      // no symlink loops to worry about. They are left out of the copy too
      // (packWorkspace copies `files` and nothing else), and named here, so
      // the preview is the copy.
      if (e.isDirectory()) {
        walk(resolve(dir, e.name), rel, depth + 1);
      } else if (e.isFile()) {
        // Counted as each file is found: checked only on entering a folder,
        // a flat folder of 20,001 files got through (#112).
        if (files.length >= MAX_FILES) {
          truncated = true;
          return;
        }
        files.push(rel);
        try {
          bytes += statSync(resolve(dir, e.name)).size;
        } catch {
          /* raced with a write; the estimate is advisory */
        }
      } else if (e.isSymbolicLink()) {
        let target = '?';
        try { target = readlinkSync(resolve(dir, e.name)); } catch { /* gone meanwhile */ }
        links.push(`${rel} -> ${target}`);
      } else {
        links.push(`${rel} (not a file)`);
      }
    }
  };
  walk(path, '', 0);
  if (truncated || bytes > MAX_BYTES) {
    throw new AdoptError(
      `${path} holds ${truncated ? `over ${MAX_FILES} files` : `${(bytes / 1e6).toFixed(0)} MB`} ` +
        `after skipping build artifacts. That is too big to copy into an agent — ` +
        `move the bulk data somewhere else and share that folder with the agent ` +
        `instead (hatchabot folders), so it reads the data in place rather than ` +
        `owning a copy of it.`,
    );
  }

  const markdownFiles = files.filter((f) => f.toLowerCase().endsWith('.md'));
  if (markdownFiles.length === 0) {
    throw new AdoptError(
      `${path} has no .md files — that does not look like an OpenClaw workspace. ` +
        `Expected SOUL.md, AGENTS.md, MEMORY.md or similar.`,
    );
  }
  return { path, files, markdownFiles, bytes, skipped, links };
}

/**
 * Tar exactly the files the preview listed: one policy for what is shown and
 * what is copied (session databases, credentials, build artifacts, links and
 * anything else not a plain file stay behind). The names go to tar on stdin,
 * NUL-separated, so no name is read as an option or split.
 */
export async function packWorkspace(preview: Pick<WorkspacePreview, 'path' | 'files'>): Promise<Buffer> {
  // --no-recursion: a listed name that became a folder since the preview
  // does not pull in what is under it.
  const args = ['cz', '-C', preview.path, '--no-recursion', '--null', '-T', '-'];
  // Each listed name must still be a plain file reached through no link,
  // before tar reads it and after: a file swapped for a link went in as the
  // link, and a folder swapped for one carried a file from outside under a
  // listed name (review 2026-10-22, B14).
  const changed = (): string | undefined => {
    let root: string;
    try { root = realpathSync(preview.path); } catch { return '.'; }
    for (const f of preview.files) {
      const p = resolve(preview.path, f);
      try { if (!lstatSync(p).isFile() || realpathSync(p) !== resolve(root, f)) return f; } catch { return f; }
    }
    return undefined;
  };
  const moved = (f: string) => new AdoptError(`${f} in ${preview.path} changed while it was being copied (a link or folder in its place). Nothing was copied — look at the folder and adopt it again.`);
  const before = changed();
  if (before) throw moved(before);
  const tarball = await new Promise<Buffer>((done, fail) => {
    const tar = spawn('tar', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    tar.stdout.on('data', (b: Buffer) => {
      size += b.length;
      if (size > 1024 * 1024 * 1024) { tar.kill(); fail(new AdoptError('The workspace grew past 1 GB while it was being copied.')); return; }
      out.push(b);
    });
    tar.stderr.on('data', (b: Buffer) => { err += b.toString(); });
    tar.on('error', fail);
    tar.on('close', (code) => code === 0 ? done(Buffer.concat(out)) : fail(new Error(`tar exited ${code}: ${err.slice(0, 300)}`)));
    tar.stdin.on('error', () => { /* tar exited early: its exit code says why */ });
    tar.stdin.end(preview.files.map((f) => `./${f}\0`).join(''));
  });
  const after = changed();
  if (after) throw moved(after);
  return tarball;
}

export interface AdoptDeps extends ProvisionDeps {
  store: Store;
}

/**
 * Copy a prepared workspace into an already-provisioned agent, then restart it
 * so the runtime picks the files up.
 */
export async function applyWorkspace(
  deps: AdoptDeps,
  agentId: string,
  sourceDir: string,
): Promise<{ files: number; bytes: number }> {
  // Busy while the workspace is being replaced: a Rebuild passing its own
  // guards mid-copy would docker rm the container underneath the restore.
  return whileBusy(agentId, () => applyWorkspaceInner(deps, agentId, sourceDir));
}

async function applyWorkspaceInner(
  deps: AdoptDeps,
  agentId: string,
  sourceDir: string,
): Promise<{ files: number; bytes: number }> {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});
  const agent = store.getAgent(agentId);
  if (!agent?.runtimeRef) throw new AdoptError('That agent has no runtime yet.');
  // Mid-provision, mid-rebuild or FAILED, the runtime is not a stable target
  // for a tar extract — and DELETING would resurrect files into a purge.
  if (agent.state !== 'RUNNING' && agent.state !== 'STOPPED') {
    throw new AdoptError(`Can't adopt into this agent while it is ${agent.state}.`);
  }

  const preview = inspectWorkspace(sourceDir);
  const tar = await packWorkspace(preview);

  const wasRunning = agent.state === 'RUNNING';
  // Recorded as it goes (operations.ts): the extract is not atomic, so one
  // cut off in the copy — a failure, or a restart — is held, and Start waits
  // for the owner's choice (resumeAdoptWorkspace). In memory only, a restart
  // there left a half-copied workspace that started as if whole (HB-0980).
  const op = beginOperation(store, 'adopt-workspace', agentId, { from: preview.path, wasRunning });
  try {
    await copyIn({ store, provider, log }, op, agentId, preview, tar, wasRunning, false);
  } catch (err) {
    rethrowIfCrash(err);
    const now = op.get();
    // Whole, but its start failed: nothing is half-replaced, so the adopt is
    // done, and the repoint of its own paths and tasks is owed for when it
    // runs, as after a restart there (HB-0980 review).
    if (now.status === 'running' && now.step === 'copied') {
      oweRepoint(store, agentId, preview.path);
      const msg = `The workspace from ${preview.path} was copied in whole, but it could not be started (${short(err)}): start it once its machine answers.`;
      op.done(msg);
      log('agent.adopted_workspace', { agentId, from: preview.path, files: preview.files.length, bytes: preview.bytes, started: false });
      throw new AdoptError(msg, undefined, true);
    }
    // Whatever was not recorded (an unexpected error) ends the record too.
    if (now.status === 'running') op.fail(err);
    throw err;
  }
  op.done(`Adopted the workspace from ${preview.path}.`);

  log('agent.adopted_workspace', {
    agentId,
    from: preview.path,
    files: preview.files.length,
    bytes: preview.bytes,
  });
  return { files: preview.files.length, bytes: preview.bytes };
}

type CopyDeps = Pick<AdoptDeps, 'store' | 'provider' | 'log'>;

/**
 * The copy, step by step: the adopt's own, and Adopt again's (`again`: the
 * operation is held already, and a failure keeps it held). Every way it ends
 * but the whole copy is recorded here: nothing copied (rolled back, or for
 * Adopt again still held), the volume gone (failed: there is nothing to put
 * right), or a copy torn part way (held).
 */
async function copyIn(
  deps: CopyDeps, op: OpHandle, agentId: string, preview: Pick<WorkspacePreview, 'path' | 'files' | 'bytes'>, tar: Buffer, start: boolean, again: boolean,
): Promise<void> {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});
  const agent = store.getAgent(agentId);
  if (!agent?.runtimeRef) throw new AdoptError('That agent has no runtime any more.');
  op.step('packed', { files: preview.files.length, bytes: preview.bytes });
  // Stop first: OpenClaw reads these at turn time, and copying underneath a
  // live agent risks a half-written workspace being read mid-conversation.
  // A STOPPED record can lag the real runtime, and a resolved stop call is
  // not proof it stopped. No file is replaced until the runtime confirms it.
  try { await stopAndConfirm(provider, agent.runtimeRef); }
  catch (err) {
    rethrowIfCrash(err);
    const msg = `${(err as Error).message} Nothing was copied into the agent.`;
    if (again) throw new AdoptError(`${msg} It stays stopped until you choose again.`);
    op.rolledBack(msg);
    throw new AdoptError(msg);
  }
  if (store.getAgent(agentId)?.state === 'RUNNING') store.setAgentState(agentId, 'STOPPED');
  op.step('stopped');
  try {
    await provider.importWorkspace(agent.runtimeRef, agent.slug, tar);
  } catch (err) {
    rethrowIfCrash(err);
    // The extract is not atomic — the workspace may now hold an arbitrary
    // prefix of the archive. The agent must not come back up believing that
    // half-truth; leave it stopped and say what happened.
    log('adopt.import_failed', { agentId, from: preview.path, error: String(err) });
    // Nothing was copied, and adopting again cannot work (HB-0373). Nothing
    // is half-replaced either: the record ends, so a Rebuild may make a new volume.
    if (err instanceof VolumeGoneError) {
      const msg = `${err.userMessage} Nothing was copied in. Find out where its files went first; a Rebuild makes a fresh, empty volume to adopt into.`;
      op.fail(msg);
      throw new AdoptError(msg);
    }
    const said = holdCutOff(op, preview.path, `failed part way (${short(err)})`);
    throw new AdoptError(
      `Copying the workspace in failed part way (${short(err)}) — the agent is left stopped because its files ` +
        `may be half-replaced, and it is not started until you choose on its page. ${said} Or delete it.`,
      { operation: op.id, detail: short(err) },
    );
  }
  op.step('copied');
  // The adopt's own start, under its busy flag as before HB-0980. Adopt again
  // and a restart's rule leave theirs to a Start (StartAfter).
  if (start) {
    await provider.start(agent.runtimeRef);
    store.setAgentState(agentId, 'RUNNING');
    op.step('started');
  }
}

function short(err: unknown): string {
  return String(err instanceof Error ? err.message : err).replace(/\s+/g, ' ').trim().slice(0, 200);
}

const ADOPT_AGAIN = { action: 'adopt-again', label: 'Adopt again' };
const START_AS_IS = { action: 'start-as-is', label: 'Start it as it is' };
/** The same way out for an agent that was stopped before the adopt: it stays stopped. */
const KEEP_AS_IS = { action: START_AS_IS.action, label: 'Keep it as it is' };

/**
 * Why the folder an adopt copied from cannot be copied from again (gone, or
 * no longer one an adopt takes), or undefined when it can. Only then is
 * Start it as it is offered: the way out, so the agent is never stuck.
 */
function cannotCopyFrom(from: string): string | undefined {
  try {
    inspectWorkspace(from);
    return undefined;
  } catch (err) {
    return err instanceof AdoptError ? err.userMessage : short(err);
  }
}

/**
 * Hold an adopt cut off in its copy (`how`: "failed part way (…)", "was
 * interrupted by a restart…"): the files may be half-replaced, so it stays
 * stopped and Start is refused until the owner chooses. Returns the choice
 * words for the answer.
 */
function holdCutOff(op: OpHandle, from: string, how: string): string {
  const gone = cannotCopyFrom(from);
  // Its first sentence: the outcome is kept to 600 characters, and the choices come after it.
  const why = gone?.split(/(?<=\.)\s/)[0]!.replace(/\.$/, '');
  // Stopped before the adopt, it is not started by the way out (HB-0980 review).
  const ran = (op.get().params as { wasRunning?: boolean }).wasRunning === true;
  const out = ran ? START_AS_IS : KEEP_AS_IS;
  const way = ran ? 'Start it as it is starts it with the files it has now;'
    : 'Keep it as it is ends this with the files it has now; it stays stopped, as it was before the adopt.';
  const choose = gone
    ? `The folder cannot be copied from again (${why}). ${way} Adopt again copies the folder in again once it is back.`
    // Over what is there: the folder is also OpenClaw's own (its database,
    // its logins, the installed skills), so it is never cleared first, and a
    // file the cut-off copy wrote that the folder no longer has is not
    // known here to remove (HB-0980 review).
    : 'Adopt again copies every file in the folder in again, whole; one the cut-off copy wrote that the folder no longer has stays as it was left.';
  op.hold(
    `Adopting the workspace from ${from} ${how}, so its files may be half-replaced. It stays stopped until you choose. ${choose}`,
    gone ? { actions: [ADOPT_AGAIN, out], recommended: out.action } : { actions: [ADOPT_AGAIN], recommended: ADOPT_AGAIN.action },
  );
  return choose;
}

export interface AdoptResumeDeps {
  store: Store;
  provider: RuntimeProvider;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

/**
 * Started again after a restart, if the adopt had stopped it: as Start starts
 * it (StartAfter), so a rebuild it was owed meanwhile is that start, owed on
 * the record before the operation is finished (oweStart). One the adopt never
 * stopped is running as it was, and only its record is put right.
 */
async function startAgain(deps: AdoptResumeDeps, opId: string, agentId: string, runtimeRef: string): Promise<StartAfter | void> {
  const phase = await deps.provider.status(runtimeRef).then((s) => s.phase, () => undefined);
  const now = deps.store.getAgent(agentId);
  if (phase === 'running') {
    if (now?.state === 'STOPPED') deps.store.setAgentState(agentId, 'RUNNING');
    return;
  }
  // Stopped for the copy before its record said so: Start takes a STOPPED agent.
  if (phase && now?.state === 'RUNNING') deps.store.setAgentState(agentId, 'STOPPED');
  oweStart(deps.store, opId);
  return { startAfter: { notStarted: (why) => `It could not be started again (${why}), so it is stopped: start it once its machine answers.` } };
}

/**
 * The adopt's own paths and tasks, re-pointed at the copy once the agent runs
 * (adopts.ts, finishDeferredAdopts): after a copy a recovery made, as after
 * one the adopt itself made (adoptInto).
 */
function oweRepoint(store: Store, agentId: string, from: string): void {
  if (openclawAgentEntryForWorkspace(from)) store.setAdoptPending(agentId, from, new Date().toISOString());
  else store.dropAdoptPending(agentId);
}

/**
 * An adopt a restart cut off (HB-0980). Before it stopped the agent for the
 * copy nothing was changed: started again if it ran (startAgain: a Start, by
 * the caller), and over. Once stopped
 * for the copy, the extract may have begun, so its files may be half-replaced:
 * held, stopped, with [Adopt again] (and [Start it as it is] when the folder
 * cannot be copied from again). Once the copy was whole, only its start was
 * left: finished.
 */
export async function resumeAdoptWorkspace(deps: AdoptResumeDeps, opId: string): Promise<StartAfter | void> {
  const op = handleFor(deps.store, opId);
  const row = op.get();
  const p = row.params as { from?: string; wasRunning?: boolean };
  const agent = row.agentId ? deps.store.getAgent(row.agentId) : undefined;
  if (!agent?.runtimeRef || agent.state === 'DELETED') { op.fail('Interrupted by a restart; the agent is gone.'); return; }
  const from = String(p.from ?? '');
  if (row.step === null || row.step === 'packed') {
    const then = p.wasRunning === true ? await startAgain(deps, op.id, agent.id, agent.runtimeRef) : undefined;
    op.rolledBack(`Adopting the workspace from ${from} was interrupted by a restart before anything was copied in — it is as it was.`);
    return then;
  }
  if (row.step === 'copied' || row.step === 'started') {
    oweRepoint(deps.store, agent.id, from);
    const then = row.step === 'copied' && p.wasRunning === true ? await startAgain(deps, op.id, agent.id, agent.runtimeRef) : undefined;
    op.done(`Adopted the workspace from ${from}; a restart came after the copy.`);
    return then;
  }
  if (agent.state === 'RUNNING') deps.store.setAgentState(agent.id, 'STOPPED');
  holdCutOff(op, from, 'was interrupted by a restart while it was being copied in');
}

/**
 * The owner's choice on a held adopt. Adopt again: every file in the folder
 * copied in again, whole, over what is there, and started if it ran; a file
 * the cut-off copy wrote that the folder no longer has stays (holdCutOff says
 * so); a folder that cannot be copied from is said
 * plainly, and the hold then offers Start it as it is. Start it as it is: only
 * while the folder cannot be copied from; the hold ends with the files it has,
 * and an agent that ran is started as Start starts it. Either way an agent that
 * ran is started by the caller once it has let go of the agent (StartAfter),
 * so a rebuild it is owed is that start, its limits go on and its sleep mark
 * goes; one stopped before the adopt stays stopped (Keep it as it is).
 */
export async function recoverAdoptWorkspace(deps: AdoptResumeDeps, opId: string, action: string): Promise<StartAfter | void> {
  const op = handleFor(deps.store, opId);
  const row = op.get();
  const p = row.params as { from?: string; wasRunning?: boolean };
  const agent = row.agentId ? deps.store.getAgent(row.agentId) : undefined;
  if (!agent?.runtimeRef || agent.state === 'DELETED') throw new AdoptError('The agent is gone.');
  // A Delete goes through this hold (holdDeleteEnds) and does not take the busy flag: one under way is not copied into.
  if (agent.state === 'DELETING' || agent.state === 'FAILED') throw new AdoptError('It is being deleted, so nothing is copied into it.');
  const from = String(p.from ?? '');
  const gone = cannotCopyFrom(from);
  if (action === START_AS_IS.action) {
    if (!gone) {
      holdCutOff(op, from, 'was cut off part way');
      throw new AdoptError(`The folder ${from} is there to copy from again, so it is not started as it is: Adopt again copies every file in it in again, whole.`);
    }
    if (p.wasRunning !== true) {
      op.done(`Kept as it is, with the files the adopt from ${from} left; the folder could not be copied from again. It stays stopped, as it was before the adopt.`);
      return;
    }
    // Its start is written on the record when it has run (settleOwedStart), owed until then.
    oweStart(deps.store, op.id);
    op.done(`Kept as it is, with the files the adopt from ${from} left; the folder could not be copied from again.`);
    return { startAfter: { notStarted: (why) => `It is kept as it is, but it could not be started: ${why} Start it once that is put right.` } };
  }
  if (gone) {
    holdCutOff(op, from, 'was cut off part way');
    throw new AdoptError(`${from} cannot be copied from again: ${gone} It stays stopped. Start it as it is starts it with the files it has now.`);
  }
  const preview = inspectWorkspace(from);
  const tar = await packWorkspace(preview);
  // Not started here: a Start does that once this lets go of the agent.
  await copyIn(deps, op, agent.id, preview, tar, false, true);
  oweRepoint(deps.store, agent.id, preview.path);
  if (p.wasRunning === true) oweStart(deps.store, op.id);
  op.done(`Adopted the workspace from ${preview.path} again: every file in it copied in whole. One the cut-off copy wrote that the folder no longer has may still be there, as it was left.`);
  const log = deps.log ?? (() => {});
  log('agent.adopted_workspace', { agentId: agent.id, from: preview.path, files: preview.files.length, bytes: preview.bytes });
  if (p.wasRunning !== true) return;
  return { startAfter: { notStarted: (why) => `Adopted again, every file in it whole, but it could not be started: ${why} Start it once its machine answers.` } };
}

/**
 * The bot a hand-built agent already owns.
 *
 * Telegram caps one account at ~20 bots, and a workspace being adopted almost
 * always has a bot already — with the family's real chat history in it. Minting
 * a fresh one therefore spends a scarce slot to give everybody a stranger to
 * talk to. Reusing the existing one costs nothing and keeps the conversation.
 */
export interface ExistingBot {
  /** The old instance's agent id, for telling the owner what to stop. */
  sourceAgentId: string;
  accountId: string;
  botToken: string;
  /** Telegram user ids already cleared to talk to it. Carrying these over is
   *  what stops the owner having to pair with their own adopted agent. */
  allowFrom: string[];
  /** Still switched on in the hand-built instance — meaning that instance will
   *  poll this bot the moment it is running. */
  enabledInSource: boolean;
  /** Telegram is switched off for the whole hand-built instance (its channel's
   *  `enabled: false`). Nothing polls the bot now, but an account still on is
   *  polled again the day Telegram is switched back on there: a takeover is
   *  refused all the same, in words that say the account must go off too
   *  (HB-1031). */
  channelOffInSource: boolean;
}

interface OpenClawConfig {
  agents?: unknown; // list or entries: openclawConfigAgents reads both
  bindings?: Array<{ agentId?: string; match?: { channel?: string; accountId?: string } }>;
  channels?: {
    telegram?: {
      enabled?: boolean;
      accounts?: Record<string, { botToken?: string; allowFrom?: string[]; enabled?: boolean }>;
    };
  };
}

/**
 * Resolve workspace → agent → binding → bot token in the hand-built instance's
 * config. Returns undefined rather than throwing: no existing bot is a normal
 * case (the owner just makes one), not an error.
 */
export function findExistingBot(
  workspaceDir: string,
  // Honor OPENCLAW_CONFIG so a non-default install (and the smoke harness)
  // resolves the same config discovery does, not a hardcoded ~/.openclaw path.
  configPath = openclawConfigPath(),
): ExistingBot | undefined {
  let cfg: OpenClawConfig;
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf8')) as OpenClawConfig;
  } catch {
    return undefined;
  }
  const want = resolve(workspaceDir);
  const agent = openclawConfigAgents(cfg).find(
    (a) =>
      (a.workspace && openclawUserPath(a.workspace) === want) ||
      (a.agentDir && openclawUserPath(a.agentDir) === want),
  );
  if (!agent?.id) return undefined;

  const accountId = (cfg.bindings ?? []).find(
    (b) => b.agentId === agent.id && (b.match?.channel ?? 'telegram') === 'telegram',
  )?.match?.accountId;
  if (!accountId) return undefined;

  const account = cfg.channels?.telegram?.accounts?.[accountId];
  if (!account?.botToken) return undefined;
  const allowFrom = (account.allowFrom ?? []).filter((id) => /^\d{1,32}$/.test(id));
  return {
    sourceAgentId: agent.id,
    accountId,
    botToken: account.botToken,
    allowFrom,
    enabledInSource: account.enabled !== false,
    channelOffInSource: cfg.channels?.telegram?.enabled === false,
  };
}

/**
 * Ask Telegram itself whether anyone else is polling this bot.
 *
 * Three-state on purpose: "couldn't reach Telegram" is not "nobody is polling",
 * and neither is "nobody answered in the split second we asked".
 *
 * This is the only authoritative answer: getUpdates replies 409 when another
 * process holds the poll, whatever manages that process. It matters most for
 * reuse, where the old instance is usually still running — and two pollers on
 * one token is not a clean failure, it is messages vanishing at random into
 * whichever copy won the race.
 *
 * No offset: that returns the waiting updates and confirms none of them. A
 * negative offset — what this used to send — tells Telegram to FORGET every
 * update before it, so a census or an inspect of a stopped or sleeping
 * agent's bot deleted the messages queued for it (night review, 2026-09-27).
 */
export type PollState = 'busy' | 'quiet' | 'unknown';

/**
 * NOTE ON WHAT THIS CAN PROVE: 'quiet' is not 'safe'. Telegram answers 409 only
 * when a getUpdates call is in flight at that instant, so a poller resting
 * between long-polls is indistinguishable from no poller at all — verified
 * against a bot the running instance owned, which answered ok:true. Use this to
 * CONFIRM a conflict, never to clear one; `enabledInSource` is the deterministic
 * signal.
 */
export async function botPollState(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PollState> {
  try {
    const res = await fetchImpl(
      `https://api.telegram.org/bot${botToken}/getUpdates?limit=1&timeout=0`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (res.status === 409) return 'busy';
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error_code?: number };
    if (body.error_code === 409) return 'busy';
    return body.ok ? 'quiet' : 'unknown';
  } catch {
    return 'unknown';
  }
}
