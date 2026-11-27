import type { ChannelProvisioner } from '../../channels/channel.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import type { Store } from '../../store/store.js';
import type { InstallDeps } from '../apps/apps.js';
import { recoverAppOperation, resumeAppOperation } from '../apps/appOperations.js';
import { resumeArchive, type ArchiveDeps } from './archive.js';
import { recoverBackupRestore, resumeBackupRestore } from '../backups/backupFiles.js';
import { AgentBusyError, whileBusy, type Reservation } from './busy.js';
import { recoverMigrate, resumeMigrate, type MigrateDeps } from '../transfer/migrate.js';
import { recoverMoveHost, resumeMoveHost } from '../transfer/moveHost.js';
import { atPointForTests, BACKGROUND_KINDS, currentBootId, FILES_REPLACED_BY, handleFor, isFinished, markInterrupted, noteFilesReplacing, rethrowIfCrash, settleOwedStart, startOwedIn, type Operation, type StartAfter } from './operations.js';
import { finishInterruptedRebuild, reapplyCurrentSettings, runProvisionSteps, type ProvisionDeps } from './provision.js';
import { applyReconcileRule } from './reconcile.js';
import { recoverSnapshotRestore, resumeSnapshotRestore } from '../files/snapshots.js';
import { resumeImport, startCutOffDownloads } from '../transfer/transfer.js';
import { recoverAdoptWorkspace, resumeAdoptWorkspace } from '../transfer/adopt.js';

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
  /** How a resumed move calls the other server (migrate's peerFetch). */
  peerFetch?: MigrateDeps['peerFetch'];
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
  /**
   * The recovery a source switch chained after its rebuild (the routes'
   * memory.history.afterRebuild), for one this pass finishes itself: run
   * once `done` settles, if the rebuild put it on its new source.
   */
  recoverAfterRebuild?: (agentId: string, done: Promise<unknown>) => void;
  /** How to reach an agent's apps (the routes' appDeps); undefined when it has no runtime. */
  appDeps?: (agentId: string) => InstallDeps | undefined;
  /** Tell an owner on their chat app (the routes' tellOwner), for what a restart settles with nobody watching. */
  tellOwner?: (ownerId: string, agentId: string, text: string) => Promise<boolean>;
  /** What a Start runs once it is up (the routes' clearPinsWhenUp), for an agent a recovery started. */
  afterStart?: (agentId: string) => void;
  /**
   * Start a stopped agent as the Start button does (power.ts startStopped:
   * the rebuild it is owed, its limits, its sleep mark), for a choice or a
   * restart rule that ends with a start (StartAfter: an adopt's). Run once it
   * has let go of the agent's busy flag. `ownerAsked`: the owner's own choice
   * (true), or a start a restart left (false), which is not rebuilt only
   * because its peers changed: power.ts keeps that for the owner's own Start.
   */
  startStopped?: (agentId: string, opts: { ownerAsked: boolean; stillOwed?: () => boolean }) => Promise<{ ok: boolean; rebuilding?: boolean; error?: string; notOwed?: true; leftOwed?: true }>;
  /** A rebuild of the agent under way or queued (the rebuild queue's isInFlight): it starts the agent. */
  isInFlight?: (agentId: string) => boolean;
  /** An archive's Discord and Slack bots, parked as it finishes (the routes' parkArchivedChannels). */
  parkOtherChannels?: ArchiveDeps['parkOtherChannels'];
}

export class RecoverError extends Error {
  constructor(readonly userMessage: string, readonly status = 409) {
    super(userMessage);
    this.name = 'RecoverError';
  }
}

/** Kinds whose held choices are their own (the rest offer only "Try again": their restart rule, run again). */
const CHOICES = new Set(['move-host', 'migrate', 'restore-backup', 'restore-snapshot', 'app-install', 'app-update', 'app-rollback', 'adopt-workspace']);
/** Kinds that handle "Try again" themselves. */
const OWN_RETRY = new Set(['move-host', 'migrate']);

function depsFor(ctx: ResumeContext, op: Operation): MigrateDeps | undefined {
  const agent = op.agentId ? ctx.store.getAgent(op.agentId) : undefined;
  const provider = agent ? ctx.providerForHost(agent.hostId) : undefined;
  if (!provider) return undefined;
  return {
    store: ctx.store, secrets: ctx.secrets, provider, channel: ctx.channel, embedder: ctx.embedder,
    log: ctx.logFor?.(op.agentId), ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    ...(ctx.peerFetch ? { peerFetch: ctx.peerFetch } : {}),
  };
}

/** What a kind's choice or restart rule leaves for after it lets go of the agent: a Start (StartAfter). */
type ChoiceThen = StartAfter | void;

/** What an owed start's record says once it has run (after the operation's own outcome). */
const STARTED_WORDS = 'It was started again, as Start starts it.';
const REBUILT_WORDS = 'Its start is the rebuild it was owed.';
const notStartedWords = (why: string) => `It could not be started (${why}), so it is stopped: start it once that is put right.`;

/**
 * The Start an operation owes (StartAfter), run once the agent's busy flag is
 * let go, and what came of it put on the record (settleOwedStart); the words
 * for the owner when it could not start. A death before it or during it
 * leaves it owed, for the next boot (startsStillOwed). One no longer owed
 * when it comes to it is not run.
 */
async function startAsStartDoes(ctx: ResumeContext, opId: string, agentId: string, ownerAsked: boolean, then?: StartAfter): Promise<string | undefined> {
  atPointForTests(ctx.store.getOperation(opId), '#start-owed');
  // Its owner's Start or Stop, or a budget's pause, took it over meanwhile (settleStartsOwedOn).
  const stillOwed = (): boolean => { const now = ctx.store.getOperation(opId); return !!now && startOwedIn(now) !== undefined; };
  if (!stillOwed()) return undefined;
  // Judged again by the start itself, once its checks are done and under its lock (HB-1252).
  const r: { ok: boolean; rebuilding?: boolean; error?: string; notOwed?: true; leftOwed?: true } = ctx.startStopped
    ? await ctx.startStopped(agentId, { ownerAsked, stillOwed }).catch((err: unknown) => { rethrowIfCrash(err); return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 200) }; })
    : { ok: false, error: 'nothing here can start it' };
  // Taken over while it was being checked: whoever took it over wrote its words.
  // Or the process stopped while it waited for another holder: still owed, for the next boot.
  if (r.notOwed || r.leftOwed) return undefined;
  if (r.ok) { settleOwedStart(ctx.store, opId, r.rebuilding ? REBUILT_WORDS : STARTED_WORDS); return undefined; }
  const why = String(r.error ?? 'no reason given').slice(0, 300);
  ctx.logFor?.(agentId)('op.start_failed', { error: why });
  settleOwedStart(ctx.store, opId, notStartedWords(why));
  return then ? then.startAfter.notStarted(why) : why;
}

/**
 * The starts operations finished before this boot still owe (HB-0980): the
 * process ended after one was finished and before its Start had run, or
 * during it. Each is started once, as Start starts it. One whose agent is
 * gone, or not stopped (running already, rebuilding, archived), is owed
 * nothing any more, nor one its owner started or stopped since, or a budget
 * paused (settleStartsOwedOn). One owed in this boot is its own caller's to run.
 */
async function startsStillOwed(ctx: ResumeContext): Promise<void> {
  const owed = ctx.store.operationsOwingStart().filter((op) => isFinished(op) && startOwedIn(op) !== currentBootId());
  await Promise.allSettled(owed.map(async (op) => {
    const a = op.agentId ? ctx.store.getAgent(op.agentId) : undefined;
    if (!a || a.state !== 'STOPPED') { settleOwedStart(ctx.store, op.id); return; }
    await startAsStartDoes(ctx, op.id, a.id, false);
  }));
}

/**
 * `held`: the caller's own reservation of the agent (the owner's choice runs
 * under it), which a setup's or rebuild's restart rule goes on under
 * (`reuse`) rather than take the agent again.
 */
async function runKind(ctx: ResumeContext, op: Operation, action: string | undefined, askAttempts?: number, held?: Reservation): Promise<ChoiceThen> {
  const log = ctx.logFor?.(op.agentId);
  // Started again: a snapshot by hand reading its files meanwhile is not
  // kept, as when it first began. A rebuild or setup counts where it runs
  // its steps again, or at its start once queued again (resumeBackground).
  if (op.agentId && FILES_REPLACED_BY.has(op.kind) && !BACKGROUND_KINDS.includes(op.kind)) noteFilesReplacing(op.agentId);
  switch (op.kind) {
    case 'move-host': {
      const deps = {
        store: ctx.store, secrets: ctx.secrets, channel: ctx.channel, embedder: ctx.embedder,
        providerForHost: ctx.providerForHost, answers: ctx.answers, log, ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
        // The owner's own choice has them on the page: only what a restart settles is told.
        ...(!action && ctx.tellOwner ? { tell: ctx.tellOwner } : {}),
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
      const rdeps = { store: ctx.store, provider: deps.provider, log, reapply: () => reapplyCurrentSettings(deps, op.agentId!), afterStart: ctx.afterStart };
      return action ? recoverBackupRestore(rdeps, op.id, action) : resumeBackupRestore(rdeps, op.id);
    }
    case 'restore-snapshot': {
      const deps = depsFor(ctx, op);
      if (!deps) throw new Error('the machine it is on is not known here any more');
      const sdeps = { store: ctx.store, provider: deps.provider, log };
      return action ? recoverSnapshotRestore(sdeps, op.id, action) : resumeSnapshotRestore(sdeps, op.id);
    }
    case 'adopt-workspace': {
      const deps = depsFor(ctx, op);
      if (!deps) throw new Error('the machine it is on is not known here any more');
      // Its starts are a Start's (StartAfter), run by recoverOperation or resumeOne once the busy flag is let go.
      const adeps = { store: ctx.store, provider: deps.provider, log };
      return action ? recoverAdoptWorkspace(adeps, op.id, action) : resumeAdoptWorkspace(adeps, op.id);
    }
    case 'archive': {
      const deps = depsFor(ctx, op);
      if (!deps) throw new Error('the machine it is on is not known here any more');
      return resumeArchive({
        store: ctx.store, secrets: ctx.secrets, provider: deps.provider, channel: ctx.channel as never, log: log ?? (() => {}),
        parkOtherChannels: ctx.parkOtherChannels,
      }, op.id);
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
      return resumeBackground(ctx, op, held);
    case 'install-image':
      handleFor(ctx.store, op.id).fail('The image copy was interrupted by a restart — install it again.', {
        actions: [{ action: 'install-again', label: 'Install again' }], recommended: 'install-again',
      });
      return;
    case 'backup-run':
      handleFor(ctx.store, op.id).fail("The backup run was interrupted by a restart, so the set it was writing is incomplete — run Back up now again, or wait for tonight's run.");
      return;
    case 'restore-drill':
      // Nothing live was touched; its throwaway volume goes at the next drill's start.
      handleFor(ctx.store, op.id).fail('The restore drill was interrupted by a restart, so it proved nothing — run a drill again (Settings → Backups).');
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
async function resumeBackground(ctx: ResumeContext, op: Operation, held?: Reservation): Promise<void> {
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
  // Up is not set up: a gateway that answers says nothing of the steps after
  // it — its git sources, connections, rebuild hook, schedules. Marked
  // running on health alone, a repo source was never cloned (audit #082).
  // Its steps run again, as Retry runs them: the volume is kept, and each
  // step leaves what is done as it is.
  // Each counts as replacing its files under its own take, not before it (HB-1491).
  if (op.kind === 'provision' && !agent.pendingAction && status?.phase === 'running' && status.healthy) {
    const r = await runProvisionSteps({
      store: ctx.store, secrets: ctx.secrets, provider, channel: ctx.channel, embedder: ctx.embedder, log: base,
      ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    }, agent.id, { reuse: held });
    if (r.agent.state === 'RUNNING') h.done('Interrupted by a restart after it came up; the rest of its setup ran again, and it is running.');
    else if (r.agent.state === 'FAILED') h.fail(r.agent.stateReason ?? 'Setup was interrupted by a restart — tap Retry.');
    else if (r.agent.pendingAction) h.fail('Setup was interrupted by a restart while it waited for a step from you — finish that step on its page.');
    else h.fail('Setup was interrupted by a restart.');
    return;
  }
  // A rebuild likewise: up after its new container was made, its steps after
  // health (sources, hook, parked schedules) had not run (HB-0301).
  if (op.kind === 'rebuild' && status?.phase === 'running' && status.healthy) {
    const finishing = finishInterruptedRebuild({
      store: ctx.store, secrets: ctx.secrets, provider, channel: ctx.channel, embedder: ctx.embedder, log: base,
      ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    }, agent.id, { reuse: held });
    // The recovery its switch chained after it (HB-0832), while the agent is
    // on the source it was asked for: requeueRebuild chains it for a rebuild
    // queued again, and one finished here had none (HB-1445). Its slot is
    // reserved now, as a live switch's is; it runs once the rebuild put the
    // agent on that source, and never on a rebuild that failed.
    const recoverOn = (op.params as { recoverOn?: unknown }).recoverOn;
    if (typeof recoverOn === 'string' && recoverOn && agent.aiProfileId === recoverOn) ctx.recoverAfterRebuild?.(agent.id, finishing.catch(() => undefined));
    const r = await finishing;
    if (r?.state === 'RUNNING') h.done('Interrupted by a restart after it came up; the rest of its rebuild ran again, and it is running.');
    else h.fail(r?.stateReason ?? 'The rebuild was interrupted by a restart — tap Retry.');
    return;
  }
  if (applyReconcileRule(ctx.store, agent, status, log) === 'unknown') return; // still interrupted: the next pass asks again
  const after = ctx.store.getAgent(agent.id)!;
  if (after.state === 'RUNNING') h.done(`Interrupted by a restart; it was running again, so it is marked running.`);
  else if (after.state === 'FAILED') h.fail(after.stateReason ?? `The ${what} was interrupted by a restart — tap Retry.`);
  // A bot-token step answered before the restart: said by what it holds, by
  // the rule the routes' boot pass then acts on (routes.ts, resumeOperations).
  else if (after.pendingAction?.received) {
    if (after.webOnly) h.rolledBack('Interrupted by a restart after it was set to go on without a Telegram bot; setup goes on without one.');
    else if (await tokenKept(ctx, after.id)) h.rolledBack('Interrupted by a restart after its bot token came in; the token was kept, and setup starts again with it.');
    else h.fail('Interrupted by a restart as its bot token came in, before it was kept: the agent asks for the token again — paste it on its page.');
  }
  else if (after.pendingAction) h.fail('Setup was interrupted by a restart while it waited for a step from you — finish that step on its page.');
  else h.fail(`The ${what} was interrupted by a restart.`);
}

/** Whether a bot token pasted before the restart is held for this agent (telegramManual.ts, on disk). */
async function tokenKept(ctx: ResumeContext, agentId: string): Promise<boolean> {
  return !ctx.channel.waitingFor || await ctx.channel.waitingFor(agentId).catch(() => false);
}

/** Settle one interrupted operation; a recovery that itself fails is held with [Try again]. */
async function resumeOne(ctx: ResumeContext, op: Operation, askAttempts?: number): Promise<void> {
  // `op` was read before the wait for the busy flag: the owner may have
  // settled it meanwhile (a held move they chose to keep here). Only one still
  // as it was read is settled; one settled already was put back on hold
  // (audit, 2026-10-20).
  const settle = async (): Promise<ChoiceThen> => {
    if (ctx.store.getOperation(op.id)?.status !== op.status) return;
    return runKind(ctx, op, undefined, askAttempts);
  };
  try {
    // A rebuild or setup is guarded in memory by its own task (re-queued here, it takes the busy flag at its turn).
    const then = op.agentId && !BACKGROUND_KINDS.includes(op.kind) ? await whileBusy(op.agentId, 'resume-operation', settle) : await settle();
    // Started again as Start starts it, now the rule has let go of the agent (a failure is on the record).
    if (then && op.agentId) await startAsStartDoes(ctx, op.id, op.agentId, false, then);
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
  return startResumeOperations(ctx).all;
}

/** The boot's pass over the operations, under way (startResumeOperations). */
export interface ResumingOperations {
  /** Every operation settled, and the starts they left owed made (resumeOperations' promise). */
  all: Promise<void>;
  /**
   * This agent's own operations settled: those of the pass, and the start
   * one of them left owed (made once every operation is settled, as
   * before). At once for an agent with none. What waits only for its
   * agent (the settings an earlier process had still to put on its
   * container, HB-0839) waits for this, not for `all`: a move of another
   * agent waiting minutes for another server holds up no one else.
   * Never rejects.
   */
  settledFor(agentId: string): Promise<void>;
}

/** resumeOperations, with each agent's own part of it to wait for. */
export function startResumeOperations(ctx: ResumeContext): ResumingOperations {
  markInterrupted(ctx.store);
  // Rebuilds still waiting their turn when the last process ended: queued again.
  const queued = ctx.store.operationsWithStatus(['queued']).filter((o) => o.bootId !== currentBootId() && BACKGROUND_KINDS.includes(o.kind));
  const ops = ctx.store.operationsWithStatus(['interrupted']);
  const byAgent = new Map<string, Array<Promise<void>>>();
  const settling = [...queued, ...ops].map((op) => {
    const p = resumeOne(ctx, op);
    if (op.agentId) byAgent.set(op.agentId, [...(byAgent.get(op.agentId) ?? []), p]);
    return p;
  });
  // Then the downloads a restart cut off, each started again (HB-1479).
  const all = Promise.allSettled(settling).then(() => startsStillOwed(ctx))
    .then(() => startCutOffDownloads({ store: ctx.store, startStopped: ctx.startStopped, isInFlight: ctx.isInFlight, logFor: (id) => ctx.logFor?.(id) ?? (() => {}) }));
  const owesStart = (agentId: string): boolean => {
    try {
      return ctx.store.operationsOwingStart().some((op) => op.agentId === agentId && startOwedIn(op) !== currentBootId())
        || ctx.store.agentHold(agentId, 'download-stop') !== undefined;
    } catch { return false; }
  };
  return {
    all,
    settledFor: async (agentId) => {
      await Promise.allSettled(byAgent.get(agentId) ?? []);
      if (owesStart(agentId)) await all.catch(() => undefined);
    },
  };
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
  // Run under the busy flag taken here, which the restart rule goes on under
  // rather than take it again (HB-0301): its reservation, handed on.
  const run = (held?: Reservation) => runKind(ctx, op, own ? action : undefined, undefined, held);
  let then: ChoiceThen;
  try {
    then = op.agentId ? await whileBusy(op.agentId, 'recover-operation', run) : await run();
  } catch (err) {
    if (err instanceof AgentBusyError) throw new RecoverError('It is busy with this already — wait a moment.');
    const msg = (err as { userMessage?: string }).userMessage;
    if (msg) throw new RecoverError(msg);
    throw err;
  }
  // A choice that ends with a start: as the Start button starts it, now the
  // choice has let go of the agent (startStopped takes the busy flag itself).
  if (then && op.agentId) {
    const said = await startAsStartDoes(ctx, op.id, op.agentId, true, then);
    if (said) throw new RecoverError(said);
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
