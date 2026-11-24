import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Agent } from '../domain/types.js';
import { ownerIdOf } from './principal.js';
import type { RouteContext } from './routeContext.js';

/** A list of agent ids, as a grant takes it. */
const IdList = z.array(z.string()).max(500);
/** PUT /v1/agents/:id/peers (HB-0814): the agents it may consult, and those it may ask to act. */
const SetPeers = z.object({ peerIds: IdList, allowActions: IdList.optional() });
/** POST /v1/agent-peers/mesh (HB-0814): the selection, and whether to connect or disconnect it. */
const Mesh = z.object({ agentIds: z.array(z.string()), connect: z.boolean() });
/**
 * POST /v1/agents/:id/message (HB-0814): what the caller says. Made text by
 * the service, as before (`String(…)`), so nothing here refuses: a body
 * without it is the empty message, refused after the token and grant checks.
 */
const ConsultBody = z.object({ text: z.unknown().optional() });

/**
 * The agent-to-agent consult and its peers: the routes (HB-0808 step 13).
 * The owner sets which agents an agent may consult (GET and PUT
 * /v1/agents/:id/peers, POST /v1/agent-peers/mesh); the caller agent holds
 * a call token and hits POST /v1/agents/:id/message, which runs a turn on
 * the peer and returns its reply. Same-owner only, grant-gated,
 * depth-limited: the rules are the consult service's (`ctx.consults`,
 * src/orchestrator/consult/). No hook.
 */
export function registerConsultRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { ownedAgent } = ctx;
  const { peers, consult } = ctx.consults;

  /** The owner's view: this agent's granted peers + the pickable candidates. */
  app.get<{ Params: { id: string } }>('/v1/agents/:id/peers', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    return peers.view(agent, ownerIdOf(req));
  });

  /** Owner grants/revokes which agents this one may consult. */
  app.put<{ Params: { id: string }; Body: { peerIds?: string[] } }>(
    '/v1/agents/:id/peers',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      // The list replaces every grant, so only a real list of ids is one: a
      // body without peerIds (or with something else there) was read as an
      // empty list and silently revoked them all (#166). [] still revokes all.
      const body = SetPeers.safeParse(req.body ?? {});
      if (!body.success) {
        if (body.error.issues.some((i) => i.path[0] !== 'allowActions')) return reply.code(400).send({ error: 'Send peerIds: the list of agent ids it may consult ([] for none).' });
        return reply.code(400).send({ error: 'allowActions must be a list of agent ids.' });
      }
      return peers.set(agent, ownerIdOf(req), body.data.peerIds, body.data.allowActions);
    },
  );

  /**
   * Connect (or disconnect) a whole selection of agents to EACH OTHER in one go:
   * every selected agent may consult every other selected agent (grants are
   * one-directional, so n agents = n×(n−1) grants). Existing grants to agents
   * outside the selection are left alone. Returns which agents now need a
   * rebuild — the asking side installs (or removes) the call-agent tool then.
   */
  app.post<{ Body: { agentIds?: string[]; connect?: boolean } }>('/v1/agent-peers/mesh', async (req, reply) => {
    const b = Mesh.safeParse(req.body ?? {});
    if (!b.success) {
      return reply.code(400).send({ error: 'Send agentIds (a list) and connect (true or false).' });
    }
    const ids = [...new Set(b.data.agentIds)];
    if (ids.length < 2) return reply.code(400).send({ error: 'Pick at least two agents to connect to each other.' });
    if (ids.length > 50) return reply.code(400).send({ error: 'At most 50 agents at a time.' });
    const selected: Agent[] = [];
    for (const id of ids) {
      const a = ownedAgent(req, id);
      if (!a) return reply.code(404).send({ error: 'One of those agents was not found.' });
      selected.push(a);
    }
    const r = await peers.mesh(ownerIdOf(req), selected, b.data.connect);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r.body;
  });

  /** Agent-to-agent message: authenticated by the CALLER AGENT's call token
   *  (auth-exempt at the hook; validated here). Runs a turn on the target and
   *  returns its reply. */
  app.post<{ Params: { id: string }; Body: { text?: string } }>('/v1/agents/:id/message', async (req, reply) => {
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    const r = await consult(bearer, req.params.id, ConsultBody.safeParse(req.body).data?.text);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return r.body;
  });
}
