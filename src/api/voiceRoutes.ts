import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { VoiceCaller } from '../orchestrator/voice/agentVoice.js';
import type { RouteContext } from './routeContext.js';

/** POST /v1/agents/:id/voice: setup takes nothing but an empty object. */
const VoiceSetup = z.object({}).strict();

/**
 * Browser voice: the routes (HB-0808 step 13, docs/voice.md).
 *
 * GET /v1/agents/:id/voice reads whether Talk is ready on the running agent;
 * POST binds Talk to it with the provider its runtime already has. The owner
 * only. Each route checks who asks (and POST its body), then asks the voice
 * service (`ctx.voice`, src/orchestrator/voice/agentVoice.ts), which reads the
 * agent, the caller's session and its context again after each wait. Every
 * answer is `no-store`. No hook.
 */
export function registerVoiceRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { ownedAgent, agentGone, watchConsoleHttp } = ctx;
  const voice = ctx.voice;
  /** Who is asking: the agent as they own it at each step, and their session watched from where the service starts it. */
  const callerOf = (req: FastifyRequest, reply: FastifyReply, ownerId: string): VoiceCaller => ({
    owned: (agentId) => ownedAgent(req, agentId),
    watch: () => watchConsoleHttp(req, reply, ownerId),
  });

  app.get<{ Params: { id: string } }>('/v1/agents/:id/voice', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const agent = ownedAgent(req, req.params.id);
    if (!agent || agentGone(agent.id)) return reply.code(404).send({ error: 'Not found' });
    const r = await voice.status(agent, callerOf(req, reply, agent.ownerId));
    return r.ok ? r.body : reply.code(r.status).send({ error: r.error });
  });

  app.post<{ Params: { id: string } }>('/v1/agents/:id/voice', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const agent = ownedAgent(req, req.params.id);
    if (!agent || agentGone(agent.id)) return reply.code(404).send({ error: 'Not found' });
    if (!VoiceSetup.safeParse(req.body).success) return reply.code(400).send({ error: 'Voice setup accepts an empty object only.' });
    const r = await voice.setup(agent, callerOf(req, reply, agent.ownerId));
    return r.ok ? r.body : reply.code(r.status).send({ error: r.error });
  });
}
