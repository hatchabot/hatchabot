import { describe, expect, it } from 'vitest';
import { estimateCost, MODEL_PRICES } from '../src/orchestrator/pricing.js';

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
