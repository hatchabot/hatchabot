import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { ChannelSetupRequired } from '../channels/channel.js';
import { ConnectorError, type ConnectorKind } from '../channels/connector.js';
import { slackManifest } from '../channels/slack.js';
import { InvalidBotTokenError, verifyBotToken } from '../channels/telegramManual.js';
import { setTelegramDisplayName } from '../channels/telegramName.js';
import { filesMb } from '../domain/filesLimit.js';
import type { Agent, Channel } from '../domain/types.js';
import { CHANNEL_ACCOUNT } from '../openclaw/configWriter.js';
import { auditBots, type HostBots } from '../orchestrator/channels/bots.js';
import { AgentBusyError, busyDone, clearBusy, isBusy, markBusy, whileBusy } from '../orchestrator/lifecycle/busy.js';
import { pairingKind } from '../orchestrator/channels/knocks.js';
import { claimFirstContact, isKnockWindow } from '../orchestrator/members/claim.js';
import { parkDiscordBot, poolRef, publicDiscordBot, type DiscordBotRow } from '../orchestrator/channels/discordPool.js';
import { admitMember, AdmitError, allowlistScrubScript, announceToMembers, denyPairing, scrubChannelAllowlist, writeDmPolicy } from '../orchestrator/members/members.js';
import { rethrowIfCrash } from '../orchestrator/lifecycle/operations.js';
import { stopAndConfirm } from '../orchestrator/lifecycle/quiesce.js';
import { ChannelTakenError, normalizeHandle } from '../store/store.js';
import { pinnedPeerFetch } from '../util/peerAddress.js';
import { sixAtATime } from '../util/queues.js';
import { noteFailure, throttled } from './auth.js';
import { ownerIdOf } from './principal.js';
import { AGENT_GONE, MACHINE_OWNER_ONLY, OPS_ALONE, TOKEN_CHECK_THROTTLED, zodMessage, type RouteContext } from './routeContext.js';

/**
 * POST /v1/discord-bots and /v1/slack-apps (HB-0814): the app's fields, each
 * read as text as before, and whether it is a house bot.
 */
const ParkBot = z.object({ shared: z.boolean().optional() }).catchall(z.unknown());

/**
 * POST /v1/agents/:id/channels/:kind (HB-0814): the app's fields, or
 * `pooled` (a parked bot's id, or 'first'). A field that is not text is left
 * out, which the connector words as missing, as before.
 */
const ConnectApp = z.record(z.string(), z.unknown());

/** POST /v1/agents/:id/pairing/approve (HB-0814): the request's code, its channel, and "That's me". */
const ApprovePairing = z.object({
  code: z.string().optional(),
  kind: z.string().optional(),
  asSelf: z.boolean().optional(),
});

/** POST /v1/agents/:id/pairing/deny (HB-0814): the request's code and its channel. */
const DenyPairing = z.object({
  code: z.string().optional(),
  kind: z.string().optional(),
});

/**
 * Telegram's own "no" to a bot's getMe: ok:false with 401 or 404, the rule a
 * pasted token is checked by (verifyBotToken). Anything else that is not a
 * bot (a rate limit, a 5xx, an outage page) says nothing of the token: the
 * bot was not checked (the agent's Re-check HB-1038, the pool's HB-1260),
 * and the bot inventory's verdict is unknown, not dead (HB-1261).
 */
const telegramRefusedToken = (status: number, body: { ok?: boolean } | null | undefined): boolean =>
  body?.ok === false && (status === 401 || status === 404);
/** The words for a getMe that did not answer properly. */
const telegramUnanswered = (status: number): string =>
  `Telegram did not answer properly just now (${status === 429 ? 'too many requests' : `HTTP ${status}`}), so the bot was not checked. Try again in a minute.`;

/**
 * Telegram, Discord and Slack: the routes (HB-0808).
 *
 * An agent's bots (Telegram's, and a Slack or Discord app), the spare pools
 * they come from and go back to, the bot census and token reveals, the
 * account's own chat identities, and pairing: who is knocking, approve and
 * deny, and whether anyone may knock. Each route reads its request and
 * words the answer; the rules and their state are the channels service's
 * (`ctx.channels`, src/orchestrator/channels/): `bots` (chatBots.ts) and
 * `knocks` (knocks.ts).
 *
 * Invites, the join page, members and web chat stay in routes.ts for now
 * (their own step of HB-0808); they reach the door through
 * `ctx.channels.knocks` too.
 */
export function registerChannelRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { deps, store, secrets, trace, providerFor, ownedAgent, ownsLocalHost, agentGone, isArchiving } = ctx;
  const { operationRefuses, busyNow, kickRebuild, rebuildOrOwe } = ctx;
  const {
    connectorFor, connectorList, imageChannelsFor, priorChatIdsOf, renameChannelBot, dmChannelPeople,
    parkedBotToTake, stopForBotHandover, owedAfterHandover, botDisplayNameFor, rememberBotName, forgetBotName,
    startRecheck, endRecheck, botSecretRefs,
  } = ctx.channels.bots;
  const { kindForCode, cachedKnocks, forgetKnocks, restDoor } = ctx.channels.knocks;

  // ---- Telegram's spare bots (telegramPool.ts) -------------------------------
  app.get('/v1/pool', async (req) => {
    // Names only of agents this caller may see: a shared house bot held by
    // another account's agent is "in use", not that agent's name (HB-0036).
    const seen = ownsLocalHost(req) ? undefined : new Set(store.listVisibleAgents(ownerIdOf(req)).map((a) => a.id));
    return {
      // Per-user: YOUR bots plus shared house bots — what a create by this
      // user could actually lease. Tokens are personally owned (their minter
      // can revoke them at BotFather), so one user's parked bot is never
      // another user's next lease.
      availableBots: deps.channel.pool.availableCount(ownerIdOf(req), store.ownerPrefs(ownerIdOf(req)).ownBotsOnly),
      // The roster: the machine owner sees every bot; everyone else their own
      // and the shared house bots — the same rule the Discord pool has.
      ...{
            bots: deps.channel.pool
              .list()
              .filter((b) => ownsLocalHost(req) || !b.ownerId || b.ownerId === ownerIdOf(req))
              .map((b) => ({
                username: b.username,
                leasedTo: b.leasedTo,
                // Which agent wears this bot right now — names beat ids in
                // a roster meant for humans.
                leasedToName: b.leasedTo && (!seen || seen.has(b.leasedTo)) ? store.getAgent(b.leasedTo)?.name : undefined,
                ownerId: ownsLocalHost(req) ? b.ownerId : undefined, // undefined = shared house bot
                shared: !b.ownerId,
                mine: b.ownerId === ownerIdOf(req),
              })),
          },
    };
  });

  // Stock the pool from the app: verify the token against Telegram, then store
  // it. Refuses a bot that is currently some agent's live identity.
  app.post<{ Body: { token?: string; shared?: boolean } }>('/v1/pool', async (req, reply) => {
    // Any account may park a bot IT minted: the row is scoped to them below,
    // and availableCount() is per-owner. Donating one to the whole house
    // (`shared`) is the machine owner's call, since everyone leases from it.
    if (req.body?.shared && !ownsLocalHost(req)) {
      return reply.code(403).send({ error: 'Only the account that set up this machine can donate a bot to the shared pool. Leave it unshared and it stays yours.' });
    }
    const parsed = z
      .object({ token: z.string().min(1).max(256), shared: z.boolean().optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Paste a bot token from @BotFather.' });
    const body = parsed.data;
    const token = body.token.trim();
    if (!token) return reply.code(400).send({ error: 'Paste a bot token from @BotFather.' });
    // The login throttle, on token checks too: a pasted token is checked with
    // the platform, and a bad one counts like a wrong password (2026-09-25).
    if (throttled(req, ownerIdOf(req))) return reply.code(429).send({ error: TOKEN_CHECK_THROTTLED });
    let username: string;
    try {
      username = await verifyBotToken(token);
    } catch (err) {
      // Telegram not answering is no strike against the person: 503, try again.
      if (!(err instanceof InvalidBotTokenError)) throw err;
      noteFailure(req, ownerIdOf(req));
      return reply.code(400).send({ error: err.userMessage });
    }
    const using = store.findAgentUsingAccount(username);
    if (using) {
      return reply.code(409).send({
        error: `@${username} is the live identity of agent "${using.name}" — it can't also sit in the pool.`,
      });
    }
    // Yours by default — a token belongs to whoever minted it. `shared: true`
    // explicitly donates it as a house bot anyone here can lease.
    await deps.channel.pool.addToPool(username, token, body?.shared ? null : ownerIdOf(req));
    return reply
      .code(201)
      .send({ username, availableBots: deps.channel.pool.availableCount(ownerIdOf(req), store.ownerPrefs(ownerIdOf(req)).ownBotsOnly) });
  });

  app.delete<{ Params: { username: string } }>('/v1/pool/:username', async (req, reply) => {
    const row = deps.channel.pool.list().find((b) => b.username === req.params.username);
    if (!row) return reply.code(404).send({ error: 'No such bot in the pool.' });
    // Your own, or the machine owner's. A house bot (no owner) is the latter.
    if (row.ownerId !== ownerIdOf(req) && !ownsLocalHost(req)) {
      return reply.code(403).send({ error: `@${req.params.username} was parked by someone else — only they or the account that set up this machine can remove it.` });
    }
    try {
      await deps.channel.pool.removeFromPool(req.params.username);
    } catch (err) {
      return reply.code(409).send({ error: String(err instanceof Error ? err.message : err) });
    }
    return { removed: true, availableBots: deps.channel.pool.availableCount(ownerIdOf(req), store.ownerPrefs(ownerIdOf(req)).ownBotsOnly) };
  });

  /** Ask Telegram about a parked bot: does the token still work, and what is the bot called now. */
  app.post<{ Params: { username: string } }>('/v1/pool/:username/recheck', async (req, reply) => {
    const row = deps.channel.pool.list().find((b) => b.username.toLowerCase() === req.params.username.toLowerCase());
    if (!row || (row.ownerId && row.ownerId !== ownerIdOf(req) && !ownsLocalHost(req))) return reply.code(404).send({ error: 'No such bot in the pool.' });
    let token: string;
    try { token = await secrets.get(row.secretRef); } catch { return reply.code(409).send({ error: 'The stored token is missing — delete it from the pool and add it again.' }); }
    let status: number;
    let body: { ok?: boolean; result?: { username?: string; first_name?: string; can_join_groups?: boolean } };
    try {
      const res = await (deps.oauthFetch ?? fetch)(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(6000) });
      status = res.status;
      body = (await res.json().catch(() => ({}))) as typeof body;
    } catch {
      return reply.code(502).send({ error: "Couldn't reach Telegram — try again." });
    }
    // A body of JSON null is no answer either, not a 500 (HB-1260 review).
    if (!body?.ok || !body.result) {
      // Only Telegram's own "no" is a dead token: a rate limit or an outage
      // told the owner to delete a healthy spare (HB-1260).
      if (telegramRefusedToken(status, body)) return { username: row.username, alive: false, warnings: ['Telegram refused this token: the bot was deleted or its token reset at BotFather. Delete it here.'] };
      return reply.code(502).send({ error: telegramUnanswered(status) });
    }
    return { username: row.username, alive: true, botName: body.result.first_name, warnings: body.result.can_join_groups ? [] : ['Groups are off at BotFather (/setjoingroups).'], checkedAt: new Date().toISOString() };
  });

  // A Telegram-bot census: this install's bots (and, with ?consolidated=1, each
  // registered peer's) so the owner can spot idle slots. ?live=1 adds a Telegram
  // getMe/poll check per bot — slower, and it touches the network.
  app.get<{ Querystring: { live?: string; consolidated?: string } }>('/v1/bots', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const ownerId = ownerIdOf(req);
    const live = req.query.live === '1' || req.query.live === 'true';
    const hostName = store.listHosts(ownerId).find((h) => h.kind === 'local')?.name ?? 'this server';
    const local = await auditBots({ store, secrets, pool: deps.channel.pool, hostName }, ownerId, { live });
    const hosts: HostBots[] = [local];

    if (req.query.consolidated === '1' || req.query.consolidated === 'true') {
      for (const peer of store.listPeers(ownerId)) {
        try {
          const token = await secrets.get(peer.secretRef);
          // NOT consolidated — the peer returns only its own install, so a ring
          // of peers can't recurse or double-count. Pinned and redirect-refusing,
          // like every call to a peer (pinnedPeerFetch).
          const res = await (deps.peerFetch ?? pinnedPeerFetch)(`${peer.url.replace(/\/$/, '')}/v1/bots?live=${live ? 1 : 0}`, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) {
            hosts.push({ host: peer.name, bots: [], error: `answered ${res.status}` });
            continue;
          }
          const body = (await res.json()) as { hosts?: HostBots[] };
          const peerLocal = body.hosts?.[0];
          hosts.push(peerLocal ? { ...peerLocal, host: peer.name } : { host: peer.name, bots: [], error: 'no data' });
        } catch (err) {
          hosts.push({ host: peer.name, bots: [], error: `unreachable (${String((err as Error)?.message ?? err).slice(0, 60)})` });
        }
      }
    }
    return { hosts };
  });

  // ---- an agent's Telegram bot ---------------------------------------------
  // Telegram is optional. Add a bot to a web-only agent (from the pool, or a
  // pasted BotFather token), or take one away (the bot goes back to the pool,
  // members get a goodbye). Either way the agent rebuilds with the new config;
  // its memory is untouched.
  app.post<{ Params: { id: string }; Body: { token?: string } }>('/v1/agents/:id/telegram', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    if (store.getChannelForAgent(agent.id)) return reply.code(409).send({ error: 'It already has a Telegram bot.' });
    if (!agent.runtimeRef || (agent.state !== 'RUNNING' && agent.state !== 'STOPPED')) {
      return reply.code(409).send({ error: `Wait until it is running (it is ${agent.state.toLowerCase()}).` });
    }
    if (operationRefuses(agent, reply)) return reply;
    if (isBusy(agent.id)) return reply.code(409).send({ error: 'It is busy with another change — try again in a moment.' });
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (token) {
      if (throttled(req, ownerIdOf(req))) return reply.code(429).send({ error: TOKEN_CHECK_THROTTLED });
      // Every check before the token is held: one refused here is never
      // written to disk (telegram/pending/<id>), where it outlived the refusal.
      let username: string;
      try { username = await verifyBotToken(token); }
      catch (err) {
        if (err instanceof InvalidBotTokenError) { noteFailure(req, ownerIdOf(req)); return reply.code(400).send({ error: err.userMessage }); }
        throw err;
      }
      const inUseBy = store.findAgentUsingAccount(username);
      if (inUseBy && inUseBy.id !== agent.id) {
        return reply.code(400).send({ error: `That bot is already connected to "${inUseBy.name}". Each agent needs its own bot — create another with @BotFather.` });
      }
      // A spare bot's token pasted by hand went down the manual path and
      // left the pool row unleased; the next lease of that bot then failed
      // the agent it went to (2026-09-25). The pool is the way to it.
      if (deps.channel.pool.owns(username)) {
        return reply.code(400).send({ error: `@${username} is a spare bot in the pool. Leave the token box empty and the agent takes a spare — or remove it from the pool first.` });
      }
      // A store that refused it left it held in memory, where the next
      // attach took it unasked: let go, from memory and disk, before the 500.
      try { await deps.channel.submitToken(agent.id, token, username); }
      catch (err) { await deps.channel.discardPending?.(agent.id); throw err; }
    } else {
      // From the pool: a token held from an earlier setup (one that failed,
      // or was answered as the agent got another bot) is not wanted now, and
      // held, it would win over the pool (composite.ts).
      deps.channel.discardPending?.(agent.id);
    }
    let result;
    try {
      // The owner's "own bots only" holds here as at creation and in the ready count (HB-0994).
      result = await deps.channel.provision({
        agentId: agent.id, agentName: agent.name, slug: agent.slug, ownerId: agent.ownerId, skipPool: token ? true : undefined,
        ownBotsOnly: store.ownerPrefs(agent.ownerId).ownBotsOnly,
      });
    } catch (err) {
      if (err instanceof ChannelSetupRequired) {
        return reply.code(409).send({ needsToken: true, error: 'No spare bots in the pool. Create one with @BotFather and paste its token.' });
      }
      // Not taken: held, it would outlive this answer, and win over the pool
      // at the next setup (composite.ts). Gone from memory and disk first.
      await deps.channel.discardPending?.(agent.id);
      throw err;
    }
    const clash = store.findAgentUsingAccount(result.accountId);
    if (clash && clash.id !== agent.id) {
      // The lease stays: the bot is live on the other agent, and releasing it
      // queued the idle name onto that agent's bot (regression review).
      return reply.code(409).send({ error: `@${result.accountId} already belongs to "${clash.name}".` });
    }
    // The bot found, not connected after all, with no farewell: it never
    // served this agent. The agent gone meanwhile (`park`), it goes back the
    // way a detach sends it, a pasted one parked in the pool first. Refused
    // as busy, a pasted one stays its owner's: only this machine's copy of
    // its token goes, so pasting it again works. Parked, it was a spare that
    // the token box then refused, and the sweep renamed the owner's own bot
    // "unassigned" (HB-1131 review). A pool bot's lease is undone, not
    // released: a release took this agent's people for the bot's earlier
    // chats (returnUnused).
    const giveBack = async (found: typeof result, park: boolean) => {
      const pool = (deps.channel as { pool?: { owns(u: string): boolean; addToPool(u: string, t: string, o?: string | null): Promise<void>; returnUnused?(u: string, agentId: string): void } }).pool;
      if (park && pool && !pool.owns(found.accountId)) {
        try { await pool.addToPool(found.accountId, await secrets.get(found.secretRef), agent.ownerId); }
        catch (err) { trace(agent.id)('channel.recycle_failed', { error: String(err).slice(0, 200) }); }
      }
      if (pool?.returnUnused && pool.owns(found.accountId)) pool.returnUnused(found.accountId, agent.id);
      else await deps.channel.release(found.accountId, { reason: 'swapped', agentId: agent.id }).catch(() => {});
      if (found.secretRef.startsWith('channel/')) await secrets.delete(found.secretRef).catch(() => {});
    };
    // Under the agent's lock, as the Discord/Slack attach is: two attaches at
    // once (a double-click) both passed the checks above, and the second's
    // insert threw ChannelTakenError as a 500 (audit, 2026-10-23).
    let attached: 'ok' | 'has-one' | 'taken' | 'gone';
    try {
      attached = await whileBusy(agent.id, async () => {
        // Deleted, archived or rebuilding while the bot was found: a row and a
        // token saved now sat on a tombstone (HB-0296). The bot goes back.
        const now = store.getAgent(agent.id);
        if (!now?.runtimeRef || (now.state !== 'RUNNING' && now.state !== 'STOPPED')) {
          await giveBack(result, true);
          return 'gone' as const;
        }
        if (store.getChannelForAgent(agent.id)) return 'has-one' as const;
        try {
          store.insertChannel({
            id: randomUUID(), agentId: agent.id, kind: deps.channel.kind, accountId: result.accountId,
            secretRef: result.secretRef, deepLink: result.deepLink, createdAt: new Date().toISOString(),
          });
        } catch (err) {
          if (err instanceof ChannelTakenError) return 'taken' as const;
          throw err;
        }
        return 'ok' as const;
      });
    } catch (err) {
      if (err instanceof AgentBusyError) {
        // Another change took the agent while its bot was found: the lease
        // was kept, the spare count stayed one short, and the pool called the
        // bot this agent's with no channel to show for it (HB-1131). It goes
        // back, unless it is connected here after all (a second attach of
        // this agent got it in first).
        if (!store.findAgentUsingAccount(result.accountId)) await giveBack(result, false);
        return reply.code(409).send({ error: err.userMessage });
      }
      throw err;
    }
    if (attached === 'gone') return reply.code(409).send({ error: `It changed while its bot was being found (it is ${(store.getAgent(agent.id)?.state ?? 'deleted').toLowerCase()}); the bot was not connected.` });
    if (attached === 'has-one') return reply.code(409).send({ error: 'It already has a Telegram bot.' });
    if (attached === 'taken') return reply.code(409).send({ error: `@${result.accountId} was just connected to another agent. Each agent needs its own bot.` });
    store.setAgentWebOnly(agent.id, false);
    await deps.channel.syncDisplayName?.(result.accountId, agent.name).catch(() => {});

    // Pair once, not once per agent. A NEW agent is born knowing the owner's
    // Telegram (createAgentRecord seeds it); a bot added later to an existing
    // one skipped that, so the owner's first message hit a pairing code and a
    // "That's me / Let them in" card — on their own Hatchabot agent (a Mac,
    // 2026-09-21). Seed it here too, before the rebuild writes the allowlist.
    const known = store.knownChannelUserId(agent.ownerId);
    const seat = store.getMembership(agent.id, agent.ownerId);
    if (known && seat && !seat.channelUserId) store.bindMembershipChannelUser(agent.id, agent.ownerId, known);
    const ownerKnown = !!store.getMembership(agent.id, agent.ownerId)?.channelUserId;

    trace(agent.id)('channel.attached', { accountId: result.accountId, ownerKnown });
    const applied = rebuildOrOwe(store.getAgent(agent.id) ?? agent);
    // Nobody to seed — the owner has never used Telegram here. Watch for their
    // first message the way a brand-new agent does, rather than leaving it to a
    // card. (claimFirstContact waits out the rebuild that is starting now.)
    if (!ownerKnown && agent.runtimeRef) {
      void claimFirstContact(
        { store, provider: providerFor(agent.hostId), providerFor, log: trace(agent.id) },
        { agentId: agent.id, runtimeRef: agent.runtimeRef, accountId: result.accountId, forUserId: agent.ownerId, timeoutMs: 30 * 60_000, excludeIds: priorChatIdsOf(result.accountId) },
      ).catch((err) => app.log.error({ err, agentId: agent.id }, 'owner claim after attach failed'));
    }
    return reply.code(202).send({ username: result.accountId, deepLink: result.deepLink, ownerKnown, ...(applied === 'next-start' ? { atNextStart: true } : {}) });
  });

  app.delete<{ Params: { id: string } }>('/v1/agents/:id/telegram', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const row = store.getChannelForAgent(agent.id);
    if (!row) return reply.code(404).send({ error: 'It has no Telegram bot.' });
    if (!agent.runtimeRef || (agent.state !== 'RUNNING' && agent.state !== 'STOPPED')) {
      return reply.code(409).send({ error: `Wait until it is running (it is ${agent.state.toLowerCase()}).` });
    }
    const BUSY = 'It is busy with another change — try again in a moment.';
    if (operationRefuses(agent, reply)) return reply;
    if (isBusy(agent.id) || isArchiving(agent.id)) return reply.code(409).send({ error: BUSY });
    // Same order as archive: stop polling BEFORE the token goes back to the
    // pool, or the next agent to lease it would fight this one for messages.
    // Under the lifecycle lock: a Start arriving between the stop and the
    // release brought the container back up on a token going back to the
    // pool (#10).
    const provider = providerFor(agent.hostId);
    let refused: string | undefined;
    try {
      refused = await whileBusy(agent.id, async () => {
        const now = store.getAgent(agent.id);
        if (!now?.runtimeRef || (now.state !== 'RUNNING' && now.state !== 'STOPPED') || now.hostId !== agent.hostId) return BUSY;
        if (store.getChannelForAgent(agent.id)?.accountId !== row.accountId) return BUSY;
        // Whatever the record says: a STOPPED row whose container still ran
        // (state drift) kept polling a token the pool then leased out (HB-0273).
        try { await stopAndConfirm(provider, now.runtimeRef); }
        catch (err) {
          rethrowIfCrash(err);
          trace(agent.id)('channel.stop_failed', { error: String(err).slice(0, 200) });
          return 'It did not stop, so its bot stays with it for now. Try again when its machine answers.';
        }
        if (now.state === 'RUNNING') store.setAgentState(agent.id, 'STOPPED');
        // Its rebuild is owed from here, before its bot goes anywhere (chatBots.ts owedAfterHandover, HB-0830).
        owedAfterHandover(agent.id);
        const pool = (deps.channel as { pool?: { owns(u: string): boolean; addToPool(u: string, t: string, o?: string | null): Promise<void> } }).pool;
        if (pool && !pool.owns(row.accountId)) {
          try { await pool.addToPool(row.accountId, await secrets.get(row.secretRef), agent.ownerId); }
          catch (err) { trace(agent.id)('channel.recycle_failed', { error: String(err).slice(0, 200) }); }
        }
        await deps.channel.release(row.accountId, { reason: 'detached', agentId: agent.id });
        if (row.secretRef.startsWith('channel/')) await secrets.delete(row.secretRef).catch(() => {});
        store.deleteChannelForAgent(agent.id);
        forgetBotName(agent.id);
        store.expireInvitesFor(agent.id, 'agent-detached');
        store.setAgentPendingAction(agent.id, null);
        store.setAgentWebOnly(agent.id, true);
        trace(agent.id)('channel.detached', { accountId: row.accountId });
        return undefined;
      });
    } catch (err) {
      if (err instanceof AgentBusyError) return reply.code(409).send({ error: BUSY });
      throw err;
    }
    if (refused) return reply.code(409).send({ error: refused });
    await scrubChannelAllowlist(
      { store, provider, log: trace(agent.id) },
      { agentId: agent.id, runtimeRef: agent.runtimeRef, kind: 'telegram', accountId: row.accountId },
    ).catch(() => false);
    // `agent` as it was before the stop above: stopped by its owner, it stays so.
    const applied = rebuildOrOwe(agent, { handover: true });
    return reply.code(202).send({ released: row.accountId, ...(applied === 'next-start' ? { atNextStart: true } : {}) });
  });

  // ---- Slack and Discord (docs/channels-slack-discord-design.md) ----------
  // Set up by pasting credentials from an app the owner made. Adding is
  // app-only (it carries secrets); each change rebuilds the agent, memory kept.
  const ROOM_ID: Record<ConnectorKind, RegExp> = { slack: /^[CG][A-Z0-9]{8,}$/, discord: /^\d{17,20}$/ };
  /** A queued bot name as the card reads it (`name`, `retryAt`), or undefined. */
  const queuedName = (v: unknown): { name: string; retryAt?: string } | undefined => {
    const p = v as { name?: unknown; retryAt?: unknown } | undefined;
    return p && typeof p.name === 'string' && p.name ? { name: p.name, ...(typeof p.retryAt === 'string' ? { retryAt: p.retryAt } : {}) } : undefined;
  };
  /** What a reused Discord bot or Slack app tells the people it served before: the seam, in their DMs. */
  const reassignedNote = (agentName: string) =>
    `— this bot is now “${agentName}” —\n\nIt has been reassigned to a different agent. Anything above this line was a previous agent and no longer applies.`;
  const publicChannel = (c: Channel) => {
    const st = (c.settings ?? {}) as Record<string, unknown>;
    return {
      kind: c.kind,
      accountId: c.accountId,
      deepLink: c.deepLink,
      displayName: typeof st.displayName === 'string' ? st.displayName : undefined,
      addToServerUrl: typeof st.addToServerUrl === 'string' ? st.addToServerUrl : undefined,
      warnings: Array.isArray(st.warnings) ? st.warnings : [],
      rooms: (st.rooms as unknown) ?? { mode: 'off' },
      /** Discord: the servers the bot is in (id + name), from the last check; Slack: the workspace. */
      servers: Array.isArray(st.servers) ? (st.servers as Array<{ id: string; name: string }>).filter((g) => g && typeof g.id === 'string').map((g) => ({ id: g.id, name: String(g.name ?? '') })) : [],
      botName: typeof st.botName === 'string' ? st.botName : undefined,
      team: typeof st.team === 'string' ? st.team : undefined,
      checkedAt: typeof st.checkedAt === 'string' ? st.checkedAt : undefined,
      createdAt: c.createdAt,
      /** A new bot name the platform has not taken yet, and when it is tried again: the card's "Rename queued" (HB-1040). */
      pendingName: queuedName(st.pendingName),
      /** The biggest file it sends on this app now, in MB: the machine's setting, the agent's own, the app's limit. */
      filesMb: c.kind === 'telegram' || c.kind === 'discord' || c.kind === 'slack' ? filesMb(c.kind, store.getAgent(c.agentId)?.filesMaxMb) : undefined,
    };
  };
  /**
   * A Telegram bot in the same shape as a Slack/Discord one, so the app draws
   * every channel from one card: the bot's display name (cached getMe), the
   * group setting as `rooms`, what the last check found, and whether the pool
   * owns it (a swap is offered for a pool bot).
   */
  const publicTelegramChannel = async (agent: Agent, c: Channel) => {
    const st = (c.settings ?? {}) as Record<string, unknown>;
    const botName = (await botDisplayNameFor(agent.id, c.secretRef).catch(() => undefined)) ?? (typeof st.botName === 'string' ? st.botName : undefined);
    const ga = agent.groupAccess ?? { mode: 'members' as const };
    return {
      kind: 'telegram' as const,
      accountId: c.accountId,
      deepLink: c.deepLink,
      displayName: botName ? `${botName} (@${c.accountId})` : `@${c.accountId}`,
      botName,
      warnings: Array.isArray(st.warnings) ? st.warnings : [],
      rooms: ga.mode === 'room' ? { mode: 'room', roomId: ga.roomId } : { mode: ga.mode },
      checkedAt: typeof st.checkedAt === 'string' ? st.checkedAt : undefined,
      pooled: deps.channel.pool.owns?.(c.accountId) ?? false,
      richMessages: agent.richMessages !== false,
      createdAt: c.createdAt,
      /** As on the other cards: the card said Telegram's 50 MB whatever the agent's cap (HB-1036). */
      filesMb: filesMb('telegram', agent.filesMaxMb),
      /** A pool bot's new name Telegram has not taken yet, from the pool (HB-1040). */
      pendingName: queuedName((deps.channel.pool as { pendingName?: (u: string) => unknown }).pendingName?.(c.accountId)),
    };
  };
  /** The people linked to an agent on one channel kind: who the agent answers there. */
  const peopleOn = (agent: Agent, kind: Channel['kind']) =>
    store.listMemberships(agent.id).filter((m) => m.status === 'active').flatMap((m) => {
      const id = kind === 'telegram' ? m.channelUserId : store.memberIdentities(agent.id, m.userId)[kind];
      return id ? [{ userId: m.userId, role: m.role, displayName: m.displayName, you: m.userId === agent.ownerId }] : [];
    });

  /** What each connector asks for, so the set-up sheet is drawn from one source. */
  app.get('/v1/channels/connectors', async () =>
    connectorList().map((c) => ({
      kind: c.kind, label: c.label,
      fields: c.fields.map((f) => ({ key: f.key, label: f.label, pattern: f.pattern.source, help: f.help })),
    })));

  // ---- spare Discord bots (discordPool.ts) ----------------------------------
  /**
   * The spare-bot pool, per app: Discord bots and Slack apps park here with
   * their tokens, name and rooms, and an agent's Set up… (or `pooled`) takes
   * one. One view: the spares this viewer may take, and the bots agents wear
   * right now — the machine owner sees everyone's, others their own and the
   * shared ones (Telegram's roster rule).
   */
  const poolView = (req: FastifyRequest, kind: 'discord' | 'slack') => {
    const me = ownerIdOf(req);
    const rows = ownsLocalHost(req) ? store.listAllDiscordBots(kind) : store.listDiscordBots(me, kind);
    const inUse = store.listAllActiveAgents()
      .filter((a) => ownsLocalHost(req) || a.ownerId === me)
      .flatMap((a) => {
        const ch = store.getChannelForAgent(a.id, kind);
        if (!ch) return [];
        const st = (ch.settings ?? {}) as Record<string, unknown>;
        return [{
          applicationId: ch.accountId, botName: typeof st.botName === 'string' ? st.botName : undefined,
          servers: Array.isArray(st.servers) ? (st.servers as Array<{ id: string; name: string }>) : [],
          team: typeof st.team === 'string' ? st.team : undefined,
          agentId: a.id, agentName: a.name, mine: a.ownerId === me, shared: st.pooledShared === true,
        }];
      });
    return { kind, bots: rows.map((b) => publicDiscordBot(b, me)), inUse, availableBots: store.listDiscordBots(me, kind).filter((b) => !b.archivedFor).length };
  };
  const parkedBotFor = (req: FastifyRequest, id: string, kind: 'discord' | 'slack', reply: FastifyReply): DiscordBotRow | undefined => {
    const b = store.getDiscordBot(id);
    const me = ownerIdOf(req);
    if (!b || (b.kind ?? 'discord') !== kind || (b.ownerId !== null && b.ownerId !== me && !ownsLocalHost(req))) { void reply.code(404).send({ error: 'No such parked bot.' }); return undefined; }
    return b;
  };
  /** Park a bot by its token(s): checked with the platform, stored under the pool, never returned. */
  const poolPark = (kind: 'discord' | 'slack') => async (req: FastifyRequest<{ Body: Record<string, unknown> }>, reply: FastifyReply) => {
    const conn = connectorFor(kind);
    if (!conn) return reply.code(404).send({ error: `${kind} is not available.` });
    const sent = ParkBot.safeParse(req.body ?? {});
    if (!sent.success) return reply.code(400).send({ error: zodMessage(sent.error) });
    const body: Record<string, string> = {};
    for (const f of conn.fields) body[f.key] = String(sent.data[f.key] ?? '');
    const shared = sent.data.shared === true;
    if (shared && !ownsLocalHost(req)) return reply.code(403).send({ error: 'Only the machine owner can share a bot with everyone.' });
    if (throttled(req, ownerIdOf(req))) return reply.code(429).send({ error: TOKEN_CHECK_THROTTLED });
    let verified;
    try { verified = await conn.verify(body); }
    catch (err) {
      if (!(err instanceof ConnectorError)) throw err;
      // A busy platform (429/5xx) is not a refused token, as on attach: ten
      // of them used up the allowance, and the good token after was a 429 (HB-0993).
      if (!err.busy) noteFailure(req, ownerIdOf(req));
      return reply.code(400).send({ error: err.userMessage });
    }
    const using = store.findAgentUsingAccount(verified.accountId, kind);
    if (using) return reply.code(409).send({ error: `That bot is connected to ${using.ownerId === ownerIdOf(req) ? `"${using.name}"` : 'another agent'}. Remove it there first — it parks itself here.` });
    if (store.getDiscordBot(verified.accountId)) return reply.code(409).send({ error: 'That bot is already parked.' });
    const st = verified.settings as Record<string, unknown>;
    const ref = poolRef(kind, verified.accountId);
    await secrets.put(ref, conn.secretValue(body));
    const row: DiscordBotRow = {
      applicationId: verified.accountId, botUserId: typeof st.botUserId === 'string' ? st.botUserId : undefined, botName: typeof st.botName === 'string' ? st.botName : undefined,
      secretRef: ref, ownerId: shared ? null : ownerIdOf(req),
      servers: Array.isArray(st.servers) ? (st.servers as DiscordBotRow['servers']) : [], warnings: verified.warnings,
      addToServerUrl: verified.addToServerUrl, checkedAt: new Date().toISOString(), addedAt: new Date().toISOString(), kind,
    };
    store.upsertDiscordBot(row);
    return { bot: publicDiscordBot(row, ownerIdOf(req)), ...poolView(req, kind) };
  };
  /** Ask the platform again about a parked bot (rooms it joined, warnings cleared). */
  const poolRecheck = (kind: 'discord' | 'slack') => async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const b = parkedBotFor(req, req.params.id, kind, reply); if (!b) return reply;
    const conn = connectorFor(kind)!;
    let secret: string;
    try { secret = await secrets.get(b.secretRef); } catch { return reply.code(409).send({ error: 'That parked bot has lost its token — delete it and park it again.' }); }
    let verified;
    try { verified = await conn.verify(conn.credsFromSecret(secret)); }
    catch (err) { if (err instanceof ConnectorError) return reply.code(400).send({ error: err.userMessage }); throw err; }
    // Judged against the row as it is NOW: removed, or taken by an agent,
    // while the platform was asked, the old snapshot written back brought it
    // back as a spare (pointing at a deleted token, or in use) (HB-0987).
    const cur = store.getDiscordBot(b.applicationId);
    if (!cur || cur.secretRef !== b.secretRef || cur.addedAt !== b.addedAt || (cur.kind ?? 'discord') !== kind
      || store.findAgentUsingAccount(b.applicationId, kind)) {
      return reply.code(409).send({ error: 'That parked bot changed meanwhile (removed, or taken by an agent) — look again.' });
    }
    const st = verified.settings as Record<string, unknown>;
    const next: DiscordBotRow = { ...cur, botName: typeof st.botName === 'string' ? st.botName : cur.botName, servers: Array.isArray(st.servers) ? (st.servers as DiscordBotRow['servers']) : cur.servers, warnings: verified.warnings, addToServerUrl: verified.addToServerUrl ?? cur.addToServerUrl, checkedAt: new Date().toISOString() };
    store.upsertDiscordBot(next);
    return { bot: publicDiscordBot(next, ownerIdOf(req)) };
  };
  /** Forget a parked bot: the stored token is discarded; the bot itself lives on at the platform. A shared bot is the machine owner's to delete. */
  const poolRemove = (kind: 'discord' | 'slack') => async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const b = parkedBotFor(req, req.params.id, kind, reply); if (!b) return reply;
    if (b.ownerId === null && !ownsLocalHost(req)) return reply.code(403).send({ error: 'A shared bot is the machine owner\'s to delete.' });
    await secrets.delete(b.secretRef).catch(() => {});
    store.deleteDiscordBot(b.applicationId);
    return { deleted: b.applicationId, ...poolView(req, kind) };
  };
  // Literal paths: the management-chat coverage ledger is checked against them.
  app.get('/v1/discord-bots', async (req) => poolView(req, 'discord'));
  app.post<{ Body: Record<string, unknown> }>('/v1/discord-bots', poolPark('discord'));
  app.post<{ Params: { id: string } }>('/v1/discord-bots/:id/recheck', poolRecheck('discord'));
  app.delete<{ Params: { id: string } }>('/v1/discord-bots/:id', poolRemove('discord'));
  app.get('/v1/slack-apps', async (req) => poolView(req, 'slack'));
  app.post<{ Body: Record<string, unknown> }>('/v1/slack-apps', poolPark('slack'));
  app.post<{ Params: { id: string } }>('/v1/slack-apps/:id/recheck', poolRecheck('slack'));
  app.delete<{ Params: { id: string } }>('/v1/slack-apps/:id', poolRemove('slack'));

  app.get<{ Querystring: { name?: string } }>('/v1/channels/slack/manifest', async (req) =>
    slackManifest(String(req.query?.name ?? '').slice(0, 80)));

  app.get<{ Params: { id: string } }>('/v1/agents/:id/channels', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const supported = await imageChannelsFor(agent);
    const mine = store.memberIdentities(agent.id, agent.ownerId);
    return {
      channels: await Promise.all(store.listChannelsForAgent(agent.id).map(async (c) => ({
        ...(c.kind === 'telegram' ? await publicTelegramChannel(agent, c) : publicChannel(c)),
        /** Has the owner's first message on this channel linked them yet? */
        youAreLinked: !!mine[c.kind],
        /** Who it answers on this channel (members linked there). */
        people: peopleOn(agent, c.kind),
      }))),
      imageSupports: ['telegram', ...supported],
      /** The agent-wide door, shown on every card: applies to every app. */
      allowKnocks: !!agent.allowKnocks,
      /** Spare bots ready for a swap, per app. */
      spare: { telegram: deps.channel.pool.availableCount?.(agent.ownerId, store.ownerPrefs(agent.ownerId).ownBotsOnly) ?? 0, discord: store.listDiscordBots(agent.ownerId, 'discord').filter((b) => !b.archivedFor).length, slack: store.listDiscordBots(agent.ownerId, 'slack').filter((b) => !b.archivedFor).length },
    };
  });

  app.post<{ Params: { id: string; kind: string }; Body: Record<string, string> }>('/v1/agents/:id/channels/:kind', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const conn = connectorFor(req.params.kind);
    if (!conn) return reply.code(404).send({ error: 'Unknown channel.' });
    const kind = conn.kind;
    // The manager may have Discord (its pushes and its chat); Slack's websocket is not routed through its jail yet.
    if (agent.ops && kind !== 'discord') return reply.code(409).send({ error: `${conn.label} is not available for the Hatchabot agent yet.` });
    if (store.getChannelForAgent(agent.id, kind)) return reply.code(409).send({ error: `It already has ${conn.label}. Remove it first to connect a different app.` });
    if (!agent.runtimeRef || (agent.state !== 'RUNNING' && agent.state !== 'STOPPED')) {
      return reply.code(409).send({ error: `Wait until it is running (it is ${agent.state.toLowerCase()}).` });
    }
    if (operationRefuses(agent, reply)) return reply;
    if (isBusy(agent.id)) return reply.code(409).send({ error: 'It is busy with another change — try again in a moment.' });
    if (!(await imageChannelsFor(agent)).includes(kind)) {
      return reply.code(409).send({
        needsImage: true,
        error: `This agent's base image can't do ${conn.label} yet. Promote a base image that includes it (Settings → Base images), then try again.`,
      });
    }
    const sent = ConnectApp.safeParse(req.body ?? {});
    if (!sent.success) return reply.code(400).send({ error: zodMessage(sent.error) });
    let body: Record<string, string> = Object.fromEntries(Object.entries(sent.data).filter((e): e is [string, string] => typeof e[1] === 'string'));
    // A parked bot (Settings → Messaging → Discord): its token comes from the pool, nothing is pasted.
    let pooled: DiscordBotRow | undefined;
    if (typeof body.pooled === 'string' && body.pooled) {
      pooled = parkedBotToTake(ownerIdOf(req), body.pooled, kind);
      if (!pooled) return reply.code(404).send({ error: body.pooled === 'first' ? `No spare ${conn.label} bot is parked. Park one under ⚙ Settings → ${conn.label}, or paste a token.` : 'No such parked bot.' });
      try { body = conn.credsFromSecret(await secrets.get(pooled.secretRef)); }
      catch { return reply.code(409).send({ error: 'That parked bot has lost its token — delete it from the pool and park it again.' }); }
    }
    if (!pooled && throttled(req, ownerIdOf(req))) return reply.code(429).send({ error: TOKEN_CHECK_THROTTLED });
    let verified;
    let secretValue: string;
    try {
      verified = await conn.verify(body);
      secretValue = conn.secretValue(body);
    } catch (err) {
      if (err instanceof ConnectorError) {
        // A busy platform (429/5xx) is not a refused token (night review).
        if (!pooled && !err.busy) noteFailure(req, ownerIdOf(req));
        return reply.code(400).send({ error: err.userMessage });
      }
      throw err;
    }
    const clash = store.findAgentUsingAccount(verified.accountId, kind);
    if (clash && clash.id !== agent.id) {
      // The name only when it is the caller's own agent: a token in hand does
      // not buy another owner's agent names.
      const where = clash.ownerId === ownerIdOf(req) ? ` to "${clash.name}"` : ' to another agent on this machine';
      return reply.code(409).send({ error: `That ${conn.label} app is already connected${where}. Each agent needs its own app.` });
    }
    const secretRef = `channel/${agent.id}/${kind}`;
    // Written under the agent's busy flag, with "already has one" asked again
    // inside it: two attaches at once (a double-click; the app and the
    // manager) both passed the check above, and the loser deleted the
    // winner's token, which lives under the same key (night review).
    // The agent asked again too: deleted while the platform was asked, the
    // tombstone got a channel row and a stored token (HB-0568).
    let outcome: 'ok' | 'has-one' | 'taken' | 'gone' | 'not-ready' | 'spare-gone';
    try {
      outcome = await whileBusy(agent.id, async () => {
    if (agentGone(agent.id)) return 'gone' as const;
    const now = store.getAgent(agent.id);
    if (!now?.runtimeRef || (now.state !== 'RUNNING' && now.state !== 'STOPPED')) return 'not-ready' as const;
    if (store.getChannelForAgent(agent.id, kind)) return 'has-one' as const;
    // The spare judged as it is once the lock is held, as a swap's is: one
    // removed from the pool while the platform was asked was still connected
    // (HB-1154). One taken by another agent is the insert's ChannelTakenError.
    const spare = pooled && store.getDiscordBot(pooled.applicationId);
    if (pooled && (!spare || spare.secretRef !== pooled.secretRef || (spare.kind ?? 'discord') !== kind)) return 'spare-gone' as const;
    await secrets.put(secretRef, secretValue);
    try {
      store.insertChannel({
        id: randomUUID(), agentId: agent.id, kind, accountId: verified.accountId, secretRef,
        deepLink: verified.deepLink, createdAt: new Date().toISOString(),
        settings: {
          ...verified.settings,
          displayName: verified.displayName,
          // No list from the platform just now is "unknown", not "none": a
          // spare's last known rooms come with it, as on a swap (HB-0998, HB-1154).
          ...(spare && (verified.settings as Record<string, unknown>).servers === undefined ? { servers: spare.servers } : {}),
          ...(verified.addToServerUrl ? { addToServerUrl: verified.addToServerUrl } : {}),
          warnings: verified.warnings,
          rooms: { mode: 'off' },
          // Remembered so a house bot goes back to the house when removed,
          // and a spare goes back to the pool even on a delete that forgets
          // the agent's bots (?recycleBot=0; HB-1419 review).
          ...(pooled && pooled.ownerId === null ? { pooledShared: true } : {}),
          ...(pooled ? { fromPool: true } : {}),
        },
      });
    } catch (err) {
      if (err instanceof ChannelTakenError) {
        // Another AGENT took this app meanwhile. The key is this agent's own
        // (and the flag keeps its other attaches out), so this deletes nobody's.
        await secrets.delete(secretRef).catch(() => {});
        return 'taken' as const;
      }
      throw err;
    }
    return 'ok' as const;
      });
    } catch (err) {
      if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
      throw err;
    }
    if (outcome === 'gone') return reply.code(409).send({ error: AGENT_GONE });
    if (outcome === 'not-ready') return reply.code(409).send({ error: `It changed while ${conn.label} was checked (it is ${String(store.getAgent(agent.id)?.state ?? 'gone').toLowerCase()}): try again once it is running.` });
    if (outcome === 'has-one') return reply.code(409).send({ error: `It already has ${conn.label}. Remove it first to connect a different app.` });
    if (outcome === 'taken') return reply.code(409).send({ error: `That ${conn.label} app was just connected to another agent. Each agent needs its own app.` });
    if (outcome === 'spare-gone') return reply.code(409).send({ error: 'That spare bot left the pool meanwhile — pick another one.' });
    if (pooled) {
      store.deleteDiscordBot(pooled.applicationId);
      if (pooled.secretRef !== secretRef) await secrets.delete(pooled.secretRef).catch(() => {});
    } else {
      // A pasted bot that was also parked as a spare: its pool row goes, or
      // "take a spare" and Change bot kept picking it and failing (night review).
      const parked = store.getDiscordBot(verified.accountId);
      if (parked && (parked.kind ?? 'discord') === kind) {
        store.deleteDiscordBot(parked.applicationId);
        if (parked.secretRef !== secretRef) await secrets.delete(parked.secretRef).catch(() => {});
      }
    }
    // The owner's identity on this channel: known from any agent they are on,
    // it is bound here now and the rebuild admits it — no first message to
    // wait for. Not known, the owner's own first DM shows up as a knock they
    // approve with "That's me": a Discord bot is visible to a whole server,
    // so "the first person to write wins the owner's seat" is no rule for it
    // (2026-09-25). Telegram keeps its claim window: a new bot's username is
    // known to its owner alone.
    let ownerKnown = !!store.memberIdentities(agent.id, agent.ownerId)[kind];
    if (!ownerKnown) {
      const elsewhere = store.identityOfUserAnywhere(agent.ownerId, kind);
      if (elsewhere) ownerKnown = store.bindMemberIdentity(agent.id, agent.ownerId, kind, elsewhere);
    }
    trace(agent.id)('channel.attached', { kind, accountId: verified.accountId, fromPool: !!pooled, ownerKnown });
    // A pool bot is ours, serving one agent after another: named for the
    // agent it now serves, like a Telegram pool bot on lease. A bot the owner
    // pasted keeps its name until they press Sync name (or rename the agent).
    if (pooled && conn.rename) await renameChannelBot(agent, store.getChannelForAgent(agent.id, kind)!, agent.name);
    // A reused bot may still sit in someone's DMs with the previous agent's
    // conversation above: mark the seam for them (Telegram's rule).
    if (pooled?.priorChatIds?.length) {
      const told = await dmChannelPeople(agent, kind, secretRef, reassignedNote(agent.name), pooled.priorChatIds);
      trace(agent.id)('channel.reassigned_marked', { kind, told });
    }
    // A sleeper is the exception: nothing wakes it for Discord or Slack (nothing
    // queues their messages), so asleep it could never answer there. It comes
    // up now, as the connect dialog says. Stopped by its owner, it stays so.
    const nowAgent = store.getAgent(agent.id) ?? agent;
    const applied = nowAgent.hibernatedAt ? (kickRebuild(agent.id) ? 'rebuilding' : 'not-started') : rebuildOrOwe(nowAgent);
    return reply.code(202).send({ ...publicChannel(store.getChannelForAgent(agent.id, kind)!), ...(applied === 'next-start' ? { atNextStart: true } : {}) });
  });

  /**
   * Move an agent onto a spare Discord bot in one step — Telegram's "Swap
   * bot", for the pool of parked Discord bots. The people linked there stay
   * linked (same Discord ids); the old bot is parked with its name and
   * servers; the new one is named for the agent; the chat is told where to
   * find it next.
   */
  app.post<{ Params: { id: string; kind: string }; Body: { pooled?: string } }>('/v1/agents/:id/channels/:kind/swap', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
    if (busyNow(agent, reply)) return reply;
    if (agent.state !== 'RUNNING' && agent.state !== 'STOPPED') return reply.code(409).send({ error: `It is ${agent.state.toLowerCase()} — wait for it to settle first.` });
    const conn = connectorFor(req.params.kind);
    if (!conn) return reply.code(404).send({ error: 'Unknown channel.' });
    const kind = conn.kind;
    const old = store.getChannelForAgent(agent.id, kind);
    if (!old) return reply.code(409).send({ error: `This agent has no ${conn.label} bot to change.` });
    const me = ownerIdOf(req);
    const wanted = parkedBotToTake(me, typeof req.body?.pooled === 'string' && req.body.pooled ? req.body.pooled : 'first', kind);
    if (!wanted) {
      return reply.code(409).send({ error: `No spare bot to move to. Park one under ⚙ Settings → Messaging, then try again.` });
    }
    let token: string;
    try { token = await secrets.get(wanted.secretRef); } catch { return reply.code(409).send({ error: 'That parked bot has lost its token — delete it from the pool and park it again.' }); }
    let verified;
    try { verified = await conn.verify(conn.credsFromSecret(token)); }
    catch (err) { if (err instanceof ConnectorError) return reply.code(400).send({ error: `The spare bot: ${err.userMessage}` }); throw err; }
    const clash = store.findAgentUsingAccount(verified.accountId, kind);
    if (clash) return reply.code(409).send({ error: 'That bot is already connected to an agent.' });
    // The stop first (HB-0997), then the new row (one transaction; a spare
    // taken meanwhile is a 409 and nothing has moved), then the goodbye, then
    // the old bot is parked. The old order parked the bot before the insert,
    // so a lost race left the agent with no row and its bot already gone
    // (30th audit). Busy for the whole of it: a second swap or a rebuild waits.
    const newName = String((verified.settings as Record<string, unknown>).botName ?? 'its new bot');
    // The new bot's token under a key of its own: the old bot's token sits under
    // `channel/<agent>/<kind>` (or an earlier swap's key), and writing the new one
    // there overwrote it — the old bot was parked holding the NEW token and its
    // secret then deleted, cutting the agent off both (use-case audit, 2026-09-27).
    const secretRef = `channel/${agent.id}/${kind}/${verified.accountId}`;
    let told = 0;
    /** Whom the spare wrote to for the agent it served before (read once the lock is held). */
    let priorChats: string[] = [];
    let parked = false;
    let stopped = false;
    let swapped: 'ok' | 'taken' | 'changed' | 'spare-gone' | 'not-stopped';
    try {
      swapped = await whileBusy(agent.id, async () => {
        // Judged again once the lock is held: a swap that finished while this
        // one's spare was being checked had moved the agent to another bot,
        // and this one, carrying on from the bot it saw first, replaced that
        // newer bot and never parked it (HB-0988).
        const now = store.getAgent(agent.id);
        const nowRow = store.getChannelForAgent(agent.id, kind);
        if (!now?.runtimeRef || (now.state !== 'RUNNING' && now.state !== 'STOPPED')
          || !nowRow || nowRow.id !== old.id || nowRow.accountId !== old.accountId || nowRow.secretRef !== old.secretRef) return 'changed' as const;
        const spare = store.getDiscordBot(wanted.applicationId);
        if (!spare || spare.secretRef !== wanted.secretRef) return 'spare-gone' as const;
        priorChats = spare.priorChatIds ?? [];
        if (store.findAgentUsingAccount(verified.accountId, kind)) return 'taken' as const;
        // The new bot's token first, under its own key, which nothing reads
        // until the row names it: a store that refuses it refuses the swap
        // before anything has stopped.
        await secrets.put(secretRef, token);
        const dropNew = async () => { if (secretRef !== old.secretRef) await secrets.delete(secretRef).catch(() => {}); };
        // Stopped, and confirmed, BEFORE anything is committed, as the
        // Telegram swap does. A stop that could not be confirmed still
        // replaced the row, deleted the old bot's token and used up the
        // spare, and answered swapped: true while the old container could
        // still be answering on the old bot (HB-0997). Not stopped: nothing
        // has moved, the old bot stays and the spare stays parked.
        if (!(await stopForBotHandover(agent))) { await dropNew(); return 'not-stopped' as const; }
        stopped = true;
        try {
          store.replaceChannelRow(agent.id, kind, {
            id: randomUUID(), agentId: agent.id, kind, accountId: verified.accountId, secretRef,
            deepLink: verified.deepLink, createdAt: new Date().toISOString(),
            settings: {
              ...verified.settings, displayName: verified.displayName,
              // No list from the platform just now is "unknown", not "none"
              // (discord.ts): the spare's last known rooms come with it, or
              // "every server it is in" closed them all at the rebuild (HB-0998).
              ...((verified.settings as Record<string, unknown>).servers === undefined ? { servers: spare.servers } : {}),
              ...(verified.addToServerUrl ? { addToServerUrl: verified.addToServerUrl } : {}),
              warnings: verified.warnings, rooms: (old.settings?.rooms as unknown) ?? { mode: 'off' },
              ...(wanted.ownerId === null ? { pooledShared: true } : {}),
              fromPool: true,
            },
          });
        } catch (err) {
          await dropNew();
          if (err instanceof ChannelTakenError) return 'taken' as const;
          throw err;
        }
        told = await dmChannelPeople(agent, kind, old.secretRef, `📮 ${agent.name} is moving to the bot “${newName}”. Message that one from now on — this chat will stop answering. Everything it knows comes with it.`);
        try { await parkDiscordBot({ store, secrets }, agent.ownerId, old); parked = true; }
        catch (err) { trace(agent.id)('channel.park_failed', { kind, error: String(err).slice(0, 200) }); if (old.secretRef !== secretRef) await secrets.delete(old.secretRef).catch(() => {}); }
        store.deleteDiscordBot(wanted.applicationId);
        if (wanted.secretRef !== secretRef) await secrets.delete(wanted.secretRef).catch(() => {});
        return 'ok' as const;
      });
    } catch (err) {
      // Another change holds it (a rebuild the other swap started): refused, not a 500.
      if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
      // Anything that failed once it had stopped (the store refusing the
      // row, say): it is not left down. It comes back up as the swap would
      // have brought it, on the bot its row names now.
      if (stopped) rebuildOrOwe(agent, { handover: true });
      throw err;
    }
    if (swapped === 'changed') return reply.code(409).send({ error: `Its ${conn.label} bot changed meanwhile — look again, then try again.` });
    if (swapped === 'spare-gone') return reply.code(409).send({ error: 'That spare bot left the pool meanwhile — pick another one.' });
    if (swapped === 'not-stopped') return reply.code(409).send({ error: `It would not stop, so it stays on its ${conn.label} bot and the spare stays parked. Try again when its machine answers.` });
    if (swapped === 'taken') {
      // Taken by another agent while this one stopped: it stays on its old
      // bot, and comes back up the way the swap would have brought it.
      if (stopped) rebuildOrOwe(agent, { handover: true });
      return reply.code(409).send({ error: 'That spare bot was just taken by another agent — pick another one.' });
    }
    trace(agent.id)('channel.swapped', { kind, from: old.accountId, to: verified.accountId, told, parked });
    const fresh = store.getChannelForAgent(agent.id, kind)!;
    if (conn.rename) await renameChannelBot(agent, fresh, agent.name);
    // The spare may still sit in someone's DMs with the agent it served
    // before: the seam is marked for them, as when an agent takes a spare.
    // The swap told only the old bot's people, and the spare's list went
    // with its pool row (HB-1049).
    if (priorChats.length) {
      const marked = await dmChannelPeople(agent, kind, fresh.secretRef, reassignedNote(agent.name), priorChats);
      trace(agent.id)('channel.reassigned_marked', { kind, told: marked });
    }
    const applied = rebuildOrOwe(agent, { handover: true });
    return { swapped: true, from: old.accountId, to: verified.accountId, told, parked, rebuilding: applied === 'rebuilding', ...(applied === 'next-start' ? { atNextStart: true } : {}), channel: publicChannel(store.getChannelForAgent(agent.id, kind)!) };
  });

  /**
   * Ask the platform again about a connected channel, from the stored token:
   * Discord's server list and its "not in any server yet" / "intent is off"
   * warnings were frozen at connect time, so the card kept nagging after the
   * owner had fixed exactly that. No token is pasted, none is returned.
   */
  app.post<{ Params: { id: string; kind: string } }>('/v1/agents/:id/channels/:kind/recheck', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    // One re-check per agent at a time: each is an outbound call to the platform with the stored token,
    // and nothing else bounded how often (CodeQL js/missing-rate-limiting #74, 2026-10-24).
    if (!startRecheck(agent.id)) return reply.code(409).send({ error: 'This agent is being re-checked already — wait for it.' });
    try {
    return await (async () => {
    if (req.params.kind === 'telegram') {
      // Telegram's check is getMe: the bot answers, what it is called, and
      // whether BotFather lets it into groups and lets it read them — the
      // two settings that make "it ignores the group" (the old group-readiness
      // check, now the same Re-check the other apps have).
      const row = store.getChannelForAgent(agent.id, 'telegram');
      if (!row) return reply.code(404).send({ error: 'It has no Telegram bot.' });
      let token: string;
      try { token = await secrets.get(row.secretRef); } catch { return reply.code(409).send({ error: 'Its Telegram token is missing — remove the bot and add one again.' }); }
      let me: { ok?: boolean; result?: { username?: string; first_name?: string; can_join_groups?: boolean; can_read_all_group_messages?: boolean } };
      let status: number;
      try {
        const res = await (deps.oauthFetch ?? fetch)(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(6000) });
        status = res.status;
        me = (await res.json().catch(() => ({}))) as typeof me;
      } catch { return reply.code(502).send({ error: "Couldn't reach Telegram — try again." }); }
      if (!me?.ok || !me.result) {
        // A body of JSON null is no answer either, not a 500 (HB-1260 review).
        // Only Telegram's own "no" (401 or 404) judges the token, as when a
        // token is pasted (verifyBotToken). A rate limit, a 5xx or an outage
        // page told the owner to fetch a fresh token for a healthy bot (HB-1038).
        if (telegramRefusedToken(status, me)) return reply.code(400).send({ error: 'Telegram refused the bot token. Add the bot again with a fresh token from @BotFather.' });
        return reply.code(502).send({ error: telegramUnanswered(status) });
      }
      const warnings: string[] = [];
      const ga = agent.groupAccess?.mode ?? 'members';
      if (ga !== 'off' && !me.result.can_join_groups) warnings.push('Groups are off at BotFather: /setjoingroups → Enable, or it cannot be added to a group.');
      if (ga !== 'off' && !me.result.can_read_all_group_messages) warnings.push('Privacy mode is on: in a group it only sees @mentions and commands. /setprivacy → Disable at BotFather, then remove and re-add it to the group.');
      // Judged against the row as it is NOW, as the other apps' are: a bot
      // swapped in while Telegram was asked got the old bot's name (HB-0598).
      const nowRow = store.getChannelForAgent(agent.id, 'telegram');
      if (!nowRow || nowRow.accountId !== row.accountId || nowRow.secretRef !== row.secretRef) return reply.code(409).send({ error: 'Its Telegram bot changed meanwhile — look again.' });
      const st = (nowRow.settings ?? {}) as Record<string, unknown>;
      store.setChannelSettings(agent.id, 'telegram', { ...st, botName: me.result.first_name, warnings, checkedAt: new Date().toISOString() });
      rememberBotName(agent.id, me.result.first_name, nowRow.secretRef);
      trace(agent.id)('channel.rechecked', { kind: 'telegram', warnings: warnings.length });
      return publicTelegramChannel(agent, store.getChannelForAgent(agent.id, 'telegram')!);
    }
    const conn = connectorFor(req.params.kind);
    if (!conn) return reply.code(404).send({ error: 'Unknown channel.' });
    const row = store.getChannelForAgent(agent.id, conn.kind);
    if (!row) return reply.code(404).send({ error: `It has no ${conn.label}.` });
    let secret: string;
    try { secret = await secrets.get(row.secretRef); } catch { return reply.code(409).send({ error: `Its ${conn.label} token is missing — remove ${conn.label} and connect it again.` }); }
    let verified;
    try { verified = await conn.verify(conn.credsFromSecret(secret)); }
    catch (err) {
      if (err instanceof ConnectorError) return reply.code(400).send({ error: err.userMessage });
      throw err;
    }
    const st = (row.settings ?? {}) as Record<string, unknown>;
    // "Every server/channel it is in" is written into its config at a rebuild:
    // say when the places changed, so the app can offer the rebuild that makes
    // it answer there (use-case walk-through, 2026-09-27).
    const ids = (v: unknown) => (Array.isArray(v) ? (v as Array<{ id?: unknown }>).map((g) => String(g?.id ?? '')).filter(Boolean).sort().join(',') : '');
    // Judged against the row as it is NOW: a rooms change made while the
    // platform was being asked must not be written back over (night review).
    const nowRow = store.getChannelForAgent(agent.id, conn.kind);
    if (!nowRow || nowRow.accountId !== row.accountId) return reply.code(409).send({ error: `Its ${conn.label} changed meanwhile — look again.` });
    const cur = (nowRow.settings ?? {}) as Record<string, unknown>;
    const listed = (verified.settings as Record<string, unknown>).servers;
    const placesChanged = listed !== undefined && (cur.rooms as { mode?: string } | undefined)?.mode === 'members'
      && ids(cur.servers) !== ids(listed);
    store.setChannelSettings(agent.id, conn.kind, {
      ...cur, ...verified.settings, displayName: verified.displayName,
      ...(verified.addToServerUrl ? { addToServerUrl: verified.addToServerUrl } : {}),
      warnings: verified.warnings, checkedAt: new Date().toISOString(),
      rooms: cur.rooms ?? { mode: 'off' },
    });
    trace(agent.id)('channel.rechecked', { kind: conn.kind, warnings: verified.warnings.length });
    return { ...publicChannel(store.getChannelForAgent(agent.id, conn.kind)!), placesChanged };
    })();
    } finally { endRecheck(agent.id); }
  });

  app.patch<{ Params: { id: string; kind: string }; Body: { rooms?: { mode?: string; roomId?: string } } }>('/v1/agents/:id/channels/:kind', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const conn = connectorFor(req.params.kind);
    if (!conn) return reply.code(404).send({ error: 'Unknown channel.' });
    const row = store.getChannelForAgent(agent.id, conn.kind);
    if (!row) return reply.code(404).send({ error: `It has no ${conn.label}.` });
    if (operationRefuses(agent, reply)) return reply;
    if (isBusy(agent.id)) return reply.code(409).send({ error: 'It is busy with another change — try again in a moment.' });
    const r = req.body?.rooms;
    const mode = r?.mode;
    // "Every server/channel it is in" exists for Discord AND Slack (the seed
    // writes both; the sheet offered it for Slack and this refused it — 2026-09-27).
    if (mode !== 'off' && mode !== 'room' && !(mode === 'members' && (conn.kind === 'discord' || conn.kind === 'slack'))) {
      return reply.code(400).send({ error: conn.kind === 'discord' ? 'Choose off, every server it is in, or one server by its ID.'
        : conn.kind === 'slack' ? 'Choose off, every channel it is in, or one channel by its ID.' : 'Choose off, or one room by its ID.' });
    }
    const roomId = typeof r?.roomId === 'string' ? r.roomId.trim() : '';
    if (mode === 'room' && !ROOM_ID[conn.kind].test(roomId)) {
      return reply.code(400).send({
        error: conn.kind === 'slack'
          ? 'Give the channel ID (it starts with C and is at the end of the channel\'s link), not its name.'
          : 'Give the server ID (a long number: right-click the server with Developer Mode on → Copy Server ID).',
      });
    }
    // A room with nobody admitted would be open to everyone in it (OpenClaw
    // reads no `users` as "anyone"), so the room waits for the first link.
    if (mode !== 'off' && !peopleOn(agent, conn.kind).length) {
      return reply.code(409).send({ error: `Link yourself first: send the bot a direct message and approve it under ${conn.label} ("That's me"). Then choose where it answers.` });
    }
    store.setChannelSettings(agent.id, conn.kind, { ...(row.settings ?? {}), rooms: mode === 'room' ? { mode, roomId } : { mode } });
    trace(agent.id)('channel.rooms', { kind: conn.kind, mode });
    const fresh = store.getAgent(agent.id) ?? agent;
    const applied = fresh.state === 'RUNNING' || fresh.state === 'STOPPED' ? rebuildOrOwe(fresh) : undefined;
    return { ...publicChannel(store.getChannelForAgent(agent.id, conn.kind)!), ...(applied === 'next-start' ? { atNextStart: true } : {}) };
  });

  app.delete<{ Params: { id: string; kind: string } }>('/v1/agents/:id/channels/:kind', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const conn = connectorFor(req.params.kind);
    if (!conn) return reply.code(404).send({ error: 'Unknown channel.' });
    const row = store.getChannelForAgent(agent.id, conn.kind);
    if (!row) return reply.code(404).send({ error: `It has no ${conn.label}.` });
    if (operationRefuses(agent, reply)) return reply;
    if (isBusy(agent.id)) return reply.code(409).send({ error: 'It is busy with another change — try again in a moment.' });
    // The bot is parked for the next agent (its tokens, rooms and name kept)
    // rather than thrown away — Discord's and Slack's alike.
    let parked = false;
    let told = 0;
    // Stop, say goodbye, park and delete under the busy flag, and only the
    // bot this request was about: a swap from another tab during the
    // farewells used to have its NEW bot's row deleted here, losing both bots
    // (night review). The goodbye is inside too, once the agent is stopped:
    // sent first, people were told it had gone from a bot that a concurrent
    // change then kept, or that could not be stopped (HB-0064).
    let outcome: 'done' | 'changed' | 'busy' | 'not-stopped';
    try {
      outcome = await whileBusy(agent.id, async () => {
        const now = store.getChannelForAgent(agent.id, conn.kind);
        if (!now || now.accountId !== row.accountId) return 'changed' as const;
        const stopped = await stopForBotHandover(agent);
        if (!stopped) return 'not-stopped' as const;
        // While the token is still the agent's (Telegram's detach farewell):
        // people who reached it here lose it.
        told = await dmChannelPeople(agent, conn.kind, now.secretRef, `👋 ${agent.name} no longer answers on ${conn.label}. Its owner took it off ${conn.label}; it is not gone. Reach it another way, or ask its owner.`);
        try { await parkDiscordBot({ store, secrets }, agent.ownerId, now); parked = true; }
        catch (err) { trace(agent.id)('channel.park_failed', { kind: conn.kind, error: String(err).slice(0, 200) }); }
        if (!parked) await secrets.delete(now.secretRef).catch(() => {});
        store.deleteChannelForAgent(agent.id, conn.kind);
        return 'done' as const;
      });
    } catch (err) {
      if (!(err instanceof AgentBusyError)) throw err;
      outcome = 'busy';
    }
    if (outcome === 'busy') return reply.code(409).send({ error: 'It is busy with another change — try again in a moment.' });
    if (outcome === 'not-stopped') return reply.code(409).send({ error: 'Its runtime could not be confirmed stopped. The bot is still connected; try again when its machine answers.' });
    if (outcome === 'changed') return reply.code(409).send({ error: `Its ${conn.label} bot changed meanwhile — look again before removing it.` });
    trace(agent.id)('channel.detached', { kind: conn.kind, accountId: row.accountId, parked, told });
    let applied: ReturnType<typeof rebuildOrOwe> | undefined;
    if (agent.runtimeRef && (agent.state === 'RUNNING' || agent.state === 'STOPPED')) {
      // OpenClaw's own approval store outlives the config: scrubbed, or the
      // next bot under this account key admits the people this one had.
      await scrubChannelAllowlist(
        { store, provider: providerFor(agent.hostId), log: trace(agent.id) },
        { agentId: agent.id, runtimeRef: agent.runtimeRef, kind: conn.kind, accountId: CHANNEL_ACCOUNT },
      ).catch(() => false);
      applied = rebuildOrOwe(agent, { handover: true });
    }
    return reply.code(202).send({ removed: conn.kind, parked, ...(applied === 'next-start' ? { atNextStart: true } : {}) });
  });

  // ---- Telegram groups ------------------------------------------------------
  /**
   * Group-chat readiness: BotFather's two group settings can NOT be changed
   * by any API (they live only in the BotFather chat), but getMe REPORTS
   * them — so the app can show live status next to the quick-help steps
   * instead of leaving the owner to guess which toggle they missed.
   */
  app.get<{ Params: { id: string } }>('/v1/agents/:id/group-readiness', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    const channel = agent && store.getChannelForAgent(agent.id);
    if (!channel) return reply.code(404).send({ error: 'Not found' });
    try {
      const token = await secrets.get(channel.secretRef);
      const res = await (deps.oauthFetch ?? fetch)(`https://api.telegram.org/bot${token}/getMe`, {
        signal: AbortSignal.timeout(5000),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        result?: { username?: string; can_join_groups?: boolean; can_read_all_group_messages?: boolean };
      };
      if (!body.ok || !body.result) {
        return reply.code(502).send({ error: "Telegram didn't answer for this bot — try again." });
      }
      return {
        username: body.result.username,
        canJoinGroups: !!body.result.can_join_groups,
        // false = privacy mode ON (the usual "bot ignores the group" cause).
        canReadAllGroupMessages: !!body.result.can_read_all_group_messages,
      };
    } catch {
      return reply.code(502).send({ error: "Couldn't reach Telegram — try again." });
    }
  });

  /**
   * Group rooms the gateway has SEEN — for binding one in 'room' mode. A
   * group session exists once any admitted member has spoken in the room
   * (members-only default lets their messages through), so the flow is: add
   * the bot to the group, say anything in it, then pick it here.
   */
  app.get<{ Params: { id: string } }>('/v1/agents/:id/group-chats', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' }); // foreign/missing: no existence leak
    if (!agent.runtimeRef || agent.state !== 'RUNNING') {
      return reply.code(409).send({ error: 'Start the agent to look for its group chats.' });
    }
    const res = await providerFor(agent.hostId).exec(agent.runtimeRef, [
      'sessions', 'list', '--agent', agent.slug, '--json',
    ]);
    if (res.code !== 0) return reply.code(502).send({ error: "The gateway didn't answer." });
    const rooms: Array<{ id: string; key: string }> = [];
    try {
      const sessions: Array<{ key?: string }> = JSON.parse(res.stdout).sessions ?? [];
      for (const s of sessions) {
        const m = /(?:^|:)group[:_](-?\d{1,20})/.exec(s.key ?? '');
        if (m && !rooms.some((r) => r.id === m[1])) rooms.push({ id: m[1]!, key: s.key! });
      }
    } catch {
      /* unparsable list → no rooms */
    }
    return { rooms };
  });

  // ---- the bot census and token reveals -------------------------------------
  /**
   * One bot's token, from the inventory — including the ones with no agent to
   * reveal them from: a spare in the pool, an orphaned token, a bot whose agent
   * is archived. Machine owner only, one bot per request, and logged: there is
   * deliberately no "reveal all".
   */
  app.get<{ Params: { username: string } }>('/v1/bots/:username/token', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const username = req.params.username.replace(/^@/, '').toLowerCase();
    const row = botSecretRefs().get(username);
    if (!row) return reply.code(404).send({ error: `This server holds no token for @${username}.` });
    // The machine owner's reveal reaches the HOUSE's bots and their own — not
    // another person's pasted bot or private spare (2026-09-25).
    if (row.ownerId && row.ownerId !== ownerIdOf(req)) return reply.code(403).send({ error: `@${username} belongs to another person on this machine; its token is theirs to see.` });
    const token = await secrets.get(row.secretRef).catch(() => undefined);
    if (!token) return reply.code(409).send({ error: 'The stored token is missing.' });
    app.log.warn({ username, where: row.where, ownerId: ownerIdOf(req) }, 'telegram.bot_token_revealed');
    return { username, where: row.where, token };
  });

  /**
   * Bot inventory — every Telegram bot this installation holds a token for,
   * with a LIVE getMe verdict. Built for the BotFather ~40-bots-per-account
   * ceiling: diffing /mybots against this list is how stale mints are found
   * (an owner hit the cap with 5 unaccounted bots, 2026-09-05). Host-owner
   * gated: it decrypts every bot token to ask Telegram about it.
   */
  app.get('/v1/bot-inventory', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const botFetch = deps.oauthFetch ?? fetch;
    const rows = botSecretRefs();
    const out: Array<Record<string, unknown>> = [];
    // getMe each bot CONCURRENTLY (bounded): serial × 6s timeout could stall
    // this admin request for minutes with a slow Telegram and ~40 bots
    // (audit 2026-09-06). A verdict per bot: ✅ alive / ❌ dead / ❓ unknown.
    const entries = [...rows.entries()].sort(([a], [b]) => a.localeCompare(b));
    const probe = async ([username, r]: [string, typeof rows extends Map<string, infer V> ? V : never]) => {
      let alive: boolean | undefined;
      let displayName: string | undefined;
      const token = await secrets.get(r.secretRef).catch(() => null);
      if (token) {
        try {
          const res = await botFetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(6000) });
          const b = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { first_name?: string } };
          // Dead only on Telegram's own "no": a rate limit or an outage page
          // marked every bot dead at once (HB-1261). Unknown otherwise.
          alive = b.ok === true ? true : telegramRefusedToken(res.status, b) ? false : undefined;
          displayName = b.ok === true ? b.result?.first_name : undefined;
        } catch { alive = undefined; /* Telegram unreachable ≠ bot dead */ }
      } else {
        alive = false;
      }
      return { username, ...r, secretRef: undefined, alive, displayName };
    };
    for (let i = 0; i < entries.length; i += 8) {
      out.push(...(await Promise.all(entries.slice(i, i + 8).map(probe))));
    }
    return { bots: out };
  });

  // Owner-facing reveal of the agent's bot token — for recycling a hand-made
  // bot into a new agent after deleting this one. Owner-authed like all /v1.
  app.get<{ Params: { id: string } }>('/v1/agents/:id/bot-token', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    const channel = agent && store.getChannelForAgent(agent.id);
    if (!agent || !channel) return reply.code(404).send({ error: 'Not found' });
    // A house bot (shared pool) or another person's pool bot is only leased:
    // its token outlives this agent's lease, so only the machine's owner may
    // see it (use-case audit, 2026-09-27; the inventory's rule).
    const poolOwner = (deps.channel.pool as { ownerOf?: (u: string) => string | null | undefined }).ownerOf?.(channel.accountId);
    if (poolOwner !== undefined && poolOwner !== agent.ownerId && !ownsLocalHost(req)) {
      return reply.code(403).send({ error: 'This is a shared house bot, lent to this agent: only the machine\'s owner can see its token.' });
    }
    app.log.warn({ agentId: agent.id, username: channel.accountId, ownerId: ownerIdOf(req) }, 'telegram.bot_token_revealed');
    return {
      accountId: channel.accountId,
      botToken: await secrets.get(channel.secretRef),
      // Pool bots recycle automatically on delete; manual bots don't — the
      // app uses this to tell the owner which kind they're looking at.
      pooled: deps.channel.pool.owns(channel.accountId),
    };
  });

  // ---- the account's own chat identities and choices ----------------------
  /**
   * Unlink the account's Telegram identity. Existing memberships keep working
   * (they carry their own binding); this only stops FUTURE agents from
   * auto-admitting that Telegram user — e.g. after handing a phone number on.
   * The store records the ids let go, so the owner seats still bound to them
   * are not inferred back as "known" (A069): a removal from an existing agent
   * is the member list's job.
   */
  app.delete('/v1/account/telegram', async (req) => {
    store.setAccountTelegram(ownerIdOf(req), null);
    return { unlinked: true };
  });
  /** A person's own preferences (Settings → Messaging → Telegram: own bots only). Each key optional; the answer is the whole set. */
  app.patch<{ Body: { ownBotsOnly?: boolean } }>('/v1/account/prefs', async (req, reply) => {
    const parsed = z.object({ ownBotsOnly: z.boolean().optional() }).strict().safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const me = ownerIdOf(req);
    if (parsed.data.ownBotsOnly !== undefined) store.setOwnerPref(me, 'ownBotsOnly', parsed.data.ownBotsOnly ? '1' : null);
    return { prefs: store.ownerPrefs(me), availableBots: deps.channel.pool.availableCount(me, store.ownerPrefs(me).ownBotsOnly) };
  });
  /**
   * Forget the caller's Discord identity on every agent: the next bot asks
   * again ("That's me"). The approval each agent's volume holds is scrubbed
   * too, and the agent rebuilt from its members: removing the link alone
   * left the handed-on account able to DM every agent (night review).
   */
  app.delete('/v1/account/discord', async (req, reply) => {
    // Only THIS id comes out of each agent's allowlists, on its volume, in any
    // state: wiping the whole approval store locked out everyone admitted since
    // the last rebuild, and a stopped agent kept the id until then (regression review).
    // Per agent, with the id THAT agent knows (a person's id can differ between
    // agents), and the binding goes only once its scrub is done: one id was
    // scrubbed from every agent and every binding dropped first, so a failed
    // scrub (the runner asleep) left the id admitted by an agent that no longer
    // knew it, and a second unlink had nothing to find (review 2026-10-23).
    const me = ownerIdOf(req);
    const failed: string[] = [], volumeGone: string[] = [], busy: string[] = [];
    let n = 0;
    for (const id of store.agentsWithIdentity(me, 'discord')) {
      // Each agent's scrub and its binding's removal under its lifecycle
      // lock, read once the lock is held, as a member's removal is
      // (roster.ts): a move that exported the volume while the scrub
      // waited kept the approval on the new machine, and the binding went
      // anyway, leaving a second unlink nothing to find (HB-1090).
      let outcome: 'done' | 'failed' | 'volume-gone';
      try {
        outcome = await whileBusy(id, async () => {
          const ownId = store.memberIdentities(id, me).discord;
          const agent = store.getAgent(id);
          if (ownId && /^\d{5,32}$/.test(ownId) && agent?.runtimeRef && agent.state !== 'DELETED' && store.getChannelForAgent(id, 'discord')) {
            const script = allowlistScrubScript([{ channel: 'discord', acct: CHANNEL_ACCOUNT, id: ownId, cred: `/home/node/.openclaw/credentials/discord-${CHANNEL_ACCOUNT.toLowerCase()}-allowFrom.json` }]);
            const res = await providerFor(agent.hostId).execShellOnVolume(agent.runtimeRef, script).catch(() => undefined);
            if (res?.code !== 0) {
              trace(id)('channel.unlink_scrub_failed', { kind: 'discord', ...(res?.volumeMissing ? { volumeGone: true } : {}) });
              // Kept, as a member's removal is: another machine may still hold the
              // allowlist. But no machine waking up brings it back (HB-0373).
              return res?.volumeMissing ? 'volume-gone' as const : 'failed' as const;
            }
          }
          n += store.unbindMemberIdentity(id, me, 'discord');
          return 'done' as const;
        });
      } catch (err) {
        if (!(err instanceof AgentBusyError)) throw err;
        // Mid-move or mid-rebuild: kept for a retry, as a failed scrub is.
        busy.push(store.getAgent(id)?.name ?? id);
        continue;
      }
      if (outcome === 'failed') failed.push(store.getAgent(id)?.name ?? id);
      if (outcome === 'volume-gone') volumeGone.push(store.getAgent(id)?.name ?? id);
    }
    if (busy.length && !failed.length && !volumeGone.length) {
      return reply.code(409).send({
        unlinked: false, agents: n, failed: busy, busy,
        error: `Your Discord could not be removed from ${busy.join(', ')} yet: ${busy.length === 1 ? 'it is' : 'they are'} busy with another change (a move or a rebuild). Unlink again in a moment${n ? `; ${n === 1 ? 'one other has' : `${n} others have`} forgotten it` : ''}.`,
      });
    }
    if (failed.length || volumeGone.length) {
      const gone = volumeGone.length
        ? `${volumeGone.join(', ')}: ${volumeGone.length === 1 ? 'its stored files are' : 'their stored files are'} not on ${volumeGone.length === 1 ? 'its' : 'their'} machine (the volume is gone), so there is nothing to remove it from. Unlink again once the files are back or after a rebuild, or delete ${volumeGone.length === 1 ? 'that agent' : 'those agents'}.`
        : '';
      // A busy one is named as busy, not as a machine asleep (HB-1090).
      const busyToo = busy.length
        ? ` ${busy.join(', ')} ${busy.length === 1 ? 'is' : 'are'} busy with another change (a move or a rebuild) and still ${busy.length === 1 ? 'knows' : 'know'} it: unlink again in a moment.`
        : '';
      return reply.code(failed.length ? 502 : 409).send({
        unlinked: false, agents: n, failed: [...failed, ...busy, ...volumeGone], ...(volumeGone.length ? { volumeGone } : {}), ...(busy.length ? { busy } : {}),
        error: (!failed.length ? `Your Discord could not be removed from ${gone}${n ? ` ${n === 1 ? 'One other has' : `${n} others have`} forgotten it.` : ''}` :
          `Your Discord could not be removed from ${failed.join(', ')} — is the machine it runs on awake? ` +
          `${failed.length === 1 ? 'That agent' : 'Those agents'} still ${failed.length === 1 ? 'knows' : 'know'} it` +
          `${n ? `; ${n === 1 ? 'one other has' : `${n} others have`} forgotten it` : ''}. Unlink again when ${failed.length === 1 ? 'it is' : 'they are'} reachable.${gone ? ` Nor from ${gone}` : ''}`) + busyToo,
      });
    }
    return { unlinked: true, agents: n };
  });

  // ---- pairing: who is knocking, and who may --------------------------------
  // The agent's Telegram deep link as a scannable QR — the invite dialog shows
  // it so an off-tailnet invitee can join by pointing their camera at the
  // owner's screen instead of retyping a link.
  app.get<{ Params: { id: string } }>('/v1/agents/:id/qr.svg', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    const channel = agent && store.getChannelForAgent(agent.id);
    if (!channel?.deepLink) return reply.code(404).send({ error: 'Not found' });
    const svg = await QRCode.toString(channel.deepLink, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
    });
    return reply.type('image/svg+xml').send(svg);
  });

  // Pending pairing requests on a live agent — the app renders these as
  // "someone wants to talk to <agent>" cards for the owner to approve.
  app.get<{ Params: { id: string } }>('/v1/agents/:id/pairing', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent?.runtimeRef || !store.listChannelsForAgent(agent.id).length) return reply.code(404).send({ error: 'Not found' });
    if (agent.state !== 'RUNNING') return [];
    return cachedKnocks(agent);
  });

  // Every pending "wants to join" request across the caller's RUNNING agents,
  // flattened — one cheap call for the management bot to poll and push an
  // approval prompt, so the owner never has to open the web UI to notice one.
  app.get('/v1/pending', async (req) => {
    const mine = store
      .listAgents(ownerIdOf(req))
      .filter((a) => a.state === 'RUNNING' && a.runtimeRef && store.listChannelsForAgent(a.id).length);
    // Each agent's knocks from the half-minute cache the per-agent route keeps
    // (approve and deny clear it), six reads at a time: every poll was a docker
    // exec per agent, all at once (HB-0058).
    const perAgent = await sixAtATime(
      mine, async (a) => {
        try {
          const reqs = await cachedKnocks(a);
          return reqs.map((r) => ({
            agentId: a.id,
            agentName: a.name,
            kind: r.kind,
            code: r.code,
            channelUserId: r.id,
            // Kept for the Telegram management bot, which reads this name.
            ...(r.kind === 'telegram' ? { telegramId: r.id } : {}),
            username: r.meta?.username,
            firstName: r.meta?.firstName,
            lastName: r.meta?.lastName,
          }));
        } catch {
          return []; // an unreachable agent shouldn't sink the whole list
        }
      },
    );
    return perAgent.flat();
  });

  app.post<{ Params: { id: string }; Body: { code?: string } }>(
    '/v1/agents/:id/pairing/approve',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
      if (busyNow(agent, reply)) return reply;
      if (agent.state !== 'RUNNING') return reply.code(409).send({ error: 'Start the agent before approving a request.' });
      const sent = ApprovePairing.safeParse(req.body ?? {});
      if (!sent.success) return reply.code(400).send({ error: zodMessage(sent.error) });
      const code = sent.data.code;
      if (!code) return reply.code(400).send({ error: 'code required' });
      // Hold through channel discovery, runtime approval and the seat commit.
      // A removal, move or stop must not finish underneath a late approval.
      markBusy(agent.id);
      try {
        const kind = await kindForCode(agent, sent.data.kind, code);
        const fresh = ownedAgent(req, agent.id);
        if (!fresh || fresh.runtimeRef !== agent.runtimeRef || fresh.hostId !== agent.hostId || fresh.state !== agent.state) {
          return reply.code(409).send({ error: 'The agent changed while reading requests. Refresh and try again.' });
        }
        if (!kind) return reply.code(400).send({ error: 'Unknown channel.' });
        const channel = store.getChannelForAgent(agent.id, kind);
        // "That's me — link & approve" (owner-only by construction: ownedAgent
        // gates this route). Binds the owner seat + links the account's Telegram.
        const asSelf = sent.data.asSelf === true;
        if (!channel) return reply.code(404).send({ error: 'Not found' });
        // Linking yourself is fine; letting anyone else into it is not (2026-09-30).
        if (agent.ops && !asSelf) return reply.code(400).send({ error: OPS_ALONE });
        const admitted = await admitMember(
          { store, provider: providerFor(agent.hostId), log: trace(agent.id) },
          {
            agentId: agent.id,
            runtimeRef: agent.runtimeRef,
            accountId: kind === 'telegram' ? channel.accountId : CHANNEL_ACCOUNT,
            code,
            kind,
            agentName: agent.name,
            sharedMemory: agent.sharedMemory,
            asSelf,
          },
        );
        // The Telegram invite's knock window has done its job once its person
        // is in: the one that named them, or else one that named nobody —
        // left open, it kept showing strangers for the rest of the half hour
        // (2026-09-30).
        if (kind === 'telegram' && !asSelf) {
          const knockWins = store.pairingWindows(agent.id).filter((w) => w.seat.startsWith('telegram:') && isKnockWindow(w));
          const handle = normalizeHandle(admitted.username);
          const answered = knockWins.find((w) => w.expect && (w.expect === handle || w.expect === normalizeHandle(admitted.channelUserId)))
            ?? knockWins.find((w) => !w.expect);
          if (answered) store.closePairingWindow(agent.id, answered.seat);
        }
        // They are on the list now, so the door goes back to silence (unless
        // a window is still open for someone else, or the agent is open).
        await restDoor(agent);
        forgetKnocks(agent.id);
        return { approved: true, member: admitted };
      } catch (err) {
        if (err instanceof AdmitError) return reply.code(err.status).send({ error: err.userMessage });
        throw err;
      } finally {
        clearBusy(agent.id);
      }
    },
  );

  // Turn a pending request away. OpenClaw has no deny verb, so this is a file
  // surgery on the pairing store (see denyPairing) — and it's "not now", not a
  // ban: they can ask again by messaging the bot.
  app.post<{ Params: { id: string }; Body: { code?: string } }>(
    '/v1/agents/:id/pairing/deny',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      const sent = DenyPairing.safeParse(req.body ?? {});
      if (!sent.success) return reply.code(400).send({ error: zodMessage(sent.error) });
      const code = sent.data.code;
      let kind: Awaited<ReturnType<typeof kindForCode>>;
      try { kind = agent ? await kindForCode(agent, sent.data.kind, code) : 'telegram'; } catch (err) {
        if (err instanceof AdmitError) return reply.code(err.status).send({ error: err.userMessage });
        throw err;
      }
      if (!kind) return reply.code(400).send({ error: 'Unknown channel.' });
      const channel = agent && store.getChannelForAgent(agent.id, kind);
      if (!agent?.runtimeRef || !channel) return reply.code(404).send({ error: 'Not found' });
      if (!code) return reply.code(400).send({ error: 'code required' });
      try {
        forgetKnocks(agent.id);
        const out = await denyPairing(
          { store, provider: providerFor(agent.hostId), log: trace(agent.id) },
          { agentId: agent.id, runtimeRef: agent.runtimeRef, code, kind },
        );
        return out;
      } catch (err) {
        if (err instanceof AdmitError) return reply.code(err.status).send({ error: err.userMessage });
        throw err;
      } finally {
        // Again once the store has changed: a dashboard's read made during the turn-away saw the request still there,
        // and was kept for half a minute, so "Not now" came back (HB-1302). Approve forgets after its change already.
        forgetKnocks(agent.id);
      }
    },
  );

  /**
   * Change the bot an agent answers on, keeping the agent.
   *
   * Everything that matters survives, because none of it belongs to the bot:
   * memory and files are on the volume, and members are keyed to each
   * *person's* Telegram id, so nobody re-pairs. What cannot survive is the
   * conversation itself — Telegram scrollback belongs to the bot — so the
   * agent says where it is going on the old bot first, while it still can. A
   * bot cannot message someone who has never started a chat with it, so that
   * farewell is the only chance to tell them.
   *
   * The new identity comes from the pool: leasing is the path that renames the
   * bot, announces the handover and keeps the ledger straight. Paste a fresh
   * BotFather token into the pool first if you want a specific one.
   */
  app.post<{ Params: { id: string } }>('/v1/agents/:id/channel/swap', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
    if (busyNow(agent, reply)) return reply;
    if (agent.state !== 'RUNNING' && agent.state !== 'STOPPED') {
      return reply.code(409).send({ error: `It is ${agent.state.toLowerCase()} — wait for it to settle first.` });
    }
    const old = store.getChannelForAgent(agent.id, 'telegram');
    if (!old) return reply.code(409).send({ error: 'This agent has no Telegram bot to change.' });
    if (!deps.channel.pool.availableCount(agent.ownerId, store.ownerPrefs(agent.ownerId).ownBotsOnly)) {
      return reply.code(409).send({
        error: 'No spare bot to move to. Add one under ⚙ Settings → Messaging → Telegram → Add a bot, then try again.',
      });
    }

    // The whole handover holds the agent's lifecycle lock, judged again once
    // it is held: lease, farewell, stop, old bot back, row swapped. Holding it
    // only for the stop let a Start or a Rebuild land between the old bot
    // going back and the new row; a pasted bot was parked (free to lease) BEFORE
    // the stop, and a stop that failed still swapped the row — the agent kept
    // polling a bot the next agent could take (concurrency review, 2026-10-09).
    type Swapped = { fresh: { accountId: string; secretRef: string; deepLink?: string }; told: number };
    let out: Swapped | { code: number; error: string };
    try {
      out = await whileBusy(agent.id, async (): Promise<Swapped | { code: number; error: string }> => {
        const now = store.getAgent(agent.id);
        if (!now?.runtimeRef || (now.state !== 'RUNNING' && now.state !== 'STOPPED') || now.migratedTo || now.hostId !== agent.hostId
          || store.getChannelForAgent(agent.id, 'telegram')?.accountId !== old.accountId) {
          return { code: 409, error: 'It changed meanwhile — look again, then try again.' };
        }
        // Lease the new identity BEFORE letting go of the old one: the farewell
        // has to name it, and a failure here must leave the agent as it was.
        let fresh;
        try {
          // Never its own bot back: pool leasing is idempotent per agent, so
          // without the exclusion a pool-bot agent was "moved" to the bot it had,
          // which the release below then freed under it (night review, 2026-09-27).
          // "Own bots only" as the spare count above judged it (HB-0994).
          fresh = await deps.channel.provision({
            agentId: agent.id, agentName: agent.name, slug: agent.slug, ownerId: agent.ownerId, exclude: [old.accountId],
            ownBotsOnly: store.ownerPrefs(agent.ownerId).ownBotsOnly,
          });
        } catch (err) {
          return { code: 409, error: `Could not take a spare bot: ${String((err as Error)?.message ?? err).slice(0, 160)}` };
        }
        if (fresh.accountId.toLowerCase() === old.accountId.toLowerCase()) {
          return { code: 409, error: 'No other spare bot to move to. Add one under ⚙ Settings → Messaging → Telegram → Add a bot, then try again.' };
        }
        const clash = store.findAgentUsingAccount(fresh.accountId);
        if (clash && clash.id !== agent.id) {
          await deps.channel.release(fresh.accountId).catch(() => {});
          return { code: 409, error: `@${fresh.accountId} already belongs to "${clash.name}".` };
        }

        // Say goodbye on the bot that still works, and where to find it next.
        const told = await announceToMembers(
          { store, provider: providerFor(now.hostId), log: trace(agent.id) },
          {
            agentId: agent.id, runtimeRef: now.runtimeRef, accountId: old.accountId,
            text: `📮 ${agent.name} is moving to @${fresh.accountId}. Open that bot and say hi — this chat will stop answering. Everything it knows comes with it.`,
          },
        ).catch(() => 0);

        // Stopped before its old bot goes anywhere: until its rebuild the
        // container still polls that token (regression review, 2026-09-28).
        // Not stopped: nothing changes — the old bot stays its own, the new
        // lease goes back, and the owner is told to try again.
        if (!(await stopForBotHandover(now))) {
          await deps.channel.release(fresh.accountId, { reason: 'swapped', agentId: agent.id }).catch(() => {});
          return { code: 409, error: `It would not stop, so it stays on @${old.accountId}. Try again in a moment.` };
        }
        // An owner's own bot (not from the pool) goes INTO the pool, as Detach
        // does: release alone deleted its token (use-case audit, 2026-09-27).
        // Only now, once nothing polls it any more.
        const tgPool = (deps.channel as { pool?: { owns(u: string): boolean; addToPool(u: string, t: string, o?: string | null): Promise<void> } }).pool;
        if (tgPool && !tgPool.owns(old.accountId)) {
          try { await tgPool.addToPool(old.accountId, await secrets.get(old.secretRef), agent.ownerId); }
          catch (err) { trace(agent.id)('channel.recycle_failed', { error: String(err).slice(0, 200) }); }
        }
        // `swapped`: the members were told above where to go; no "removed" notice.
        await deps.channel.release(old.accountId, { reason: 'swapped', agentId: agent.id }).catch((err: unknown) =>
          app.log.warn({ agentId: agent.id, err: String(err) }, 'old bot release failed'));
        store.replaceChannelRow(agent.id, 'telegram', {
          id: randomUUID(), agentId: agent.id, kind: 'telegram',
          accountId: fresh.accountId, secretRef: fresh.secretRef, deepLink: fresh.deepLink,
          createdAt: new Date().toISOString(),
        } as never);
        forgetBotName(agent.id);
        trace(agent.id)('channel.swapped', { from: old.accountId, to: fresh.accountId, told });
        return { fresh, told };
      });
    } catch (err) {
      if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
      throw err;
    }
    if ('error' in out) return reply.code(out.code).send({ error: out.error });
    const { fresh, told } = out;

    // A rebuild writes the whole Telegram block from the new row — the account
    // key, the token, the allowlist and the door policy together. Doing that by
    // hand on a live config is the class of edit that has bitten us twice.
    const applied = rebuildOrOwe(agent, { handover: true });
    return {
      swapped: true, from: old.accountId, to: fresh.accountId,
      deepLink: fresh.deepLink, told, rebuilding: applied === 'rebuilding',
      ...(applied === 'next-start' ? { atNextStart: true } : {}),
    };
  });

  /**
   * Who may reach this agent on a messaging app. Off (the default) means
   * invitees and people you already know; on restores the old behaviour where
   * anyone who finds the bot can knock and wait for you to approve.
   */
  app.post<{ Params: { id: string } }>('/v1/agents/:id/allow-knocks', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const parsed = z.object({ on: z.boolean() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    // Turning it OFF is always allowed (it shuts a door); on, never for the manager (2026-09-30).
    if (agent.ops && parsed.data.on) return reply.code(400).send({ error: OPS_ALONE });
    const was = !!agent.allowKnocks;
    store.setAllowKnocks(agent.id, parsed.data.on);
    trace(agent.id)('agent.allow_knocks', { on: parsed.data.on });
    // Opened on the running bot, or not at all. A write its runtime refused
    // (its volume unavailable) was ignored: 200, the setting kept, and the
    // bot went on dropping new people's messages, with nothing to try again,
    // since the sweep leaves an open door alone (HB-0995). Not taken: the
    // setting goes back, and a door this opened rests again (the sweep
    // finishes that if it fails too). An app its running config does not
    // have (`no-account`: an image without that app's plugin is built
    // without it) has no door to open now, and is not a refusal: its next
    // build writes the door from the setting. Only a write that failed is.
    /** Each app's door opened: the first that did not take it, and why, or undefined when all did. */
    const refusedDoor = async (a: Agent): Promise<{ kind: string; why: string } | undefined> => {
      for (const ch of store.listChannelsForAgent(a.id)) {
        let why = 'the write to its volume failed';
        const out = await writeDmPolicy(
          { store, provider: providerFor(a.hostId), log: trace(a.id) },
          { agentId: a.id, runtimeRef: a.runtimeRef!, kind: ch.kind, accountId: ch.kind === 'telegram' ? ch.accountId : CHANNEL_ACCOUNT, policy: 'pairing' },
        ).catch((err: unknown) => { why = String(err instanceof Error ? err.message : err).slice(0, 160); return 'failed' as const; });
        if (out === 'failed') return { kind: ch.kind, why };
      }
      return undefined;
    };
    // Turned on while a change holds the agent (a rebuild that may have
    // written its config, the door shut, already): the live write is skipped
    // while it rebuilds, or lands on a config the rebuild then replaces, and
    // "on" waited for the next rebuild (HB-1156). Once the change ends, the
    // door is opened on what runs then, the same way. One that does not take
    // it keeps the setting the owner was answered with (its next build writes
    // the door from it), and says so on its timeline: put back, the setting
    // changed with no word to anyone (HB-1156 review).
    if (parsed.data.on && !was && isBusy(agent.id)) {
      void busyDone(agent.id).then(async () => {
        const now = store.getAgent(agent.id);
        // Turned off since, or not up: its next build writes the door from the setting.
        if (!now?.allowKnocks || !now.runtimeRef || now.state !== 'RUNNING') return;
        const refused = await refusedDoor(now);
        if (refused) trace(now.id)('agent.knock_door_failed', refused);
      }).catch((err: unknown) => app.log.error({ err, agentId: agent.id }, 'opening the door once the agent was free failed'));
    }
    // Live, not at the next rebuild: "anyone can knock" that only takes
    // effect in a minute or two is a setting people press twice.
    if (agent.runtimeRef && agent.state === 'RUNNING') {
      if (parsed.data.on) {
        if (await refusedDoor(agent)) {
          store.setAllowKnocks(agent.id, was);
          trace(agent.id)('agent.allow_knocks', { on: was, undone: true });
          if (!was) await restDoor({ ...agent, allowKnocks: false });
          return reply.code(502).send({
            allowKnocks: was,
            error: `Its bot did not take the change — is its machine awake? It stays ${was ? 'open to knocks' : 'invite only'}. Try again in a moment, or Rebuild it.`,
          });
        }
      } else {
        await restDoor({ ...agent, allowKnocks: false });
      }
    }
    return { allowKnocks: parsed.data.on };
  });

  /**
   * Point this agent's bot at the agent's current name, on demand.
   *
   * The automatic paths cover pool bots (renamed on lease, re-applied on
   * rebuild, retried by the sweep). Nothing covers a bot the OWNER minted or
   * adopted — deliberately, since renaming someone's own bot unasked is not
   * ours to do. Asking is exactly what makes it fine, which is what this is.
   * It also answers honestly when Telegram refuses: its rename quota is hours
   * long, and "nothing happened" is a bad answer to a button press.
   */
  app.post<{ Params: { id: string }; Body: { kind?: string } }>('/v1/agents/:id/bot-name/sync', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const wanted = pairingKind(req.body?.kind) ?? 'telegram';
    if (wanted !== 'telegram') {
      const other = store.getChannelForAgent(agent.id, wanted);
      if (!other) return reply.code(409).send({ error: `This agent has no ${wanted} bot yet.` });
      const res = await renameChannelBot(agent, other, agent.name);
      return res.ok ? { ok: true, name: res.name } : { ok: false, name: agent.name, error: res.error };
    }
    const chan = store.getChannelForAgent(agent.id);
    if (!chan || chan.kind !== 'telegram') {
      return reply.code(409).send({ error: 'This agent has no Telegram bot yet.' });
    }
    // Document the change IN the chat — the label changing silently under the
    // members is the confusing part; a one-line DM from the bot is the record.
    // Best-effort, and only when the rename actually happened.
    const announce = () => {
      if (!agent.runtimeRef) return;
      void announceToMembers(
        { store, provider: providerFor(agent.hostId), log: trace(agent.id) },
        {
          agentId: agent.id, runtimeRef: agent.runtimeRef, accountId: chan.accountId,
          text: `🏷 This bot is now named “${agent.name}”. Same agent, same chat — only the display name changed.`,
        },
      ).catch(() => 0);
    };
    // The card's Sync button greys off this cache — a stale entry after a
    // successful rename would keep the button lit (or grey it wrongly).
    forgetBotName(agent.id);
    const pooled = deps.channel.pool.owns(chan.accountId);
    if (pooled) {
      await deps.channel.syncDisplayName?.(chan.accountId, agent.name);
      const pending = deps.channel.pool.pendingName?.(chan.accountId);
      // Still parked = Telegram refused; the sweep will finish it.
      if (!pending) announce();
      return pending
        ? { ok: false, name: pending.name, retryAt: pending.retryAt }
        : { ok: true, name: agent.name };
    }
    // The owner's own bot: rename it directly, since nothing else ever will.
    try {
      const res = await setTelegramDisplayName(await secrets.get(chan.secretRef), agent.name, deps.oauthFetch);
      trace(agent.id)('channel.renamed', { name: agent.name, ...res, manual: true });
      if (res.ok) announce();
      return res.ok
        ? { ok: true, name: agent.name }
        : {
            ok: false,
            name: agent.name,
            error: res.error,
            ...(res.retryAfter ? { retryAt: new Date(Date.now() + res.retryAfter * 1000).toISOString() } : {}),
          };
    } catch (err) {
      return reply.code(502).send({ error: `Couldn't reach Telegram: ${String(err)}` });
    }
  });
}
