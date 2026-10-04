import { MODEL_CATALOG, modelOption } from './modelOptions.js';

/**
 * Model prices in USD per 1M tokens, as [input, output]. The source of truth
 * the /v1/usage rollup prices against so the web and CLI agree; the app's
 * Model prices panel (Settings → AI sources) reads it through
 * GET /v1/model-prices and the page's own table is refreshed from there. A
 * test keeps it and modelOptions' MODEL_CATALOG pricing every model alike.
 */
/** When these were last checked against Anthropic's pricing page (PRICES_SOURCE). */
export const PRICES_CHECKED = '2026-10-03';
export const PRICES_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';
/** A cache write (Anthropic's 5-minute cache) as a multiple of the input price. */
export const CACHE_WRITE_MULTIPLIER = 1.25;
/** A cache read as a share of the input price, unless CACHE_READ_SHARE lists less. */
export const CACHE_READ_DEFAULT = 0.1;
export const MODEL_PRICES: Record<string, [number, number]> = {
  'claude-mythos-5': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-opus-4-5': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  // $2/$10 was Sonnet 5's launch price and stayed: the rise to $3/$15 planned
  // for 2026-09-01 was called off (Anthropic's pricing page, read 2026-10-01).
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-sonnet-4-5': [3, 15],
  'claude-haiku-4-5': [1, 5],
  'claude-fable-5-1': [10, 50],
  'claude-fable-5': [10, 50],
};

/** A cache read as a share of the input price: a tenth, except where Anthropic lists less. */
export const CACHE_READ_SHARE: Record<string, number> = { 'claude-opus-5-5': 0.05, 'claude-fable-5-1': 0.025 };

export interface CostRange {
  /** Lower bound: every token priced as input (the realistic end for
   *  agent workloads, where reloaded context dwarfs generated output). */
  low: number;
  /** Upper bound: every token priced as output. */
  high: number;
  /** True if some model's tokens couldn't be priced (unknown model). */
  partial: boolean;
}

/**
 * Estimate a dollar cost RANGE from a per-model token breakdown. OpenClaw
 * reports one combined input+output counter with no split, and in/out prices
 * differ (e.g. fable-5 is $10 in / $50 out), so an exact figure is impossible —
 * the range brackets it: low = all-input, high = all-output. Unknown models
 * contribute nothing and set `partial`.
 */
export function estimateCost(
  byModel: Array<{ model: string; tokens: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>,
): CostRange {
  let low = 0;
  let high = 0;
  let partial = false;
  for (const m of byModel) {
    const price = MODEL_PRICES[m.model];
    if (!price) {
      if (m.tokens > 0) partial = true;
      continue;
    }
    // With the per-call split (2026-09-28) the figure is exact: input and
    // output at their prices, cache reads at a tenth of input (less on the
    // models in CACHE_READ_SHARE), cache writes
    // at 1.25× (Anthropic's 5-minute cache). Without it, the old bracket.
    if (typeof m.input === 'number' && typeof m.output === 'number') {
      const exact = ((m.input + CACHE_WRITE_MULTIPLIER * (m.cacheWrite ?? 0) + (CACHE_READ_SHARE[m.model] ?? CACHE_READ_DEFAULT) * (m.cacheRead ?? 0)) * price[0] + m.output * price[1]) / 1e6;
      low += exact; high += exact;
      continue;
    }
    low += (m.tokens / 1e6) * price[0];
    high += (m.tokens / 1e6) * price[1];
  }
  return { low, high, partial };
}

/** A range that priced nothing because no model's price is known: shown as
 *  "no price known", never "$0.00+" (2026-09-30). */
export const pricesNothing = (c: CostRange | null | undefined): boolean => !!c && c.partial && c.high === 0;

export interface PriceRow {
  id: string;
  label: string;
  /** USD per 1M tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** A cache read as a share of input (0.1, or less where Anthropic lists less). */
  cacheReadShare: number;
  legacy?: boolean;
  limited?: boolean;
}

/** The price list, current models first (the catalog's order: largest first), retired ones last. */
export function priceList(): PriceRow[] {
  const order = new Map(MODEL_CATALOG.map((m, i) => [m.id, i]));
  return Object.entries(MODEL_PRICES)
    .map(([id, [input, output]]) => {
      const opt = modelOption(id);
      const share = CACHE_READ_SHARE[id] ?? CACHE_READ_DEFAULT;
      const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
      return {
        id, label: opt?.label ?? id, input, output,
        cacheRead: r4(input * share), cacheWrite: r4(input * CACHE_WRITE_MULTIPLIER), cacheReadShare: share,
        ...(opt?.legacy ? { legacy: true } : {}), ...(opt?.limited ? { limited: true } : {}),
      };
    })
    .sort((a, b) => Number(!!a.legacy) - Number(!!b.legacy) || (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
}
