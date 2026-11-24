import { totalmem } from 'node:os';
import type { Agent } from '../../domain/types.js';
import { describeCompressedSwap } from '../../domain/swap.js';
import { ProviderError, type ContainerStats, type RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';

/**
 * Live CPU and memory (HB-0808): per
 * agent and per machine, as Status → Resources shows them, and the peaks and
 * cap hits an owner clears. The agent's own page reads its peak and cap hits
 * through `peakSinceClear` and `capHitsSince` too.
 *
 * Its state, sorted (HB-0809):
 *  - `statsCache`: one docker stats sample per machine, shared while it is
 *    taken and for three seconds after it answers (a cache). No timer.
 *
 * Nothing here knows about HTTP: a route checks who is asking, asks this,
 * and words the answer.
 */
export interface Resources {
  /**
   * Every machine the caller is listed, with the containers they may see on
   * it: their own and shared agents; for the machine's owner (`owner`) every
   * agent, the machine-level containers and whether swap is compressed.
   */
  fleet(ownerId: string, owner: boolean): Promise<{ at: string; hosts: unknown[] }>;
  /** Forget the peaks and cap hits of these agents: they count from now. How many. */
  clearPeaksOf(agentsToClear: Agent[]): Promise<number>;
  /** The peak to show: the kernel's since the container started, or the app's high-water mark since the owner cleared it. */
  peakSinceClear(a: Agent, kernelPeak: number | undefined, current: number | undefined): number | undefined;
  /** Cap hits since the baseline a clear (or a new cap) recorded. */
  capHitsSince(a: Agent, raw: number | undefined, startedAt?: string): number | undefined;
}

/** What the readings need from the process they run in. Functions only, so a test hands them fakes. */
export interface ResourcesDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
}

export function createResources(deps: ResourcesDeps): Resources {
  const { store, providerFor, trace } = deps;

  // docker samples every container for a second per call: one sample per host
  // per 3 s serves every viewer, however many keep the tab open (27th audit).
  // A sample still being taken is shared however long it takes, and the three
  // seconds count from its answer: counted from its start, a slow Docker had
  // every viewer start another sample each poll (HB-0880). A failed one is
  // forgotten only while it is still the one kept.
  const statsCache = new Map<string, { answeredAt?: number; value: Promise<ContainerStats[]> }>();
  const statsFor = (hostId: string, provider: RuntimeProvider): Promise<ContainerStats[]> => {
    const hit = statsCache.get(hostId);
    if (hit && (hit.answeredAt === undefined || Date.now() - hit.answeredAt < 3_000)) return hit.value;
    const entry: { answeredAt?: number; value: Promise<ContainerStats[]> } = { value: provider.stats!() };
    statsCache.set(hostId, entry);
    entry.value.then(
      () => { entry.answeredAt = Date.now(); },
      () => { if (statsCache.get(hostId) === entry) statsCache.delete(hostId); },
    );
    return entry.value;
  };
  /** The peak to show: the kernel's since the container started, or the app's high-water mark since the owner cleared it. */
  const peakSinceClear = (a: Agent, kernelPeak: number | undefined, current: number | undefined): number | undefined => {
    if (!a.memoryPeakClearedAt) return kernelPeak;
    return current === undefined ? Math.max(a.memoryPeakSince ?? 0, 0) || undefined : store.bumpMemoryPeak(a.id, current);
  };
  /**
   * Cap hits since the baseline a clear (or a new cap) recorded. The kernel's
   * counter only grows within one container; a reading below the baseline is
   * a new one's (a rebuild, a start, a wake) counting from zero, so the
   * baseline goes and the reading counts whole — subtracted, real pressure
   * read zero until the new container passed the old one's total (audit #054).
   * A reading from a container that started after the baseline's (`startedAt`)
   * is a new counter too, even once it has passed the old total (HB-0234).
   */
  const capHitsSince = (a: Agent, raw: number | undefined, startedAt?: string): number | undefined => {
    if (raw === undefined) return undefined;
    const base = a.memoryCapBaseline ?? 0;
    const sameContainer = !startedAt || !a.memoryCapBaselineStartedAt || startedAt === a.memoryCapBaselineStartedAt;
    if (raw >= base && sameContainer) return raw - base;
    store.rebaseMemoryCapHits(a.id, base);
    return raw;
  };
  /**
   * The container an agent's ref names on its machine, by its provider's rule
   * (containerName): a legacy `docker://<uuid>` ref's is not its bare
   * fragment. Read as the fragment, such an agent was left out of its
   * machine's totals, and Clear kept its cap hits (HB-1117).
   */
  const containerOf = (a: Agent): string => {
    const ref = a.runtimeRef ?? '';
    if (!ref) return '';
    let provider: RuntimeProvider | undefined;
    try { provider = providerFor(a.hostId); } catch { /* a machine no longer known: the name as written */ }
    return provider?.containerName?.(ref) ?? ref.replace(/^docker:\/\//, '');
  };
  /** Forget the peaks and cap hits of these agents: they count from now. */
  const clearPeaksOf = async (agentsToClear: Agent[]): Promise<number> => {
    let n = 0;
    const byHost = new Map<string, Agent[]>();
    for (const a of agentsToClear) byHost.set(a.hostId, [...(byHost.get(a.hostId) ?? []), a]);
    for (const [hostId, list] of byHost) {
      const provider = providerFor(hostId);
      let rows: ContainerStats[] = [];
      try { rows = provider.stats ? await statsFor(hostId, provider) : []; } catch { rows = []; }
      const byName = new Map(rows.map((r) => [r.name, r]));
      for (const a of list) {
        const r = byName.get(containerOf(a));
        store.clearMemoryPeaks(a.id, r?.memCapHits ?? 0, r?.startedAt);
        trace(a.id)('memory.peaks_cleared', { agentId: a.id });
        n++;
      }
    }
    return n;
  };

  /**
   * Live CPU and memory, per agent and per machine (docker stats, one call per
   * host). Your own and shared agents; the machine owner also sees the
   * machine-level containers (the memory search service, doormen).
   */
  const fleet: Resources['fleet'] = async (ownerId, owner) => {
    const visible = new Map(store.listVisibleAgents(ownerId).map((a) => [containerOf(a), a]));
    const everyone = owner ? new Map(store.listAllActiveAgents().map((a) => [containerOf(a), a])) : visible;
    const hosts = await Promise.all(store.listHosts(ownerId).map(async (h) => {
      const provider = providerFor(h.id);
      if (!provider.stats) return { id: h.id, name: h.name, kind: h.kind, containers: [], error: 'not measurable' };
      // A machine that is asleep or offline answers at once, not after ssh's connect timeout (2026-10-05).
      if (provider.reachable && !(await provider.reachable())) return { id: h.id, name: h.name, kind: h.kind, containers: [], unreachable: true, error: "Its machine isn't answering — it may be asleep or offline." };
      try {
        const rows = await statsFor(h.id, provider);
        type Row = ContainerStats & { agentId?: string; agentName?: string; role: 'agent' | 'hatchabot' | 'embedder' | 'embed-door' | 'doorman'; mine?: boolean; shared?: boolean };
        const containers = rows.flatMap((r): Row[] => {
          const a = everyone.get(r.name);
          if (a) {
            if (!visible.has(r.name) && !owner) return [];
            // Since the owner last cleared the peaks (Status → Resources), when they did.
            r = { ...r, memPeakBytes: peakSinceClear(a, r.memPeakBytes, r.memBytes), memCapHits: capHitsSince(a, r.memCapHits, r.startedAt), clearedAt: a.memoryPeakClearedAt } as typeof r & { clearedAt?: string };
            return [{ ...r, agentId: a.id, agentName: a.name, role: a.ops ? 'hatchabot' as const : 'agent' as const, mine: a.ownerId === ownerId, shared: a.ownerId !== ownerId && visible.has(r.name) }];
          }
          if (!owner) return [];
          const role = /-embedder$/.test(r.name) ? 'embedder' : /-embed-door$/.test(r.name) ? 'embed-door' : /-doorman-/.test(r.name) ? 'doorman' : 'other';
          if (role === 'other') return [];
          return [{ ...r, role: role as 'embedder' | 'embed-door' | 'doorman' }];
        });
        return { id: h.id, name: h.name, kind: h.kind, containers, totals: {
          cpuPct: Math.round(containers.reduce((s, c) => s + c.cpuPct, 0) * 10) / 10,
          memBytes: containers.reduce((s, c) => s + c.memBytes, 0),
          // Caps are ceilings, not reservations: what matters is whether the
          // peaks, all reached at once, would fit the machine.
          memPeakBytes: containers.reduce((s, c) => s + (c.memPeakBytes ?? c.memBytes), 0),
          memCapBytes: containers.reduce((s, c) => s + c.memLimitBytes, 0),
          swapBytes: containers.reduce((s, c) => s + (c.swapBytes ?? 0), 0),
          ...(h.kind === 'local' ? { machineMemBytes: totalmem() } : {}),
        },
        // Whether this host compresses swap, for the machine's owner (swap.ts).
        ...(owner ? await (async () => { const sw = await provider.compressedSwap?.(); return sw ? { swap: { kind: sw.kind, compressed: sw.compressed, summary: sw.compressed ? describeCompressedSwap(sw) : sw.why } } : {}; })().catch(() => ({})) : {}),
        };
      } catch (err) {
        return { id: h.id, name: h.name, kind: h.kind, containers: [], error: err instanceof ProviderError ? err.userMessage : 'unreachable' };
      }
    }));
    return { at: new Date().toISOString(), hosts };
  };

  return { fleet, clearPeaksOf, peakSinceClear, capHitsSince };
}
