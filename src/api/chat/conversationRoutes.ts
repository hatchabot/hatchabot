import type { FastifyInstance } from 'fastify';
import { ownerIdOf } from '../principal.js';
import type { RouteContext } from '../routeContext.js';

/**
 * An agent's conversations as Hatchabot reads them: the routes (HB-0808 step
 * 13, HB-0826). The unread mark cleared when the console is open (POST
 * /v1/agents/:id/seen) and the home screen's Recent list (GET /v1/recent).
 * The reads, their caches and the Recent capture are the conversations
 * service's (`ctx.conversations`, src/orchestrator/conversation/). No hook,
 * no body.
 */
export function registerConversationRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, visibleAgent, conversations } = ctx;

  // The console is open (or just closed): everything so far counts as read.
  app.post<{ Params: { id: string } }>('/v1/agents/:id/seen', async (req, reply) => {
    const agent = visibleAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'No such agent.' });
    store.setAgentSeen(ownerIdOf(req), agent.id, Date.now());
    return { ok: true };
  });

  /**
   * The home screen's Recent list: the agents this person can open that were
   * active in the last week, each with its last line as they could read it
   * (the service's `recent`). ?all=1 is the whole week.
   */
  app.get<{ Querystring: { all?: string } }>('/v1/recent', async (req) => {
    const me = ownerIdOf(req);
    return conversations.recent(me, req.query.all === '1');
  });
}
