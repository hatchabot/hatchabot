import { join } from 'node:path';
import type { Agent } from '../../domain/types.js';
import type { ChannelKindForFiles } from '../../domain/filesLimit.js';
import { parseMemoryCap } from '../../domain/memoryCap.js';
import { agentMemoryLimits, COMPRESSED_SWAP_FIX, describeCompressedSwap, parseSwapAllowance, type CompressedSwap } from '../../domain/swap.js';
import { writeEnvVar } from '../../ops/tailnet.js';
import { ProviderError, type RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { defaultSpec, readMachineDefaults } from './machineDefaults.js';

/**
 * Defaults for this machine (HB-0808 step 15; the settings themselves are
 * machineDefaults.ts): written to .env, applied at once. A memory or swap
 * default reaches every agent this control plane runs that has no cap or
 * allowance of its own, in its limits turn; the engine's memory restarts the
 * memory search service this machine runs; a file ceiling is set live on
 * each agent on that app. Nothing here knows about HTTP: who may ask is the
 * route's, and a refusal is a result the route words.
 */
export interface Defaults {
  /** Every default, with the compressed swap note beside "Compressed swap per agent" when the machine says. */
  view(): Promise<{ defaults: ReturnType<typeof readMachineDefaults> }>;
  /** Set one, by its key, to the value as sent (text). */
  set(key: string, value: string): Promise<DefaultSet>;
}

export type DefaultSet =
  /** `notApplied`: saved, but not yet in effect, and why (the memory search service did not restart). */
  | { ok: true; answer: { default: ReturnType<typeof readMachineDefaults>[number] | undefined; applied: number; volumeGone?: string[]; notApplied?: string } }
  /** `invalid`: no such setting, or a value it does not take. `not-written`: .env was not written. Each with its words. */
  | { ok: false; why: 'invalid' | 'not-written'; error: string };

export interface DefaultsDeps {
  store: Store;
  providerFor: (hostId: string) => RuntimeProvider;
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** The agent's limits turn (the agent settings service's). */
  inLimitsTurn: <T>(agentId: string, fn: () => Promise<T>) => Promise<T>;
  /** A running agent's managed AGENTS.md sections brought up to date; never rejects. */
  syncDocsHeld: (agent: Agent) => Promise<void>;
  /** An agent's file ceiling on each of its apps, or on one, set live. */
  /** `skipped`: nothing to write to (being set up, rebuilt, moved or deleted), which says nothing of its machine. */
  applyFilesCap: (agent: Agent, only?: ChannelKindForFiles) => Promise<{ applied: number; gone: boolean; skipped?: true }>;
  /** This machine's memory search service. */
  embedder: () => { readonly enabled: boolean; readonly external: string | undefined; restart(): Promise<unknown> };
}

/** The machine-defaults note beside "Compressed swap per agent". */
const swapNote = (sw: CompressedSwap): string => sw.compressed
  ? `This machine compresses swap: ${describeCompressedSwap(sw)}.`
  : `${sw.why ?? 'No compressed swap here.'} To turn it on: ${COMPRESSED_SWAP_FIX}.`;

export function createDefaults(deps: DefaultsDeps): Defaults {
  const { store, providerFor, trace, inLimitsTurn, syncDocsHeld, applyFilesCap } = deps;
  return {
    async view() {
      // Compressed swap: whether this machine has it, beside the setting.
      const localId = store.localHostId();
      const sw = localId ? await (async () => providerFor(localId).compressedSwap?.())().catch(() => undefined) : undefined;
      return { defaults: readMachineDefaults().map((d) => d.key === 'agentSwap' && sw ? { ...d, note: swapNote(sw) } : d) };
    },
    async set(key, value) {
      const spec = defaultSpec(key);
      if (!spec) return { ok: false, why: 'invalid', error: 'Unknown setting.' };
      const checked = spec.check(value);
      if (!checked.ok) return { ok: false, why: 'invalid', error: checked.error };
      const envFile = process.env.HATCHABOT_ENV_FILE ?? join(process.cwd(), '.env');
      const wrote = await writeEnvVar(envFile, spec.env, checked.value, () => true, `Written by Hatchabot: ${spec.label} (Settings → Hosts → Defaults for this machine).`)
        .catch((err: unknown) => ({ ok: false, error: String(err) }));
      if (!wrote.ok) return { ok: false, why: 'not-written', error: wrote.error ?? 'Could not write .env' };
      process.env[spec.env] = checked.value;
      let applied = 0;
      // Every agent this control plane runs, runners included: their next build
      // takes these values from this .env anyway, and the live paths (docker
      // update, openclaw config set) reach a runner through its provider just as
      // the per-agent settings do. Only this machine's agents got them before,
      // though the page said "on every agent" (2026-09-30). A runner that fails
      // once is skipped for the rest of this change — one unreachable runner
      // must not hold the page for a Docker timeout per agent.
      const local = store.localHostId();
      const fleet = store.listAllActiveAgents().filter((a) => a.runtimeRef && (a.state === 'RUNNING' || a.state === 'STOPPED') && !!store.getHost(a.hostId));
      const unreachable = new Set<string>();
      const volumeGone: string[] = [];
      let notApplied: string | undefined;
      if (spec.key === 'agentMemory' || spec.key === 'agentSwap') {
        for (const a of fleet) {
          const told = await inLimitsTurn(a.id, async () => {
            const now = store.getAgent(a.id);
            if (!now?.runtimeRef || (now.state !== 'RUNNING' && now.state !== 'STOPPED') || now.migratedTo || !store.getHost(now.hostId) || unreachable.has(now.hostId)) return;
            const cls = now.classId ? store.getAgentClass(now.classId) : undefined;
            // A cap or allowance saved while this default waited stands.
            if (spec.key === 'agentMemory'
              ? parseMemoryCap(now.memoryCap) || parseMemoryCap(cls?.memoryCap)
              : parseSwapAllowance(now.swapAllowance) !== undefined || parseSwapAllowance(cls?.swapAllowance) !== undefined) return;
            const prov = providerFor(now.hostId), lim = agentMemoryLimits(store, now);
            if (!prov.updateMemory) return;
            try { await prov.updateMemory(now.runtimeRef, lim.memory, lim.swap); applied++; }
            catch { if (now.hostId !== local) unreachable.add(now.hostId); return; }
            return spec.key === 'agentMemory' && now.state === 'RUNNING' ? now : undefined;
          });
          if (told) void syncDocsHeld(told);
        }
      } else if (spec.key === 'engineMemory') {
        const embedder = deps.embedder();
        // Applied once the service has restarted, not before: a stop or start
        // Docker refused was reported as applied, though the engine kept its
        // old memory, or was left down (HB-0937).
        if (embedder.enabled && !embedder.external) {
          try { await embedder.restart(); applied = 1; }
          catch (err) {
            // In the words the page gets from Restart itself (embedderRoutes.ts),
            // never Docker's. What each failure leaves, now that a start
            // replaces an engine on another limit, and fails if Docker will
            // not let the old one go (HB-1021): the door's stop refused, both
            // up on the old memory, until the health check (every 5 minutes)
            // finds the engine off its limit and starts it again; the engine's
            // stop refused or the start failed, memory search off until the
            // health check starts it. Hatchabot's own start at boot (a deploy,
            // a restart, a reboot) starts it too, and so do Start and Restart.
            const why = err instanceof ProviderError ? err.userMessage : err instanceof Error ? err.message : String(err);
            notApplied = `The memory search service did not restart: ${why.trim().replace(/([^.!?])$/, '$1.')} It may keep its old memory, or be off, until it next starts: Hatchabot tries again within about 5 minutes, and at its own next start. To do it now, press Restart under Settings → Hosts → Memory search service (Start, if it shows Start).`;
          }
        }
      } else if (spec.key.startsWith('files')) {
        const kind = spec.key.slice(5).toLowerCase() as ChannelKindForFiles;
        for (const a of fleet) {
          if (unreachable.has(a.hostId)) continue;
          const r = await applyFilesCap(a, kind);
          applied += r.applied;
          if (r.gone) volumeGone.push(a.name);
          else if (!r.applied && !r.skipped && a.hostId !== local && store.listChannelsForAgent(a.id).some((c) => c.kind === kind)) unreachable.add(a.hostId);
        }
      }
      trace()('machine.default_set', { key: spec.key, value: checked.value || 'off', applied, ...(notApplied ? { notApplied } : {}) });
      return { ok: true, answer: { default: readMachineDefaults().find((d) => d.key === spec.key), applied, ...(volumeGone.length ? { volumeGone } : {}), ...(notApplied ? { notApplied } : {}) } };
    },
  };
}
