import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { describeCompressedSwap } from '../domain/swap.js';
import { ensureRunnerKey, runnerSetupSnippet } from '../orchestrator/machines/runnerSetup.js';
import { endpointKey } from '../orchestrator/machines/hosts.js';
import type { Host } from '../domain/types.js';
import { pingRunner } from '../providers/resolveProvider.js';
import { ownerIdOf } from './principal.js';
import { HOST_GOING, MACHINE_OWNER_ONLY, zodMessage, type RouteContext } from './routeContext.js';

/** POST /v1/hosts/:id/install-image (HB-0814): `wait: true` holds the request until the copy ends (scripts). */
const InstallImage = z.object({ wait: z.boolean().nullish() });

/**
 * Machines and runners: the routes (HB-0808).
 *
 * Settings → Hosts: this machine and the runners added to it, a runner's
 * probe (Check), the runner key and its setup snippet, Install image, Drain
 * and Remove; Status → Resources: live CPU and memory, and clearing the
 * peaks. Everything that changes a machine is its owner's (MACHINE_OWNER_ONLY).
 *
 * Each route checks who is asking, reads its request and words the answer;
 * the rules and their state are the machines service's (`ctx.machines`,
 * src/orchestrator/machines/): `hosts`, `installs` and `resources`.
 */
export function registerMachineRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, providerFor, ownedAgent, ownsLocalHost, holdOnce, hostBeingRemoved } = ctx;
  const { addProblem, add, drain, remove } = ctx.machines.hosts;
  const { clearPeaksOf, fleet } = ctx.machines.resources;

  app.get('/v1/hosts', async (req) => ctx.machines.hosts.list(ownerIdOf(req), ownsLocalHost(req)));

  /** On-demand reachability check for a runner host's Docker endpoint. */
  app.get<{ Params: { id: string } }>('/v1/hosts/:id/ping', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const host = store.getHost(req.params.id);
    if (!host) return reply.code(404).send({ error: 'Not found' });
    const dockerHost = typeof host.settings?.dockerHost === 'string' ? host.settings.dockerHost : '';
    // Compressed swap on that host (swap.ts), read through its own daemon.
    const swapOf = async () => {
      const sw = await (async () => providerFor(host.id).compressedSwap?.({ fresh: true }))().catch(() => undefined);
      return sw ? { swap: { kind: sw.kind, compressed: sw.compressed, summary: sw.compressed ? describeCompressedSwap(sw) : sw.why } } : {};
    };
    if (!dockerHost) return { reachable: true, serverVersion: 'local', ...(await swapOf()) }; // the local daemon
    // Adapt pingRunner's {ok, version, error} to the shape the UI reads
    // ({reachable, serverVersion, error}) — the same mapping the add path does.
    // Without this a *successful* probe renders as "unreachable — no response".
    // Looked for as the image its agents run and Install image copies (HB-1108), not hatchabot-runtime:latest.
    const ping = await pingRunner(dockerHost, { image: ctx.machines.images.defaultBase });
    // Which OpenClaw its image runs, beside this machine's: a runner left on
    // an old image is offered the update (a runner sat on 2026.7 while the
    // fleet moved to 2026.9.8, 2026-10-07, with no button to say so).
    const versions = ping.ok && ping.hasImage ? await (async () => {
      const there = await providerFor(host.id).currentImageInfo().catch(() => undefined);
      const local = store.localHostId();
      const here = local ? await providerFor(local).currentImageInfo().catch(() => undefined) : undefined;
      return { imageVersion: there?.openclawVersion, currentVersion: here?.openclawVersion };
    })() : {};
    return { reachable: ping.ok, serverVersion: ping.version, hasImage: ping.hasImage, ...versions, error: ping.error, ...(ping.ok ? await swapOf() : {}) };
  });

  // The control plane's dedicated runner key (created on first ask) plus the
  // paste-on-the-runner setup snippet — the two halves of "add a runner
  // without an SSH treasure hunt". Host-owner only: the snippet authorizes
  // THIS box onto another machine.
  app.get('/v1/runner-setup', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    try {
      const pubKey = await ensureRunnerKey();
      return { pubKey, snippet: runnerSetupSnippet(pubKey) };
    } catch (err) {
      return reply.code(500).send({
        error: `Couldn't prepare the runner key (is ssh-keygen installed?): ${String(
          err instanceof Error ? err.message : err,
        ).slice(0, 200)}`,
      });
    }
  });

  // Copy this box's runtime image onto a runner (docker save | docker -H load).
  // Slow — minutes for a multi-GB image — so the UI treats it as a long job.
  /**
   * Copying the runtime image to a runner runs in the background, one copy
   * per runner: a relayed tailnet took over 15 minutes for 2 GB (2026-10-08),
   * and a request held open that long is dropped by a browser or proxy while
   * the copy goes on. POST starts it (or answers with the one under way);
   * GET says how far it has come. `wait: true` holds the request for scripts.
   */
  app.get<{ Params: { id: string } }>('/v1/hosts/:id/install-image', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    if (!store.getHost(req.params.id)) return reply.code(404).send({ error: 'Not found' });
    return ctx.machines.installs.status(req.params.id);
  });
  app.post<{ Params: { id: string } }>('/v1/hosts/:id/install-image', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const host = store.getHost(req.params.id);
    if (!host) return reply.code(404).send({ error: 'Not found' });
    const dockerHost = typeof host.settings?.dockerHost === 'string' ? host.settings.dockerHost : '';
    if (!dockerHost) return reply.code(400).send({ error: 'The local host already has the image.' });
    const body = InstallImage.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: zodMessage(body.error) });
    // Not onto a runner being removed: its row goes, and the copy would go on
    // there with nothing here to follow it (HB-1025). A copy under way holds
    // its removal off the other way round (hosts.inUse).
    if (hostBeingRemoved(host.id)) return reply.code(409).send({ error: HOST_GOING });
    const wait = body.data.wait === true;
    const copy = ctx.machines.installs.start(host, dockerHost, ownerIdOf(req));
    if (!wait) return reply.code(202).send(copy.job);
    const done = await copy.finished;
    if (!done.ok) return reply.code(502).send({ error: done.error });
    return { installed: true, ...(done.differs ? { differs: done.differs } : {}) };
  });

  app.post<{ Params: { id: string } }>('/v1/agents/:id/resources/clear', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    await clearPeaksOf([agent]);
    return { cleared: 1 };
  });
  /** Every agent of the caller's — every agent on the machine for its owner. */
  app.post('/v1/resources/clear', async (req) => {
    const list = ownsLocalHost(req) ? store.listAllActiveAgents() : store.listAgents(ownerIdOf(req));
    return { cleared: await clearPeaksOf(list.filter((a) => a.runtimeRef)) };
  });

  app.get('/v1/resources', async (req) => fleet(ownerIdOf(req), ownsLocalHost(req)));

  // Register a runner host (Cluster mode): a remote Docker endpoint that the
  // control plane places agents on. Host-owner only — it adds fleet capacity.
  // The endpoint is reachability-checked best-effort so a typo fails here.
  app.post<{ Body: { name?: string; dockerHost?: string } }>('/v1/hosts', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(64),
        // ssh://user@host is the simplest secure transport; tcp:// is spoken
        // to over TLS only (runnerEndpoint.ts). Reject anything else.
        dockerHost: z.string().trim().regex(/^(ssh|tcp):\/\/\S+$/, 'Use ssh://user@host or tcp://host:port'),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const { name, dockerHost } = parsed.data;
    const problem = addProblem(ownerIdOf(req), dockerHost);
    if (problem && 'invalid' in problem) return reply.code(400).send({ error: problem.invalid });
    const addedAlready = (already: Host) => reply.code(409).send({ error: `That address is already added, as "${already.name}". A runner that did not answer stays saved: press Check on its row.` });
    if (problem?.already) return addedAlready(problem.already);
    // One at a time per endpoint: a double click on Add made two runners
    // (HB-0062). Held by the address as one spelling: written another way (a
    // trailing slash, a capital), both were added at once (HB-1119).
    if (!holdOnce(req, `host-add:${ownerIdOf(req)}:${endpointKey(dockerHost)}`)) return reply.code(409).send({ error: 'That machine is already being added.' });

    const added = await add({ ownerId: ownerIdOf(req), name, dockerHost });
    if ('already' in added) return addedAlready(added.already);
    const { host, ping, twins } = added;
    // Saved regardless — a runner that's briefly unreachable now may be up at
    // provision time — but surface the probe so the owner sees a bad endpoint.
    return reply.code(201).send({
      ...host,
      reachable: ping.ok,
      serverVersion: ping.version,
      hasImage: ping.hasImage,
      pingError: ping.error,
      ...(twins.length ? { warning: `This is the same Docker as "${twins[0]!.name}", under another address. Keep one of the two: agents belong on one row.` } : {}),
    });
  });

  // Drain a host: stop every running agent on it (take it out of service before
  // decommissioning). Best-effort per agent; a busy one is skipped and reported.
  app.post<{ Params: { id: string } }>('/v1/hosts/:id/drain', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const host = store.getHost(req.params.id);
    if (!host) return reply.code(404).send({ error: 'Not found' });
    return drain(host);
  });

  app.delete<{ Params: { id: string } }>('/v1/hosts/:id', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const host = store.getHost(req.params.id);
    if (!host) return reply.code(404).send({ error: 'Not found' });
    if (host.kind === 'local') {
      return reply.code(400).send({ error: 'The local host is this machine — it cannot be removed.' });
    }
    const r = await remove(host);
    if ('refused' in r) return reply.code(409).send(r.refused);
    if ('going' in r) return reply.code(409).send({ error: HOST_GOING });
    return r;
  });
}
