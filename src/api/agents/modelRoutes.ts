import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { keptSaid } from '../../orchestrator/lifecycle/memoryLimits.js';
import { assessModelChange } from '../../orchestrator/usage/modelLedger.js';
import { ownModelOverClass } from '../../orchestrator/usage/budgets.js';
import { effectiveModel } from '../../orchestrator/lifecycle/provision.js';
import { VOLUME_GONE } from '../../providers/provider.js';
import { zodMessage, type RouteContext } from '../routeContext.js';

/** POST /v1/agents/:id/model: a model on its source's menu, or null (or nothing) for the source's default. `why` goes to the ledger (ctx.ledgered). */
const SetModel = z.object({ model: z.string().nullish() });

/**
 * An agent's own model: the routes (HB-0807; the check, HB-0808).
 *
 * The route reads its request and words the answer; the checks, the agent's
 * queue of model writes and the class it may leave are the agent settings
 * service's (`ctx.settings`, src/orchestrator/lifecycle/agentSettings.ts).
 */
export function registerModelRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, ownedAgent, ledgered } = ctx;
  const { modelChoiceProblem, applyModelToRuntime } = ctx.settings.models;
  const { detachClassIfDrifted } = ctx.settings.classes;

  // ---- live model change (no rebuild) --------------------------------------
  // OpenClaw reads the model per turn, so `openclaw models set` takes effect on
  // the very next message — no container rebuild or restart. Set the per-agent
  // override in the store (so it's correct on a future rebuild), and apply it
  // live when the agent is RUNNING; a STOPPED/ARCHIVED agent just records it and
  // picks it up when it next starts.
  app.post<{ Params: { id: string }; Body: { model?: string | null } }>(
    '/v1/agents/:id/model',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      const profile = store.getAIProfile(agent.aiProfileId);
      if (!profile) return reply.code(409).send({ error: 'This agent has no AI source.' });
      const parsed = SetModel.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
      const model = (parsed.data.model ?? null) || null;
      // Not on the source's menu (400), or a model Anthropic refuses for the
      // Claude Code version this agent's OpenClaw presents on a subscription
      // (409) — a cleared pin's default included (modelChoiceProblem, HB-0555).
      const problem = await modelChoiceProblem(agent, profile, model);
      if (problem) return reply.code(problem.status).send({ error: problem.error });
      // A class dropped here takes its memory limits with it (HB-0561).
      // Its class still applying a change: it leaves once that is done ('pending').
      // `apply`: its runtime is told next, and the ask for that is stored
      // with the model, so a restart between the two leaves it to the next
      // start rather than to some later rebuild (HB-0809).
      const dropped = await ledgered(req, 'model', [agent.id], () => store.transact(() => {
        // Set by hand after a class ended its budget's switch: it wins for the rest of the month (HB-1477 review).
        if ((store.getAgent(agent.id)?.model ?? null) !== model) ownModelOverClass(store, agent.id);
        store.setAgentModel(agent.id, model, { apply: true });
        return detachClassIfDrifted(agent.id);
      }));
      const classDetached = dropped.detached;
      const applied = effectiveModel(store.getAgent(agent.id)!, profile);
      const how = await applyModelToRuntime(agent.id);
      const kept = keptSaid(agent.name, await dropped.limits);
      // Recorded, but there is nothing to write it to. Said as an error, or the
      // page reads a change that "applies on its next rebuild" (HB-0373).
      if (how === 'gone') return reply.code(409).send({ error: `${VOLUME_GONE} The model is recorded, but a Rebuild would make a fresh, empty volume: find out where its files went first.`, model: applied, volumeGone: true, classDetached, ...kept });
      // failed: the runtime refused it, so the agent still answers on its old
      // model until a retry or a rebuild (the manager said ✅ without it, audit #077).
      return { model: applied, live: how === 'live', staged: how === 'staged', rebuild: how === 'rebuild', failed: how === 'failed', classDetached, ...kept };
    },
  );

  /** What a set_model card for this agent and model should say (the broker asks when it files one). */
  app.get<{ Params: { id: string }; Querystring: { model?: string } }>('/v1/agents/:id/model-check', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const model = String(req.query?.model ?? '').trim();
    if (!model) return reply.code(400).send({ error: 'Which model? Add ?model=…' });
    const profile = store.getAIProfile(agent.aiProfileId);
    // problem: what POST /model would refuse it with, null when it would take it (HB-0597).
    const problem = profile ? (await modelChoiceProblem(agent, profile, model))?.error ?? null : 'This agent has no AI source.';
    return { ...assessModelChange(store, agent, profile, model), problem, ...(profile && profile.vendor !== 'local' ? { offered: [...new Set([profile.model, ...(profile.models ?? [])])] } : {}) };
  });
}
