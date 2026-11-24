import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { EMBED_MODEL_ALIAS } from '../embedder/embedder.js';
import { ProviderError } from '../providers/provider.js';
import { ownerIdOf } from './principal.js';
import { MACHINE_OWNER_ONLY, type RouteContext } from './routeContext.js';

/**
 * POST /v1/embedder/guests (HB-0814; was a cast of the body read for `name`):
 * the guest's name. Anything else (no `name`, one that is not text, a body
 * that is not an object) is the empty name, refused by the service's own words.
 */
const GuestBody = z.object({ name: z.string() });
/**
 * The machine a service route is for (HB-0814; was a cast of the body read
 * for `host`), after the query's `host`: whatever the body's `host` is, as
 * before (only text names a machine).
 */
const HostBody = z.object({ host: z.unknown() });

/**
 * The memory search service: the routes (HB-0808 step 13).
 *
 * The fleet's engine choice (GET and PUT /v1/embed-default, POST
 * /v1/embed/move-all), a machine's service (GET /v1/embedder and its start,
 * stop and restart, `?host=` for a runner's own) and the guests' keys (GET
 * and POST /v1/embedder/guests, DELETE …/guests/:name). Each route checks
 * who asks and the body, in that order as before, then asks the memory
 * search service (`ctx.memorySearch`, src/orchestrator/memorySearch/). No
 * hook. A guest's key is shown once, in the answer that makes it.
 */
export function registerEmbedderRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { ownsLocalHost, holdOnce, memorySearch } = ctx;
  const embedder = memorySearch.local;
  const answer = <T>(reply: FastifyReply, r: { ok: true; body: T } | { ok: false; status: number; error: string }) =>
    r.ok ? r.body : reply.code(r.status).send({ error: r.error });

  // The machine owner's, like its PUT: the counts are the whole machine's
  // fleet, other accounts' agents included (HB-0061).
  app.get('/v1/embed-default', async (req, reply) => (ownsLocalHost(req) ? memorySearch.fleetView() : reply.code(403).send({ error: MACHINE_OWNER_ONLY })));
  app.put<{ Body: { default?: string } }>('/v1/embed-default', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const mode = req.body?.default;
    if (mode !== 'shared' && mode !== 'baked') return reply.code(400).send({ error: "default must be 'shared' or 'baked'" });
    return answer(reply, await memorySearch.setDefault(mode));
  });
  app.post<{ Body: { mode?: string; when?: string } }>('/v1/embed/move-all', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const mode = req.body?.mode, when = req.body?.when ?? 'quiet';
    if (mode !== 'shared' && mode !== 'baked') return reply.code(400).send({ error: "mode must be 'shared' or 'baked'" });
    if (when !== 'now' && when !== 'quiet') return reply.code(400).send({ error: "when must be 'now' or 'quiet'" });
    return answer(reply, await memorySearch.moveAll(mode, when));
  });

  /** `?host=` names a runner (its own service); absent, this machine. Undefined: no such host for this account. */
  const embedderHostOf = (req: FastifyRequest) => {
    const body = HostBody.safeParse(req.body);
    const q = (req.query as { host?: unknown } | undefined)?.host ?? (body.success ? body.data.host : undefined);
    const hostId = typeof q === 'string' && q ? q : undefined;
    return memorySearch.at(hostId, { ownerId: () => ownerIdOf(req), ownsLocal: () => ownsLocalHost(req) });
  };
  app.get('/v1/embedder', async (req, reply) => {
    const at = embedderHostOf(req);
    if (!at) return reply.code(404).send({ error: 'No such machine.' });
    const v = await at.svc.status();
    // The external server's address may carry credentials: the owner's to see.
    return at.owns ? v : { ...v, external: v.external ? 'an external server' : undefined, doorAddress: undefined };
  });

  const embedderAction = (action: 'start' | 'stop' | 'restart') => async (req: FastifyRequest, reply: FastifyReply) => {
    const at = embedderHostOf(req);
    if (!at) return reply.code(404).send({ error: 'No such machine.' });
    if (!at.owns) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    try {
      return await at.svc[action]();
    } catch (err) {
      if (err instanceof ProviderError) return reply.code(502).send({ error: err.userMessage });
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  app.post('/v1/embedder/start', embedderAction('start'));
  app.post('/v1/embedder/stop', embedderAction('stop'));
  app.post('/v1/embedder/restart', embedderAction('restart'));
  // Guest keys: other tenants of a shared host use this machine's service
  // (docs/shared-host.md). Machine owner only; a key is shown once.
  app.get('/v1/embedder/guests', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    return { guests: embedder.listGuests() };
  });
  app.post<{ Body: { name?: string } }>('/v1/embedder/guests', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const parsed = GuestBody.safeParse(req.body);
    const name = parsed.success ? parsed.data.name.trim() : '';
    // One at a time per name: a double click minted two keys, and the one
    // shown could be the one the second had already replaced (HB-0062).
    if (!holdOnce(req, `embed-guest:${name}`)) return reply.code(409).send({ error: `A key for ${name} is already being made.` });
    let key: string;
    try { key = embedder.addGuest(name); } catch (err) { return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) }); }
    app.log.warn({ guest: name, ownerId: ownerIdOf(req) }, 'embed.guest_key_issued');
    // Where a guest's agents reach the door: the address containers see this
    // machine at (10.0.2.2 for a rootless neighbour; the bridge gateway on root Docker).
    const host = await memorySearch.guestHost();
    return reply.code(201).send({
      name, key, model: EMBED_MODEL_ALIAS,
      url: `http://${host}:${embedder.doorPort}/v1`,
      env: `HATCHABOT_EMBED_URL=http://${host}:${embedder.doorPort}/v1\nHATCHABOT_EMBED_KEY=${key}\nHATCHABOT_EMBED_MODEL=${EMBED_MODEL_ALIAS}`,
    });
  });
  app.delete<{ Params: { name: string } }>('/v1/embedder/guests/:name', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    if (!embedder.removeGuest(req.params.name)) return reply.code(404).send({ error: 'No such guest.' });
    return { removed: req.params.name };
  });
}
