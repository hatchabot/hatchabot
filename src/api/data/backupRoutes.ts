import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BackupBusyError, pruneBackup, RestoreError } from '../../orchestrator/backups/backupFiles.js';
import { AgentBusyError } from '../../orchestrator/lifecycle/busy.js';
import { DRILL_EVERY, type DrillEvery } from '../../orchestrator/backups/drills.js';
import { runInBackground } from '../../orchestrator/lifecycle/operations.js';
import { SnapshotError, snapshotLabel } from '../../orchestrator/files/snapshots.js';
import { ownerIdOf } from '../principal.js';
import { MACHINE_OWNER_ONLY, zodMessage, type RouteContext } from '../routeContext.js';

/** POST /v1/agents/:id/snapshots (HB-0814): its label, or none. */
const TakeSnapshot = z.object({ label: z.string().optional() });

/** POST /v1/backups/restore (HB-0814): the agent, the set's date, and the owner's yes to another install's set. */
const RestoreFromBackup = z.object({
  agentId: z.string().optional(),
  date: z.string().optional(),
  otherKey: z.boolean().optional(),
});

/**
 * Backups, snapshots and restores: the routes (HB-0808).
 *
 * An agent's snapshots (its core-file history: list, take, read, restore,
 * delete); the nightly backup sets (Settings → Backups: list, Back up now,
 * prune a set, restore one agent from a set); recovery readiness and the
 * restore drills (run one, the schedule). Each route reads its request and
 * words the answer; the rules are the backups service's (`ctx.backups`,
 * src/orchestrator/backups/): `snapshots`, `sets` and `drills`.
 *
 * Download of one agent (GET /v1/agents/:id/backup) and restore from a
 * download (POST /v1/agents/restore) are the export and import routes, still
 * in routes.ts (moving between machines is its own step).
 */
export function registerBackupRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, ownedAgent, ownsLocalHost, busyNow, waitAsked, accepted, backgroundError } = ctx;
  const { sets, drills, snapshots } = ctx.backups;

  // ---- snapshots (core-file history) ---------------------------------------

  app.get<{ Params: { id: string } }>('/v1/agents/:id/snapshots', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    return store.listSnapshots(agent.id).map((s) => ({ ...s, label: snapshotLabel(s) }));
  });

  app.post<{ Params: { id: string }; Body: { label?: string } }>(
    '/v1/agents/:id/snapshots',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      const body = TakeSnapshot.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: zodMessage(body.error) });
      try {
        const snap = await snapshots.take(agent, body.data.label);
        return reply.code(201).send(snap);
      } catch (err) {
        if (err instanceof SnapshotError || err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string; snapId: string } }>(
    '/v1/agents/:id/snapshots/:snapId',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      const snap = agent && store.getSnapshot(agent.id, req.params.snapId);
      if (!snap) return reply.code(404).send({ error: 'Not found' });
      return { ...snap, label: snapshotLabel(snap) };
    },
  );

  app.post<{ Params: { id: string; snapId: string } }>(
    '/v1/agents/:id/snapshots/:snapId/restore',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      // Restore writes the volume — the one mutating route that lacked a busy
      // guard, so a restore could interleave with a migrate/adopt/export
      // reading or replacing the same volume. Hold the flag for the write.
      if (busyNow(agent, reply)) return reply;
      const run = snapshots.restore(agent, req.params.snapId, ownerIdOf(req));
      try {
        if (waitAsked(req)) return await run();
        // In the background once it has begun (phase 3); its refusals
        // (stopped, no such snapshot) come first, as before.
        const bg = await runInBackground(store, run, { onError: backgroundError });
        return bg.started ? accepted(reply, bg.opId) : bg.value;
      } catch (err) {
        if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        if (err instanceof SnapshotError) return reply.code(409).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string; snapId: string } }>(
    '/v1/agents/:id/snapshots/:snapId',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      const removed = snapshots.remove(agent.id, req.params.snapId);
      if (removed === 'in-use') {
        return reply.code(409).send({ error: 'A restore that has not finished still needs this snapshot. Finish or revert it (its Alerts line) first, then delete it.' });
      }
      if (removed === 'not-found') {
        return reply.code(404).send({ error: 'Not found' });
      }
      return { deleted: true };
    },
  );

  // ---- scheduled backups (Settings → Backups) -----------------------------
  // These sets hold the whole fleet's data plus the decryption key in the
  // clear, so every route is gated to the machine's owner and returns only
  // metadata — never the backup files themselves.
  app.get<{ Querystring: { latest?: string } }>('/v1/backups', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    // ?latest=1: only the newest set's date and flags, no volume list — the
    // home screen polls this for "how old is the last backup", and the full
    // list is ~140 KB on a big fleet (night review).
    return sets.list({ latest: req.query?.latest === '1' });
  });

  app.post('/v1/backups/run', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const run = sets.runNow(ownerIdOf(req));
    return { run };
  });

  app.delete<{ Params: { date: string } }>('/v1/backups/:date', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    try {
      const removed = pruneBackup(req.params.date);
      if (!removed) return reply.code(404).send({ error: 'No backup for that date.' });
      return { ok: true };
    } catch (err) {
      if (err instanceof BackupBusyError) return reply.code(409).send({ error: err.message });
      return reply.code(400).send({ error: String((err as Error)?.message ?? err) });
    }
  });

  // ---- recovery readiness (docs/recovery-readiness-design.md) ---------------
  // Per agent: the newest backup a restore could use, the recent sets that
  // left it out and why, its runner, the last drill that checked it, one
  // status. Metadata only. The machine's owner sees every agent; anyone else
  // the agents they own (restoring stays the machine owner's).
  // ?agentId=: that one agent, with the sets a restore can use (the guided
  // restore's choices); the list leaves those out — the page polls it.
  app.get<{ Querystring: { agentId?: string } }>('/v1/backups/readiness', async (req) => {
    const admin = ownsLocalHost(req);
    const me = ownerIdOf(req);
    const one = typeof req.query?.agentId === 'string' ? req.query.agentId : undefined;
    return drills.readiness({ admin, ownerId: me, agentId: one });
  });

  app.post('/v1/backups/drill', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    return { run: drills.runDrill('app', ownerIdOf(req)) };
  });
  /** Automatic drills: off (the default), weekly or daily. Lives in .env, like the rebuild policy. */
  app.put<{ Body: { every?: string } }>('/v1/backups/drill-schedule', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const every = req.body?.every;
    if (!every || !(DRILL_EVERY as string[]).includes(every)) return reply.code(400).send({ error: `every must be one of: ${DRILL_EVERY.join(', ')}` });
    const wrote = await drills.setDrillEvery(every as DrillEvery);
    if (!wrote.ok) return reply.code(409).send({ error: wrote.error ?? 'Could not write .env' });
    return { every: every as DrillEvery };
  });
  // The schedule itself (a drill in the quiet hours after today's backup) is
  // the service's, every fifteen minutes; exposed on app for tests.
  (app as unknown as { drillSweep?: typeof drills.drillSweep }).drillSweep = drills.drillSweep;

  // Restore ONE agent's whole volume from a backup set. Destructive and
  // owner-only; it overwrites live memory, so it holds the busy guard for the
  // stop → import → start swap the same way a snapshot restore does.
  app.post<{ Body: { agentId?: string; date?: string; otherKey?: boolean } }>('/v1/backups/restore', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const body = RestoreFromBackup.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: zodMessage(body.error) });
    const { agentId, date, otherKey } = body.data;
    if (!agentId || !date) return reply.code(400).send({ error: 'agentId and date are required.' });
    // Machine-level, like the panel above: the host owner can restore any agent
    // on this box, not only ones they personally own.
    const agent = store.getAgent(agentId);
    if (!agent || agent.state === 'DELETED') return reply.code(404).send({ error: 'Not found' });
    if (busyNow(agent, reply)) return reply;
    const run = sets.restore({ agent, date, otherKey: otherKey === true, requestedBy: ownerIdOf(req) });
    try {
      if (waitAsked(req)) return await run();
      // In the background once it has begun (phase 3): minutes on a large
      // agent. Its refusals (no such date, not in that set) come first.
      const bg = await runInBackground(store, run, { onError: backgroundError });
      return bg.started ? accepted(reply, bg.opId) : bg.value;
    } catch (err) {
      if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
      if (err instanceof RestoreError) return reply.code(400).send({ error: err.userMessage, ...(err.code ? { code: err.code } : {}) });
      throw err;
    }
  });
}
