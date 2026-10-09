import type { ChannelProvisioner } from '../channels/channel.js';
import type { RuntimeProvider } from '../providers/provider.js';
import type { SecretStore } from '../secrets/secretStore.js';
import type { Store } from '../store/store.js';
import type { InstallDeps } from './apps.js';
import { recoverAppOperation, resumeAppOperation } from './appOperations.js';
import { resumeArchive } from './archive.js';
import { recoverBackupRestore, resumeBackupRestore } from './backups.js';
import { AgentBusyError, whileBusy } from './busy.js';
import { recoverMigrate, resumeMigrate } from './migrate.js';
import { recoverMoveHost, resumeMoveHost } from './moveHost.js';
import { BACKGROUND_KINDS, currentBootId, handleFor, markInterrupted, rethrowIfCrash, type Operation } from './operations.js';
import { reapplyCurrentSettings, type ProvisionDeps } from './provision.js';
import { applyReconcileRule } from './reconcile.js';
import { recoverSnapshotRestore, resumeSnapshotRestore } from './snapshots.js';
import { resumeImport } from './transfer.js';

/**
 * After a restart: settle every operation the last process left running
 * (docs/operations-and-one-interface-design.md, "After a restart"). Runs at
 * boot after the first reconcile (index.ts), in the background. Each kind's
 * rule lives beside its code: resumeMoveHost, resumeMigrate, resumeImport.
 * The owner's choices on a held operation come through recoverOperation
 * (POST /v1/operations/:id/recover).
 */
export interface ResumeContext {
  store: Store;
  secrets: SecretStore;
  channel: ChannelProvisioner;
  embedder?: ProvisionDeps['embedder'];
  providerForHost: (hostId: string) => RuntimeProvider | undefined;
  /** The agent's timeline + journal writer (routes' trace). */
  logFor?: (agentId: string | null) => (event: string, detail: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Does this machine answer? (moveHost's machineAnswers by default.) */
  answers?: (p: RuntimeProvider) => Promise<boolean>;
  /**
   * Put a rebuild queued before the restart back in the queue (the routes'
   * kickRebuild, with the agent as it was asked for). False: it may not run
   * now (another rebuild already under way, an operation on disk).
   */
  requeueRebuild?: (op: Operation) => boolean;
  /** How to reach an agent's apps (the routes' appDeps); undefined when it has no runtime. */
  appDeps?: (agentId: string) => InstallDeps | undefined;
}

export class RecoverError extends Error {
  constructor(readonly userMessage: string, readonly status = 409) {
    super(userMessage);
    this.name = 'RecoverError';
  }
}

/** Kinds whose held choices are their own (the rest offer only "Try again": their restart rule, run again). */
const CHOICES = new Set(['move-host', 'migrate', 'restore-backup', 'restore-snapshot', 'app-install', 'app-update', 'app-rollback']);
/** Kinds that handle "Try again" themselves. */
const OWN_RETRY = new Set(['move-host', 'migrate']);

function depsFor(ctx: ResumeContext, op: Operation): ProvisionDeps | undefined {
  const agent = op.agentId ? ctx.store.getAgent(op.agentId) : undefined;
  const provider = agent ? ctx.providerForHost(agent.hostId) : undefined;
  if (!provider) return undefined;
  return {
    store: ctx.store, secrets: ctx.secrets, provider, channel: ctx.channel, embedder: ctx.embedder,
    log: ctx.logFor?.(op.agentId), ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
  };
}

async function runKind(ctx: ResumeContext, op: Operation, action: string | undefined, askAttempts?: number): Promise<void> {
  const log = ctx.logFor?.(op.agentId);
  switch (op.kind) {
    case 'move-host': {
      const deps = {
        store: ctx.store, secrets: ctx.secrets, channel: ctx.channel, embedder: ctx.embedder,
        providerForHost: ctx.providerForHost, answers: ctx.answers, log, ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
      };
      return action ? recoverMoveHost(deps, op.id, action) : resumeMoveHost(deps, op.id);
    }
    case 'migrate': {
      const deps = depsFor(ctx, op);
      if (!deps) throw new Error('the machine it is on is not known here any more');
      return action ? recoverMigrate(deps, op.id, action) : resumeMigrate(deps, op.id, askAttempts);
    }
    case 'import': {
      const deps = depsFor(ctx, op);
      if (!deps) throw new Error('the machine it was being imported onto is not known here any more');
      return resumeImport(deps, op.id);
    }
    case 'restore-backup': {
      const deps = depsFor(ctx, op);
      if (!deps) throw new Error('the machine it is on is not known here any more');
      const rdeps = { store: ctx.store, provider: deps.provider, log, reapply: () => reapplyCurrentSettings(deps, op.agentId!) };
      return action ? recoverBackupRestore(rdeps, op.id, action) : resumeBackupRestore(rdeps, op.id);
    }
    case 'restore-snapshot': {
      const deps = depsFor(ctx, op);
      if (!deps) throw new Error('the machine it is on is not known here any more');
      const sdeps = { store: ctx.store, provider: deps.provider, log };
      return action ? recoverSnapshotRestore(sdeps, op.id, action) : resumeSnapshotRestore(sdeps, op.id);
    }
    case 'archive': {
      const deps = depsFor(ctx, op);
      if (!deps) throw new Error('the machine it is on is not known here any more');
      return resumeArchive({ store: ctx.store, secrets: ctx.secrets, provider: deps.provider, channel: ctx.channel as never, log: log ?? (() => {}) }, op.id);
    }
    case 'app-install':
    case 'app-update':
    case 'app-rollback': {
      const install = op.agentId ? ctx.appDeps?.(op.agentId) : undefined;
      if (!install) throw new Error('its agent cannot be reached to compare its app with the record');
      const adeps = { store: ctx.store, install };
      return action ? recoverAppOperation(adeps, op.id, action) : resumeAppOperation(adeps, op.id);
    }
    case 'rebuild':
    case 'provision':
      return resumeBackground(ctx, op);
    case 'install-image':
      handleFor(ctx.store, op.id).fail('The image copy was interrupted by a restart — install it again.', {
        actions: [{ action: 'install-again', label: 'Install again' }], recommended: 'install-again',
      });
      return;
    case 'backup-run':
      handleFor(ctx.store, op.id).fail("The backup run was interrupted by a restart, so the set it was writing is incomplete — run Back up now again, or wait for tonight's run.");
      return;
    default:
      // A kind not instrumented: recorded as interrupted, nothing guessed.
      handleFor(ctx.store, op.id).fail(`Interrupted by a restart.`);
  }
}

/**
 * A rebuild or a setup after a restart (the design's provision / rebuild
 * row): reconcile's rules, applied on purpose, the outcome on the record. A
 * rebuild still waiting its turn — or cut off before it touched the container
 * (its snapshot, its checkpoint turn) — is queued again. A machine that does
 * not answer leaves it interrupted, asked again by the 10-minute pass.
 */
async function resumeBackground(ctx: ResumeContext, op: Operation): Promise<void> {
  const h = handleFor(ctx.store, op.id);
  const agent = op.agentId ? ctx.store.getAgent(op.agentId) : undefined;
  const what = op.kind === 'rebuild' ? 'rebuild' : 'setup';
  if (!agent || agent.state === 'DELETED' || agent.state === 'ARCHIVED') {
    h.rolledBack(`Not finished: the agent was ${agent?.state === 'ARCHIVED' ? 'archived' : 'deleted'} meanwhile.`);
    return;
  }
  const requeue = (why: string) => {
    if (op.kind === 'rebuild' && ctx.requeueRebuild?.(op)) return true;
    h.rolledBack(`Not rebuilt: it ${why} when Hatchabot restarted, and could not be queued again now (another rebuild, or an operation, is under way). Rebuild it again.`);
    return false;
  };
  if (op.status === 'queued') { requeue('was waiting its turn'); return; }
  if (op.kind === 'rebuild' && (agent.state === 'RUNNING' || agent.state === 'STOPPED')) {
    // Cut off before the REBUILDING flip: the container was never touched.
    requeue('had not touched its container yet');
    return;
  }
  const busyState = op.kind === 'rebuild' ? 'REBUILDING' : 'PROVISIONING';
  if (agent.state !== busyState) {
    if (agent.state === 'RUNNING') h.done(`The ${what} had finished before the restart.`);
    else h.fail(agent.stateReason ?? `The ${what} was interrupted by a restart.`);
    return;
  }
  const provider = ctx.providerForHost(agent.hostId);
  if (!provider) throw new Error('the machine it is on is not known here any more');
  const status = agent.runtimeRef ? await provider.status(agent.runtimeRef) : undefined;
  const base = ctx.logFor?.(agent.id) ?? (() => {});
  // "Not answering" is said by reconcile's own sweep; asked again every 10 minutes, it would repeat.
  const log = (e: string, d: Record<string, unknown>) => { if (e !== 'reconcile.host_unreachable') base(e, d); };
  if (applyReconcileRule(ctx.store, agent, status, log) === 'unknown') return; // still interrupted: the next pass asks again
  const after = ctx.store.getAgent(agent.id)!;
  if (after.state === 'RUNNING') h.done(`Interrupted by a restart; it was running again, so it is marked running.`);
  else if (after.state === 'FAILED') h.fail(after.stateReason ?? `The ${what} was interrupted by a restart — tap Retry.`);
  else if (after.pendingAction) h.fail('Setup was interrupted by a restart while it waited for a step from you — finish that step on its page.');
  else h.fail(`The ${what} was interrupted by a restart.`);
}

/** Settle one interrupted operation; a recovery that itself fails is held with [Try again]. */
async function resumeOne(ctx: ResumeContext, op: Operation, askAttempts?: number): Promise<void> {
  const settle = () => runKind(ctx, op, undefined, askAttempts);
  try {
    // A rebuild or setup is guarded in memory by its own task (re-queued here, it takes the busy flag at its turn).
    if (op.agentId && !BACKGROUND_KINDS.includes(op.kind)) await whileBusy(op.agentId, settle);
    else await settle();
  } catch (err) {
    rethrowIfCrash(err);
    if (err instanceof AgentBusyError) return; // someone else is on it; the next pass will see
    const h = handleFor(ctx.store, op.id);
    if (['interrupted', 'running', 'held'].includes(h.get().status)) {
      h.hold(
        `Putting it right after a restart failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
        { actions: [{ action: 'retry', label: 'Try again' }], recommended: 'retry' },
      );
    }
    ctx.logFor?.(op.agentId)('op.resume_failed', { op: op.id, error: String(err).slice(0, 300) });
  }
}

/**
 * Every `running` row from an earlier process is interrupted; settle each by
 * its kind's rule. Independent agents are settled side by side (a move to
 * another Hatchabot may wait minutes for that server to answer).
 */
export async function resumeOperations(ctx: ResumeContext): Promise<void> {
  markInterrupted(ctx.store);
  // Rebuilds still waiting their turn when the last process ended: queued again.
  const queued = ctx.store.operationsWithStatus(['queued']).filter((o) => o.bootId !== currentBootId() && BACKGROUND_KINDS.includes(o.kind));
  const ops = ctx.store.operationsWithStatus(['interrupted']);
  await Promise.allSettled([...queued, ...ops].map((op) => resumeOne(ctx, op)));
}

/**
 * The owner's choice on a held operation. Only an action the operation
 * offers; `retry` re-runs the kind's restart rule.
 */
export async function recoverOperation(ctx: ResumeContext, opId: string, action: string): Promise<Operation> {
  const op = ctx.store.getOperation(opId);
  if (!op) throw new RecoverError('Not found', 404);
  if (op.status !== 'held') throw new RecoverError('There is nothing to choose: this operation is not waiting on you.');
  if (!op.recovery?.actions.some((a) => a.action === action)) {
    throw new RecoverError(`"${action}" is not one of this operation's choices.`, 400);
  }
  // "Try again" (offered when putting it right failed) runs the kind's restart
  // rule again; the other choices are the kind's own.
  const own = CHOICES.has(op.kind) && (action !== 'retry' || OWN_RETRY.has(op.kind));
  const run = () => runKind(ctx, op, own ? action : undefined);
  try {
    if (op.agentId) await whileBusy(op.agentId, run);
    else await run();
  } catch (err) {
    if (err instanceof AgentBusyError) throw new RecoverError('It is busy with this already — wait a moment.');
    const msg = (err as { userMessage?: string }).userMessage;
    if (msg) throw new RecoverError(msg);
    throw err;
  }
  return ctx.store.getOperation(opId)!;
}

/**
 * A move to another Hatchabot held because that server did not say whether
 * the agent arrived: asked again on a timer until it answers (the design's
 * "retry the question every 10 minutes"). Start stays refused meanwhile.
 */
export async function retryHeldOperations(ctx: ResumeContext): Promise<void> {
  // One the boot pass could not take (the agent was busy then) is settled now.
  for (const op of ctx.store.operationsWithStatus(['interrupted'])) await resumeOne(ctx, op);
  for (const op of ctx.store.operationsWithStatus(['held'])) {
    if (op.kind !== 'migrate' || !op.recovery?.actions.some((a) => a.action === 'retry')) continue;
    await resumeOne(ctx, { ...op }, 1);
  }
}

export function startOperationRetryLoop(ctx: ResumeContext, intervalMs = 10 * 60_000): NodeJS.Timeout {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void retryHeldOperations(ctx).catch(() => {}).finally(() => { running = false; });
  }, intervalMs);
  timer.unref();
  return timer;
}
