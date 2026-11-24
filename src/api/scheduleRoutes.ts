import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AgentBusyError } from '../orchestrator/lifecycle/busy.js';
import { CronSystemOwnedError } from '../orchestrator/schedules/crons.js';
import type { ScheduleRefusal } from '../orchestrator/schedules/schedules.js';
import { queryLimit, zodMessage, type RouteContext } from './routeContext.js';

/** POST /v1/agents/:id/crons: a new task, on a cron expression or every so many minutes. */
const NewTask = z
  .object({
    name: z.string().trim().min(1).max(80),
    message: z.string().trim().min(1).max(4000),
    // Any length: nine at least refused @daily and the other short nicknames
    // the gateway runs (HB-1018). Its shape is the gateway's to judge, as
    // before: it answers at once, in its own words.
    cron: z.string().trim().min(1).max(64).optional(),
    everyMinutes: z.number().min(0.25).max(60 * 24 * 30).optional(), // 15s floor; 1.5 = every 90s
    tz: z.string().trim().max(64).optional(),
    announce: z.boolean().optional(),
    notify: z.boolean().optional(),
  })
  .refine((b) => !!b.cron !== !!b.everyMinutes, { message: 'give exactly one of cron / everyMinutes' });

/**
 * PATCH /v1/agents/:id/crons/:jobId (HB-0814): an object of fields, each
 * checked below where it always was, in its own words. A body that is not
 * an object has none of them, as it had when it was read as one: it is
 * answered "enabled must be true or false.", as before.
 */
const TaskChange = z.record(z.string(), z.unknown());

/** The fields of an edit in place (PATCH, when any is given). */
const EditTask = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    message: z.string().trim().min(1).max(4000).optional(),
    cron: z.string().trim().min(1).max(64).optional(), // any length, as a new task's (HB-1018)
    everyMinutes: z.number().min(0.25).max(60 * 24 * 30).optional(),
    tz: z.string().trim().max(64).optional(),
  })
  .refine((b) => !(b.cron && b.everyMinutes), { message: 'give at most one of cron / everyMinutes' });

/** A refusal of the service, in its status and words. */
function refuse(reply: FastifyReply, r: ScheduleRefusal): FastifyReply {
  return reply.code({ 'not-found': 404, conflict: 409, failed: 502 }[r.refused]).send({ error: r.error });
}

/**
 * Scheduled tasks: the routes (HB-0808).
 *
 * An agent's tasks (the list, a new one, an edit or a switch on or off, run
 * now, its runs, delete) and the template tasks still waiting (try again).
 * Each route reads its request and words the answer; the rules are the
 * schedules service's (`ctx.schedules.tasks`, src/orchestrator/schedules/).
 * Every one needs the agent RUNNING (`runningAgent`), and a change needs it
 * free (`busyNow`), checked here first, in the order they always were. The
 * sweeps and the event-trigger permission are the service's too, with no
 * route of their own here: PATCH /v1/agents/:id saves the permission.
 */
export function registerScheduleRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { runningAgent, busyNow } = ctx;
  const { tasks } = ctx.schedules;

  app.get<{ Params: { id: string } }>('/v1/agents/:id/crons', async (req, reply) => {
    const agent = runningAgent(req, req.params.id, reply);
    if (!agent) return reply;
    try {
      return await tasks.list(agent);
    } catch (err) {
      app.log.warn({ agent: agent.id, err: String((err as Error).message ?? err) }, 'cron list failed');
      // Not "none": the tasks may be fine; they just couldn't be read.
      return reply.code(503).send({ error: "Couldn't read its scheduled tasks just now — try again in a moment." });
    }
  });

  // Template tasks still waiting (a gateway that refused them at setup): try
  // again now, rather than at the next start, wake or rebuild (HB-0231).
  app.post<{ Params: { id: string } }>('/v1/agents/:id/crons/waiting', async (req, reply) => {
    const agent = runningAgent(req, req.params.id, reply, 'add its waiting tasks');
    if (!agent) return reply;
    try {
      return await tasks.retryWaiting(agent);
    } catch (err) {
      if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
      throw err;
    }
  });

  // The missing verb (audit backlog: "no interface creates a cron"): a
  // definition can DESCRIBE a schedule, but only a real gateway cron fires.
  app.post<{ Params: { id: string } }>('/v1/agents/:id/crons', async (req, reply) => {
    const agent = runningAgent(req, req.params.id, reply, 'add a scheduled task');
    if (!agent) return reply;
    const parsed = NewTask.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    // Like enable, edit and delete: an agent being moved, exported or rebuilt
    // is refused, or the new task lands in a runtime that is going away and
    // never reaches the copy that carries on.
    if (busyNow(agent, reply)) return reply;
    let out: Awaited<ReturnType<typeof tasks.add>>;
    try {
      out = await tasks.add(agent, parsed.data);
    } catch (err) {
      if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
      throw err;
    }
    if ('refused' in out) return refuse(reply, out);
    return reply.code(201).send({ created: true, id: out.id, ...(parsed.data.notify ? { notify: out.noted } : {}) });
  });

  // Enable / disable a task, or change it in place (name, message, schedule).
  // An edit patches only what changed: re-creating the task gave it the
  // owner's chat as its recipient, so one bound to a member's chat or a group
  // started posting to the owner instead.
  app.patch<{ Params: { id: string; jobId: string } }>(
    '/v1/agents/:id/crons/:jobId',
    async (req, reply) => {
      const agent = runningAgent(req, req.params.id, reply);
      if (!agent) return reply;
      const fields = TaskChange.safeParse(req.body ?? {});
      const body: Record<string, unknown> = fields.success ? fields.data : {};
      // Told on the owner's phone when it runs (HB-0537): Hatchabot's own
      // setting, so the task itself is not touched and no CLI starts. A task
      // that is gone, or OpenClaw's own, is forgotten by the next quick pass.
      const notify = body.notify;
      if (notify !== undefined) {
        if (typeof notify !== 'boolean') return reply.code(400).send({ error: 'notify must be true or false.' });
        const jobId = req.params.jobId;
        if (!jobId || jobId.length > 200 || /[\u0000-\u001f]/.test(jobId)) return reply.code(400).send({ error: 'That is not a task id.' });
      }
      if (typeof notify === 'boolean' && !['enabled', 'name', 'message', 'cron', 'everyMinutes', 'tz'].some((k) => body[k] !== undefined)) {
        tasks.setNote(agent, req.params.jobId, notify);
        return { ok: true, notify };
      }
      if (['name', 'message', 'cron', 'everyMinutes', 'tz'].some((k) => body[k] !== undefined)) {
        const parsed = EditTask.safeParse(body);
        if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
        // An edit that also turns it on or off does both (it used to drop the switch).
        if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return reply.code(400).send({ error: 'enabled must be true or false.' });
        const turn = body.enabled as boolean | undefined;
        if (busyNow(agent, reply)) return reply;
        try {
          const out = await tasks.edit(agent, req.params.jobId, parsed.data, turn, notify);
          if ('refused' in out) return refuse(reply, out);
          return out;
        } catch (err) {
          if (err instanceof CronSystemOwnedError) return reply.code(409).send({ error: err.userMessage });
          if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
          throw err;
        }
      }
      const enabled = body.enabled;
      if (typeof enabled !== 'boolean') {
        return reply.code(400).send({ error: 'enabled must be true or false.' });
      }
      if (busyNow(agent, reply)) return reply;
      try {
        const ok = await tasks.setEnabled(agent, req.params.jobId, enabled, notify);
        if (!ok) {
          return reply.code(502).send({ error: `Couldn't ${enabled ? 'enable' : 'disable'} that task — it may no longer exist.` });
        }
        return { ok: true, enabled };
      } catch (err) {
        if (err instanceof CronSystemOwnedError) return reply.code(409).send({ error: err.userMessage });
        if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  // Fire a task now ("test fire"). Its output is delivered the task's own way
  // (e.g. a Telegram announce), so this only reports that it was triggered.
  app.post<{ Params: { id: string; jobId: string } }>(
    '/v1/agents/:id/crons/:jobId/run',
    async (req, reply) => {
      const agent = runningAgent(req, req.params.id, reply);
      if (!agent) return reply;
      if (busyNow(agent, reply)) return reply;
      try {
        const ok = await tasks.runNow(agent, req.params.jobId);
        if (!ok) return reply.code(502).send({ error: "Couldn't run that task — it may no longer exist." });
        return { ok: true };
      } catch (err) {
        if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  // A task's recent runs — what it produced, whether it arrived. The list above
  // says when a task last ran; only this says what it did.
  app.get<{ Params: { id: string; jobId: string }; Querystring: { limit?: string } }>(
    '/v1/agents/:id/crons/:jobId/runs',
    async (req, reply) => {
      const agent = runningAgent(req, req.params.id, reply, 'read its scheduled tasks');
      if (!agent) return reply;
      const limit = queryLimit(req.query.limit, 10, 50);
      try {
        return { runs: await tasks.runs(agent, req.params.jobId, limit) };
      } catch (err) {
        app.log.warn({ agent: agent.id, err: String((err as Error).message ?? err) }, 'cron runs failed');
        // Not "it has not run yet": its runs just couldn't be read.
        return reply.code(503).send({ error: "Couldn't read that task's runs just now — try again in a moment." });
      }
    },
  );

  // Delete a task.
  app.delete<{ Params: { id: string; jobId: string } }>(
    '/v1/agents/:id/crons/:jobId',
    async (req, reply) => {
      const agent = runningAgent(req, req.params.id, reply);
      if (!agent) return reply;
      if (busyNow(agent, reply)) return reply;
      try {
        const ok = await tasks.remove(agent, req.params.jobId);
        if (!ok) return reply.code(502).send({ error: "Couldn't delete that task — it may no longer exist." });
        return { ok: true };
      } catch (err) {
        if (err instanceof CronSystemOwnedError) return reply.code(409).send({ error: err.userMessage });
        if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  // For tests: the two passes, run on demand.
  (app as unknown as { retargetCronSweep?: () => Promise<void> }).retargetCronSweep = ctx.schedules.sweeps.retargetCronSweep;
  (app as unknown as { quickCronRetarget?: () => Promise<void> }).quickCronRetarget = ctx.schedules.sweeps.quickCronRetarget;
}
