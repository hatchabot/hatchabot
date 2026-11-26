import { afterEach, describe, expect, it } from 'vitest';
import { keyedLock } from '../src/util/queues.js';

/**
 * The one keyed lock (src/util/queues.ts, HB-1465): every hand-written
 * keyed chain of promises became one of these. Each property the copies
 * kept is held here.
 */
const gate = () => { let open!: () => void; const held = new Promise<void>((r) => { open = r; }); return { held, open }; };
/** Lets every queued callback and a timer of a few ms run. */
const settle = () => new Promise((r) => setTimeout(r, 5));

describe('keyedLock', () => {
  it('runs one at a time per key, in the order asked, and leaves another key free', async () => {
    const lock = keyedLock();
    const ran: string[] = [];
    const g = gate();
    const first = lock.run('a', async () => { ran.push('first starts'); await g.held; ran.push('first ends'); return 1; });
    const second = lock.run('a', async () => { ran.push('second'); return 2; });
    const third = lock.run('a', async () => { ran.push('third'); return 3; });
    const other = lock.run('b', async () => { ran.push('other key'); return 'b'; });
    expect(await other).toBe('b');
    expect(ran).toEqual(['first starts', 'other key']);
    g.open();
    expect(await Promise.all([first, second, third])).toEqual([1, 2, 3]);
    expect(ran).toEqual(['first starts', 'other key', 'first ends', 'second', 'third']);
  });

  it('never calls fn before run returns: even a free turn is taken in a later tick', async () => {
    const lock = keyedLock();
    let ran = false;
    const p = lock.run('a', async () => { ran = true; });
    expect(ran).toBe(false);
    await p;
    expect(ran).toBe(true);
  });

  it('gives the holder its own result or error, and a failure does not stop the next', async () => {
    const lock = keyedLock();
    const failed = lock.run('a', async () => { throw new Error('first failed'); });
    const threw = lock.run('a', () => { throw new Error('thrown, not returned'); });
    const next = lock.run('a', async () => 'next ran');
    await expect(failed).rejects.toThrow('first failed');
    await expect(threw).rejects.toThrow('thrown, not returned');
    expect(await next).toBe('next ran');
  });

  it('forgets a key once idle, after a failure and a refusal too', async () => {
    const lock = keyedLock();
    const g = gate();
    const held = lock.run('a', () => g.held);
    const late = lock.run('a', async () => 'never', 1);
    const failing = lock.run('b', async () => { throw new Error('no'); });
    expect(lock.size).toBe(2);
    await expect(late).rejects.toThrow();
    await expect(failing).rejects.toThrow('no');
    await settle();
    expect(lock.size).toBe(1); // a's turn is still held
    g.open();
    await held;
    await settle();
    expect(lock.size).toBe(0);
  });

  describe('a wait limit', () => {
    it('refuses a waiter whose turn did not come in time, with the lock\'s refusal, and it never runs', async () => {
      class Busy extends Error {}
      const lock = keyedLock({ refusal: () => new Busy('still busy') });
      const g = gate();
      const first = lock.run('a', () => g.held);
      let ran = false;
      const late = lock.run('a', async () => { ran = true; }, 10);
      await expect(late).rejects.toBeInstanceOf(Busy);
      await expect(late).rejects.toThrow('still busy');
      g.open();
      await first;
      await settle();
      expect(ran).toBe(false);
    });

    it('refuses with a plain error when the lock names none', async () => {
      const lock = keyedLock();
      const g = gate();
      void lock.run('a', () => g.held).catch(() => {});
      await expect(lock.run('a', async () => 'x', 1)).rejects.toThrow('It waited too long for its turn.');
      g.open();
    });

    it('lets in no one behind a waiter that gave up while the ones before it still run', async () => {
      const lock = keyedLock();
      const ran: string[] = [];
      const g = gate();
      const first = lock.run('a', async () => { ran.push('first starts'); await g.held; ran.push('first ends'); });
      const late = lock.run('a', async () => { ran.push('late'); }, 5);
      const after = lock.run('a', async () => { ran.push('after'); });
      await expect(late).rejects.toThrow();
      await settle();
      expect(ran).toEqual(['first starts']);
      g.open();
      await Promise.all([first, after]);
      expect(ran).toEqual(['first starts', 'first ends', 'after']);
    });

    it('gives a holder that throws at once, not in a promise, its error as a rejection, and the next still runs', async () => {
      const lock = keyedLock();
      let free!: Promise<unknown>;
      expect(() => { free = lock.run('b', () => { throw new Error('thrown on a free turn'); }, 0); }).not.toThrow();
      await expect(free).rejects.toThrow('thrown on a free turn');
      const g = gate();
      const first = lock.run('a', () => g.held, 10_000);
      const threw = lock.run('a', () => { throw new Error('thrown at once'); }, 10_000);
      const next = lock.run('a', async () => 'next ran', 10_000);
      g.open();
      await first;
      await expect(threw).rejects.toThrow('thrown at once');
      expect(await next).toBe('next ran');
      await settle();
      expect(lock.size).toBe(0);
    });

    it('takes a turn that is free even with no time left, and one that comes in time', async () => {
      const lock = keyedLock();
      expect(await lock.run('a', async () => 'free', 0)).toBe('free');
      const g = gate();
      const first = lock.run('a', () => g.held);
      const inTime = lock.run('a', async () => 'in time', 10_000);
      g.open();
      await first;
      expect(await inTime).toBe('in time');
    });

    it('stop() refuses every waiter with a limit still waiting, as its limit would; one without a limit waits on, and runs', async () => {
      class Busy extends Error {}
      const lock = keyedLock({ refusal: () => new Busy('refused') });
      const ran: string[] = [];
      const g = gate();
      const first = lock.run('a', async () => { await g.held; ran.push('first'); });
      const limited = lock.run('a', async () => { ran.push('limited'); }, 60_000);
      const unlimited = lock.run('a', async () => { ran.push('unlimited'); });
      const elsewhere = lock.run('b', async () => { ran.push('elsewhere waits'); await g.held; }, 60_000);
      const behind = lock.run('b', async () => { ran.push('behind elsewhere'); }, 60_000);
      await settle(); // `elsewhere` has its turn: it is no longer waiting
      lock.stop();
      await expect(limited).rejects.toBeInstanceOf(Busy);
      await expect(behind).rejects.toBeInstanceOf(Busy);
      g.open();
      await Promise.all([first, unlimited, elsewhere]);
      await settle();
      expect(ran).toEqual(['elsewhere waits', 'first', 'unlimited']);
    });

    it('a holder that asks for its own key\'s turn again is not let in: with a limit it is refused, and its own turn then ends', async () => {
      const lock = keyedLock();
      const out = await lock.run('a', async () => {
        const again = await lock.run('a', async () => 'inner', 5).catch((err: Error) => `refused: ${err.message}`);
        return `outer, ${again}`;
      });
      expect(out).toBe('outer, refused: It waited too long for its turn.');
    });
  });

  describe('leaves no rejection unhandled', () => {
    const seen: unknown[] = [];
    const note = (reason: unknown) => { seen.push(reason); };
    afterEach(() => { process.off('unhandledRejection', note); seen.length = 0; });

    it('when callers drop the promises of a failure and of a waiter that gave up', async () => {
      process.on('unhandledRejection', note);
      const lock = keyedLock();
      const g = gate();
      lock.run('a', async () => { await g.held; throw new Error('the holder failed'); });
      lock.run('a', async () => 'gave up', 1);
      lock.run('a', async () => { throw new Error('the next failed too'); });
      lock.run('b', async () => 'never asked', 0);
      await settle();
      g.open();
      await settle();
      lock.run('a', async () => 'stopped', 60_000);
      lock.run('c', () => g.held);
      lock.run('c', async () => 'stopped', 60_000);
      lock.stop();
      await settle();
      expect(seen).toEqual([]);
      expect(lock.size).toBe(0);
    });
  });
});
