import { randomUUID } from 'node:crypto';
import type { RuntimeProvider } from '../providers/provider.js';
import type { Store } from '../store/store.js';

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

export type SnapshotReason = 'manual' | 'pre-edit' | 'pre-restore' | 'pre-rebuild' | 'scheduled';

export interface SnapshotDeps {
  store: Store;
  provider: RuntimeProvider;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export class SnapshotError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'SnapshotError';
  }
}

export function workspacePath(slug: string, name: string): string {
  return `/home/node/.openclaw/agents/${slug}/agent/${name}`;
}

export async function readCoreFiles(
  provider: RuntimeProvider,
  runtimeRef: string,
  slug: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of CORE_FILES) {
    // Cap the read: these live in SQLite and are captured automatically, so
    // an oversized MEMORY.md must not bloat the control plane.
    const res = await provider.execShell(
      runtimeRef,
      `head -c ${MAX_FILE_BYTES} ${JSON.stringify(workspacePath(slug, name))} 2>/dev/null || true`,
    );
    if (res.stdout) files[name] = res.stdout;
  }
  return files;
}

export async function writeCoreFile(
  provider: RuntimeProvider,
  runtimeRef: string,
  slug: string,
  name: string,
  content: string,
): Promise<void> {
  // base64 through the shell so arbitrary content can't break quoting.
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const res = await provider.execShell(
    runtimeRef,
    `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(workspacePath(slug, name))}`,
  );
  if (res.code !== 0) {
    throw new SnapshotError(`Couldn't write ${name}: ${res.stderr.slice(-200)}`);
  }
}

export interface SnapshotSummary {
  id: string;
  label: string;
  reason: string;
  createdAt: string;
  files: string[];
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
  const snapshot = {
    id: randomUUID(),
    agentId,
    label: (opts.label ?? '').trim().slice(0, 64) || defaultLabel(reason),
    reason,
    files,
    createdAt: new Date().toISOString(),
  };
  store.insertSnapshot(snapshot);
  const pruned = store.pruneAutoSnapshots(agentId, AUTO_KEEP);
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

  // A restore is itself destructive — capture the current state first so an
  // unwanted rollback is one more rollback away, not a loss.
  let safetySnapshotId: string | undefined;
  try {
    safetySnapshotId = (
      await captureSnapshot(deps, agentId, {
        reason: 'pre-restore',
        label: `before restoring ${snapshot.label}`,
      })
    ).id;
  } catch (err) {
    log('snapshot.safety_failed', { agentId, error: String(err) });
  }

  const restored: string[] = [];
  for (const [name, content] of Object.entries(snapshot.files)) {
    if (!(CORE_FILES as readonly string[]).includes(name)) continue; // stored data is ours, but be strict
    await writeCoreFile(provider, agent.runtimeRef, agent.slug, name, content);
    restored.push(name);
  }
  log('snapshot.restored', { agentId, snapshotId, restored });
  return { restored, safetySnapshotId };
}

function defaultLabel(reason: SnapshotReason): string {
  switch (reason) {
    case 'pre-edit':
      return 'before an edit';
    case 'pre-restore':
      return 'before a restore';
    case 'pre-rebuild':
      return 'before a rebuild';
    case 'scheduled':
      return 'automatic';
    default:
      return 'manual snapshot';
  }
}
