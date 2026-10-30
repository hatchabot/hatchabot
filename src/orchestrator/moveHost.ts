import { stopAndConfirm } from './quiesce.js';
import type { Agent } from '../domain/types.js';
import type { RuntimeProvider } from '../providers/provider.js';
import type { Store } from '../store/store.js';
import { whileBusy } from './busy.js';
import { beginOperation, handleFor, rethrowIfCrash, stepReached, type OpHandle } from './operations.js';
import {
  buildRuntimeSpec,
  forgetEmbedDecision,
  recordApplied,
  reindexMemoryIfSwitched,
  runRebuildHook,
  scrubRemovedDataSources,
  waitForHealthy,
  waitForSkillsSettled,
  type ProvisionDeps,
} from './provision.js';
import { TransferError } from './transfer.js';

/**
 * Move an agent to another host on THIS control plane (local ⇄ runner, or
 * runner ⇄ runner). Unlike a peer Rehost — which ships the agent to another
 * Hatchabot server and tombstones the copy here — a move keeps the same agent
 * record, bot, members, and memory; only the Docker daemon running the
 * container changes. That makes it simpler and safer: one control plane, one
 * bot token, no second poller to fence off.
 *
 * Flow: quiesce → snapshot the volume through the source provider → flip
 * hostId → recreate on the target (provision, restore the snapshot, re-apply
 * config) → start there → retire the source runtime. Any failure before the
 * target is healthy rolls everything back onto the source host.
 *
 * Each step is recorded as a `move-host` operation (operations.ts). A restart
 * in the middle is settled by resumeMoveHost: undone before the host flip,
 * finished after it, held when the machine it needs is not answering.
 *
 * Container/volume names are derived from the agent id, so the runtimeRef is
 * IDENTICAL on both daemons. Two consequences the code below leans on:
 *  - the store's runtimeRef never needs to change (set anyway, for legacy refs);
 *  - if source and target are the SAME daemon, "retiring the source" would
 *    destroy the runtime we just built — so it must be skipped (same provider
 *    instance) or the move refused up front (two host rows, one endpoint).
 */
export interface MoveDeps extends Omit<ProvisionDeps, 'provider'> {
  source: RuntimeProvider;
  target: RuntimeProvider;
  /** The host `source` was made for. The caller builds it before its own
   *  checks (awaits); the agent is judged on it again under the lock. */
  sourceHostId?: string;
  /** Who asked (owner id), for the operation's record. */
  requestedBy?: string;
  /** Told the operation's id as soon as it exists (the route returns it). */
  onOperation?: (id: string) => void;
  /** Move it onto the target's default image: its pin is dropped with the move, and put back if the move is undone. */
  dropPin?: boolean;
}

export async function moveAgentToHost(
  deps: MoveDeps,
  agentId: string,
  targetHostId: string,
): Promise<Agent> {
  return whileBusy(agentId, () => moveInner(deps, agentId, targetHostId));
}

async function moveInner(deps: MoveDeps, agentId: string, targetHostId: string): Promise<Agent> {
  const { store, source, target } = deps;
  const log = deps.log ?? (() => {});

  const agent = store.getAgent(agentId);
  if (!agent?.runtimeRef) throw new TransferError('This agent has no runtime to move yet.');
  if (agent.state !== 'RUNNING' && agent.state !== 'STOPPED') {
    throw new TransferError(`Can't move while the agent is ${agent.state}.`);
  }
  // `source` was made for the host the caller read before its checks; a move
  // that finished meanwhile left it pointing at a daemon the agent is no
  // longer on, and the export would read that one (concurrency review,
  // 2026-10-09).
  if (deps.sourceHostId && agent.hostId !== deps.sourceHostId) {
    throw new TransferError('It moved to another machine meanwhile. Look again, then move it from there.');
  }
  const sourceHost = store.getHost(agent.hostId);
  const targetHost = store.getHost(targetHostId);
  if (!sourceHost || !targetHost) throw new TransferError('Unknown host.');
  if (sourceHost.id === targetHost.id) {
    throw new TransferError('The agent is already on that host.');
  }
  // Two host rows pointing at one Docker daemon are the move's cardinal
  // hazard: container/volume names derive from the agentId, so the target ref
  // EQUALS the source ref, and "retire the source" (step 4) would purge the
  // volume we just moved onto — total, unrecoverable memory loss. Endpoint-
  // string equality can't catch this (ssh://h vs ssh://h:22, IP vs hostname,
  // a runner aliasing localhost, tcp vs ssh). The daemon's own ID can. Probe
  // both BEFORE touching anything; a daemon we can't reach → refuse, because
  // "can't verify they differ" must never green-light a destructive purge.
  let sourceDaemon: string;
  let targetDaemon: string;
  try {
    [sourceDaemon, targetDaemon] = await Promise.all([source.daemonId(), target.daemonId()]);
  } catch (err) {
    throw new TransferError(
      `Couldn't verify the two hosts are different machines, so the move was cancelled ` +
        `(a Docker daemon didn't answer). (${String(err instanceof Error ? err.message : err).slice(0, 200)})`,
    );
  }
  if (sourceDaemon === targetDaemon) {
    throw new TransferError(
      `${sourceHost.name} and ${targetHost.name} are the same Docker daemon — the agent already ` +
        `runs there. Remove the duplicate host entry instead of moving.`,
    );
  }
  // Removed while the daemons were asked: moved onto it, the agent pointed at
  // a machine Hatchabot no longer knew. A removal still under way sees the
  // operation begun below, in this same tick, and stops (HB-0275).
  if (!store.getHost(targetHostId)) throw new TransferError(`${targetHost.name} was removed meanwhile — the move was cancelled.`);

  const oldRef = agent.runtimeRef;
  const wasRunning = agent.state === 'RUNNING';
  // The memory search key as it stands: the target's build mints keys for
  // the target, and the source's door forgets the agent. A rollback restarts
  // the source container with its OLD key, which must open the source's door
  // again — it got 401 for every recall until the next rebuild (2026-10-09).
  // Hashes only, so it may sit in the operation's params for a restart.
  const keyBefore = store.embedTokenRow(agentId) ?? null;
  const p: MoveParams = {
    from: sourceHost.id, to: targetHost.id, fromName: sourceHost.name, toName: targetHost.name,
    wasRunning, oldRef, keyBefore,
    appliedBefore: {
      profileId: agent.appliedProfileId, model: agent.appliedModel, prevId: agent.appliedProfilePrevId,
      at: agent.appliedProfileAt, embedMode: agent.appliedEmbedMode,
    },
    ...(deps.dropPin && agent.image ? { droppedImage: agent.image } : {}),
  };
  // On disk from here: a restart in the middle is finished or undone on
  // purpose (resumeMoveHost), never left for reconcile to guess at.
  const op = beginOperation(store, 'move-host', agentId, { ...p }, { hostId: targetHost.id, requestedBy: deps.requestedBy });
  deps.onOperation?.(op.id);
  op.step('checked');
  // The pin goes with the move, on its record: undone — by a restart too —
  // it comes back. Dropped by the route before the move began, a reboot's
  // rollback left the agent unpinned on its source, and its next rebuild
  // lost the image's packages (audit #086).
  if (p.droppedImage) {
    store.setAgentImage(agentId, null);
    log('image.unpinned', { reason: 'move-host', was: p.droppedImage, to: targetHost.id });
  }

  // 1. Quiesce. One bot, one poller: the source must stop before the copy on
  //    the target ever starts, and the volume must be still for the snapshot.
  try {
    await stopAndConfirm(source, oldRef);
    if (wasRunning) store.setAgentState(agentId, 'STOPPED');
  } catch (err) {
    rethrowIfCrash(err);
    keepPin(store, agentId, p, log);
    op.fail(err);
    throw err;
  }
  op.step('stopped');

  // 2. Snapshot the volume. A failure here leaves the source fully intact.
  let state: Buffer;
  try {
    state = await source.exportState(oldRef);
  } catch (err) {
    rethrowIfCrash(err);
    // Only claim RUNNING if the container actually came back (export's rule).
    if (wasRunning) {
      try {
        await source.start(oldRef);
        store.setAgentState(agentId, 'RUNNING');
      } catch (e) {
        log('move.source_restart_failed', { agentId, error: String(e) });
      }
    }
    const e = new TransferError(
      `Couldn't read the agent's state — the move was cancelled. (${String(
        err instanceof Error ? err.message : err,
      ).slice(0, 300)})`,
    );
    keepPin(store, agentId, p, log);
    op.rolledBack(e.userMessage);
    throw e;
  }
  op.step('exported');

  // 3. Recreate on the target. hostId is NOT flipped yet — a crash between
  //    the flip and importState would leave the record pointing at a host
  //    with no data, and Retry would seed a fresh empty volume there while
  //    the real memory sits orphaned on the source. So we build the target
  //    spec against a host OVERRIDE (Max/host pairing re-checked there,
  //    host-folder mounts resolve against the target), and flip the store's
  //    hostId only once the snapshot has actually landed. Same double-
  //    provision as import: provision seeds, the snapshot overwrites, the
  //    second provision re-applies this install's config over openclaw.json.
  const progress: { newRef?: string; targetMayRun: boolean } = { targetMayRun: false };
  try {
    const tdeps: ProvisionDeps = { ...deps, provider: target };
    const spec = await buildRuntimeSpec(tdeps, agentId, targetHost);
    ({ runtimeRef: progress.newRef } = await target.provision(spec));
    op.step('target-created', { newRef: progress.newRef });
    await target.importState(progress.newRef!, state);
    op.step('state-copied');
    // Data is on the target now — safe to point the record there.
    store.setAgentHost(agentId, targetHostId);
    op.step('host-flipped');
    await completeOnTarget(tdeps, op, agentId, { ...p, newRef: progress.newRef }, progress);
  } catch (err) {
    rethrowIfCrash(err);
    const r = await putBack(deps, source, target, agentId, { ...p, newRef: progress.newRef }, { targetMayRun: progress.targetMayRun });
    if (r.orphaned) {
      // Do NOT restart the source — leave it stopped and shout, so an operator
      // resolves the orphan instead of a silent flip-flop. Held, not failed: a
      // failed operation is over, and Start was then allowed while the copy
      // on the target may still answer the same bot (A087).
      log('move.rollback_orphan', { agentId, target: targetHostId, ref: progress.newRef });
      const e = new TransferError(
        `Move failed and the copy on ${targetHost.name} couldn't be cleaned up — "${agent.name}" ` +
          `is left STOPPED to avoid two bots polling at once. Remove the copy on ${targetHost.name}, ` +
          `then choose what to do on its page (Alerts) — Start stays refused until then.`,
      );
      op.hold(orphanOutcome(p, `The move to ${targetHost.name} failed`), orphanChoices(p));
      throw e;
    }
    log('move.rolled_back', { agentId, to: targetHostId, error: String(err) });
    const e = new TransferError(
      `Move failed and was rolled back — the agent stays on ${sourceHost.name}. (${String(
        err instanceof Error ? err.message : err,
      ).slice(0, 300)})`,
    );
    op.rolledBack(e.userMessage);
    throw e;
  }

  await retireSource(deps, source, op, agentId, p);
  return store.getAgent(agentId)!;
}

/** What a move records, and what a restart needs to finish or undo it. Never a secret. */
export interface MoveParams {
  from: string;
  to: string;
  fromName: string;
  toName: string;
  wasRunning: boolean;
  oldRef: string;
  /** Container/volume names derive from the agent id: the target's ref equals the source's. */
  newRef?: string;
  keyBefore: ReturnType<Store['embedTokenRow']> | null;
  /**
   * What the record said the source runtime runs (its AI source and model,
   * memory search engine). The target's build records its own; undone, the
   * source runs on as before and the record says so again (audit #081).
   * Absent from a move recorded by an older release.
   */
  appliedBefore?: { profileId?: string; model?: string; prevId?: string; at?: string; embedMode?: 'baked' | 'shared' };
  /** The image pin dropped for this move (dropPin): put back if it is undone (audit #086). */
  droppedImage?: string;
}

/** A move undone keeps the image it was pinned to (audit #086). */
function keepPin(store: Store, agentId: string, p: MoveParams, log: (event: string, detail: Record<string, unknown>) => void): void {
  if (!p.droppedImage || store.getAgent(agentId)?.image) return;
  store.setAgentImage(agentId, p.droppedImage);
  log('image.repinned', { reason: 'move-host undone', image: p.droppedImage });
}

/**
 * From the host flip on: re-apply this machine's config over the copied
 * openclaw.json (the second seed), start it there if it was running, and
 * settle it. Idempotent, so a restart can run it again.
 */
async function completeOnTarget(
  tdeps: ProvisionDeps,
  op: OpHandle,
  agentId: string,
  p: MoveParams,
  progress: { targetMayRun: boolean },
): Promise<void> {
  const { store } = tdeps;
  const target = tdeps.provider;
  const log = tdeps.log ?? (() => {});
  const sleep = tdeps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const newRef = p.newRef ?? p.oldRef;
  const agent = store.getAgent(agentId)!;
  const respec = await buildRuntimeSpec(tdeps, agentId);
  await target.provision(respec);
  store.setAgentRuntimeRef(agentId, newRef);
  recordApplied(store, agentId, respec);
  // A removed repo whose deploy key was still to be scrubbed rode the copied
  // volume: scrubbed there before it can start. Only a start or wake retried
  // it, and the move ran neither, so the moved agent could still use the key
  // (HB-0317). Nothing is recorded yet: a rollback restarts the source, whose
  // volume still holds the key, and its next start must still scrub it.
  if (store.dataSourceRemovals(agentId).length) {
    await scrubRemovedDataSources(tdeps, agentId, newRef, false, log, { settle: false }).catch(() => false);
  }
  op.step('target-configured');
  // Left stopped, it is not started to run its rebuild hook: the hook is
  // owed to this new container's first start instead. It ran only for a
  // running agent, and a stopped one lost the tools it puts back (audit #087).
  if (!p.wasRunning) store.setRebuildHookDue(agentId, new Date().toISOString());
  if (p.wasRunning) {
    progress.targetMayRun = true;
    await target.start(newRef);
    op.step('target-started');
    // Cold image / imported sessions: give it the import path's 2 minutes.
    await waitForHealthy(target, newRef, sleep, 120);
    // $HOME rode the volume, but tools the agent installed OUTSIDE it (apt,
    // /usr/local) come from the image — re-run its on-rebuild hook on the new
    // host to reconstitute them, as rebuild does (audit 2026-09-08).
    await runRebuildHook(tdeps, agentId, newRef, log);
    // Settle skills/gateway before RUNNING so an early message doesn't start a
    // fresh session and archive the moved conversation (audit 2026-09-08).
    await waitForSkillsSettled(target, newRef, agent.slug, sleep, log);
    await reindexMemoryIfSwitched(tdeps, agentId, newRef, log);
    if (store.getAgent(agentId)!.state !== 'RUNNING') store.setAgentState(agentId, 'RUNNING');
  }
  op.step('settled');
  // Settled there: the removal is recorded done only now, by scrubbing the
  // copy again (judged by what is left, so a second pass is a no-op). Never
  // throws: nothing after 'settled' may undo the move. What is left stays
  // recorded for its next start there.
  if (store.dataSourceRemovals(agentId).length) {
    await scrubRemovedDataSources(tdeps, agentId, newRef, p.wasRunning, log).catch(() => false);
  }
}

/**
 * 4. Retire the source runtime, volume included. Best-effort: the agent is
 *    already live on the target, so a failure here is an orphan to clean up,
 *    never a reason to unwind the move. Daemons are distinct (checked before
 *    anything was touched), so this can't touch the moved volume.
 */
async function retireSource(
  deps: { log?: (event: string, detail: Record<string, unknown>) => void },
  source: RuntimeProvider | undefined,
  op: OpHandle,
  agentId: string,
  p: MoveParams,
): Promise<void> {
  const log = deps.log ?? (() => {});
  let left = false;
  try {
    if (!source) throw new Error('the machine it left is not known here any more');
    await source.destroy(p.oldRef, { purge: true });
    op.step('source-removed');
  } catch (err) {
    rethrowIfCrash(err);
    left = true;
    log('move.source_cleanup_failed', { agentId, host: p.from, error: String(err) });
  }
  log('agent.moved', { agentId, from: p.from, to: p.to, toName: p.toName, wasRunning: p.wasRunning });
  op.done(`Moved to ${p.toName}.${left ? ` Its old copy on ${p.fromName} could not be removed yet.` : ''}`);
}

/**
 * Undo a move onto its source host: remove the copy on the target, point the
 * record back, put the memory-search key back, and start the source if it was
 * running. `orphaned`: the target's copy could not be removed and may be
 * running, so the source was NOT started (two pollers on one bot is worse
 * than downtime). `leftover`: a copy that never started may remain on the
 * target. `sourceStartFailed`: it was running and did not come back.
 */
async function putBack(
  deps: { store: Store; embedder?: ProvisionDeps['embedder']; log?: (event: string, detail: Record<string, unknown>) => void },
  source: RuntimeProvider | undefined,
  target: RuntimeProvider | undefined,
  agentId: string,
  p: MoveParams,
  opts: { targetMayRun: boolean },
): Promise<{ orphaned: boolean; leftover: boolean; sourceStartFailed: boolean }> {
  const { store } = deps;
  const log = deps.log ?? (() => {});
  // The target's memory-search decision was never applied: a later model
  // change must not record it as the agent's (night review, 2026-09-27).
  forgetEmbedDecision(agentId);
  // Daemons are confirmed distinct (the daemonId check), so purging the
  // target runtime never touches the source's storage.
  let orphaned = false;
  let leftover = false;
  const ref = p.newRef ?? p.oldRef;
  try {
    if (!target) throw new Error('the other machine is not answering');
    await target.destroy(ref, { purge: true });
  } catch {
    // The destroy failed — and the failure that landed us here (a hung remote
    // daemon) is exactly what makes destroy fail too. If the target container
    // is still up it has --restart unless-stopped and will poll the bot;
    // restarting the source too = two pollers on one token, the one thing
    // worse than downtime. Verify before deciding. A copy that was never
    // started (the move stopped before the start) is only a leftover.
    if (opts.targetMayRun) {
      // Down means stopped or gone: a container restarting in a loop
      // ('starting') or paused ('error') may poll the bot again (A087).
      const alive = target ? !(await targetDown(target, ref)) : true;
      if (alive) orphaned = true;
      else leftover = true;
    } else {
      leftover = true;
    }
  }
  const now = store.getAgent(agentId);
  if (now && now.hostId !== p.from) {
    store.setAgentHost(agentId, p.from);
    store.setAgentRuntimeRef(agentId, p.oldRef);
  }
  // The source's runtime is the one that runs: its record, as it was before.
  if (p.appliedBefore) store.restoreAgentApplied(agentId, p.appliedBefore);
  keepPin(store, agentId, p, log);
  const before = p.keyBefore ?? undefined;
  if (deps.embedder && JSON.stringify(store.embedTokenRow(agentId) ?? null) !== JSON.stringify(before ?? null)) {
    store.restoreEmbedToken(agentId, before);
    await deps.embedder.syncKeys?.([p.from, p.to])
      .catch((e) => log('move.embed_keys_failed', { agentId, error: String(e).slice(0, 200) }));
  }
  if (orphaned) return { orphaned, leftover, sourceStartFailed: false };
  let sourceStartFailed = false;
  if (p.wasRunning) {
    // Only claim RUNNING if the container actually came back (export's rule).
    try {
      if (!source) throw new Error('the machine it was on is not known here any more');
      await source.start(p.oldRef);
      const s = store.getAgent(agentId);
      if (s && s.state !== 'RUNNING') store.setAgentState(agentId, 'RUNNING');
    } catch (err) {
      sourceStartFailed = true;
      log('move.source_restart_failed', { agentId, error: String(err) });
    }
  }
  return { orphaned, leftover, sourceStartFailed };
}

/** What a restart's recovery needs: the store, a provider per host, and the move's own deps. */
export interface MoveResumeDeps extends Omit<ProvisionDeps, 'provider'> {
  providerForHost: (hostId: string) => RuntimeProvider | undefined;
  /** Does this machine answer? Default: its daemon id within 20 s. */
  answers?: (p: RuntimeProvider) => Promise<boolean>;
}

export const machineAnswers = async (p: RuntimeProvider): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p.daemonId().then(() => true, () => false),
      new Promise<boolean>((r) => { timer = setTimeout(() => r(false), 20_000); timer.unref?.(); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** Is the copy at `ref` confirmed stopped or gone? A machine that does not answer is not. */
async function targetDown(target: RuntimeProvider, ref: string): Promise<boolean> {
  const s = await target.status(ref).catch((err: unknown) => { rethrowIfCrash(err); return { phase: 'unknown' as const }; });
  return s.phase === 'stopped' || s.phase === 'absent';
}

/**
 * A move undone while its copy on the target could not be removed and may be
 * running: held, so Start and Wake stay refused (a failed operation is over,
 * and they were allowed), with the two ways out — Hatchabot removes it, or
 * the owner did (A087).
 */
const orphanChoices = (p: MoveParams) => ({
  actions: [
    { action: 'remove-copy', label: `Remove the copy on ${p.toName}${p.wasRunning ? `, then start it on ${p.fromName}` : ''}` },
    { action: 'copy-removed', label: `I removed the copy on ${p.toName}${p.wasRunning ? ` — start it on ${p.fromName}` : ''}` },
  ],
  recommended: 'remove-copy',
});

const orphanOutcome = (p: MoveParams, start: string) =>
  `${start}, and its copy on ${p.toName} could not be removed — it is left stopped on ${p.fromName} so two copies never answer at once. ` +
  `Remove that copy, or let Hatchabot try to.`;

const moveHoldChoices = (p: MoveParams) => ({
  actions: [
    { action: 'retry', label: `Try again when ${p.toName} is back` },
    { action: 'put-back', label: `Put it back on ${p.fromName}` },
  ],
  recommended: 'retry',
});

/**
 * A move a restart cut off (the design's table, move-host rows):
 *  - before the host flip: undo — remove the target's leftovers if it
 *    answers, put the memory-search key back, start the source if it ran;
 *  - after the flip: finish — the second seed and the start on the target,
 *    its rebuild hook, skills and re-index, then remove the source's volume;
 *  - the machine it must use does not answer: hold, with
 *    [Try again when it's back] [Put it back here].
 */
export async function resumeMoveHost(deps: MoveResumeDeps, opId: string): Promise<void> {
  const { store } = deps;
  const op = handleFor(store, opId);
  const row = op.get();
  const p = row.params as unknown as MoveParams;
  const agent = row.agentId ? store.getAgent(row.agentId) : undefined;
  if (!agent || agent.state === 'DELETED') { op.fail('The agent is gone.'); return; }
  const agentId = agent.id;
  const log = deps.log ?? (() => {});
  const answers = deps.answers ?? machineAnswers;
  const source = deps.providerForHost(p.from);
  const target = deps.providerForHost(p.to);
  // Nothing was touched before the check: there is nothing to put right.
  if (!row.step) { op.fail('The move was interrupted before it changed anything.'); return; }

  if (agent.hostId !== p.to) {
    // Before the flip: nothing on the target is in use yet. Undo.
    const targetUp = !!target && await answers(target);
    const r = await putBack(deps, source, targetUp ? target : undefined, agentId, p, { targetMayRun: false });
    if (r.sourceStartFailed) {
      op.hold(
        `The move to ${p.toName} was interrupted by a restart and undone, but ${p.fromName} did not start it again.`,
        { actions: [{ action: 'retry', label: 'Try again' }], recommended: 'retry' },
      );
      return;
    }
    if (r.leftover) log('move.leftover', { agentId, host: p.to });
    op.rolledBack(
      `The move to ${p.toName} was interrupted by a restart and undone — it stays on ${p.fromName}` +
        `${p.wasRunning ? ' and is running again' : ''}.` +
        (r.leftover ? ` A copy that never started may be left on ${p.toName}; it is replaced the next time it moves there.` : ''),
    );
    return;
  }

  // After the flip: the record already says target, and the source's volume
  // is the stale copy. Finish — but only with a target that answers, unless
  // all that is left is the old copy, which needs only the machine it left.
  const settledThere = stepReached(row.kind, row.step, 'settled') && (!p.wasRunning || agent.state === 'RUNNING');
  if (!settledThere && (!target || !(await answers(target)))) {
    op.hold(`The move to ${p.toName} was interrupted, and ${p.toName} isn't answering.`, moveHoldChoices(p));
    return;
  }
  const progress = { targetMayRun: p.wasRunning && stepReached(row.kind, row.step, 'target-configured') };
  if (!settledThere && target) {
    try {
      await completeOnTarget({ ...deps, provider: target }, op, agentId, p, progress);
    } catch (err) {
      rethrowIfCrash(err);
      // As a move in one go: a target that will not come up is rolled back.
      const r = await putBack(deps, source, target, agentId, p, progress);
      if (r.orphaned) {
        op.hold(orphanOutcome(p, `The move to ${p.toName} could not be finished after a restart`), orphanChoices(p));
        return;
      }
      log('move.rolled_back', { agentId, to: p.to, error: String(err) });
      op.rolledBack(`The move to ${p.toName} could not be finished after a restart and was undone — it stays on ${p.fromName}. (${String(err instanceof Error ? err.message : err).slice(0, 200)})`);
      return;
    }
  }
  await retireSource(deps, source, op, agentId, p);
}

/** The owner's choice on a held move: try again, or put it back on the source. */
export async function recoverMoveHost(deps: MoveResumeDeps, opId: string, action: string): Promise<void> {
  const { store } = deps;
  const op = handleFor(store, opId);
  const row = op.get();
  const p = row.params as unknown as MoveParams;
  if (action === 'retry') return resumeMoveHost(deps, opId);
  if (action === 'remove-copy' || action === 'copy-removed') return settleOrphan(deps, op, p, action);
  if (action !== 'put-back') throw new TransferError(`"${action}" is not one of this operation's choices.`);
  const agentId = row.agentId!;
  const target = deps.providerForHost(p.to);
  const answers = deps.answers ?? machineAnswers;
  const targetUp = !!target && await answers(target);
  const targetMayRun = p.wasRunning && stepReached(row.kind, row.step, 'target-configured');
  if (!targetUp && targetMayRun) {
    throw new TransferError(
      `Its copy on ${p.toName} may already be running, so it can't be put back until ${p.toName} answers ` +
        `(starting both would make two copies answer the same bot). Try again when ${p.toName} is back.`,
    );
  }
  const r = await putBack(deps, deps.providerForHost(p.from), targetUp ? target : undefined, agentId, p, { targetMayRun });
  if (r.orphaned) {
    op.hold(orphanOutcome(p, `Putting it back on ${p.fromName} was asked for`), orphanChoices(p));
    return;
  }
  endPutBack(deps, op, agentId, p, r);
}

function endPutBack(
  deps: MoveResumeDeps, op: OpHandle, agentId: string, p: MoveParams,
  r: { leftover: boolean; sourceStartFailed: boolean },
): void {
  if (r.sourceStartFailed) {
    // The record is back on the source now: a retry undoes, it does not finish.
    op.hold(`Put back on ${p.fromName}, but it did not start there.`, { actions: [{ action: 'retry', label: 'Try again' }], recommended: 'retry' });
    return;
  }
  if (r.leftover) deps.log?.('move.leftover', { agentId, host: p.to });
  op.rolledBack(
    `Put back on ${p.fromName}${p.wasRunning ? ' and running' : ''}.` +
      (r.leftover ? ` A copy that never started may be left on ${p.toName}; it is replaced the next time it moves there.` : ''),
  );
}

/**
 * The owner's choice on a move held with its copy on the target maybe still
 * running (A087). `remove-copy`: Hatchabot removes it, and only a copy then
 * confirmed stopped or gone lets the source start. `copy-removed`: the owner
 * removed it; checked when that machine answers (a copy still up there is
 * refused), taken at their word when it does not — the same word a move to
 * another Hatchabot takes ("it is not there"), so a machine gone for good
 * does not keep the agent stopped forever.
 */
async function settleOrphan(deps: MoveResumeDeps, op: OpHandle, p: MoveParams, action: 'remove-copy' | 'copy-removed'): Promise<void> {
  const agentId = op.get().agentId!;
  const target = deps.providerForHost(p.to);
  const answers = deps.answers ?? machineAnswers;
  const targetUp = !!target && await answers(target);
  const ref = p.newRef ?? p.oldRef;
  if (action === 'copy-removed' && targetUp && !(await targetDown(target!, ref))) {
    throw new TransferError(
      `Its copy on ${p.toName} is still there and may be running, so it stays stopped on ${p.fromName}. ` +
        `Remove it on ${p.toName} (or choose "Remove the copy on ${p.toName}"), then try again.`,
    );
  }
  if (action === 'remove-copy' && !targetUp) {
    throw new TransferError(
      `${p.toName} isn't answering, so its copy there can't be removed yet. Try again when it is back — ` +
        `or, if you removed that copy yourself, choose "I removed the copy on ${p.toName}".`,
    );
  }
  // The owner's word (copy-removed, machine away) stands in for the check: nothing there may run.
  const r = await putBack(deps, deps.providerForHost(p.from), targetUp ? target : undefined, agentId, p, {
    targetMayRun: action === 'remove-copy' || targetUp,
  });
  if (r.orphaned) {
    throw new TransferError(
      `Its copy on ${p.toName} could not be removed or confirmed stopped, so it stays stopped on ${p.fromName}. ` +
        `Remove it on ${p.toName}, then choose "I removed the copy on ${p.toName}".`,
    );
  }
  endPutBack(deps, op, agentId, p, r);
}
