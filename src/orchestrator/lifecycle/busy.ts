import { forgetReservation, freeWithin, isReserved, reserve, waitersFor, whenFree, whileReserved, type Purpose, type Reservation } from './reservations.js';

/**
 * One operation per agent at a time: the busy flag, by the names its callers
 * use. Since HB-1465 it is the facade of the agent's reservation
 * (reservations.ts), which keeps the holder and what it was taken for; every
 * take in src names its purpose.
 *
 * Reconcile must leave a busy agent alone: it judges an agent by what docker
 * reports, and mid-operation that is meaningless — a container being
 * created looks "absent", one being replaced looks "stopped".
 *
 * Getting this wrong is not cosmetic. Reconcile marking an importing agent
 * FAILED made the import's final `setAgentState('RUNNING')` an illegal
 * transition, which surfaced to the user as a rolled-back migration.
 *
 * Each flag is its holder's (HB-1385): the mark it was given, which only
 * that holder's release lets go. It was a Set, and a holder that let go
 * late (its finally run twice, or after the agent had passed to another)
 * freed whoever held the agent then.
 */
export { AgentBusyError, heldFor, PURPOSES, type Purpose, type Reservation } from './reservations.js';

/**
 * Mark the agent busy for `purpose`, for a holder that cannot put its work
 * in one function (whileBusy): what it returns is the one way to let this
 * mark go, in the holder's finally. Refused (AgentBusyError) when the agent
 * is held already: one holder at a time, as whileBusy. The release lets go
 * of this mark only: called again, or once the agent has passed to another
 * holder, it does nothing.
 *
 * With no purpose: a holder that names none, which only tests are (a stand-in
 * for another holder); test/reservations.test.ts holds src to naming one.
 */
export function markBusy(agentId: string, purpose: Purpose): () => void;
export function markBusy(agentId: string): () => void;
export function markBusy(agentId: string, purpose?: Purpose): () => void {
  const r = reserve(agentId, purpose);
  return () => r.release();
}

/**
 * Forget the agent's flag, whoever holds it, and let its waiters go: what a
 * restart does to every flag (they are this process's memory). For tests,
 * which stand for a restart with it; src lets a flag go only through its
 * holder's release (test/busy.test.ts keeps it out of src).
 */
export function clearBusy(agentId: string): void {
  forgetReservation(agentId);
}

export function isBusy(agentId: string): boolean {
  return isReserved(agentId);
}

/**
 * Settles once the agent is no longer busy (at once when it is not): for a
 * job that waits its turn behind whatever holds the agent, rather than
 * looking again every few seconds. `signal`: a waiter that stops waiting
 * (its own time limit) is let go and forgotten, not kept until the agent is
 * free. Never rejects.
 */
export function busyDone(agentId: string, signal?: AbortSignal): Promise<void> {
  return whenFree(agentId, signal);
}

/**
 * How often, and how long each time, a job owed to an agent (its model, its
 * AGENTS.md sections, its template tasks) waits out a busy flag it was
 * refused by, before it is left owed for the next start: the boot's own work
 * for one agent took it from another's, and what was refused was left for
 * the next restart (HB-0834 review).
 */
export const OWED_BUSY_WAITS = 5;
export const OWED_BUSY_WAIT_MS = 30 * 60_000;

/**
 * Waits for the agent to be free (busyDone), at most `maxMs`, or until
 * `signal` aborts. True when it was let go because the agent was freed, which
 * does not say it is still free: whoever goes first takes it, and the rest
 * are refused again.
 */
export function freedWithin(agentId: string, maxMs: number, signal?: AbortSignal): Promise<boolean> {
  return freeWithin(agentId, maxMs, signal);
}

/** How many wait for this agent to be free (tests: a waiter that gave up is not among them). */
export function busyWaiters(agentId: string): number {
  return waitersFor(agentId);
}

/**
 * Run `fn` with the agent marked busy for `purpose`, clearing it however
 * that ends (reservations.ts, `whileReserved`).
 *
 * Exclusive: a caller arriving while the agent is already busy is refused,
 * not queued. Overlapping lifecycle operations (a Rebuild during a migrate's
 * stopped window, an adopt during a rebuild) don't merely race — they end in
 * two containers polling one bot token, or a container replaced underneath a
 * volume restore. Refusing loudly is the only safe answer.
 *
 * `fn` is given the reservation; `reuse` hands a holder's own on to code
 * that would take the agent again, which then goes on under it (in place of
 * `busyHeld`, HB-1465).
 *
 * With no purpose (`whileBusy(id, fn)`): a holder that names none, which
 * only tests are.
 */
export function whileBusy<T>(agentId: string, purpose: Purpose, fn: (held: Reservation) => Promise<T>, opts?: { reuse?: Reservation }): Promise<T>;
export function whileBusy<T>(agentId: string, fn: () => Promise<T>): Promise<T>;
export function whileBusy<T>(
  agentId: string,
  purposeOrFn: Purpose | (() => Promise<T>),
  fn?: (held: Reservation) => Promise<T>,
  opts?: { reuse?: Reservation },
): Promise<T> {
  if (typeof purposeOrFn === 'function') return whileReserved(agentId, undefined, purposeOrFn);
  return whileReserved(agentId, purposeOrFn, fn!, opts);
}
