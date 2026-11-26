import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Agent } from '../../domain/types.js';
import { REBUILD_POLICIES, rebuildPolicy, type RebuildPolicy } from '../../domain/rebuildPolicy.js';
import { canTransition } from '../../domain/stateMachine.js';
import { AgentBusyError } from '../../orchestrator/lifecycle/busy.js';
import { machineTz, monthKey } from '../../orchestrator/usage/budgets.js';
import { NoLongerSleepy } from '../../orchestrator/lifecycle/hibernate.js';
import type { AgentLifecycle } from '../../orchestrator/lifecycle/agentLifecycle.js';
import { AgentEditBody } from '../../orchestrator/lifecycle/agentEdits.js';
import { MAX_REBUILD_CONCURRENCY } from '../../orchestrator/lifecycle/rebuildQueue.js';
import { snapshotModels } from '../../orchestrator/usage/modelLedger.js';
import { publicOperation, settleStartsOwedOn } from '../../orchestrator/lifecycle/operations.js';
import { RecoverError } from '../../orchestrator/lifecycle/operationsResume.js';
import { ownerIdOf } from '../principal.js';
import { MACHINE_OWNER_ONLY, queryLimit, zodMessage, type RouteContext } from '../routeContext.js';
import { isPublic } from '../trust.js';

/**
 * POST /v1/agents/:id/rebuild. `checkpoint`: summarise a running agent's live
 * conversation into MEMORY.md first. `stoppedWaits`: a rebuild to apply a
 * change just made, so a stopped agent keeps it for its next start. No body
 * is a plain rebuild (HB-0814).
 */
const RebuildBody = z.object({ checkpoint: z.boolean().nullish(), stoppedWaits: z.boolean().nullish() }).nullish();
/** POST /v1/operations/:id/recover: the owner's choice, one of the operation's recovery actions. */
const RecoverBody = z.object({ action: z.string().min(1).max(32) });

const CreateAgent = z.object({
  name: z.string().trim().min(1).max(64),
  persona: z.string().max(4000).optional(),
  aiProfileId: z.string().min(1),
  hostId: z.string().min(1),
  sharedMemory: z.boolean().optional(),
  /** Optional per-agent model override, chosen from the profile's menu. */
  model: z.string().min(1).max(64).optional(),
  /** Telegram user ids to admit without pairing — carried from an adopted
   *  agent, so the people already talking to it are not made to knock. */
  seedMembers: z.array(z.string().regex(/^\d{1,32}$/)).max(32).optional(),
  /** Owner unchecked "use a pool bot": walk BotFather even if the pool has
   *  bots (they want a bespoke @handle for this agent). */
  skipPool: z.boolean().optional(),
  /** false = no Telegram bot: talked to only through Hatchabot. Default true. */
  telegram: z.boolean().optional(),
});

/**
 * The agent lifecycle's routes (HB-0808 step 11): the rebuild policy and how
 * many rebuild at once, the long operations and the owner's choice for a held
 * one, and Rebuild, Retry setup, Stop, Start, sleep and wake. The rules are
 * the agent lifecycle service's (src/orchestrator/lifecycle/agentLifecycle.ts,
 * `ctx.lifecycle`); who may ask, the first checks and the words of each answer
 * are here. Registered once, where GET /v1/rebuild-policy stood in routes.ts.
 * Last, PATCH /v1/agents/:id, an agent's own settings (HB-0825), whose rules
 * are the agent edits service's (src/orchestrator/lifecycle/agentEdits.ts,
 * `ctx.agentEdits`).
 */
export function registerLifecycleRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, trace, ownedAgent, visibleAgent, ownsLocalHost, movedAway, busyNow, publicAgent, capProblem, capRowMade, holdOnce, kickProvision, kickRebuild, oweRebuild, recordLedger } = ctx;
  const { startStopped, stopRunning, hibernate, wake, sleepView } = ctx.lifecycle.power;
  const { records } = ctx.lifecycle;

  // ---- agents ---------------------------------------------------------------

  app.post('/v1/agents', async (req, reply) => {
    const parsed = CreateAgent.safeParse(req.body);
    if (!parsed.success) {
      // A new account with nothing shared to it hits this first, and
      // "aiProfileId: expected string, received undefined" is a dead end.
      // Name the actual situation instead.
      if (/aiProfileId/.test(zodMessage(parsed.error)) && store.listAIProfiles(ownerIdOf(req)).length === 0) {
        return reply.code(400).send({
          error: 'No AI source is available to your account yet. Ask whoever runs this server to share one with you (⚙ Settings → AI sources → Shared), or add your own API key there.',
        });
      }
      return reply.code(400).send({ error: zodMessage(parsed.error) });
    }
    const ownerId = ownerIdOf(req);
    // The checks, in their order, and the record (agentRecords.ts create).
    const made = records.create(ownerId, parsed.data, { capProblem: () => capProblem(req), holdName: (key) => holdOnce(req, key) });
    // Its row counts itself now, not beside the request's place (HB-1121).
    capRowMade(req);
    if (!made.ok) return reply.code(made.status).send({ error: made.error });
    return reply.code(202).send(made.agent);
  });

  app.get<{ Querystring: { all?: string } }>('/v1/agents', async (req, reply) => {
    // ?all=1: the HOST OWNER's admin view — every user's agents, with their
    // ownerId, so orphans from other logins (an old test account's leftovers)
    // are findable and cleanable. Listing metadata only: memory, files, and
    // conversations stay behind the per-agent ownership checks as always.
    const all = req.query.all === '1';
    if (all && !ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    return ctx.lifecycle.list.view(ownerIdOf(req), { all, machineOwner: () => ownsLocalHost(req) });
  });

  app.get<{ Params: { id: string } }>('/v1/agents/:id', async (req, reply) => {
    const agent = visibleAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const channel = store.getChannelForAgent(agent.id);
    const role = store.accessRole(agent.id, ownerIdOf(req));
    return publicAgent(agent, {
      role,
      deepLink: channel?.deepLink,
      // As the list says it: the CLI names the bot an agent is on.
      botUsername: channel?.accountId,
      // Members see declarations, never the owner's applied answers.
      ...(role === 'owner' ? {} : { paramValues: undefined }),
    });
  });

  /**
   * Archive: keep the agent, give the bot back. See orchestrator/lifecycle/archive.ts —
   * bot tokens are the capped resource, so this is how a fleet outgrows the
   * number of bots one Telegram account may own.
   */
  app.post<{ Params: { id: string }; Body: { checkpoint?: boolean } }>('/v1/agents/:id/archive', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    if (movedAway(agent, reply)) return reply;
    // A second tap while the first is still saving its conversation.
    if (records.isArchiving(agent.id)) return reply.code(409).send({ error: 'It is already being archived.' });
    if (busyNow(agent, reply)) return reply;
    if (!canTransition(agent.state, 'ARCHIVED')) {
      return reply.code(409).send({ error: `Cannot archive while ${agent.state.toLowerCase()}.` });
    }
    const checkpoint = req.body?.checkpoint === true && agent.state === 'RUNNING' && !!agent.runtimeRef;
    // The marker, the waits and the archive (agentRecords.ts archive). Its
    // answer is made before the marker goes.
    const archived = await records.archive(agent, { checkpoint, requestedBy: ownerIdOf(req) }, ({ checkpointWarning, botReturn }) =>
      // Done: the marker (cleared below) is not part of the answer. Where its
      // bot went, as it happened (HB-0476): null when it had none to give back.
      ({ ...publicAgent(store.getAgent(agent.id)!), archiving: undefined, checkpointWarning, botReturn }));
    return archived.ok ? archived.value : reply.code(archived.status).send({ error: archived.error });
  });

  /**
   * Restore: lease a bot again and boot. This is a re-provision, not a start —
   * the agent has no messaging identity at all while archived, and the one it
   * gets back will be a DIFFERENT bot with a different link.
   */
  app.post<{ Params: { id: string } }>('/v1/agents/:id/restore', async (req, reply) => {
      { const capErr = capProblem(req); if (capErr) return reply.code(429).send({ error: capErr }); }
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    if (movedAway(agent, reply)) return reply;
    if (busyNow(agent, reply)) return reply;
    if (agent.state !== 'ARCHIVED') {
      return reply.code(409).send({ error: 'That agent is not archived.' });
    }
    if (!holdOnce(req, `restore:${agent.id}`)) return reply.code(409).send({ error: 'It is already being brought back.' });
    // Its parked bots, PROVISIONING, then setup (agentRecords.ts restore).
    const restored = await records.restore(agent, () => publicAgent(store.getAgent(agent.id)!));
    // Counted by its own row again, not beside the request's place (HB-1121).
    capRowMade(req);
    return reply.code(202).send(restored);
  });

  type DeleteRoute = { Params: { id: string }; Querystring: { recycleBot?: string } };
  app.delete<DeleteRoute>('/v1/agents/:id', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent || agent.state === 'DELETED') return deleteAgent(req, reply);
    if (records.isDeleting(agent.id)) return reply.code(409).send({ error: 'It is being deleted already: wait for that to finish.' });
    return records.whileDeleting(agent.id, () => deleteAgent(req, reply));
  });
  const deleteAgent = async (req: FastifyRequest<DeleteRoute>, reply: FastifyReply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    // Fully gone — say so. A DELETING agent, by contrast, is a delete that was
    // interrupted (destroy threw, or the process was killed mid-teardown); we
    // let a retry RE-ENTER and finish it, rather than 404-ing it into a
    // permanent tombstone with secrets un-scrubbed and the bot never released.
    if (agent.state === 'DELETED') {
      return reply.code(404).send({ error: 'Not found' });
    }
    // A migrate/adopt/import mid-flight: refuse rather than wait — those run
    // for minutes, and purging the volume under an in-progress export is loss.
    // An adopt held on a torn copy is not one: its files go with the volume.
    if (busyNow(agent, reply, { deleting: true })) return reply;
    // The waits, the teardown and the tombstone (agentRecords.ts remove).
    const gone = await records.remove(agent, { recycleBot: req.query.recycleBot }, (tombstone) => publicAgent(tombstone));
    return gone.ok ? gone.value : reply.code(gone.status).send({ error: gone.error });
  };

  // Machine settings, read as they are set: by the machine owner (HB-0061).
  // A member's page has rebuildConcurrency in /v1/config.
  app.get('/v1/rebuild-policy', async (req, reply) => (!ownsLocalHost(req) ? reply.code(403).send({ error: MACHINE_OWNER_ONLY }) : {
    policy: rebuildPolicy(),
    policies: REBUILD_POLICIES,
    quietHours: process.env.HATCHABOT_REBUILD_QUIET_HOURS ?? '3-5',
  }));
  /** How many rebuilds run at once on this machine (the rest wait their turn). Owner-set; lives in .env. */
  app.get('/v1/rebuild-concurrency', async (req, reply) => (!ownsLocalHost(req) ? reply.code(403).send({ error: MACHINE_OWNER_ONLY })
    : ctx.lifecycle.rebuilds.concurrencyView()));
  app.put<{ Body: { atOnce?: unknown } }>('/v1/rebuild-concurrency', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const n = Number(req.body?.atOnce);
    if (!Number.isInteger(n) || n < 1 || n > MAX_REBUILD_CONCURRENCY) return reply.code(400).send({ error: `atOnce must be a whole number from 1 to ${MAX_REBUILD_CONCURRENCY}` });
    const wrote = await ctx.lifecycle.rebuilds.setAtOnce(n);
    if (!wrote.ok) return reply.code(409).send({ error: wrote.error ?? 'Could not write .env' });
    return { atOnce: n };
  });

  app.put<{ Body: { policy?: string } }>('/v1/rebuild-policy', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const policy = req.body?.policy;
    if (!policy || !(REBUILD_POLICIES as string[]).includes(policy)) {
      return reply.code(400).send({ error: `policy must be one of: ${REBUILD_POLICIES.join(', ')}` });
    }
    const wrote = await ctx.lifecycle.rebuilds.setPolicy(policy as RebuildPolicy);
    if (!wrote.ok) return reply.code(409).send({ error: wrote.error ?? 'Could not write .env' });
    return { policy: policy as RebuildPolicy };
  });

  // For tests: one pass of the machine's own rebuilds.
  (app as unknown as { rebuildSweep?: AgentLifecycle['rebuilds']['rebuildSweep'] }).rebuildSweep = ctx.lifecycle.rebuilds.rebuildSweep;

  /** An operation the caller may see: on an agent they own. Members see nothing. */
  const ownedOperation = (req: FastifyRequest, id: string) => {
    const op = store.getOperation(id);
    if (!op?.agentId || !ownedAgent(req, op.agentId)) return undefined;
    return op;
  };
  app.get<{ Querystring: { agentId?: string; limit?: string } }>('/v1/operations', async (req, reply) => {
    const limit = queryLimit(req.query.limit, 50, 200);
    if (req.query.agentId) {
      const agent = ownedAgent(req, req.query.agentId);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      return { operations: store.listOperations([agent.id], limit).map((o) => publicOperation(o)) };
    }
    const ids = store.listAgents(ownerIdOf(req)).filter((a) => a.ownerId === ownerIdOf(req)).map((a) => a.id);
    return { operations: store.listOperations(ids, limit).map((o) => publicOperation(o)) };
  });
  app.get<{ Params: { id: string } }>('/v1/operations/:id', async (req, reply) => {
    const op = ownedOperation(req, req.params.id);
    if (!op) return reply.code(404).send({ error: 'Not found' });
    return publicOperation(op);
  });
  app.post<{ Params: { id: string } }>('/v1/operations/:id/recover', async (req, reply) => {
    const op = ownedOperation(req, req.params.id);
    if (!op) return reply.code(404).send({ error: 'Not found' });
    const action = RecoverBody.safeParse(req.body);
    if (!action.success) return reply.code(400).send({ error: 'Say which choice: { "action": "…" } (one of the operation\'s recovery actions).' });
    trace(op.agentId!)('op.recover', { op: op.id, action: action.data.action });
    try {
      const after = await ctx.lifecycle.operations.recover(op.id, action.data.action);
      const agent = store.getAgent(op.agentId!);
      return { operation: publicOperation(after), agent: agent ? publicAgent(agent) : undefined };
    } catch (err) {
      if (err instanceof RecoverError) return reply.code(err.status).send({ error: err.userMessage, operation: publicOperation(store.getOperation(op.id)) });
      throw err;
    }
  });

  // Rebuild: new container from the current image, volume (memory) kept.
  app.post<{ Params: { id: string } }>(
    '/v1/agents/:id/rebuild',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
      if (movedAway(agent, reply)) return reply;
      if (busyNow(agent, reply)) return reply;
      if (agent.state !== 'RUNNING' && agent.state !== 'STOPPED') {
        return reply.code(409).send({ error: `Cannot rebuild while ${agent.state}` });
      }
      // `checkpoint` = summarise the live conversation into MEMORY.md first
      // (only meaningful for a RUNNING agent — a stopped one has no live turn to
      // run). Used when the rebuild will change the AI backend, which resets
      // the thread. The pre-rebuild snapshot + checkpoint both run as the first
      // steps of the background task, so this still returns 202 at once.
      const body = RebuildBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: zodMessage(body.error) });
      const checkpoint = body.data?.checkpoint === true
        && agent.state === 'RUNNING';
      // `stoppedWaits`: a rebuild to apply a change just made, not one asked for
      // by name. A stopped or sleeping agent stays so and has it at its next start (HB-0420).
      if (body.data?.stoppedWaits === true && agent.state === 'STOPPED') {
        oweRebuild(agent.id);
        return reply.code(202).send({ rebuilding: false, atNextStart: true });
      }
      if (!kickRebuild(agent.id, { checkpoint })) {
        return reply.code(409).send({ error: 'Another operation is already running on this agent.' });
      }
      // Its operation (queued just now) too, so a caller can follow it to
      // its end rather than take "accepted" for "rebuilt" (#127).
      const op = store.listOperations([agent.id], 1).find((o) => o.kind === 'rebuild');
      return reply.code(202).send({ rebuilding: true, ...(op ? { operation: publicOperation(op) } : {}) });
    },
  );

  // Retry after FAILED (or nudge a stuck PROVISIONING after a restart).
  app.post<{ Params: { id: string } }>('/v1/agents/:id/provision', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    if (movedAway(agent, reply)) return reply;
    if (busyNow(agent, reply)) return reply;
    kickProvision(agent.id);
    return reply.code(202).send(publicAgent(store.getAgent(agent.id)!));
  });

  app.post<{ Params: { id: string } }>('/v1/agents/:id/stop', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
    if (busyNow(agent, reply)) return reply;
    // Guard the transition here so a mid-rebuild stop is a 409, not a 500.
    if (agent.state !== 'RUNNING') {
      return reply.code(409).send({ error: `Cannot stop while ${agent.state}` });
    }
    // Under the agent's lifecycle lock (power.ts stopRunning); its answer is made while the lock is held.
    try {
      const stopped = await stopRunning(agent.id, (now: Agent) => publicAgent(now));
      if (!stopped.ok) return reply.code(409).send({ error: stopped.error });
      // Stopped on purpose: a start a restart left owed is not to undo it (HB-0980).
      settleStartsOwedOn(store, agent.id, 'owner-stop');
      return stopped.value;
    } catch (err) {
      if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/v1/agents/:id/start', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
    if (movedAway(agent, reply)) return reply;
    if (busyNow(agent, reply)) return reply;
    if (agent.state !== 'STOPPED') {
      return reply.code(409).send({ error: `Cannot start while ${agent.state}` });
    }
    const r = await startStopped(agent, { ownerAsked: true });
    if (!r.ok || !r.agent) return reply.code(409).send({ error: r.error ?? 'It could not be started just now — try again shortly.' });
    // Its owner's Start is the start a restart left owed, if any (HB-0980).
    settleStartsOwedOn(store, agent.id, 'owner-start');
    // Started by hand while a budget has it paused: it runs on until the 1st (budgets.ts).
    // A cheaper model a budget chose is not a pause: Start leaves its model, and the
    // budget still puts its own back on the 1st.
    // A pause of a month that is over, whose start on the 1st has not happened
    // yet, is ended by this start too: before, only this month's was, and the
    // passes went on owing it a start (HB-1011).
    const month = monthKey(Date.now(), machineTz()), at = new Date().toISOString();
    for (const pause of store.openBudgetPauses(agent.id)) {
      if (pause.kind !== 'pause' || pause.month > month) continue;
      store.resumeBudgetPause(agent.id, pause.month, at, 'owner');
      if (pause.month === month) trace(agent.id)('budget.started_by_hand', {});
    }
    return r.rebuilding ? reply.code(202).send({ ...publicAgent(r.agent), rebuilding: true }) : publicAgent(r.agent);
  });

  // ---- Hibernation (src/orchestrator/lifecycle/hibernate.ts) ------------------------
  app.post<{ Params: { id: string } }>('/v1/agents/:id/hibernate', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
    if (movedAway(agent, reply)) return reply;
    if (busyNow(agent, reply)) return reply;
    if (agent.state !== 'RUNNING') return reply.code(409).send({ error: `Cannot put it to sleep while ${agent.state}` });
    if (agent.ops) return reply.code(409).send({ error: 'The management agent stays up: it carries your notifications.' });
    // By hand, the idle rule does not apply — the owner knows. The chat-app and
    // scheduled-task rules do: a sleeper misses what only a running one gets.
    const kinds = store.listChannelsForAgent(agent.id).map((c) => c.kind);
    if (kinds.some((k) => k !== 'telegram')) return reply.code(409).send({ error: 'An agent on Discord or Slack cannot sleep: nothing queues their messages while it is down.' });
    // Its scheduled tasks are read under the agent's lock, with the stop
    // (hibernateAgent): read here first, a task added meanwhile was put to
    // sleep with it (audit #055).
    try {
      return publicAgent(await hibernate(agent, 'by hand'));
    } catch (err) {
      if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
      if (!(err instanceof NoLongerSleepy)) throw err;
      // Unreadable is not "none" (#122): the idle sweep refuses then too.
      if (err.message === 'its scheduled tasks could not be read') return reply.code(409).send({ error: "Couldn't read its scheduled tasks just now, and they would not run while it sleeps — try again in a moment." });
      if (err.message === 'has scheduled tasks') return reply.code(409).send({ error: 'It has scheduled tasks of its own: they would not run while it sleeps. Pause them first.' });
      return reply.code(409).send({ error: `It cannot sleep just now: ${err.message}.` });
    }
  });
  app.post<{ Params: { id: string } }>('/v1/agents/:id/wake', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
    if (movedAway(agent, reply)) return reply;
    if (busyNow(agent, reply)) return reply;
    if (!agent.hibernatedAt) return reply.code(409).send({ error: 'It is not asleep.' });
    return publicAgent(await wake(agent, 'by hand'));
  });
  /** What the idle rule would do with this agent now — for the app's "Asleep" explanations. */
  app.get<{ Params: { id: string } }>('/v1/agents/:id/hibernate', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    return sleepView(agent);
  });

  // Owner-editable agent settings. `name` is display-only (the slug, workspace
  // and bot identity never change). `sharedMemory` no longer changes anything:
  // memory is always shared, and `false` is refused with the reason (HB-0094).
  // The checks in their order and the change are the agent edits service's
  // (src/orchestrator/lifecycle/agentEdits.ts, `ctx.agentEdits`; HB-0825):
  // who asks, the body and the answers are here. Registered last, where it
  // stood in routes.ts: after these routes, before the files routes.
  app.patch<{ Params: { id: string }; Body: { name?: string; sharedMemory?: boolean; aiProfileId?: string } }>(
    '/v1/agents/:id',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      const ledgerBefore = snapshotModels(store, [agent.id]);
      const parsed = AgentEditBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
      const done = await ctx.agentEdits.edit(agent, parsed.data, {
        ownerId: ownerIdOf(req),
        ownsLocalHost: () => ownsLocalHost(req),
        holdName: (key) => holdOnce(req, key),
        stepUp: () => {
          const again = app.publicAccess ? app.publicAccess.stepUpRefusal(req) : isPublic(req) ? { code: 403, body: { error: 'Not at the public address.' } } : undefined;
          if (!again) return undefined;
          const { error, ...extra } = again.body;
          return { ok: false, status: again.code, error: String(error), extra };
        },
        ledger: (source) => recordLedger(req, source, ledgerBefore),
      });
      if (!done.ok) return reply.code(done.status).send({ error: done.error, ...done.extra });
      return done.answer;
    },
  );
}
