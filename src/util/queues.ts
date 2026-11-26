/**
 * `fn` over every item, six at a time, results in order: a docker exec per
 * running agent, all at once, measurably slows the box (the pairing sweep
 * learned this at 26 agents; HB-0058).
 */
export async function sixAtATime<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += 6) out.push(...(await Promise.all(items.slice(i, i + 6).map(fn))));
  return out;
}

/**
 * `fn` for each item once `ready(item)` has settled (failed or not), at most
 * six at a time among those that are ready: one whose wait is long (its
 * agent's own operation still being settled after a restart, HB-0839) holds
 * up none of the others, as a batch of six would. Results in order.
 */
export async function sixAtATimeWhenReady<T, R>(items: T[], ready: (item: T) => Promise<unknown>, fn: (item: T) => Promise<R>): Promise<R[]> {
  const slots = semaphore(6);
  return Promise.all(items.map(async (item) => {
    await ready(item).catch(() => undefined);
    await slots.acquire();
    try { return await fn(item); } finally { slots.release(); }
  }));
}

/** One keyed lock (keyedLock): each key's turns, one at a time. */
export interface KeyedLock {
  /**
   * `fn` in `key`'s turn: once every earlier `run` on that key has settled,
   * failed or not, in the order they were asked for. Its result or its error
   * is the answer; the next waiter runs either way.
   *
   * `waitMs`: the longest it waits for its turn. Then it gives up: it is
   * refused (the lock's `refusal`), `fn` never runs, and the one behind it
   * still waits for the ones before it. A turn that is free is taken even
   * with no time left. With no `waitMs` it waits as long as it takes.
   *
   * Not re-entrant: a holder that asks for its own key's turn waits for itself.
   */
  run<T>(key: string, fn: () => Promise<T>, waitMs?: number): Promise<T>;
  /** Every waiter with a wait limit still waiting is refused now, as its limit would refuse it, and never runs. One with none waits on. */
  stop(): void;
  /** How many keys have a turn held or waited for: an idle key is forgotten. */
  readonly size: number;
}

/**
 * Turns per key, one at a time (docs/architecture.md, "In-memory state,
 * sorted": each lock made is a row there, under the name it is kept as).
 * FIFO per key; a waiter may have a wait limit, and one that gave up never
 * runs; a key is forgotten once idle; a failure is its caller's alone, and
 * nothing is left unhandled. `refusal`: what a waiter that gave up is
 * refused with.
 */
export function keyedLock(opts: { refusal?: () => Error } = {}): KeyedLock {
  const refusal = opts.refusal ?? (() => new Error('It waited too long for its turn.'));
  /** Each key's last turn, settled once it and every turn before it have. Never rejects. */
  const tails = new Map<string, Promise<void>>();
  /** The waits with a limit under way: each one's deadline, and its refusal. */
  const waits = new Set<{ late: NodeJS.Timeout; refuse: () => void }>();
  const keep = (key: string, tail: Promise<void>): void => {
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  };
  return {
    run<T>(key: string, fn: () => Promise<T>, waitMs?: number): Promise<T> {
      const before = tails.get(key) ?? Promise.resolve();
      if (waitMs === undefined) {
        const mine = before.then(() => fn());
        keep(key, mine.then(() => {}, () => {}));
        return mine;
      }
      const turn = new Promise<void>((resolve, reject) => {
        const refuse = () => reject(refusal());
        const wait = { late: setTimeout(() => { waits.delete(wait); refuse(); }, waitMs), refuse };
        waits.add(wait);
        void before.then(() => { clearTimeout(wait.late); waits.delete(wait); resolve(); }, () => {});
      });
      const mine = turn.then(() => fn());
      // The next waits for the ones before this too: one that gave up does
      // not let it in while they still run.
      keep(key, before.then(() => mine).then(() => {}, () => {}));
      // A refusal comes while those still run, before the line above takes
      // `mine` up: handled here, as a failure is, it is its caller's alone.
      void mine.catch(() => {});
      return mine;
    },
    stop(): void {
      for (const wait of waits) { clearTimeout(wait.late); wait.refuse(); }
      waits.clear();
    },
    get size() { return tails.size; },
  };
}

/**
 * At most `limit` at a time: `acquire()` waits for a slot, `release()` gives
 * it back. Resizable while some wait (`setLimit`): raising it lets waiters in
 * at once; lowering it lets the running ones finish and admits fewer after.
 * The rebuild queue's two gates (orchestrator/lifecycle/rebuildQueue.ts), and
 * a pushed definition's children four at a time.
 */
export const semaphore = (initial: number) => {
  let limit = initial;
  let used = 0;
  const waiting: Array<() => void> = [];
  const admit = () => { while (used < limit && waiting.length) { used++; waiting.shift()!(); } };
  return {
    acquire: (): Promise<void> => {
      if (used < limit) { used++; return Promise.resolve(); }
      return new Promise((resolve) => waiting.push(resolve));
    },
    release: (): void => { used--; admit(); },
    setLimit: (n: number): void => { limit = n; admit(); },
    get limit() { return limit; },
  };
};
