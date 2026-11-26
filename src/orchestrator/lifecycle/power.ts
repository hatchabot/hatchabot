import type { Agent } from '../../domain/types.js';
import { rebuildPolicy } from '../../domain/rebuildPolicy.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { AgentBusyError, isBusy, whileBusy } from './busy.js';
import { hibernateAfterMs, hibernateAgent, hibernateBlocker, wakeAgent, type HibernateDeps } from './hibernate.js';
import { operationRefusal } from './operations.js';
import { renderRefusedRecently } from './provision.js';
import type { AutoRebuilds } from './autoRebuilds.js';

/**
 * Start, Stop, sleep and wake (HB-0808 step 11): when a stopped agent may
 * start and whether that start is the rebuild it is owed (`startStopped`,
 * which a budget's resume uses too), a Stop under the agent's lifecycle lock,
 * and the sleep a person asks for (hibernate.ts, with the process's
 * `HibernateDeps`). Part of the agent lifecycle service (agentLifecycle.ts).
 * Who may ask, the first checks and the words of every answer are the routes'
 * (src/api/agents/lifecycleRoutes.ts).
 */
export interface Power {
  /** Why this agent may not be started now, or undefined when it may. `holdingLock`: the caller holds its busy flag. */
  startRefusal(a: Agent | undefined, holdingLock?: boolean): string | undefined;
  /** Start a STOPPED agent, or rebuild it when a rebuild is owed or required; `ownerAsked`: the Start button. */
  startStopped(agent: Agent, opts?: { ownerAsked?: boolean }): Promise<{ ok: boolean; rebuilding?: boolean; agent?: Agent; error?: string }>;
  /**
   * Stop a running agent under its lifecycle lock. `answer` is made from the
   * stopped agent while the lock is still held. Throws AgentBusyError when
   * another holder has the agent.
   */
  stopRunning<T>(agentId: string, answer: (stopped: Agent) => T): Promise<{ ok: true; value: T } | { ok: false; error: string }>;
  /** Put it to sleep (hibernate.ts): throws AgentBusyError, or NoLongerSleepy with the reason it may not sleep. */
  hibernate(agent: Agent, why: string): Promise<Agent>;
  /** Wake a sleeping agent (a change made while it slept makes the wake a rebuild). */
  wake(agent: Agent, why: string): Promise<Agent>;
  /** What the idle rule would do with this agent now: the app's "Asleep" explanations. */
  sleepView(agent: Agent): Promise<{ afterMs: number; asleep: boolean; policy: Agent['hibernate'] | null; blocker: string | undefined }>;
}

/** What it needs from the process it runs in. Functions only, so a test hands it fakes. */
export interface PowerDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** The queue's: rebuild in the background (false when it would not). */
  kickRebuild: (agentId: string) => boolean;
  /** The queue's: a setup or rebuild in flight for the agent, waiting its turn included. */
  isInFlight: (agentId: string) => boolean;
  /** The auto rebuilds': why it needs a rebuild, if it does. */
  rebuildNeedOf: AutoRebuilds['rebuildNeedOf'];
  /** An archive of it is under way (from the click to the state flip). */
  isArchiving: (agentId: string) => boolean;
  /** Its peers are not the ones its last rebuild installed. */
  peersNotInstalled: (agentId: string) => boolean;
  /** The agent settings service's memory limits: its turn, its limits put on its container, its budget told. */
  inLimitsTurn: <T>(agentId: string, fn: () => Promise<T>) => Promise<T>;
  applyCurrentLimits: (agentId: string) => Promise<unknown>;
  tellMemoryBudget: (agentId: string) => Promise<void>;
  /** What runs once a started or woken agent is up (its pins, its browser, its accounts...). */
  clearPinsWhenUp: (a: Agent) => void;
  /** A Stop by a person: a budget's pause of it is no longer the budget's to end. */
  disownPauseOnStop: (agentId: string) => void;
  /** The process's hibernation deps (the idle sweep and the wake poll use the same). */
  hibernateDeps: () => HibernateDeps;
}

export function createPower(deps: PowerDeps): Power {
  const { store, providerFor, trace, kickRebuild, isInFlight, rebuildNeedOf, isArchiving, peersNotInstalled, inLimitsTurn, applyCurrentLimits, tellMemoryBudget, clearPinsWhenUp, disownPauseOnStop } = deps;

  /**
   * Start a STOPPED agent: the Start button, and a budget pause ending
   * (budgets.ts). One that needs a REQUIRED rebuild comes up rebuilt.
   */
  const BUSY_MSG = 'Another operation is already running on this agent.';
  /** Why this agent may not be started now, or undefined when it may. */
  const startRefusal = (a: Agent | undefined, holdingLock = false): string | undefined => {
    if (!a || !a.runtimeRef) return 'Not found';
    if (a.migratedTo) return `It moved to ${a.migratedTo}.`;
    // A move or import interrupted by a restart, or held for the owner's
    // choice: starting it could put two copies on one bot (operations.ts).
    { const onDisk = operationRefusal(store, a.id); if (onDisk) return onDisk; }
    if ((!holdingLock && isBusy(a.id)) || isArchiving(a.id)) return BUSY_MSG;
    // A rebuild in flight or waiting its turn (one follows every bot
    // handover): the container still holds the bot it gave back, and
    // starting it as it is polled a bot another agent may lease
    // (concurrency review, 2026-10-09). The rebuild starts it.
    if (isInFlight(a.id)) return 'It is being rebuilt; it starts by itself when that is done.';
    if (a.state !== 'STOPPED') return `Cannot start while ${a.state}`;
    return undefined;
  };
  /** Does its container run another image than its pin? Unread is not "another" (rebuildNeedOf leaves pinned agents out). */
  const pinNotRunYet = async (a: Agent): Promise<boolean> => {
    if (!a.image || !a.runtimeRef) return false;
    const prov = providerFor(a.hostId);
    const [running, target] = await Promise.all([prov.info(a.runtimeRef), prov.currentImageInfo(a.image)]).catch(() => [undefined, undefined]);
    return !!running?.imageId && !!target?.imageId && running.imageId !== target.imageId;
  };
  /**
   * Why Start rebuilds it rather than start its container: a change saved for
   * its next start, or peers it has not installed, however they changed (a
   * peer deleted, a change during an operation: HB-0465). The second waits
   * while a rebuild was refused at render a moment ago (HB-0419), as Start's
   * own checks do. Peers are judged only when the owner starts it: a wake for
   * a message, or a budget's resume, starts the container it has, and the
   * peers wait for Start or a Rebuild.
   */
  const rebuildOwedAtStart = (agentId: string, ownerAsked: boolean): string | undefined =>
    store.getAgent(agentId)?.rebuildOnStart ? 'a change made while it was down'
      : ownerAsked && !renderRefusedRecently(agentId) && peersNotInstalled(agentId) ? 'its peers changed while it was down'
      : undefined;
  const startStopped = async (agent: Agent, opts: { ownerAsked?: boolean } = {}): Promise<{ ok: boolean; rebuilding?: boolean; agent?: Agent; error?: string }> => {
    { const why = startRefusal(agent); if (why) return { ok: false, error: why }; }
    // A stopped agent is never rebuilt on the machine's own initiative (a
    // rebuild starts it). Starting it is the moment: one that needs a
    // REQUIRED rebuild comes up rebuilt instead of as it was, and so does one
    // with a change waiting for this start, whatever the machine's policy: the
    // change is the owner's own, and the old container does not have it (HB-0411).
    const owed = rebuildOwedAtStart(agent.id, !!opts.ownerAsked);
    const reasons: string[] = owed ? [owed] : [];
    // Refused at render time a moment ago (HB-0419), and nothing was owed: the
    // container it has still works, so this press starts it as it is.
    const mayBeRebuilt = reasons.length > 0 || !renderRefusedRecently(agent.id);
    // Pinned while it ran with the rebuild put off: the pin is the owner's too (HB-0441).
    if (mayBeRebuilt && !reasons.length && await pinNotRunYet(agent)) reasons.push('it is pinned to an image it does not run yet');
    if (mayBeRebuilt && !reasons.length && rebuildPolicy() !== 'manual') {
      const need = await rebuildNeedOf(agent).then((r) => r?.need, () => undefined);
      if (need?.level === 'required') reasons.push(...need.reasons);
    }
    if (reasons.length) {
      // Judged again after that wait: an Archive or a Delete may have begun.
      const why = startRefusal(store.getAgent(agent.id));
      if (why) return { ok: false, error: why };
      if (kickRebuild(agent.id)) {
        trace(agent.id)('rebuild.on_start', { reasons });
        return { ok: true, rebuilding: true, agent: store.getAgent(agent.id)! };
      }
      // Never its old container in place of a rebuild that was owed: that may
      // still hold a bot it gave back (rebuildAfterHandover).
      if (store.getAgent(agent.id)?.rebuildOnStart) return { ok: false, error: BUSY_MSG };
    }
    // Under the agent's lifecycle lock, as Archive, Rebuild and Move are, and
    // judged again once it is held. Without it an Archive could take the lock
    // during the docker start, stop the container, give the bot back and mark
    // it ARCHIVED — and then this start brought the runtime up, still holding
    // the token of a bot another agent might lease next (#10).
    let r: { ok: boolean; agent?: Agent; error?: string };
    try {
      r = await whileBusy(agent.id, 'start', async () => {
        const now = store.getAgent(agent.id);
        const why = startRefusal(now, true);
        if (why) return { ok: false, error: why };
        // A change saved for its next start during the checks above.
        if (now?.rebuildOnStart) return { ok: false, error: 'A change was just saved for it. Press Start again.' };
        // Its cap and swap allowance as they are now, as a wake does (swap.ts).
        const provider = providerFor(now!.hostId);
        await inLimitsTurn(agent.id, () => applyCurrentLimits(agent.id));
        await provider.start(now!.runtimeRef!);
        store.setHibernated(agent.id, null);
        return { ok: true, agent: store.setAgentState(agent.id, 'RUNNING') };
      });
    } catch (err) {
      if (err instanceof AgentBusyError) return { ok: false, error: err.userMessage };
      throw err;
    }
    // After the store says RUNNING and the lock is let go, as a wake does:
    // what runs once it is up (the limits check among it) skips busy agents.
    // Its budget too (tellMemoryBudget): a cap changed while it was down
    // went on its container above, but its AGENTS.md still says the old
    // one, and its environment keeps the cap it was made with, so the live
    // words. A section that already says its cap is left as it is.
    if (r.ok && r.agent) {
      clearPinsWhenUp(r.agent);
      void tellMemoryBudget(r.agent.id).catch(() => undefined);
    }
    return r;
  };

  // Under the agent's lifecycle lock, as Archive, Rebuild and Move are: an
  // Archive or a Start arriving during the docker stop is refused as busy,
  // instead of finishing underneath it (#10).
  const stopRunning = <T,>(agentId: string, answer: (stopped: Agent) => T): Promise<{ ok: true; value: T } | { ok: false; error: string }> =>
    whileBusy(agentId, 'stop', async (): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
      const now = store.getAgent(agentId);
      if (!now?.runtimeRef || now.state !== 'RUNNING') {
        return { ok: false, error: `Cannot stop while ${now?.state ?? 'DELETED'}` };
      }
      await providerFor(now.hostId).stop(now.runtimeRef);
      disownPauseOnStop(now.id);
      return { ok: true, value: answer(store.setAgentState(now.id, 'STOPPED')) };
    });

  return {
    startRefusal, startStopped, stopRunning,
    hibernate: (agent, why) => hibernateAgent(deps.hibernateDeps(), agent, why),
    wake: (agent, why) => wakeAgent(deps.hibernateDeps(), agent, why),
    sleepView: async (agent) => {
      const afterMs = hibernateAfterMs();
      return { afterMs, asleep: !!agent.hibernatedAt, policy: agent.hibernate ?? null,
        blocker: afterMs ? await hibernateBlocker(deps.hibernateDeps(), agent, Date.now(), afterMs) : 'hibernation is off on this machine (HATCHABOT_HIBERNATE_AFTER)' };
    },
  };
}
