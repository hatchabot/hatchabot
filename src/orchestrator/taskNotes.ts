/**
 * A note on the owner's phone when a scheduled task has run (HB-0537).
 *
 * An agent in no chat app writes a task's result into its console
 * conversation (crons.ts cronTargetFor) and the home screen shows its red dot;
 * nothing reached the phone. A task the owner ticks "Tell me on Telegram when
 * it runs" for gets a short note from their Hatchabot agent's bot each time it
 * has run: the task, the agent, and a link that opens the agent. Never the
 * result itself, so the report stays out of Telegram's cloud.
 *
 * The runs are seen by the quick pass (routes.ts quickCronRetarget, every
 * CRON_QUICK_CHECK_MS) in the read of the task store it already makes
 * (crons.ts readCronStore): a task's `lastRunAtMs` newer than the last one
 * told is a run to tell. The setting is Hatchabot's (store `cron_notes`), not
 * the task's, so OpenClaw's own task is never changed for it.
 */
import type { Cron } from './crons.js';

/** A task the owner asked to be told about: since when, and the run last told. */
export interface TaskNoteSetting { jobId: string; sinceMs: number; seenRunMs?: number }

export interface TaskNoteDue { jobId: string; name: string; status: 'ok' | 'error'; runAtMs: number }

/** At most this many task notes per owner an hour, apart from the alerts' own budget (push.ts PushBudget). */
export const TASK_NOTES_PER_HOUR = 10;

/**
 * Which of these tasks have a finished run not told yet. `seen`: the run each
 * one has now been looked at for, told or not (a skipped run is not news, and
 * is not looked at again). `gone`: settings whose task is no longer there, or
 * is OpenClaw's own (only when the list holds any task at all: an empty read
 * forgets nothing).
 */
export function dueTaskNotes(settings: readonly TaskNoteSetting[], jobs: readonly Cron[]): {
  due: TaskNoteDue[];
  seen: Array<{ jobId: string; runMs: number }>;
  gone: string[];
} {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const due: TaskNoteDue[] = [], seen: Array<{ jobId: string; runMs: number }> = [], gone: string[] = [];
  for (const s of settings) {
    const job = byId.get(s.jobId);
    if (!job || job.system) { if (jobs.length) gone.push(s.jobId); continue; }
    const last = job.lastRunAtMs;
    // A run that started before the setting was turned on is not one it asked about.
    if (last === undefined || last <= (s.seenRunMs ?? s.sinceMs)) continue;
    seen.push({ jobId: s.jobId, runMs: last });
    if (job.lastStatus === 'ok' || job.lastStatus === 'error') {
      due.push({ jobId: s.jobId, name: job.name?.trim() || 'A scheduled task', status: job.lastStatus, runAtMs: last });
    }
  }
  return { due, seen, gone };
}

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function agoText(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 90) return `${min} minutes ago`;
  const h = Math.round(min / 60);
  return h < 36 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`;
}

/**
 * The note: which task, from which agent, and whether it worked; then where
 * to read it. A run seen late (the agent asleep, the app down) says when it
 * ran, as a time ago: the machine's clock zone need not be the owner's.
 */
export function taskNoteText(o: { agent: string; task: string; status: 'ok' | 'error'; runAtMs: number; now: number; link?: string }): { headline: string; tail: string } {
  const task = `"${cap(o.task.replace(/\s+/g, ' ').trim(), 80)}"`, agent = cap(o.agent.replace(/\s+/g, ' ').trim(), 60);
  const late = o.now - o.runAtMs > 15 * 60_000 ? ` (it ran ${agoText(o.now - o.runAtMs)})` : '';
  const headline = o.status === 'ok' ? `${task} from ${agent} has run${late}.` : `${task} from ${agent} ran, but failed${late}.`;
  const verb = o.status === 'ok' ? 'Read it' : 'See what went wrong';
  return { headline, tail: o.link ? `${verb} in Hatchabot: ${o.link}` : `${verb} in the Hatchabot app.` };
}
