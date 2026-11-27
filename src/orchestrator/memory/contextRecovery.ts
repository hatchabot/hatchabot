import type { Agent } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { isBusy } from '../lifecycle/busy.js';
import { refused, said, type Answer } from '../consult/answers.js';
import type { AgentTurns } from '../consult/consults.js';
import { contextStats, exportTranscript, recoverContext, recoveryRunning, type RecoveryProcess, type TranscriptResult } from './transcript.js';

/** A recovery begun (its staged file's counts), or nothing to recover and why. */
export type RecoveryAnswer =
  | { started: true; conversations: number; messages: number; file?: string }
  | { started: false; reason: string };

/**
 * An agent's earlier conversations (HB-0808 step 13): the chat history read
 * from its own transcript store, and Recover context, which stages the
 * conversations a reset made it lose in its workspace and has it save the
 * durable parts to memory in the background (it confirms in its own chat).
 *
 * It owns `recovering` (one background recovery turn per agent: a click, or
 * one chained after a source switch's rebuild by the AI sources service,
 * `afterRebuild`; each slot held by its own attempt) and its timers
 * (`recoveryExpiries`), which `stop()` ends: a look at the turn's process
 * every half minute, which frees the slot once it has ended, and fifteen
 * minutes as the ceiling (all a turn whose process is not known has).
 */
export interface ContextRecovery {
  /** The whole chat history as markdown (an agent with a runtime the route found). */
  transcript(agent: Agent): Promise<Answer<{ t: TranscriptResult; file: string }>>;
  /** Recover context (a running agent the route checked, not busy). */
  recover(agent: Agent, includeLive: boolean): Promise<Answer<RecoveryAnswer>>;
  /**
   * Chained onto the rebuild just kicked for a switched agent, so recovery
   * runs on the NEW source, after the container is healthy. Best-effort. The
   * slot is reserved now. `done`: the rebuild to wait for when it is not the
   * queue's (one the boot's pass finishes itself, HB-1445); it never rejects.
   */
  afterRebuild(agentId: string, done?: Promise<unknown>): void;
  /** Is a recovery turn running (or reserved) for this agent? */
  recovering(agentId: string): boolean;
  /**
   * Is its recovery turn answering now: being prepared or started, and not
   * yet seen to end? Not the slot a switch reserves until its rebuild is
   * done. The one turn per agent reads it, so an ask, a checkpoint or a
   * consult waits for it.
   */
  answering(agentId: string): boolean;
  /** Look at its recovery turn's process now, and free the slot if it has ended (before an action that `recovering` refuses). */
  settle(agentId: string): Promise<void>;
  /** End the slots' timers, at shutdown. */
  stop(): void;
}

export interface ContextRecoveryDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** The setup or rebuild under way for an agent (the lifecycle queue's), if any. */
  inFlight: (agentId: string) => Promise<void> | undefined;
  /** The one turn per agent (the consult service's `turns`): an ask, a checkpoint, a consult. */
  turns: Pick<AgentTurns, 'inFlight'>;
}

/** How long a recovery holds its slot at most: the turn's own --timeout is 900 s. */
const RECOVERY_SLOT_MS = 15 * 60_000;
/** How often a running recovery's process is looked at: once it has ended, its slot is freed (HB-0887). */
export const RECOVERY_CHECK_MS = 30_000;

/** One recovery's hold on its agent's slot, and its timers. */
interface Attempt {
  /** The ceiling: frees the slot after RECOVERY_SLOT_MS. */
  timer?: NodeJS.Timeout;
  /** The next look at its process. */
  check?: NodeJS.Timeout;
  /** Its turn, once started: where it runs, and its process when the launch could say. */
  turn?: { hostId: string; runtimeRef: string; proc?: RecoveryProcess };
  /**
   * Its turn is being prepared (the history rendered, then the launch): it
   * holds the agent's one turn from the check that let it in, or an ask
   * admitted meanwhile ran beside it in the same conversation.
   */
  preparing?: boolean;
}

export function createContextRecovery(deps: ContextRecoveryDeps): ContextRecovery {
  const { store, providerFor, trace, inFlight, turns } = deps;
  /** Agents with a background recovery turn in flight, each with the attempt that holds its slot. */
  const recovering = new Map<string, Attempt>();
  /** The slots' timers (a ceiling and a look at the process); each is its recovery's own. */
  const recoveryExpiries = new Set<NodeJS.Timeout>();
  let stopped = false;
  const claim = (id: string, preparing = false): Attempt => { const attempt: Attempt = preparing ? { preparing } : {}; recovering.set(id, attempt); return attempt; };
  const clear = (t: NodeJS.Timeout | undefined): undefined => { if (t) { clearTimeout(t); recoveryExpiries.delete(t); } return undefined; };
  /**
   * The slot is freed by the attempt that holds it, never by an older one:
   * a recovery that found nothing left its timer running, and fifteen
   * minutes on it freed the slot of the recovery after it (HB-0886).
   */
  const release = (id: string, attempt: Attempt): void => {
    attempt.timer = clear(attempt.timer);
    attempt.check = clear(attempt.check);
    if (recovering.get(id) === attempt) recovering.delete(id);
  };
  /** Free the slot after RECOVERY_SLOT_MS (`unref()`'d), as each recovery did. */
  const expireLater = (id: string, attempt: Attempt): void => {
    const timer = setTimeout(() => release(id, attempt), RECOVERY_SLOT_MS);
    timer.unref();
    attempt.timer = timer;
    recoveryExpiries.add(timer);
  };
  /**
   * Has its turn ended? Its container stopped or replaced took the turn with
   * it; otherwise its process is looked at in the container. Not known (no
   * process from the launch, or the container could not be asked): the
   * ceiling frees it.
   */
  const look = async (id: string, attempt: Attempt): Promise<void> => {
    const turn = attempt.turn;
    if (!turn?.proc || recovering.get(id) !== attempt) return;
    const now = store.getAgent(id);
    if (!now || now.state !== 'RUNNING' || now.runtimeRef !== turn.runtimeRef) { release(id, attempt); return; }
    const running = await recoveryRunning(providerFor(turn.hostId), turn.runtimeRef, turn.proc).catch(() => undefined);
    if (running === false) release(id, attempt);
  };
  /** Look again in RECOVERY_CHECK_MS (`unref()`'d), while the attempt holds the slot. */
  const watch = (id: string, attempt: Attempt): void => {
    if (stopped || !attempt.turn?.proc || recovering.get(id) !== attempt) return;
    const check = setTimeout(() => {
      attempt.check = clear(check);
      const again = () => watch(id, attempt);
      look(id, attempt).then(again, again);
    }, RECOVERY_CHECK_MS);
    check.unref();
    attempt.check = check;
    recoveryExpiries.add(check);
  };
  /** Its turn has started: the shared turn counts it, and its process is watched. */
  const started = (agent: Agent, attempt: Attempt, proc: RecoveryProcess | undefined): void => {
    attempt.turn = { hostId: agent.hostId, runtimeRef: agent.runtimeRef!, ...(proc ? { proc } : {}) };
    watch(agent.id, attempt);
  };

  // ---- chat history (from the agent's own transcript store) ----------------
  // The Telegram Bot API can't read past messages; OpenClaw's session files can,
  // including conversations from before a reset. Owner only.
  const transcript: ContextRecovery['transcript'] = async (agent) => {
    if (!['RUNNING', 'STOPPED', 'ARCHIVED'].includes(agent.state) || isBusy(agent.id)) {
      return refused(409, `Can't read the history while the agent is ${isBusy(agent.id) ? 'busy' : agent.state.toLowerCase()} — try again in a moment.`);
    }
    let t;
    try { t = await exportTranscript(providerFor(agent.hostId), agent); }
    catch (err) { return refused(502, `Couldn't read the chat history: ${String((err as Error).message ?? err).slice(0, 200)}`); }
    if (!t.messages) return refused(404, 'No chat history found for this agent yet.');
    trace(agent.id)('transcript.exported', { conversations: t.conversations, messages: t.messages, ...(t.unreadable ? { unreadable: t.unreadable } : {}) });
    const file = `${agent.slug}-chat-history-${new Date().toISOString().slice(0, 10)}.md`;
    return said({ t, file });
  };

  /** Restore what a reset made the agent lose: stage its earlier conversations
   *  in its workspace and have it save the durable parts to memory (background;
   *  it confirms in its own chat). */
  const recover: ContextRecovery['recover'] = async (agent, includeLive) => {
    if (recovering.has(agent.id)) return refused(409, 'A recovery is already running for this agent — it will confirm in its chat when done.');
    // Its turn goes into the same conversation as an ask, a checkpoint or a
    // consult: not started while one of those is answering (HB-0887).
    if (turns.inFlight(agent.id)) return refused(429, 'It is already answering something — try again when that finishes.');
    // In the same tick as that check: answering from here, not from its launch.
    const attempt = claim(agent.id, true);
    expireLater(agent.id, attempt); // the turn's own --timeout is 900s
    let staged;
    try { staged = await recoverContext(providerFor(agent.hostId), agent, { includeLive }); }
    catch (err) { release(agent.id, attempt); return refused(502, `Couldn't recover the history: ${String((err as Error).message ?? err).slice(0, 300)}`); }
    const { proc, ...r } = staged;
    trace(agent.id)('transcript.recover_started', r);
    store.clearContextReset(agent.id); // the offer is taken; stop making it
    if (!r.messages) {
      release(agent.id, attempt);
      return said({ started: false, reason: includeLive ? 'Nothing to recover — no chat history found.' : 'Nothing to recover — there are no conversations from before a reset; the current one is already in its context (tick "include the current conversation" right after a source switch).' });
    }
    started(agent, attempt, proc);
    return said({ started: true, ...r });
  };

  /**
   * The page's Recover context offer, when the recovery after a switch was
   * not run because a turn was answering: that turn is the first on the
   * new source and ends the conversation the recovery was for, and the
   * rebuild's own look at the agent's context came before it, so nothing
   * offered it and only the timeline said so (HB-1176). What it would have
   * restored, read now: a conversation ended since the switch was asked
   * (`since`) is offered as the rebuild's look offers one; one not ended
   * yet, with the conversation still current, which the new source does not
   * have. Only when there is one: an offer made now is news again, and
   * with none current it offered again only what the owner had dismissed.
   * A container that does not answer is no evidence: nothing is offered;
   * and an offer the owner dismissed while it was read stays dismissed.
   */
  const offerRecovery = async (agent: Agent, since: number): Promise<void> => {
    const shown = store.getContextReset(agent.id);
    let stats;
    try { stats = await contextStats(providerFor(agent.hostId), agent); } catch { return; }
    if (shown && !store.getContextReset(agent.id)) return;
    const ended = stats.lastReset ? Date.parse(stats.lastReset) : 0;
    if (ended && ended >= since - 60_000 && stats.lostMessages) {
      store.setContextReset(agent.id, { resetAt: stats.lastReset!, lostMessages: stats.lostMessages });
      trace(agent.id)('context.reset_after_rebuild', { resetAt: stats.lastReset, lost: stats.lostMessages });
      return;
    }
    if (!stats.liveMessages) return;
    const offer = { resetAt: new Date().toISOString(), lostMessages: stats.lostMessages + stats.liveMessages };
    store.setContextReset(agent.id, offer);
    trace(agent.id)('context.recover_offered_after_switch', { lost: offer.lostMessages, live: stats.liveMessages });
  };

  const afterRebuild: ContextRecovery['afterRebuild'] = (id, done) => {
    // No rebuild to wait for: nothing would ever free a reservation, and the
    // agent would never sleep again (HB-0887's idle sweep reads it). Looked
    // at before the claim, which would put aside a recovery holding the slot.
    const rebuild = done ?? inFlight(id);
    if (!rebuild) return;
    const since = Date.now();
    // Reserve the slot now so a manual click can't double up.
    const attempt = claim(id);
    // The source it was switched to: the recovery is for after that runs.
    const intended = store.getAgent(id)?.aiProfileId;
    void rebuild.then(async () => {
      // Its own reservation, still: a slot freed meanwhile is not taken back.
      if (recovering.get(id) !== attempt) return;
      const fresh = store.getAgent(id);
      if (!fresh?.runtimeRef || fresh.state !== 'RUNNING') { release(id, attempt); return; }
      // A rebuild that was refused (or failed) leaves the old container
      // running on the old source: the recovery, promised for the new one,
      // is not run there (HB-0892). Recover context is there once it is.
      if (!intended || fresh.appliedProfileId !== intended) {
        release(id, attempt);
        trace(id)('transcript.recover_after_switch_skipped', { why: 'the rebuild did not put it on its new source' });
        return;
      }
      // An ask, a checkpoint or a consult that came after the rebuild is
      // answering in the conversation the recovery would go into: it is not
      // run beside it, as Recover context is not (HB-0887). Not waited for:
      // that turn may take minutes. The page offers Recover context instead.
      if (turns.inFlight(id)) {
        release(id, attempt);
        trace(id)('transcript.recover_after_switch_skipped', { why: 'it was answering something when its rebuild was done' });
        await offerRecovery(fresh, since);
        return;
      }
      attempt.preparing = true;
      expireLater(id, attempt);
      const staged = await recoverContext(providerFor(fresh.hostId), fresh, { includeLive: true })
        .catch((err) => ({ error: String((err as Error)?.message ?? err).slice(0, 200) }));
      if (!('messages' in staged)) { release(id, attempt); trace(id)('transcript.recover_after_switch', staged); return; }
      const { proc, ...r } = staged;
      trace(id)('transcript.recover_after_switch', r);
      if (!r.messages) { release(id, attempt); return; }
      started(fresh, attempt, proc);
      // A throw on the way (providerFor for a machine no longer known) frees
      // the slot it reserved: swallowed, it held it until a restart, and
      // Recover context was refused meanwhile.
    }).catch(() => { release(id, attempt); });
  };

  return {
    transcript, recover, afterRebuild,
    recovering: (id) => recovering.has(id),
    answering: (id) => { const attempt = recovering.get(id); return !!(attempt?.turn || attempt?.preparing); },
    settle: async (id) => {
      const attempt = recovering.get(id);
      if (attempt?.turn) await look(id, attempt);
    },
    stop: () => {
      stopped = true;
      for (const timer of recoveryExpiries) clearTimeout(timer);
      recoveryExpiries.clear();
    },
  };
}
