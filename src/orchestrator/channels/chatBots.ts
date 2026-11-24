import type { CompositeTelegramProvisioner } from '../../channels/composite.js';
import type { ChannelConnector, ConnectorKind } from '../../channels/connector.js';
import { discordConnector } from '../../channels/discord.js';
import { slackConnector } from '../../channels/slack.js';
import type { Agent, Channel } from '../../domain/types.js';
import { CHANNEL_ACCOUNT } from '../../openclaw/configWriter.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import type { DiscordBotRow } from './discordPool.js';
import { announceToMembers } from '../members/members.js';
import { stopAndConfirm } from '../lifecycle/quiesce.js';
import type { Store } from '../../store/store.js';

/**
 * The chat bots (HB-0808): the Telegram,
 * Discord and Slack bots an agent answers on, as the routes and the rest of
 * the process use them. The Slack and Discord connectors; a bot's name, put
 * on it now or retried later; the messages its people get from this machine
 * (farewells, moving notes, the reused-bot marker); a parked bot taken from
 * the spare pool; an agent stopped before its bot is handed on; and every bot
 * this server holds a token for.
 *
 * Its state, sorted (HB-0809):
 *  - `botNameCache`: a cache (a Telegram bot's display name, ten minutes).
 *  - `channelRechecks`: an in-process lock (one re-check of an agent's
 *    channels at a time); gone after a restart, with the request it held.
 *  - the name retry timer: a chat app's new bot name still owed is kept in
 *    the channel's settings (`pendingName`), so a restart loses nothing; the
 *    timer only asks again every ten minutes. `stop()` ends it.
 *
 * Nothing here knows about HTTP: a route reads its request, asks this, and
 * words the answer.
 */
export interface ChatBots {
  /** The Slack or Discord connector; undefined for Telegram or an unknown kind. */
  connectorFor(kind: string): ChannelConnector | undefined;
  /** Every connector, Slack then Discord: what each one asks for draws the set-up sheet. */
  connectorList(): ChannelConnector[];
  /** Messaging plugins in the image this agent (re)builds on. */
  imageChannelsFor(agent: Agent): Promise<string[]>;
  /** Whom a recycled pool bot just wrote to; never the owner's first knock. */
  priorChatIdsOf(username: string): string[];
  /** Point a Slack/Discord bot's name at the agent's; a refusal for an hour's quota is kept and retried. */
  renameChannelBot(agent: Agent, chan: Channel, name: string): Promise<{ ok: boolean; name: string; error?: string }>;
  /** Each Slack/Discord bot name still owed whose retry time has come, put on now. */
  retryPendingChannelNames(): Promise<void>;
  /** One DM per person linked on a Slack/Discord channel (or to `ids`), from this machine; how many went. */
  dmChannelPeople(agent: Agent, kind: Channel['kind'], secretRef: string, text: string, ids?: string[]): Promise<number>;
  /** A parked Discord bot this caller may take: the one named, or the first of theirs / the house's. */
  parkedBotToTake(me: string, pooled: string, kind?: 'discord' | 'slack'): DiscordBotRow | undefined;
  /** Stop a running agent before its Discord/Slack bot goes back to the pool. False = it would not stop. Stopped, its rebuild is owed (owedAfterHandover). */
  stopForBotHandover(agent: Agent): Promise<boolean>;
  /** An agent just stopped so its bot can be handed on: its rebuild is owed on its record from here, before the bot goes anywhere. */
  owedAfterHandover(agentId: string): void;
  /** The Telegram bot's live display name (getMe first_name), cached ten minutes per agent and bot. */
  botDisplayNameFor(agentId: string, secretRef: string): Promise<string | undefined>;
  /** A display name just read from Telegram for the bot whose token is at `secretRef`, kept as the cached one. */
  rememberBotName(agentId: string, value: string | undefined, secretRef: string): void;
  /** A rename or a sync makes the cached name stale. */
  forgetBotName(agentId: string): void;
  /** One re-check of an agent's channels at a time: false when one is under way. `endRecheck` lets go. */
  startRecheck(agentId: string): boolean;
  endRecheck(agentId: string): void;
  /** Every bot this server holds a token for, username → where its secret is. */
  botSecretRefs(): Map<string, BotSecret>;
  /** End the name retry timer: at shutdown. */
  stop(): void;
}

/** Where one bot's token is: an agent's channel, the pool (leased or free), or an orphaned secret. */
export type BotSecret = { secretRef: string; where: string; agentName?: string; agentState?: string; ownerId?: string | null };

/** What the chat bots need from the process they run in. Functions only, so a test hands them fakes. */
export interface ChatBotsDeps {
  store: Store;
  /** The stored tokens (only read here). */
  secrets: Pick<SecretStore, 'get'>;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline: `trace(agent.id)` gives the function that takes the event and its detail. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** Telegram's provisioner: its pool is asked whom a recycled bot wrote to, and which bots it holds. */
  channel: Pick<CompositeTelegramProvisioner, 'pool'>;
  /** Slack and Discord connectors to use instead of the real ones (tests inject fakes that never touch the network). */
  connectors?: Partial<Record<ConnectorKind, ChannelConnector>>;
  /**
   * Keep a rebuild owed on this agent's record, so its next start is one
   * (the setup and rebuild queue's oweRebuild, which belongs to its own
   * feature; this is all the service sees of it).
   */
  oweRebuild: (agentId: string) => void;
  /** How often to retry the bot names still owed; 0 = never (tests). */
  nameRetryMs: number;
  /** Telegram's Bot API, as the routes hand it in (the global fetch without one; a test's stand-in with one). */
  telegramFetch?: typeof fetch;
}

export function createChatBots(deps: ChatBotsDeps): ChatBots {
  const { store, secrets, providerFor, trace } = deps;
  // ---- the Slack and Discord connectors ----------------------------------
  const connectors: Record<ConnectorKind, ChannelConnector> = {
    slack: deps.connectors?.slack ?? slackConnector(),
    discord: deps.connectors?.discord ?? discordConnector(),
  };
  const connectorFor = (kind: string): ChannelConnector | undefined =>
    kind === 'slack' || kind === 'discord' ? connectors[kind] : undefined;
  /** Messaging plugins in the image this agent (re)builds on. */
  const imageChannelsFor = async (agent: Agent): Promise<string[]> => {
    try { return (await providerFor(agent.hostId).currentImageInfo(agent.image ?? undefined)).channels ?? []; }
    catch { return []; }
  };

  /** Whom a recycled pool bot just wrote to; never the owner's first knock. */
  const priorChatIdsOf = (username: string): string[] =>
    (deps.channel.pool as { priorChatIds?: (u: string) => string[] }).priorChatIds?.(username) ?? [];

  /**
   * Point a Slack/Discord bot's name at the agent's (Telegram has its own
   * path: setTelegramDisplayName + the pool's retry sweep). Best effort; the
   * outcome goes to the Setup log, the card's name follows, and the members
   * on that channel are told — a label changing under them is the confusing
   * part.
   */
  const renameChannelBot = async (agent: Agent, chan: Channel, name: string): Promise<{ ok: boolean; name: string; error?: string }> => {
    const conn = connectorFor(chan.kind);
    if (!conn?.rename) return { ok: false, name, error: `${chan.kind} bots cannot be renamed from here.` };
    let secret: string;
    try { secret = await secrets.get(chan.secretRef); } catch { return { ok: false, name, error: 'The stored token is missing.' }; }
    const res = await conn.rename(secret, name);
    trace(agent.id)('channel.renamed', { kind: chan.kind, name: res.name ?? name, ok: res.ok, ...(res.note ? { note: res.note } : {}) });
    // The name fields go onto the row as it is NOW: the settings read before
    // the platform answered, written back whole, undid a rooms change the
    // owner made meanwhile (members back over off), and a bot swapped in
    // meanwhile got the old bot's name (HB-0890).
    const now = store.getChannelForAgent(agent.id, chan.kind);
    if (!now || now.accountId !== chan.accountId || now.secretRef !== chan.secretRef) {
      return { ok: false, name, error: 'Its bot changed while it was being renamed. Sync the name again.' };
    }
    if (res.ok) {
      const st = (now.settings ?? {}) as Record<string, unknown>;
      const servers = Array.isArray(st.servers) ? (st.servers as Array<{ name?: string; id: string }>) : [];
      const shown = res.name ?? name;
      store.setChannelSettings(agent.id, chan.kind, {
        ...st, botName: shown,
        displayName: chan.kind === 'discord' && servers.length ? `@${shown} in ${servers.map((g) => g.name || g.id).join(', ')}` : `@${shown}`,
      });
      if (agent.runtimeRef && agent.state === 'RUNNING') {
        void announceToMembers(
          { store, provider: providerFor(agent.hostId), log: trace(agent.id) },
          { agentId: agent.id, runtimeRef: agent.runtimeRef, accountId: CHANNEL_ACCOUNT, kind: chan.kind, text: `🏷 This bot is now named “${shown}”. Same agent, same chat — only the name changed.` },
        ).catch(() => 0);
      }
    }
    if (!res.ok && /name changes an hour/.test(res.note ?? '')) {
      // Discord's quota: remembered, and the sweep below applies it later —
      // the same promise a Telegram pool bot's pending rename carries.
      store.setChannelSettings(agent.id, chan.kind, { ...(now.settings ?? {}), pendingName: { name, retryAt: new Date(Date.now() + 40 * 60_000).toISOString() } });
    } else if ((now.settings as Record<string, unknown> | undefined)?.pendingName && (res.ok || !/network|timed? ?out|unreachable|busy|\b5\d\d\b|reach/i.test(res.note ?? ''))) {
      // Done, or refused for good (a reset token, a refused name): either way
      // no longer pending — it was retried every ten minutes for ever (night review).
      const st = { ...(store.getChannelForAgent(agent.id, chan.kind)?.settings ?? {}) } as Record<string, unknown>;
      delete st.pendingName; store.setChannelSettings(agent.id, chan.kind, st);
    }
    return res.ok ? { ok: true, name: res.name ?? name } : { ok: false, name, error: res.note, ...(/name changes an hour/.test(res.note ?? '') ? { retryAt: new Date(Date.now() + 40 * 60_000).toISOString() } : {}) };
  };
  const retryPendingChannelNames = async (): Promise<void> => {
    for (const agent of store.listAllActiveAgents()) {
      for (const ch of store.listChannelsForAgent(agent.id)) {
        const p = (ch.settings as Record<string, unknown> | undefined)?.pendingName as { name?: string; retryAt?: string } | undefined;
        if (!p?.name || !p.retryAt || Date.parse(p.retryAt) > Date.now() || ch.kind === 'telegram') continue;
        await renameChannelBot(agent, ch, agent.name).catch(() => undefined);
      }
    }
  };
  // A chat app's new bot name still owed, every 10 minutes.
  const nameRetry = deps.nameRetryMs > 0
    ? setInterval(() => { void retryPendingChannelNames().catch(() => {}); }, deps.nameRetryMs).unref()
    : undefined;

  /**
   * One DM per person linked on a Slack/Discord channel, from this machine
   * (the agent may be stopped or gone). Farewells, moving notes, the reused-bot
   * marker — what Telegram members get through the Bot API.
   */
  const dmChannelPeople = async (agent: Agent, kind: Channel['kind'], secretRef: string, text: string, ids?: string[]): Promise<number> => {
    const conn = connectorFor(kind);
    if (!conn?.dm) return 0;
    const targets = ids ?? store.listMemberships(agent.id).filter((m) => m.status === 'active')
      .map((m) => store.memberIdentities(agent.id, m.userId)[kind]).filter((id): id is string => !!id);
    if (!targets.length) return 0;
    let secret: string;
    try { secret = await secrets.get(secretRef); } catch { return 0; }
    const results = await Promise.all(targets.map((id) => conn.dm!(secret, id, text).catch(() => false)));
    return results.filter(Boolean).length;
  };
  /** A parked Discord bot this caller may take: the one named, or the first of theirs / the house's. */
  const parkedBotToTake = (me: string, pooled: string, kind: 'discord' | 'slack' = 'discord'): DiscordBotRow | undefined => {
    if (pooled === 'first') return store.listDiscordBots(me, kind).find((b) => !b.archivedFor); // a bot kept for an archived agent is not offered
    const b = store.getDiscordBot(pooled);
    return b && (b.kind ?? 'discord') === kind && (b.ownerId === null || b.ownerId === me) ? b : undefined;
  };

  /**
   * A container stopped so its bot can be handed on owes a rebuild from that
   * moment, on its record (HB-0830): it still holds the token of a bot that
   * is about to go back to the pool. The rebuild the handover asks for
   * afterwards (the routes' rebuildOrOwe) was all that said so, and it is
   * asked for only once the bot is gone and the calls after it have
   * answered: a restart in between left a stopped agent whose Start ran the
   * old container, on a bot another agent could lease. Owed first
   * (rebuildOnStart), its next start is a rebuild whatever happens to this
   * process; the rebuild that makes its new container clears it
   * (provision.ts recordApplied). Called by stopForBotHandover, below, and by
   * Telegram's detach, which stops the agent itself (channelRoutes.ts).
   */
  const owedAfterHandover = (agentId: string): void => { deps.oweRebuild(agentId); };
  /**
   * Stop a running agent before its Discord/Slack bot goes back to the pool:
   * until its rebuild, the container still holds the token, and a spare taken
   * by another agent in that window answered on two gateways (night review,
   * 2026-09-27). Telegram's detach does the same. False = it would not stop,
   * so the bot must not be parked. The caller's rebuild starts it again.
   */
  const stopForBotHandover = async (agent: Agent): Promise<boolean> => {
    const now = store.getAgent(agent.id);
    if (!now?.runtimeRef) return true;
    try {
      await stopAndConfirm(providerFor(now.hostId), now.runtimeRef);
      if (now.state === 'RUNNING') store.setAgentState(now.id, 'STOPPED');
      owedAfterHandover(now.id);
      return true;
    } catch (err) {
      trace(agent.id)('channel.stop_failed', { error: String(err).slice(0, 200) });
      return false;
    }
  };

  // The bot's live Telegram DISPLAY name (getMe first_name), so the card's
  // Sync-name button can grey out when it already matches. Names change
  // rarely: cache 10 min per agent, invalidate on a successful sync/rename.
  // Each entry is for one bot (the token it was read with): after Change
  // bot, the card named the new @handle with the old bot's name for ten
  // minutes (HB-1044).
  const botNameCache = new Map<string, { fetchedAt: number; value?: string; secretRef: string }>();
  const botDisplayNameFor = async (agentId: string, secretRef: string): Promise<string | undefined> => {
    const cached = botNameCache.get(agentId);
    const hit = cached?.secretRef === secretRef ? cached : undefined;
    if (hit && Date.now() - hit.fetchedAt < 10 * 60_000) return hit.value;
    let value: string | undefined;
    try {
      const token = await secrets.get(secretRef);
      const res = await (deps.telegramFetch ?? fetch)(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(4000) });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { first_name?: string } };
      if (body.ok) value = body.result?.first_name;
    } catch {
      /* offline / rate-limited — omit rather than fail or churn the cache */
      return hit?.value;
    }
    botNameCache.set(agentId, { fetchedAt: Date.now(), value, secretRef });
    return value;
  };

  /** One re-check per agent at a time (CodeQL js/missing-rate-limiting #74, 2026-10-24). */
  const channelRechecks = new Set<string>();

  /**
   * Every bot this server holds a token for, username → where its secret is:
   * agents' channels first, then pool rows, then any telegram/bot/* secret
   * nothing references (an orphaned token). One lookup for the inventory and
   * for revealing a single token, so they can never disagree about what exists.
   */
  const botSecretRefs = (): Map<string, { secretRef: string; where: string; agentName?: string; agentState?: string; ownerId?: string | null }> => {
    const rows = new Map<string, { secretRef: string; where: string; agentName?: string; agentState?: string; ownerId?: string | null }>();
    for (const a of store.listAllActiveAgents()) {
      const ch = store.getChannelForAgent(a.id);
      if (ch) rows.set(ch.accountId.toLowerCase(), { secretRef: ch.secretRef, where: 'agent', agentName: a.name, agentState: a.state, ownerId: a.ownerId });
    }
    for (const p of deps.channel.pool.list?.() ?? []) {
      const u = p.username.toLowerCase();
      if (!rows.has(u)) rows.set(u, { secretRef: p.secretRef, where: p.leasedTo ? 'pool-leased' : 'pool-free', ownerId: p.ownerId ?? null });
    }
    for (const ref of store.listSecretRefs('telegram/bot/%')) {
      const u = ref.split('/')[2]!.toLowerCase();
      if (!rows.has(u)) rows.set(u, { secretRef: ref, where: 'orphan-token' });
    }
    return rows;
  };

  return {
    connectorFor, connectorList: () => Object.values(connectors), imageChannelsFor, priorChatIdsOf,
    renameChannelBot, retryPendingChannelNames, dmChannelPeople, parkedBotToTake, stopForBotHandover, owedAfterHandover,
    botDisplayNameFor,
    rememberBotName: (agentId, value, secretRef) => { botNameCache.set(agentId, { fetchedAt: Date.now(), value, secretRef }); },
    forgetBotName: (agentId) => { botNameCache.delete(agentId); },
    startRecheck: (agentId) => {
      if (channelRechecks.has(agentId)) return false;
      channelRechecks.add(agentId);
      return true;
    },
    endRecheck: (agentId) => { channelRechecks.delete(agentId); },
    botSecretRefs,
    stop: () => { if (nameRetry) clearInterval(nameRetry); },
  };
}
