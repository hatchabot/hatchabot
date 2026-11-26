import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { noteFailure, throttled } from '../signIn/auth.js';
import { ownerIdOf } from '../principal.js';
import { AGENT_GONE, zodMessage, type RouteContext } from '../routeContext.js';

/** POST /v1/agents/:id/env: a variable's name and its value (a secret). */
const AddEnv = z.object({ name: z.string().trim().min(1).max(128), value: z.string().min(1).max(8192) });
/**
 * POST /v1/agents/:id/channel-token (HB-0814): a BotFather token, a
 * hand-built workspace whose bot to reuse, or `webOnly: true`. Text where
 * text is read (a token or a workspace that is not text was a 500); a body
 * that is not an object is read as empty, as before ("token required").
 */
const BotTokenBody = z.object({ token: z.string().nullish(), fromWorkspace: z.string().nullish(), webOnly: z.unknown().optional() });

/**
 * An agent's secrets: the routes (HB-0808 step 15, part C). Its debug
 * gateway's credential, revealed on a click; its environment values; and
 * the bot token its parked setup waits for. Owner only. The rules are the
 * agent secrets service's (`ctx.agentSecrets`,
 * src/orchestrator/agentSecrets/). No hook.
 */
export function registerAgentSecretRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, ownedAgent, agentGone, publicAgent, ownsLocalHost } = ctx;
  const { env, botToken } = ctx.agentSecrets;

  // On-demand Control UI credential — same shape as the bot-token reveal, so
  // the token is fetched by an explicit click, not broadcast in every poll.
  app.get<{ Params: { id: string } }>('/v1/agents/:id/gateway', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent?.gatewayPort || !agent.gatewayToken) {
      return reply.code(404).send({ error: 'This agent has no debug gateway yet — rebuild it.' });
    }
    return { port: agent.gatewayPort, token: agent.gatewayToken };
  });

  // ---- Per-agent environment variables -----------------------------------
  // An API key or config the agent's own tools need, injected at provision.
  // Values are secrets: stored in the SecretStore, never returned, applied on
  // the next rebuild.
  //
  // The name policy is a security boundary shared with the import path —
  // see domain/envPolicy.ts for the reasoning.

  app.post<{ Params: { id: string }; Body: { name?: string; value?: string } }>(
    '/v1/agents/:id/env',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      if (agentGone(agent.id)) return reply.code(409).send({ error: AGENT_GONE });
      const parsed = AddEnv.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
      const { name, value } = parsed.data;
      const r = await env.add(agent, name, value);
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      return publicAgent(store.getAgent(agent.id)!);
    },
  );

  app.delete<{ Params: { id: string; envId: string } }>(
    '/v1/agents/:id/env/:envId',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      const r = await env.remove(agent, req.params.envId);
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      return publicAgent(store.getAgent(agent.id)!);
    },
  );

  // The parked-provisioning resume: user pasted their BotFather token.
  app.post<{ Params: { id: string }; Body: { token?: string; fromWorkspace?: string } }>(
    '/v1/agents/:id/channel-token',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      const raw = req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const body = BotTokenBody.safeParse(raw);
      if (!body.success) return reply.code(400).send({ error: zodMessage(body.error) });
      const r = await botToken.answer(agent, body.data, {
        ownsLocalHost: () => ownsLocalHost(req),
        throttled: () => throttled(req, ownerIdOf(req)),
        noteFailure: () => noteFailure(req, ownerIdOf(req)),
      });
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      return reply.code(202).send(r.body);
    },
  );
}
