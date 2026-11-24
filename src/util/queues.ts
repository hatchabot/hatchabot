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

/**
 * `fn` in the queue `queues` keeps for `key`, after what is already in it:
 * one at a time per key, each started once the one before has settled,
 * failed or not (model applies per agent, changes per class).
 */
export function inQueue<T>(queues: Map<string, Promise<unknown>>, key: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  const settled = next.catch(() => {}).finally(() => { if (queues.get(key) === settled) queues.delete(key); });
  queues.set(key, settled);
  return next;
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
