import { randomUUID } from 'node:crypto';
import type { ChannelConnector } from '../../channels/connector.js';
import type { CompositeTelegramProvisioner } from '../../channels/composite.js';
import type { Agent, Channel } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import type { Store } from '../../store/store.js';
import { dropAppPending } from '../apps/appPending.js';
import { archiveAgent, ArchiveError, copyElsewhere, leaveBotToCopy } from './archive.js';
import { AgentBusyError, clearBusy, isBusy, markBusy } from './busy.js';
import { parkDiscordBot } from '../channels/discordPool.js';
import { eventLabel, IN_PROGRESS } from '../health/eventLabels.js';
import { forgetFilesReplacing, handleFor, holdDeleteEnds } from './operations.js';
import { checkpointMemory, createAgentRecord, SKIP_POOL, slugify } from './provision.js';
import { machineLoginOnly, modelOverrideProblem } from './modelRuntime.js';

/** A Claude Max source on this machine's login cannot reach a runner: create's and PATCH's words. */
export const MACHINE_LOGIN_NO_RUNNER = "This Claude Max profile uses this machine's login, which can't reach a runner. Run `claude setup-token` and add it as a setup-token AI source, or use an API-key profile.";

/** A new agent as the create route's body gives it (`CreateAgent` in src/api/lifecycleRoutes.ts). */
export interface NewAgent {
  name: string;
  persona?: string;
  aiProfileId: string;
  hostId: string;
  sharedMemory?: boolean;
  model?: string;
  seedMembers?: string[];
  skipPool?: boolean;
  telegram?: boolean;
}

/** Why not, with the status the route answers and its words. */
export type RecordRefusal = { ok: false; status: number; error: string };

/**
 * An agent's record and what makes, keeps or ends it (HB-0808 step 11, part 2):
 * create, archive and unarchive, and delete, with the two markers the list
 * and the other features read (`archiving`, `deletesRunning`). Part of the
 * agent lifecycle service (agentLifecycle.ts). Nothing here knows HTTP: who
 * may ask, the first checks (the agent's, `busyNow`, the agent cap's place)
 * and the words of the answer are src/api/lifecycleRoutes.ts's; a refusal is
 * a result with its status and words.
 *
 * A restart loses nothing of it (docs/architecture.md, "In-memory state,
 * sorted"): an archive is an operation on disk (archive.ts, settled by
 * `resumeArchive`), and a delete cut off leaves the agent DELETING in the
 * store, which Delete finishes (HB-0265).
 */
export interface AgentRecords {
  /**
   * Make an agent and start its setup. `capProblem` takes the agent cap's
   * place for the request (the route context's); `holdName` holds the name
   * until the request answers (HB-0305). The checks run in their order.
   */
  create(ownerId: string, data: NewAgent, guards: { capProblem: () => string | undefined; holdName: (key: string) => boolean }): { ok: true; agent: Agent } | RecordRefusal;
  /** Is it being archived (from the click to the state flip)? */
  isArchiving(agentId: string): boolean;
  /** The archive's step under way, and since when, for the agent's answer. */
  archivingNow(agentId: string): { at: string; step: string } | undefined;
  /** For a busy agent: its newest event, as a plain step ("re-indexing memory") with its time. */
  progressOf(a: Agent): { at: string; step: string } | undefined;
  /**
   * Archive it: keep the agent, give its bot back. `answer` is made before the
   * marker goes, as the route's answer was.
   */
  archive<T>(agent: Agent, opts: { checkpoint: boolean; requestedBy: string },
    answer: (out: { checkpointWarning?: string; botReturn: unknown }) => T): Promise<{ ok: true; value: T } | RecordRefusal>;
  /**
   * Bring an archived agent back: its parked bots, then setup (the route
   * checked the cap, the state and the hold). `answer` is made as setup is
   * kicked, as the route's answer was.
   */
  restore<T>(agent: Agent, answer: () => T): Promise<T>;
  /** Is a delete of it under way in this process? */
  isDeleting(agentId: string): boolean;
  /** Run `fn` as the agent's delete: marked meanwhile; a setup for an answered bot-token step skipped meanwhile goes on after. */
  whileDeleting<T>(agentId: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Delete it, from waiting out its setup or rebuild to the tombstone. The
   * route checked who asks and `busyNow`. `answer` is made from the tombstone
   * as it is written.
   */
  remove<T>(agent: Agent, opts: { recycleBot?: string }, answer: (tombstone: Agent) => T): Promise<{ ok: true; value: T } | RecordRefusal>;
}

export interface AgentRecordsDeps {
  store: Store;
  secrets: SecretStore;
  providerFor: (hostId: string) => RuntimeProvider;
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  channel: CompositeTelegramProvisioner;
  /** A runner whose removal is under way: no agent is made on one (HB-0275). Its words, or undefined. */
  hostGoing: (hostId: string) => string | undefined;
  /** Its chat-app connector (Discord, Slack), from the channels service. */
  connectorFor: (kind: string) => ChannelConnector | undefined;
  /** Tell the people on a chat-app bot something, from the channels service. Returns how many were told. */
  dmChannelPeople: (agent: Agent, kind: Channel['kind'], secretRef: string, text: string) => Promise<number>;
  /** An archive's Discord and Slack bots parked and their people told (routes.ts; the boot's finish uses it too). */
  parkArchivedChannels: (agent: Agent) => Promise<void>;
  /** The agent settings service forgets a deleted agent. */
  forgetSettings: (agentId: string) => void;
  /** The conversations service forgets a deleted agent's cached reads (HB-0914). */
  forgetConversations: (agentId: string) => void;
  /** The queue's (rebuildQueue.ts). */
  kickProvision: (agentId: string, opts?: { webOnlyIfNoBot?: boolean }) => void;
  provisionWhenFree: (agentId: string) => void;
  inFlight: (agentId: string) => Promise<void> | undefined;
  callOff: (agentId: string) => void;
  logError: (detail: Record<string, unknown>, msg: string) => void;
  warn: (detail: Record<string, unknown>, msg: string) => void;
}

export function createAgentRecords(deps: AgentRecordsDeps): AgentRecords {
  const { store, secrets, providerFor, trace, kickProvision, provisionWhenFree, inFlight, connectorFor, dmChannelPeople, parkArchivedChannels } = deps;
  /**
   * Archives under way, from the click to the state flip: the checkpoint turn
   * alone is ~20 s, and the tile used to look untouched all that time, as if
   * the button had done nothing (2026-10-07). The list, the agent's own GET and
   * the CLI read it (`archiving`, `progress`).
   */
  const archiving = new Map<string, { at: string; step: string }>();
  /**
   * Deletes under way in this process. The page offers Delete on a DELETING
   * agent too (one a restart interrupted, HB-0265), so a second Delete while
   * the first still tears down is turned away rather than run beside it.
   */
  const deletesRunning = new Set<string>();

  const create: AgentRecords['create'] = (ownerId, data, guards) => {
    // Ownership, not mere existence: without this any authenticated caller
    // could run a container using the owner's AI credentials. Unknown-vs-
    // not-yours are the same answer on purpose. The one exception is a LOCAL
    // host: the machine is shared with every account on this installation
    // (see Store.listHosts) — what stays per-account is the AI credential.
    const profile = store.getAIProfile(data.aiProfileId);
    const host = store.getHost(data.hostId);
    if (!profile || (profile.ownerId !== ownerId && !profile.shared)) {
      return { ok: false, status: 400, error: 'Unknown AI profile' };
    }
    if (!host || (host.ownerId !== ownerId && host.kind !== 'local')) {
      return { ok: false, status: 400, error: 'Unknown host' };
    }
    { const going = deps.hostGoing(host.id); if (going) return { ok: false, status: 409, error: going }; }
    // A machine-login Max source (subscription, no stored token) IS the
    // operator's ~/.claude. Another account selecting it would mount that
    // directory into their container — refuse (family-member hardening). The
    // owner's own agents still use it; only cross-owner selection is blocked.
    if (profile.kind === 'subscription' && !profile.secretRef && profile.ownerId !== ownerId) {
      return { ok: false, status: 400,
        error:
          'That Max source uses its owner\'s machine login and can\'t be used by another account. ' +
          'Ask them to share a setup-token source instead, or use your own API-key source.',
      };
    }
    // A Claude Max profile reaches a runner only as a setup-token (secretRef
    // present) — that credential is injected as data. The machine-login flavour
    // mounts this box's ~/.claude, which a remote runner can't see.
    if (machineLoginOnly(profile) && host.kind !== 'local') return { ok: false, status: 400, error: MACHINE_LOGIN_NO_RUNNER };

    // A per-agent model override, if given, must belong to the profile's menu
    // and never applies to a local source.
    const modelProblem = modelOverrideProblem(profile, data.model);
    if (modelProblem) return { ok: false, status: 400, error: modelProblem };

    // Optional per-account ceiling: on a shared box this bounds how many
    // agents (and pool bots, ports, containers) one account can consume.
    // Unset = no limit, preserving the single-owner default. ARCHIVED agents
    // are excluded — they hold no bot, container, or port, so they don't
    // consume the resources this cap protects (an owner can keep old archives
    // without eating their live-agent budget).
    const capErr = guards.capProblem();
    if (capErr) return { ok: false, status: 429, error: capErr };

    // The slug is derived from the name and is UNIQUE per owner — it becomes
    // a container name and a workspace path. Catch the collision here: letting
    // it reach the INSERT surfaces a raw SQLite error as "Internal Server
    // Error", which tells the owner nothing about what to do next.
    const slug = slugify(data.name);
    const clash = store
      .listAllActiveAgents()
      .find((a) => a.ownerId === ownerId && a.slug === slug);
    if (clash) {
      return { ok: false, status: 409,
        error:
          `You already have an agent called "${clash.name}" (${clash.state.toLowerCase()}). ` +
          `Pick a different name, or delete that one first.`,
      };
    }
    // A rename to this name still under way (it holds the name until it
    // answers): made now, the rename then saved it too (HB-0305).
    if (!guards.holdName(`agent-name:${ownerId}:${data.name.trim().toLowerCase()}`)) {
      return { ok: false, status: 409, error: `An agent of yours is being renamed "${data.name.trim()}" right now. Pick another name, or try again in a moment.` };
    }

    const { seedMembers, skipPool, telegram, ...rest } = data;
    // Its row and what its first setup must know, written together: with no
    // Telegram, or with a bot of its own (skip the pool and walk BotFather).
    // The second is kept until the manual flow parks the agent with a
    // pendingAction, which drives every retry from then on. Each was its own
    // write after the row, and "skip the pool" was held in memory: a process
    // that ended in between left an agent whose Retry leased a pool bot its
    // owner had declined (HB-0837).
    const agent = store.transact(() => {
      const made = createAgentRecord(store, { ownerId, ...rest });
      if (telegram === false) store.setAgentWebOnly(made.id, true);
      if (skipPool) store.setAgentHold(made.id, SKIP_POOL, '1');
      return made;
    });
    // Must land before provisioning renders the config: allowFrom is seeded
    // onto the fresh volume there, and a member added afterwards would have to
    // pair like a stranger.
    for (const channelUserId of seedMembers ?? []) {
      // Skip anyone already admitted. Most importantly the OWNER: adopt seeds
      // from the source bot's allowFrom, which includes the owner's own
      // Telegram id — and createAgentRecord already bound it to the owner seat
      // via pair-once. Seeding it again would list the owner twice (owner seat
      // + a member row), the exact split link-owner-telegram.ts had to repair.
      // Also dedupes any repeated ids within seedMembers itself.
      if (store.getActiveMembershipByChannelUser(agent.id, channelUserId)) continue;
      store.insertMembership({
        id: randomUUID(),
        agentId: agent.id,
        userId: `telegram:${channelUserId}`,
        role: 'user',
        channelUserId,
        status: 'active',
        joinedAt: new Date().toISOString(),
      });
    }
    kickProvision(agent.id);
    return { ok: true, agent };
  };

  const progressOf = (a: Agent): { at: string; step: string } | undefined => {
    const arch = archiving.get(a.id);
    if (arch) return arch;
    if (a.state !== 'PROVISIONING' && a.state !== 'REBUILDING') return undefined;
    const last = store.listEvents([a.id], 1)[0];
    if (!last || !IN_PROGRESS.has(last.event)) return undefined;
    return { at: last.at, step: eventLabel(last.event, last.detail) };
  };

  const archive: AgentRecords['archive'] = async (agent, opts, answer) => {
    const { checkpoint } = opts;
    // Shown at once — on the tile, in the CLI, in every open browser — before
    // the waits below: the checkpoint alone is a whole agent turn (~20 s), and
    // until the state flipped the tile looked as if nothing had happened.
    const step = (what: string) => archiving.set(agent.id, { at: new Date().toISOString(), step: what });
    step(checkpoint ? 'archiving — saving its conversation to memory first' : 'archiving — stopping it and handing its bot back');
    trace(agent.id)('agent.archiving', { checkpoint });
    try {
      // Wait out an in-flight provision/rebuild: releasing the bot underneath one
      // would leave the finishing container polling a token that is back in the
      // pool and possibly already leased to somebody else.
      // A rebuild still waiting for a slot is called off, not waited through.
      deps.callOff(agent.id);
      const running = inFlight(agent.id);
      if (running) await running.catch(() => {});
      // Optionally distil the live conversation into MEMORY.md BEFORE we stop it —
      // a long archive may later restore into a fresh session that leans on
      // MEMORY.md rather than the old transcript. Must run while still RUNNING.
      // The checkpoint is an agent turn, so it can fail if the AI source is out of
      // credits — never block the archive on it, but surface a warning so the user
      // knows the summary wasn't saved.
      let checkpointWarning: string | undefined;
      if (checkpoint) {
        const r = await checkpointMemory(providerFor(agent.hostId), agent.runtimeRef!, agent.slug, trace(agent.id)).catch(() => ({ ok: false, detail: 'error' }));
        if (!r.ok) checkpointWarning = "Archived, but couldn't save the conversation to memory first — the AI source didn't complete (out of credits, expired, or unreachable?).";
      }
      step('archiving — stopping it and handing its bot back');
      let archived: Awaited<ReturnType<typeof archiveAgent>>;
      try {
        archived = await archiveAgent(
          { store, secrets, provider: providerFor(agent.hostId), channel: deps.channel, log: trace(agent.id), requestedBy: opts.requestedBy,
            parkOtherChannels: parkArchivedChannels },
          agent.id,
        );
      } catch (err) {
        if (err instanceof AgentBusyError) return { ok: false, status: 409, error: err.userMessage };
        if (err instanceof ArchiveError) return { ok: false, status: 409, error: err.userMessage };
        deps.logError({ agentId: agent.id, err: String(err) }, 'archive failed');
        return { ok: false, status: 502, error: "Couldn't archive the agent — try again in a moment." };
      }
      // Done: the marker (cleared below) is not part of the answer. Where its
      // bot went, as it happened (HB-0476): null when it had none to give back.
      return { ok: true, value: answer({ checkpointWarning, botReturn: archived.bot ?? null }) };
    } finally {
      archiving.delete(agent.id);
    }
  };

  const restore: AgentRecords['restore'] = async (agent, answer) => {
    // Reclaiming a parked bot waits for its platform. Keep Delete and other
    // lifecycle changes out until the channels and state are committed; a
    // deleted agent must never regain credentials after its scrub (HB-0702).
    // busyNow was checked above with no await before this claim.
    markBusy(agent.id);
    try {
    // The bots it left in the pool come back to it, if still there. Their
    // identity is checked with the platform again (a Slack deep link needs the
    // app id; a Discord one the bot user) so the row is whole.
    for (const kind of ['discord', 'slack'] as const) {
      const kept = store.discordBotArchivedFor(agent.id, kind);
      const conn = connectorFor(kind);
      if (!kept || !conn || store.getChannelForAgent(agent.id, kind)) continue;
      try {
        const secret = await secrets.get(kept.secretRef);
        const verified = await conn.verify(conn.credsFromSecret(secret));
        const secretRef = `channel/${agent.id}/${kind}`;
        await secrets.put(secretRef, secret);
        store.insertChannel({
          id: randomUUID(), agentId: agent.id, kind, accountId: verified.accountId, secretRef,
          deepLink: verified.deepLink, createdAt: new Date().toISOString(),
          settings: { ...verified.settings, displayName: verified.displayName, ...(verified.addToServerUrl ? { addToServerUrl: verified.addToServerUrl } : {}),
            warnings: verified.warnings, rooms: { mode: 'off' }, ...(kept.ownerId === null ? { pooledShared: true } : {}) },
        });
        store.deleteDiscordBot(kept.applicationId);
        if (kept.secretRef !== secretRef) await secrets.delete(kept.secretRef).catch(() => {});
        trace(agent.id)('channel.attached', { kind, accountId: verified.accountId, fromPool: true, restored: true });
      } catch (err) {
        // The token stored for a row that never came: not left behind (night review).
        if (!store.getChannelForAgent(agent.id, kind)) await secrets.delete(`channel/${agent.id}/${kind}`).catch(() => {});
        deps.warn({ agentId: agent.id, kind, err: String(err) }, 'parked bot not restored');
      }
    }
    store.setAgentState(agent.id, 'PROVISIONING');
    } finally { clearBusy(agent.id); }
    // Nobody was asked about Telegram here: with no pool bot free it comes
    // back web-only and the owner is told (Alerts), rather than sitting in
    // PROVISIONING until someone pastes a token (2026-10-07).
    // No await between releasing the restore's lock and provision taking it.
    kickProvision(agent.id, { webOnlyIfNoBot: true });
    return answer();
  };

  const whileDeleting: AgentRecords['whileDeleting'] = async (agentId, fn) => {
    deletesRunning.add(agentId);
    try { return await fn(); } finally {
      deletesRunning.delete(agentId);
      // Refused before it began (another change held the agent): setup for an
      // answered bot-token step, skipped while the delete ran, goes on.
      const after = store.getAgent(agentId);
      if (after?.state === 'PROVISIONING' && after.pendingAction?.received) provisionWhenFree(agentId);
    }
  };

  const remove: AgentRecords['remove'] = async (agent, query, answer) => {
    // Wait for any in-flight provision/rebuild: deleting underneath one would
    // let it re-create the container AFTER the purge, leaving an orphan that
    // still holds the bot token and keeps polling Telegram.
    // A rebuild still waiting for a slot is called off, not waited through.
    deps.callOff(agent.id);
    const running = inFlight(agent.id);
    if (running) await running.catch(() => {});
    // Re-check busy AFTER that wait: a migrate/adopt could have grabbed the
    // flag the instant the rebuild released it, and purging the volume under
    // an in-progress export is loss.
    if (isBusy(agent.id)) {
      return { ok: false, status: 409, error: 'Another operation is already running on this agent.' };
    }
    if (agent.state !== 'DELETING') store.setAgentState(agent.id, 'DELETING');
    // A pasted token held for its setup goes with it, from memory and disk.
    deps.channel.discardPending?.(agent.id);
    if (agent.runtimeRef) {
      try {
        await providerFor(agent.hostId).destroy(agent.runtimeRef, { purge: true });
      } catch (err) {
        // The runtime may still be alive (holding the bot token). Do NOT
        // release the bot or mark DELETED — that would orphan a poller. Park in
        // FAILED (a legal DELETING→FAILED move) so Delete stays retryable.
        store.setAgentState(agent.id, 'FAILED', 'Delete could not remove the runtime — tap Delete again.');
        deps.logError({ agentId: agent.id, err: String(err) }, 'destroy failed during delete');
        return { ok: false, status: 502, error: "Couldn't remove the agent's runtime — try Delete again in a moment." };
      }
    }
    // An adopt held on a torn copy ends here: the files it waited to put right
    // went with the volume (HB-0980). Only once the runtime is gone: a delete
    // that could not remove it leaves the hold, and Start still waits.
    { const held = holdDeleteEnds(store, agent.id); if (held) handleFor(store, held.id).fail('The agent was deleted while this waited for your choice; its half-copied files went with it.'); }
    // A management agent takes its jail with it: the doorman and the network.
    if (agent.ops) await providerFor(agent.hostId).removeOpsJail?.(agent.id).catch(() => {});
    // The runtime is gone; everything below is idempotent, so a retry after an
    // interrupted delete safely finishes the teardown.
    const channel = store.getChannelForAgent(agent.id);
    if (channel) {
      // A migrated-away agent's bot now belongs to the peer that received it.
      // Releasing it back into THIS pool would let a new local agent lease it
      // and fight the peer for the same token — release only when it stays ours.
      if (!agent.migratedTo) {
        // A PASTED bot's token is parked in the pool BY DEFAULT — bots are the
        // scarce resource (Telegram's per-account ceiling), and the Bot pool
        // tab is where a token gets discarded on purpose. ?recycleBot=0 opts
        // out. (Pool-leased bots already return via release() below.)
        // Best-effort END TO END: recycling is a bonus, so no failure in it —
        // not even a pool without the newer methods — may block the delete.
        // A copy was downloaded (or moved by file) while it stood stopped: the
        // bot may answer from there, so it is not parked for the next agent here
        // unless asked (?recycleBot=1). Parked, the next agent polled the same
        // bot as the copy (audit, 2026-10-23).
        // Nor freed, if it is a pool bot: freed, the next agent leased it and
        // polled it beside the copy (audit #099; leaveBotToCopy).
        if (copyElsewhere(agent) && query.recycleBot !== '1') {
          trace(agent.id)('bot.not_parked', { why: 'a copy was downloaded', exportedAt: agent.exportedAt });
          await leaveBotToCopy(deps.channel, channel.accountId, agent.id, (e, d) => trace(agent.id)(e, d));
        } else {
          if (query.recycleBot !== '0') {
            try {
              if (!deps.channel.pool.owns(channel.accountId)) {
                // Parked under the AGENT'S OWNER: their token, their pool slot —
                // never another user's next lease.
                const token = await secrets.get(channel.secretRef);
                await deps.channel.pool.addToPool(channel.accountId, token, agent.ownerId);
              }
            } catch (err) {
              deps.warn({ agentId: agent.id, err: String(err) }, 'bot recycle into pool failed');
            }
          }
          // Name the agent: a pasted bot parked just above has no lease, and
          // without it the pool recorded no prior chatters (who could then win
          // the next lease's owner claim) and sent no goodbye (night review).
          await deps.channel.release(channel.accountId, { reason: 'deleted', agentId: agent.id });
        }
      }
      // An imported agent's token lives under channel/<agentId>/bot-token,
      // which release() (keyed by username) never touches — scrub it here so
      // deletion doesn't leave a live credential in the store. A moved-away
      // agent's token, whatever its name, is the live one on the peer: it
      // does not stay here either.
      if (channel.secretRef.startsWith('channel/') || agent.migratedTo) {
        await secrets.delete(channel.secretRef).catch(() => {});
      }
      store.deleteChannelForAgent(agent.id);
    }
    // Slack's app belongs to the owner and its tokens must not outlive the
    // agent; a Discord bot is parked in the pool for the next agent (best
    // effort — a bot that cannot be parked is discarded, never left behind).
    // ?recycleBot=0 forgets only one the owner gave: one leased from the pool
    // goes back to it, as a Telegram pool bot does through release(), and a
    // house bot to the house (HB-1419 review: it was thrown away). One leased
    // before the pool marked it (fromPool) is taken for one the owner gave.
    for (const other of store.listChannelsForAgent(agent.id)) {
      const told = await dmChannelPeople(agent, other.kind, other.secretRef, `👋 ${agent.name} has been deleted by its owner. This bot no longer answers for it.`);
      if (told) trace(agent.id)('channel.farewell', { kind: other.kind, told });
      const st = (other.settings ?? {}) as Record<string, unknown>;
      if (query.recycleBot !== '0' || st.pooledShared === true || st.fromPool === true) {
        try { await parkDiscordBot({ store, secrets }, agent.ownerId, other); continue; }
        catch (err) { deps.warn({ agentId: agent.id, err: String(err) }, 'discord bot park failed'); }
      }
      await secrets.delete(other.secretRef).catch(() => {});
    }
    store.deleteChannelForAgent(agent.id, 'all');
    // Scrub the agent's other stored secrets so a tombstone leaves no live
    // credentials: data-source deploy keys and env-var values (both keyed by
    // the source/var id, so release() never touches them).
    // A failure keeps the rows that name them: the scrub below would erase
    // the last record of a live credential, so the delete parks in FAILED
    // (retryable, like a runtime that would not go) instead of DELETED.
    // Anything still missed is caught by the boot sweep (sweepOrphanAgentSecrets).
    const refs = [
      ...store.listDataSources(agent.id).map((d) => d.secretRef),
      ...store.dataSourceRemovals(agent.id).map((r) => r.secretRef), // a removed source's key not yet scrubbed
      ...store.listAgentEnv(agent.id).map((e) => e.secretRef),
      `agent-call-token/${agent.id}`,
    ].filter((r): r is string => !!r);
    const kept: string[] = [];
    for (const ref of refs) {
      try { await secrets.delete(ref); } catch { kept.push(ref); }
    }
    if (kept.length) {
      store.setAgentState(agent.id, 'FAILED', 'Delete could not remove all of its stored keys — tap Delete again.');
      deps.logError({ agentId: agent.id, kept: kept.length }, 'secret delete failed during delete');
      return { ok: false, status: 502, error: "Couldn't remove all of the agent's stored keys — try Delete again in a moment." };
    }
    store.deleteSnapshotsFor(agent.id);
    store.deleteEventsFor(agent.id);
    // Kill any outstanding invite links: redeeming one after deletion would
    // mint a membership against a tombstone with no bot to talk to.
    store.expireInvitesFor(agent.id);
    // The tombstone keeps only the agent row (slug bookkeeping): drop gateway
    // credentials and the child rows — memberships carry Telegram user IDs
    // (PII), source/env/seed rows would dangle (their secrets were scrubbed
    // above). Pre-fix tombstones are cleaned by the same scrub in #migrate.
    // An app still waiting to go in, with any secret values it was given.
    await dropAppPending(store, secrets, agent.id);
    store.scrubAgentResidue(agent.id);
    forgetFilesReplacing(agent.id);
    deps.forgetSettings(agent.id);
    deps.forgetConversations(agent.id);
    return { ok: true, value: answer(store.setAgentState(agent.id, 'DELETED')) };
  };

  return {
    create,
    isArchiving: (agentId) => archiving.has(agentId),
    archivingNow: (agentId) => archiving.get(agentId),
    progressOf,
    archive,
    restore,
    isDeleting: (agentId) => deletesRunning.has(agentId),
    whileDeleting,
    remove,
  };
}
