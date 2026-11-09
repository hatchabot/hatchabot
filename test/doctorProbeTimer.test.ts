import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * The review of the HB-0551 fix: the HTTPS probe armed its deadline before
 * the request existed. When the request threw at once, the timer still fired
 * ten seconds later and called destroy on a request that never was: a
 * ReferenceError with no one to catch it, which ends doctor. The timer is now
 * armed after the request exists, and unref'd.
 */
const https = vi.hoisted(() => ({ mode: 'throw' as 'throw' | 'hang', destroyed: 0 }));
vi.mock('node:https', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:https')>();
  return {
    ...real,
    request: () => {
      if (https.mode === 'throw') throw new TypeError('made-up refused option');
      const req = Object.assign(new EventEmitter(), {
        end() {},
        destroy() { https.destroyed++; return req; },
      });
      return req;
    },
  };
});

const { probeControlPlane } = await import('../src/doctor.js');

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the HTTPS probe\'s deadline (review of HB-0551)', () => {
  it('a request that throws at once answers "not ok" and leaves no timer behind', async () => {
    https.mode = 'throw';
    vi.useFakeTimers();
    const got = await probeControlPlane('https://localhost:9137');
    expect(got).toMatchObject({ ok: false, error: expect.stringMatching(/made-up refused option/) });
    expect(vi.getTimerCount()).toBe(0);
    expect(() => vi.advanceTimersByTime(20_000)).not.toThrow();
  });

  it('a request that never answers ends at the deadline, with a timer that does not hold the process', async () => {
    https.mode = 'hang';
    https.destroyed = 0;
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const pending = probeControlPlane('https://localhost:9137');
    await vi.advanceTimersByTimeAsync(0);
    const timer = spy.mock.results.map((r) => r.value as { hasRef?: () => boolean }).find((t) => t?.hasRef);
    expect(timer?.hasRef?.()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ ok: false, error: expect.stringMatching(/timed out/) });
    expect(https.destroyed).toBe(1);
  });
});
