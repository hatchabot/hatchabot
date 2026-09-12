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
      { model: 'claude-sonnet-5', tokens: 2_000_000 }, // [3, 15]
    ]);
    expect(c.low).toBeCloseTo(5 + 6, 6); // 5 + 2*3
    expect(c.high).toBeCloseTo(25 + 30, 6); // 25 + 2*15
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
});
