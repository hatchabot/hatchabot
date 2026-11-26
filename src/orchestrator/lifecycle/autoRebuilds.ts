import { join } from 'node:path';
import type { Agent } from '../../domain/types.js';
import { pickAutoRebuilds, rebuildNeed, rebuildPolicy, type RebuildPolicy } from '../../domain/rebuildPolicy.js';
import { writeEnvVar } from '../../ops/tailnet.js';
import type { RuntimeInfo, RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { sixAtATime } from '../../util/queues.js';
import { isBusy } from './busy.js';
import { renderRefusedRecently } from './provision.js';
import { MAX_REBUILD_CONCURRENCY } from './rebuildQueue.js';

/**
 * The machine's own rebuilds (HB-0808 step 11): which agents need a rebuild
 * (`rebuildNeedOf`, against the default image of their machine), the sweep
 * that rebuilds the ones its policy allows now (`rebuildSweep`, through the
 * same queue a Rebuild button uses), and the two settings an owner sets in
 * .env: the policy and how many rebuild at once. Part of the agent lifecycle
 * service (agentLifecycle.ts). Who may change a setting, and the words of a
 * refusal, are the routes' (src/api/agents/lifecycleRoutes.ts). `stop()` ends the
 * sweep's interval.
 */
export interface AutoRebuilds {
  /** Why this agent needs a rebuild, if it does (RUNNING or STOPPED with a container); pinned agents never chase the default image. */
  rebuildNeedOf(a: Agent): Promise<{ running: RuntimeInfo; current: RuntimeInfo; imageBehind: boolean; need: ReturnType<typeof rebuildNeed> } | undefined>;
  /** Rebuild the idle agents the policy allows now; the ids it queued. */
  rebuildSweep(now?: Date): Promise<string[]>;
  /** Write the policy to .env and use it from now; `error` when .env could not be written. */
  setPolicy(policy: RebuildPolicy): Promise<{ ok: boolean; error?: string }>;
  /** Rebuilds at once, those waiting a slot, those running, and the most allowed. */
  concurrencyView(): { atOnce: number; queued: number; running: number; max: number };
  /** Write how many rebuild at once to .env, and use it at once; `error` when .env could not be written. */
  setAtOnce(n: number): Promise<{ ok: boolean; error?: string }>;
  stop(): void;
}

/** What it needs from the process it runs in. Functions only, so a test hands it fakes. */
export interface AutoRebuildsDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** The queue's: rebuild in the background (false when it would not). */
  kickRebuild: (agentId: string) => boolean;
  /** The queue's: a setup or rebuild in flight for the agent. */
  isInFlight: (agentId: string) => boolean;
  /** The queue's: how many at once, and how many wait and run. */
  queueAtOnce: () => number;
  queueCounts: () => { queued: number; running: number };
  setQueueAtOnce: (n: number) => void;
  /** The owner switched its memory search engine and the rebuild is still owed. */
  switchPendingFor: (a: Agent) => boolean;
  /** Its last activity, with `read` only when its conversations were read (an unattended rebuild must not interrupt it). */
  activityEvidence: (a: Agent) => Promise<{ read: boolean; lastActiveAt?: string }>;
  /** A line to the server's log for a sweep that failed. */
  warn: (detail: Record<string, unknown>, msg: string) => void;
  /** The sweep's interval; 0 starts none (the tests, as before). */
  sweepEveryMs: number;
}

export function createAutoRebuilds(deps: AutoRebuildsDeps): AutoRebuilds {
  const { store, providerFor, trace, kickRebuild, isInFlight, setQueueAtOnce, switchPendingFor, activityEvidence } = deps;

  /** Why this agent needs a rebuild, if it does. Pinned agents never chase the default image. */
  // The default image is per host, not per agent: one lookup per host per
  // 10 s, not 45 in a burst every list and every sweep (26th audit).
  const imageInfoCache = new Map<string, { at: number; value: Promise<RuntimeInfo> }>();
  const currentImageInfoFor = (hostId: string): Promise<RuntimeInfo> => {
    const hit = imageInfoCache.get(hostId);
    if (hit && Date.now() - hit.at < 10_000) return hit.value;
    const value = providerFor(hostId).currentImageInfo();
    imageInfoCache.set(hostId, { at: Date.now(), value });
    value.catch(() => imageInfoCache.delete(hostId));
    return value;
  };

  const rebuildNeedOf = async (a: Agent) => {
    if (!a.runtimeRef || (a.state !== 'RUNNING' && a.state !== 'STOPPED')) return undefined;
    const provider = providerFor(a.hostId);
    const [running, current] = await Promise.all([provider.info(a.runtimeRef), currentImageInfoFor(a.hostId)]);
    const imageBehind = !a.image && !!(running.imageId && current.imageId && running.imageId !== current.imageId);
    return { running, current, imageBehind, need: rebuildNeed(running, imageBehind, undefined, { running: running.openclawVersion, current: current.openclawVersion }) };
  };

  const setAtOnce = async (n: number): Promise<{ ok: boolean; error?: string }> => {
    const envFile = process.env.HATCHABOT_ENV_FILE ?? join(process.cwd(), '.env');
    const wrote = await writeEnvVar(envFile, 'HATCHABOT_REBUILD_CONCURRENCY', String(n), () => true,
      'Written by Hatchabot: how many agents rebuild at once (Settings → Hosts → Automatic rebuilds).')
      .catch((err: unknown) => ({ ok: false, error: String(err) }));
    if (!wrote.ok) return wrote;
    process.env.HATCHABOT_REBUILD_CONCURRENCY = String(n);
    setQueueAtOnce(n); // live: queued rebuilds follow the new number at once
    trace()('rebuild.concurrency_set', { atOnce: n });
    return { ok: true };
  };
  const setPolicy = async (policy: RebuildPolicy): Promise<{ ok: boolean; error?: string }> => {
    const envFile = process.env.HATCHABOT_ENV_FILE ?? join(process.cwd(), '.env'); // (tests point it elsewhere)
    const wrote = await writeEnvVar(envFile, 'HATCHABOT_REBUILD_POLICY', policy, () => true,
      'Written by Hatchabot: when agents are rebuilt on their own (Settings → Hosts → Automatic rebuilds).')
      .catch((err: unknown) => ({ ok: false, error: String(err) }));
    if (!wrote.ok) return wrote;
    process.env.HATCHABOT_REBUILD_POLICY = policy; // live: the sweep reads it each time
    trace()('rebuild.policy_set', { policy });
    return { ok: true };
  };

  /**
   * The machine's own rebuilds. Every few minutes: agents whose rebuild the
   * policy allows now, idle ones only, two at a time through the same queue a
   * Rebuild button uses. Exported for tests via the returned handle. One
   * sweep at a time, as the wake sweep: a slow one (its looks six at a time)
   * was joined by the next interval's, and they looked at every agent twice
   * (HB-1128).
   */
  let sweeping = false;
  const rebuildSweep = async (now = new Date()): Promise<string[]> => {
    if (sweeping) return [];
    sweeping = true;
    try {
      return await sweepOnce(now);
    } finally {
      sweeping = false;
    }
  };
  const sweepOnce = async (now: Date): Promise<string[]> => {
    const policy = rebuildPolicy();
    if (policy === 'manual') return [];
    const agents = store.listAllActiveAgents().filter((a) => a.state === 'RUNNING' && !a.ops && !a.migratedTo);
    // Six agents at a time: each look is a docker inspect (or ssh) and maybe
    // an exec, and every running agent's at once was a burst the size of the
    // fleet (HB-1128).
    const candidates = await sixAtATime(agents, async (a) => {
      const need = await rebuildNeedOf(a).then((r) => r?.need, () => undefined);
      const switchPending = switchPendingFor(a);
      // Asking an agent when it last talked is a docker exec: only for the ones that matter.
      const activity = need || switchPending ? await activityEvidence(a) : { read: false };
      return {
        id: a.id,
        state: a.state,
        ops: a.ops,
        busy: isBusy(a.id) || isInFlight(a.id) || renderRefusedRecently(a.id),
        need,
        switchPending,
        lastActiveAt: activity.lastActiveAt,
        activityRead: activity.read,
      };
    });
    const picked = pickAutoRebuilds(candidates, policy, now);
    const kicked: string[] = [];
    for (const id of picked) {
      const c = candidates.find((x) => x.id === id)!;
      // Judged on the list read before the activity reads: an agent its owner
      // stopped (or that moved) meanwhile is not rebuilt — the rebuild took
      // its own fresh look, saw nothing change after it, and started it
      // again (audit #095).
      const listed = agents.find((a) => a.id === id)!;
      const cur = store.getAgent(id);
      if (!cur || cur.state !== 'RUNNING' || cur.hostId !== listed.hostId || cur.runtimeRef !== listed.runtimeRef || cur.migratedTo) {
        trace(id)('rebuild.skipped', { why: cur?.state === 'STOPPED' ? 'stopped before it was queued' : 'it changed before it was queued' });
        continue;
      }
      trace(id)('rebuild.auto', { level: c.need?.level ?? 'switch', reasons: c.need?.reasons ?? ['memory search engine switch'], policy });
      kickRebuild(id);
      kicked.push(id);
    }
    return kicked;
  };

  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  if (deps.sweepEveryMs > 0) {
    sweepTimer = setInterval(() => { void rebuildSweep().catch((err) => deps.warn({ err }, 'rebuild sweep failed')); }, deps.sweepEveryMs);
    sweepTimer.unref();
  }

  return {
    rebuildNeedOf, rebuildSweep, setPolicy, setAtOnce,
    concurrencyView: () => ({ atOnce: deps.queueAtOnce(), ...deps.queueCounts(), max: MAX_REBUILD_CONCURRENCY }),
    stop: () => { if (sweepTimer) clearInterval(sweepTimer); sweepTimer = undefined; },
  };
}
