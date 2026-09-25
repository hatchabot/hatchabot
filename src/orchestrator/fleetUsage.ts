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
import { hourOf, slotOf } from './sourceUsage.js';

export type UsagePeriod = 'hour' | 'day' | 'week';
export const USAGE_PERIODS: UsagePeriod[] = ['hour', 'day', 'week'];

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
const SPAN: Record<UsagePeriod, { ms: number; bucketMinutes: number }> = {
  hour: { ms: 60 * MIN, bucketMinutes: 5 },
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
  const agents = store.listVisibleAgents(ownerId).filter((a) => a.state !== 'DELETED');
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

  for (const d of store.tokenDeltas(ids, from)) {
    row(d.agentId).tokens += d.delta;
    const b = bucket(d.at); if (b) b.tokens += d.delta;
  }
  // Requests: the hour view needs five-minute slots; the day and week views
  // bin by the hour, and the hourly table has a week of history (the slots
  // only began with v2.70.0 and would undercount a day until they fill).
  if (period !== 'hour') {
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
    const cost = billing === 'api' && r.tokens > 0 ? estimateCost([{ model: model ?? '', tokens: r.tokens }]) : null;
    return { id: a.id, name: a.name, state: a.state, ...r, billing, profileName: p?.name, model, cost };
  }).filter((r) => r.tokens || r.requests).sort((x, y) => y.tokens - x.tokens || y.requests - x.requests);

  const byBilling: Record<string, number> = { included: 0, api: 0, local: 0 };
  for (const r of rows) byBilling[r.billing] = (byBilling[r.billing] ?? 0) + r.tokens;
  const billed = rows.filter((r) => r.cost);
  const cost = billed.length
    ? { low: billed.reduce((s, r) => s + r.cost!.low, 0), high: billed.reduce((s, r) => s + r.cost!.high, 0), partial: billed.some((r) => r.cost!.partial), agents: billed.length }
    : null;
  const totals = { tokens: rows.reduce((s, r) => s + r.tokens, 0), requests: rows.reduce((s, r) => s + r.requests, 0), limited: rows.reduce((s, r) => s + r.limited, 0) };
  // Counting starts at each agent's first sample; the latest of those bounds what this window can know.
  let countingSince: string | undefined;
  for (const a of agents) {
    const p = store.getAIProfile(a.aiProfileId); if (!p) continue;
    const first = store.firstTokenSampleAt(p.id, new Set([a.id]));
    if (first && (!countingSince || first > countingSince)) countingSince = first;
  }
  return { period, from, to, bucketMinutes, buckets: [...buckets.values()], agents: rows, totals, byBilling, cost, countingSince };
}
