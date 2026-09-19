import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Store } from '../store/store.js';
import type { SecretStore } from '../secrets/secretStore.js';
import { Broker } from '../mgmt/broker.js';
import { PendingStore, type PendingConfirm } from '../mgmt/pendingStore.js';
import { HttpApiClient, type Requester } from '../mgmt/apiClient.js';
import { LlmAgent, type AgentSink, type ChatMessage, type ChatModel } from '../mgmt/llm.js';
import { completeWithProfile, friendlyLlmError, mgmtBackendOf, pickMgmtProfile, runMgmtCompletion, type MgmtChatRequest, type RunCompletionDeps } from './mgmtLlm.js';
import { runCliTurnWithMcp } from './cliChatModel.js';
import { MANIFEST, toolDef } from '../mgmt/tools.js';
import { SYSTEM_PROMPT } from '../mgmt/llm.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { internalHeaders, ownerIdOf } from './principal.js';
import { OpsAuthError, setOpsHandlers } from '../ops/opsServer.js';
import { makeOpsWeb, OPS_WEB_TOOLS, type OpsWebDeps } from '../ops/opsWeb.js';
import { SEARCH_KEY_REF } from '../orchestrator/provision.js';

/**
 * Management Phase C: the web chat pane. The SAME broker that runs the
 * Telegram bot, hosted in-process per owner — the model composes, the broker
 * gates, and mutations become confirmation cards rendered in the web app
 * instead of Telegram. Three properties make this sound:
 *
 * 1. The broker acts AS the signed-in user: its ApiClient dispatches through
 *    app.inject carrying the caller's own auth headers, so every /v1 call
 *    passes normal auth and owner scoping. The chat pane can never do more
 *    than the person typing into it.
 * 2. The LLM runs server-side with the 🛠 Management-flagged source
 *    (mgmtLlm.ts) — same as the Telegram proxy path; no credential moves.
 * 3. Confirmations are the same server-stored, single-use, TTL'd records;
 *    the web card shows the FULL spec (the response carries it verbatim).
 *
 * Sessions are in-memory per owner (history + broker arm-state); a restart
 * clears them, which for a management console is a feature.
 */

interface ChatSession {
  /** What the assistant is doing right now, for the pane's live status line
   *  ("Thinking… 6s", "Checking the runtime… 2s"). Undefined when idle. */
  progress?: { step: string; since: number };
  /** Every step of the current turn, in order, for the pane's step list. */
  steps?: string[];
  broker: Broker;
  llm: LlmAgent;
  history: ChatMessage[];
  /** What the pane renders on reload — display-shaped, capped. Proposal
   *  entries carry the full card so a long turn outliving the HTTP request
   *  (or a page reload) can't lose an unconfirmed card (audit backlog #2). */
  transcript: Array<{
    kind: 'user' | 'assistant' | 'proposal' | 'steps';
    text?: string;
    steps?: string[];
    proposal?: unknown;
    confirmId?: string;
  }>;
  /** One turn at a time: concurrent POSTs raced on `history` and silently
   *  lost whole turns (audit 2026-09-04). */
  busy: boolean;
  setAuth: (req: FastifyRequest) => void;
}

/**
 * Cap history WITHOUT breaking the Messages-API grammar. A blind
 * `slice(-cap)` could start the window on a user message whose content is
 * tool_results referencing a trimmed-off tool_use — a hard 400 that made
 * long api-key sessions permanently broken (audit 2026-09-04). Trim the
 * front to the first plain-text user turn, and the tail back to the last
 * assistant message that isn't awaiting a tool_result.
 */
export function sanitizeHistory(msgs: ChatMessage[], cap: number): ChatMessage[] {
  const hasBlock = (m: ChatMessage, type: string): boolean =>
    Array.isArray(m.content) && m.content.some((b) => (b as { type?: string }).type === type);
  // Tail: never end mid-exchange (assistant tool_use with no result, or a
  // dangling user message the next POST would double up on).
  let end = msgs.length;
  while (end > 0) {
    const m = msgs[end - 1]!;
    if (m.role === 'assistant' && !hasBlock(m, 'tool_use')) break;
    end--;
  }
  const closed = msgs.slice(0, end);
  // Front: after capping, drop until a plain-text user turn opens the window.
  let out = closed.slice(-cap);
  while (out.length && !(out[0]!.role === 'user' && typeof out[0]!.content === 'string')) {
    out = out.slice(1);
  }
  return out;
}

const HISTORY_CAP = 30; // model-side turns kept
const TRANSCRIPT_CAP = 80;
const MAX_SESSIONS = 20;

export interface MgmtChatDeps {
  store: Store;
  secrets: SecretStore;
  /** Test seams — same overrides the Telegram proxy route uses. */
  mgmtLlmComplete?: typeof completeWithProfile;
  mgmtCliComplete?: RunCompletionDeps['cliComplete'];
  /** How the MCP tool server reaches this process (loopback). */
  selfUrl?: string;
  /** Test seam: replaces the whole CLI+MCP turn. Receives the turn token so a
   *  test can play the CLI's part by calling POST /v1/mgmt/mcp itself. */
  mgmtMcpTurn?: (turnToken: string, req: { system: string; messages: unknown[] }) => Promise<string>;
  /** Test seams for the management agent's web tools. */
  opsWeb?: Partial<OpsWebDeps>;
  /** Off switch for the MCP path (falls back to the text protocol). */
  disableMcp?: boolean;
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
  const complete = deps.mgmtLlmComplete ?? completeWithProfile;
  const sessions = new Map<string, ChatSession>();
  /**
   * One database-backed store for every owner's proposals: they survive a
   * restart, list on the home screen, and can be approved from any tab. A day
   * to decide, not two minutes — the list is a to-do, not a popup.
   */
  const pendingStore = new PendingStore({
    ttlMs: 24 * 3600_000,
    backing: {
      get: (id) => store.getMgmtProposal<PendingConfirm>(id) as PendingConfirm | undefined,
      put: (rec) => store.putMgmtProposal(rec),
      resolve: (id, status) => store.resolveMgmtProposal(id, status, Date.now()),
      sweep: (now) => store.sweepMgmtProposals(now),
    },
  });

  /** Live CLI+MCP turns: one-turn token → the session and the turn's sink. */
  const turns = new Map<string, { ownerId: string; session: ChatSession; sink: AgentSink }>();
  const selfUrl = deps.selfUrl ?? `http://127.0.0.1:${process.env.PORT ?? 8080}`;

  /**
   * The MCP tool server's only door. Authenticated by the one-turn token (not
   * a user session, so the auth hooks exempt it) and loopback-only. Goes
   * through the SAME broker as every other path: reads run, changes become
   * cards, forbidden tools don't exist.
   */
  app.post('/v1/mgmt/mcp', async (req, reply) => {
    const ip = req.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') return reply.code(403).send({ error: 'loopback only' });
    const token = String(req.headers['x-hatchabot-turn'] ?? '');
    let turn: { ownerId: string; session: ChatSession; sink: AgentSink } | undefined;
    for (const [k, v] of turns) {
      if (k.length === token.length && timingSafeEqual(Buffer.from(k), Buffer.from(token))) { turn = v; break; }
    }
    if (!turn || !turn.session.busy) return reply.code(401).send({ error: 'That turn is over.' });
    const b = (req.body ?? {}) as { op?: string; name?: unknown; input?: unknown };
    if (b.op === 'list') {
      return { tools: MANIFEST.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) };
    }
    if (b.op !== 'call' || typeof b.name !== 'string') return reply.code(400).send({ error: 'op must be list or call' });
    const r = await turn.session.broker.handleTool(b.name, (b.input ?? {}) as Record<string, unknown>, { ownerId: turn.ownerId, ...WEB_WHO });
    turn.session.progress = { step: 'Thinking about what it found', since: Date.now() };
    if (r.ok && 'pending' in r) {
      await turn.sink.proposeCard(r.pending.confirmId, r.pending.summary);
      return { text: `A confirmation card was posted to the owner for "${r.pending.summary}". This is NOT done yet — the owner must press Confirm. Do not claim it succeeded.` };
    }
    if (r.ok) return { text: JSON.stringify(r.data).slice(0, 6000) };
    return { text: `Error ${r.error.code}: ${r.error.message}`, isError: true };
  });

  // Sweep every session's pending store — the bot process sweeps its own
  // singleton, but these per-owner stores had nobody doing it and resolved
  // authoring cards carry multi-KB specs (audit 2026-09-04).
  setInterval(() => { pendingStore.sweep(); }, 60_000).unref();

  const sessionFor = (ownerId: string): ChatSession => {
    const existing = sessions.get(ownerId);
    if (existing) {
      // LRU touch: re-insert so eviction drops the least-recently-USED owner,
      // not the first-ever-created one.
      sessions.delete(ownerId);
      sessions.set(ownerId, existing);
      return existing;
    }
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    // The caller's auth headers, refreshed on every chat call so the broker
    // always acts as the CURRENT request's principal.
    let headers: Record<string, string> = {};
    const requester: Requester = async (method, path, body) => {
      const res = await app.inject({
        method: method as 'GET',
        url: path,
        headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        payload: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const parsed = (() => {
        try {
          return res.json();
        } catch {
          return res.body;
        }
      })();
      if (res.statusCode >= 400) {
        const msg =
          parsed && typeof parsed === 'object' && typeof (parsed as any).error === 'string'
            ? (parsed as any).error
            : `${method} ${path} → ${res.statusCode}`;
        throw new Error(msg);
      }
      return parsed;
    };
    const api = new HttpApiClient(requester);
    const broker = new Broker(api, pendingStore, {
      audit: (event, detail) => app.log.info(detail, event),
    });
    const setStep = (step: string) => {
      if (!session.busy) return;
      session.progress = { step, since: Date.now() };
      // Tool steps are the story worth keeping; "Thinking" in between isn't.
      if (!/^Thinking/.test(step) && session.steps && session.steps[session.steps.length - 1] !== step) session.steps.push(step);
    };
    // Name each tool as it runs, so a slow step reads as work, not a hang.
    const handle = broker.handleTool.bind(broker);
    broker.handleTool = async (name, args, who) => {
      setStep(toolStep(name));
      return handle(name, args, who);
    };
    const model: ChatModel = {
      create: async (req) => {
        setStep(req.messages.length > 1 ? 'Thinking about what it found' : 'Thinking');
        const profile = pickMgmtProfile(store, ownerId);
        if (!profile) {
          throw new Error(
            'No AI source can back management chat — add an Anthropic source under ⚙ Settings → AI sources.',
          );
        }
        // api-key → direct Messages call; subscription → the Claude CLI on
        // the host. No credential beyond what the fleet already has.
        const resp = await runMgmtCompletion(
          { secrets, apiComplete: complete, cliComplete: deps.mgmtCliComplete },
          profile,
          req as MgmtChatRequest,
        );
        // Wire-shaped blocks; llm.ts only reads type/text/id/name/input,
        // a structural subset.
        return resp as unknown as Awaited<ReturnType<ChatModel['create']>>;
      },
    };
    const session: ChatSession = {
      broker,
      llm: new LlmAgent(model, broker),
      history: [],
      transcript: [],
      busy: false,
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
    sessions.set(ownerId, session);
    return session;
  };

  /** The proposer identity for web confirms: owner-scoped broker + a fixed
   *  synthetic chat, so the pending record's user/chat binding is satisfied
   *  without pretending the web is Telegram. */
  const WEB_WHO = { chatId: 0, fromUserId: 0 };

  /** A proposal, enriched with the FULL spec so the web card can show every
   *  byte that would execute — the clipped-preview lesson (audit 2026-09-03)
   *  applied from day one here. */
  const enrich = (s: ChatSession, confirmId: string, summary: string) => {
    const rec = s.broker.pending.peek(confirmId);
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

  app.get('/v1/mgmt/chat', async (req) => {
    const ownerId = ownerIdOf(req);
    const s = sessions.get(ownerId);
    const profile = pickMgmtProfile(store, ownerId);
    // Annotate proposal entries with their CURRENT confirmability, so a
    // reloaded pane renders live buttons only on still-pending cards.
    const transcript = (s?.transcript ?? []).map((t) =>
      t.kind === 'proposal'
        ? { ...t, pending: !!t.confirmId && s!.broker.pending.peek(t.confirmId)?.status === 'pending' }
        : t,
    );
    return {
      available: !!profile,
      llm: profile ? { model: profile.model, profileName: profile.name } : undefined,
      mode: s?.broker.readWrite ? 'read-write' : 'read-only',
      transcript,
    };
  });

  /** The live status line: what the assistant is doing, and for how long. */
  app.get('/v1/mgmt/chat/progress', async (req) => {
    const s = sessions.get(ownerIdOf(req));
    if (!s?.busy || !s.progress) return { busy: false };
    return { busy: true, step: s.progress.step, elapsedMs: Date.now() - s.progress.since, steps: s.steps ?? [] };
  });

  app.post('/v1/mgmt/chat', async (req, reply) => {
    const parsed = z.object({ message: z.string().trim().min(1).max(8000) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'message required' });
    const ownerId = ownerIdOf(req);
    const s = sessionFor(ownerId);
    if (s.busy) {
      return reply.code(409).send({ error: 'A message is already being answered — wait for the reply.' });
    }
    s.busy = true;
    s.progress = { step: 'Thinking', since: Date.now() };
    s.steps = [];
    s.setAuth(req);
    const texts: string[] = [];
    const proposals: Array<ReturnType<typeof enrich>> = [];
    const sink: AgentSink = {
      say: async (t) => void texts.push(t),
      proposeCard: async (confirmId, summary) => void proposals.push(enrich(s, confirmId, summary)),
    };
    try {
      const profile = pickMgmtProfile(store, ownerId);
      // Tests that stub the text-protocol CLI keep that path; HATCHABOT_MGMT_MCP=0
      // is the operator's off switch.
      const viaMcp = !deps.disableMcp && process.env.HATCHABOT_MGMT_MCP !== '0' && profile &&
        (deps.mgmtMcpTurn || (mgmtBackendOf(profile).kind === 'cli' && !deps.mgmtCliComplete));
      if (viaMcp) {
        // Subscription source: the Claude CLI gets the tools natively over MCP
        // and runs its own multi-step loop; see runCliTurnWithMcp.
        const turnToken = randomBytes(24).toString('hex');
        turns.set(turnToken, { ownerId, session: s, sink });
        try {
          const history = [...s.history, { role: 'user' as const, content: parsed.data.message }];
          const text = deps.mgmtMcpTurn
            ? await deps.mgmtMcpTurn(turnToken, { system: SYSTEM_PROMPT, messages: history })
            : await runCliTurnWithMcp(
                {
                  model: profile!.model,
                  oauthToken: profile!.secretRef ? await secrets.get(profile!.secretRef) : undefined,
                  mcpUrl: selfUrl,
                  turnToken,
                },
                { system: SYSTEM_PROMPT, messages: history as MgmtChatRequest['messages'] },
              );
          if (text.trim()) await sink.say(text.trim());
          const noted = proposals.length ? `\n\n[Cards posted: ${proposals.map((p) => p.summary.split('\n')[0]).join('; ')}]` : '';
          s.history = sanitizeHistory([...history, { role: 'assistant', content: (text.trim() || '(no reply)') + noted }], HISTORY_CAP);
        } finally {
          turns.delete(turnToken);
        }
      } else {
        const msgs = await s.llm.respond({ ownerId, ...WEB_WHO }, parsed.data.message, sink, s.history);
        s.history = sanitizeHistory(msgs, HISTORY_CAP);
      }
    } catch (err) {
      return reply.code(502).send({ error: friendlyLlmError(String((err as Error).message ?? err)) });
    } finally {
      s.busy = false;
      s.progress = undefined;
    }
    const steps = s.steps ?? [];
    s.transcript.push({ kind: 'user', text: parsed.data.message });
    if (steps.length) s.transcript.push({ kind: 'steps', steps });
    for (const t of texts) s.transcript.push({ kind: 'assistant', text: t });
    for (const p of proposals) s.transcript.push({ kind: 'proposal', proposal: p, confirmId: p.confirmId });
    s.transcript = s.transcript.slice(-TRANSCRIPT_CAP);
    return { texts, proposals, steps, mode: s.broker.readWrite ? 'read-write' : 'read-only' };
  });

  app.post('/v1/mgmt/chat/confirm', async (req, reply) => {
    const parsed = z
      .object({ confirmId: z.string().min(1).max(64), verb: z.enum(['confirm', 'cancel']) })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'confirmId and verb required' });
    return resolveProposal(req, reply, parsed.data.confirmId, parsed.data.verb);
  });

  /** Confirm or cancel a proposal as the signed-in owner. Hatchabot executes
   *  it with THIS request's auth, exactly as if they had done it in a panel. */
  const resolveProposal = async (req: FastifyRequest, reply: import('fastify').FastifyReply, id: string, verb: 'confirm' | 'cancel') => {
    const ownerId = ownerIdOf(req);
    const s = sessionFor(ownerId); // created on demand: cards outlive a restart
    s.setAuth(req);
    // Read the card before it resolves: afterwards its author is what tells us
    // whether the management agent is waiting to hear how it went.
    const rec = store.getMgmtProposal<PendingConfirm>(id) as PendingConfirm | undefined;
    const out = await s.broker.confirm(id, verb, { ...WEB_WHO, ownerId });
    if (!out.ok) {
      return reply.code(out.reason === 'missing' ? 404 : 409).send({
        error: out.reason === 'expired' ? 'That card expired — ask again.' : out.reason === 'missing' ? 'No such proposal.' : 'Already handled.',
      });
    }
    store.setMgmtProposalOutcome(id, out.text);
    s.transcript.push({ kind: 'assistant', text: out.text });
    s.transcript = s.transcript.slice(-TRANSCRIPT_CAP);
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
    const s = sessionFor(ownerId);
    const rows = store.listMgmtProposals<PendingConfirm>(ownerId, Date.now());
    return {
      pending: rows.filter((r) => r.status === 'pending').map((r) => enrich(s, r.id, r.summary)),
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

  app.post('/v1/mgmt/chat/mode', async (req, reply) => {
    const parsed = z.object({ readWrite: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'readWrite required' });
    const s = sessionFor(ownerIdOf(req));
    s.broker.setMode(parsed.data.readWrite);
    return { mode: s.broker.readWrite ? 'read-write' : 'read-only' };
  });

  app.delete('/v1/mgmt/chat', async (req) => {
    sessions.delete(ownerIdOf(req));
    return { cleared: true };
  });
}

/** A person-shaped label for a tool while it runs. */
const TOOL_STEPS: Record<string, string> = {
  list_agents: 'Looking at your agents', get_agent: 'Looking at the agent', get_logs: 'Reading its logs',
  get_health: 'Checking its health', get_usage: 'Checking usage', list_events: 'Reading recent activity',
  list_members: 'Checking who can talk to it', list_pending: 'Checking who is waiting to join', get_pool: 'Checking the bot pool',
  get_runtime: 'Checking the runtime version', list_images: 'Looking at images', get_image_log: 'Reading the build log',
  list_base_images: 'Looking at base images', get_base_build: 'Checking the build',
  list_sources: 'Checking AI sources and usage', list_crons: 'Reading its scheduled tasks', list_peers: 'Checking which agents it can ask',
  read_agent_file: 'Reading one of its files', list_snapshots: 'Listing its snapshots', list_backups: 'Listing backups', list_classes: 'Listing classes',
};
export function toolStep(name: string): string {
  if (TOOL_STEPS[name]) return TOOL_STEPS[name]!;
  const words = name.replace(/_/g, ' ');
  return toolDef(name)?.tier === 'read' ? `Looking up ${words}` : `Preparing a card: ${words}`;
}
