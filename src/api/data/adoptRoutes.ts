import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AdoptError } from '../../orchestrator/transfer/adopt.js';
import { AgentBusyError } from '../../orchestrator/lifecycle/busy.js';
import { HOST_PATH_DENIED, type RouteContext } from '../routeContext.js';

/** POST /v1/openclaw/quiesce (HB-0814): the bots to quiet. Any other shape keeps its words. */
const Quiesce = z.object({ accountIds: z.array(z.string()) });
/** POST /v1/workspaces/scan-paths, /v1/workspaces/inspect and /v1/agents/:id/adopt-workspace (HB-0814): a folder of this machine. Any other shape keeps its words. */
const WorkspacePath = z.object({ path: z.string().min(1) });

/**
 * Bringing in what was made outside Hatchabot: the routes (HB-0808 step 12).
 *
 * The OpenClaw agents installed for the user this server runs as, their bots
 * quieted before Hatchabot takes them, the folders a workspace names, what a
 * workspace would bring, and a workspace copied into an agent that exists
 * here. Each is the machine's owner's only (HOST_PATH_DENIED): they read and
 * write this machine's folders and OpenClaw's own config. Step-up at the
 * public address (src/api/publicRoutes.ts).
 *
 * Each route reads its request and words the answer; the rules and the
 * deferred adopts' state are the moves, import and export service's
 * (`ctx.transfers.adopts`, src/orchestrator/transfer/adopts.ts). No hook.
 * Registered where the adopt routes stood in routes.ts.
 */
export function registerAdoptRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { ownedAgent, ownsLocalHost, busyNow } = ctx;
  const adopts = ctx.transfers.adopts;

  /** Every OpenClaw agent installed for the user this server runs as, so the
   *  owner can bring them in without hunting down workspace paths. */
  app.get('/v1/openclaw/agents', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    return { agents: await adopts.openclawAgents() };
  });

  /** Disable the named bots in OpenClaw and restart its gateway once, so their
   *  pollers actually stop before Hatchabot takes them over. Host-owner only —
   *  it edits the config file and restarts the gateway (its systemd unit, or
   *  on a Mac OpenClaw's own restart: openclawImport.ts gatewayRestart). */
  app.post('/v1/openclaw/quiesce', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    const parsed = Quiesce.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'accountIds (string[]) required.' });
    }
    const ids = parsed.data.accountIds;
    if (!ids.length) return { quiet: [], stillBusy: [], unconfirmed: [] };
    try {
      return await adopts.quiesce(ids);
    } catch (err) {
      return reply.code(400).send({ error: String((err as Error)?.message ?? err) });
    }
  });

  /** External host folders an adopted workspace references — candidates to
   *  share so the agent isn't blind to its data. Host-owner only (reads paths). */
  app.post('/v1/workspaces/scan-paths', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    const parsed = WorkspacePath.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'path required' });
    return { candidates: await adopts.scanPaths(parsed.data.path) };
  });

  /** Look before you leap: what would be adopted from this folder? */
  app.post('/v1/workspaces/inspect', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
    const parsed = WorkspacePath.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'path required' });
    try {
      return await adopts.inspect(parsed.data.path);
    } catch (err) {
      if (err instanceof AdoptError) return reply.code(400).send({ error: err.userMessage });
      throw err;
    }
  });

  /** Copy an existing workspace into an agent that already exists here. */
  app.post<{ Params: { id: string } }>(
    '/v1/agents/:id/adopt-workspace',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      if (!ownsLocalHost(req)) return reply.code(403).send({ error: HOST_PATH_DENIED });
      if (busyNow(agent, reply)) return reply;
      const parsed = WorkspacePath.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'path required' });
      const path = parsed.data.path;
      // Same cheap insurance as a rebuild: the copy overwrites memory files.
      // In the files turn (HB-0629): one that does not come is refused here,
      // with nothing changed.
      if (agent.state === 'RUNNING') {
        try {
          await adopts.snapshotBefore(agent);
        } catch (err) {
          if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
          throw err;
        }
      }
      // The snapshot may have waited for its turn: the agent as it is now,
      // judged again as the move route judges it after its waits. An
      // archive's checkpoint, a change held part-way or one begun meanwhile
      // is refused; so is a move that ended meanwhile, as a move is when its
      // agent's machine changed under its checks (moves.ts,
      // preflightRefusal): the copy goes where it runs now only when the
      // owner, looking again, asks for it there.
      const now = ownedAgent(req, agent.id);
      if (!now) return reply.code(404).send({ error: 'Not found' });
      if (busyNow(now, reply)) return reply;
      if (now.hostId !== agent.hostId || now.runtimeRef !== agent.runtimeRef || now.migratedTo !== agent.migratedTo) {
        return reply.code(409).send({ error: 'It moved to another machine while its snapshot was taken. Look again, then adopt the workspace.' });
      }
      try {
        return await adopts.adoptInto(now, path);
      } catch (err) {
        if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        // Held on a torn copy (HB-0980): which operation, and what failed, for the web app's and the CLI's cleanup.
        // Copied in whole but not started: said apart, so neither removes the agent the copy is in.
        if (err instanceof AdoptError) return reply.code(400).send({ error: err.userMessage, ...(err.held ? { code: 'adopt-held', operation: err.held.operation, detail: err.held.detail } : err.copied ? { code: 'adopt-not-started' } : {}) });
        throw err;
      }
    },
  );
}
