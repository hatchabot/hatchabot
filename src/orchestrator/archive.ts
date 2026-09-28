import type { Store } from '../store/store.js';
import type { SecretStore } from '../secrets/secretStore.js';
import type { RuntimeProvider } from '../providers/provider.js';
import type { CompositeTelegramProvisioner } from '../channels/composite.js';
import { whileBusy } from './busy.js';
import { canTransition } from '../domain/stateMachine.js';

/**
 * Archive: a STOPPED agent that has handed its Telegram bot back.
 *
 * The scarce resource in this system is not disk or CPU — it's bot tokens.
 * Telegram caps how many bots one account may own (~20 in practice), and every
 * agent, however idle, sits on one. A seasonal agent — tax season, a trip, a
 * house move — is worth keeping whole and worth nothing at all as a held token.
 *
 * So archiving takes the one thing another agent can't do without and leaves
 * everything else exactly where it is: the container (stopped), its volume, the
 * memory in it, the members, the settings. The only thing that does not survive
 * is the CHAT ADDRESS. Coming back means leasing a bot again, and it will be a
 * different bot with a different link — which is why restoring re-enters
 * provisioning rather than simply starting the container, and why the members
 * are told, while the old bot can still speak to them, that a new link will
 * follow. Their Telegram user ids are global rather than per-bot, so the
 * allowlist rebuilds itself on restore and nobody has to pair again.
 */
export interface ArchiveDeps {
  store: Store;
  secrets: SecretStore;
  provider: RuntimeProvider;
  channel: CompositeTelegramProvisioner;
  log: (event: string, detail: Record<string, unknown>) => void;
}

export class ArchiveError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'ArchiveError';
  }
}

export async function archiveAgent(deps: ArchiveDeps, agentId: string): Promise<void> {
  return whileBusy(agentId, async () => {
    const { store, secrets, provider, channel, log } = deps;
    const agent = store.getAgent(agentId);
    if (!agent) throw new ArchiveError('No such agent.');
    if (agent.state === 'ARCHIVED') return; // idempotent: a double tap is not an error
    // Judged now, inside the busy flag: the route's check came before it
    // waited out a Retry, and giving up the bot first then failing to flip
    // the state left the agent neither archived nor whole (night review).
    if (!canTransition(agent.state, 'ARCHIVED')) throw new ArchiveError(`It is ${agent.state.toLowerCase()} — wait for it to settle, then archive it.`);

    // Stop first, and only release the bot once the runtime is actually down.
    // A container left polling a token that has gone back in the pool is the
    // one genuinely bad outcome here: the next agent to lease it would fight
    // this one for every message.
    // Whatever the state: a FAILED agent's container may still be up and
    // polling (a failed delete or rebuild leaves it so). If it cannot be
    // stopped, the bot is not given up (night review, 2026-09-27).
    if (agent.runtimeRef) {
      try {
        await provider.stop(agent.runtimeRef);
      } catch (err) {
        if (agent.state === 'RUNNING') throw err;
        const st = await provider.status(agent.runtimeRef).catch(() => ({ phase: 'unknown' as const }));
        if (st.phase !== 'absent' && st.phase !== 'stopped') {
          throw new ArchiveError("Couldn't stop its runtime, so its bot was not given up. Try again in a moment.");
        }
      }
    }

    const row = store.getChannelForAgent(agentId);
    if (row && !agent.migratedTo) {
      // A PASTED bot is parked in the pool first, exactly as delete does it —
      // the token stays usable, which is the entire point of archiving. Under
      // the agent's OWNER: their token, their pool slot, never another user's
      // next lease.
      if (!channel.pool.owns(row.accountId)) {
        try {
          await channel.pool.addToPool(row.accountId, await secrets.get(row.secretRef), agent.ownerId);
        } catch (err) {
          // Recycling is the bonus, not the job. An agent that can't be parked
          // in the pool is still archived; the token just isn't reusable.
          log('archive.recycle_failed', { agentId, error: String(err) });
        }
      }
      // agentId explicitly: a token parked a line ago has no lease to read, and
      // its members would otherwise get no goodbye at all.
      await channel.release(row.accountId, { reason: 'archived', agentId });
      // An imported agent's token lives outside the username-keyed space that
      // release() scrubs.
      if (row.secretRef.startsWith('channel/')) await secrets.delete(row.secretRef).catch(() => {});
      store.deleteChannelForAgent(agentId);
    }

    // Any outstanding invite points at a bot this agent no longer has. Let them
    // go rather than mint a membership with nowhere to talk.
    // An archived management agent keeps nothing running: its doorman goes too.
    if (agent.ops) await provider.removeOpsJail?.(agentId).catch(() => {});
    store.expireInvitesFor(agentId, 'agent-archived');
    // A parked human step ("paste a bot token") is meaningless now and would
    // otherwise follow the agent into the archive — the card would sit there
    // asking for a token for an agent that isn't running, and the fleet's
    // needs-attention count would never come down. Restore re-parks it if the
    // pool is still dry. Same for a token stashed but never committed: we are
    // giving up this identity, so don't quietly provision onto it later.
    store.setAgentPendingAction(agentId, null);
    channel.discardPending?.(agentId);
    store.setAgentState(agentId, 'ARCHIVED');
    log('agent.archived', { agentId, accountId: row?.accountId });
  });
}
