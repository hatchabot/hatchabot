import type { ChannelProvisioner } from '../../channels/channel.js';
import type { Agent } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import type { Store } from '../../store/store.js';
import { semaphore } from '../../util/queues.js';
import { AgentBusyError, isBusy } from './busy.js';
import { claimFirstContact } from '../members/claim.js';
import { beginOperation, currentBootId, handleFor, KIND_LABEL, type OpHandle } from './operations.js';
import { rebuildAgent, renderRefusalOf, runProvisionSteps, type ProvisionDeps } from './provision.js';
import { contextStats } from '../memory/transcript.js';

/**
 * The setup and rebuild queue (HB-0808 step 11): one setup or rebuild in
 * flight per agent (`inflight`), the rebuilds waiting for a slot (two gates:
 * rebuilds at once, and those that checkpoint first), and a change kept for
 * an agent's next start. Part of the agent lifecycle service
 * (agentLifecycle.ts), built once per process.
 *
 * Every feature reads this one queue: the route context hands its functions
 * on (`kickProvision`, `provisionWhenFree`, `kickRebuild`, `oweRebuild`,
 * `rebuildOrOwe`), and the other services are told of it as functions
 * (`inFlight`, `isInFlight`). Nothing here knows HTTP: a refusal is a false or
 * a word, and the routes say the rest.
 *
 * A restart loses nothing of it (docs/architecture.md, "In-memory state,
 * sorted"): a setup or a rebuild is an operation on disk, a queued rebuild is
 * `queued` there and put back in the queue at the start (`resumeOperations`,
 * through `kickRebuild`'s `resume`), and a change for the next start is on the
 * agent's record (`rebuildOnStart`).
 */
export interface RebuildQueue {
  /** Start setup in the background, unless one or a rebuild is in flight for the agent. */
  kickProvision(agentId: string, opts?: { webOnlyIfNoBot?: boolean; queuedSince?: number }): void;
  /** Setup for an answered bot-token step: now, or once what holds the agent lets go. */
  provisionWhenFree(agentId: string, since?: number): void;
  /**
   * Queue a rebuild in the background. False, and nothing queued, when a
   * setup or rebuild is in flight for the agent, a long operation on it is
   * not over, this copy moved away, or it has no runtime. `recoverOn`: a
   * source switch chains a recovery after it, for that source; kept on the
   * operation, so a rebuild a restart puts back in the queue is followed by
   * it too (routes.ts requeueRebuild, HB-0832).
   */
  kickRebuild(agentId: string, opts?: { checkpoint?: boolean; recoverOn?: string; resume?: { opId: string; was: Agent } }): boolean;
  /** A rebuild after a bot handover: now, or after the one in flight. */
  rebuildAfterHandover(agentId: string): boolean;
  /** Keep a change for the agent's next start or wake, which is then a rebuild. Returns the stamp. */
  oweRebuild(agentId: string, log?: (event: string, detail: Record<string, unknown>) => void): string;
  /** A running agent is rebuilt now, a stopped one owes it at its next start. `was`: the agent before the change. */
  rebuildOrOwe(was: Agent, opts?: { handover?: boolean }): 'rebuilding' | 'next-start' | 'not-started';
  /** The setup or rebuild in flight for the agent (it settles when that ends), or undefined. */
  inFlight(agentId: string): Promise<void> | undefined;
  /** Is a setup or rebuild in flight for the agent, waiting its turn included? */
  isInFlight(agentId: string): boolean;
  /** Is its rebuild waiting for a slot (the page's "waiting its turn")? */
  isQueued(agentId: string): boolean;
  /** A Delete or an Archive calls off its rebuild still waiting for a slot: it skips itself at its turn. */
  callOff(agentId: string): void;
  /** How many rebuilds run at once now. */
  atOnce(): number;
  /** How many wait for a slot, and how many setups and rebuilds are in flight. */
  counts(): { queued: number; running: number };
  /** Rebuilds at once from now: queued ones follow the new number at once. */
  setAtOnce(n: number): void;
  /** End the waits of a setup behind another holder (it is then not started). */
  stop(): void;
}

/** What the queue needs from the process it runs in. Functions only, so a test hands it fakes. */
export interface RebuildQueueDeps {
  store: Store;
  secrets: SecretStore;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** Telegram's provisioner (a setup leases a bot). */
  channel: ChannelProvisioner;
  /** The memory search service for a build, read at each build. */
  embedder: () => ProvisionDeps['embedder'];
  /** A new agent "from a repo": its app goes in once its setup has it running. */
  runPendingApp: (agentId: string) => Promise<void>;
  /** The chat ids a Telegram bot has already seen, so the owner's claim waits for a new one. */
  priorChatIdsOf: (username: string) => string[];
  /** A delete of the agent is under way (it marks itself before it waits for a setup). */
  deleting: (agentId: string) => boolean;
  /** A rebuilt agent's browser follows it to its new network. */
  browsersNow: (agentId: string) => Promise<unknown>;
  /** A line to the server's log for a background task that failed. */
  logError: (detail: Record<string, unknown>, msg: string) => void;
}

/** Rebuilds at once: 1–12; the default 6 fits an ordinary machine. */
export const MAX_REBUILD_CONCURRENCY = 12;
export function clampConcurrency(raw: string | undefined): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_REBUILD_CONCURRENCY, n) : 6;
}

export function createRebuildQueue(deps: RebuildQueueDeps): RebuildQueue {
  const { store, secrets, providerFor, trace, runPendingApp, priorChatIdsOf, deleting, browsersNow, logError } = deps;
  /** The waits of a setup behind another holder (provisionWhenFree), which `stop()` ends. */
  const setupWaits = new Set<ReturnType<typeof setTimeout>>();
  const waitAWhile = (ms: number) => new Promise<void>((r) => {
    const t = setTimeout(() => { setupWaits.delete(t); r(); }, ms);
    t.unref();
    setupWaits.add(t);
  });

  // ---- background provisioning ------------------------------------------
  // POST /v1/agents returns in milliseconds; the slow steps (docker, health
  // check) run here. One in-flight run per agent; the app polls GET /v1/agents.
  const inflight = new Map<string, Promise<void>>();
  /** `webOnlyIfNoBot`: a dry pool means web-only, not a parked token prompt (ProvisionDeps); kept on the agent for a Retry. */
  /** How long setup for an answered step waits for another holder of the agent to let go. */
  const SETUP_WAITS_FOR_BUSY_MS = 30 * 60_000;
  /** `queuedSince`: when setup for an answered step was first asked for (provisionWhenFree). */
  const kickProvision = (agentId: string, opts: { webOnlyIfNoBot?: boolean; queuedSince?: number } = {}): void => {
    if (inflight.has(agentId)) return;
    // On the record, not only for this run: a Retry after a failed setup makes
    // the same promise the first attempt did (HB-0415).
    if (opts.webOnlyIfNoBot) store.setAgentWebOnlyIfNoBot(agentId, true);
    const task = (async () => {
      const agent = store.getAgent(agentId);
      if (!agent) return;
      const provider = providerFor(agent.hostId);
      const log = trace(agentId);
      // On disk (operations.ts): a restart in the middle is settled by
      // reconcile's rules on purpose, with the outcome on this record.
      const op = beginOperation(store, 'provision', agentId, { from: agent.state, hostId: agent.hostId });
      let result: Awaited<ReturnType<typeof runProvisionSteps>>;
      try {
        result = await runProvisionSteps(
          { store, secrets, provider, channel: deps.channel, log, embedder: deps.embedder(), webOnlyIfNoBot: store.getAgent(agentId)?.webOnlyIfNoBot },
          agentId,
        );
      } catch (err) {
        op.fail(err);
        // An answered bot-token step whose setup could not start. Another
        // holder took the agent between the look and the start: queued again
        // behind it. Anything else is the agent's own: failed with the
        // reason, for a Retry, which takes the held token.
        if (store.getAgent(agentId)?.pendingAction?.received) {
          if (err instanceof AgentBusyError) provisionWhenFree(agentId, opts.queuedSince ?? Date.now());
          else {
            store.setAgentPendingAction(agentId, null);
            store.setAgentState(agentId, 'FAILED', `Setup could not start: ${err instanceof Error ? err.message : String(err)} Tap Retry.`);
          }
        }
        throw err;
      }
      const s = result.agent.state;
      if (s === 'RUNNING') store.setAgentWebOnlyIfNoBot(agentId, false);
      if (s === 'FAILED') op.fail(result.agent.stateReason ?? 'Setup failed.');
      else op.done(s === 'RUNNING' ? 'Set up and running.'
        : result.agent.pendingAction?.received ? 'A bot token came in as it ended: setup runs again with it.'
        : result.agent.pendingAction ? 'Waiting for a step from you.' : `Setup ended ${s.toLowerCase()}.`);
      // Fresh agent went live in pairing mode → watch for the owner's first
      // message and bind it (the §12.4 claim). DETACHED: the claim window is
      // 10 minutes of idle polling on an agent that is already live — holding
      // `inflight` for it made Delete hang and Rebuild answer 409 that whole
      // time. The watcher notices for itself when the agent goes away.
      // Skipped entirely when the owner's Telegram identity was carried over
      // from an earlier agent (createAgentRecord): they're in allowFrom
      // already, so there is no pairing request to watch for.
      // A new agent "from a repo": its app goes in now that it runs.
      if (result.agent.state === 'RUNNING') void runPendingApp(agentId);
      const channelRow = store.getChannelForAgent(agentId);
      const ownerBound = store
        .listMemberships(agentId)
        .some((m) => m.userId === result.agent.ownerId && m.channelUserId);
      if (result.agent.state === 'RUNNING' && result.agent.runtimeRef && channelRow && !ownerBound) {
        void claimFirstContact(
          { store, provider, providerFor, log },
          {
            agentId,
            runtimeRef: result.agent.runtimeRef,
            accountId: channelRow.accountId,
            forUserId: result.agent.ownerId,
            // The same half hour an invitee gets. Ten minutes is a short leash
            // for "make the agent, then go and find it in Telegram".
            timeoutMs: 30 * 60_000,
            excludeIds: priorChatIdsOf(channelRow.accountId),
          },
        ).catch((err) => logError({ err, agentId }, 'owner claim failed'));
      }
    })();
    inflight.set(
      agentId,
      task
        .catch((err) => logError({ err, agentId }, 'provision task failed'))
        .finally(() => inflight.delete(agentId)),
    );
  };
  /**
   * Setup for an answered bot-token step (a pasted token, or "go on without
   * one"): now, or once the setup or rebuild under way ends. Dropped while one
   * ran, the answer waited for nothing, and reconcile failed the agent. The
   * step stays answered (`received`) until setup takes the answer up.
   */
  const provisionWhenFree = (agentId: string, since = Date.now()): void => {
    // A delete under way (it marks itself before it waits for a setup), the
    // agent gone, or the answer taken up already: nothing is started.
    const a = store.getAgent(agentId);
    if (deleting(agentId) || (a?.state !== 'PROVISIONING' && a?.state !== 'FAILED') || !a.pendingAction?.received) return;
    const after = (p: Promise<unknown>) => void p
      .then(() => provisionWhenFree(agentId, since))
      .catch((err) => logError({ err, agentId }, 'queued setup failed'));
    const running = inflight.get(agentId);
    if (running) { after(running); return; }
    // Another holder has the agent (an import, a move, a change): asked again
    // when it lets go, for up to SETUP_WAITS_FOR_BUSY_MS, rather than failed.
    if (isBusy(agentId)) {
      if (Date.now() - since < SETUP_WAITS_FOR_BUSY_MS) { after(waitAWhile(2_000)); return; }
      store.setAgentPendingAction(agentId, null); // a held token stays held, for the Retry
      store.setAgentState(agentId, 'FAILED', 'Setup could not start: the agent was busy with another change for 30 minutes. Tap Retry.');
      return;
    }
    kickProvision(agentId, { queuedSince: since });
  };

  /**
   * Start a rebuild in the background (the snapshot runs as its first step, so
   * this returns at once). Returns false if the agent is already changing or
   * has no runtime — callers turn that into a 409 or just skip it in a batch.
   */
  // Rebuilds run at most N at a time. A bulk move kicked 15 at once, each
  // starting with a checkpoint turn on the SAME source — a self-inflicted rate
  // limit (13/15 failed) plus 15 container recreations thrashing the box. The
  // inflight entry is set immediately (busy checks / double-kick refusal hold);
  // the work itself waits for a slot.
  // Two limits, because the two costs are different. A plain rebuild is docker
  // work — a fleet-wide one is a queue, and on this hardware each takes about a
  // minute, so the cap decides how long "Rebuild all" takes. A rebuild that
  // CHECKPOINTS first makes an AI call on the agent's source, and running many
  // at once rate-limits that source (13 of 15 failed once) — so those stay few.
  const REBUILD_CONCURRENCY = clampConcurrency(process.env.HATCHABOT_REBUILD_CONCURRENCY);
  const CHECKPOINT_CONCURRENCY = Math.max(1, Math.min(
    REBUILD_CONCURRENCY,
    Math.floor(Number(process.env.HATCHABOT_CHECKPOINT_CONCURRENCY) || 2),
  ));
  // Resizable: the owner sets "rebuild at once" in Settings while rebuilds
  // may be queued (the owner, 2026-09-24 — six agents moving to 2026.9 at once
  // all re-indexed memory through one engine). Raising it wakes waiters;
  // lowering it lets the running ones finish and admits fewer after.
  const rebuildGate = semaphore(REBUILD_CONCURRENCY);
  const checkpointGate = semaphore(CHECKPOINT_CONCURRENCY);
  /** Queued, not yet started: the app says "waiting its turn" rather than spinning silently. */
  const rebuildQueued = new Set<string>();
  /** Queued rebuilds Delete or Archive called off: they skip themselves at their turn instead of rebuilding an agent about to go. */
  const rebuildCancelled = new Set<string>();
  /**
   * Why a queued rebuild must not run after all, judged at its turn: the
   * agent may have moved (another host, or another Hatchabot), been deleted,
   * or been stopped or put to sleep while it waited. Rebuilding then started
   * a second copy on the old daemon polling the same bot, or undid the Stop
   * (night review, 2026-09-27). A long operation begun while it waited (a
   * move held for its owner) keeps the copy stopped: judged again at the
   * turn, not only when it was queued (audit, 2026-10-20).
   */
  const stoppedWhileQueued = (was: Agent, now: Agent | undefined): boolean => was.state === 'RUNNING' && now?.state === 'STOPPED' && !now.migratedTo && now.hostId === was.hostId;
  const staleRebuild = (was: Agent, now: Agent | undefined, opId: string): string | undefined => {
    if (rebuildCancelled.has(was.id)) return 'called off by delete or archive';
    if (!now || now.state === 'DELETED' || now.state === 'ARCHIVED') return 'deleted or archived';
    { const onDisk = store.activeOperationFor(was.id); if (onDisk && onDisk.id !== opId) return `${KIND_LABEL[onDisk.kind] ?? onDisk.kind} is not over`; }
    if (now.migratedTo && !was.migratedTo) return 'moved to another Hatchabot';
    if (now.hostId !== was.hostId || now.runtimeRef !== was.runtimeRef) return 'moved to another machine';
    if (was.state === 'RUNNING' && now.state === 'STOPPED') return now.hibernatedAt ? 'put to sleep' : 'stopped by its owner';
    return undefined;
  };
  /**
   * `resume`: a rebuild queued before a restart, put back in the queue at
   * boot (resumeOperations); `was` is the agent as it was when it was asked
   * for, so staleRebuild judges it as before.
   */
  const kickRebuild = (agentId: string, opts: { checkpoint?: boolean; recoverOn?: string; resume?: { opId: string; was: Agent } } = {}): boolean => {
    if (inflight.has(agentId)) return false;
    const now0 = store.getAgent(agentId);
    const agent = opts.resume ? { ...now0!, ...opts.resume.was } as Agent : now0;
    if (!now0 || !agent?.runtimeRef) return false;
    // A copy that moved to another Hatchabot is never rebuilt here: started,
    // it polls the same bot as the copy there (bulk source switches and the
    // channel routes reached it; night review, 2026-09-28).
    if (now0.migratedTo) return false;
    // Nor one with a long operation not over (a move or import interrupted by
    // a restart, or held for its owner): the rebuild would start it.
    { const onDisk = store.activeOperationFor(agentId); if (onDisk && onDisk.id !== opts.resume?.opId) return false; }
    const startedAt = Date.now();
    // Queued on disk (operations.ts): a restart keeps its place — re-queued
    // at boot, judged by staleRebuild then as now. Its own steps are never
    // refused by it: a rebuild in this process is guarded in memory, as before.
    let op: OpHandle;
    if (opts.resume) {
      op = handleFor(store, opts.resume.opId);
      store.updateOperation(op.id, { status: 'queued', bootId: currentBootId() });
    } else {
      op = beginOperation(store, 'rebuild', agentId, {
        checkpoint: !!opts.checkpoint,
        was: { state: agent.state, hostId: agent.hostId, runtimeRef: agent.runtimeRef, migratedTo: agent.migratedTo ?? null },
        ...(opts.recoverOn ? { recoverOn: opts.recoverOn } : {}),
      }, { queued: true });
    }
    const task = (async () => {
      rebuildQueued.add(agentId);
      // The checkpoint slot first, then the rebuild slot, and the checkpoint
      // slot goes back as soon as the checkpoint turn ends: holding both for
      // the whole rebuild left rebuild slots idle behind two checkpoints
      // (night review, 2026-09-27).
      let checkpointHeld = false;
      if (opts.checkpoint) { await checkpointGate.acquire(); checkpointHeld = true; }
      const releaseCheckpoint = () => { if (checkpointHeld) { checkpointHeld = false; checkpointGate.release(); } };
      await rebuildGate.acquire();
      rebuildQueued.delete(agentId);
      try {
        const now = store.getAgent(agentId);
        const stale = staleRebuild(agent, now, op.id);
        if (stale) {
          trace(agentId)('rebuild.skipped', { why: stale });
          // Stopped or put to sleep while it waited: what it was to carry is
          // not lost, its next start does it (HB-0411).
          if (stoppedWhileQueued(agent, now)) oweRebuild(agentId);
          op.rolledBack(`Not rebuilt: ${stale}.`);
          return;
        }
        op.start();
        let rebuilt: Agent;
        try {
          rebuilt = await rebuildAgent(
            {
              store, secrets, provider: providerFor(now!.hostId), channel: deps.channel,
              log: trace(agentId), checkpointMemory: opts.checkpoint, afterCheckpoint: releaseCheckpoint, embedder: deps.embedder(),
            },
            agentId,
          );
        } catch (err) {
          op.fail(err);
          throw err;
        }
        const refused = rebuilt.state === 'RUNNING' || rebuilt.state === 'STOPPED' ? renderRefusalOf(agentId) : undefined;
        if (rebuilt.state === 'FAILED') op.fail(rebuilt.stateReason ?? 'The rebuild failed.');
        else if (refused) op.fail(`Not rebuilt: ${refused} ${rebuilt.state === 'RUNNING' ? 'It keeps running' : 'It stays stopped'} as it was.`);
        else op.done('Rebuilt.');
      } finally {
        releaseCheckpoint();
        rebuildGate.release();
      }
    })();
    inflight.set(
      agentId,
      task
        .then(() => checkContextAfterRebuild(agentId, startedAt))
        // A rebuilt agent has a new network namespace: its browser follows it.
        .then(() => { if (store.getAgent(agentId)?.browser) void browsersNow(agentId); })
        .catch((err) => logError({ err, agentId }, 'rebuild task failed'))
        .finally(() => {
          inflight.delete(agentId); rebuildQueued.delete(agentId); rebuildCancelled.delete(agentId);
          // However it ended (a throw before its turn), the record is not left queued.
          const row = store.getOperation(op.id);
          if (row && (row.status === 'queued' || row.status === 'running') && row.bootId === currentBootId()) op.fail('The rebuild did not run.');
        }),
    );
    return true;
  };

  /**
   * After a bot handover (a swap, a detach): the container still holds the
   * old bot until a rebuild writes the new row into it. When a rebuild or a
   * setup is already in flight, kickRebuild says no — and a queued rebuild
   * kicked while the agent ran skips itself once it finds it stopped, so the
   * agent sat stopped on the new row. Another follows the one in flight
   * instead (concurrency review, 2026-10-09). Start refuses meanwhile
   * (startRefusal): the old container is not booted on a bot it gave back.
   */
  const rebuildAfterHandover = (agentId: string): boolean => {
    if (kickRebuild(agentId)) return true;
    const running = inflight.get(agentId);
    if (!running) return false;
    void running.then(() => { kickRebuild(agentId); }).catch(() => {});
    return true;
  };

  /** Keep a change for the next start or wake, which is a rebuild. A later
   * obligation gets a distinct stamp even in the same millisecond, so a
   * completed live apply can clear only the obligation it created. */
  const oweRebuild = (agentId: string, log = trace(agentId)): string => {
    const before = Date.parse(store.getAgent(agentId)?.rebuildOnStart ?? '') || 0;
    const at = new Date(Math.max(Date.now(), before + 1)).toISOString();
    store.setRebuildOnStart(agentId, at);
    log('rebuild.owed', {});
    return at;
  };
  /**
   * A change only a new container picks up (a source, a browser, a bot, where
   * it answers). A rebuild ends RUNNING, so a stopped or sleeping agent does
   * not get one now: it would come up behind its owner's back, answer on its
   * chat apps and spend on its source (HB-0411, HB-0420). It stays down and
   * its next start is the rebuild. `was`: the agent as it was before the
   * change, read fresh, since a bot handover stops a running one itself; the
   * rule is about what its owner left it as. Only a Rebuild asked for by name
   * starts a stopped agent.
   */
  const rebuildOrOwe = (was: Agent, opts: { handover?: boolean } = {}): 'rebuilding' | 'next-start' | 'not-started' => {
    if (!was.runtimeRef) return 'not-started';
    // The routes refuse under an operation (operationRefuses). One that began
    // since they asked: stopped by it is not stopped by its owner, so no next
    // start is promised, and kickRebuild would refuse too.
    if (store.activeOperationFor(was.id)) return 'not-started';
    if (was.state === 'STOPPED') { oweRebuild(was.id); return 'next-start'; }
    return (opts.handover ? rebuildAfterHandover(was.id) : kickRebuild(was.id)) ? 'rebuilding' : 'not-started';
  };

  /**
   * Did this rebuild cost the agent its conversation?
   *
   * OpenClaw ends a conversation by renaming its file to `*.jsonl.reset.<ts>`,
   * so the answer is in the session files — no bookkeeping, no guesswork. When
   * a reset lands after the rebuild started, record it: the app then says so
   * and offers Recover context, instead of the owner meeting an agent that has
   * forgotten them mid-chat. Asked for 2026-09-20, after exactly that.
   */
  const checkContextAfterRebuild = async (agentId: string, startedAt: number): Promise<void> => {
    const agent = store.getAgent(agentId);
    if (!agent?.runtimeRef || agent.state !== 'RUNNING') return;
    let stats;
    try { stats = await contextStats(providerFor(agent.hostId), agent); }
    catch { return; } // a container that will not answer is not evidence
    const at = stats.lastReset ? Date.parse(stats.lastReset) : 0;
    if (!at || at < startedAt - 60_000 || !stats.lostMessages) return;
    store.setContextReset(agentId, { resetAt: stats.lastReset!, lostMessages: stats.lostMessages });
    trace(agentId)('context.reset_after_rebuild', { resetAt: stats.lastReset, lost: stats.lostMessages });
  };

  return {
    kickProvision, provisionWhenFree, kickRebuild, rebuildAfterHandover, oweRebuild, rebuildOrOwe,
    inFlight: (agentId) => inflight.get(agentId),
    isInFlight: (agentId) => inflight.has(agentId),
    isQueued: (agentId) => rebuildQueued.has(agentId),
    callOff: (agentId) => { if (rebuildQueued.has(agentId)) rebuildCancelled.add(agentId); },
    atOnce: () => rebuildGate.limit,
    counts: () => ({ queued: rebuildQueued.size, running: inflight.size }),
    setAtOnce: (n) => { rebuildGate.setLimit(n); },
    stop: () => { for (const t of setupWaits) clearTimeout(t); setupWaits.clear(); },
  };
}
