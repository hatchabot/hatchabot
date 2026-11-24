import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Agent } from '../../domain/types.js';
import { doorScript as embedDoorScript } from '../../embedder/door.js';
import { EMBED_MODEL_ALIAS, EmbedderService, embedDefault, embedKeyHash, scheduleEmbedderBoot } from '../../embedder/embedder.js';
import { writeEnvVar } from '../../ops/tailnet.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import type { Store } from '../../store/store.js';
import { sixAtATime } from '../../util/queues.js';
import { isBusy } from '../lifecycle/busy.js';
import type { ProvisionDeps } from '../lifecycle/provision.js';

/**
 * The memory search service (HB-0808 step 13): the embedding service of
 * src/embedder, one engine per machine for every agent's semantic memory
 * search. Nothing uses it until an agent is switched to it; the owner turns
 * it on under Settings → Hosts.
 *
 * It holds this machine's service (`local`), each runner's own (made on first
 * use, `runnerEmbedders`), what provisioning asks of them (`forProvision`),
 * the fleet's engine choice (`fleetView`, `setDefault`, `moveAll`) and the
 * boot start and health loop (`startTimers`, ended by `stop()`). Built once
 * in `registerRoutes` and on the route context as `ctx.memorySearch`; its
 * routes are in src/api/embedderRoutes.ts. It knows nothing of HTTP.
 */
export interface MemorySearch {
  /** This machine's service. */
  local: EmbedderService;
  /** The service of a machine: this one's (no id, or this machine's), or a runner's own, made on first use. */
  serviceFor(hostId: string | undefined): EmbedderService;
  /** A runner's service, if one was made. */
  madeFor(hostId: string): EmbedderService | undefined;
  /** A removed runner's service is forgotten. */
  forget(hostId: string): void;
  /** What provisioning needs of the service: it up, and a key for the agent. */
  forProvision: NonNullable<ProvisionDeps['embedder']>;
  /** The fleet's counts: what new agents get, how many use the service, and how many switches are owed. */
  fleetView(): FleetView;
  /** What new agents get (HATCHABOT_EMBED_DEFAULT, written to .env). */
  setDefault(mode: 'shared' | 'baked'): Promise<EmbedAnswer<FleetView>>;
  /** Every agent of this machine marked for an engine; `now` rebuilds the idle running ones at once. */
  moveAll(mode: 'shared' | 'baked', when: 'now' | 'quiet'): Promise<EmbedAnswer<FleetView & { switched: number; queued: number; deferred: number; engineFree: number }>>;
  /** `host` names a runner (its own service); absent, this machine. Undefined: no such host for this account. */
  at(hostId: string | undefined, caller: { ownerId: () => string; ownsLocal: () => boolean }): { svc: EmbedderService; owns: boolean } | undefined;
  /** Where a guest's agents reach the door: the address containers see this machine at. */
  guestHost(): Promise<string>;
  /** The boot start and the health loop (the caller keeps them off under test). */
  startTimers(): void;
  /** Ends the boot start and the health loop. */
  stop(): void;
}

export interface FleetView { default: 'shared' | 'baked'; total: number; shared: number; pending: number }
export type EmbedAnswer<T> = { ok: true; body: T } | { ok: false; status: number; error: string };

/** What the service needs from the process it runs in. Functions only, so a test hands them fakes. */
export interface MemorySearchDeps {
  store: Store;
  secrets: SecretStore;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** Where the services keep their state (beside the database). */
  dataDir: string;
  /** The runtime image when HATCHABOT_IMAGE is not set. */
  defaultBase: string;
  /** The owner switched its memory search engine and the rebuild is still owed. */
  switchPendingFor: (a: Agent) => boolean;
  /** Is a provision or rebuild of this agent in the queue? */
  isInFlight: (agentId: string) => boolean;
  /** When the agent last spoke (its sessions). */
  lastActiveFor: (a: Agent) => Promise<string | undefined>;
  /** A rebuild through the queue; false when it could not be queued. */
  kickRebuild: (agentId: string) => boolean;
  /** The server's log, for the timers' warnings. */
  warn: (detail: Record<string, unknown>, msg: string) => void;
}

export function createMemorySearch(deps: MemorySearchDeps): MemorySearch {
  const { store, secrets, providerFor, trace, switchPendingFor, isInFlight, lastActiveFor, kickRebuild } = deps;
  const buildDataDir = deps.dataDir, DEFAULT_BASE = deps.defaultBase;
  const localProvider = (): RuntimeProvider => {
    const id = store.localHostId();
    if (!id) throw new Error('This installation has no local host.');
    return providerFor(id);
  };
  const embedder = new EmbedderService({
    provider: localProvider,
    secrets,
    store,
    dataDir: buildDataDir,
    runtimeImage: process.env.HATCHABOT_IMAGE ?? DEFAULT_BASE,
    doorScript: embedDoorScript(),
    // Where agents reach this machine: the docker bridge's gateway on Linux;
    // Docker Desktop has no such address to bind, so loopback (agents use host.docker.internal).
    doorBind: async () => (await localProvider().hostGatewayAddress?.()) ?? '127.0.0.1',
    localHostId: () => store.localHostId(),
    log: (e, d) => trace()(e, d),
  });
  /**
   * Each runner runs its own memory search service (2.147): its agents call
   * it on their own machine, so a laptop away from home keeps its memory
   * search, and no memory leaves the machine it is on. Made on first use;
   * its state is under embed-hosts/<host id>.
   */
  const runnerEmbedders = new Map<string, EmbedderService>();
  const embedderFor = (hostId: string | undefined): EmbedderService => {
    if (!hostId || hostId === store.localHostId()) return embedder;
    let svc = runnerEmbedders.get(hostId);
    if (!svc) {
      svc = new EmbedderService({
        provider: () => providerFor(hostId),
        hostId,
        secrets,
        store,
        dataDir: buildDataDir,
        runtimeImage: process.env.HATCHABOT_IMAGE ?? DEFAULT_BASE,
        doorScript: embedDoorScript(),
        // Docker Desktop (a Mac) cannot bind its bridge: loopback, which its
        // containers reach as host.docker.internal. Linux: the runner's bridge gateway.
        doorBind: async () => {
          const p = providerFor(hostId);
          return (await p.desktop?.().catch(() => false)) ? '127.0.0.1' : ((await p.hostGatewayAddress?.()) ?? '127.0.0.1');
        },
        log: (e, d) => trace()(e, { ...d, host: hostId }),
      });
      runnerEmbedders.set(hostId, svc);
    }
    return svc;
  };
  const embedderForProvision: NonNullable<ProvisionDeps['embedder']> = {
    async credentialsFor(agentId, hostArg) {
      // The machine the build is for comes first: an external server is this
      // machine's setting, and a runner's agent handed its address had no
      // way to reach it (2026-10-09). A runner's agents use its own service.
      const agent = store.getAgent(agentId);
      const local = store.localHostId();
      const hostId = hostArg ?? agent?.hostId ?? local;
      // A server the operator already runs (Ollama speaks the same API): its
      // address as given, its one key, its model — no container, no door.
      if (embedder.external && (!hostId || hostId === local)) {
        return {
          baseUrl: embedder.external.replace(/\/$/, ''),
          token: process.env.HATCHABOT_EMBED_KEY?.trim() || '',
          model: process.env.HATCHABOT_EMBED_MODEL?.trim() || EMBED_MODEL_ALIAS,
        };
      }
      // Only a service the machine owner turned on: an agent owner switching
      // their agent must not start a machine-level container by the back door
      // (27th audit). The health loop, not this, brings an enabled one back up.
      // The exception is the machine owner's OWN agent on a service nobody has
      // touched: since 2026.9.6 every image is engine-free, and a fresh
      // install's first agent died with "not turned on" until the owner found
      // Settings → Hosts (the shared-host bed, 2026-09-25). Stopped on purpose
      // stays stopped for everyone.
      // The service of the machine the build is for: this one's, or the runner's own.
      const svc = embedderFor(hostId);
      if (!svc.enabled) {
        const ownersOwn = !!agent && !!hostId && store.getHost(hostId)?.ownerId === agent.ownerId;
        if (ownersOwn && !svc.stoppedByOwner) {
          trace(agentId)('embed.auto_started', { by: 'the machine owner\'s agent', ...(svc.hostId ? { host: svc.hostId } : {}) });
          await svc.start();
        } else {
          throw new Error(svc.stoppedByOwner
            ? 'the memory search service was stopped by the machine\'s owner (Settings → Hosts)'
            : 'the memory search service is not turned on (Settings → Hosts)');
        }
      }
      let v = await svc.status();
      // An enabled service that fell over comes back for this build — but only
      // if it is still enabled once the turn is ours: a Stop that landed in
      // between wins, and this build fails rather than undoing it (30th audit).
      if (!(v.embedder === 'running' && v.door === 'running')) v = await svc.start({ onlyIfEnabled: true });
      if (!(v.embedder === 'running' && v.door === 'running')) throw new Error('the memory search service was stopped by the machine\'s owner (Settings → Hosts)');
      if (!v.doorAddress) throw new Error('the embedding service has no address');
      // Docker Desktop publishes on loopback, which a container reaches as host.docker.internal.
      const doorAddress = v.doorAddress.replace(/^(127\.[\d.]+|localhost)(?=:)/, 'host.docker.internal');
      const token = randomBytes(24).toString('base64url');
      // A key for another machine than the last one: the agent is moving.
      // Its index is re-checked there (one forced pass), and the old
      // machine's door forgets it.
      const before = store.embedTokenHost(agentId);
      const moved = before !== undefined && (before ?? local) !== hostId;
      if (moved) store.setAgentEmbedIndex(agentId, null, null);
      store.setEmbedToken(agentId, embedKeyHash(token), hostId ?? null);
      // On a runner the key file is copied there before the build goes on: its first call must work.
      await svc.syncKeysNow();
      if (moved) embedderFor(before ?? local).syncKeys();
      return { baseUrl: `http://${doorAddress}/v1`, token, model: EMBED_MODEL_ALIAS };
    },
    async syncKeys(hostIds) {
      for (const h of new Set(hostIds.map((x) => x ?? store.localHostId()))) {
        await embedderFor(h ?? undefined).syncKeysNow()
          .catch((err) => trace()('embed.keys_sync_failed', { host: h, error: String(err).slice(0, 200) }));
      }
    },
  };
  // An archived or deleted agent's key leaves its door's file at once (HB-0027).
  // A service that is off has no door running: its next start writes the file.
  store.onEmbedKeyRetired = (hostId) => {
    try { const svc = embedderFor(hostId ?? store.localHostId()); if (svc.enabled) svc.syncKeys(); }
    catch (err) { trace()('embed.keys_sync_failed', { host: hostId, error: String(err).slice(0, 200) }); }
  };
  /**
   * The fleet's engine choice: what new agents get, and moving the rest.
   * A move marks the agents; `now` rebuilds the idle running ones through the
   * queue at once, `quiet` leaves them to the sweep's quiet hours. Machine
   * owner only, since it drives the machine's service.
   */
  const embedFleetView = (): FleetView => {
    const local = store.localHostId();
    const all = store.listAllActiveAgents().filter((a) => a.hostId === local && !a.ops && a.state !== 'ARCHIVED');
    return {
      default: embedDefault(),
      total: all.length,
      shared: all.filter((a) => a.embedMode === 'shared').length,
      pending: all.filter(switchPendingFor).length,
    };
  };
  const sharedOff = (mode: 'shared' | 'baked') => mode === 'shared' && !embedder.enabled && !embedder.external;
  let stopTimers: (() => void) | undefined;

  return {
    local: embedder,
    serviceFor: embedderFor,
    madeFor: (hostId) => runnerEmbedders.get(hostId),
    forget: (hostId) => { runnerEmbedders.delete(hostId); },
    forProvision: embedderForProvision,
    fleetView: embedFleetView,

    async setDefault(mode) {
      if (sharedOff(mode)) {
        return { ok: false, status: 400, error: 'Turn the memory search service on first (Settings → Hosts).' };
      }
      const envFile = process.env.HATCHABOT_ENV_FILE ?? join(process.cwd(), '.env');
      const wrote = await writeEnvVar(envFile, 'HATCHABOT_EMBED_DEFAULT', mode, () => true,
        'Written by Hatchabot: which memory search engine new agents get (Settings → Hosts).')
        .catch((err: unknown) => ({ ok: false, error: String(err) }));
      if (!wrote.ok) return { ok: false, status: 409, error: wrote.error ?? 'Could not write .env' };
      process.env.HATCHABOT_EMBED_DEFAULT = mode;
      trace()('embed.default_set', { mode });
      return { ok: true, body: embedFleetView() };
    },

    async moveAll(mode, when) {
      if (sharedOff(mode)) {
        return { ok: false, status: 400, error: 'Turn the memory search service on first (Settings → Hosts).' };
      }
      const local = store.localHostId();
      let agents = store.listAllActiveAgents().filter((a) =>
        a.hostId === local && !a.ops && !a.migratedTo && (a.state === 'RUNNING' || a.state === 'STOPPED') && (a.embedMode ?? 'baked') !== mode);
      // Back to "their own engine" is only for images that carry one: an
      // engine-free image is switched straight back to the service at its build,
      // so rebuilding it changed nothing (use-case walk-through, 2026-09-27).
      let engineFree = 0;
      if (mode === 'baked' && local) {
        // Each image once, six at a time: the same image was inspected once
        // per agent, one after another, before any agent was marked (HB-0947).
        const images = [...new Set(agents.map((a) => a.image ?? undefined))];
        const infos = await sixAtATime(images, (image) => providerFor(local).currentImageInfo(image).catch(() => undefined));
        const free = new Set(images.filter((_, i) => infos[i]?.embedEngine === 'none'));
        const keep = agents.filter((a) => !free.has(a.image ?? undefined));
        engineFree = agents.length - keep.length;
        agents = keep;
      }
      let queued = 0;
      for (const a of agents) {
        store.setAgentEmbedMode(a.id, mode);
        trace(a.id)('embed.mode', { mode, by: 'move-all' });
      }
      if (when === 'now') {
        // The idle running ones through the queue (two at a time); the rest wait
        // for the quiet hours — never mid-conversation.
        for (const a of agents) {
          if (a.state !== 'RUNNING' || isBusy(a.id) || isInFlight(a.id)) continue;
          const last = await lastActiveFor(a).catch(() => undefined);
          if (last && Date.now() - Date.parse(last) < 10 * 60_000) continue;
          if (kickRebuild(a.id)) queued++;
        }
      }
      trace()('embed.move_all', { mode, when, switched: agents.length, queued, engineFree });
      return { ok: true, body: { ...embedFleetView(), switched: agents.length, queued, deferred: agents.length - queued, engineFree } };
    },

    at(hostId, caller) {
      if (!hostId || hostId === store.localHostId()) return { svc: embedder, owns: caller.ownsLocal() };
      const h = store.listHosts(caller.ownerId()).find((x) => x.id === hostId && x.kind !== 'local');
      return h ? { svc: embedderFor(h.id), owns: h.ownerId === caller.ownerId() } : undefined;
    },

    async guestHost() {
      return (await localProvider().hostAddressForAgents?.().catch(() => undefined)) ?? '127.0.0.1';
    },

    startTimers() {
      // At boot: a machine whose runtime image carries no engine (every image
      // since 2026.9.6) needs the service for every agent, so an untouched
      // service comes up with Hatchabot instead of waiting for a rebuild to
      // trip over it (the tool comes up by itself, 2026-09-25). A service
      // the owner stopped stays stopped; an external server needs no start.
      // Then the health loop over every enabled service (scheduleEmbedderBoot).
      stopTimers?.();
      stopTimers = scheduleEmbedderBoot({
        embedder, localHostId: () => store.localHostId(),
        imageInfo: (host) => providerFor(host).currentImageInfo(),
        log: (e, d) => trace()(e, d),
        services: () => [embedder, ...store.listRunnerHostIds().map(embedderFor)],
        warn: (detail, msg) => deps.warn(detail, msg),
        bootMs: Number(process.env.HATCHABOT_EMBED_BOOT_MS) || 15_000,
        healthMs: Number(process.env.HATCHABOT_EMBED_HEALTH_MS) || 5 * 60_000,
      });
    },

    stop() { stopTimers?.(); stopTimers = undefined; },
  };
}
