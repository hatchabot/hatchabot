import type { ChannelKindForFiles } from '../../domain/filesLimit.js';
import type { Agent } from '../../domain/types.js';
import { isBusy } from '../lifecycle/busy.js';
import { CRON_QUICK_CHECK_MS, cronTargetFor, readCronStore, retargetDue, retargetImplicitCrons, type Cron } from './crons.js';
import { commandOwnersFor } from '../lifecycle/provision.js';
import { agentTimeZone } from './timezone.js';
import type { SchedulesDeps } from './schedules.js';
import { dueTaskNotes, taskNoteText } from './taskNotes.js';

/**
 * The passes over every running agent's tasks (HB-0808): the full pass after
 * a start and daily (`retargetCronSweep`), and the quick one every
 * CRON_QUICK_CHECK_MS (`quickCronRetarget`), which also tells the owner of
 * each finished run they asked about (`noteFinishedTasks`). Each starts on a
 * timer of its own, off in tests (`sweepsOn`); `stop()` ends them. Both are
 * safe off a timer: a database or gateway that fails is tried next time.
 */
export interface TaskSweeps {
  retargetCronSweep(): Promise<void>;
  quickCronRetarget(): Promise<void>;
  stop(): void;
}

export function createTaskSweeps(deps: SchedulesDeps): TaskSweeps {
  const { store, providerFor, trace, taskNotePush, applyFilesCap, finishDeferredAdopts, warn } = deps;

  /**
   * The chat apps an agent is in now: a task naming another is re-pointed
   * (HB-0401). Not while tasks are still being adopted: the next try compares
   * recipients to tell what was already brought over, and would add it twice.
   */
  const attachedApps = (agentId: string) => (store.listAdoptPending().some((r) => r.agentId === agentId) ? undefined : store.listChannelsForAgent(agentId).map((c) => c.kind));
  /** A slow schedule read may outlive an ownership, runtime or runner change. */
  const cronReadContext = (a: Agent) => {
    const provider = providerFor(a.hostId);
    const hostKey = () => {
      const h = store.getHost(a.hostId);
      return JSON.stringify([h?.ownerId, h?.provider, h?.kind, h?.settings]);
    };
    const host = hostKey();
    const current = () => {
      try {
        const now = store.getAgent(a.id);
        return !!now && now.ownerId === a.ownerId && now.hostId === a.hostId && now.slug === a.slug
          && now.runtimeRef === a.runtimeRef && now.state === 'RUNNING' && !isBusy(a.id)
          && hostKey() === host && providerFor(a.hostId) === provider;
      } catch { return false; }
    };
    return { provider, current };
  };
  /** One agent's tasks with no recipient pointed where its results go (crons.ts retargetImplicitCrons). */
  const retargetAgentCrons = async (a: Agent & { runtimeRef: string }, why: 'sweep' | 'quick') => {
    const context = cronReadContext(a);
    if (!context.current()) return;
    const held = store.quietedCrons(a.id);
    const target = cronTargetFor(store, a), attached = attachedApps(a.id);
    const destination = JSON.stringify([target, attached]);
    const current = () => context.current() && JSON.stringify([cronTargetFor(store, a), attachedApps(a.id)]) === destination;
    // A task about to be made quiet is remembered first (HB-1086): a pass
    // cut off after the write (the owner's first message changed where
    // results go, or a restart) used to forget it, and it stayed quiet.
    const marked: string[] = [];
    const willQuiet = (jobId: string) => { marked.push(jobId); store.addQuietedCron(a.id, jobId, new Date().toISOString()); };
    const r = await retargetImplicitCrons(context.provider, a.runtimeRef, a.slug, target, held, attached, current, willQuiet);
    if (!current()) return;
    if (held.length || r.held.length || marked.length) store.setQuietedCrons(a.id, r.held, new Date().toISOString(), [...held, ...marked]);
    if (r.changed || r.failed) trace(a.id)('cron.retargeted', { changed: r.changed, failed: r.failed, ...(r.held.length ? { waiting: r.held.length } : {}), ...(why === 'quick' ? { quick: true } : {}) });
  };
  /**
   * Scheduled tasks that announce to no one in particular get the owner's chat
   * as their recipient, or the console conversation of an agent in no chat app
   * (quiet when neither is possible): OpenClaw 2026.9 refuses implicit
   * delivery, so they ran daily and reached nobody.
   * Agents create such tasks themselves too, so this runs after each start and
   * then daily, one agent at a time (promise review, 2026-09-29). The same pass
   * keeps the command owner and the per-app file ceilings in each config.
   */
  const retargetCronSweep = async () => {
    // Off a timer: a database that fails here must not end the process.
    let agents: Agent[];
    try { agents = store.listAllActiveAgents(); }
    catch (err) { warn({ err: String(err) }, 'cron.sweep_failed'); return; }
    for (const a of agents) {
      if (a.state !== 'RUNNING' || !a.runtimeRef || isBusy(a.id)) continue;
      let context: ReturnType<typeof cronReadContext>;
      try { context = cronReadContext(a); } catch { continue; }
      try {
        await retargetAgentCrons(a as Agent & { runtimeRef: string }, 'sweep');
      } catch { /* its gateway is not answering: next time */ }
      if (!context.current()) continue;
      // The owner is OpenClaw's command owner, live (hot-reloaded): an agent
      // built before this left the key empty, and the next person approved
      // would have become the owner (2026-09-29).
      try {
        const read = await context.provider.execShell(a.runtimeRef,
          `node -e 'const c=JSON.parse(require("fs").readFileSync("/home/node/.openclaw/openclaw.json","utf8"));process.stdout.write(JSON.stringify((c.commands&&c.commands.ownerAllowFrom)||[]))'`);
        if (!context.current()) continue;
        const want = JSON.stringify(commandOwnersFor(store, a));
        if (read.code === 0 && read.stdout.trim() !== want) {
          const set = await context.provider.exec(a.runtimeRef, ['config', 'set', 'commands.ownerAllowFrom', want, '--strict-json']);
          if (!context.current()) continue;
          trace(a.id)('owner.command_owner_set', { ok: set.code === 0, had: (JSON.parse(read.stdout || '[]') as unknown[]).length });
        }
      } catch { /* next time */ }
      // Its time zone, live (timezone.ts): agents built before it, or after the
      // setting changed, ran on the container's UTC (2026-10-07).
      try {
        if (!context.current()) continue;
        const read = await context.provider.execShell(a.runtimeRef,
          `node -e 'const c=JSON.parse(require("fs").readFileSync("/home/node/.openclaw/openclaw.json","utf8"));process.stdout.write(String(((c.agents||{}).defaults||{}).userTimezone||""))'`);
        if (!context.current()) continue;
        const want = agentTimeZone();
        if (read.code === 0 && read.stdout.trim() !== want) {
          const set = await context.provider.exec(a.runtimeRef, ['config', 'set', 'agents.defaults.userTimezone', want]);
          if (!context.current()) continue;
          trace(a.id)('timezone.set', { ok: set.code === 0, was: read.stdout.trim() || null, now: want });
        }
      } catch { /* next time */ }
      // The per-app file ceiling reached OpenClaw only at a build or when
      // changed, so agents built before it ran with OpenClaw's own 100 MB
      // (32 of 35 Telegram agents on the Spark, 2026-09-30). Set it on any app
      // whose config section lacks it — once: afterwards the key is there.
      try {
        if (!context.current()) continue;
        const kinds = [...new Set(store.listChannelsForAgent(a.id).map((c) => c.kind))]
          .filter((k): k is ChannelKindForFiles => k === 'telegram' || k === 'discord' || k === 'slack');
        if (kinds.length) {
          const read = await context.provider.execShell(a.runtimeRef,
            `node -e 'const c=JSON.parse(require("fs").readFileSync("/home/node/.openclaw/openclaw.json","utf8")).channels||{};process.stdout.write(JSON.stringify(process.argv.slice(1).filter(k=>c[k]&&typeof c[k]==="object"&&c[k].mediaMaxMb===undefined)))' ${kinds.join(' ')}`);
          if (!context.current()) continue;
          const missing = read.code === 0 ? (JSON.parse(read.stdout || '[]') as ChannelKindForFiles[]).filter((k) => kinds.includes(k)) : [];
          for (const kind of missing) {
            if (!context.current()) break;
            const { applied } = await applyFilesCap(a, kind);
            trace(a.id)('files.cap_backfilled', { kind, ok: applied > 0 });
          }
        }
      } catch { /* next time */ }
    }
  };
  /**
   * Tell the owner, on their phone, of each finished run of a task they asked
   * about (HB-0537, taskNotes.ts), from the quick pass's read of the store.
   * Each run is marked told before the note goes, so a slow or failed send
   * never tells it twice; the notes have their own hourly budget.
   */
  const noteFinishedTasks = async (a: Agent, jobs: Cron[], current: () => boolean) => {
    if (!current()) return;
    const settings = store.cronNotes(a.id);
    if (!settings.length) return;
    const { due, seen, gone } = dueTaskNotes(settings, jobs);
    for (const id of gone) store.setCronNote(a.id, id, false, 0);
    const dueIds = new Set(due.map((d) => d.jobId));
    for (const s of seen) if (!dueIds.has(s.jobId)) store.markCronNoted(a.id, s.jobId, s.runMs);
    const base = deps.appUrl();
    for (const d of due) {
      if (!current()) return;
      const setting = settings.find((s) => s.jobId === d.jobId)!;
      let claimed = false;
      const beforeSend = () => {
        if (!current()) return false;
        const now = store.cronNotes(a.id).find((s) => s.jobId === d.jobId);
        if (!now || now.sinceMs !== setting.sinceMs || (!claimed && (now.seenRunMs ?? now.sinceMs) >= d.runAtMs)) return false;
        if (!claimed) { store.markCronNoted(a.id, d.jobId, d.runAtMs); claimed = true; }
        return true;
      };
      const { headline, tail } = taskNoteText({
        agent: a.name, task: d.name, status: d.status, runAtMs: d.runAtMs, now: Date.now(),
        ...(base ? { link: `${base}/#console=${encodeURIComponent(a.slug)}` } : {}),
      });
      const told = await taskNotePush.waiting(a.ownerId, headline, undefined, { note: true, tail, beforeSend }).catch(() => false);
      if (!current()) return;
      // No destination or budget: still consumed as before, but only if the
      // same owner and setting remain after asynchronous delivery preparation.
      if (!claimed && !beforeSend()) continue;
      trace(a.id)('cron.noted', { task: d.name, status: d.status, told });
    }
  };
  /**
   * The quick check between full passes, every CRON_QUICK_CHECK_MS: a task an
   * agent made in its chat (an 8am summary asked for in the web chat at
   * night) fired before the next daily pass re-pointed it, and its result
   * reached no one (2026-10-12). Per running agent it reads the task store
   * once (readCronStore, ~65 ms) and starts the CLI only when a task needs
   * changing. Tasks a pass could not change are not tried again until they
   * change: the signature of what was due is kept per agent. It first gives
   * the adopts still waiting for their agent their turn (finishDeferredAdopts).
   */
  const quickTried = new Map<string, string>();
  let quickRunning = false;
  const quickCronRetarget = async () => {
    if (quickRunning) return;
    quickRunning = true;
    try {
      try { await finishDeferredAdopts(); } catch { /* next time */ }
      let agents: Agent[];
      let noting: Set<string>;
      try { agents = store.listAllActiveAgents(); noting = store.agentsWithCronNotes(); }
      catch (err) { warn({ err: String(err) }, 'cron.sweep_failed'); return; }
      for (const a of agents) {
        if (a.state !== 'RUNNING' || !a.runtimeRef || isBusy(a.id)) { quickTried.delete(a.id); continue; }
        try {
          // One read of its task store serves both: the runs to tell, and the tasks to re-point.
          const context = cronReadContext(a);
          const read = await readCronStore(context.provider, a.runtimeRef, a.slug);
          if (!context.current()) { quickTried.delete(a.id); continue; }
          if (read && noting.has(a.id)) {
            try { await noteFinishedTasks(a, read.jobs, context.current); }
            catch (err) { warn({ agent: a.id, err: String(err) }, 'cron.note_failed'); }
          }
          if (!context.current()) { quickTried.delete(a.id); continue; }
          const due = read && retargetDue(read, cronTargetFor(store, a), store.quietedCrons(a.id), attachedApps(a.id));
          if (!due?.ids.length) { quickTried.delete(a.id); continue; }
          if (quickTried.get(a.id) === due.sig) continue;
          quickTried.set(a.id, due.sig);
          await retargetAgentCrons(a as Agent & { runtimeRef: string }, 'quick');
        } catch { /* its gateway is not answering: next time */ }
      }
    } finally {
      quickRunning = false;
    }
  };

  // The full pass three minutes after the start and then daily; the quick
  // pass every CRON_QUICK_CHECK_MS. Off in tests, as they always were.
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  const intervals: ReturnType<typeof setInterval>[] = [];
  if (deps.sweepsOn) {
    timeouts.push(setTimeout(() => { void retargetCronSweep(); }, 3 * 60_000).unref());
    intervals.push(setInterval(() => { void retargetCronSweep(); }, 24 * 3_600_000).unref());
    intervals.push(setInterval(() => { void quickCronRetarget(); }, CRON_QUICK_CHECK_MS).unref());
  }

  return {
    retargetCronSweep,
    quickCronRetarget,
    stop: () => {
      for (const t of timeouts) clearTimeout(t);
      for (const t of intervals) clearInterval(t);
    },
  };
}
