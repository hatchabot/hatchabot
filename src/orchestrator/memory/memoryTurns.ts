import { notifyAgentChat } from '../../channels/notify.js';
import type { Agent } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import type { Store } from '../../store/store.js';
import { isBusy } from '../lifecycle/busy.js';
import { refused, said, type Answer } from '../consult/answers.js';
import type { AgentTurns } from '../consult/consults.js';
import { checkpointMemory } from '../lifecycle/provision.js';

/** What a checkpoint did: saved, found nothing new, or could not run its turn. */
export type CheckpointAnswer =
  | { ok: true; saved: true }
  | { ok: true; saved: false; nothingNew: boolean; note: string }
  | { ok: false; saved: false; error: string };

/**
 * The turns an owner runs in an agent's own conversation (HB-0808 step 13):
 * a checkpoint (save the conversation to memory now) and an ask (say
 * something, get its answer). Each takes the agent's one turn (`turns`,
 * the consult service's), so neither interleaves with a consult, a
 * distillation or the other. No state of its own; a turn's time limit is
 * its exec's, per request.
 */
export interface MemoryTurns {
  /** Save the live conversation to memory (a running agent the route checked, not busy). */
  checkpoint(agent: Agent): Promise<Answer<CheckpointAnswer>>;
  /** A sleeping agent is woken to be asked something; any other is left as it is. */
  wakeToAsk(agent: Agent | undefined): Promise<void>;
  /** Say `text` to a running agent and answer with what it said; `via` is how the owner asked, `ownerId` who. */
  ask(agent: Agent, text: unknown, via: string, ownerId: string): Promise<Answer<{ reply: string }>>;
}

export interface MemoryTurnsDeps {
  store: Store;
  secrets: SecretStore;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** The one turn per agent (the consult service's `turns`). */
  turns: AgentTurns;
  /** Wake a sleeping agent and wait for its gateway. */
  ensureAwake: (agent: Agent, why: string) => Promise<Agent>;
  /** Its cached sessions are dropped (the conversations service's). */
  forgetSessions: (agentId: string) => void;
  /** How long an owner's ask (and a distillation) may take (HATCHABOT_ASK_TIMEOUT_MS). */
  askTimeoutMs: number;
}

export function createMemoryTurns(deps: MemoryTurnsDeps): MemoryTurns {
  const { store, secrets, providerFor, trace, turns, ensureAwake } = deps;
  const ASK_TIMEOUT_MS = deps.askTimeoutMs;

  /**
   * Save the live conversation to memory on demand — the standalone form of the
   * pre-rebuild checkpoint. Useful before archiving, before /new, or whenever
   * you want durable facts written down ahead of a reset you can see coming. It
   * writes to MEMORY.md/today's file and resets nothing.
   */
  const checkpoint: MemoryTurns['checkpoint'] = async (agent) => {
    // The checkpoint IS an agent turn, so it needs the AI source to run. If the
    // source is out of credits / expired / unreachable, the turn fails and
    // NOTHING is written — report that honestly instead of a false "Saved".
    // A turn in flight, as an ask is: the idle sweep and a second ask wait.
    if (!turns.take(agent.id)) return refused(429, 'It is already answering something — try again when that finishes.');
    let r: Awaited<ReturnType<typeof checkpointMemory>>;
    try { r = await checkpointMemory(providerFor(agent.hostId), agent.runtimeRef!, agent.slug, trace(agent.id)); }
    finally { turns.release(agent.id); }
    if (!r.ok) {
      return said({
        ok: false, saved: false,
        error: `Couldn't save to memory — the agent's AI source didn't complete the turn (out of credits, expired, or unreachable?). Nothing was lost; the summary just wasn't written. ${r.detail ?? ''}`.trim(),
      });
    }
    // A turn that ended well has not necessarily saved anything: only a
    // change to MEMORY.md or memory/ is a save (2026-09-30).
    if (r.changed !== true) {
      return said({
        ok: true, saved: false, nothingNew: r.changed === false,
        note: r.changed === false
          ? 'It found nothing new to save — its memory files are unchanged.'
          : "It finished, but its memory files couldn't be checked, so it isn't known whether anything was saved.",
      });
    }
    // Confirm in Telegram (ONLY on a real save) — where the agent lives, so a
    // web-triggered checkpoint isn't invisible to someone watching the chat.
    // Sent to the agent's active members; best-effort, no-op if it has no bot.
    const notified = await notifyAgentChat(
      store, secrets, agent.id,
      '📝 Saved our conversation to memory — it will survive a reset.',
    ).catch(() => 0);
    trace(agent.id)('memory.checkpoint_notified', { chats: notified });
    return said({ ok: true, saved: true });
  };

  const wakeToAsk: MemoryTurns['wakeToAsk'] = async (sleeping) => {
    if (sleeping?.hibernatedAt && sleeping.state === 'STOPPED') await ensureAwake(sleeping, 'it was asked something');
  };

  // The owner says something to their agent and gets its answer back — the
  // command-line twin of typing in the agent's console. It lands in the same
  // conversation the owner has with it in the app.
  const ask: MemoryTurns['ask'] = async (agent, sent, via, ownerId) => {
    const text = String(sent ?? '').trim();
    if (!text) return refused(400, 'Say something.');
    if (text.length > 8000) return refused(413, 'That message is over 8,000 characters.');
    if (isBusy(agent.id)) return refused(409, 'It is busy (rebuilding or moving) — try again shortly.');
    // One turn at a time, shared with agent-to-agent consults: two turns racing
    // into one conversation interleave.
    if (!turns.take(agent.id)) return refused(429, 'It is already answering something — try again when that finishes.');
    try {
      trace(agent.id)('owner.ask', { chars: text.length, via });
      deps.forgetSessions(agent.id);
      const res = await providerFor(agent.hostId).exec(agent.runtimeRef!, ['agent', '--agent', agent.slug, '-m', text], { timeoutMs: ASK_TIMEOUT_MS });
      deps.forgetSessions(agent.id);
      if (res.timedOut) return refused(504, `No answer within ${Math.round(ASK_TIMEOUT_MS / 1000)} s.`);
      if (res.code !== 0) return refused(502, 'The turn did not complete — see: hatchabot logs ' + agent.slug);
      // The owner just read the answer; it is not news waiting in the app.
      // Only an answer: a turn that failed or ran out of time marked as read
      // what was waiting, which the owner had not seen (HB-1014).
      store.setAgentSeen(ownerId, agent.id, Date.now());
      return said({ reply: res.stdout.trim().slice(0, 50_000) || '(no reply)' });
    } finally {
      turns.release(agent.id);
    }
  };

  return { checkpoint, wakeToAsk, ask };
}
