import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { UP_TRIES, sleepUnref, upEveryMs, type UpWait } from './afterRestart.js';
import { createClassChanges, type ClassChanges } from './classChanges.js';
import { createMemoryLimits, type MemoryLimits } from './memoryLimits.js';
import { createModelRuntime, type ModelRuntime } from './modelRuntime.js';
import { createSourceHolds, type SourceHolds } from './sourceHolds.js';

/**
 * The agent settings service (HB-0807):
 * what each agent runs on, and how a change of it reaches the agent. Three
 * parts, each with its own state and no way into another's:
 *
 *  - `models` (modelRuntime.ts): an agent's model put on its runtime, one
 *    write at a time per agent, and the checks of what it may run;
 *  - `limits` (memoryLimits.ts): its memory cap and swap allowance put on its
 *    container, one change at a time per agent, and its new budget told;
 *  - `classes` (classChanges.ts): a class edited or deleted, an agent joining
 *    or leaving one, one change at a time per class;
 *
 * and `sourceHolds` (sourceHolds.ts): the AI sources a change is moving an
 * agent to, which may not be deleted meanwhile. A class change takes one; so
 * do the AI sources service (sources/aiSources.ts, through `withSourceHold`)
 * and PATCH /v1/agents/:id, which is why it is here and not with either.
 *
 * Built once per process (`registerRoutes` in src/api/routes.ts) and handed
 * to the route files on the shared context (`ctx.settings`). Nothing here
 * knows about HTTP: a route reads its request, asks this, and words the
 * answer. `stop()` ends its timers; `forgetAgent` drops what it keeps for an
 * agent that is gone.
 *
 * Which of its Maps and Sets a restart may not lose is sorted in each part's
 * header and in docs/architecture.md ("In-memory state, sorted",
 * HB-0809). None of what it holds in memory is needed after a restart: what
 * a process has still to do for an agent when it ends is in the store
 * (`agent_holds`), and the next process takes it up, at once where only the
 * store is asked (a detach left to be decided, as the service is built) and
 * in `resume()` where a machine is.
 */
export interface AgentSettings {
  models: ModelRuntime;
  limits: MemoryLimits;
  classes: ClassChanges;
  sourceHolds: SourceHolds;
  /** An agent deleted, or one whose making failed: what the service kept for it goes. */
  forgetAgent(agentId: string): void;
  /**
   * After a restart: what the last process had still to put on a container.
   * The limits of the agents taken out of their class as the service was
   * built, the models it stored and had not applied, and each running
   * agent's memory budget. Each agent's once `settled` says its own
   * operations the start settles are (operationsResume.ts,
   * startResumeOperations' `settledFor`): one agent's move to another
   * Hatchabot, waiting minutes for that server, held up every other
   * agent's (HB-0839). Called once, by the boot (`registerRoutes`'
   * `resumeOperations`); never rejects.
   */
  resume(settled?: (agentId: string) => Promise<void>): Promise<void>;
  /** End the service's timers and start no more background work: at shutdown. */
  stop(): void;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export interface AgentSettingsDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline: `trace(agent.id)` gives the function that takes the event and its detail. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** A line to the server's log only. */
  warn: (detail: Record<string, unknown>, event: string) => void;
  /**
   * The setup or rebuild in flight for an agent, as a promise for its end
   * (it may reject), or undefined when there is none. The setup and rebuild
   * queue belongs to its own feature; this is all the service sees of it.
   */
  inFlight: (agentId: string) => Promise<void> | undefined;
  /** Deleted or being deleted: nothing more is stored for it. */
  agentGone: (id: string) => boolean;
  /** One write of an agent's AGENTS.md at a time: the turn a save of it takes. */
  withAgentsMdTurn: <T>(agentId: string, fn: () => Promise<T>) => Promise<T>;
  /** How long a hold on an AI source counts for (the API's HOLD_MS). */
  sourceHoldMs: number;
  /** Tests: the pause between two looks for a container that is not up yet after a restart (afterRestart.ts). */
  sleep?: (ms: number) => Promise<void>;
  /** After a restart: a model ask an earlier process left that its runtime refused (modelRuntime.ts, HB-1404). */
  owedRefused?: (agentId: string, ask: string) => void;
}

export function createAgentSettings(deps: AgentSettingsDeps): AgentSettings {
  const { store, providerFor, trace, inFlight } = deps;
  let stopped = false;
  const upWait: UpWait = { tries: UP_TRIES, everyMs: upEveryMs(), sleep: deps.sleep ?? sleepUnref, stopped: () => stopped };
  const models = createModelRuntime({ store, providerFor, trace, inFlight, upWait, ...(deps.owedRefused ? { owedRefused: deps.owedRefused } : {}) });
  const limits = createMemoryLimits({ store, providerFor, trace, inFlight, withAgentsMdTurn: deps.withAgentsMdTurn, upWait });
  const classes = createClassChanges({ store, trace, inFlight, agentGone: deps.agentGone, models, limits });
  const sourceHolds = createSourceHolds({ holdMs: deps.sourceHoldMs, warn: deps.warn });
  return {
    models, limits, classes, sourceHolds,
    forgetAgent: (agentId) => classes.forgetAgent(agentId),
    // By agent, each once its own operations are settled. The limits first: a
    // class left changes those that apply, and the budget told is of them.
    // Then the models and the budgets side by side: one agent's wait for its
    // rebuild, or for its operation, holds up neither, nor another agent's.
    resume: async (settled = async () => undefined) => {
      try {
        const own = (agentId: string): Promise<void> => settled(agentId).catch(() => undefined);
        const limitsOn = classes.limitsAfterRestart(own);
        const ready = (agentId: string): Promise<void> => limitsOn.get(agentId) ?? own(agentId);
        await Promise.all([models.applyOwed(ready), limits.tellRunning(ready), ...limitsOn.values()]);
      } catch (err) {
        deps.warn({ err: String((err as Error)?.message ?? err).slice(0, 300) }, 'settings.resume_failed');
      }
    },
    stop: () => { stopped = true; models.stop(); limits.stop(); },
  };
}
