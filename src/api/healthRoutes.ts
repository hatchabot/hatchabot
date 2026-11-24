import type { FastifyInstance } from 'fastify';
import type { HealthChecks } from '../orchestrator/health/healthChecks.js';
import { ownerIdOf } from './principal.js';
import { queryLimit, type RouteContext } from './routeContext.js';

/**
 * Health, logs and events: the routes (HB-0808).
 *
 * The server's own liveness (GET /healthz, open to anyone: src/api/auth.ts
 * and src/api/publicRoutes.ts leave it out of the sign-in), an agent's live
 * health (GET /v1/agents/:id/health), its runtime output
 * (GET /v1/agents/:id/logs) and its event trail (GET /v1/agents/:id/events),
 * Activity across the agents the caller can see (GET /v1/events), and the
 * security posture (GET /v1/security/posture).
 *
 * Each route checks who is asking, reads its request and words the answer;
 * the rules are the health service's (`ctx.health`,
 * src/orchestrator/health/healthChecks.ts), which also owns the limits check
 * and its timers. No hook. `app.limitsCheck`, `app.lastLimitsCheck` and
 * `app.diskSweep` (src/index.ts's daily storage measurement, and tests) are
 * set here.
 */
export function registerHealthRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { deps, providerFor, ownedAgent, ownsLocalHost } = ctx;
  const health = ctx.health;
  const hooks = app as unknown as {
    limitsCheck?: HealthChecks['limitsCheck']; lastLimitsCheck?: HealthChecks['lastLimitsCheck']; diskSweep?: HealthChecks['diskSweep'];
  };
  hooks.limitsCheck = health.limitsCheck;
  hooks.lastLimitsCheck = health.lastLimitsCheck;
  hooks.diskSweep = health.diskSweep;

  app.get('/healthz', async () => ({ ok: true }));

  // ---- security posture (config-risk check, runnable on demand) ------------
  app.get('/v1/security/posture', async (req) => health.posture({
    ownerId: ownerIdOf(req),
    isHostOwner: ownsLocalHost(req),
    authMode: deps.authMode ?? 'password',
  }));

  /** The agent's own event trail — what Hatchabot did to it and when, in plain words (the Setup log). */
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/v1/agents/:id/events', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const limit = queryLimit(req.query.limit, 60, 200);
    return health.timeline(agent, limit);
  });

  // Recent runtime output — the "is it alive and what is it doing" view.
  app.get<{ Params: { id: string }; Querystring: { lines?: string } }>(
    '/v1/agents/:id/logs',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
      // Clamp both ends: a negative `?lines` slipped through Math.min into
      // `docker logs --tail -5`, which means "everything".
      const lines = Math.min(Math.max(Math.floor(Number(req.query.lines ?? 80)) || 80, 1), 500);
      const text = await providerFor(agent.hostId).logs(agent.runtimeRef, lines);
      return { text };
    },
  );

  // Live health probe of the agent's own gateway, with when its AI source last
  // answered (the health service's `check`). Running agents only.
  app.get<{ Params: { id: string }; Querystring: { doctor?: string } }>('/v1/agents/:id/health', async (req, reply) => {
    const agent = ctx.runningAgent(req, req.params.id, reply, 'check its health');
    if (!agent) return reply;
    return health.check(agent, req.query.doctor === '1');
  });

  /** Recent activity across every agent the caller can see. */
  app.get<{ Querystring: { limit?: string; agentId?: string } }>('/v1/events', async (req) => {
    // Clamp low too: a negative `?limit` became SQLite `LIMIT -1` (no limit),
    // dumping the whole event table.
    const limit = Math.min(Math.max(Math.floor(Number(req.query.limit ?? 40)) || 40, 1), 200);
    return health.feed(ownerIdOf(req), limit, req.query.agentId);
  });
}
