import { describe, expect, it } from 'vitest';
import { isBusy, markBusy, whileBusy } from '../src/orchestrator/lifecycle/busy.js';
import { as, makeWorld, seedRunningAgent } from './support/world.js';

/**
 * Each test's world starts with no agent held (HB-0873): the reservations
 * are the process's memory, and the tests of a file share one process, so a
 * mark left by one test, or by work it started and did not wait for, was the
 * next test's too when its agent had the same id. The tests below run in
 * order, and the first leaves its marks on purpose, as a test that forgot
 * to let go would. Ids and names are made up.
 */
describe('a test world starts with no agent held, whatever the test before it left', () => {
  it('a test that leaves its agent marked busy, and another held by work it did not wait for', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    markBusy(id); // never let go
    void whileBusy('a2', 'rebuild', () => new Promise<void>(() => {})); // never ends
    expect(isBusy(id)).toBe(true);
    expect(isBusy('a2')).toBe(true);
    w.routes?.stop();
    await w.f.close();
  });

  it('the next test, with an agent of the same id: free, and its Stop answers', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    // Was: still held from the test before, and its Stop was refused as busy.
    expect(isBusy(id)).toBe(false);
    expect(isBusy('a2')).toBe(false);
    const stop = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/stop`, headers: as(), payload: {} });
    expect(stop.statusCode, stop.body).toBe(200);
    w.routes?.stop();
    await w.f.close();
  });
});
