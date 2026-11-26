import { buildRecommendations, inRecommended } from '../../orchestrator/usage/recommendations.js';
import { publicReplayHeaders } from '../trust.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store } from '../../store/store.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import { quoteOutput } from '../../ops/notify.js';
import { Broker } from '../../mgmt/broker.js';
import { PendingStore, type PendingConfirm } from '../../mgmt/pendingStore.js';
import { HttpApiClient, type Requester } from '../../mgmt/apiClient.js';
import { toolDef } from '../../mgmt/tools.js';
import { safeEqual } from '../../util/safeEqual.js';
import { internalHeaders, ownerIdOf } from '../principal.js';
import { OpsAuthError, setOpsHandlers } from '../../ops/opsServer.js';
import { makeOpsWeb, type OpsWebDeps } from '../../ops/opsWeb.js';
import { opsDoorTools } from '../../ops/opsTools.js';
import { SEARCH_KEY_REF } from '../../orchestrator/lifecycle/provision.js';
import { voiceNetworkHosts } from '../../orchestrator/voice/voiceNetwork.js';
import { keyedLock } from '../../util/queues.js';

/**
 * Where a management agent reaches Hatchabot, and where the cards it files are
 * confirmed.
 *
 * The built-in web chat that used to live here — a Claude-only assistant in the
 * app — was removed in v2.2.0: the Hatchabot agent does that work on any AI
 * source, with a console, a memory and a jail. What it shared with the chat is
 * what remains: the broker, the pending-card store, and the rule that made
 * either surface safe —
 *
 * 1. The agent's key can only READ and PROPOSE. Nothing it says executes.
 * 2. A confirm runs as the signed-in person: the broker's ApiClient dispatches
 *    through app.inject carrying THAT request's own auth headers, so every /v1
 *    call passes normal auth and owner scoping.
 * 3. Cards are server-stored, single-use and TTL'd, and carry the full spec —
 *    a card can never execute more than it showed.
 */

/** Per owner: a broker that acts as whoever is pressing Confirm. */
interface Confirmer {
  broker: Broker;
  setAuth: (req: FastifyRequest) => void;
  /** The card being executed: its calls carry its id, so the model-change ledger knows who prepared it (routes.ts ledgerMeta). */
  setProposal: (id: string | undefined) => void;
}

export interface MgmtChatDeps {
  store: Store;
  secrets: SecretStore;
  /** Test seams for the management agent's web tools. */
  opsWeb?: Partial<OpsWebDeps>;
  /** May this peer address use the management agents' door? (routes.ts) */
  opsPeerOk?: (ip: string) => Promise<boolean>;
  /** Tell the owner's management agent what happened to a change it filed
   *  (routes.ts owns the notifier; see src/ops/notify.ts). */
  notifyOps?: (ownerId: string, body: string) => void;
  /** Push "something is waiting" to the owner's Telegram, through the
   *  management agent's own bot (routes.ts owns it; see src/ops/push.ts). */
  pushOps?: (ownerId: string, headline: string, detail?: string) => void;
  /** Does this request's person own the machine (its Recommended has the machine's budget too; routes.ts ownsLocalHost)? */
  machineOwner?: (req: FastifyRequest) => boolean;
}

/**
 * Cards a confirm was carrying out when the process ended (HB-1053). A confirm
 * marks its card confirmed before the change runs, so that a second tap cannot
 * run it twice; a restart between the two left the card confirmed with no
 * outcome, the change not made, and nothing said: the card was gone from the
 * list and confirming it again was "Already handled". Run at start-up, before
 * anything can confirm, so each one found is a previous process's. Each is
 * told, as a failure is, and never run again: it may have happened in part.
 */
export function markInterruptedConfirms(store: Store): InterruptedConfirm[] {
  return store.markInterruptedMgmtProposals((rec) =>
    `⚠ Interrupted — ${rec.summary ?? rec.tool ?? 'a change'}: Hatchabot restarted while it was carrying this out, so it may not have happened, or only in part. Check, and if it is not done, File it again.`);
}
export type InterruptedConfirm = ReturnType<Store['markInterruptedMgmtProposals']>[number];

/**
 * What the owner's management agent is told at start about their cards a
 * restart cut off (HB-1053; routes.ts `tellInterruptedConfirms`): each one's
 * first line, quoted, since a card's words can come from what the agent read.
 */
export function interruptedConfirmsNote(cards: InterruptedConfirm[]): string {
  const one = cards.length === 1;
  const shown = cards.slice(0, 5).map((c) => `"${quoteOutput(c.summary.split('\n')[0] ?? c.tool, 200)}"`);
  const more = cards.length > shown.length ? ` and ${cards.length - shown.length} more` : '';
  return `Hatchabot restarted while it was carrying out ${one ? 'a change' : `${cards.length} changes`} your owner had confirmed, so ${one ? 'it' : 'they'} may not have happened, or only in part: ${shown.join('; ')}${more}. `
    + `${one ? 'Its card' : 'Their cards'} on the Hatchabot home screen, under Alerts, ${one ? 'says' : 'say'} Interrupted, with a File it again button that files the same change again for them to confirm. Nothing is tried again by itself.`;
}

export function registerMgmtChat(app: FastifyInstance, deps: MgmtChatDeps): void {
  const { store, secrets } = deps;
  const pendingStore = new PendingStore({
    ttlMs: 24 * 3600_000,
    backing: {
      get: (id) => store.getMgmtProposal<PendingConfirm>(id) as PendingConfirm | undefined,
      put: (rec) => store.putMgmtProposal(rec),
      resolve: (id, status) => store.resolveMgmtProposal(id, status, Date.now()),
      sweep: (now) => store.sweepMgmtProposals(now),
    },
  });
  // Nothing called sweep(): cards were kept for ever and overdue ones never
  // marked expired (night review, 2026-09-27). Hourly, off the event loop's books.
  const proposalSweep = setInterval(() => { try { pendingStore.sweep(); } catch { /* next hour */ } }, 3600_000);
  proposalSweep.unref?.();
  app.addHook('onClose', async () => { clearInterval(proposalSweep); });

  /**
   * One broker per owner, for CONFIRMING cards. Not a conversation: it holds
   * no history and no model — it exists so a confirm executes with the auth of
   * the person who pressed it.
   */
  const confirmers = new Map<string, Confirmer>();
  const confirmerFor = (ownerId: string): Confirmer => {
    const existing = confirmers.get(ownerId);
    if (existing) return existing;
    let headers: Record<string, string> = {};
    let proposalId: string | undefined;
    const requester: Requester = async (method, path, body) => {
      const res = await app.inject({
        method: method as 'GET',
        url: path,
        headers: { ...headers, ...(proposalId ? { 'x-hatchabot-proposal': proposalId } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        payload: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const parsed = (() => { try { return res.json(); } catch { return res.body; } })();
      if (res.statusCode >= 400) {
        const msg = parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
          ? (parsed as { error: string }).error
          : `${method} ${path} → ${res.statusCode}`;
        throw new Error(msg);
      }
      return parsed;
    };
    const broker = new Broker(new HttpApiClient(requester), pendingStore, {
      audit: (event, detail) => app.log.info(detail, event),
    });
    const confirmer: Confirmer = {
      broker,
      setAuth: (req) => {
        headers = {};
        const auth = req.headers.authorization;
        const cookie = req.headers.cookie;
        if (typeof auth === 'string') headers.authorization = auth;
        if (typeof cookie === 'string') headers.cookie = cookie;
        const shim = req.headers['x-hatchabot-owner'];
        if (typeof shim === 'string') headers['x-hatchabot-owner'] = shim;
        // A confirm pressed at the public address executes as a public
        // request: the route's class and step-up apply to the change itself.
        Object.assign(headers, publicReplayHeaders(req));
      },
      setProposal: (id) => { proposalId = id; },
    };
    confirmers.set(ownerId, confirmer);
    return confirmer;
  };

  /** The proposer identity for web confirms: owner-scoped broker + a fixed
   *  synthetic chat, so the pending record's user/chat binding is satisfied
   *  without pretending the web is Telegram. */
  const WEB_WHO = { chatId: 0, fromUserId: 0 };

  /** A proposal, enriched with the FULL spec so the web card can show every
   *  byte that would execute — the clipped-preview lesson (audit 2026-09-03)
   *  applied from day one here. */
  const enrich = (confirmId: string, summary: string, inRecommendedList?: Set<string | undefined>) => {
    const rec = pendingStore.peek(confirmId);
    return {
      confirmId,
      summary,
      tool: rec?.tool,
      agentId: rec?.resolved.agentId || undefined,
      createdAtMs: rec?.createdAtMs,
      source: rec?.source ?? 'chat',
      note: rec?.note,
      risk: rec?.risk ?? 'routine',
      expiresAtMs: rec?.expiresAtMs,
      // Filed again (HB-1053): what it says is as of its first filing, and the card says so.
      firstFiledAtMs: rec?.firstFiledAtMs,
      // A cost or model card: shown as a Usage → Recommended item (recommendations.ts), not in the cards list —
      // only while Recommended shows it; on an agent archived since (HB-1095), or merged into an item put off with Not now (HB-1269), it stays here.
      recommended: !!inRecommendedList?.has(confirmId),
      // set_model: the scorecard's evidence and a downgrade's risks, shown on the card.
      check: rec?.resolved.check ? { evidence: rec.resolved.check.evidence, warnings: rec.resolved.check.warnings, downgrade: rec.resolved.check.downgrade } : undefined,
      spec: rec?.resolved.spec
        ? {
            name: rec.resolved.spec.name,
            persona: rec.resolved.spec.persona,
            soul: rec.resolved.spec.soul,
            agentsMd: rec.resolved.spec.agentsMd,
            dockerfile: rec.resolved.spec.dockerfile,
            base: rec.resolved.spec.base,
            fields: rec.resolved.spec.fields,
            diff: rec.resolved.spec.diff,
          }
        : undefined,
    };
  };

  const confirming = keyedLock();
  /** Confirm or cancel a proposal as the signed-in owner. Hatchabot executes
   *  it with THIS request's auth, exactly as if they had done it in a panel. */
  const resolveProposal = async (req: FastifyRequest, reply: import('fastify').FastifyReply, id: string, verb: 'confirm' | 'cancel') => {
    const ownerId = ownerIdOf(req);
    const c = confirmerFor(ownerId); // created on demand: cards outlive a restart
    let rec: PendingConfirm | undefined;
    let out: Awaited<ReturnType<Confirmer['broker']['confirm']>>;
    if (verb === 'cancel') {
      // A cancel runs nothing as anyone: it only claims the card (owner-bound
      // and single-use, PendingStore.claim). Queued with the confirms, it
      // waited for a rebuild being followed for minutes before an unrelated
      // card could be put away (HB-0940). It never touches the confirmer's
      // credentials or card id, which a confirm in progress is using.
      rec = store.getMgmtProposal<PendingConfirm>(id) as PendingConfirm | undefined;
      out = await c.broker.confirm(id, verb, { ...WEB_WHO, ownerId });
    } else {
      // One confirm at a time per owner: the confirmer holds ONE set of
      // credentials, and a second confirm arriving mid-way would swap them under
      // the first (a confirm pressed at the public address could then run with a
      // private one's standing; review, 2026-10-01).
      ({ rec, out } = await confirming.run(ownerId, async () => {
        try {
          c.setAuth(req);
          // Read the card before it resolves: afterwards its author is what tells us
          // whether the management agent is waiting to hear how it went.
          const card = store.getMgmtProposal<PendingConfirm>(id) as PendingConfirm | undefined;
          c.setProposal(id);
          return { rec: card, out: await c.broker.confirm(id, verb, { ...WEB_WHO, ownerId }) };
        } finally {
          c.setProposal(undefined);
        }
      }));
    }
    if (!out.ok) {
      return reply.code(out.reason === 'missing' ? 404 : 409).send({
        error: out.reason === 'expired' ? 'That card expired — ask again.' : out.reason === 'missing' ? 'No such proposal.' : 'Already handled.',
      });
    }
    store.setMgmtProposalOutcome(id, out.text);
    // A card the management agent filed: tell it how it went, in its own chat.
    // Confirming used to be silent there — the owner had to ask it later what
    // had happened (2026-09-19). Only its own cards, so a change the owner made
    // elsewhere does not wake it.
    if (rec?.source === 'agent') {
      // Quoted: the card's words can come from content the agent read, and
      // raw they could close the note's brackets and speak as Hatchabot.
      const headline = quoteOutput(rec.summary.split('\n')[0] ?? rec.tool, 300);
      deps.notifyOps?.(ownerId, verb === 'cancel'
        ? `Your owner cancelled the change you filed: "${headline}". It will not happen.`
        : `Your owner confirmed the change you filed: "${headline}". Hatchabot reports: ${quoteOutput(out.text, 600)}`);
    }
    return { done: out.done, text: out.text };
  };

  // ---- the management agent's door (docs/ops-agent-design.md) --------------
  // Reached only through the ops server, with the agent's propose-only key.
  // Reads run as its owner, in process. Changes are filed as proposals in the
  // owner's "Alerts" list; they execute later, with the auth of
  // whoever presses Confirm — never with anything the agent holds.
  const OPEN_PROPOSALS_CAP = 20;
  const TOO_MANY_OPEN = `There are already ${OPEN_PROPOSALS_CAP} proposals waiting for the owner. Ask them to confirm or cancel some first.`;
  const openProposals = (ownerId: string): number =>
    store.listMgmtProposals<PendingConfirm>(ownerId, Date.now()).filter((p) => p.status === 'pending').length;
  const opsWeb = makeOpsWeb({ braveKey: () => secrets.get(SEARCH_KEY_REF).catch(() => undefined), ...deps.opsWeb });
  const opsBrokers = new Map<string, Broker>();
  const opsBrokerFor = (ownerId: string): Broker => {
    let b = opsBrokers.get(ownerId);
    if (!b) {
      const requester: Requester = async (method, path, body) => {
        const res = await app.inject({
          method: method as 'GET', url: path,
          headers: { ...internalHeaders(ownerId), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          payload: body !== undefined ? JSON.stringify(body) : undefined,
        });
        let parsed: unknown;
        try { parsed = res.json(); } catch { parsed = res.body; }
        if (res.statusCode >= 400) {
          throw new Error(parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
            ? (parsed as { error: string }).error : `${method} ${path} → ${res.statusCode}`);
        }
        return parsed;
      };
      b = new Broker(new HttpApiClient(requester), pendingStore, {
        audit: (event, detail) => app.log.info({ ...detail, via: 'ops-agent' }, event),
        // Counted again as the card is filed: two calls that each saw 19
        // waiting both filed theirs once their agents were resolved (HB-0942).
        admit: (who) => (openProposals(who.ownerId) >= OPEN_PROPOSALS_CAP ? TOO_MANY_OPEN : undefined),
      });
      b.setMode(true);
      opsBrokers.set(ownerId, b);
    }
    return b;
  };

  const opsMcp = async (token: string, message: unknown): Promise<unknown> => {
    const agent = store.opsAgentForToken(token);
    if (!agent) throw new OpsAuthError('unknown key');
    const m = (message ?? {}) as { id?: unknown; method?: string; params?: { name?: unknown; arguments?: unknown; protocolVersion?: string } };
    if (m.id === undefined || m.id === null) return undefined; // a notification
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
    switch (m.method) {
      case 'initialize':
        return ok({ protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hatchabot', version: '1' } });
      case 'ping':
        return ok({});
      case 'tools/list':
        // Change tools take one extra argument, the agent's reason (opsTools.ts).
        return ok({ tools: opsDoorTools() });
      case 'tools/call': {
        const name = String(m.params?.name ?? '');
        const text = (t: string, isError = false) => ok({ content: [{ type: 'text', text: t }], isError });
        // Before anything is resolved, so a full list costs nothing; the broker counts again as it files (admit).
        if (toolDef(name)?.tier === 'mutate' && openProposals(agent.ownerId) >= OPEN_PROPOSALS_CAP) return text(TOO_MANY_OPEN, true);
        const { why, ...args } = (m.params?.arguments ?? {}) as Record<string, unknown>;
        if (name === 'web_search' || name === 'read_result') {
          const out = await opsWeb(agent.ownerId, name, args).catch((e) => ({ text: `Error: ${String((e as Error).message ?? e)}`, isError: true }));
          return text(out.text, out.isError);
        }
        const r = await opsBrokerFor(agent.ownerId).handleTool(name, args, { ownerId: agent.ownerId, ...WEB_WHO, source: 'agent', note: typeof why === 'string' ? why : undefined });
        if (r.ok && 'pending' in r) {
          // The owner may be nowhere near the app. If their management agent
          // has a Telegram bot, say so there — one way, with no approve button:
          // the card is still pressed in Hatchabot, signed in.
          deps.pushOps?.(agent.ownerId,
            `🔑 Your Hatchabot manager has prepared a change and is waiting for you.`,
            r.pending.summary.split('\n')[0]);
          const warned = r.pending.warnings?.length
            ? ` Hatchabot put these risks on the card, for the owner to weigh: ${r.pending.warnings.join(' ')} Say so when you tell them about it.`
            : '';
          return text(`Filed for the owner's approval: "${r.pending.summary.split('\n')[0]}". It is NOT done. It appears under "Alerts" on their Hatchabot home screen and only happens if they press Confirm there. Tell them so; never say it succeeded.${warned}`);
        }
        if (r.ok) return text(JSON.stringify(r.data).slice(0, 12_000));
        // The list filled while this one was being resolved: the same answer as the early check's (HB-0942).
        if (r.error.code === 'TOO_MANY_OPEN') return text(r.error.message, true);
        return text(`Error ${r.error.code}: ${r.error.message}`, true);
      }
      default:
        return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Unknown method ${String(m.method)}` } };
    }
  };

  /** Its text provider, explicitly approved voice provider, and attached chat
   * apps. Voice grants are fixed hosts tied to the current runtime context. */
  const opsAllowedHosts = (token: string): string[] | undefined => {
    const agent = store.opsAgentForToken(token);
    if (!agent) return undefined;
    const vendor = store.getAIProfile(agent.aiProfileId)?.vendor;
    const hosts = vendor === 'openai' ? ['api.openai.com']
      : vendor === 'google' ? ['generativelanguage.googleapis.com']
      : vendor === 'anthropic' ? ['api.anthropic.com']
      : [];
    if (store.getChannelForAgent(agent.id)) hosts.push('api.telegram.org');
    if (store.getChannelForAgent(agent.id, 'discord')) hosts.push('discord.com', 'gateway.discord.gg', 'cdn.discordapp.com', 'media.discordapp.net');
    return [...new Set([...hosts, ...voiceNetworkHosts(store, agent)])];
  };
  // A doorman's key, compared in constant time against every live doorman's.
  const doormanKeyOk = (key: string): boolean => {
    return store.listDoormanKeys().some((x) => safeEqual(x, key));
  };
  setOpsHandlers({ mcp: opsMcp, allowedHosts: opsAllowedHosts, peerOk: deps.opsPeerOk, doormanKeyOk, log: (event, detail) => app.log.info(detail, event) });

  /** The last Recommended build the list could not make, and when it was logged (a plain variable: one reason at a time). */
  let recommendedFailed: { why: string; at: number } = { why: '', at: -Infinity };
  /** Recommended as built, for the cards list, with prune off (only read: the home screen polls the list). Throws as the build does. */
  const recommendedNow = (req: FastifyRequest, ownerId: string) =>
    buildRecommendations(store, ownerId, { machineOwner: deps.machineOwner?.(req) ?? false, prune: false });
  /**
   * Where the home screen shows a waiting card, by the cards list's own rule
   * (GET /v1/proposals): under Usage → Recommended when Recommended, as
   * built, has it, else under Alerts; a build that fails hides no card. The
   * words of File it again said Alerts for every card, a cost or model card
   * too (review of HB-1053).
   */
  const cardPlace = (req: FastifyRequest, ownerId: string, rec: PendingConfirm): 'recommended' | 'alerts' => {
    if (!inRecommended(store, rec)) return 'alerts';
    try { return recommendedNow(req, ownerId).items.some((it) => it.proposalId === rec.id) ? 'recommended' : 'alerts'; } catch { return 'alerts'; }
  };
  const PLACE_WORDS = { recommended: 'under Usage → Recommended', alerts: 'under Alerts' } as const;
  /** The home screen's list: what is waiting for you, and what happened to
   *  the last day's. */
  app.get('/v1/proposals', async (req) => {
    const ownerId = ownerIdOf(req);
    const rows = store.listMgmtProposals<PendingConfirm>(ownerId, Date.now());
    const pending = rows.filter((r) => r.status === 'pending');
    // A card is left out of this list only when Recommended, as built, shows
    // it: one filed for an item the owner had put off with Not now was merged
    // into that hidden item and was in neither list (HB-1269). Built only
    // when some card could be there, and only read: the home screen polls
    // this every few seconds, so it never tidies the stored Not nows. A build
    // that fails hides no card: every card is shown here, and the list stays.
    let shown: Set<string | undefined> | undefined;
    if (pending.some((r) => inRecommended(store, r))) {
      try {
        shown = new Set(recommendedNow(req, ownerId).items.map((it) => it.proposalId));
      } catch (err) {
        // Once a minute for the same reason: the home screen asks every 4 s.
        const why = (err as Error)?.message ?? String(err);
        const at = Date.now();
        if (why !== recommendedFailed.why || at - recommendedFailed.at >= 60_000) {
          recommendedFailed = { why, at };
          app.log.warn({ err: why }, 'proposals.recommended_failed');
        }
      }
    }
    return {
      pending: pending.map((r) => enrich(r.id, r.summary, shown)),
      recent: rows.filter((r) => r.status !== 'pending').slice(0, 10).map((r) => ({
        confirmId: r.id, summary: r.summary.split('\n')[0], status: r.status, outcome: r.outcome, resolvedAtMs: r.resolvedAtMs,
        // A restart cut it off: the home screen offers File it again, until it is (HB-1053).
        ...(r.interrupted ? { interrupted: true, refiled: !!r.refiledAs } : {}),
      })),
    };
  });
  /**
   * File it again (HB-1053): a card a restart cut off becomes a fresh card
   * with the same change, waiting for its owner's Confirm like any other.
   * Nothing runs here, and nothing is ever tried again by itself: the owner
   * checks first whether the change happened. Once per card. Its answer
   * says where the new card is (`where`: cardPlace).
   */
  app.post<{ Params: { id: string } }>('/v1/proposals/:id/again', async (req, reply) => {
    const ownerId = ownerIdOf(req);
    const old = store.getMgmtProposal<PendingConfirm>(req.params.id);
    if (!old || old.ownerId !== ownerId) return reply.code(404).send({ error: 'No such proposal.' });
    if (old.status !== 'confirmed' || !old.interrupted) return reply.code(409).send({ error: 'Only a change a restart cut off can be filed again.' });
    if (old.refiledAs) {
      const card = store.getMgmtProposal<PendingConfirm>(old.refiledAs);
      const waits = card?.status === 'pending' && card.expiresAtMs > Date.now();
      return reply.code(409).send({ error: waits ? `It was filed again already: its card is ${PLACE_WORDS[cardPlace(req, ownerId, card)]}.` : 'It was filed again already, and that card is not waiting any more.' });
    }
    if (openProposals(ownerId) >= OPEN_PROPOSALS_CAP) return reply.code(409).send({ error: `There are already ${OPEN_PROPOSALS_CAP} changes waiting for you. Confirm or cancel some first.` });
    const fresh = store.transact(() => {
      const rec = pendingStore.create({
        ownerId, chatId: old.chatId, fromUserId: old.fromUserId, tool: old.tool, resolved: old.resolved, summary: old.summary,
        source: old.source, note: old.note, risk: old.risk, refiledFrom: old.id, firstFiledAtMs: old.firstFiledAtMs ?? old.createdAtMs,
      }, Math.max(0, old.expiresAtMs - old.createdAtMs));
      if (!store.setMgmtProposalRefiled(old.id, rec.id)) throw new Error('filed again meanwhile');
      // The guard's switch back: the model change's ledger named the card a restart cut off (its guardCard).
      if (old.resolved?.guardOf) store.moveModelChangeGuard(old.resolved.guardOf, old.id, rec.id);
      return rec;
    });
    return { confirmId: fresh.id, summary: fresh.summary.split('\n')[0], where: cardPlace(req, ownerId, fresh) };
  });
  app.post<{ Params: { id: string; verb: string } }>('/v1/proposals/:id/:verb', async (req, reply) => {
    const verb = req.params.verb;
    if (verb !== 'confirm' && verb !== 'cancel') return reply.code(404).send({ error: 'Not found' });
    return resolveProposal(req, reply, req.params.id, verb);
  });
}
