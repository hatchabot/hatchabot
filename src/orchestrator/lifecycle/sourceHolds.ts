/**
 * AI sources an agent is being switched to, counted. A switch takes a hold in
 * the same tick as its last look at the source and lets it go when it is
 * done, and the source's delete is refused while one is held. Looked up
 * again only after its waits, a switch that found the source gone had
 * already applied the rest of its change (HB-0570).
 * Alongside the store's own check at the write: that one refuses only when
 * the switch is done, with its other changes made; a hold refuses the delete.
 * They end when the change does (withSourceHold), not at onResponse, which
 * never comes for a caller that hung up. Or after `holdMs`: a handler stuck
 * that long must not keep its source from being deleted for good.
 *
 * An in-process lock (HB-0809): the holds are gone after a restart, and so is
 * every switch that held one.
 */
export interface SourceHolds {
  /** `fn` under a hold on source `id` (none without one), taken before `fn` starts. */
  withSourceHold<T>(id: string | undefined, fn: () => Promise<T>): Promise<T>;
  /** A switch onto source `id` is under way. Holds past `holdMs` no longer count, and are logged once as they go. */
  sourceHeld(id: string): boolean;
}

export function createSourceHolds(opts: {
  /** How long a hold counts for. */
  holdMs: number;
  /** A line to the server's log only (a hold that outlived `holdMs`). */
  warn: (detail: Record<string, unknown>, event: string) => void;
}): SourceHolds {
  const { holdMs, warn } = opts;
  const sourceHolds = new Map<string, Set<{ at: number }>>();
  const holdSource = (id: string): (() => void) => {
    const hold = { at: Date.now() };
    const set = sourceHolds.get(id) ?? new Set();
    sourceHolds.set(id, set.add(hold));
    return () => {
      set.delete(hold);
      if (!set.size && sourceHolds.get(id) === set) sourceHolds.delete(id);
    };
  };
  const sourceHeld = (id: string): boolean => {
    const set = sourceHolds.get(id);
    if (!set) return false;
    for (const hold of set) {
      if (Date.now() - hold.at < holdMs) continue;
      set.delete(hold);
      warn({ source: id, heldMs: Date.now() - hold.at }, 'source.hold_expired');
    }
    if (!set.size) sourceHolds.delete(id);
    return set.size > 0;
  };
  const withSourceHold = async <T>(id: string | undefined, fn: () => Promise<T>): Promise<T> => {
    const release = id ? holdSource(id) : () => {};
    try { return await fn(); } finally { release(); }
  };
  return { withSourceHold, sourceHeld };
}
