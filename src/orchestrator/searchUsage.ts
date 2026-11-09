/**
 * The month's web searches, for the owner (HB-0532): Brave's against what the
 * key allows, per day and per agent, and what they cost.
 *
 * Agents call Brave from their own containers, so their searches are read from
 * OpenClaw's transcripts by the usage reader (usage.ts, `srch`) and stored per
 * agent, hour and provider (store `search_hours`). Hatchabot's own searches —
 * the Hatchabot agent's (opsWeb.ts) and its checks of the key (webSearch.ts
 * probeBrave, an agent's search test) — are counted where they happen, under
 * the fixed ids below. Searches made with the same key outside Hatchabot show
 * only in Brave's own quota number and bill.
 *
 * The month is the UTC calendar month, as budgets use; on a plan with a
 * monthly cap whose reset Brave told the last check, it is the month that
 * ends at that reset instead.
 *
 * An agent with a BRAVE_API_KEY of its own searches on its own key: those are
 * stored as OWN_BRAVE when they are read (sourceUsage.ts) and shown as its
 * "other" searches, so they use none of the fleet key's credit (HB-0578).
 */
import type { Store } from '../store/store.js';
import type { WebSearchState } from './webSearch.js';

/** Where the Hatchabot agent's own searches are counted (it searches through Hatchabot, not its container). */
export const OPS_AGENT_SEARCHES = '__hatchabot_agent__';
/** Where Hatchabot's checks are counted: the key check, and an agent's search test. */
export const SEARCH_CHECKS = '__checks__';
/**
 * The provider name a Brave search is stored under when the agent made it with
 * its own BRAVE_API_KEY (HB-0578): its own quota and bill, so it counts with
 * "other" here, never against the fleet key's credit or cost.
 */
export const OWN_BRAVE = 'brave-own';

export interface SearchPrice {
  /** Dollars per 1,000 Brave searches. */
  per1000: number;
  /** Dollars of free credit Brave gives each month. */
  monthlyCredit: number;
}
/** Brave's Search plan as of 2026-11: $5 per 1,000 requests, with $5 of credit each month. The owner can change both. */
export const DEFAULT_SEARCH_PRICE: SearchPrice = { per1000: 5, monthlyCredit: 5 };
const PRICE_PREF_OWNER = '__machine__';

export function readSearchPrice(store: Pick<Store, 'getOwnerPref'>): SearchPrice {
  const raw = store.getOwnerPref(PRICE_PREF_OWNER, 'webSearchPrice');
  if (raw) {
    try {
      const p = JSON.parse(raw) as Partial<SearchPrice>;
      const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
      if (ok(p.per1000) && ok(p.monthlyCredit)) return { per1000: p.per1000, monthlyCredit: p.monthlyCredit };
    } catch { /* a damaged row is the default */ }
  }
  return { ...DEFAULT_SEARCH_PRICE };
}

export function saveSearchPrice(store: Pick<Store, 'setOwnerPref'>, p: SearchPrice): void {
  store.setOwnerPref(PRICE_PREF_OWNER, 'webSearchPrice', JSON.stringify({ per1000: p.per1000, monthlyCredit: p.monthlyCredit }));
}

export interface SearchUsageRow {
  /** An agent's id, or one of the fixed ids above. */
  id: string;
  name: string;
  kind: 'agent' | 'hatchabot-agent' | 'checks' | 'removed';
  /** Searches Brave answered (each a request it bills). */
  brave: number;
  /** Searches another provider answered (DuckDuckGo, an agent's own provider or own Brave key, or one the transcript did not name). */
  other: number;
  /** Answered from OpenClaw's cache: no request was made. */
  cached: number;
  /** Its Brave searches at the price, before the month's credit (dollars). */
  cost: number;
}

export type SearchAllowance =
  /** A plan with a monthly cap: Brave's own numbers at the last check. */
  | { kind: 'quota'; limit: number; remaining: number; used: number; checkedAt?: string; resetsAt?: string }
  /** A metered plan (no cap): how much of the month's free credit the counted searches used. */
  | { kind: 'credit'; free: number; used: number; left: number };

export interface SearchUsageReport {
  period: { start: string; end: string; basis: 'calendar' | 'quota'; elapsedDays: number; days: number };
  brave: number;
  other: number;
  cached: number;
  /** One entry per UTC day of the period, today and the days to come included (zero). */
  byDay: Array<{ day: string; brave: number; other: number }>;
  /** Everyone who searched this period, most Brave searches first. */
  byAgent: SearchUsageRow[];
  allowance?: SearchAllowance;
  price: SearchPrice;
  cost: {
    /** The period's Brave searches at the price. */
    gross: number;
    /** Less the month's credit: what Brave would bill, if these were all the key's searches. */
    net: number;
    /** `net` at the period's end if searching goes on at this pace. */
    projectedNet: number;
  };
  /** Brave searches by the period's end at this pace. */
  projected: number;
  /** The day the allowance runs out at this pace, when that is before the period ends. */
  runsOut?: string;
  keySet: boolean;
  active: WebSearchState['active'];
  /** When Brave's quota was last asked (the quota numbers are from then). */
  checkedAt?: string;
}

const DAY = 86_400_000;
/** The UTC hour a time in ms falls in, as the search hours are kept (`2026-11-08T14`). */
export const hourOfMs = (t: number) => new Date(t).toISOString().slice(0, 13);
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const cents = (x: number) => Math.round(x * 100) / 100;

/**
 * The same day and time a month earlier, on the month's last day when it is
 * shorter (HB-0579): a reset on 31 March follows one on 28 February, where
 * setUTCMonth ran on into 3 March and the report left out five days.
 */
export function monthBefore(t: number): number {
  const d = new Date(t);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const py = m === 0 ? y - 1 : y, pm = m === 0 ? 11 : m - 1;
  const last = new Date(Date.UTC(py, pm + 1, 0)).getUTCDate();
  return Date.UTC(py, pm, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** The month the report covers: the quota's, when Brave said when it resets; else the UTC calendar month. */
export function searchPeriod(state: Pick<WebSearchState, 'brave'>, now: number): { start: number; end: number; basis: 'calendar' | 'quota' } {
  const b = state.brave;
  const reset = b?.resetsAt ? Date.parse(b.resetsAt) : NaN;
  if (b && (b.limit ?? 0) > 0 && Number.isFinite(reset) && reset > now && reset <= now + 32 * DAY) {
    return { start: monthBefore(reset), end: reset, basis: 'quota' };
  }
  const d = new Date(now);
  return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1), basis: 'calendar' };
}

export function searchUsageReport(o: {
  hours: (fromHour: string, toHour: string) => Array<{ agentId: string; hour: string; provider: string; n: number }>;
  state: WebSearchState;
  keySet: boolean;
  price: SearchPrice;
  nameOf: (id: string) => string | undefined;
  now: number;
}): SearchUsageReport {
  const { state, price, now } = o;
  const period = searchPeriod(state, now);
  const perSearch = price.per1000 / 1000;
  const rows = o.hours(hourOfMs(period.start), hourOfMs(period.end));

  const days = new Map<string, { brave: number; other: number }>();
  for (let t = Date.UTC(new Date(period.start).getUTCFullYear(), new Date(period.start).getUTCMonth(), new Date(period.start).getUTCDate()); t < period.end; t += DAY) {
    days.set(dayOf(t), { brave: 0, other: 0 });
  }
  const who = new Map<string, SearchUsageRow>();
  for (const r of rows) {
    if (r.n <= 0) continue;
    let w = who.get(r.agentId);
    if (!w) {
      const kind: SearchUsageRow['kind'] = r.agentId === OPS_AGENT_SEARCHES ? 'hatchabot-agent' : r.agentId === SEARCH_CHECKS ? 'checks' : o.nameOf(r.agentId) !== undefined ? 'agent' : 'removed';
      const name = kind === 'hatchabot-agent' ? 'Hatchabot agent' : kind === 'checks' ? "Hatchabot's checks" : o.nameOf(r.agentId) ?? 'A removed agent';
      w = { id: r.agentId, name, kind, brave: 0, other: 0, cached: 0, cost: 0 };
      who.set(r.agentId, w);
    }
    const day = days.get(r.hour.slice(0, 10));
    if (r.provider === 'brave') { w.brave += r.n; if (day) day.brave += r.n; }
    else if (r.provider === 'cached') w.cached += r.n;
    else { w.other += r.n; if (day) day.other += r.n; } // OWN_BRAVE among them: the agent's own bill
  }
  const byAgent = [...who.values()]
    .map((w) => ({ ...w, cost: cents(w.brave * perSearch) }))
    .sort((a, b) => b.brave - a.brave || b.other - a.other || a.name.localeCompare(b.name));
  const brave = byAgent.reduce((s, w) => s + w.brave, 0);
  const other = byAgent.reduce((s, w) => s + w.other, 0);
  const cached = byAgent.reduce((s, w) => s + w.cached, 0);

  // The pace: the period so far, but never less than a day, so a morning's few searches are not a month's thousands.
  const elapsed = Math.min(period.end, now) - period.start;
  const span = period.end - period.start;
  const rate = brave / Math.max(elapsed, DAY);
  const projected = Math.round(Math.max(brave, rate * span));

  const b = state.brave;
  let allowance: SearchAllowance | undefined;
  let runsOut: string | undefined;
  const runOutAt = (from: number, left: number) => {
    if (rate <= 0 || left <= 0) return left <= 0 ? from : undefined;
    const t = from + left / rate;
    return t < period.end ? t : undefined;
  };
  if (b && (b.limit ?? 0) > 0 && b.remaining !== undefined) {
    const limit = b.limit!;
    allowance = { kind: 'quota', limit, remaining: b.remaining, used: Math.max(0, limit - b.remaining), ...(state.checkedAt ? { checkedAt: state.checkedAt } : {}), ...(b.resetsAt ? { resetsAt: b.resetsAt } : {}) };
    const at = runOutAt(state.checkedAt ? Date.parse(state.checkedAt) : now, b.remaining);
    if (at !== undefined) runsOut = dayOf(at);
  } else if (perSearch > 0 && price.monthlyCredit > 0) {
    const free = Math.floor(price.monthlyCredit / perSearch + 1e-9);
    allowance = { kind: 'credit', free, used: brave, left: Math.max(0, free - brave) };
    const at = runOutAt(period.start, free);
    if (at !== undefined) runsOut = dayOf(at);
  }

  const gross = brave * perSearch;
  return {
    period: { start: new Date(period.start).toISOString(), end: new Date(period.end).toISOString(), basis: period.basis, elapsedDays: Math.round((elapsed / DAY) * 10) / 10, days: Math.round(span / DAY) },
    brave, other, cached,
    byDay: [...days].map(([day, v]) => ({ day, ...v })),
    byAgent,
    ...(allowance ? { allowance } : {}),
    price: { ...price },
    cost: { gross: cents(gross), net: cents(Math.max(0, gross - price.monthlyCredit)), projectedNet: cents(Math.max(0, projected * perSearch - price.monthlyCredit)) },
    projected,
    ...(runsOut ? { runsOut } : {}),
    keySet: o.keySet,
    active: state.active,
    ...(state.checkedAt ? { checkedAt: state.checkedAt } : {}),
  };
}
