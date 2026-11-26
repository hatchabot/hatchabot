import { keyedLock } from '../../util/queues.js';
import { isBusy } from '../lifecycle/busy.js';
import type { SchedulesDeps } from './schedules.js';

/**
 * Event-triggered tasks: the agent's permission to run them, saved on its
 * record and written to its running gateway (HB-0808). PATCH
 * /v1/agents/:id, which saves it, is the agent's own route (routes.ts).
 */
export interface CronTriggers {
  /**
   * The saved permission written to the running agent, in the order they
   * were saved. Undefined when it is live (or the agent is gone); else what
   * to tell the owner, a rebuild owed for its next start or wake.
   * `ownObligation`: the rebuild mark the caller made, cleared once live.
   */
  applyCronTriggers(agentId: string, ownObligation?: string): Promise<string | undefined>;
}

export function createCronTriggers(deps: SchedulesDeps): CronTriggers {
  const { store, providerFor, trace, agentGone, oweRebuild } = deps;

  /** Concurrent toggles apply the latest saved permission in order. A failed
   * write leaves a durable rebuild obligation, so Start/wake cannot reuse
   * the old permission after the caller was told the change was saved. */
  const triggerApplies = keyedLock();
  const applyCronTriggers = (agentId: string, ownObligation?: string): Promise<string | undefined> => triggerApplies.run(agentId, async () => {
    const a = store.getAgent(agentId);
    if (!a || agentGone(agentId)) return undefined;
    let live = false;
    if (a.state === 'RUNNING' && a.runtimeRef && !isBusy(agentId)) {
      const res = await providerFor(a.hostId).exec(a.runtimeRef, ['config', 'set', 'cron.triggers.enabled', a.cronTriggers ? 'true' : 'false'], { timeoutMs: 20_000 }).catch(() => undefined);
      const now = store.getAgent(agentId);
      live = res?.code === 0 && now?.state === 'RUNNING' && now.runtimeRef === a.runtimeRef && now.hostId === a.hostId && !!now.cronTriggers === !!a.cronTriggers;
    }
    trace(agentId)('cron.triggers', { enabled: !!a.cronTriggers, live });
    if (live) {
      // A browser, image or channel change may also need a rebuild. Clear
      // only our own mark, and only if nobody replaced it while we waited.
      if (ownObligation && store.getAgent(agentId)?.rebuildOnStart === ownObligation) store.setRebuildOnStart(agentId, null);
      return undefined;
    }
    const now = store.getAgent(agentId);
    if (!now || agentGone(agentId)) return undefined;
    if (now.runtimeRef && !now.rebuildOnStart) oweRebuild(agentId);
    return now.state === 'STOPPED' || !now.runtimeRef
      ? `Saved. Event-triggered tasks will be ${now.cronTriggers ? 'enabled' : 'disabled'} when the agent next starts.`
      : 'Saved, but its running permission could not be changed. Event-triggered tasks may still use the old permission. Rebuild the agent to apply it; its next start or wake will also apply it.';
  });

  return { applyCronTriggers };
}
