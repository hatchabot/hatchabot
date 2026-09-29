/**
 * Status → Usage, by period: what the fleet used in the last hour, day or
 * week, per agent and per bucket — all from what the background sampler has
 * already recorded (token counter samples every ten minutes; calls in
 * five-minute slots and hours), so it answers at once and needs no container.
 *
 * The old view read every running container live (slow), ranked agents by
 * LIFETIME tokens, and showed a lifetime average per hour that read as
 * "using tokens right now" when the use was days ago (Chris, 2026-09-25).
 */
import type { Store } from '../store/store.js';
import { estimateCost, type CostRange } from './pricing.js';
import { FIRST_READ_REACH_MS } from './usage.js';
import { hourOf, slotOf } from './sourceUsage.js';

export type UsagePeriod = 'hour' | '3h' | '6h' | '9h' | '12h' | 'day' | 'week';
export const USAGE_PERIODS: UsagePeriod[] = ['hour', '3h', '6h', '9h', '12h', 'day', 'week'];

export interface UsageBucket { at: string; tokens: number; requests: number; limited: number }
export interface UsageAgentRow {
  id: string; name: string; state: string;
  tokens: number; requests: number; limited: number;
  billing: 'included' | 'api' | 'local'; profileName?: string; model?: string;
  cost: CostRange | null;
}
export interface UsagePeriodView {
  period: UsagePeriod;
  from: string; to: string;
  /** Bucket size in minutes: 5 for the hour, 60 for the day, 120 for the week. */
  bucketMinutes: number;
  buckets: UsageBucket[];
  agents: UsageAgentRow[];
  totals: { tokens: number; requests: number; limited: number };
  byBilling: Record<string, number>;
  cost: (CostRange & { agents: number }) | null;
  /** When token counting began for the newest-started agent — a window that starts earlier is partial. */
  countingSince?: string;
}

const MIN = 60_000;
/** A rise spreads over at most this much time before its reading (readings are ten minutes apart; a pass can run late). */
const SPREAD_MAX_MS = 20 * MIN;
const SPAN: Record<UsagePeriod, { ms: number; bucketMinutes: number }> = {
  hour: { ms: 60 * MIN, bucketMinutes: 5 },
  // A few hours back (Chris, 2026-09-28): 15-minute bars to 6 hours, 30 after.
  '3h': { ms: 3 * 60 * MIN, bucketMinutes: 15 },
  '6h': { ms: 6 * 60 * MIN, bucketMinutes: 15 },
  '9h': { ms: 9 * 60 * MIN, bucketMinutes: 30 },
  '12h': { ms: 12 * 60 * MIN, bucketMinutes: 30 },
  day: { ms: 24 * 60 * MIN, bucketMinutes: 60 },
  week: { ms: 7 * 24 * 60 * MIN, bucketMinutes: 120 },
};

function bucketStart(iso: string, bucketMinutes: number): string {
  const t = Date.parse(iso);
  return new Date(Math.floor(t / (bucketMinutes * MIN)) * bucketMinutes * MIN).toISOString();
}

export function computeUsagePeriod(store: Store, ownerId: string, period: UsagePeriod, now = Date.now()): UsagePeriodView {
  const { ms, bucketMinutes } = SPAN[period];
  const from = new Date(now - ms).toISOString(), to = new Date(now).toISOString();
  // The owner's own agents: usage is what THEIR plan spends. A shared agent's
  // numbers are its owner's, not a member's (one rule on every usage surface, 30th audit).
  const agents = store.listAgents(ownerId).filter((a) => a.state !== 'DELETED');
  const ids = new Set(agents.map((a) => a.id));
  const per = new Map<string, { tokens: number; requests: number; limited: number }>();
  const row = (id: string) => { let r = per.get(id); if (!r) { r = { tokens: 0, requests: 0, limited: 0 }; per.set(id, r); } return r; };
  const buckets = new Map<string, UsageBucket>();
  const startOf = new Date(Math.floor((now - ms) / (bucketMinutes * MIN)) * bucketMinutes * MIN).getTime();
  for (let t = startOf; t <= now; t += bucketMinutes * MIN) {
    const at = new Date(t).toISOString();
    buckets.set(at, { at, tokens: 0, requests: 0, limited: 0 });
  }
  const bucket = (iso: string) => buckets.get(bucketStart(iso, bucketMinutes));

  const firstBucket = [...buckets.values()][0];
  for (const d of store.tokenDeltas(ids, from)) {
    row(d.agentId).tokens += d.delta;
    // A rise happened between two readings ten minutes apart: spread it over
    // the buckets that span covers. All of it at the reading's time made the
    // 5-minute bars alternate full and empty, one reading behind the request
    // bars beside them (review, 2026-09-29). A long gap (a stop, an
    // unreachable container) spreads over its last SPREAD_MAX_MS only.
    const end = Date.parse(d.at), start = Math.max(Date.parse(d.prevAt), end - SPREAD_MAX_MS);
    if (!(end > start)) { const b = bucket(d.at) ?? firstBucket; if (b) b.tokens += d.delta; continue; }
    // Whole tokens that sum to the rise exactly: each bucket takes the rounded
    // cumulative share less what the buckets before it took.
    let given = 0;
    for (let t = Math.floor(start / (bucketMinutes * MIN)) * bucketMinutes * MIN; t < end; t += bucketMinutes * MIN) {
      const share = Math.round(d.delta * (Math.min(end, t + bucketMinutes * MIN) - start) / (end - start)) - given;
      given += share;
      // A span that began before the window lands its early part on the first bar.
      const b = buckets.get(new Date(t).toISOString()) ?? firstBucket;
      if (b) b.tokens += share;
    }
  }
  // Requests: the hour and day views count five-minute slots (whole hours
  // reached up to an hour past the window, while tokens use the exact time;
  // night review — slots have kept a week since v2.70.0). The week view bins
  // by the hour from the hourly table.
  if (period === 'week') {
    for (const h of store.modelCallHoursForAgents(ids, hourOf(from))) {
      const r = row(h.agentId); r.requests += h.ok + h.failed + h.limited; r.limited += h.limited;
      const b = bucket(`${h.hour}:00:00Z`); if (b) { b.requests += h.ok + h.failed + h.limited; b.limited += h.limited; }
    }
  } else {
    for (const sl of store.modelCallSlotsForAgents(ids, slotOf(from))) {
      const r = row(sl.agentId); r.requests += sl.ok + sl.failed + sl.limited; r.limited += sl.limited;
      const b = bucket(`${sl.slot}:00Z`); if (b) { b.requests += sl.ok + sl.failed + sl.limited; b.limited += sl.limited; }
    }
  }

  const rows: UsageAgentRow[] = agents.map((a) => {
    const p = store.getAIProfile(a.aiProfileId);
    const billing: UsageAgentRow['billing'] = p?.vendor === 'local' ? 'local' : p?.kind === 'subscription' ? 'included' : 'api';
    const r = per.get(a.id) ?? { tokens: 0, requests: 0, limited: 0 };
    const model = a.model ?? p?.model;
    // At the agent's own measured price per token when known (cache reads, most
    // of the tokens, cost a tenth of input); else the all-input..all-output bracket.
    const rate = billing === 'api' && r.tokens > 0 ? store.agentTokenRate(a.id) : undefined;
    const cost = billing !== 'api' || r.tokens <= 0 ? null
      : rate ? { low: r.tokens * rate.usdPerToken, high: r.tokens * rate.usdPerToken, partial: rate.partial }
      : estimateCost([{ model: model ?? '', tokens: r.tokens }]);
    return { id: a.id, name: a.name, state: a.state, ...r, billing, profileName: p?.name, model, cost };
  }).filter((r) => r.tokens || r.requests).sort((x, y) => y.tokens - x.tokens || y.requests - x.requests);

  const byBilling: Record<string, number> = { included: 0, api: 0, local: 0 };
  for (const r of rows) byBilling[r.billing] = (byBilling[r.billing] ?? 0) + r.tokens;
  const billed = rows.filter((r) => r.cost);
  const cost = billed.length
    ? { low: billed.reduce((s, r) => s + r.cost!.low, 0), high: billed.reduce((s, r) => s + r.cost!.high, 0), partial: billed.some((r) => r.cost!.partial), agents: billed.length }
    : null;
  const totals = { tokens: rows.reduce((s, r) => s + r.tokens, 0), requests: rows.reduce((s, r) => s + r.requests, 0), limited: rows.reduce((s, r) => s + r.limited, 0) };
  // What each agent's readings can know reaches FIRST_READ_REACH_MS before its
  // first sample: a first reading reads the transcripts' last 8 days, writing
  // them when there were calls and showing there were none when not. Taking
  // the first sample itself flagged every window as partial for a day (a
  // week, on the week view) after an idle agent was first read (review,
  // 2026-09-29). The latest reach bounds what this window can know.
  let countingSince: string | undefined;
  for (const a of agents) {
    const p = store.getAIProfile(a.aiProfileId); if (!p) continue;
    const first = store.firstTokenSampleAt(p.id, new Set([a.id]));
    if (!first) continue;
    const reach = new Date(Date.parse(first) - FIRST_READ_REACH_MS).toISOString();
    if (!countingSince || reach > countingSince) countingSince = reach;
  }
  if (countingSince && countingSince <= from) countingSince = undefined;
  return { period, from, to, bucketMinutes, buckets: [...buckets.values()], agents: rows, totals, byBilling, cost, ...(countingSince ? { countingSince } : {}) };
}
