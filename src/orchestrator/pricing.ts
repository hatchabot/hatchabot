/**
 * Model prices in USD per 1M tokens, as [input, output]. Kept in sync with the
 * web app's MODEL_PRICES table (web/index.html) — this is the source of truth
 * the /v1/usage rollup prices against so the web and CLI agree.
 */
export const MODEL_PRICES: Record<string, [number, number]> = {
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-sonnet-5': [3, 15],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
  'claude-fable-5': [10, 50],
};

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
  byModel: Array<{ model: string; tokens: number }>,
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
    low += (m.tokens / 1e6) * price[0];
    high += (m.tokens / 1e6) * price[1];
  }
  return { low, high, partial };
}
