import type { Agent } from '../domain/types.js';
import type { Store } from '../store/store.js';
import { HOUR_FIELDS } from './usage.js';
import { coverageDays, type StoredProfile } from './modelScorecard.js';
import { modelOption, priceMix, type TokenMix } from './modelOptions.js';

/**
 * What each agent costs at API prices, for the home screen's cost badges
 * ("$12/wk") and View by → Cost (docs/features.md, "Cost badges").
 *
 * The measure: the last N days (7 by default, rolling) of the tokens each
 * model actually used — input, output, cache reads at the model's share,
 * cache writes at 1.25× — priced with modelOptions.priceMix, the same
 * pricing as Usage and Right-size. Shown per week (the badge, the sections)
 * and, in the tooltip, as a monthly rate (× 30/N).
 *
 * Read from what the usage sampler stored (agent_model_profiles, whose
 * per-model hour buckets say what each model did and when): no container is
 * asked anything and no agent is woken.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * View by → Cost's bands: the edges of a week's cost, in absolute dollars so
 * a band means the same on every install. With [10, 50, 100]: under $10,
 * $10–50, $50–100, over $100 (each band takes its lower edge). The one
 * place to change them; the app builds its section names from this list.
 */
export const COST_BANDS: readonly number[] = [10, 50, 100];
/** 0 = no use in the window; else 1 (the cheapest band) to bands.length + 1. */
export type CostTier = number;
export function tierOf(amount: number, used: boolean, bands: readonly number[] = COST_BANDS): CostTier {
  if (!used) return 0;
  return 1 + bands.filter((edge) => amount >= edge).length;
}

/**
 * The windows View by → Cost offers (its row of pills; the icon chips follow
 * the one chosen, a week by default). Each has its own bands — about the
 * week's $10 / $50 / $100 scaled to the window, rounded — the smallest amount
 * worth a chip (a week's $1, scaled), and the chip's suffix.
 */
export interface CostPeriod { hours: number; bands: readonly number[]; chipMin: number; suffix: string }
export const COST_PERIODS: Readonly<Record<string, CostPeriod>> = {
  '1h': { hours: 1, bands: [0.05, 0.25, 0.5], chipMin: 0.01, suffix: '/1h' },
  '3h': { hours: 3, bands: [0.2, 1, 2], chipMin: 0.02, suffix: '/3h' },
  '6h': { hours: 6, bands: [0.4, 2, 4], chipMin: 0.04, suffix: '/6h' },
  '9h': { hours: 9, bands: [0.5, 2.5, 5], chipMin: 0.05, suffix: '/9h' },
  '12h': { hours: 12, bands: [0.75, 4, 7.5], chipMin: 0.07, suffix: '/12h' },
  '1d': { hours: 24, bands: [1.5, 7.5, 15], chipMin: 0.15, suffix: '/day' },
  '1w': { hours: 168, bands: COST_BANDS, chipMin: 1, suffix: '/wk' },
  '1m': { hours: 720, bands: [40, 200, 400], chipMin: 4, suffix: '/mo' },
};
export const DEFAULT_COST_PERIOD = '1w';

export interface AgentCost {
  /** API-price cost of the window, USD. */
  cost: number;
  /** The same per week (× 7 / days; the window itself on the 7-day default), USD. */
  weekly: number;
  /** The same as a monthly rate (× 30 / days), USD. */
  monthly: number;
  tier: CostTier;
  /** False when its tokens ran on models with no known price (another vendor's): the page says "no price known". */
  priced: boolean;
  /** Some tokens had no price: the figure is what the priced part cost. */
  partial?: boolean;
  /** On a Claude plan: not billed per token, but it counts against the plan's limits. */
  plan?: boolean;
  /** On a local model: no API cost at all. */
  local?: boolean;
  /** Read before the sampler kept hour buckets: the profile's 30 days, scaled to the window. */
  approx?: boolean;
}

const LOCAL_MODEL = /^(ollama|local|lmstudio|llamacpp)\//i;

/**
 * One agent's cost over `days` (a fraction for hours: 1/24 is the last hour)
 * ending at `now`, from its stored profile (undefined = never read). The
 * window is exact: an hour bucket it only partly covers counts for that part
 * (its use spread evenly over the hour, or over the part of the current hour
 * gone by). `bands`: the tier is the window's cost against these; without,
 * the week's rate against COST_BANDS.
 */
export function agentCost(
  agent: Pick<Agent, 'createdAt'>,
  stored: { profile: StoredProfile; at: string } | undefined,
  source: { kind?: string; vendor?: string } | undefined,
  days: number,
  now = Date.now(),
  bands?: readonly number[],
): AgentCost {
  const local = source?.vendor === 'local';
  const plan = !local && source?.kind === 'subscription';
  let cost = 0, unpriced = 0, used = 0, approx = false;
  const p = stored?.profile;
  if (p && p.models) {
    const hours = p.hourly === true || Object.values(p.models).some((s) => s.h && Object.keys(s.h).length);
    const from = now - days * DAY;
    const readAt = Date.parse(stored!.at) || now;
    for (const [model, s] of Object.entries(p.models)) {
      let mix: TokenMix;
      if (hours) {
        mix = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        for (const [h, v] of Object.entries(s.h ?? {})) {
          const start = Date.parse(`${h}:00:00Z`);
          if (!(start + HOUR > from) || start > now) continue;
          const span = Math.max(1, Math.min(HOUR, now - start));
          const w = start >= from ? 1 : Math.max(0, Math.min(1, (start + span - from) / span));
          HOUR_FIELDS.forEach((f, i) => { if (f in mix) mix[f as keyof TokenMix] += (Number(v[i]) || 0) * w; });
        }
      } else {
        // A profile from before v2.118 has the 30 days' totals only: its daily
        // average over the days it covers, times the window. One read longer
        // ago than the window knows nothing of it (an agent asleep since).
        if (readAt < now - days * DAY) continue;
        const k = Math.min(1, days / coverageDays(p, readAt, agent.createdAt));
        mix = { input: s.input * k, output: s.output * k, cacheRead: s.cacheRead * k, cacheWrite: s.cacheWrite * k };
        approx = true;
      }
      const tokens = mix.input + mix.output + mix.cacheRead + mix.cacheWrite;
      if (!(tokens > 0)) continue;
      used += tokens;
      const usd = priceMix(model, mix);
      if (usd !== undefined) cost += usd;
      else if (!local && !LOCAL_MODEL.test(model)) unpriced += tokens;
    }
  }
  const priced = !(unpriced > 0 && cost === 0);
  const weekly = cost * 7 / days;
  return {
    cost: r2(cost),
    weekly: r2(weekly),
    monthly: r2(cost * 30 / days),
    tier: bands ? tierOf(cost, used > 0, bands) : tierOf(weekly, used > 0),
    priced,
    ...(unpriced > 0 && cost > 0 ? { partial: true } : {}),
    ...(plan ? { plan: true } : {}),
    ...(local ? { local: true } : {}),
    ...(approx && used > 0 ? { approx: true } : {}),
  };
}

/**
 * The agents this person sees on their home screen, with what each costs.
 * A web-chat guest of an agent gets no cost for it: they don't pay for it
 * and it is not theirs to weigh.
 */
export function costsFor(store: Store, viewer: string, days: number, now = Date.now(), bands?: readonly number[]): Record<string, AgentCost> {
  const agents = store.listVisibleAgents(viewer).filter((a) => a.state !== 'DELETED' && a.state !== 'DELETING')
    .filter((a) => a.ownerId === viewer || (store.accessRole(a.id, viewer) && !store.webChatAllowed(a.id, viewer)));
  const profiles = store.modelProfiles(agents.map((a) => a.id)) as Map<string, { profile: StoredProfile; at: string }>;
  const sources = new Map<string, { kind?: string; vendor?: string } | undefined>();
  const out: Record<string, AgentCost> = {};
  for (const a of agents) {
    if (!sources.has(a.aiProfileId)) sources.set(a.aiProfileId, store.getAIProfile(a.aiProfileId));
    out[a.id] = agentCost(a, profiles.get(a.id), sources.get(a.aiProfileId), days, now, bands);
  }
  return out;
}

/** A small time-limited cache: one answer per key for `ttlMs`. */
export class TtlCache<T> {
  private readonly hits = new Map<string, { at: number; value: T }>();
  constructor(private readonly ttlMs: number, private readonly max = 500) {}
  get(key: string, now: number, compute: () => T): { value: T; at: number } {
    const hit = this.hits.get(key);
    if (hit && now - hit.at < this.ttlMs && now >= hit.at) return hit;
    const fresh = { at: now, value: compute() };
    if (this.hits.size >= this.max) this.hits.clear();
    this.hits.set(key, fresh);
    return fresh;
  }
}

/** HATCHABOT_COST_BADGES=off hides the badges, View by → Cost and the tooltip's cost line. */
export const costBadgesOn = (): boolean => !/^(off|0|false|no)$/i.test(String(process.env.HATCHABOT_COST_BADGES ?? '').trim());

// ---- what a window cost, and on what (Usage's "At API prices", 2026-10-05) ----

/** Each model's tokens in [now − hours, now], from the hour buckets, a bucket the window only partly covers counted for that part. */
export function mixesInWindow(p: StoredProfile | undefined, hours: number, now: number): Map<string, TokenMix> {
  const out = new Map<string, TokenMix>();
  if (!p?.models) return out;
  const from = now - hours * HOUR;
  for (const [model, s] of Object.entries(p.models)) {
    const mix: TokenMix = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const [h, v] of Object.entries(s.h ?? {})) {
      const start = Date.parse(`${h}:00:00Z`);
      if (!(start + HOUR > from) || start > now) continue;
      const span = Math.max(1, Math.min(HOUR, now - start));
      const w = start >= from ? 1 : Math.max(0, Math.min(1, (start + span - from) / span));
      HOUR_FIELDS.forEach((f, i) => { if (f in mix) mix[f as keyof TokenMix] += (Number(v[i]) || 0) * w; });
    }
    if (mix.input + mix.output + mix.cacheRead + mix.cacheWrite > 0) out.set(model, mix);
  }
  return out;
}

/** A cost split by what it paid for, USD. */
export interface CostParts { input: number; cacheWrite: number; cacheRead: number; output: number }
const noParts = (): CostParts => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
/** One model's token mix priced part by part (the same arithmetic as priceMix); undefined when the model has no price. */
export function priceParts(model: string, t: TokenMix): CostParts | undefined {
  const m = modelOption(model);
  if (!m) return undefined;
  return { input: (t.input * m.input) / 1e6, cacheWrite: (1.25 * t.cacheWrite * m.input) / 1e6, cacheRead: (m.cacheRead * t.cacheRead * m.input) / 1e6, output: (t.output * m.output) / 1e6 };
}

export interface WindowPricing {
  hours: number;
  /** All the owner's agents at API prices, USD (plan agents as an equivalent). */
  total: number;
  /** The same as a month at this pace (× 720 / hours). */
  monthly: number;
  parts: CostParts;
  /** How much of it is on API keys (billed) and on Claude plans (an equivalent). */
  billing: { api: number; plan: number };
  /** Per model, dearest first. */
  models: Array<{ model: string; cost: number }>;
  /** Per agent of the owner's: its window at API prices. */
  agents: Record<string, { cost: number; parts: CostParts }>;
  /** Tokens on models with no known price were left out. */
  unpriced?: boolean;
}

export function windowPricing(store: Store, viewer: string, hours: number, now = Date.now()): WindowPricing {
  const agents = store.listAgents(viewer).filter((a) => a.state !== 'DELETED' && a.state !== 'DELETING');
  const profiles = store.modelProfiles(agents.map((a) => a.id)) as Map<string, { profile: StoredProfile; at: string }>;
  const parts = noParts(), billing = { api: 0, plan: 0 }, byModel = new Map<string, number>();
  const per: Record<string, { cost: number; parts: CostParts }> = {};
  let unpriced = false;
  for (const a of agents) {
    const src = store.getAIProfile(a.aiProfileId);
    if (src?.vendor === 'local') continue;
    const ap = noParts();
    for (const [model, mix] of mixesInWindow(profiles.get(a.id)?.profile, hours, now)) {
      const pp = priceParts(model, mix);
      if (!pp) { if (!LOCAL_MODEL.test(model)) unpriced = true; continue; }
      (Object.keys(ap) as Array<keyof CostParts>).forEach((k) => { ap[k] += pp[k]; });
      byModel.set(model.replace(/^.*\//, ''), (byModel.get(model.replace(/^.*\//, '')) ?? 0) + pp.input + pp.cacheWrite + pp.cacheRead + pp.output);
    }
    const cost = ap.input + ap.cacheWrite + ap.cacheRead + ap.output;
    if (!(cost > 0)) continue;
    (Object.keys(parts) as Array<keyof CostParts>).forEach((k) => { parts[k] += ap[k]; });
    if (src?.kind === 'subscription') billing.plan += cost; else billing.api += cost;
    per[a.id] = { cost: r2(cost), parts: { input: r2(ap.input), cacheWrite: r2(ap.cacheWrite), cacheRead: r2(ap.cacheRead), output: r2(ap.output) } };
  }
  const total = parts.input + parts.cacheWrite + parts.cacheRead + parts.output;
  return {
    hours, total: r2(total), monthly: r2((total * 720) / hours),
    parts: { input: r2(parts.input), cacheWrite: r2(parts.cacheWrite), cacheRead: r2(parts.cacheRead), output: r2(parts.output) },
    billing: { api: r2(billing.api), plan: r2(billing.plan) },
    models: [...byModel].map(([model, cost]) => ({ model, cost: r2(cost) })).filter((m) => m.cost > 0).sort((x, y) => y.cost - x.cost),
    agents: per,
    ...(unpriced ? { unpriced: true } : {}),
  };
}

// ---- spend over time, part by part (the Usage chart, fleet and agent alike) ----

export type SpendRange = '1h' | '3h' | '6h' | '9h' | '12h' | 'day' | 'week' | 'month';
/** The chart's ranges: the window, and the slice its bars are cut in (an hour at the finest: the sampler keeps hours). */
export const SPEND_RANGES: Record<SpendRange, { hours: number; bucketHours: number }> = {
  '1h': { hours: 1, bucketHours: 1 },
  '3h': { hours: 3, bucketHours: 1 },
  '6h': { hours: 6, bucketHours: 1 },
  '9h': { hours: 9, bucketHours: 1 },
  '12h': { hours: 12, bucketHours: 1 },
  day: { hours: 24, bucketHours: 1 },
  week: { hours: 168, bucketHours: 3 },
  month: { hours: 720, bucketHours: 24 },
};
export interface SpendBucket extends CostParts { at: string; tokens: number; /** A source's chart: calls it refused in this slice (rate limit), everyone's. */ refused?: number }
export interface SpendSeries {
  range: SpendRange;
  bucketHours: number;
  buckets: SpendBucket[];
  totals: CostParts & { cost: number; tokens: number };
  /** Share of the cost on Claude plans (an equivalent, not a bill), 0–1. */
  planShare: number;
  /** A source's chart: calls refused in the range, all told. */
  refused?: number;
  /** The range's cost as a month at that pace (× 720 h / the range's hours). */
  monthly: number;
  /** Per model, dearest first. */
  models: Array<{ model: string; cost: number }>;
  /** Every agent that could be picked (the owner's, not local), with its cost in the range: the chart's agent picker. */
  choices: Array<{ id: string; name: string; cost: number }>;
}

/**
 * What the owner's agents (or one of them) cost at API prices, slice by slice
 * — new input, cache writes, cache reads, output — and the tokens behind it,
 * from the sampler's hour buckets. The last bucket ends with the current hour.
 */
export function spendSeries(store: Store, viewer: string, range: SpendRange, opts: { agentId?: string; agentIds?: string[]; sourceId?: string; now?: number } = {}): SpendSeries {
  const now = opts.now ?? Date.now();
  // The window is exact — the last `hours` to the minute; an hour bucket it
  // only partly covers counts for that part — and the bars are cut on clock
  // boundaries, so the first and last slices may be partial.
  const { hours, bucketHours } = SPEND_RANGES[range];
  const size = bucketHours * HOUR;
  const from = now - hours * HOUR;
  const start = Math.floor(from / size) * size;
  const n = Math.max(1, Math.ceil((now - start) / size));
  const out: SpendBucket[] = Array.from({ length: n }, (_, i) => ({ at: new Date(start + i * size).toISOString(), ...noParts(), tokens: 0 }));
  const mine = store.listAgents(viewer).filter((a) => a.state !== 'DELETED' && a.state !== 'DELETING' && store.getAIProfile(a.aiProfileId)?.vendor !== 'local');
  const picked = opts.agentId ? new Set([opts.agentId]) : opts.agentIds?.length ? new Set(opts.agentIds) : undefined;
  // One AI source (Settings → AI): the agents on it NOW. Spend is kept per agent and model, not per source,
  // so an agent that switched sources brings its earlier spend with it (rare; the panel says "agents on it now").
  const onSource = (a: { aiProfileId: string }) => !opts.sourceId || a.aiProfileId === opts.sourceId;
  const profiles = store.modelProfiles(mine.map((a) => a.id)) as Map<string, { profile: StoredProfile; at: string }>;
  let plan = 0, all = 0;
  const byModel = new Map<string, number>(), perAgent = new Map<string, number>();
  for (const a of mine) {
    const src = store.getAIProfile(a.aiProfileId);
    const into = onSource(a) && (!picked || picked.has(a.id));
    for (const [model, st] of Object.entries(profiles.get(a.id)?.profile.models ?? {})) {
      for (const [h, v] of Object.entries(st.h ?? {})) {
        const at = Date.parse(`${h}:00:00Z`);
        if (!(at + HOUR > from) || at > now) continue;
        const span = Math.max(1, Math.min(HOUR, now - at));
        const w = at >= from ? 1 : Math.max(0, Math.min(1, (at + span - from) / span));
        const b = out[Math.min(n - 1, Math.max(0, Math.floor((at - start) / size)))]!;
        const mix: TokenMix = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        HOUR_FIELDS.forEach((f, i) => { if (f in mix) mix[f as keyof TokenMix] += (Number(v[i]) || 0) * w; });
        const pp = priceParts(model, mix);
        const c = pp ? pp.input + pp.cacheWrite + pp.cacheRead + pp.output : 0;
        perAgent.set(a.id, (perAgent.get(a.id) ?? 0) + c);
        if (!into) continue;
        b.tokens += mix.input + mix.output + mix.cacheRead + mix.cacheWrite;
        if (!pp) continue;
        (Object.keys(pp) as Array<keyof CostParts>).forEach((k) => { b[k] += pp[k]; });
        const bare = model.replace(/^.*\//, '');
        byModel.set(bare, (byModel.get(bare) ?? 0) + c);
        all += c;
        if (src?.kind === 'subscription') plan += c;
      }
    }
  }
  // A source's chart: the calls it refused (rate-limited) in each slice — everyone's who draws on it, since they
  // share its limit; counts only. They replaced the separate requests chart in Settings → AI (2026-10-07).
  let refused = 0;
  if (opts.sourceId) {
    for (const r of store.modelCallHoursFor(opts.sourceId, new Date(from - HOUR).toISOString().slice(0, 13))) {
      const at = Date.parse(`${r.hour}:00:00Z`);
      if (!r.limited || !(at + HOUR > from) || at > now) continue;
      const b = out[Math.min(n - 1, Math.max(0, Math.floor((at - start) / size)))]!;
      b.refused = (b.refused ?? 0) + r.limited;
      refused += r.limited;
    }
  }
  const totals = { ...noParts(), cost: 0, tokens: 0 };
  for (const b of out) {
    (['input', 'cacheWrite', 'cacheRead', 'output'] as const).forEach((k) => { totals[k] += b[k]; b[k] = Math.round(b[k] * 10_000) / 10_000; });
    totals.tokens += b.tokens;
    b.tokens = Math.round(b.tokens);
  }
  totals.cost = totals.input + totals.cacheWrite + totals.cacheRead + totals.output;
  return {
    range, bucketHours, buckets: out,
    totals: { input: r2(totals.input), cacheWrite: r2(totals.cacheWrite), cacheRead: r2(totals.cacheRead), output: r2(totals.output), cost: r2(totals.cost), tokens: Math.round(totals.tokens) },
    planShare: all > 0 ? Math.round((plan / all) * 1000) / 1000 : 0,
    ...(opts.sourceId ? { refused } : {}),
    monthly: r2((totals.cost * 720) / hours),
    models: [...byModel].map(([model, cost]) => ({ model, cost: r2(cost) })).filter((m) => m.cost > 0).sort((x, y) => y.cost - x.cost),
    choices: (opts.agentId ? [] : mine.filter(onSource).map((a) => ({ id: a.id, name: a.name, cost: r2(perAgent.get(a.id) ?? 0) })).sort((x, y) => y.cost - x.cost || x.name.localeCompare(y.name))),
  };
}
