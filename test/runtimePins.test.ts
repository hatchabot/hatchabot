import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs helper shared with the build script
import { pickPlugin, satisfies } from '../scripts/runtime-pins.mjs';

describe('runtime image pins', () => {
  const R9 = '>=24.16.0 <25 || >=26.1.0';
  it('reads an npm engines range', () => {
    expect(satisfies('v22.23.2', R9)).toBe(false);
    expect(satisfies('v24.15.9', R9)).toBe(false);
    expect(satisfies('v24.21.0', R9)).toBe(true);
    expect(satisfies('v25.9.0', R9)).toBe(false);
    expect(satisfies('26.1.0', R9)).toBe(true);
    expect(satisfies('v22.23.2', '>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0')).toBe(true);
  });
  it('never claims a fit for a range it cannot read', () => {
    expect(satisfies('v24.21.0', '^24.16.0')).toBe(false);
    expect(satisfies('garbage', R9)).toBe(false);
  });
  it('picks the newest full plugin release that is not newer than OpenClaw', () => {
    const list = ['2026.7.1', '2026.7.33', '2026.8.2', '2026.9.1-beta.1', '2026.9.1', '2026.9.4', '2026.9.5'];
    expect(pickPlugin('2026.9.4', list)).toBe('2026.9.4');
    expect(pickPlugin('2026.9.0', list)).toBe('2026.8.2');
    expect(pickPlugin('2026.7.1-2', list)).toBe('2026.7.1');
    expect(pickPlugin('2026.1.0', list)).toBeUndefined();
  });
});
