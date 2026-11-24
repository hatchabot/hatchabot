import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { defaultMemoryCap, effectiveMemoryCap, formatMemoryCap, parseMemoryCap } from '../domain/memoryCap.js';
import { formatSwapAllowance, parseSwapAllowance } from '../domain/swap.js';
import { classChangedThrice, classKey, type ClassEdit, type ClassStep } from '../orchestrator/lifecycle/classChanges.js';
import { keptSaid, memoryCapProblem, swapAllowanceProblem } from '../orchestrator/lifecycle/memoryLimits.js';
import { modelOverrideProblem } from '../orchestrator/lifecycle/modelRuntime.js';
import { sixAtATime } from '../util/queues.js';
import { ownerIdOf } from './principal.js';
import { IMAGE_TAG_RE, MACHINE_OWNER_ONLY, zodMessage, type RouteContext } from './routeContext.js';

/** A class's setting as a request names it: a string, or null (and left out) for none. The words are the ones the routes always answered with. */
const setting = z.string({ error: 'a string.' }).nullish();
/** POST /v1/agent-classes. Checked in this order, so the first field that is wrong is the one named. */
const NewClass = z.object({ name: setting, model: setting, aiProfileId: setting, image: setting, memoryCap: setting, swapAllowance: setting });
/**
 * PUT /v1/agent-classes/:id: name, model, aiProfileId, image, memoryCap and
 * swapAllowance, each a string, or null to clear it. Every field sent is
 * held to that, the ones this route does not read included, in the order
 * they were sent: as the route always did.
 */
const ClassEditBody = z.record(z.string(), setting);
/**
 * POST /v1/agents/:id/class. `reviewed`: the class's settings as a
 * confirmation card showed them, compared as they are (a value of any kind).
 */
const JoinClass = z.object({
  classId: z.string().nullish(),
  reviewed: z.record(z.string(), z.unknown(), { error: 'the class settings as shown, or left out.' }).optional(),
});

/**
 * Agent classes (model/source tiers): the routes (HB-0807).
 *
 * Assigning a class writes the agent's source and/or model (via the normal
 * fields) and applies it — model live, a source change needs a rebuild.
 *
 * Each route reads its request and words the answer; the rules, the queues
 * and the holds are the agent settings service's (`ctx.settings`,
 * src/orchestrator/lifecycle/agentSettings.ts), which is the only place
 * their state lives.
 */
export function registerClassRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, ownedAgent, ownsLocalHost, recordLedger } = ctx;
  const { inClassQueue, classEditBegun, classEditEnded, checkClassFor, applyClassToAgent, checkEditMembers, writeClassEdit, asItsClassWroteIt } = ctx.settings.classes;
  const { limitsTold, capMovedFrom } = ctx.settings.limits;
  const { withSourceHold } = ctx.settings.sourceHolds;

  /** A class change's turn, answered: its refusal sent, or its work after the queue run (ClassStep). */
  const classStep = (reply: FastifyReply, step: ClassStep): Promise<unknown> | FastifyReply =>
    'later' in step ? step.later() : reply.code(step.status).send(step.body);
  app.get('/v1/agent-classes', async (req) => ({ classes: store.listAgentClasses(ownerIdOf(req)) }));

  app.post<{ Body: { name?: string; model?: string; aiProfileId?: string; image?: string } }>('/v1/agent-classes', async (req, reply) => {
    // A number where a string belongs used to reach .trim() and answer 500 (audit, 2026-10-23).
    const parsed = NewClass.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const b = parsed.data;
    const name = (b.name ?? '').trim().slice(0, 48);
    if (!name) return reply.code(400).send({ error: 'A class needs a name.' });
    if (store.agentClassByName(ownerIdOf(req), name)) return reply.code(400).send({ error: `There's already a class called "${name}".` });
    // A source, if given, must be the caller's own or shared.
    if (b.aiProfileId) {
      const src = store.getAIProfile(b.aiProfileId);
      if (!src || (src.ownerId !== ownerIdOf(req) && !src.shared)) return reply.code(400).send({ error: 'Unknown AI source.' });
      // A class with its own source: its model is checked as an agent's would be,
      // now, not when the class is first given to an agent (HB-0060).
      const prob = modelOverrideProblem(src, b.model?.trim() || undefined);
      if (prob) return reply.code(400).send({ error: prob });
    }
    const image = b.image?.trim() || undefined;
    if (image && !IMAGE_TAG_RE.test(image)) return reply.code(400).send({ error: 'That image tag is not valid.' });
    if (image && !ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const capIn = b.memoryCap?.trim() || undefined;
    const capCheck = capIn ? memoryCapProblem(capIn, () => ownsLocalHost(req)) : undefined;
    if (capCheck) return reply.code(capCheck.status).send({ error: capCheck.error });
    const swapIn = b.swapAllowance?.trim() || undefined;
    const swapCheck = swapIn ? swapAllowanceProblem(swapIn, capIn ?? defaultMemoryCap(), () => ownsLocalHost(req)) : undefined;
    if (swapCheck) return reply.code(swapCheck.status).send({ error: swapCheck.error });
    const id = randomUUID();
    store.upsertAgentClass({ id, ownerId: ownerIdOf(req), name, model: b.model?.trim() || undefined, aiProfileId: b.aiProfileId || undefined, image, memoryCap: capIn ? formatMemoryCap(parseMemoryCap(capIn)!) : undefined, swapAllowance: swapIn ? formatSwapAllowance(parseSwapAllowance(swapIn)!) : undefined });
    return { class: store.getAgentClass(id) };
  });

  app.put<{ Params: { id: string }; Body: { name?: string; model?: string; aiProfileId?: string; image?: string | null } }>(
    '/v1/agent-classes/:id',
    // In the class's queue: the edit before this one has written every
    // member, so this one reads the class as it left it (HB-0560). Only the
    // records are written there: every check that asks a member's machine
    // (an image pin, the runtime a model needs) is made before the queue is
    // taken (checkClassFor), and each member's container work (its model,
    // its memory limits) runs once the queue is let go, in that agent's own
    // turn, which reads it as it is then. A slow container, or a runner
    // asleep, holds up no other change of the class. In the queue, the
    // checks are used only while they still fit: the class as it was read
    // (`row`) and each member's check for these settings. Otherwise it
    // checks again, three times at most; past that it answers 409 with
    // nothing written (classChangedThrice). Nothing in the queue asks a
    // machine.
    async (req, reply) => {
      // Under way until its records are written (classEditsUnderWay), the checks included.
      classEditBegun(req.params.id);
      let step: ClassStep;
      try {
        for (let attempt = 1; ; attempt++) {
          const last = attempt >= 3;
          const seen = classEditPlan(req);
          if ('status' in seen) return reply.code(seen.status).send(seen.body);
          // The source it moves members to held from this look until they
          // are written (withSourceHold): its delete is refused meanwhile
          // (HB-0570). Members all on it already hold nothing, and the
          // delete says it is in use.
          const moves = seen.aiProfileId && store.listAgentsInClass(seen.cls.id).some((a) => a.state !== 'ARCHIVED' && a.aiProfileId !== seen.aiProfileId) ? seen.aiProfileId : undefined;
          const turn = await withSourceHold(moves, async () => {
            const checks = await checkEditMembers(seen);
            return inClassQueue([req.params.id], async (): Promise<ClassStep | { again: true }> => {
              const plan = classEditPlan(req);
              if ('status' in plan) return plan;
              if (plan.row !== seen.row) return last ? classChangedThrice : { again: true };
              return writeClassEdit(plan, checks, last, (before) => recordLedger(req, 'class', before));
            });
          });
          if ('again' in turn) continue;
          step = turn;
          break;
        }
      } finally {
        classEditEnded(req.params.id);
      }
      return classStep(reply, step);
    },
  );
  /**
   * A class edit as asked (PUT /v1/agent-classes/:id), read against the class
   * as it is now: its new settings, or the refusal to send. Only the store:
   * made before the edit's checks and again in the class's queue, where
   * `row` (the class as read) tells whether it changed in between.
   */
  const classEditPlan = (req: FastifyRequest<{ Params: { id: string } }>): { status: number; body: unknown } | ClassEdit => {
    const cls = store.getAgentClass(req.params.id);
    if (!cls || cls.ownerId !== ownerIdOf(req)) return { status: 404, body: { error: 'Not found' } };
    const parsed = ClassEditBody.safeParse(req.body ?? {});
    if (!parsed.success) return { status: 400, body: { error: zodMessage(parsed.error) } };
    const b = parsed.data;
    // null clears a field, but a class always has a name: null reached .trim() and answered 500 (HB-0596).
    if (b.name === null) return { status: 400, body: { error: 'A class needs a name.' } };
    const name = b.name !== undefined ? (b.name.trim().slice(0, 48) || cls.name) : cls.name;
    let memoryCap = cls.memoryCap;
    if (b.memoryCap !== undefined) {
      const capIn = b.memoryCap?.trim() || undefined;
      const capCheck = capIn ? memoryCapProblem(capIn, () => ownsLocalHost(req)) : undefined;
      if (capCheck) return { status: capCheck.status, body: { error: capCheck.error } };
      memoryCap = capIn ? formatMemoryCap(parseMemoryCap(capIn)!) : undefined;
    }
    let swapAllowance = cls.swapAllowance;
    if (b.swapAllowance !== undefined) {
      const swapIn = b.swapAllowance?.trim() || undefined;
      const swapCheck = swapIn ? swapAllowanceProblem(swapIn, memoryCap ?? defaultMemoryCap(), () => ownsLocalHost(req)) : undefined;
      if (swapCheck) return { status: swapCheck.status, body: { error: swapCheck.error } };
      swapAllowance = swapIn ? formatSwapAllowance(parseSwapAllowance(swapIn)!) : undefined;
    }
    const image = b.image !== undefined ? (b.image?.trim() || undefined) : cls.image;
    if (image && !IMAGE_TAG_RE.test(image)) return { status: 400, body: { error: 'That image tag is not valid.' } };
    if (image && image !== cls.image && !ownsLocalHost(req)) return { status: 403, body: { error: MACHINE_OWNER_ONLY } };
    const clash = store.agentClassByName(cls.ownerId, name);
    if (clash && clash.id !== cls.id) return { status: 400, body: { error: `There's already a class called "${name}".` } };
    const model = b.model !== undefined ? (b.model?.trim() || undefined) : cls.model;
    let aiProfileId = b.aiProfileId !== undefined ? (b.aiProfileId || undefined) : cls.aiProfileId;
    if (aiProfileId) {
      const src = store.getAIProfile(aiProfileId);
      const usable = !!src && (src.ownerId === ownerIdOf(req) || src.shared);
      // Only a source this request names is refused. A stored one that was
      // deleted or un-shared since is dropped: it made every edit of the
      // class (a rename, a model) answer "Unknown AI source" (night review).
      if (!usable && b.aiProfileId !== undefined) return { status: 400, body: { error: 'Unknown AI source.' } };
      if (!usable) aiProfileId = undefined;
      // A model or source this edit names must go together, as on create (HB-0060).
      const prob = usable && (b.model !== undefined || b.aiProfileId !== undefined) ? modelOverrideProblem(src!, model) : undefined;
      if (prob) return { status: 400, body: { error: prob } };
    }
    return { cls, row: JSON.stringify(cls), name, model, aiProfileId, image, memoryCap, swapAllowance, b: { memoryCap: b.memoryCap, swapAllowance: b.swapAllowance } };
  };

  // In the class's queue: an edit still writing finishes first (HB-0560).
  // Its members' containers are changed once the queue is let go, as an edit's are.
  app.delete<{ Params: { id: string } }>('/v1/agent-classes/:id', async (req, reply) => classStep(reply, await inClassQueue([req.params.id], async (): Promise<ClassStep> => {
    const cls = store.getAgentClass(req.params.id);
    if (!cls || cls.ownerId !== ownerIdOf(req)) return { status: 404, body: { error: 'Not found' } };
    const members = store.listAgentsInClass(cls.id);
    store.deleteAgentClass(cls.id); // also clears class_id on its agents (their models are left as-is)
    return { later: async () => {
      // Members without a cap (or swap allowance) of their own ran on the
      // class's: their containers get the limits that now apply, as a class
      // edit does, rather than keep the deleted class's until a rebuild (#148).
      // Six at a time, each in its agent's own turn; said in member order.
      const skipped = cls.memoryCap || cls.swapAllowance ? await sixAtATime(members, async (m) => {
        const out = await limitsTold(m.id, { when: 'its class was deleted', tellIf: capMovedFrom(effectiveMemoryCap(m, cls)) });
        return out.why ? [`${(store.getAgent(m.id) ?? m).name}: ${out.why}`] : [];
      }) : [];
      return { removed: true, skipped: skipped.flat() };
    } };
  })));

  /**
   * Assign (or clear, with classId=null) an agent's class, applying its model/source.
   * `reviewed`: the class's settings as a confirmation card showed them. When
   * the class has changed since, nothing is applied (409): a card reviewed
   * with one model applied another, and its receipt still named the first
   * (audit #097).
   */
  app.post<{ Params: { id: string }; Body: { classId?: string | null; reviewed?: Record<string, string | null> } }>('/v1/agents/:id/class', async (req, reply) => {
    const owned = ownedAgent(req, req.params.id);
    if (!owned) return reply.code(404).send({ error: 'Not found' });
    const parsed = JoinClass.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const classId = parsed.data.classId ?? null;
    const reviewed = parsed.data.reviewed;
    // In the queues of the class it leaves and the one it joins: an edit of
    // either writing now finishes first, and one saved meanwhile waits and
    // then reaches it as a member (HB-0560). The class it leaves is read
    // again once in them: one deleted, or that it left, while this waited
    // (no class now) is no reason to refuse. Moved into another class by a
    // path outside these queues, nothing is written and it says so
    // (setAgentClassIf), as when its own model or source is changed while
    // it joins. The checks that ask its machine are made before the queues
    // are taken (checkClassFor), and used in them while they still fit the
    // class (three tries, then 409 with nothing written); its container
    // (its model, its memory limits) is changed once they are let go, as an
    // edit's members are.
    const changed: ClassStep = { status: 409, body: { error: 'Its class, model or source was changed while this applied. Nothing was changed; ask again.' } };
    for (let attempt = 1; ; attempt++) {
      const last = attempt >= 3;
      const seen = store.getAgent(owned.id);
      if (!seen) return reply.code(404).send({ error: 'Not found' });
      const queued = seen.classId ?? null;
      const seenCls = classId ? store.getAgentClass(classId) : undefined;
      // The source a class moves it to held from this look until it is
      // written (withSourceHold): its delete is refused meanwhile (HB-0570).
      // One already on it holds nothing, and the delete says it is in use.
      const moves = seenCls?.aiProfileId && seenCls.aiProfileId !== seen.aiProfileId ? seenCls.aiProfileId : undefined;
      const step = await withSourceHold(moves, async () => {
        const check = seenCls && seenCls.ownerId === ownerIdOf(req) ? await checkClassFor(seen, seenCls) : undefined;
        return inClassQueue([queued, classId], async (): Promise<ClassStep | { again: true }> => {
          const agent = store.getAgent(owned.id);
          if (!agent) return { status: 404, body: { error: 'Not found' } };
          const from = agent.classId ?? null;
          if (from !== queued && from !== null && from !== classId) return changed;
          // The class's memory cap governs an agent with none of its own: applied
          // to the container now, as a class edit does, not at some later rebuild
          // (night review, 2026-09-28).
          // A container that could not take it keeps its old limits until it is
          // rebuilt: said in memoryPending, not swallowed as applied (#138).
          // The cap it ran on before, to tell it a new budget (HB-0599).
          const capBefore = effectiveMemoryCap(agent, agent.classId ? store.getAgentClass(agent.classId) : undefined);
          const applyCap = async (when: string) => keptSaid(agent.name, await limitsTold(agent.id, { when, tellIf: capMovedFrom(capBefore) }));
          if (classId === null) {
            if (!store.setAgentClassIf(agent.id, from, null)) return changed;
            return { later: async () => ({ classId: null, rebuild: false, ...(await applyCap('it left its class')) }) };
          }
          const cls = store.getAgentClass(classId);
          if (!cls || cls.ownerId !== ownerIdOf(req)) return { status: 404, body: { error: 'No such class.' } };
          if (reviewed) {
            const shown = reviewed;
            // The swap allowance too: it changes the container's memory as the cap does (HB-0558).
            const label = { aiProfileId: 'AI source', model: 'model', image: 'image', memoryCap: 'memory cap', swapAllowance: 'swap allowance' } as const;
            const differ = (Object.keys(label) as Array<keyof typeof label>)
              .filter((k) => k in shown && (shown[k] ?? null) !== (cls[k] ?? null));
            if (differ.length) {
              const value = (k: keyof typeof label) => (k === 'aiProfileId' && cls.aiProfileId
                ? store.getAIProfile(cls.aiProfileId)?.name ?? 'another source'
                : cls[k] ?? 'none');
              const said = differ.map((k) => `${label[k]} ${value(k)}`).join(', ');
              return { status: 409, body: { error: `The class "${cls.name}" changed after this was shown: it now has ${said}. Nothing was changed; ask again to see it as it is.` } };
            }
          }
          // Its check, while it fits the class as it is now; three that did not: nothing written.
          if (check?.for !== classKey(cls, false)) {
            // The source it was checked to move to, deleted meanwhile (past
            // its hold), which takes it off the class too: said, with nothing
            // written, rather than checked again for a class it was not asked to join.
            if (check && !('error' in check) && check.switching && !store.getAIProfile(check.target.id)) return { status: 400, body: { error: "the class's source was deleted meanwhile" } };
            return last ? classChangedThrice : { again: true };
          }
          const r = applyClassToAgent(agent, cls, check, { from, ledger: (before) => recordLedger(req, 'class', before) });
          if (r.changed || r.moved) {
            // Changed by its class, not its owner, since its check (an edit of
            // the class it leaves, written first): checked again, as above.
            if (asItsClassWroteIt(agent.id)) return last ? classChangedThrice : { again: true };
            return changed;
          }
          if (r.error) return { status: 400, body: { error: r.error } };
          return {
            later: async () => {
              const done = r.finish ? await r.finish() : { rebuild: r.rebuild, modelPending: undefined };
              return { classId: cls.id, rebuild: done.rebuild, ...(done.modelPending ? { modelPending: `It joined the class, but ${done.modelPending}.` } : {}), ...(await applyCap('it joined a class')) };
            },
          };
        });
      });
      if ('again' in step) continue;
      return classStep(reply, step);
    }
  });
}
