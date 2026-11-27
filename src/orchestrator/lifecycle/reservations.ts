/**
 * One reservation per agent (HB-0629, HB-1465 step 4): what was the busy
 * flag, with what it was taken for. `busy.ts` is its facade, by the names
 * every caller already uses (`whileBusy`, `markBusy`, `isBusy`, `busyDone`).
 *
 * Exclusive and in memory, as the flag was: a second take of a held agent
 * is refused (AgentBusyError), not queued, and a restart lets go of every
 * reservation, since the work it guarded ends with the process. What the
 * work left behind is made up for at the start by what each purpose names
 * below (an operation on disk, reconcile, a hold in the store), never by
 * the reservation itself: none is kept in the database
 * (docs/architecture.md, "In-memory state, sorted").
 *
 * Each reservation is its holder's (HB-1385): only its own release lets it
 * go, and a release called late (its finally run twice, or once the agent
 * has passed to another holder) does nothing.
 */

/**
 * What a reservation is taken for: named at every take in src
 * (test/reservations.test.ts holds every whileBusy and markBusy to one).
 * The take's words to a caller it refuses are as they were; the purpose is
 * for what a log, or a later check, can say about the holder (`heldFor`,
 * `AgentBusyError.heldFor`).
 */
export const PURPOSES = [
  // Long changes, each an operation on disk (operations.ts): the start
  // settles one a restart cut off (resumeOperations), and reconcile leaves
  // its agent alone meanwhile (activeOperationFor).
  'provision', 'rebuild', 'move-host', 'migrate', 'import', 'restore-backup', 'restore-snapshot', 'archive',
  'app-install', 'app-update', 'app-rollback', 'adopt-workspace',
  // An interrupted operation settled by the start's pass, and the owner's choice on a held one.
  'resume-operation', 'recover-operation',
  // Its container started or stopped: reconcile judges the record by it at the start.
  'start', 'stop', 'sleep', 'wake', 'drain', 'budget-pause', 'ops-tools-restart', 'download',
  // Its files, its tasks, its apps and its settings in the container.
  'file-save', 'file-upload', 'setup-values', 'definition-read', 'definition-push', 'proposal-merge',
  'skill-change', 'skill-trial', 'docs-sync', 'data-source-add', 'template-tasks', 'adopt-repoint',
  'task-add', 'task-edit', 'task-enable', 'task-run', 'task-remove', 'app-remove', 'voice',
  // Its bots and the people on them.
  'telegram-attach', 'telegram-detach', 'telegram-swap', 'channel-attach', 'channel-swap', 'channel-detach',
  'pairing-approve', 'member-grant', 'member-remove', 'member-join', 'discord-unlink',
  // A new agent's record filled in, a copy made, an image taken to another machine, an archived agent restored.
  'template-answers', 'clone-source', 'clone-draft', 'move-image', 'unarchive',
] as const;
export type Purpose = (typeof PURPOSES)[number];

/** The words a take refused because the agent is held says, as the busy flag said them. */
const BUSY = 'Another operation is already running on this agent.';

/** A second lifecycle operation arrived while one was still running. */
export class AgentBusyError extends Error {
  /** `heldFor`: the purpose of the reservation it ran into, where a take was refused by one (none: another refusal, or a holder that named none). */
  constructor(readonly userMessage: string, readonly heldFor?: Purpose) {
    super(userMessage);
    this.name = 'AgentBusyError';
  }
}

/** One agent held, by one holder. */
export interface Reservation {
  readonly agentId: string;
  /** What it was taken for. None only for a holder that names none, which only tests are (busy.ts, `markBusy`). */
  readonly purpose: Purpose | undefined;
  /** Still the agent's: not let go, and the agent not passed to another holder. */
  readonly held: boolean;
  /** Lets go of this reservation only: called again, or once the agent has passed to another holder, it does nothing. */
  release(): void;
}

/** Each agent's reservation, by agent. */
const reservations = new Map<string, Reservation>();
/** Who waits for an agent to be free (whenFree), let go when it is. */
const freed = new Map<string, Array<() => void>>();

function letGo(agentId: string): void {
  reservations.delete(agentId);
  const waiting = freed.get(agentId);
  freed.delete(agentId);
  for (const go of waiting ?? []) go();
}

/**
 * Reserve the agent for `purpose`, for a holder that cannot put its work in
 * one function (whileReserved): its `release()` is the one way to let it
 * go, in the holder's finally. Refused (AgentBusyError) when the agent is
 * held already: one holder at a time. Taken in this tick, so nothing can
 * come between a caller's last check and it.
 */
export function reserve(agentId: string, purpose: Purpose | undefined): Reservation {
  const holder = reservations.get(agentId);
  if (holder) throw new AgentBusyError(BUSY, holder.purpose);
  const r: Reservation = {
    agentId,
    purpose,
    get held() { return reservations.get(agentId) === r; },
    release() { if (reservations.get(agentId) === r) letGo(agentId); },
  };
  reservations.set(agentId, r);
  return r;
}

/**
 * Run `fn` with the agent reserved for `purpose`, let go however that ends.
 *
 * Exclusive: a caller arriving while the agent is held is refused, not
 * queued (a rejection, never a throw from this call). Overlapping lifecycle
 * operations (a Rebuild during a migrate's stopped window, an adopt during a
 * rebuild) don't merely race — they end in two containers polling one bot
 * token, or a container replaced underneath a volume restore. Refusing
 * loudly is the only safe answer. Taken in the tick it is called in.
 *
 * `fn` is given the reservation, to hand on as `reuse`.
 *
 * `reuse`: a holder's own reservation, handed to code that would take the
 * agent again (an owner's choice on a held operation runs the setup's or
 * the rebuild's restart rule, which takes it itself). While that is still
 * the agent's, `fn` goes on under it, and this take neither refuses its own
 * holder nor lets the agent go when `fn` ends: its holder does. One that is
 * no longer held, or another agent's, is no reservation here: the agent is
 * taken as with none.
 */
export async function whileReserved<T>(
  agentId: string,
  purpose: Purpose | undefined,
  fn: (held: Reservation) => Promise<T>,
  opts: { reuse?: Reservation } = {},
): Promise<T> {
  const { reuse } = opts;
  if (reuse && reuse.agentId === agentId && reuse.held) return fn(reuse);
  const r = reserve(agentId, purpose);
  try {
    return await fn(r);
  } finally {
    r.release();
  }
}

export function isReserved(agentId: string): boolean {
  return reservations.has(agentId);
}

/** What the agent is held for now (none when it is free, or held by a holder that named none). */
export function heldFor(agentId: string): Purpose | undefined {
  return reservations.get(agentId)?.purpose;
}

/**
 * Settles once the agent is no longer held (at once when it is not): for a
 * job that waits its turn behind whatever holds the agent, rather than
 * looking again every few seconds. `signal`: a waiter that stops waiting
 * (its own time limit) is let go and forgotten, not kept until the agent is
 * free. Never rejects.
 */
export function whenFree(agentId: string, signal?: AbortSignal): Promise<void> {
  if (!reservations.has(agentId) || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const go = () => { signal?.removeEventListener('abort', leave); resolve(); };
    const leave = () => {
      const rest = (freed.get(agentId) ?? []).filter((w) => w !== go);
      if (rest.length) freed.set(agentId, rest); else freed.delete(agentId);
      resolve();
    };
    freed.set(agentId, [...(freed.get(agentId) ?? []), go]);
    signal?.addEventListener('abort', leave, { once: true });
  });
}

/**
 * Waits for the agent to be free (whenFree), at most `maxMs`, or until
 * `signal` aborts. True when it was let go because the agent was freed, which
 * does not say it is still free: whoever goes first takes it, and the rest
 * are refused again.
 */
export async function freeWithin(agentId: string, maxMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  if (!reservations.has(agentId)) return true;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), maxMs);
  timer.unref?.();
  const end = () => stop.abort();
  signal?.addEventListener('abort', end, { once: true });
  try { await whenFree(agentId, stop.signal); } finally { clearTimeout(timer); signal?.removeEventListener('abort', end); }
  return !stop.signal.aborted;
}

/** How many wait for this agent to be free (tests: a waiter that gave up is not among them). */
export function waitersFor(agentId: string): number {
  return freed.get(agentId)?.length ?? 0;
}

/**
 * Forget the agent's reservation, whoever holds it, and let its waiters go:
 * what a restart does to every one (they are this process's memory). For
 * tests, which stand for a restart with it through busy.ts's `clearBusy`;
 * src lets one go only through its holder's release (test/busy.test.ts and
 * test/reservations.test.ts keep both out of src).
 */
export function forgetReservation(agentId: string): void {
  letGo(agentId);
}

/**
 * Forget every reservation and let every waiter go, as a new process starts
 * with none. For the tests' setup only (test/support/freshReservations.ts),
 * which runs it after every test: a test world shares the process with the
 * one before it, and an agent of the same id held there was still held in
 * the next (HB-0873). src never calls it (test/reservations.test.ts).
 */
export function forgetAllReservationsForTests(): void {
  for (const agentId of new Set([...reservations.keys(), ...freed.keys()])) letGo(agentId);
}
