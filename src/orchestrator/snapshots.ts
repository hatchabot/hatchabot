import { createHash, randomUUID } from 'node:crypto';
import type { ExecResult, RuntimeProvider } from '../providers/provider.js';
import type { SnapshotParams, Store, StoredSnapshot } from '../store/store.js';
import { beginOperation, handleFor, rethrowIfCrash } from './operations.js';

/**
 * Version history for what makes an agent *itself*: SOUL.md (who it is),
 * AGENTS.md (how it works), MEMORY.md (what it knows). Those files are the
 * expensive part — months of accumulated context — and they are also the
 * easiest to destroy with one bad edit or an overeager agent.
 *
 * Deliberately NOT a volume snapshot: the core files are kilobytes, so they
 * live in the control-plane DB and can be captured automatically before
 * anything risky. Whole-runtime copies remain the job of export (portable,
 * heavyweight) and scripts/backup-volumes.sh (nightly, everything).
 */

export const CORE_FILES = ['SOUL.md', 'AGENTS.md', 'MEMORY.md'] as const;

/** How many automatic snapshots to keep per agent. Manual ones are forever. */
export const AUTO_KEEP = 20;

/** Per-file ceiling for both snapshot capture and edits (256 KB). */
export const MAX_FILE_BYTES = 256 * 1024;

export type SnapshotReason =
  | 'manual'
  | 'pre-edit'
  | 'pre-restore'
  | 'pre-rebuild'
  | 'pre-adopt'
  | 'pre-params' // before re-rendering files from edited setup values
  | 'scheduled';

export interface SnapshotDeps {
  store: Store;
  provider: RuntimeProvider;
  log?: (event: string, detail: Record<string, unknown>) => void;
  /** Who asked, for a restore's operation record. */
  requestedBy?: string;
  /** Told a restore's operation id once it begins (the route answers 202 with it). */
  onOperation?: (id: string) => void;
}

export class SnapshotError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'SnapshotError';
  }
}

/** A core file past MAX_FILE_BYTES (a template export words it its own way). */
export class CoreFileTooBigError extends SnapshotError {}

export function workspacePath(slug: string, name: string): string {
  return `/home/node/.openclaw/agents/${slug}/agent/${name}`;
}

/**
 * `onVolume`: through a one-shot on the agent's volume, for a stopped agent
 * (its own container cannot exec), with the image it runs.
 */
export type VolumeAccess = { onVolume?: boolean; image?: string };

/** Said on stderr by the read below when the file is there and empty. */
const EMPTY_FILE_MARK = 'hatchabot:empty-file';

/**
 * One core file as it is: its text, '' when it is there and empty, undefined
 * when it is not there at all. A file that is there but cannot be read, or a
 * read that failed, throws: `|| true` made both look like a missing file, so
 * a snapshot left that file out and still looked whole (#66), and a share
 * carried an empty SOUL.md or AGENTS.md (#119).
 */
export async function readCoreFile(
  provider: RuntimeProvider,
  runtimeRef: string,
  slug: string,
  name: string,
  via: VolumeAccess = {},
): Promise<string | undefined> {
  const q = JSON.stringify(workspacePath(slug, name));
  // Read one byte past the cap so an oversized file is *detectable*:
  // silently truncating would store a partial MEMORY.md and later restore
  // it over the real one — data loss by the system meant to prevent it.
  const script =
    `head -c ${MAX_FILE_BYTES + 1} ${q} 2>/dev/null || { [ ! -e ${q} ] || exit 3; }; ` +
    `if [ -e ${q} ] && [ ! -s ${q} ]; then echo ${EMPTY_FILE_MARK} >&2; fi`;
  const res = via.onVolume
    ? await provider.execShellOnVolume(runtimeRef, script, { readOnly: true, image: via.image })
    : await provider.execShell(runtimeRef, script);
  if (res.code !== 0) {
    throw new SnapshotError(
      res.code === 3 ? `${name} is there but could not be read.` : `Couldn't read ${name} — is the agent healthy?`,
    );
  }
  if (Buffer.byteLength(res.stdout, 'utf8') > MAX_FILE_BYTES) {
    throw new CoreFileTooBigError(
      `${name} is larger than ${Math.floor(MAX_FILE_BYTES / 1024)} KB — too big to snapshot safely. ` +
        'Trim it, or back the agent up with an export instead.',
    );
  }
  if (res.stdout) return res.stdout;
  return res.stderr.includes(EMPTY_FILE_MARK) ? '' : undefined;
}

/**
 * The core files there are. An empty one is kept as '' so restoring the
 * snapshot empties it again (#67); a missing one is left out, and restoring
 * the snapshot takes it away again (#214).
 */
export async function readCoreFiles(
  provider: RuntimeProvider,
  runtimeRef: string,
  slug: string,
  via: VolumeAccess = {},
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of CORE_FILES) {
    const text = await readCoreFile(provider, runtimeRef, slug, name, via);
    if (text !== undefined) files[name] = text;
  }
  return files;
}

/**
 * Write a file inside an agent (its path as the agent sees it) from base64.
 * Small content goes through the shell as before; larger content is fed on
 * stdin to a one-shot on the volume. Linux caps one argument at 128 KiB, so
 * a MEMORY.md past ~98 KB failed to spawn ("Docker is not available") and a
 * snapshot restore stopped half-way (night review, 2026-09-27).
 */
export async function writeFileInAgent(provider: RuntimeProvider, runtimeRef: string, path: string, b64: string, via: VolumeAccess = {}): Promise<ExecResult> {
  if (b64.length <= ARGV_SAFE_B64) {
    // tmp + mv, so a failure never leaves the file truncated.
    const q = JSON.stringify(path);
    const script = `set -e; echo ${JSON.stringify(b64)} | base64 -d > ${q}.tmp && mv ${q}.tmp ${q}`;
    return via.onVolume ? provider.execShellOnVolume(runtimeRef, script, { image: via.image }) : provider.execShell(runtimeRef, script);
  }
  if (!provider.writeToVolume) return { code: 1, stdout: '', stderr: 'this machine cannot write a file that large into the agent' };
  return provider.writeToVolume(runtimeRef, ['sh', '-c', 'cat > "$1.part-$$" && mv -f "$1.part-$$" "$1"', 'sh', path], Buffer.from(b64, 'base64'));
}
/** Base64 up to this size rides in the shell argument; beyond it, stdin. */
export const ARGV_SAFE_B64 = 96 * 1024;

export async function writeCoreFile(
  provider: RuntimeProvider,
  runtimeRef: string,
  slug: string,
  name: string,
  content: string,
  via: VolumeAccess = {},
): Promise<void> {
  // base64 through the shell so arbitrary content can't break quoting.
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const res = await writeFileInAgent(provider, runtimeRef, workspacePath(slug, name), b64, via);
  if (res.code !== 0) {
    throw new SnapshotError(`Couldn't write ${name}: ${res.stderr.slice(-200)}`);
  }
}

/**
 * Take a core file away: a snapshot taken before it existed restores that.
 * Leaving it was a restore that said "done" yet kept the newer MEMORY.md (#214).
 */
export async function removeCoreFile(
  provider: RuntimeProvider,
  runtimeRef: string,
  slug: string,
  name: string,
  via: VolumeAccess = {},
): Promise<void> {
  const script = `rm -f ${JSON.stringify(workspacePath(slug, name))}`;
  const res = via.onVolume
    ? await provider.execShellOnVolume(runtimeRef, script, { image: via.image })
    : await provider.execShell(runtimeRef, script);
  if (res.code !== 0) {
    throw new SnapshotError(`Couldn't remove ${name}: ${res.stderr.slice(-200)}`);
  }
}

export interface SnapshotSummary {
  id: string;
  label: string;
  reason: string;
  createdAt: string;
  files: string[];
}

/** Content hash of a file set, independent of key order. */
function filesHash(files: Record<string, string>): string {
  const h = createHash('sha256');
  for (const k of Object.keys(files).sort()) h.update(`${k}\0${files[k]}\0`);
  return h.digest('hex');
}

/**
 * The snapshots the agent's unfinished operation still needs: a restore's
 * target and the safety copy taken before it. Pruning spares them, and the
 * delete route refuses them — deleted by hand, a held restore had neither
 * Finish nor Revert left, and nothing could clear it (audit #020).
 */
export function snapshotsInUse(store: Store, agentId: string): string[] {
  const active = store.activeOperationFor(agentId);
  return Object.entries(active?.params ?? {})
    .filter(([k, v]) => /snapshotId$/i.test(k) && typeof v === 'string')
    .map(([, v]) => v as string);
}

export async function captureSnapshot(
  deps: SnapshotDeps,
  agentId: string,
  opts: { label?: string; reason?: SnapshotReason } = {},
): Promise<SnapshotSummary> {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});
  const agent = store.getAgent(agentId);
  if (!agent?.runtimeRef) throw new SnapshotError('This agent has no runtime yet.');
  if (agent.state !== 'RUNNING') {
    throw new SnapshotError('Start the agent to snapshot its files.');
  }

  const files = await readCoreFiles(provider, agent.runtimeRef, agent.slug);
  if (Object.keys(files).length === 0) {
    throw new SnapshotError("Couldn't read the agent's files — is it healthy?");
  }
  const reason = opts.reason ?? 'manual';
  // The setup-values layer goes with the files: restoring the files alone
  // left the newer layer, and the next value edit re-rendered the version
  // just undone (#68).
  const params: SnapshotParams | null = agent.paramFiles
    ? { values: agent.paramValues ?? {}, soul: agent.paramFiles.soul, agents: agent.paramFiles.agents }
    : null;
  // An automatic capture identical to the newest snapshot adds nothing: two
  // thirds of them were copies (every fleet rebuild made one), and rotation
  // then evicted older, different versions to keep them (review, 2026-09-29).
  // A named one is always kept — the owner asked for that point by name.
  if (reason !== 'manual') {
    const last = store.latestSnapshot(agentId);
    if (last && filesHash(last.files) === filesHash(files) && last.params !== undefined
      && JSON.stringify(last.params) === JSON.stringify(params)) {
      log('snapshot.unchanged', { agentId, reason, same: last.id });
      return { id: last.id, label: last.label, reason: last.reason, createdAt: last.createdAt, files: Object.keys(last.files) };
    }
  }
  const snapshot = {
    id: randomUUID(),
    agentId,
    label: (opts.label ?? '').trim().slice(0, 64) || defaultLabel(reason),
    reason,
    files,
    createdAt: new Date().toISOString(),
    params,
  };
  store.insertSnapshot(snapshot);
  // Not one the agent's operation still needs: a restore's safety copy, taken
  // at the limit, pruned the very snapshot it was restoring, and a restart
  // part-way then had nothing to finish with (A40, 2026-10-22).
  const pruned = store.pruneAutoSnapshots(agentId, AUTO_KEEP, snapshotsInUse(store, agentId));
  log('snapshot.captured', { agentId, id: snapshot.id, reason, pruned });
  return {
    id: snapshot.id,
    label: snapshot.label,
    reason,
    createdAt: snapshot.createdAt,
    files: Object.keys(files),
  };
}

/**
 * Best-effort automatic capture: a failure here must never block the action
 * it was protecting (an unsnapshottable agent is still editable).
 */
export async function autoSnapshot(
  deps: SnapshotDeps,
  agentId: string,
  reason: SnapshotReason,
): Promise<void> {
  try {
    await captureSnapshot(deps, agentId, { reason });
  } catch (err) {
    (deps.log ?? (() => {}))('snapshot.auto_failed', { agentId, reason, error: String(err) });
  }
}

export async function restoreSnapshot(
  deps: SnapshotDeps,
  agentId: string,
  snapshotId: string,
): Promise<{ restored: string[]; safetySnapshotId?: string }> {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});
  const agent = store.getAgent(agentId);
  if (!agent?.runtimeRef) throw new SnapshotError('This agent has no runtime yet.');
  if (agent.state !== 'RUNNING') throw new SnapshotError('Start the agent to restore its files.');
  const snapshot = store.getSnapshot(agentId, snapshotId);
  if (!snapshot) throw new SnapshotError('That snapshot no longer exists.');

  // Recorded as it goes (operations.ts): a restart part-way through the
  // files holds the agent for its owner — finish, or revert to the snapshot
  // taken just before (resumeSnapshotRestore).
  const op = beginOperation(store, 'restore-snapshot', agentId, { snapshotId, label: snapshot.label }, { requestedBy: deps.requestedBy });
  deps.onOperation?.(op.id);

  // A restore is itself destructive — capture the current state first so an
  // unwanted rollback is one more rollback away, not a loss.
  let safetySnapshotId: string | undefined;
  let present: string[] = [];
  try {
    const safety = await captureSnapshot(deps, agentId, {
      reason: 'pre-restore',
      label: `before restoring ${snapshot.label}`,
    });
    safetySnapshotId = safety.id;
    present = safety.files;
  } catch (err) {
    rethrowIfCrash(err);
    log('snapshot.safety_failed', { agentId, error: String(err) });
    // No copy, no restore: the app promises "this is undoable", and a file too
    // big for a snapshot (MEMORY.md past 256 KB) would have been overwritten
    // with nothing to go back to (use-case audit, 2026-09-27).
    // Says why, and points only at what fixes it: "Download a copy first"
    // changed nothing here (the restore still refuses) and cannot work for an
    // agent too big to download (review, 2026-09-29).
    const why = err instanceof SnapshotError ? ` (${err.userMessage.split(' — ')[0]!.replace(/\.$/, '')})` : '';
    const msg = `Its current files could not be snapshotted first${why}, so the restore would not be undoable — nothing was changed. Trim its largest file, then try again.`;
    op.rolledBack(msg);
    throw new SnapshotError(msg);
  }
  op.step('safety-taken', { safetySnapshotId });

  const restored: string[] = [];
  // The snapshot's files are written; a core file it lacks was not there
  // when it was taken, so one there now (the safety copy just read it) goes.
  const steps: Array<[string, string | undefined]> = [
    ...coreFilesOf(snapshot.files).map((n): [string, string] => [n, snapshot.files[n]!]),
    ...present.filter((n) => isCoreFile(n) && !(n in snapshot.files)).map((n): [string, undefined] => [n, undefined]),
  ];
  for (const [name, content] of steps) {
    try {
      if (content === undefined) await removeCoreFile(provider, agent.runtimeRef, agent.slug, name);
      else await writeCoreFile(provider, agent.runtimeRef, agent.slug, name, content);
    } catch (err) {
      rethrowIfCrash(err);
      // Each file is written whole (tmp + mv), but the set is not: files
      // before this one are already the snapshot's. Say so, and where the
      // way back is, rather than a bare write error (issue #12).
      log('snapshot.restore_partial', { agentId, snapshotId, restored, failed: name, error: String(err) });
      const why = err instanceof SnapshotError ? err.userMessage : String(err);
      const msg =
        `${why}${restored.length ? ` ${restored.join(', ')} ${restored.length === 1 ? 'was' : 'were'} already restored.` : ' Nothing was changed.'} ` +
        `The snapshot "before restoring ${snapshot.label}" holds how its files were.`;
      if (restored.length) op.fail(msg);
      else op.rolledBack(msg);
      throw new SnapshotError(msg);
    }
    restored.push(name);
    op.step('file-written', { restored: [...restored] });
  }
  restoreParamLayer(store, agentId, snapshot);
  op.step('written');
  log('snapshot.restored', { agentId, snapshotId, restored });
  op.done(`Restored its files from "${snapshot.label}".`);
  return { restored, safetySnapshotId };
}

/**
 * Put the setup-values layer back as it was when the snapshot was taken, once
 * its files are written: the layer is what "Apply values" re-renders SOUL/
 * AGENTS from (#68). The persona's layer stays: snapshots do not hold the
 * persona. A snapshot from before the layer was recorded makes the restored
 * files the layer, the rule a direct file edit follows.
 */
function restoreParamLayer(store: Store, agentId: string, snapshot: StoredSnapshot): void {
  const agent = store.getAgent(agentId);
  if (!agent) return;
  const p = snapshot.params;
  if (p === undefined) {
    if (!agent.paramFiles) return;
    const layer = { ...agent.paramFiles };
    if (typeof snapshot.files['SOUL.md'] === 'string') layer.soul = snapshot.files['SOUL.md'];
    if (typeof snapshot.files['AGENTS.md'] === 'string') layer.agents = snapshot.files['AGENTS.md'];
    store.setAgentParamState(agentId, agent.paramValues ?? {}, layer);
  } else if (p === null) {
    // It had no layer then: the next value edit seeds one from the restored files.
    if (agent.paramFiles) store.setAgentParamState(agentId, agent.paramValues ?? null, null);
  } else {
    store.setAgentParamState(agentId, p.values, { ...(agent.paramFiles ?? {}), soul: p.soul, agents: p.agents });
  }
}

const isCoreFile = (n: string): boolean => (CORE_FILES as readonly string[]).includes(n);

/** The files a snapshot holds that a restore writes (only the core files, ever). */
function coreFilesOf(files: Record<string, string>): string[] {
  return Object.keys(files).filter(isCoreFile);
}

/** Make the core files a snapshot's: its files written, the ones it lacks (absent when it was taken) removed (#214). */
async function writeSnapshotFiles(
  deps: SnapshotDeps, runtimeRef: string, slug: string, files: Record<string, string>, via: VolumeAccess = {},
): Promise<void> {
  for (const name of coreFilesOf(files)) await writeCoreFile(deps.provider, runtimeRef, slug, name, files[name]!, via);
  for (const name of CORE_FILES) if (!(name in files)) await removeCoreFile(deps.provider, runtimeRef, slug, name, via);
}

const SNAPSHOT_CHOICES = {
  actions: [
    { action: 'finish', label: 'Finish' },
    { action: 'revert', label: 'Revert to the copy taken before' },
  ],
  recommended: 'finish',
};

/**
 * A snapshot restore a restart cut off part-way through its files (the
 * design's restore-snapshot row). What the files hold now decides: all the
 * snapshot's → done; all as before → nothing was changed; a mix (or they
 * cannot be read) → held for the owner, with [Finish] and [Revert to the copy
 * taken before] — that snapshot is already saved.
 */
export async function resumeSnapshotRestore(deps: SnapshotDeps, opId: string): Promise<void> {
  const op = handleFor(deps.store, opId);
  const row = op.get();
  const p = row.params as { snapshotId?: string; safetySnapshotId?: string; label?: string };
  const agent = row.agentId ? deps.store.getAgent(row.agentId) : undefined;
  if (!agent?.runtimeRef || agent.state === 'DELETED') { op.fail('Interrupted by a restart; the agent is gone.'); return; }
  const label = p.label ?? 'a snapshot';
  if (!row.step) {
    op.rolledBack(`The restore of "${label}" was interrupted by a restart before any file was written — nothing was changed.`);
    return;
  }
  const snapshot = p.snapshotId ? deps.store.getSnapshot(agent.id, p.snapshotId) : undefined;
  const safety = p.safetySnapshotId ? deps.store.getSnapshot(agent.id, p.safetySnapshotId) : undefined;
  if (row.step === 'written') { op.done(`Restored its files from "${label}".`); return; }
  let now: Record<string, string> | undefined;
  // A stopped agent's files are read on its volume (its container cannot exec).
  const via: VolumeAccess = agent.state === 'STOPPED' ? { onVolume: true, image: agent.image ?? undefined } : {};
  try { now = await readCoreFiles(deps.provider, agent.runtimeRef, agent.slug, via); } catch { now = undefined; }
  if (now && snapshot) {
    // Every core file, so one the snapshot lacks must be gone too (#214).
    if (CORE_FILES.every((n) => now![n] === snapshot.files[n])) {
      restoreParamLayer(deps.store, agent.id, snapshot);
      op.done(`Restored its files from "${label}".`);
      return;
    }
    // Strict, as above: a file the restore made (empty) where the copy taken
    // before had none is a change, not "nothing" (review R06, 2026-10-23).
    if (safety && CORE_FILES.every((n) => now![n] === safety.files[n])) {
      op.rolledBack(`The restore of "${label}" was interrupted by a restart before any file was written — nothing was changed.`);
      return;
    }
  }
  op.hold(
    `Restoring "${label}" was interrupted by a restart part-way through its files, so they are a mix of before and after.`,
    safety ? SNAPSHOT_CHOICES : { actions: [SNAPSHOT_CHOICES.actions[0]!], recommended: 'finish' },
  );
}

/** The owner's choice on a held snapshot restore. */
export async function recoverSnapshotRestore(deps: SnapshotDeps, opId: string, action: string): Promise<void> {
  const op = handleFor(deps.store, opId);
  const row = op.get();
  const p = row.params as { snapshotId?: string; safetySnapshotId?: string; label?: string };
  const agent = row.agentId ? deps.store.getAgent(row.agentId) : undefined;
  if (!agent?.runtimeRef) throw new SnapshotError('The agent is gone.');
  // A stopped agent's files are written on its volume: Start is refused
  // while this choice waits, so "start it first" was a dead end (#86).
  if (agent.state !== 'RUNNING' && agent.state !== 'STOPPED') throw new SnapshotError(`It is ${agent.state.toLowerCase()}: wait for it to settle, or retry it, then choose again.`);
  const via: VolumeAccess = agent.state === 'STOPPED' ? { onVolume: true, image: agent.image ?? undefined } : {};
  const label = p.label ?? 'a snapshot';
  if (action === 'revert') {
    const safety = p.safetySnapshotId ? deps.store.getSnapshot(agent.id, p.safetySnapshotId) : undefined;
    if (!safety) throw new SnapshotError('The snapshot taken before the restore is gone, so there is nothing to revert to. Finish instead.');
    await writeSnapshotFiles(deps, agent.runtimeRef, agent.slug, safety.files, via);
    restoreParamLayer(deps.store, agent.id, safety);
    op.rolledBack(`Reverted its files to how they were before restoring "${label}".`);
    return;
  }
  const snapshot = p.snapshotId ? deps.store.getSnapshot(agent.id, p.snapshotId) : undefined;
  if (!snapshot) throw new SnapshotError(`The snapshot "${label}" no longer exists, so the restore cannot be finished. Revert instead.`);
  await writeSnapshotFiles(deps, agent.runtimeRef, agent.slug, snapshot.files, via);
  restoreParamLayer(deps.store, agent.id, snapshot);
  op.step('written');
  op.done(`Restored its files from "${label}".`);
}

function defaultLabel(reason: SnapshotReason): string {
  switch (reason) {
    case 'pre-edit':
      return 'before an edit';
    case 'pre-restore':
      return 'before a restore';
    case 'pre-rebuild':
      return 'before a rebuild';
    case 'pre-adopt':
      return 'before adopting a workspace';
    case 'scheduled':
      return 'automatic';
    default:
      return 'manual snapshot';
  }
}
