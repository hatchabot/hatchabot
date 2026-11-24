import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { sixAtATime } from '../../util/queues.js';
import { costAgents, costsFor, TtlCache, type AgentCost } from './agentCosts.js';
import { localDay } from './fleetUsage.js';
import { estimateCost, pricesNothing } from './pricing.js';
import { agentUsage } from './usage.js';
import { foldPractice, practiceSummary } from './practiceUsage.js';

/**
 * What the Usage and Cost views read (HB-0808): the home
 * screen's cost badges, and the fleet's use read live from
 * each running agent's container.
 *
 * Its state, sorted (HB-0809):
 *  - `costCache`: one cost answer per person and window for five minutes (a
 *    cache, a TtlCache of agentCosts.ts). No timer.
 *
 * Nothing here knows about HTTP: a route checks who is asking and what was
 * asked, asks this, and words the answer.
 */
export interface UsageReadings {
  /**
   * What each agent this person sees cost at API prices over the last `days`
   * (agentCosts.ts costsFor), with `bands` when a period was asked; one
   * answer per person and `key` (the window) for five minutes. `at`: when
   * it was worked out.
   */
  costBadges(ownerId: string, key: string, days: number, bands?: readonly number[]): { value: Record<string, AgentCost>; at: number };
  /**
   * The fleet usage rollup: every RUNNING agent of the owner's, ranked by
   * tokens, read live from each container (a STOPPED one, or one whose read
   * fails, is counted as `skipped`, not as zero). Records today's snapshot
   * as a side effect.
   */
  fleetUsage(ownerId: string): Promise<FleetUsage>;
}

/** The answer of GET /v1/usage. */
export type FleetUsage = Awaited<ReturnType<typeof computeFleetUsage>>;

/** What the readings need from the process they run in. Functions only, so a test hands them fakes. */
export interface UsageReadingsDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
}

export function createUsageReadings(deps: UsageReadingsDeps): UsageReadings {
  const { store } = deps;

  /**
   * The home screen's cost badges and View by → Cost (agentCosts.ts): what
   * each agent this person sees cost at API prices over the last `days`
   * (7 by default), and as a monthly rate. From the sampler's stored
   * profiles only: no container is read and no agent is woken. One answer
   * per person and window for five minutes. A web-chat guest gets none.
   */
  const costCache = new TtlCache<Record<string, AgentCost>>(5 * 60_000);
  const costBadges = (me: string, key: string, days: number, bands?: readonly number[]) => {
    const hit = costCache.get(`${me}|${key}`, Date.now(), () => costsFor(store, me, days, Date.now(), bands));
    // Who sees which agent is read each time: a member whose access was taken
    // away kept seeing that agent's cost for the rest of the five minutes (HB-1098).
    const now = new Set(costAgents(store, me).map((a) => a.id));
    return { value: Object.fromEntries(Object.entries(hit.value).filter(([id]) => now.has(id))), at: hit.at };
  };

  return { costBadges, fleetUsage: (ownerId) => computeFleetUsage(deps, ownerId) };
}

// Fleet usage rollup: every RUNNING agent the caller can see, ranked by
// tokens. Live-only — usage is read from each agent's live container, so
// STOPPED agents have no session data to report and are counted as `skipped`
// rather than shown as zero. One flaky container never sinks the list: its
// read is caught and it drops to `skipped` too.
// The rollup as a function, so both the route and the daily snapshot job can
// call it. Records today's snapshot (upsert by day) as a side effect — so a
// usage trend accrues from normal use, no dedicated expensive job required.
async function computeFleetUsage(deps: UsageReadingsDeps, ownerId: string) {
  const { store, providerFor } = deps;
  // The owner's own agents only: usage is what their plan spends (30th audit; the same rule as the periods view).
  const visible = store.listAgents(ownerId);
  const running = visible.filter((a) => a.state === 'RUNNING' && a.runtimeRef);
  const skipped0 = visible.filter((a) => a.state !== 'RUNNING' || !a.runtimeRef).length;
  const results = await sixAtATime(
    running, async (a) => {
      try {
        // Strict, so a failed read lands in `skipped` below instead of counting as 0 (review, 2026-09-29).
        // Its practice runs, which its transcripts do not hold, added and said apart, as its own Usage page does (HB-1246).
        const practice = practiceSummary(store, a.id);
        const u = foldPractice(await agentUsage(providerFor(a.hostId), a.runtimeRef!, a.slug, { strict: true }), practice);
        // The source its container runs: a switch saved but not rebuilt yet still
        // spends on the old one, and was labelled and priced as the new (HB-1009).
        const p = store.getAIProfile(a.appliedProfileId ?? a.aiProfileId) ?? store.getAIProfile(a.aiProfileId);
        const billing = p?.vendor === 'local' ? 'local' : p?.kind === 'subscription' ? 'included' : 'api';
        const read = billing === 'api' ? estimateCost(u.byModel) : null;
        const priced = read && practice?.usd ? { ...read, low: read.low + practice.usd, high: read.high + practice.usd } : read;
        // No known price for any of its models: say so, not "$0.00+" (2026-09-30).
        const unpriced = pricesNothing(priced);
        const cost = unpriced ? null : priced;
        return { id: a.id, name: a.name, ...u, billing, profileName: p?.name, cost, ...(unpriced ? { unpriced: true } : {}) };
      } catch {
        return null; // unreachable container — treat as skipped, not zero
      }
    },
  );
  const agentsUsage = results
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((x, y) => y.totalTokens - x.totalTokens);
  const billed = agentsUsage.filter((a) => a.cost);
  const cost = billed.length
    ? {
        low: billed.reduce((s, a) => s + a.cost!.low, 0),
        high: billed.reduce((s, a) => s + a.cost!.high, 0),
        partial: billed.some((a) => a.cost!.partial) || agentsUsage.some((a) => 'unpriced' in a && a.unpriced),
        agents: billed.length,
      }
    : null;
  const totalTokens = agentsUsage.reduce((s, a) => s + a.totalTokens, 0);
  // Tokens split by billing category — the "where does the fleet run" view.
  const byBilling = { included: 0, api: 0, local: 0 } as Record<string, number>;
  for (const a of agentsUsage) byBilling[a.billing] = (byBilling[a.billing] ?? 0) + a.totalTokens;
  // Persist today's snapshot (only when we actually measured something, so a
  // transient all-unreachable read can't zero the day). Best-effort. Totals
  // are cumulative, so a day's point only ever rises (the store keeps the
  // larger): this view counts running agents only, the sampler every agent,
  // and the smaller one used to pull the day down (use-case audit, 2026-09-27).
  if (agentsUsage.length) {
    try {
      // No cost: this one prices LIFETIME totals, which on a day's bar read
      // as that day's spend; the sampler prices the day's own use (review, 2026-09-29).
      store.upsertUsageSnapshot(ownerId, { day: localDay(Date.now()).day, totalTokens, byBilling });
    } catch { /* trend is a nicety; never break the view */ }
  }
  return {
    agents: agentsUsage,
    totalTokens,
    totalSessions: agentsUsage.reduce((s, a) => s + a.sessions, 0),
    counted: agentsUsage.length,
    skipped: skipped0 + (results.length - agentsUsage.length),
    byBilling,
    cost,
  };
}
