import type { ChannelProvisioner } from '../channels/channel.js';
import type { RuntimeProvider } from '../providers/provider.js';
import type { SecretStore } from '../secrets/secretStore.js';
import type { Store } from '../store/store.js';
import { AgentBusyError, whileBusy } from './busy.js';
import { recoverMigrate, resumeMigrate } from './migrate.js';
import { recoverMoveHost, resumeMoveHost } from './moveHost.js';
import { handleFor, markInterrupted, rethrowIfCrash, type Operation } from './operations.js';
import type { ProvisionDeps } from './provision.js';
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
}

export class RecoverError extends Error {
  constructor(readonly userMessage: string, readonly status = 409) {
    super(userMessage);
    this.name = 'RecoverError';
  }
}

const RESUMABLE = new Set(['move-host', 'migrate', 'import']);

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
    default:
      // Not instrumented yet (later phases): recorded as interrupted, nothing guessed.
      handleFor(ctx.store, op.id).fail(`Interrupted by a restart.`);
  }
}

/** Settle one interrupted operation; a recovery that itself fails is held with [Try again]. */
async function resumeOne(ctx: ResumeContext, op: Operation, askAttempts?: number): Promise<void> {
  const settle = () => runKind(ctx, op, undefined, askAttempts);
  try {
    if (op.agentId) await whileBusy(op.agentId, settle);
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
  const ops = ctx.store.operationsWithStatus(['interrupted']);
  await Promise.allSettled(ops.map((op) => resumeOne(ctx, op)));
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
  // An import's only choice is to try its undo again: its restart rule.
  const run = () => runKind(ctx, op, RESUMABLE.has(op.kind) && op.kind !== 'import' ? action : undefined);
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
