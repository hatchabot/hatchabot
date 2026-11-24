import type { ChannelKindForFiles } from '../../domain/filesLimit.js';
import type { Agent } from '../../domain/types.js';
import type { OpsPush } from '../../ops/push.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { createTaskSweeps, type TaskSweeps } from './sweeps.js';
import { createScheduledTasks, type ScheduledTasks } from './tasks.js';
import { createCronTriggers, type CronTriggers } from './triggers.js';

/**
 * The schedules service (HB-0808): an
 * agent's scheduled tasks, which live in its own OpenClaw gateway and are
 * driven through its `openclaw cron` CLI (crons.ts). Three parts:
 *
 *  - `tasks` (tasks.ts): the Schedule tab's list, a new task, an edit, on
 *    or off, run now, its runs, delete, the template tasks still waiting, and
 *    a task told on the owner's phone when it runs;
 *  - `sweeps` (sweeps.ts): the passes that point tasks with no recipient
 *    where their results go, keep each config's command owner, time zone and
 *    file ceilings, and tell the owner of a finished run they asked about
 *    (taskNotes.ts, beside this), with their three timers;
 *  - `triggers` (triggers.ts): the permission to run event-triggered tasks,
 *    written to the running agent.
 *
 * Built once per process (`registerRoutes` in src/api/routes.ts) and handed
 * to the route file on the shared context (`ctx.schedules`); PATCH
 * /v1/agents/:id, still in the registry, calls `triggers`. `stop()` ends the
 * sweeps' timers. Nothing here knows about HTTP: who may ask, whether the
 * agent is running and free, and the words of an answer are the route
 * file's (src/api/scheduleRoutes.ts). A template's tasks parked at import
 * are provision.ts's (`applyPendingSchedules`); `tasks` only lists them and
 * tries them again.
 */
export interface Schedules {
  tasks: ScheduledTasks;
  sweeps: TaskSweeps;
  triggers: CronTriggers;
  stop(): void;
}

/** Why not: `not-found` (404), `conflict` (409), `failed` (502: OpenClaw said no), each with its words. */
export type ScheduleRefusal = { refused: 'not-found' | 'conflict' | 'failed'; error: string };

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export interface SchedulesDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** Deleted or being deleted: nothing more is stored for it. */
  agentGone: (id: string) => boolean;
  /** Keep a change for the agent's next start or wake, which is then a rebuild. Returns the stamp. */
  oweRebuild: (agentId: string) => string;
  /** Whether a task's note has a way to its owner (their Hatchabot agent's Telegram bot or Discord). */
  noteReach: (ownerId: string) => boolean;
  /** The task notes' push: the Hatchabot agent's bot, with a budget of its own (TASK_NOTES_PER_HOUR). */
  taskNotePush: Pick<OpsPush, 'waiting'>;
  /** This Hatchabot's address, for the link in a task's note; undefined when it has none. */
  appUrl: () => string | undefined;
  /** The per-app file ceiling written to one of the agent's chat apps (the full pass backfills it). */
  applyFilesCap: (a: Agent, kind: ChannelKindForFiles) => Promise<{ applied: number }>;
  /** The adopts still waiting for their agent's gateway: the quick pass gives them their turn first. */
  finishDeferredAdopts: () => Promise<void>;
  /** A line to the server's log for a pass that failed. */
  warn: (detail: Record<string, unknown>, msg: string) => void;
  /** Start the sweeps' timers (off in tests, as they always were). */
  sweepsOn: boolean;
}

export function createSchedules(deps: SchedulesDeps): Schedules {
  const sweeps = createTaskSweeps(deps);
  return {
    tasks: createScheduledTasks(deps),
    sweeps,
    triggers: createCronTriggers(deps),
    stop: () => sweeps.stop(),
  };
}
