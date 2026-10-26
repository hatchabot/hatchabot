import { stopAndConfirm } from './quiesce.js';
import type { Store } from '../store/store.js';
import type { Agent } from '../domain/types.js';
import type { SecretStore } from '../secrets/secretStore.js';
import type { RuntimeProvider } from '../providers/provider.js';
import type { CompositeTelegramProvisioner } from '../channels/composite.js';
import { whileBusy } from './busy.js';
import { canTransition } from '../domain/stateMachine.js';
import { beginOperation, handleFor, rethrowIfCrash, type OpHandle } from './operations.js';
import { dropAppPending } from './appPending.js';

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
  channel: Pick<CompositeTelegramProvisioner, 'pool' | 'release'> & Partial<Pick<CompositeTelegramProvisioner, 'discardPending'>>;
  log: (event: string, detail: Record<string, unknown>) => void;
  /** Who asked, for the operation's record. */
  requestedBy?: string;
  /**
   * Its Discord and Slack bots: parked and their people told (the routes'
   * parkArchivedChannels). Part of the archive's finish, so a restart that
   * cut it off parks them too — done by the route alone, they stayed on the
   * agent for good (audit #093). Safe to run twice.
   */
  parkOtherChannels?: (agent: Agent) => Promise<void>;
}

export class ArchiveError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'ArchiveError';
  }
}

/**
 * A copy downloaded while it stood stopped (exportedAt) may be answering on
 * this bot somewhere else. Giving the bot up here must not make it the next
 * agent's: a pool bot leaves this pool, quietly (no goodbye through a bot the
 * copy may be using, no idle name over the copy's), and a pasted one is not
 * parked — only this machine's copy of its token goes. Delete and archive
 * both freed a pool bot, and archive parked a pasted one, so the next agent
 * here polled the same bot as the copy (audit #099).
 */
export async function leaveBotToCopy(channel: ArchiveDeps['channel'], accountId: string, agentId: string, log: (event: string, detail: Record<string, unknown>) => void): Promise<void> {
  if (!channel.pool.owns(accountId)) { await channel.release(accountId, { reason: 'moved', agentId }); return; }
  // Taken out while still this agent's, in one statement (a release first freed
  // it for a lease to take before the remove, HB-0065); left leased (a slot
  // used up) rather than freed when it cannot be.
  try { await channel.pool.removeFromPool(accountId, { leasedTo: agentId }); }
  catch (err) { log('bot.retire_failed', { agentId, accountId, error: String(err instanceof Error ? err.message : err).slice(0, 200) }); }
}

/** A copy was downloaded while it stood stopped: its bot may be answering there. */
export const copyElsewhere = (agent: { exportedAt?: string; state: string }): boolean => !!agent.exportedAt && agent.state !== 'RUNNING';

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

    // Recorded as it goes (operations.ts): a restart before the bot is given
    // back is undone (it is started again if it ran); after, the archive is
    // finished (resumeArchive) — the bot is gone, going back would need another.
    const row = store.getChannelForAgent(agentId);
    const wasRunning = agent.state === 'RUNNING';
    const op = beginOperation(store, 'archive', agentId, { wasRunning, accountId: row?.accountId ?? null }, { requestedBy: deps.requestedBy });
    try {
      // Stop first, and only release the bot once the runtime is actually down.
      // A container left polling a token that has gone back in the pool is the
      // one genuinely bad outcome here: the next agent to lease it would fight
      // this one for every message.
      // Whatever the state: a FAILED agent's container may still be up and
      // polling (a failed delete or rebuild leaves it so). If it cannot be
      // stopped, the bot is not given up (night review, 2026-09-27).
      if (agent.runtimeRef) {
        try { await stopAndConfirm(provider, agent.runtimeRef); }
        catch (err) {
          rethrowIfCrash(err);
          throw new ArchiveError("Couldn't confirm its runtime stopped, so its bot was not given up. Try again when its machine answers.");
        }
      }
      // Which way the bot goes is recorded with the stop: a bot left to a
      // copy cannot be taken back, so a restart part way finishes (HB-0233).
      const toCopy = !!row && !agent.migratedTo && copyElsewhere(agent);
      op.step('stopped', toCopy ? { leaveToCopy: true } : undefined);

      if (row && toCopy) {
        log('bot.not_parked', { agentId, why: 'a copy was downloaded', exportedAt: agent.exportedAt });
        await leaveBotToCopy(channel, row.accountId, agentId, log);
      } else if (row && !agent.migratedTo) {
        // A PASTED bot is parked in the pool first, exactly as delete does it —
        // the token stays usable, which is the entire point of archiving. Under
        // the agent's OWNER: their token, their pool slot, never another user's
        // next lease.
        if (!channel.pool.owns(row.accountId)) {
          try {
            await channel.pool.addToPool(row.accountId, await secrets.get(row.secretRef), agent.ownerId);
          } catch (err) {
            rethrowIfCrash(err);
            // Recycling is the bonus, not the job. An agent that can't be parked
            // in the pool is still archived; the token just isn't reusable.
            log('archive.recycle_failed', { agentId, error: String(err) });
          }
        }
        // agentId explicitly: a token parked a line ago has no lease to read, and
        // its members would otherwise get no goodbye at all.
        await channel.release(row.accountId, { reason: 'archived', agentId });
      }
      op.step('bot-released');
      await finishArchive(deps, op, agentId);
    } catch (err) {
      rethrowIfCrash(err);
      // The stop or the release failed in this process: the route says so, as
      // it always did; the record ends with it.
      if (op.get().status === 'running') op.fail(err);
      throw err;
    }
  });
}

/**
 * Everything after the bot is given back, each step safe to run twice: the
 * token an import kept, the channel row, a management agent's doorman, the
 * invites and the parked human step, then ARCHIVED. The container stays
 * stopped. Shared by the archive and its finish after a restart.
 */
async function finishArchive(deps: ArchiveDeps, op: OpHandle, agentId: string): Promise<void> {
  const { store, secrets, provider, channel, log } = deps;
  const agent = store.getAgent(agentId);
  if (!agent) return;
  const row = store.getChannelForAgent(agentId);
  if (row && !agent.migratedTo) {
    // An imported agent's token lives outside the username-keyed space that
    // release() scrubs.
    if (row.secretRef.startsWith('channel/')) await secrets.delete(row.secretRef).catch(() => {});
    store.deleteChannelForAgent(agentId);
  }

  if (!agent.migratedTo) await deps.parkOtherChannels?.(agent);

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
  // So is an app still waiting to go in, and any secret values it was given:
  // a restored agent is installed into again by hand.
  await dropAppPending(store, secrets, agentId);
  if (agent.state !== 'ARCHIVED') store.setAgentState(agentId, 'ARCHIVED');
  op.step('archived');
  log('agent.archived', { agentId, accountId: row?.accountId ?? (op.get().params.accountId as string | null) ?? undefined });
  op.done('Archived.');
}

/**
 * An archive a restart cut off (the design's archive row). Its bot given back
 * — recorded, or found back in the pool and not leased to it (a pasted bot is
 * parked there before it is released) — means finish: ARCHIVED, the container
 * left stopped. Otherwise nothing was given up: undone, and started again if
 * it ran.
 */
export async function resumeArchive(deps: ArchiveDeps, opId: string): Promise<void> {
  const op = handleFor(deps.store, opId);
  const row = op.get();
  const agent = row.agentId ? deps.store.getAgent(row.agentId) : undefined;
  if (!agent || agent.state === 'DELETED') { op.fail('Interrupted by a restart; the agent is gone.'); return; }
  if (agent.state === 'ARCHIVED') { await finishArchive(deps, op, agent.id); return; }
  const p = row.params as { wasRunning?: boolean; accountId?: string | null; leaveToCopy?: boolean };
  // Its bot was being left to a downloaded copy: there is nothing to undo to
  // (a pool bot gone from the pool left it stopped with a channel row whose
  // bot was gone, HB-0233), so it is finished; leaving it again is harmless.
  const toCopy = !!p.leaveToCopy && row.step === 'stopped';
  const released = toCopy || row.step === 'bot-released' || row.step === 'archived' || (() => {
    if (!p.accountId) return false;
    const entry = deps.channel.pool.list().find((e) => e.username.toLowerCase() === String(p.accountId).toLowerCase());
    return !!entry && entry.leasedTo !== agent.id;
  })();
  if (released) {
    // Its container must not poll a bot that may be someone else's now.
    // Confirmed down before its channel row goes and it is called archived: a
    // swallowed stop used to finish with the container still up (B025). Held
    // until it is — Start and Wake stay refused, and Try again runs this again.
    if (agent.runtimeRef) {
      try { await stopAndConfirm(deps.provider, agent.runtimeRef); }
      catch (err) {
        rethrowIfCrash(err);
        deps.log('archive.not_stopped', { agentId: agent.id, error: String(err instanceof Error ? err.message : err).slice(0, 200) });
        op.hold(
          'The archive was interrupted by a restart after its bot was given back, and its runtime could not be confirmed stopped, ' +
            'so it may still answer on a bot that is free for another agent now. Wake its machine or bring Docker back, then try again.',
          { actions: [{ action: 'retry', label: 'Try again' }], recommended: 'retry' },
        );
        return;
      }
    }
    if (toCopy && p.accountId && deps.store.getChannelForAgent(agent.id)) await leaveBotToCopy(deps.channel, p.accountId, agent.id, deps.log);
    await finishArchive(deps, op, agent.id);
    return;
  }
  if (p.wasRunning && agent.runtimeRef) {
    await deps.provider.start(agent.runtimeRef);
    if (deps.store.getAgent(agent.id)?.state !== 'RUNNING') deps.store.setAgentState(agent.id, 'RUNNING');
  }
  deps.log('archive.undone', { agentId: agent.id });
  op.rolledBack('The archive was interrupted by a restart before its bot was given back — it was left as it was.');
}
