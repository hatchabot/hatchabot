import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ownerIdOf } from './principal.js';
import { zodMessage, type RouteContext } from './routeContext.js';

/** POST /v1/ops-agent (HB-0814): the AI source to run it on, or none for the default. */
const NewOpsAgent = z.object({ aiProfileId: z.string().nullish() }).nullish();
/** PUT /v1/operator-profile (HB-0814): the operator's "about you", as text; none clears it. */
const OperatorProfile = z.object({ content: z.string().nullish() }).nullish();

/**
 * The Hatchabot agent: the routes (HB-0808).
 *
 * The account's management agent (GET and POST /v1/ops-agent), asking it
 * which agents to add (POST /v1/ops-agent/suggest), and the operator's
 * profile that every agent's AGENTS.md carries (GET and PUT
 * /v1/operator-profile).
 *
 * Each route checks who is asking, reads its request and words the answer;
 * the rules and their state are the Hatchabot agent service's
 * (`ctx.hatchabotAgent`, src/orchestrator/ops/hatchabotAgent.ts). No hook.
 * The door itself (registerMgmtChat, src/api/mgmtChat.ts) stays where it is
 * and asks the service who may use it.
 */
export function registerOpsAgentRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, publicAgent, holdOnce, capProblem } = ctx;
  const ops = ctx.hatchabotAgent;

  /**
   * "Help me decide what agents to add." Hands the management agent the opener
   * and returns; it asks its questions (or reads the fleet and names the gaps)
   * in its own console, and files what the owner wants as ordinary cards.
   */
  app.post('/v1/ops-agent/suggest', async (req, reply) => {
    const ownerId = ownerIdOf(req);
    const r = await ops.suggest(ownerId);
    if (r.kind === 'none') return reply.code(409).send({ error: 'Set up your Hatchabot agent first — it is the one that suggests.' });
    if (r.kind === 'not-running') {
      return reply.code(409).send({ error: `Your Hatchabot agent is ${r.state.toLowerCase()} — start it and try again.` });
    }
    if (r.kind === 'failed') {
      // "It didn't answer" is true but useless. The three things that actually
      // happen — it is mid-turn, the plan is rate-limited, it took too long —
      // each want a different response from the person reading this.
      const why = r.why;
      if (why === 'busy') {
        return reply.code(409).send({ error: 'Your Hatchabot agent is in the middle of something — give it a minute and ask again.' });
      }
      if (/rate.?limit|429|quota/i.test(why)) {
        return reply.code(429).send({ error: 'Your AI source is rate-limited right now — the whole household shares it. Try again shortly.' });
      }
      if (/timed?.?out|timeout/i.test(why)) {
        return reply.code(504).send({ error: 'Your Hatchabot agent took too long to answer. Open it and ask "what am I missing?" directly.' });
      }
      return reply.code(502).send({ error: `Your Hatchabot agent did not answer: ${why.slice(0, 160) || 'no reason given'}` });
    }
    return { asked: true, agentId: r.agentId, slug: r.slug };
  });

  // ---- operator identity profile --------------------------------------------
  app.get('/v1/operator-profile', async (req) => ({ content: store.getOperatorProfile(ownerIdOf(req)) }));

  app.put('/v1/operator-profile', async (req, reply) => {
    const ownerId = ownerIdOf(req);
    const parsed = OperatorProfile.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const content = String(parsed.data?.content ?? '').slice(0, 8000);
    // The push into the running agents is fired and not waited for (the service's setOperatorProfile).
    const { pushing } = ops.setOperatorProfile(ownerId, content);
    return reply.code(202).send({ content, pushing });
  });

  // The account's management agent (docs/ops-agent-design.md): an OpenClaw
  // agent in a network jail, with locked-down tools and a propose-only key.
  // One per account, on this machine, web-only until a bot is added.
  app.get('/v1/ops-agent', async (req) => {
    const a = store.getOpsAgent(ownerIdOf(req));
    return { agent: a ? publicAgent(a) : null };
  });
  app.post('/v1/ops-agent', async (req, reply) => {
    const ownerId = ownerIdOf(req);
    if (!holdOnce(req, `ops-create:${ownerId}`)) return reply.code(409).send({ error: 'Your Hatchabot agent is already being set up.' });
    if (store.getOpsAgent(ownerId)) return reply.code(409).send({ error: 'You already have a Hatchabot agent.' });
    const capErr = capProblem(req);
    if (capErr) return reply.code(429).send({ error: capErr });
    const parsed = NewOpsAgent.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const made = await ops.create(ownerId, parsed.data?.aiProfileId);
    if ('refusal' in made) return reply.code(made.refusal === 'invalid' ? 400 : 409).send({ error: made.error });
    return reply.code(202).send(publicAgent(store.getAgent(made.agent.id)!));
  });
}
