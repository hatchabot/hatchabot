import type { Agent } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { whileBusy } from '../lifecycle/busy.js';
import { FILES_REPLACED_BY, filesReplacingCount, operationRefusal } from '../lifecycle/operations.js';
import { captureSnapshot, restoreSnapshot, SnapshotError, snapshotsInUse, type SnapshotSummary } from '../files/snapshots.js';

/**
 * An agent's snapshots (HB-0808): the
 * history of its core files, one taken by hand, one restored, one deleted.
 * Taking and restoring them is src/orchestrator/files/snapshots.ts; this is the
 * rules the API put round it: when one may be taken, the turn it waits for,
 * and which ones a restore not yet finished still needs.
 *
 * Its state: none of its own. Both take the agent's core-files turn (the
 * agent files service's `withCoreFilesTurn`, the queue the AGENTS.md writers share), handed
 * in; a restore holds the busy flag (busy.ts) and is recorded as an operation
 * (restore-snapshot).
 *
 * Nothing here knows about HTTP: a route reads its request, asks this, and
 * words the answer.
 */
export interface AgentSnapshots {
  /**
   * Take one by hand, in turn with the changes that write its core files.
   * Refused (SnapshotError) under a change that replaces its files, and when
   * one begins while it reads; AgentBusyError when its turn did not come.
   */
  take(agent: Agent, label: string | undefined): Promise<SnapshotSummary>;
  /**
   * Put its core files back as the snapshot holds them, in its files turn
   * and under the busy flag. The function returned runs it (the route runs
   * it now or in the background); its refusals are thrown.
   */
  restore(agent: Agent, snapshotId: string, requestedBy: string): (onOperation?: (id: string) => void) => Promise<{ restored: string[]; safetySnapshotId?: string }>;
  /** Delete one: refused while a restore that has not finished needs it. */
  remove(agentId: string, snapshotId: string): 'in-use' | 'not-found' | 'deleted';
}

/** What the snapshots need from the process they run in. Functions only, so a test hands them fakes. */
export interface AgentSnapshotsDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** Deleted or being deleted. */
  agentGone: (id: string) => boolean;
  /** Is a setup or rebuild in flight for the agent? (The routes' setup and rebuild queue.) */
  inFlight: (agentId: string) => boolean;
  /** Is an archive of this agent under way? */
  isArchiving: (agentId: string) => boolean;
  /**
   * The agent's core-files turn (files/coreFileTurns.ts): one change that writes its
   * files at a time, a snapshot by hand among them; one waits two minutes
   * at most, then is refused (AgentBusyError) and never runs (HB-0566).
   */
  withCoreFilesTurn: <T>(agentId: string, fn: () => Promise<T>) => Promise<T>;
}

/** The answer when `agentGone` says so (AGENT_GONE's words in src/api/routeContext.ts, as captureSnapshot words it). */
const AGENT_GONE = 'It was deleted.';

export function createAgentSnapshots(deps: AgentSnapshotsDeps): AgentSnapshots {
  const { store, providerFor, trace, agentGone, withCoreFilesTurn } = deps;
  const snapshotDeps = (agent: Agent) => ({
    store,
    provider: providerFor(agent.hostId),
    log: trace(agent.id),
  });

  const take = (agent: Agent, label: string | undefined): Promise<SnapshotSummary> => {
    // In turn with the changes that write several files (withCoreFilesTurn):
    // it waits for one under way, and one waits for it (HB-0566).
    // Its machine as it is at its turn (moved meanwhile); captureSnapshot
    // judges the rest then (deleted, archived, not running). Under a
    // change that replaces its files (a rebuild, a move, an archive, a
    // restore, an app update), they may be half replaced: it is refused.
    // One that begins while it reads (a Rebuild pressed meanwhile) goes
    // ahead, and what was read is dropped, not stored. Other work (a
    // backup, a task switched on, an app install) does not hold it up.
    // Those that take one inside their own change (a rebuild's, Apply
    // values') call captureSnapshot.
    const replacing = (): string | undefined => {
      if (deps.inFlight(agent.id)) return 'It is busy (a rebuild); take the snapshot when that ends.';
      if (deps.isArchiving(agent.id)) return 'It is busy (being archived); take the snapshot when that ends.';
      const op = store.activeOperationFor(agent.id);
      if (op && FILES_REPLACED_BY.has(op.kind)) return operationRefusal(store, agent.id) ?? 'Another change is under way — wait for it to finish.';
      return undefined;
    };
    return withCoreFilesTurn(agent.id, () => {
      const busy = replacing();
      if (busy) throw new SnapshotError(busy);
      const began = filesReplacingCount(agent.id);
      return captureSnapshot(snapshotDeps(store.getAgent(agent.id) ?? agent), agent.id, {
        label,
        torn: () => (filesReplacingCount(agent.id) !== began || replacing()
          ? 'A rebuild or restore started while the snapshot read its files; take it again.'
          : undefined),
      });
    });
  };

  // The files turn first, then the busy flag, as Apply values takes them.
  const restore: AgentSnapshots['restore'] = (agent, snapshotId, requestedBy) =>
    (onOperation?: (id: string) => void) => withCoreFilesTurn(agent.id, () => whileBusy(agent.id, 'restore-snapshot', async () => {
      // Where it runs as it is at its turn: moved while this waited, the
      // restore wrote the snapshot to where it was (HB-0566).
      const fresh = store.getAgent(agent.id);
      if (!fresh || agentGone(agent.id)) throw new SnapshotError(AGENT_GONE);
      if (fresh.hostId !== agent.hostId || fresh.runtimeRef !== agent.runtimeRef) throw new SnapshotError('It moved while this waited; restore again.');
      return restoreSnapshot({ ...snapshotDeps(fresh), requestedBy, onOperation }, agent.id, snapshotId);
    }));

  const remove = (agentId: string, snapshotId: string): 'in-use' | 'not-found' | 'deleted' => {
    if (snapshotsInUse(store, agentId).includes(snapshotId)) return 'in-use';
    if (!store.deleteSnapshot(agentId, snapshotId)) return 'not-found';
    return 'deleted';
  };

  return { take, restore, remove };
}
