import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Store } from '../store/store.js';
import type { SecretStore } from '../secrets/secretStore.js';
import { Broker } from '../mgmt/broker.js';
import { PendingStore, type PendingConfirm } from '../mgmt/pendingStore.js';
import { HttpApiClient, type Requester } from '../mgmt/apiClient.js';
import { MANIFEST, toolDef } from '../mgmt/tools.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { internalHeaders, ownerIdOf } from './principal.js';
import { OpsAuthError, setOpsHandlers } from '../ops/opsServer.js';
import { makeOpsWeb, OPS_WEB_TOOLS, type OpsWebDeps } from '../ops/opsWeb.js';
import { SEARCH_KEY_REF } from '../orchestrator/provision.js';

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
    const requester: Requester = async (method, path, body) => {
      const res = await app.inject({
        method: method as 'GET',
        url: path,
        headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
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
      },
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
  const enrich = (confirmId: string, summary: string) => {
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

  /** Confirm or cancel a proposal as the signed-in owner. Hatchabot executes
   *  it with THIS request's auth, exactly as if they had done it in a panel. */
  const resolveProposal = async (req: FastifyRequest, reply: import('fastify').FastifyReply, id: string, verb: 'confirm' | 'cancel') => {
    const ownerId = ownerIdOf(req);
    const c = confirmerFor(ownerId); // created on demand: cards outlive a restart
    c.setAuth(req);
    // Read the card before it resolves: afterwards its author is what tells us
    // whether the management agent is waiting to hear how it went.
    const rec = store.getMgmtProposal<PendingConfirm>(id) as PendingConfirm | undefined;
    const out = await c.broker.confirm(id, verb, { ...WEB_WHO, ownerId });
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
      const headline = rec.summary.split('\n')[0] ?? rec.tool;
      deps.notifyOps?.(ownerId, verb === 'cancel'
        ? `Your owner cancelled the change you filed: "${headline}". It will not happen.`
        : `Your owner confirmed the change you filed: "${headline}". Hatchabot reports: ${out.text.slice(0, 600)}`);
    }
    return { done: out.done, text: out.text };
  };

  // ---- the management agent's door (docs/ops-agent-design.md) --------------
  // Reached only through the ops server, with the agent's propose-only key.
  // Reads run as its owner, in process. Changes are filed as proposals in the
  // owner's "Waiting for you" list; they execute later, with the auth of
  // whoever presses Confirm — never with anything the agent holds.
  const OPEN_PROPOSALS_CAP = 20;
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
      b = new Broker(new HttpApiClient(requester), pendingStore, { audit: (event, detail) => app.log.info({ ...detail, via: 'ops-agent' }, event) });
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
        // Change tools take one extra argument here: the agent's reason, shown
        // to the owner on the card, labelled as the agent's words.
        return ok({ tools: [...MANIFEST.map((t) => ({
          name: t.name, description: t.description,
          inputSchema: t.tier === 'mutate'
            ? { ...t.input_schema, properties: { ...t.input_schema.properties, why: { type: 'string', maxLength: 400, description: 'One or two sentences for the owner: why you propose this.' } } }
            : t.input_schema,
        })), ...OPS_WEB_TOOLS] });
      case 'tools/call': {
        const name = String(m.params?.name ?? '');
        const text = (t: string, isError = false) => ok({ content: [{ type: 'text', text: t }], isError });
        if (toolDef(name)?.tier === 'mutate'
          && store.listMgmtProposals<PendingConfirm>(agent.ownerId, Date.now()).filter((p) => p.status === 'pending').length >= OPEN_PROPOSALS_CAP) {
          return text(`There are already ${OPEN_PROPOSALS_CAP} proposals waiting for the owner. Ask them to confirm or cancel some first.`, true);
        }
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
          return text(`Filed for the owner's approval: "${r.pending.summary.split('\n')[0]}". It is NOT done. It appears under "Waiting for you" on their Hatchabot home screen and only happens if they press Confirm there. Tell them so; never say it succeeded.`);
        }
        if (r.ok) return text(JSON.stringify(r.data).slice(0, 12_000));
        return text(`Error ${r.error.code}: ${r.error.message}`, true);
      }
      default:
        return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Unknown method ${String(m.method)}` } };
    }
  };

  /** Where this agent's container may connect: its AI provider, and Telegram
   *  if it has a bot. Nothing else leaves the jail. */
  const opsAllowedHosts = (token: string): string[] | undefined => {
    const agent = store.opsAgentForToken(token);
    if (!agent) return undefined;
    const vendor = store.getAIProfile(agent.aiProfileId)?.vendor;
    const hosts = vendor === 'openai' ? ['api.openai.com']
      : vendor === 'google' ? ['generativelanguage.googleapis.com']
      : vendor === 'anthropic' ? ['api.anthropic.com']
      : [];
    if (store.getChannelForAgent(agent.id)) hosts.push('api.telegram.org');
    return hosts;
  };
  setOpsHandlers({ mcp: opsMcp, allowedHosts: opsAllowedHosts, peerOk: deps.opsPeerOk, log: (event, detail) => app.log.info(detail, event) });

  /** The home screen's list: what is waiting for you, and what happened to
   *  the last day's. */
  app.get('/v1/proposals', async (req) => {
    const ownerId = ownerIdOf(req);
    const rows = store.listMgmtProposals<PendingConfirm>(ownerId, Date.now());
    return {
      pending: rows.filter((r) => r.status === 'pending').map((r) => enrich(r.id, r.summary)),
      recent: rows.filter((r) => r.status !== 'pending').slice(0, 10).map((r) => ({
        confirmId: r.id, summary: r.summary.split('\n')[0], status: r.status, outcome: r.outcome, resolvedAtMs: r.resolvedAtMs,
      })),
    };
  });
  app.post<{ Params: { id: string; verb: string } }>('/v1/proposals/:id/:verb', async (req, reply) => {
    const verb = req.params.verb;
    if (verb !== 'confirm' && verb !== 'cancel') return reply.code(404).send({ error: 'Not found' });
    return resolveProposal(req, reply, req.params.id, verb);
  });
}
