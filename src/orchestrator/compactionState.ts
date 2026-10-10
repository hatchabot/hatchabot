/**
 * The agents whose compaction is running in this process. A ledger row
 * still "running" for an agent not in here was cut off by a restart. Its own
 * module so the health view (tokenHealth.ts) can read it without importing
 * compaction.ts, which imports the health view.
 */
export const compactingNow = new Set<string>();
