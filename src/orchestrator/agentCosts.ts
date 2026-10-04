import type { Agent } from '../domain/types.js';
import type { Store } from '../store/store.js';
import { HOUR_FIELDS } from './usage.js';
import { coverageDays, type StoredProfile } from './modelScorecard.js';
import { priceMix, type TokenMix } from './modelOptions.js';

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
/** 0 = no use in the window; else 1 (the cheapest band) to COST_BANDS.length + 1. */
export type CostTier = number;
export function tierOf(weekly: number, used: boolean): CostTier {
  if (!used) return 0;
  return 1 + COST_BANDS.filter((edge) => weekly >= edge).length;
}

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

/** One agent's cost over `days` ending at `now`, from its stored profile (undefined = never read). */
export function agentCost(
  agent: Pick<Agent, 'createdAt'>,
  stored: { profile: StoredProfile; at: string } | undefined,
  source: { kind?: string; vendor?: string } | undefined,
  days: number,
  now = Date.now(),
): AgentCost {
  const local = source?.vendor === 'local';
  const plan = !local && source?.kind === 'subscription';
  let cost = 0, unpriced = 0, used = 0, approx = false;
  const p = stored?.profile;
  if (p && p.models) {
    const hours = p.hourly === true || Object.values(p.models).some((s) => s.h && Object.keys(s.h).length);
    // The window's hour buckets: the `days × 24` most recent hours, this one included.
    const fromHour = new Date(now - days * DAY + HOUR).toISOString().slice(0, 13);
    const readAt = Date.parse(stored!.at) || now;
    for (const [model, s] of Object.entries(p.models)) {
      let mix: TokenMix;
      if (hours) {
        mix = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        for (const [h, v] of Object.entries(s.h ?? {})) {
          if (h < fromHour) continue;
          HOUR_FIELDS.forEach((f, i) => { if (f in mix) mix[f as keyof TokenMix] += Number(v[i]) || 0; });
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
    tier: tierOf(weekly, used > 0),
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
export function costsFor(store: Store, viewer: string, days: number, now = Date.now()): Record<string, AgentCost> {
  const agents = store.listVisibleAgents(viewer).filter((a) => a.state !== 'DELETED' && a.state !== 'DELETING')
    .filter((a) => a.ownerId === viewer || (store.accessRole(a.id, viewer) && !store.webChatAllowed(a.id, viewer)));
  const profiles = store.modelProfiles(agents.map((a) => a.id)) as Map<string, { profile: StoredProfile; at: string }>;
  const sources = new Map<string, { kind?: string; vendor?: string } | undefined>();
  const out: Record<string, AgentCost> = {};
  for (const a of agents) {
    if (!sources.has(a.aiProfileId)) sources.set(a.aiProfileId, store.getAIProfile(a.aiProfileId));
    out[a.id] = agentCost(a, profiles.get(a.id), sources.get(a.aiProfileId), days, now);
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
