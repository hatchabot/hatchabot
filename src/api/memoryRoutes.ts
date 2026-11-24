import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CompactMode } from '../orchestrator/memory/compaction.js';
import { ownerIdOf, principalOf } from './principal.js';
import { NO_COMPRESS, zodMessage, type RouteContext } from './routeContext.js';
import { publicReplayHeaders } from './trust.js';

/**
 * POST /v1/agents/:id/recover-context (HB-0814): whether the conversation
 * under way is recovered too. Anything but `true` is no, as before: this
 * body never refused anything.
 */
const RecoverContext = z.object({ includeLive: z.unknown().optional() });
/** POST /v1/agents/:id/compact (HB-0814): the mode and the lines to keep, each checked in its own words. */
const Compact = z.object({ mode: z.unknown().optional(), lines: z.unknown().optional() });
/** PUT /v1/agents/:id/context-cap (HB-0814): the cap, checked in its own words (a body without it is no cap given). */
const ContextCap = z.object({ tokens: z.unknown().optional() });
/** POST /v1/agents/:id/ask (HB-0814): what the owner says, made text by the service as before. */
const AskBody = z.object({ text: z.unknown().optional() });
/** POST /v1/agents/:id/distill (HB-0814): what to focus on, or nothing. */
const Distill = z.object({ topic: z.string().nullish() });
/** POST /v1/agents/:id/proposals/:pid/resolve (HB-0814): the verdict, and whether to push a merge to the children. */
const Resolve = z.object({ action: z.enum(['merge', 'dismiss']), push: z.unknown().optional() });

/**
 * An agent's memory and the turns in its conversation: the routes (HB-0808
 * step 13, part 2c). Save the conversation to memory (checkpoint), the chat
 * history and Recover context, compact and the context cap (the token
 * steward), an owner's ask, and a child's distillation with its review on
 * the master. Each route checks who asks and reads the body; the rules are
 * the memory service's (`ctx.memory`, src/orchestrator/memory/). No hook.
 */
export function registerMemoryRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, ownedAgent, runningAgent, busyNow, ledgerMeta } = ctx;
  const { turns, history, steward, proposals } = ctx.memory;

  /**
   * Save the live conversation to memory on demand — the standalone form of the
   * pre-rebuild checkpoint (the service's `checkpoint`). It writes to
   * MEMORY.md/today's file and resets nothing.
   */
  app.post<{ Params: { id: string } }>('/v1/agents/:id/checkpoint', async (req, reply) => {
    const agent = runningAgent(req, req.params.id, reply, 'save its conversation to memory');
    if (!agent) return reply;
    if (busyNow(agent, reply)) return reply;
    const r = await turns.checkpoint(agent);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r.body;
  });

  // ---- chat history (from the agent's own transcript store) ----------------
  // The Telegram Bot API can't read past messages; OpenClaw's session files can,
  // including conversations from before a reset. Owner only.
  app.get<{ Params: { id: string } }>('/v1/agents/:id/transcript', NO_COMPRESS, async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
    const r = await history.transcript(agent);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    const { t, file } = r.body;
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename="${file}"`)
      .header('x-hatchabot-conversations', String(t.conversations))
      .header('x-hatchabot-messages', String(t.messages))
      .header('x-hatchabot-unreadable', String(t.unreadable))
      .send(t.text);
  });

  /** "I have seen it" — stop offering to recover this reset. */
  app.delete<{ Params: { id: string } }>('/v1/agents/:id/context-reset', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    store.clearContextReset(agent.id);
    return { cleared: true };
  });

  /** Restore what a reset made the agent lose: stage its earlier conversations
   *  in its workspace and have it save the durable parts to memory (background;
   *  it confirms in its own chat). */
  app.post<{ Params: { id: string }; Body: { includeLive?: boolean } }>('/v1/agents/:id/recover-context', async (req, reply) => {
    const agent = runningAgent(req, req.params.id, reply, 'recover its earlier conversations');
    if (!agent) return reply;
    if (busyNow(agent, reply)) return reply;
    const includeLive = RecoverContext.safeParse(req.body).data?.includeLive === true;
    const r = await history.recover(agent, includeLive);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    if (!r.body.started) return r.body;
    return reply.code(202).send(r.body);
  });

  // ---- the token steward (docs/features.md, "Token steward") ---------------
  /**
   * Compact one of the agent's conversations (its main one): mode "lines"
   * keeps the last N lines (seconds); "summarise" runs in the background.
   */
  app.post<{ Params: { id: string }; Body: { mode?: string; lines?: number; why?: string } }>('/v1/agents/:id/compact', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const parsed = Compact.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const body = parsed.data;
    const mode: CompactMode | undefined = body.mode === 'lines' ? 'lines' : body.mode === 'summarise' || body.mode === 'summarize' || body.mode === undefined ? 'summarise' : undefined;
    if (!mode) return reply.code(400).send({ error: 'mode is "summarise" or "lines".' });
    if (body.lines !== undefined && (!Number.isInteger(body.lines) || (body.lines as number) < 20 || (body.lines as number) > 5000)) return reply.code(400).send({ error: 'lines: a whole number from 20 to 5000.' });
    const r = await steward.compact(agent, mode, body.lines as number | undefined, ledgerMeta(req, 'compact'));
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r.body;
  });
  /**
   * The agent's context cap: OpenClaw compacts its conversations at about
   * this − 20K (compaction.ts). tokens null takes it away.
   */
  app.put<{ Params: { id: string }; Body: { tokens?: number | null; why?: string } }>('/v1/agents/:id/context-cap', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const raw = ContextCap.safeParse(req.body).data?.tokens;
    const r = await steward.setContextCap(agent, raw, ledgerMeta(req, 'context-cap'));
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r.body;
  });

  // The owner says something to their agent and gets its answer back — the
  // command-line twin of typing in the agent's console. It lands in the same
  // conversation the owner has with it in the app. Owner only: a member talks
  // to an agent through its chat app, where the door decides who is heard.
  app.post<{ Params: { id: string }; Body: { text?: string } }>('/v1/agents/:id/ask', async (req, reply) => {
    await turns.wakeToAsk(ownedAgent(req, req.params.id));
    const agent = runningAgent(req, req.params.id, reply, 'talk to it');
    if (!agent) return reply;
    const r = await turns.ask(agent, AskBody.safeParse(req.body).data?.text, principalOf(req).via, ownerIdOf(req));
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r.body;
  });

  /**
   * Child → master distillation (the return half of the lineage flows): the
   * child's own model writes up its generalizable learning, parked as a
   * proposal on the master for the owner's review.
   */
  app.post<{ Params: { id: string }; Body: { topic?: string } }>(
    '/v1/agents/:id/distill',
    async (req, reply) => {
      const child = runningAgent(req, req.params.id, reply, 'distill its learnings');
      if (!child) return reply;
      const no = proposals.cannotDistill(child);
      if (no) return reply.code(no.status).send({ error: no.error });
      const body = Distill.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: zodMessage(body.error) });
      const r = await proposals.distill(child, body.data.topic ?? '');
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      return reply.code(201).send(r.body);
    },
  );

  app.get<{ Params: { id: string } }>('/v1/agents/:id/proposals', async (req, reply) => {
    const master = ownedAgent(req, req.params.id);
    if (!master) return reply.code(404).send({ error: 'Not found' });
    return { proposals: store.listProposals(master.id) };
  });

  /** Owner's review verdict: merge appends to the master's AGENTS.md under a
   *  "Distilled learnings" section (snapshot first), optionally pushing to
   *  all children; dismiss just closes it. */
  app.post<{ Params: { id: string; pid: string }; Body: { action?: string; push?: boolean } }>(
    '/v1/agents/:id/proposals/:pid/resolve',
    async (req, reply) => {
      const master = ownedAgent(req, req.params.id);
      if (!master) return reply.code(404).send({ error: 'Not found' });
      const parsed = Resolve.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'action must be "merge" or "dismiss".' });
      }
      const body = parsed.data;
      const proposal = store.listProposals(master.id).find((p) => p.id === req.params.pid);
      if (!proposal) return reply.code(404).send({ error: 'No such pending proposal.' });
      if (body.action === 'dismiss') {
        store.resolveProposal(master.id, req.params.pid, 'dismissed');
        return { dismissed: true };
      }
      if (master.state !== 'RUNNING' || !master.runtimeRef) {
        return reply.code(409).send({ error: 'Start the master to merge into its playbook.' });
      }
      if (busyNow(master, reply)) return reply;
      const merged = await proposals.merge(master, proposal);
      if (!merged.ok) return reply.code(merged.status).send({ error: merged.error });
      let pushed = 0;
      if (body.push) {
        const pushRes = await app.inject({
          method: 'POST',
          url: `/v1/agents/${master.id}/push-definition`,
          headers: {
            ...(typeof req.headers.authorization === 'string' ? { authorization: req.headers.authorization } : {}),
            ...(typeof req.headers.cookie === 'string' ? { cookie: req.headers.cookie } : {}),
            ...(typeof req.headers['x-hatchabot-owner'] === 'string' ? { 'x-hatchabot-owner': req.headers['x-hatchabot-owner'] as string } : {}),
            ...publicReplayHeaders(req), // a public caller's replay stays public (trust.ts)
            'content-type': 'application/json',
          },
          payload: '{}',
        });
        if (pushRes.statusCode === 200) pushed = pushRes.json().pushed;
      }
      return { merged: true, pushed };
    },
  );
}
