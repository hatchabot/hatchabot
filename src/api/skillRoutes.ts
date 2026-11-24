import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CURATED_SKILLS, CuratedSkillSelectionSchema } from '../openclaw/skills.js';
import type { SkillCaller, SkillRefusal } from '../orchestrator/skills/skills.js';
import { zodMessage, type RouteContext } from './routeContext.js';

/** PUT /v1/agents/:id/skills: the library's choices, and nothing else. */
const SaveSkills = z.object({ selected: CuratedSkillSelectionSchema }).strict();
/** POST /v1/agents/:id/skills/:skill/file: a library action, against the revision the preview showed. */
const SkillFileAction = z.object({ action: z.enum(['update', 'replace', 'rollback']), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
/** POST /v1/agents/:id/skills/:skill/try: a practice task, against the revision the preview showed. */
const PracticeSkill = z.object({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/**
 * Curated skills per agent: the routes (HB-0808 step 13).
 *
 * The library (GET and PUT /v1/agents/:id/skills), one instruction file
 * previewed and changed (GET and POST …/skills/:skill/file), a practice task
 * (POST …/skills/:skill/try) and the running agent's inventory (GET
 * …/skills/status). The owner only; never the manager. Each route checks who
 * asks, the skill and the body, in that order as before, then asks the skills
 * service (`ctx.skills`, src/orchestrator/skills/skills.ts), which reads the
 * agent, the caller's session and its context again after each wait. Every
 * answer is `no-store`. No hook.
 */
export function registerSkillRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { ownedAgent, agentGone, watchConsoleHttp } = ctx;
  const skills = ctx.skills;
  /** Who is asking: the agent as they own it at each step, and their session watched from where the service starts it. */
  const callerOf = (req: FastifyRequest, reply: FastifyReply, ownerId: string): SkillCaller => ({
    owned: (agentId) => ownedAgent(req, agentId),
    watch: () => watchConsoleHttp(req, reply, ownerId),
  });
  const refusal = (reply: FastifyReply, r: SkillRefusal) => {
    if (r.retryAfter !== undefined) reply.header('retry-after', r.retryAfter);
    return reply.code(r.status).send({ error: r.error });
  };

  app.get<{ Params: { id: string } }>('/v1/agents/:id/skills', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const agent = ownedAgent(req, req.params.id);
    if (!agent || agentGone(agent.id)) return reply.code(404).send({ error: 'Not found' });
    if (agent.ops) return reply.code(400).send({ error: 'The manager uses Hatchabot’s own tools and instructions.' });
    return skills.view(agent);
  });
  app.put<{ Params: { id: string } }>('/v1/agents/:id/skills', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const agent = ownedAgent(req, req.params.id);
    if (!agent || agentGone(agent.id)) return reply.code(404).send({ error: 'Not found' });
    if (agent.ops) return reply.code(400).send({ error: 'The manager uses Hatchabot’s own tools and instructions.' });
    const parsed = SaveSkills.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const r = skills.save(agent, parsed.data.selected);
    return r.ok ? r.body : refusal(reply, r);
  });

  app.get<{ Params: { id: string; skill: string } }>('/v1/agents/:id/skills/:skill/file', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const agent = ownedAgent(req, req.params.id);
    if (!agent || agentGone(agent.id)) return reply.code(404).send({ error: 'Not found' });
    const skill = CURATED_SKILLS.find((s) => s.id === req.params.skill);
    if (!skill) return reply.code(404).send({ error: 'Skill not found' });
    if (agent.ops) return reply.code(400).send({ error: 'The manager uses its own instructions.' });
    const r = await skills.readFile(agent, skill, callerOf(req, reply, agent.ownerId));
    return r.ok ? r.body : refusal(reply, r);
  });
  app.post<{ Params: { id: string; skill: string } }>('/v1/agents/:id/skills/:skill/file', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const agent = ownedAgent(req, req.params.id);
    if (!agent || agentGone(agent.id)) return reply.code(404).send({ error: 'Not found' });
    if (agent.ops) return reply.code(400).send({ error: 'The manager uses its own instructions.' });
    const parsed = SkillFileAction.safeParse(req.body);
    if (!parsed.success || !CURATED_SKILLS.some((s) => s.id === req.params.skill)) return reply.code(400).send({ error: 'Choose a library action from a fresh skill preview.' });
    const r = await skills.changeFile(agent, req.params.skill, parsed.data, callerOf(req, reply, agent.ownerId));
    return r.ok ? r.body : refusal(reply, r);
  });

  app.post<{ Params: { id: string; skill: string } }>('/v1/agents/:id/skills/:skill/try', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const agent = ownedAgent(req, req.params.id);
    if (!agent || agentGone(agent.id)) return reply.code(404).send({ error: 'Not found' });
    if (agent.ops) return reply.code(400).send({ error: 'The manager uses its own instructions.' });
    const parsed = PracticeSkill.safeParse(req.body);
    if (!parsed.success || !CURATED_SKILLS.some((s) => s.id === req.params.skill)) return reply.code(400).send({ error: 'Open a fresh skill preview before starting practice.' });
    const r = await skills.practice(agent, req.params.skill, parsed.data.expectedRevision, callerOf(req, reply, agent.ownerId));
    return r.ok ? r.body : refusal(reply, r);
  });

  app.get<{ Params: { id: string } }>('/v1/agents/:id/skills/status', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const agent = ownedAgent(req, req.params.id);
    if (!agent || agentGone(agent.id)) return reply.code(404).send({ error: 'Not found' });
    if (agent.ops) return reply.code(400).send({ error: 'The manager uses Hatchabot’s own tools and instructions.' });
    const r = await skills.status(agent, callerOf(req, reply, agent.ownerId));
    return r.ok ? r.body : refusal(reply, r);
  });
}
