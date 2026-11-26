import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ownerIdOf } from '../principal.js';
import { zodMessage, type RouteContext } from '../routeContext.js';

/** A body that is an object, or an empty one: what `(req.body ?? {})` read, without the cast (a string or a list read as no fields). */
const fields = (body: unknown): object => (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {});

/** POST /v1/agent-todos (HB-0814): the planned agent's name and a note, both text (or left out; a name or note that is not text was a 500). */
const PlanBody = z.object({ name: z.string().nullish(), note: z.string().nullish() });
/** POST /v1/agents/icons/auto (HB-0814): which agents (up to 200 ids), and whether to pick again for those with one. */
const IconsAuto = z.object({ ids: z.array(z.string()).max(200).optional(), redo: z.unknown().optional() });
/** POST /v1/agents/:id/icons/suggest (HB-0814): the emoji already shown (up to 200), and a short wish. */
const IconIdeasBody = z.object({ exclude: z.array(z.string()).max(200).optional(), want: z.string().max(500).optional() });
/**
 * POST /v1/agents/:id/move (HB-0814): `dir`, or `before` (and `group`), each
 * checked by the service in its own words. `before` counts when it is there,
 * null included.
 */
const MoveBody = z.object({ dir: z.unknown().optional(), before: z.unknown().optional(), group: z.unknown().optional() });
/** POST /v1/groups/sort (HB-0814): a section or all of them, the mode and the direction, each checked by the service in its own words. */
const SortBody = z.object({ group: z.unknown().optional(), all: z.unknown().optional(), mode: z.unknown().optional(), desc: z.unknown().optional() });
/** POST /v1/groups/rename: the group's name and its new one. */
const RenameGroup = z.object({ from: z.string().trim().min(1).max(48), to: z.string().trim().min(1).max(48) });
/** POST /v1/groups/move (HB-0814): the group, and up or down. */
const MoveGroup = z.object({ group: z.string().min(1), dir: z.enum(['up', 'down']) });

/**
 * The home screen: the routes (HB-0808 step 15, part C). The order of the
 * caller's agents and their groups, their icons, and the agents planned for
 * later. Per owner: every route reads the caller's own. The rules are the
 * home screen service's (`ctx.homeScreen`, src/orchestrator/homeScreen/).
 * No hook.
 */
export function registerHomeScreenRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { ownedAgent } = ctx;
  const { order, icons, plans } = ctx.homeScreen;

  // ---- planned agents: a launchpad of agents to create later -----------------
  app.get('/v1/agent-todos', async (req) => ({ todos: plans.list(ownerIdOf(req)) }));
  app.post<{ Body: { name?: string; note?: string } }>('/v1/agent-todos', async (req, reply) => {
    const b = PlanBody.safeParse(fields(req.body));
    if (!b.success) return reply.code(400).send({ error: zodMessage(b.error) });
    const r = plans.add(ownerIdOf(req), b.data);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r.body;
  });
  app.delete<{ Params: { id: string } }>('/v1/agent-todos/:id', async (req, reply) => {
    if (!plans.remove(ownerIdOf(req), req.params.id)) return reply.code(404).send({ error: 'Not found' });
    return { removed: true };
  });

  // Pick home-screen icons (ui v2) for the caller's agents that have none —
  // or, with `redo`, for the named ones. One call to the owner's management
  // AI covers the batch; without one (or if it fails) a keyword table picks.
  // Either way the result is validated to one emoji and a palette colour.
  app.post<{ Body: { ids?: string[]; redo?: boolean } }>('/v1/agents/icons/auto', async (req, reply) => {
    const ownerId = ownerIdOf(req);
    const b = IconsAuto.safeParse(fields(req.body));
    if (!b.success) {
      return reply.code(400).send({ error: 'ids must be a list of agent ids.' });
    }
    const r = await icons.auto(ownerId, b.data, (detail, msg) => req.log.warn(detail, msg));
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r.body;
  });

  // Ideas for one agent's icon (the icon dialog's ✨ button): one AI call for a
  // handful of different emoji, none of those the dialog has already shown.
  // Nothing is saved: the person picks one, and the dialog's Save sets it.
  app.post<{ Params: { id: string }; Body: { exclude?: string[]; want?: string } }>('/v1/agents/:id/icons/suggest', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const b = IconIdeasBody.safeParse(fields(req.body));
    if (!b.success) {
      // The list's words when the list is wrong, as it was checked first.
      if (b.error.issues.some((i) => i.path[0] === 'exclude')) return reply.code(400).send({ error: 'exclude must be a list of emoji.' });
      return reply.code(400).send({ error: 'want must be a short text.' });
    }
    const r = await icons.suggest(agent, ownerIdOf(req), b.data, (detail, msg) => req.log.warn(detail, msg));
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r.body;
  });

  // Reorder an agent. Cosmetic, immediate, no rebuild. Three shapes:
  //   { dir: 'up' | 'down' }       one place within its section
  //   { dir: 'top' | 'bottom' }    to the edge of its section
  //   { before: id | null, group? } drag-and-drop: just before another agent
  //                                 (adopting that agent's section), or the end
  //                                 of `group` ('' = ungrouped) when before is null
  app.post<{ Params: { id: string }; Body: { dir?: string; before?: string | null; group?: string | null } }>(
    '/v1/agents/:id/move',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      const r = order.move(agent, MoveBody.safeParse(fields(req.body)).data ?? {}, (id) => ownedAgent(req, id));
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      return r.body;
    },
  );

  // Sort a section A→Z (group: a name, or '' / null for ungrouped), or every section.
  /**
   * Sort a section, once. `mode: 'name'` is A→Z, `'time'` is earliest→latest,
   * and `desc: true` reverses either — the second press of the same button.
   * Nothing is remembered: this writes the order and stops, so a hand-dragged
   * agent stays where you put it until you ask for a sort again.
   */
  app.post<{ Body: { group?: string | null; all?: boolean; mode?: unknown; desc?: unknown } }>(
    '/v1/groups/sort',
    async (req, reply) => {
      const ownerId = ownerIdOf(req);
      const r = await order.sort(ownerId, SortBody.safeParse(fields(req.body)).data ?? {});
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      return r.body;
    },
  );

  // Reorder a whole group section up/down in the caller's list.
  /** Rename a group: its agents and its place in the order follow. */
  app.post<{ Body: { from?: string; to?: string } }>('/v1/groups/rename', async (req, reply) => {
    const parsed = RenameGroup.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Give the group\'s current name and its new one (up to 48 characters).' });
    const { from, to } = parsed.data;
    const r = order.rename(ownerIdOf(req), from, to);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r.body;
  });
  app.post<{ Body: { group?: string; dir?: string } }>('/v1/groups/move', async (req, reply) => {
    const parsed = MoveGroup.safeParse(fields(req.body));
    if (!parsed.success) {
      return reply.code(400).send({ error: 'group and dir ("up" | "down") are required.' });
    }
    const { group, dir } = parsed.data;
    return order.moveGroup(ownerIdOf(req), group, dir);
  });
}
