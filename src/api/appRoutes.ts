import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { dropAppPending } from '../orchestrator/apps/appPending.js';
import { AppError } from '../orchestrator/apps/apps.js';
import type { SourceRefusal } from '../orchestrator/apps/dataSources.js';
import { isPublicGitUrl, PUBLIC_REPO_READ_ONLY } from '../orchestrator/apps/gitSource.js';
import { ownerIdOf } from './principal.js';
import { AGENT_GONE, HOST_PATH_DENIED, MACHINE_OWNER_ONLY, zodMessage, type RouteContext } from './routeContext.js';

/**
 * An app's `values`: setting name to value, or none. A string or a list
 * was taken key by key (each character a setting), so anything else is
 * refused before it is used (HB-0064), in the words it always had.
 */
const AppValues = z.record(z.string(), z.unknown()).nullish();
const VALUES_REFUSAL = 'values must be an object of setting names and their values.';

/** POST /v1/apps/inspect (HB-0814): the repo, its ref, and a new agent's name (anything but text is no name, as before). */
const InspectApp = z.object({ source: z.string().nullish(), ref: z.string().nullish(), name: z.unknown().optional() });

/** POST /v1/agents/:id/app and …/app/pending (HB-0814): the repo, its ref, its settings, and the owner's yes to a second copy on one account. */
const InstallApp = z.object({ source: z.string().nullish(), ref: z.string().nullish(), values: AppValues, allowShared: z.boolean().nullish() });

/** POST /v1/agents/:id/app/update (HB-0814): a ref, new settings, and the same yes. */
const UpdateApp = z.object({ ref: z.string().nullish(), values: AppValues, allowShared: z.boolean().nullish() });

/** POST /v1/agents/:id/data-sources. */
const AddDataSource = z
  .object({
    kind: z.enum(['folder', 'git']),
    access: z.enum(['ro', 'rw']),
    path: z.string().min(1).max(512).optional(),
    repoUrl: z.string().min(1).max(512).optional(),
    /** Adopted agents: bind at the original host path, not /data/<name>. */
    atHostPath: z.boolean().optional(),
    /** git: a public repo, cloned over https with no credentials (read-only, no deploy key). */
    public: z.boolean().optional(),
  });

/** PATCH /v1/agents/:id/data-sources/:dsId. */
const SetAccess = z.object({ access: z.enum(['ro', 'rw']) });

/**
 * Apps in agents and data sources: the routes (HB-0808).
 *
 * Apps (docs/apps-in-agents.md): a repo's manifest read, an app installed
 * into an agent now or once a new agent's setup is done, updated, rolled
 * back and stopped. The source is read on the host, so only the machine's
 * owner may install or change one. Data sources (docs/data-sources.md): git
 * repos and folders added to an agent, their access, the Test button, and
 * their removal.
 *
 * Each route checks the agent, reads its request (a body against its
 * schema) and words the answer; the rules and their locks are the apps and
 * data sources service's (`ctx.apps`, src/orchestrator/apps/): `installed`
 * and `dataSources`.
 */
export function registerAppRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, secrets, ownedAgent, ownsLocalHost, busyNow, agentGone, publicAgent } = ctx;
  const { appView, inspect, installFromSource, savePending, update, rollback, remove, runPendingApp } = ctx.apps.installed;
  const { dataSources } = ctx.apps;

  // ---- apps in agents (docs/apps-in-agents.md) --------------------------------------
  // A codebase with a hatchabot.json, installed into an agent as a release with
  // its config, tests and scheduled commands. The source is read on the host, so
  // only the machine's owner may install or update (host paths, host git login).
  const appFail = (reply: FastifyReply, e: unknown) => {
    const conflict = (e as { conflict?: string[] })?.conflict;
    // How it left the agent (apps.ts, outcome): the page says "unchanged" only when this does.
    const o = (e ?? {}) as { unchanged?: boolean; held?: boolean };
    const state = { unchanged: o.unchanged === true, ...(o.held ? { held: true } : {}) };
    if (e instanceof AppError && conflict) return reply.code(409).send({ error: e.message, conflict, unchanged: o.unchanged !== false });
    if (e instanceof AppError && (e as { stale?: boolean }).stale) return reply.code(409).send({ error: e.message, unchanged: true });
    const needs = (e as { needs?: unknown })?.needs;
    if (e instanceof AppError) return reply.code(400).send({ error: e.message, test: (e as AppError & { test?: unknown }).test, ...(needs ? { needs } : {}), ...state });
    return reply.code(502).send({ error: `The install did not finish: ${(e as Error)?.message ?? e}`, ...state });
  };
  const appTarget = (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    if (!ownsLocalHost(req)) { reply.code(403).send({ error: "Only this machine's owner can install or change an app (it reads this machine's folders and git login)." }); return undefined; }
    const a = ownedAgent(req, req.params.id);
    if (!a) { reply.code(404).send({ error: 'Not found' }); return undefined; }
    if (a.state !== 'RUNNING' || !a.runtimeRef) { reply.code(409).send({ error: `${a.name} is ${a.state.toLowerCase()}; start it first.` }); return undefined; }
    if (busyNow(a, reply)) return undefined;
    return a;
  };
  /**
   * The body against its schema, read where the route first read it. A
   * `values` that is not settings is answered in its own words (HB-0064),
   * as it was when only it was checked here; anything else is the schema's.
   */
  const appBody = <S extends z.ZodType>(schema: S, req: FastifyRequest, reply: FastifyReply): z.infer<S> | undefined => {
    const body = schema.safeParse(req.body ?? {});
    if (body.success) return body.data;
    reply.code(400).send({ error: body.error.issues.some((i) => i.path[0] === 'values') ? VALUES_REFUSAL : zodMessage(body.error) });
    return undefined;
  };

  /** What a repo's manifest says, and what it will ask for. */
  app.post('/v1/apps/inspect', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: "Only this machine's owner can read a repo from it." });
    const body = appBody(InspectApp, req, reply); if (!body) return reply;
    try {
      // `name`: a new agent's, so its chat comes with {app_dir}, {agent}… filled in for it (HB-0259).
      const name = typeof body.name === 'string' && body.name.trim() ? body.name : undefined;
      return await inspect(body.source ?? '', body.ref || 'HEAD', name);
    } catch (e) { return appFail(reply, e); }
  });

  app.get<{ Params: { id: string } }>('/v1/agents/:id/app', async (req, reply) => {
    const a = ownedAgent(req, req.params.id);
    if (!a) return reply.code(404).send({ error: 'Not found' });
    const p = store.getAppPending(a.id);
    return { app: appView(a), pending: p ? { source: p.source, since: p.createdAt, error: p.error ?? null } : null,
      canChange: ownsLocalHost(req) };
  });

  // A new agent's waiting install, run by setup when it finishes and by the boot resume; exposed on app for tests.
  (app as unknown as { runPendingApp?: typeof runPendingApp }).runPendingApp = runPendingApp;

  /** Install an app into this agent (or replace the one it has, from a new source). */
  app.post<{ Params: { id: string } }>('/v1/agents/:id/app', async (req, reply) => {
    const a = appTarget(req, reply); if (!a) return reply;
    const body = appBody(InstallApp, req, reply); if (!body) return reply;
    // An install waiting for this agent (a new agent's, failed or not yet
    // run) is superseded by this one once it is in: kept, the next start
    // installed it again, over this one or after Stop app (HB-0252).
    const waiting = store.getAppPending(a.id);
    try {
      const done = await installFromSource(a, body.source ?? '', body.ref || 'HEAD', body.values ?? {}, body.allowShared === true, ownerIdOf(req));
      if (waiting) await dropAppPending(store, secrets, a.id, waiting.gen);
      return { app: appView(a), test: done.test ?? null };
    } catch (e) { return appFail(reply, e); } finally {
      // A request saved while this one ran found the agent busy: it goes in now.
      const now = store.getAppPending(a.id);
      if (now && !now.error && now.gen !== waiting?.gen) void runPendingApp(a.id);
    }
  });

  /** Install it when the agent is ready (a new agent from a repo): checked now, run after setup. */
  app.post<{ Params: { id: string } }>('/v1/agents/:id/app/pending', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: "Only this machine's owner can install an app (it reads this machine's folders and git login)." });
    const a = ownedAgent(req, req.params.id);
    if (!a || a.state === 'DELETED' || a.state === 'ARCHIVED') return reply.code(404).send({ error: 'Not found' });
    const body = appBody(InstallApp, req, reply); if (!body) return reply;
    // No source: try the waiting one again (its page's "Try again").
    const waiting = store.getAppPending(a.id);
    if (!body.source && waiting) {
      store.setAppPendingError(a.id, null);
      if (a.state === 'RUNNING') void runPendingApp(a.id);
      return { pending: true, retried: true };
    }
    try {
      const ref = body.ref || 'HEAD';
      const r = await savePending(a, { source: body.source ?? '', ref, values: body.values ?? {}, allowShared: body.allowShared === true });
      if ('missing' in r) return reply.code(400).send({ error: `Needs a value for: ${r.missing.join(', ')}.` });
      if (!r.saved) return reply.code(409).send({ error: 'It was deleted or archived meanwhile, so nothing was saved.' });
      return { pending: true, app: r.app, name: r.name };
    } catch (e) { return appFail(reply, e); }
  });

  /** Install the newest commit (or a given ref) from where it came. */
  app.post<{ Params: { id: string } }>('/v1/agents/:id/app/update', async (req, reply) => {
    const a = appTarget(req, reply); if (!a) return reply;
    const body = appBody(UpdateApp, req, reply); if (!body) return reply;
    const had = store.getAgentApp(a.id);
    if (!had) return reply.code(404).send({ error: `${a.name} has no app installed.` });
    try {
      const u = await update(a, had, { ref: body.ref, values: body.values, allowShared: body.allowShared === true, requestedBy: ownerIdOf(req) });
      if ('unchanged' in u) return { app: appView(a), unchanged: true };
      if ('otherApp' in u) {
        return reply.code(409).send({
          error: `${u.sha.slice(0, 12)} is another app (${u.otherApp}, not ${had.app}), so it was not installed as an update. To replace ${had.app} with it, install it again from ${had.source}.`,
          unchanged: true,
        });
      }
      const { done, refreshed } = u;
      return { app: appView(a), test: done.test ?? null, ...(refreshed.length ? { refreshed } : {}) };
    } catch (e) { return appFail(reply, e); }
  });

  /** Back to the release before the last install or update. */
  app.post<{ Params: { id: string } }>('/v1/agents/:id/app/rollback', async (req, reply) => {
    const a = appTarget(req, reply); if (!a) return reply;
    const had = store.getAgentApp(a.id);
    if (!had?.previousSha || !had.previousManifest) return reply.code(409).send({ error: 'There is no earlier release to go back to.' });
    try {
      await rollback(a, had, ownerIdOf(req));
      return { app: appView(a) };
    } catch (e) { return appFail(reply, e); }
  });

  /** Stop running it: its scheduled commands go; the code and its data stay in the agent. */
  app.delete<{ Params: { id: string } }>('/v1/agents/:id/app', async (req, reply) => {
    const a = appTarget(req, reply); if (!a) return reply;
    const had = store.getAgentApp(a.id);
    if (!had) return reply.code(404).send({ error: `${a.name} has no app installed.` });
    try {
      const n = await remove(a, had);
      return { removed: true, tasks: n };
    } catch (e) { return appFail(reply, e); }
  });

  // ---- data sources (docs/data-sources.md) ---------------------------------
  /** A data source's refusal, worded. */
  const refuse = (reply: FastifyReply, r: SourceRefusal) => {
    if (r.refused === 'machine-owner') return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    if (r.refused === 'gone') return reply.code(409).send({ error: AGENT_GONE });
    return reply.code(r.refused === 'invalid' ? 400 : r.refused === 'conflict' ? 409 : 500).send({ error: r.error });
  };

  // Add a data source: a folder (the machine's owner only) or a git repo (any
  // agent owner). Both apply on rebuild; a public repo is cloned now when the
  // agent is up.
  app.post<{ Params: { id: string } }>('/v1/agents/:id/data-sources', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    if (agentGone(agent.id)) return reply.code(409).send({ error: AGENT_GONE });
    const parsed = AddDataSource.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const refused = await dataSources.add(agent, parsed.data, () => ownsLocalHost(req));
    if (refused) return refuse(reply, refused);
    return publicAgent(store.getAgent(agent.id)!);
  });

  // Flip a source between read-only and writable, without the remove-and-re-add
  // dance (which for a git repo meant a fresh clone AND a new deploy key).
  // Applies on the next rebuild: a container's bind mounts are fixed once it's
  // running. For git this is a documented intent, not an enforcement — the repo
  // is cloned onto the volume, so what a push is actually allowed to do is the
  // deploy key's permission on the host.
  app.patch<{ Params: { id: string; dsId: string } }>(
    '/v1/agents/:id/data-sources/:dsId',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      const src = store.getDataSource(agent.id, req.params.dsId);
      if (!src) return reply.code(404).send({ error: 'No such data source.' });
      if (src.kind === 'folder' && store.activeOperationFor(agent.id)?.kind === 'move-host') {
        return reply.code(409).send({ error: 'Its move to another machine is not over. Change folder access once that finishes.' });
      }
      const parsed = SetAccess.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
      // Same gate as creating a writable folder: granting write to a host folder
      // is the machine owner's call, not any agent owner's.
      if (src.kind === 'folder' && parsed.data.access === 'rw' && !ownsLocalHost(req)) {
        return reply.code(403).send({ error: HOST_PATH_DENIED });
      }
      if (src.kind === 'git' && isPublicGitUrl(src.repoUrl) && parsed.data.access === 'rw') {
        return reply.code(400).send({ error: PUBLIC_REPO_READ_ONLY });
      }
      store.setDataSourceAccess(agent.id, src.id, parsed.data.access);
      return publicAgent(store.getAgent(agent.id)!);
    },
  );

  // The Test button (Settings → Data): does this source work from here, now?
  app.post<{ Params: { id: string; dsId: string } }>('/v1/agents/:id/data-sources/:dsId/check', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const src = store.getDataSource(agent.id, req.params.dsId);
    if (!src) return reply.code(404).send({ error: 'No such data source.' });
    const r = await dataSources.check(agent, src);
    return 'refused' in r ? refuse(reply, r) : r;
  });

  app.delete<{ Params: { id: string; dsId: string } }>(
    '/v1/agents/:id/data-sources/:dsId',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      const src = store.getDataSource(agent.id, req.params.dsId);
      if (!src) return reply.code(404).send({ error: 'No such data source.' });
      const r = await dataSources.remove(agent, src);
      if ('refused' in r) return refuse(reply, r);
      return { ...publicAgent(store.getAgent(agent.id)!), ...r };
    },
  );
}
