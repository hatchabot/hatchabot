import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Store } from '../store/store.js';
import type { SecretStore } from '../secrets/secretStore.js';
import { Broker } from '../mgmt/broker.js';
import { PendingStore } from '../mgmt/pendingStore.js';
import { HttpApiClient, type Requester } from '../mgmt/apiClient.js';
import { LlmAgent, type AgentSink, type ChatMessage, type ChatModel } from '../mgmt/llm.js';
import { completeWithProfile, friendlyLlmError, pickMgmtProfile, runMgmtCompletion, type MgmtChatRequest, type RunCompletionDeps } from './mgmtLlm.js';
import { ownerIdOf } from './principal.js';

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
  broker: Broker;
  llm: LlmAgent;
  history: ChatMessage[];
  /** What the pane renders on reload — display-shaped, capped. */
  transcript: Array<{ kind: 'user' | 'assistant'; text: string }>;
  setAuth: (req: FastifyRequest) => void;
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
}

export function registerMgmtChat(app: FastifyInstance, deps: MgmtChatDeps): void {
  const { store, secrets } = deps;
  const complete = deps.mgmtLlmComplete ?? completeWithProfile;
  const sessions = new Map<string, ChatSession>();

  const sessionFor = (ownerId: string): ChatSession => {
    const existing = sessions.get(ownerId);
    if (existing) return existing;
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
    const broker = new Broker(api, new PendingStore(), {
      audit: (event, detail) => app.log.info(detail, event),
    });
    const model: ChatModel = {
      create: async (req) => {
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
      setAuth: (req) => {
        headers = {};
        const auth = req.headers.authorization;
        const cookie = req.headers.cookie;
        if (typeof auth === 'string') headers.authorization = auth;
        if (typeof cookie === 'string') headers.cookie = cookie;
        const shim = req.headers['x-agentclaw-owner'];
        if (typeof shim === 'string') headers['x-agentclaw-owner'] = shim;
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
    return {
      available: !!profile,
      llm: profile ? { model: profile.model, profileName: profile.name } : undefined,
      mode: s?.broker.readWrite ? 'read-write' : 'read-only',
      transcript: s?.transcript ?? [],
    };
  });

  app.post('/v1/mgmt/chat', async (req, reply) => {
    const parsed = z.object({ message: z.string().trim().min(1).max(8000) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'message required' });
    const ownerId = ownerIdOf(req);
    const s = sessionFor(ownerId);
    s.setAuth(req);
    const texts: string[] = [];
    const proposals: Array<ReturnType<typeof enrich>> = [];
    const sink: AgentSink = {
      say: async (t) => void texts.push(t),
      proposeCard: async (confirmId, summary) => void proposals.push(enrich(s, confirmId, summary)),
    };
    try {
      const msgs = await s.llm.respond({ ownerId, ...WEB_WHO }, parsed.data.message, sink, s.history);
      s.history = msgs.slice(-HISTORY_CAP);
    } catch (err) {
      return reply.code(502).send({ error: friendlyLlmError(String((err as Error).message ?? err)) });
    }
    s.transcript.push({ kind: 'user', text: parsed.data.message });
    for (const t of texts) s.transcript.push({ kind: 'assistant', text: t });
    s.transcript = s.transcript.slice(-TRANSCRIPT_CAP);
    return { texts, proposals, mode: s.broker.readWrite ? 'read-write' : 'read-only' };
  });

  app.post('/v1/mgmt/chat/confirm', async (req, reply) => {
    const parsed = z
      .object({ confirmId: z.string().min(1).max(64), verb: z.enum(['confirm', 'cancel']) })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'confirmId and verb required' });
    const s = sessions.get(ownerIdOf(req));
    if (!s) return reply.code(404).send({ error: 'No chat session — the card may predate a server restart.' });
    s.setAuth(req);
    const out = await s.broker.confirm(parsed.data.confirmId, parsed.data.verb, WEB_WHO);
    if (!out.ok) {
      return reply.code(409).send({
        error: out.reason === 'expired' ? 'That card expired — ask again.' : 'Already handled.',
      });
    }
    s.transcript.push({ kind: 'assistant', text: out.text });
    return { done: out.done, text: out.text };
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
