import type { CompositeTelegramProvisioner } from '../../channels/composite.js';
import type { Operation } from './operations.js';
import { createAgentList, type AgentList, type AgentListDeps } from './agentList.js';
import { createAgentRecords, type AgentRecords, type AgentRecordsDeps } from './agentRecords.js';
import { createAutoRebuilds, type AutoRebuilds, type AutoRebuildsDeps } from './autoRebuilds.js';
import { createCapacity, type Capacity } from './capacity.js';
import { createPower, type Power, type PowerDeps } from './power.js';
import { createRebuildQueue, type RebuildQueue, type RebuildQueueDeps } from './rebuildQueue.js';

/**
 * The agent lifecycle service (HB-0808 step 11): what
 * makes, runs, rebuilds, starts, stops, archives and
 * deletes an agent. Seven parts:
 *
 *  - `queue` (rebuildQueue.ts): the setup and rebuild queue, one in flight
 *    per agent, the rebuild slots, and a change kept for the next start;
 *  - `rebuilds` (autoRebuilds.ts): which agents need a rebuild, the
 *    machine's own rebuilds by its policy, and the two .env settings for them,
 *    with the sweep's timer;
 *  - `power` (power.ts): Start (and the rebuild it may be), Stop, sleep and
 *    wake;
 *  - `records` (agentRecords.ts): create, archive and unarchive, and delete,
 *    with the archive marker and the deletes under way;
 *  - `capacity` (capacity.ts): the agent caps, and the places requests hold
 *    while they make an agent;
 *  - `list` (agentList.ts): the agent list's tiles;
 *  - `operations`: the owner's choice for a long operation held for them.
 *
 * Built once per process (`registerRoutes` in src/api/routes.ts), before the
 * other services, which are told of it as functions; on the route context as
 * `ctx.lifecycle`, and the queue's functions are the context's
 * `kickProvision`, `provisionWhenFree`, `kickRebuild`, `oweRebuild` and
 * `rebuildOrOwe` as before. `stop()` ends the sweep's interval, a setup's
 * waits and an owed start's wait. Nothing here knows HTTP: who may ask and the words of an answer are
 * src/api/agents/lifecycleRoutes.ts's.
 *
 * Not here: PATCH /v1/agents/:id, which stays in src/api/routes.ts (HB-0825).
 */
export interface AgentLifecycle {
  queue: RebuildQueue;
  rebuilds: AutoRebuilds;
  power: Power;
  records: AgentRecords;
  capacity: Capacity;
  list: AgentList;
  operations: {
    /** Carry out the owner's choice for an operation held for them (operationsResume.ts): throws RecoverError with its words. */
    recover(opId: string, action: string): Promise<Operation>;
  };
  stop(): void;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export interface AgentLifecycleDeps extends Omit<RebuildQueueDeps, 'deleting' | 'channel'>,
  Pick<AutoRebuildsDeps, 'switchPendingFor' | 'activityEvidence' | 'warn' | 'sweepEveryMs'>,
  Pick<PowerDeps, 'peersNotInstalled' | 'inLimitsTurn' | 'applyCurrentLimits' | 'tellMemoryBudget' | 'clearPinsWhenUp' | 'disownPauseOnStop' | 'hibernateDeps'>,
  Pick<AgentRecordsDeps, 'hostGoing' | 'connectorFor' | 'dmChannelPeople' | 'parkArchivedChannels' | 'forgetSettings' | 'forgetConversations'>,
  Omit<AgentListDeps, 'store' | 'providerFor' | 'channel' | 'rebuildNeedOf' | 'isQueued' | 'progressOf'> {
  /** The channels: setup's and a rebuild's, a delete's bot back to the pool, the list's pool marks. */
  channel: CompositeTelegramProvisioner;
  /** The boot's resume context, for the owner's choice (operationsResume.ts recoverOperation). */
  recoverOperation: (opId: string, action: string) => Promise<Operation>;
}

export function createAgentLifecycle(deps: AgentLifecycleDeps): AgentLifecycle {
  // The queue reads the deletes under way, and power the archive marker: both
  // are the records part's, built after the queue it uses (read when asked).
  let records: AgentRecords | undefined;
  const queue = createRebuildQueue({ ...deps, deleting: (agentId) => !!records?.isDeleting(agentId) });
  records = createAgentRecords({
    ...deps,
    kickProvision: (agentId, opts) => queue.kickProvision(agentId, opts),
    provisionWhenFree: (agentId) => queue.provisionWhenFree(agentId),
    inFlight: queue.inFlight,
    callOff: queue.callOff,
  });
  const rebuilds = createAutoRebuilds({
    ...deps,
    kickRebuild: (agentId) => queue.kickRebuild(agentId),
    isInFlight: queue.isInFlight,
    queueAtOnce: queue.atOnce,
    queueCounts: queue.counts,
    setQueueAtOnce: queue.setAtOnce,
  });
  const power = createPower({
    ...deps,
    kickRebuild: (agentId) => queue.kickRebuild(agentId),
    isInFlight: queue.isInFlight,
    rebuildNeedOf: rebuilds.rebuildNeedOf,
    isArchiving: records.isArchiving,
  });
  const list = createAgentList({
    ...deps,
    rebuildNeedOf: rebuilds.rebuildNeedOf,
    isQueued: queue.isQueued,
    progressOf: records.progressOf,
  });
  return {
    queue, rebuilds, power, records, list,
    capacity: createCapacity(deps),
    operations: { recover: (opId, action) => deps.recoverOperation(opId, action) },
    stop: () => { rebuilds.stop(); queue.stop(); power.stop(); },
  };
}
