import type { Agent } from '../../domain/types.js';
import { whileBusy } from '../lifecycle/busy.js';
import { CronSystemOwnedError, addCron, cronTargetFor, deleteCron, editCron, listCronRuns, listCrons, runCronNow, setCronEnabled, type Cron } from './crons.js';
import { retryPendingSchedules } from '../lifecycle/provision.js';
import type { ScheduleRefusal, SchedulesDeps } from './schedules.js';

/** An edit's write found the agent on another runtime than the one its task was read from (HB-0906). */
const REPLACED = Symbol('runtime replaced');

/** A template task not added yet, and why (HB-0231). */
export interface WaitingTask { name: string; message: string; cron?: string; everyMs?: number; tz?: string; why: string | null }

/** A new task, as the route's schema read it. */
export interface NewTask {
  name: string;
  message: string;
  cron?: string;
  everyMinutes?: number;
  tz?: string;
  announce?: boolean;
  notify?: boolean;
}

/** What an edit changes (each field left out is kept). */
export interface TaskEdit { name?: string; message?: string; cron?: string; everyMinutes?: number; tz?: string }

/**
 * One agent's scheduled tasks, as its Schedule tab and the CLI's `tasks`
 * change them (HB-0808). Every one is asked of a RUNNING agent that is not
 * busy: the route has checked both (`runningAgent`, `busyNow`) before it
 * calls. A change takes the agent's busy flag while it runs (`whileBusy`:
 * AgentBusyError when something else took it meanwhile), and is thrown on to
 * the route, as CronSystemOwnedError is for OpenClaw's own tasks.
 */
export interface ScheduledTasks {
  /** Its tasks, the template tasks still waiting, the ones told on the owner's phone, and whether a note can reach them. Throws when the tasks cannot be read. */
  list(agent: Agent): Promise<{ crons: Cron[]; waiting: WaitingTask[]; notes: string[]; noteReach: boolean }>;
  /** The template tasks still waiting, tried again now; what still waits. */
  retryWaiting(agent: Agent): Promise<{ waiting: WaitingTask[] }>;
  /** A new task, pointed where its results go. Its id, and whether it is told on the phone. */
  add(agent: Agent, task: NewTask): Promise<ScheduleRefusal | { id?: string; noted: boolean }>;
  /** Told on the owner's phone when it runs, or not (HB-0537): Hatchabot's own setting; the task is not touched. */
  setNote(agent: Agent, jobId: string, on: boolean): void;
  /**
   * A task changed in place, and switched on or off with it (`turn`), its
   * note kept once the rest took (`notify`, HB-0559).
   */
  edit(agent: Agent, jobId: string, change: TaskEdit, turn?: boolean, notify?: boolean): Promise<ScheduleRefusal | { ok: true; edited: boolean; enabled?: boolean }>;
  /** On or off, and its note kept once that took. False when OpenClaw would not. */
  setEnabled(agent: Agent, jobId: string, enabled: boolean, notify?: boolean): Promise<boolean>;
  /** Run it now; its output goes the task's own way. False when OpenClaw would not. */
  runNow(agent: Agent, jobId: string): Promise<boolean>;
  /** Its recent runs. Throws when they cannot be read. */
  runs(agent: Agent, jobId: string, limit: number): ReturnType<typeof listCronRuns>;
  /** Deleted, and its note forgotten. False when OpenClaw would not. */
  remove(agent: Agent, jobId: string): Promise<boolean>;
}

// Crons live in the agent's own OpenClaw gateway store on its durable volume
// (they survive rebuilds like MEMORY.md). We drive them through the
// in-container `openclaw cron` CLI — never the store directly — exactly as
// sessions/pairing do. The gateway must be up, so every route needs RUNNING.
export function createScheduledTasks(deps: SchedulesDeps): ScheduledTasks {
  const { store, providerFor, trace } = deps;

  /** Template tasks not added yet, and why (HB-0231): the Tasks list shows them. */
  const waitingTasks = (agentId: string) => store.getPendingSchedules(agentId).map((t) => ({
    name: t.name, message: t.message, cron: t.cron, everyMs: t.everyMs, tz: t.tz, why: t.why ?? null,
  }));

  const setNote = (agent: Agent, jobId: string, on: boolean) => {
    store.setCronNote(agent.id, jobId, on, Date.now());
    trace(agent.id)('cron.note_set', { id: jobId, on });
  };

  return {
    list: async (agent) => ({
      crons: await listCrons(providerFor(agent.hostId), agent.runtimeRef!, agent.slug),
      waiting: waitingTasks(agent.id),
      // The tasks told on the owner's phone when they run, and whether a note can reach them (HB-0537).
      notes: store.cronNotes(agent.id).map((n) => n.jobId),
      noteReach: deps.noteReach(agent.ownerId),
    }),

    // Template tasks still waiting (a gateway that refused them at setup): try
    // again now, rather than at the next start, wake or rebuild (HB-0231).
    retryWaiting: async (agent) => {
      await retryPendingSchedules({ store, provider: providerFor(agent.hostId) }, agent.id, trace(agent.id));
      return { waiting: waitingTasks(agent.id) };
    },

    // The missing verb (audit backlog: "no interface creates a cron"): a
    // definition can DESCRIBE a schedule, but only a real gateway cron fires.
    add: async (agent, task) => {
      const out = await whileBusy(agent.id, () => addCron(providerFor(agent.hostId), agent.runtimeRef!, agent.slug, {
        name: task.name,
        message: task.message,
        cron: task.cron,
        everyMs: task.everyMinutes ? Math.round(task.everyMinutes * 60_000) : undefined,
        tz: task.tz,
        // The owner's chat, or — an agent in no chat app — its console
        // conversation. With neither (older OpenClaw, owner's id unknown) the
        // task is quiet and its runs are read with `tasks … runs`.
        announce: task.announce !== false,
        deliverTo: cronTargetFor(store, agent),
      }));
      if (!out.ok) return { refused: 'failed', error: out.error };
      // Quiet only until the owner can be reached: the repair pass points it at them then.
      if (out.quieted && out.id) store.addQuietedCron(agent.id, out.id, new Date().toISOString());
      trace(agent.id)('cron.created', { name: task.name, cron: task.cron, everyMinutes: task.everyMinutes });
      // Told on the phone when it runs (HB-0537): only with the new task's id to keep it under.
      const noted = task.notify === true && !!out.id;
      if (noted) store.setCronNote(agent.id, out.id!, true, Date.now());
      return { id: out.id, noted };
    },

    setNote,

    // An edit patches only what changed: re-creating the task gave it the
    // owner's chat as its recipient, so one bound to a member's chat or a group
    // started posting to the owner instead.
    edit: async (agent, jobId, fields, turn, notify) => {
      // Kept once the rest of the request took, not before: an edit refused
      // or failed still turned the note on or off (HB-0559).
      const keepNote = () => {
        if (typeof notify !== 'boolean') return;
        setNote(agent, jobId, notify);
      };
      const provider = providerFor(agent.hostId);
      // Only a task of this agent's, and only one that carries a message:
      // a --message on a shell-command task would turn it into a prompt.
      const job = (await listCrons(provider, agent.runtimeRef!, agent.slug).catch(() => undefined))?.find((c) => c.id === jobId);
      if (!job) return { refused: 'not-found', error: 'That task no longer exists.' };
      if (job.system) return { refused: 'conflict', error: new CronSystemOwnedError().userMessage };
      if (job.payloadKind === 'command') return { refused: 'conflict', error: 'Shell-command tasks are edited by asking the agent.' };
      // A blank zone clears the task's own zone (HB-0366); on a task with
      // none it changes nothing, and a request with nothing else is done.
      const tz = fields.tz === '' && !job.scheduleTz ? undefined : fields.tz;
      const change = {
        name: fields.name,
        message: fields.message,
        cron: fields.cron,
        everyMs: fields.everyMinutes ? Math.round(fields.everyMinutes * 60_000) : undefined,
        tz,
      };
      const edited = Object.values(change).some((v) => v !== undefined);
      // Each write goes to the runtime the task was read from, and only while
      // that is still the agent's. A move to another machine or a restore
      // from a copy holds the busy flag while it gives the agent another
      // runtime, so one that finished during the list read is seen here, once
      // the flag is ours: the write went to the retired runtime instead
      // (HB-0906). A rebuild in place keeps its runtime's name, and its tasks
      // are on the volume: the write goes to it as before.
      const onTheRuntimeRead = <T>(write: () => Promise<T>) => whileBusy(agent.id, async (): Promise<T | typeof REPLACED> => {
        const now = store.getAgent(agent.id);
        return now && now.hostId === agent.hostId && now.runtimeRef === agent.runtimeRef ? write() : REPLACED;
      });
      const replaced: ScheduleRefusal = { refused: 'conflict', error: 'The agent was moved to another machine or replaced from a copy while its tasks were being read, so nothing was changed. Open its tasks again and make the change once more.' };
      // The edit took and stays, whatever then happens to the switch: its note goes with it.
      let editTook = false;
      try {
        if (edited) {
          const out = await onTheRuntimeRead(() => editCron(provider, agent.runtimeRef!, job.id, change, job));
          if (out === REPLACED) return replaced;
          if (!out.ok) return { refused: 'failed', error: out.error };
          editTook = true;
          trace(agent.id)('cron.edited', { id: job.id, name: fields.name ?? job.name, fields: Object.keys(fields) });
        }
        if (turn === undefined) { keepNote(); return { ok: true, edited }; }
        const switched = await onTheRuntimeRead(() => setCronEnabled(provider, agent.runtimeRef!, job.id, turn));
        if (switched === REPLACED && !editTook) return replaced;
        if (switched !== true) {
          if (editTook) keepNote();
          return { refused: 'failed', error: `The task ${edited ? 'was changed, but ' : ''}couldn't be ${turn ? 'enabled' : 'disabled'} — try that again.` };
        }
        keepNote();
        return { ok: true, edited, enabled: turn };
      } catch (err) {
        // Busy by then, or the switch threw: the edit still took.
        if (editTook) keepNote();
        throw err;
      }
    },

    setEnabled: async (agent, jobId, enabled, notify) => {
      const ok = await whileBusy(agent.id, () =>
        setCronEnabled(providerFor(agent.hostId), agent.runtimeRef!, jobId, enabled),
      );
      if (!ok) return false;
      if (typeof notify === 'boolean') setNote(agent, jobId, notify);
      return true;
    },

    // Fire a task now ("test fire"). Its output is delivered the task's own way
    // (e.g. a Telegram announce), so this only reports that it was triggered.
    runNow: (agent, jobId) => whileBusy(agent.id, () =>
      runCronNow(providerFor(agent.hostId), agent.runtimeRef!, jobId),
    ),

    // A task's recent runs — what it produced, whether it arrived. The list
    // says when a task last ran; only this says what it did.
    runs: (agent, jobId, limit) => listCronRuns(providerFor(agent.hostId), agent.runtimeRef!, jobId, limit),

    remove: async (agent, jobId) => {
      const ok = await whileBusy(agent.id, () =>
        deleteCron(providerFor(agent.hostId), agent.runtimeRef!, jobId),
      );
      if (ok) store.setCronNote(agent.id, jobId, false, 0);
      return ok;
    },
  };
}
