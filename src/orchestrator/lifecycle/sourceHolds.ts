/**
 * AI sources an agent is being switched to, counted. A switch takes a hold in
 * the same tick as its last look at the source and lets it go when it is
 * done, and the source's delete is refused while one is held. Looked up
 * again only after its waits, a switch that found the source gone had
 * already applied the rest of its change (HB-0570).
 * Alongside the store's own check at the write: that one refuses only when
 * the switch is done, with its other changes made; a hold refuses the delete.
 * They end when the change does (withSourceHold), however long that takes,
 * not at onResponse, which never comes for a caller that hung up. A lapse
 * at ten minutes let a source be deleted under a switch still at work (a
 * slow docker call), as it let a second request in under the request holds
 * before HB-0630 (HB-1413).
 *
 * An in-process lock (HB-0809): the holds are gone after a restart, and so is
 * every switch that held one.
 */
export interface SourceHolds {
  /** `fn` under a hold on source `id` (none without one), taken before `fn` starts and let go when it ends. */
  withSourceHold<T>(id: string | undefined, fn: () => Promise<T>): Promise<T>;
  /** A switch onto source `id` is under way. */
  sourceHeld(id: string): boolean;
}

export function createSourceHolds(): SourceHolds {
  const sourceHolds = new Map<string, Set<object>>();
  const holdSource = (id: string): (() => void) => {
    const hold = {};
    const set = sourceHolds.get(id) ?? new Set();
    sourceHolds.set(id, set.add(hold));
    return () => {
      set.delete(hold);
      if (!set.size && sourceHolds.get(id) === set) sourceHolds.delete(id);
    };
  };
  const sourceHeld = (id: string): boolean => (sourceHolds.get(id)?.size ?? 0) > 0;
  const withSourceHold = async <T>(id: string | undefined, fn: () => Promise<T>): Promise<T> => {
    const release = id ? holdSource(id) : () => {};
    try { return await fn(); } finally { release(); }
  };
  return { withSourceHold, sourceHeld };
}
