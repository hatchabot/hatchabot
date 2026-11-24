import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ownerIdOf } from './principal.js';
import type { RouteContext } from './routeContext.js';

/**
 * PUT /v1/agents/:id/params (HB-0814): the values, or a reset. Each is read
 * as before: `values` is checked by the service in its own words
 * ("Malformed setup values."), `reset` is yes when truthy, and a body that
 * is not an object is read as without either (the service's 400).
 */
const SetupValuesBody = z.object({ values: z.unknown().optional(), reset: z.unknown().optional() });

/**
 * An agent's definition: the routes (HB-0808 step 15, part C). Its setup
 * values applied to its files, and a master's definition pushed to its
 * children. The route finds the agent and checks it is not busy where the
 * old route did; the rules are the definition service's (`ctx.definition`,
 * src/orchestrator/definition/). No hook.
 */
export function registerDefinitionRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { ownedAgent, busyNow } = ctx;
  const { values, push } = ctx.definition;

  /**
   * Edit (or reset) a configured template copy's setup values in place —
   * standing preferences change over time, and a Share→Import round-trip is
   * a terrible way to flip "enable LEAPS". The agent keeps its raw
   * placeholder-bearing layer from import (paramFiles); this re-renders
   * SOUL/AGENTS/persona from it with the new values. A snapshot is taken
   * first, so a re-render over hand-edits is always recoverable.
   */
  app.put<{ Params: { id: string }; Body: { values?: Record<string, string>; reset?: boolean } }>(
    '/v1/agents/:id/params',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
      const ready = values.prepare(agent, SetupValuesBody.safeParse(req.body).data ?? {});
      if (!ready.ok) return reply.code(ready.status).send({ error: ready.error });
      if (busyNow(agent, reply)) return reply;
      const r = await ready.body();
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      return r.body;
    },
  );

  /**
   * Master → children definition push: re-render every RUNNING child's
   * SOUL/AGENTS from the master's CURRENT files, keeping each child's own
   * setup values. Snapshot-first per child, so any push is reversible; the
   * child's MEMORY.md (its lived history) is never touched. A merged
   * proposal's push comes here too (memoryRoutes.ts, by `app.inject`).
   */
  app.post<{ Params: { id: string } }>('/v1/agents/:id/push-definition', async (req, reply) => {
    const master = ownedAgent(req, req.params.id);
    if (!master?.runtimeRef || master.state !== 'RUNNING') {
      return reply.code(409).send({ error: 'Start the master to push its definition.' });
    }
    // The master mid-operation (a restore, a move) has files that are not its
    // definition yet.
    if (busyNow(master, reply)) return reply;
    const r = await push.push(master, ownerIdOf(req), (id) => ownedAgent(req, id));
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r.body;
  });
}
