import type { Agent } from '../../domain/types.js';
import type { Store } from '../../store/store.js';
import { keyedLock } from '../../util/queues.js';
import { AgentBusyError } from '../lifecycle/busy.js';

/** A change refused once its turn came (withCoreFilesTurn): the answer's status and words. */
export class TurnRefused extends Error { constructor(readonly status: number, message: string) { super(message); } }

/** How long a change waits for its agent's core-files turn before it is refused (HB-0566). */
export const CORE_FILES_WAIT_MS = 2 * 60_000;

/** The answer when `agentGone` says so (AGENT_GONE's words in src/api/routeContext.ts). */
const AGENT_GONE = 'It was deleted.';

/**
 * An agent's core-files turn and its AGENTS.md turn: one queue per agent
 * (HB-0808 step 13, part of the agent files service, files.ts). Every
 * caller shares it: a save of a core file, an upload, a skill file changed
 * or practised, a snapshot taken or restored by hand, setup values, a
 * pushed definition, a proposal merged, a template or share read, an
 * adopt's snapshot first and its re-point of the files (HB-0629), and the
 * AGENTS.md budget's and the held syncs' writes (src/api/routes.ts and the
 * services hand these functions on; none builds its own).
 *
 * Its state: `agentsMdTurns`, a keyed lock (keyedLock, src/util/queues.ts):
 * the queue (what waits in it ends with the process) and the deadlines of
 * the changes waiting for their turn, which `stop()` brings forward: each
 * is refused at once, as its deadline would refuse it, and never runs.
 */
export interface CoreFileTurns {
  /**
   * One write of an agent's AGENTS.md at a time among those that take this
   * turn: a save of it, the budget's check and rename, the held syncs'
   * write. A keyed chain, not the busy flag, which would refuse a Rebuild
   * or a class apply asked meanwhile.
   */
  withAgentsMdTurn<T>(agentId: string, fn: () => Promise<T>): Promise<T>;
  /**
   * One agent's changes that write its core files (setup values, a definition
   * pushed to it, a snapshot restored, a file saved, a proposal merged, an
   * adopt's re-point) and its snapshots taken by hand take turns: a snapshot taken during such a change held some files
   * from before and some from after (HB-0566, HB-0629). Narrower than the busy flag: a
   * backup, a task switched on, an app install does not hold a snapshot up.
   * One waits CORE_FILES_WAIT_MS at most (or `waitMs`, what is left of a
   * deadline it shares), then is refused (AgentBusyError) and never runs: a
   * change that hung held every later one up for good. A turn that is free
   * is taken even with no time left.
   */
  withCoreFilesTurn<T>(agentId: string, fn: () => Promise<T>, waitMs?: number): Promise<T>;
  /**
   * The agent as it is at its turn, not as read before the wait: one deleted
   * meanwhile is refused (404), one stopped or asleep too (409, `notRunning`).
   * Where it runs is read here, so one moved meanwhile is written where it is.
   */
  freshRunning(agentId: string, notRunning: (a: Agent) => string): Agent & { runtimeRef: string };
  /** At shutdown: every change still waiting for its turn is refused now, as its deadline would refuse it. */
  stop(): void;
}

export interface CoreFileTurnsDeps {
  store: Store;
  /** Deleted or being deleted. */
  agentGone: (id: string) => boolean;
}

export function createCoreFileTurns(deps: CoreFileTurnsDeps): CoreFileTurns {
  const { store, agentGone } = deps;
  // The AGENTS.md budget/docs writers take this same queue. Holding it for
  // the whole transaction also protects snapshots and partial-write rollback.
  // A change of core files waits for its turn CORE_FILES_WAIT_MS at most;
  // one that gave up never runs, and the next still waits for the one
  // before it. An AGENTS.md write waits as long as it takes.
  const agentsMdTurns = keyedLock({ refusal: () => new AgentBusyError('Another change to its files is still running; try again when it ends.') });
  const withAgentsMdTurn = <T>(agentId: string, fn: () => Promise<T>): Promise<T> => agentsMdTurns.run(agentId, fn);
  const withCoreFilesTurn = <T>(agentId: string, fn: () => Promise<T>, waitMs = CORE_FILES_WAIT_MS): Promise<T> =>
    agentsMdTurns.run(agentId, fn, waitMs);

  const freshRunning = (agentId: string, notRunning: (a: Agent) => string): Agent & { runtimeRef: string } => {
    const fresh = store.getAgent(agentId);
    if (!fresh || agentGone(agentId)) throw new TurnRefused(404, AGENT_GONE);
    if (fresh.state !== 'RUNNING' || !fresh.runtimeRef) throw new TurnRefused(409, notRunning(fresh));
    return fresh as Agent & { runtimeRef: string };
  };

  const stop = (): void => agentsMdTurns.stop();

  return { withAgentsMdTurn, withCoreFilesTurn, freshRunning, stop };
}
