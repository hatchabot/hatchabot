import type { Agent } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import type { Store } from '../../store/store.js';
import { isBusy } from '../lifecycle/busy.js';
import { cappedModelOf, syncContextCap } from '../memory/compaction.js';
import { snapshotDailyUsage } from './fleetUsage.js';
import { evaluateModelChanges, fileGuardProposals } from './modelLedger.js';
import { sampleSourceUsage } from './sourceUsage.js';
import { runTokenWatch } from './tokenWatch.js';
import { runUsageAlerts } from './usageAlerts.js';

/**
 * The usage pass (HB-0808): every ten
 * minutes, each agent's model calls are read from its own logs and stored
 * per hour (sourceUsage.ts), and then, in order: the model-change guard, the
 * token steward (loop incidents, and context caps written where they are
 * owed), the spike warnings (after the loops, so a loop told in the pass
 * covers its spike) and the budgets. The exact % of a Claude plan isn't
 * readable with a setup-token.
 *
 * Its state, sorted (HB-0809):
 *  - `capRetryAt`: when a context cap whose write was refused is tried again
 *    (a cache: a back-off; the cap itself is in the store).
 *  - the pass under way (`sampling`) and when the last one ended
 *    (`sampledAt`): plain variables. One pass at a time.
 *
 * Its timers: the first pass 90 seconds after the start, then one every
 * `sampleEveryMs`; none when that is 0 (the tests) or not a number above 0.
 * Both are `unref()`'d and end with `stop()`.
 */
export interface UsageSampler {
  /** One pass now, or the one under way. Never rejects: a failure is logged (`usage.sample_failed`). */
  sample(): Promise<unknown>;
  /** When the last pass ended, if one has since the start. */
  sampledAt(): string | undefined;
  /** Is a pass under way? */
  sampling(): boolean;
  /** The pass's model-change guard on its own: verdicts that are due, and a worse one's switch-back card. Never throws. */
  guardModels(): void;
  /** The pass's token steward on its own: loop incidents, then the context caps owed to running agents. */
  stewardTokens(): Promise<void>;
  /** End the timers: at shutdown. */
  stop(): void;
}

/** What the pass needs from the process it runs in. Functions only, so a test hands it fakes. */
export interface UsageSamplerDeps {
  store: Store;
  /** The secrets the sampler reads a source's rate limits with. */
  secrets: SecretStore;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** A budget's, a spike's or a loop's message to its owner; true if it reached them. */
  tell: (ownerId: string, agent: Agent, text: string) => Promise<boolean>;
  /** A card waiting on the owner's phone (the quality guard's switch-back). Never rejects. */
  push: (ownerId: string, headline: string, detail?: string) => void;
  /** The budgets' pass, last in each usage pass. */
  budgetPass: () => Promise<unknown>;
  /** The service log. */
  log: { info: (detail: Record<string, unknown>, msg: string) => void; warn: (detail: Record<string, unknown>, msg: string) => void };
  /** How often a pass runs; 0 (or anything not above 0) starts no timer. */
  sampleEveryMs: number;
}

export function createUsageSampler(deps: UsageSamplerDeps): UsageSampler {
  const { store, secrets, providerFor, trace, log } = deps;
  const tellUsageSpike = deps.tell;

  let usageSampling: Promise<unknown> | null = null;
  let usageSampledAt: string | undefined;
  /** The daily trend point, from the sampler's readings (fleetUsage.ts). */
  const snapshotUsageFromSamples = () => snapshotDailyUsage(store);
  /**
   * After each usage pass: model changes that are due get their verdict from
   * the profiles just stored, and a worse one gets Hatchabot's switch-back
   * card (once), announced the way other cards are (modelLedger.ts).
   */
  const runModelGuard = () => {
    try {
      evaluateModelChanges(store);
      fileGuardProposals({
        store,
        push: deps.push,
        log: (event, detail) => { trace(String(detail.agentId ?? 'admin'))(event, detail); },
      });
    } catch (err) { log.warn({ err: String(err) }, 'model.guard_failed'); }
  };
  /**
   * After each usage pass (the same timer): Hatchabot's loop watcher opens and
   * clears "Alerts" incidents from what the pass stored and tells each new
   * one once on the manager's chat (tokenWatch.ts); and a context cap that is
   * not yet in a running agent's config (it was asleep, or its model moved)
   * is written there (compaction.ts). Never wakes an agent.
   */
  const runTokenSteward = async () => {
    await runTokenWatch({ store, tell: tellUsageSpike, log: (event, detail) => { trace(String(detail.agentId ?? ''))(event, detail); } })
      .catch((err) => log.warn({ err: String(err) }, 'token.watch_failed'));
    for (const a of store.listAllActiveAgents()) {
      const cap = a.state === 'RUNNING' && a.runtimeRef && !isBusy(a.id) ? store.getContextCap(a.id) : undefined;
      if (!cap) continue;
      // The model its container runs (a source switch waiting for its rebuild: the old one).
      const running = cappedModelOf(store, a);
      if (!running) continue;
      const want = cap.tokens && running.profile.vendor !== 'local' ? `${running.provider}/${running.id}` : undefined;
      // A cap changed after it was last written (saved while stopped or busy)
      // is on the same model: the model alone said "done" for good (HB-0318).
      const changed = !!cap.tokens && (!cap.appliedAt || cap.setAt > cap.appliedAt);
      if ((want ?? null) === (cap.appliedModel ?? null) && !changed) continue;
      // A write that was refused (a hand edit, a busy gateway) waits 6 hours, not every pass; a rebuild tries at once.
      if ((capRetryAt.get(a.id) ?? 0) > Date.now()) continue;
      const r = await syncContextCap({ store, provider: providerFor(a.hostId), log: (e, d) => trace(a.id)(e, d) }, a, a.runtimeRef!).catch(() => 'failed' as const);
      if (r === 'failed' || r === 'changed-by-hand') capRetryAt.set(a.id, Date.now() + 6 * 3_600_000); else capRetryAt.delete(a.id);
    }
  };
  const capRetryAt = new Map<string, number>();
  const runUsageSample = () => {
    if (usageSampling) return usageSampling;
    usageSampling = sampleSourceUsage({ store, secrets, providerFor, log: (e, d) => log.info(d, e) })
      .then(async (r) => { usageSampledAt = new Date().toISOString(); if (r.limited) log.info(r, 'usage.sample_rate_limits_seen'); try { snapshotUsageFromSamples(); } catch (err) { log.warn({ err: String(err) }, 'usage.snapshot_failed'); }
        runModelGuard();
        // The loop watcher before the spike check: a loop told in this pass
        // covers the spike it causes (one cause, one message; usageAlerts.ts).
        await runTokenSteward();
        await runUsageAlerts({ store, tell: tellUsageSpike, log: (e, d) => log.info(d, e) }).catch((err) => log.warn({ err: String(err) }, 'usage.alerts_failed'));
        await deps.budgetPass();
        return r; })
      .catch((err) => log.warn({ err: String(err) }, 'usage.sample_failed'))
      .finally(() => { usageSampling = null; });
    return usageSampling;
  };

  let firstPass: ReturnType<typeof setTimeout> | undefined;
  let passes: ReturnType<typeof setInterval> | undefined;
  const every = deps.sampleEveryMs;
  if (every > 0) {
    firstPass = setTimeout(() => { void runUsageSample(); }, 90_000).unref();
    passes = setInterval(() => { void runUsageSample(); }, every).unref();
  }

  return {
    sample: runUsageSample,
    sampledAt: () => usageSampledAt,
    sampling: () => !!usageSampling,
    guardModels: runModelGuard,
    stewardTokens: runTokenSteward,
    stop: () => {
      if (firstPass) clearTimeout(firstPass);
      if (passes) clearInterval(passes);
      firstPass = passes = undefined;
    },
  };
}
