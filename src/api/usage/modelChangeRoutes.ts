import type { FastifyInstance } from 'fastify';
import { ownerIdOf } from '../principal.js';
import { queryLimit, type RouteContext } from '../routeContext.js';

/**
 * The model steward's two reads: the routes (HB-0808 step 15, part C;
 * docs/features.md, "Right-size"; the scorecard is in usageRoutes.ts). Both
 * come from what Hatchabot already holds — no container is asked anything
 * and no sleeping agent is woken — and both are the caller's own: their
 * agents, the sources they may use. The reads are the model changes
 * service's (`ctx.modelChanges`, src/orchestrator/usage/modelChanges.ts).
 * No hook.
 */
export function registerModelChangeRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { options, changes } = ctx.modelChanges;

  app.get('/v1/model-options', async (req) => options(ownerIdOf(req)));
  /**
   * The model-change ledger (modelLedger.ts): the caller's changes, newest
   * first, with the old model's figures at the change, the new model's a week
   * on and the verdict, plus what the cheaper switches saved this month.
   */
  app.get<{ Querystring: { limit?: string; agent?: string } }>('/v1/model-changes', async (req) => {
    const ownerId = ownerIdOf(req);
    const limit = queryLimit(req.query?.limit, 30, 200);
    const agentRef = req.query?.agent;
    return changes(ownerId, limit, agentRef);
  });
}
