import { describe, expect, it } from 'vitest';
import { CACHE_READ_DEFAULT, CACHE_READ_SHARE, CACHE_WRITE_MULTIPLIER, estimateCost, MODEL_PRICES, priceList, PRICES_CHECKED, PRICES_SOURCE } from '../src/orchestrator/pricing.js';
import { MODEL_CATALOG, priceMix } from '../src/orchestrator/modelOptions.js';

describe('estimateCost', () => {
  it('brackets combined-token cost as [all-input, all-output] per model', () => {
    // 1M fable-5 tokens: low = $10 (all input), high = $50 (all output).
    const c = estimateCost([{ model: 'claude-fable-5', tokens: 1_000_000 }]);
    expect(c.low).toBeCloseTo(10, 6);
    expect(c.high).toBeCloseTo(50, 6);
    expect(c.partial).toBe(false);
  });

  it('sums across models at each model\'s own rate', () => {
    const c = estimateCost([
      { model: 'claude-opus-4-8', tokens: 1_000_000 }, // [5, 25]
      { model: 'claude-sonnet-5', tokens: 2_000_000 }, // [2, 10]
    ]);
    expect(c.low).toBeCloseTo(5 + 4, 6); // 5 + 2*2
    expect(c.high).toBeCloseTo(25 + 20, 6); // 25 + 2*10
  });

  it('flags partial when a model has no known price, still pricing the rest', () => {
    const c = estimateCost([
      { model: 'claude-opus-4-8', tokens: 1_000_000 },
      { model: 'some-unknown-model', tokens: 500_000 },
    ]);
    expect(c.partial).toBe(true);
    expect(c.low).toBeCloseTo(5, 6); // only the priced model counted
  });

  it('is $0 with no partial flag for empty usage', () => {
    expect(estimateCost([])).toEqual({ low: 0, high: 0, partial: false });
    // A zero-token unknown model doesn't trip partial.
    expect(estimateCost([{ model: 'mystery', tokens: 0 }]).partial).toBe(false);
  });

  it('prices every model the web app prices (tables stay in sync)', () => {
    for (const model of Object.keys(MODEL_PRICES)) {
      expect(estimateCost([{ model, tokens: 1_000_000 }]).partial).toBe(false);
    }
  });
  it('prices a cache read at the model\'s own share of input', () => {
    const call = { tokens: 1_000_000, input: 0, output: 0, cacheRead: 1_000_000 };
    expect(estimateCost([{ model: 'claude-opus-4-8', ...call }]).low).toBeCloseTo(0.5, 6);   // a tenth of $5
    expect(estimateCost([{ model: 'claude-opus-5-5', ...call }]).low).toBeCloseTo(0.2, 6);   // a twentieth of $4
    expect(estimateCost([{ model: 'claude-fable-5-1', ...call }]).low).toBeCloseTo(0.25, 6); // a fortieth of $10
  });
});

describe('the price list (Settings → AI sources → Model prices)', () => {
  it('every model the product offers has a price, the same one in both tables (none is deliberately unpriced today)', () => {
    // Models deliberately without a price would be listed here, with why.
    const DELIBERATELY_UNPRICED: string[] = [];
    for (const m of MODEL_CATALOG) {
      if (DELIBERATELY_UNPRICED.includes(m.id)) continue;
      expect(MODEL_PRICES[m.id], `${m.id} has no price in pricing.ts`).toEqual([m.input, m.output]);
      expect(CACHE_READ_SHARE[m.id] ?? CACHE_READ_DEFAULT, m.id).toBe(m.cacheRead);
    }
    // ...and nothing is priced that the product does not offer.
    for (const id of Object.keys(MODEL_PRICES)) expect(MODEL_CATALOG.some((m) => m.id === id), id).toBe(true);
  });

  it('both pricers agree on a mixed call', () => {
    const mix = { input: 1e6, output: 2e5, cacheRead: 8e6, cacheWrite: 5e5 };
    for (const m of MODEL_CATALOG) {
      const c = estimateCost([{ model: m.id, tokens: 0, ...mix }]);
      expect(c.low, m.id).toBeCloseTo(priceMix(m.id, mix)!, 9);
    }
  });

  it('lists per million tokens, with cache reads at the share and writes at 1.25×; current models first', () => {
    const list = priceList();
    expect(list.length).toBe(Object.keys(MODEL_PRICES).length);
    expect(list.find((m) => m.id === 'claude-opus-4-8')).toMatchObject({ label: 'Opus 4.8', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheReadShare: 0.1 });
    expect(list.find((m) => m.id === 'claude-opus-5-5')).toMatchObject({ cacheRead: 0.2, cacheWrite: 5, cacheReadShare: 0.05 });
    expect(list.find((m) => m.id === 'claude-fable-5-1')).toMatchObject({ cacheRead: 0.25, cacheWrite: 12.5, cacheReadShare: 0.025 });
    const firstOld = list.findIndex((m) => m.legacy);
    expect(firstOld).toBeGreaterThan(0);
    expect(list.slice(firstOld).every((m) => m.legacy)).toBe(true);
    expect(CACHE_WRITE_MULTIPLIER).toBe(1.25);
    expect(PRICES_CHECKED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PRICES_SOURCE).toBe('https://platform.claude.com/docs/en/about-claude/pricing');
  });

  it('the worked example in the panel: Opus 4.8, a 300,000-token conversation', () => {
    const o = priceList().find((m) => m.id === 'claude-opus-4-8')!;
    expect((300_000 * o.cacheRead / 1e6).toFixed(2)).toBe('0.15');
    expect((300_000 * o.cacheWrite / 1e6).toFixed(2)).toBe('1.88');
    expect((1_000 * o.output / 1e6).toFixed(2)).toBe('0.03');
  });
});
