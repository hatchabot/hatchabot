import type { RuntimeProvider } from '../providers/provider.js';
import type { Store } from '../store/store.js';

/**
 * An agent's scheduled tasks ("crons") live in its own OpenClaw gateway store on
 * the durable volume — they survive rebuilds like MEMORY.md, and each managed
 * agent has its own container, so its cron store is naturally scoped to it.
 *
 * We drive them entirely through the in-container `openclaw cron` CLI via
 * `provider.exec` — never the SQLite store directly — exactly as sessions and
 * pairing do. The gateway owns write semantics and scheduler reload; the raw
 * `cron_jobs` columns are denormalized and volatile, the CLI is the stable
 * contract.
 */
export interface Cron {
  id: string;
  name?: string;
  /** Declared by OpenClaw itself (its weekly skill review, memory dreaming, the
   *  heartbeat): shown, never editable or deletable — the gateway refuses
   *  ("system-owned monitor jobs cannot be removed by cron clients", 2026.9). */
  system?: boolean;
  description?: string;
  enabled: boolean;
  /** 'cron' | 'every' | 'at'. */
  scheduleKind?: string;
  /** For kind 'cron': the 5/6-field expression. */
  scheduleExpr?: string;
  scheduleTz?: string;
  /** For kind 'every': interval in ms. */
  everyMs?: number;
  /** For kind 'at': the one-shot time in ms. */
  atMs?: number;
  /** 'agentTurn' (a prompt fired at the agent) | 'command' (a gateway shell). */
  payloadKind?: string;
  /** The prompt (agentTurn) or command (command), for a preview. */
  message?: string;
  /** What the scheduler knows about its runs — without these nothing could
   *  tell a task that fires from one that silently never does. */
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  /** 'ok' | 'error' | 'skipped' … as the gateway reports it. */
  lastStatus?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
  lastDelivered?: boolean;
  /** Whether a run's result goes to the agent's chat (the gateway's delivery.mode, "none" = quiet). Undefined when the job says nothing. */
  announce?: boolean;
  /** Announcing with no explicit recipient ("last", or no `to`): OpenClaw
   *  2026.9 refuses to deliver those, so the result reaches nobody. */
  implicitDelivery?: boolean;
}

/** One past run of a task: what the agent produced, and whether it arrived. */
export interface CronRun {
  runAtMs: number;
  status: string;
  summary?: string;
  error?: string;
  durationMs?: number;
  delivered?: boolean;
  model?: string;
}

function normalizeCron(j: Record<string, any>): Cron {
  const s = (j.schedule ?? {}) as Record<string, any>;
  const p = (j.payload ?? {}) as Record<string, any>;
  return {
    id: String(j.id),
    name: typeof j.displayName === 'string' ? j.displayName : typeof j.name === 'string' ? j.name : undefined,
    system: typeof j.declarationKey === 'string' && j.declarationKey.length > 0,
    description: typeof j.description === 'string' ? j.description : undefined,
    enabled: !!j.enabled,
    scheduleKind: s.kind,
    scheduleExpr: s.expr,
    scheduleTz: s.tz,
    // The gateway's JSON is camelCase ({kind:'every', everyMs, anchorMs} /
    // {kind:'at', at}); the snake_case reads never matched, so interval jobs
    // showed no interval and couldn't be edited (2026-09-11).
    everyMs: typeof s.everyMs === 'number' ? s.everyMs : typeof s.every_ms === 'number' ? s.every_ms : undefined,
    atMs: typeof s.at === 'number' ? s.at : typeof s.atMs === 'number' ? s.atMs : typeof s.at_ms === 'number' ? s.at_ms : undefined,
    payloadKind: p.kind,
    // Read so an edit can keep it: the app's edit re-creates the task, and a
    // quiet one came back announcing (night review, 2026-09-27).
    announce: typeof j.delivery?.mode === 'string' ? j.delivery.mode !== 'none' : undefined,
    implicitDelivery: typeof j.delivery?.mode === 'string' && j.delivery.mode !== 'none'
      && (!j.delivery.channel || j.delivery.channel === 'last' || !j.delivery.to),
    message:
      typeof p.message === 'string' ? p.message
      : typeof p.command === 'string' ? p.command
      : typeof p.shell === 'string' ? p.shell
      : undefined,
    ...cronState(j),
  };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The scheduler's run state, read from `state` with the top-level mirrors as fallback. */
function cronState(j: Record<string, any>): Partial<Cron> {
  const st = (j.state ?? {}) as Record<string, any>;
  const status = st.lastRunStatus ?? st.lastStatus ?? j.lastRunStatus;
  const delivered = st.lastDelivered ?? j.lastDelivered;
  return {
    nextRunAtMs: num(st.nextRunAtMs) ?? num(j.nextRunAtMs),
    lastRunAtMs: num(st.lastRunAtMs) ?? num(j.lastRunAtMs),
    lastStatus: typeof status === 'string' ? status : undefined,
    lastDurationMs: num(st.lastDurationMs),
    consecutiveErrors: num(st.consecutiveErrors),
    lastDelivered: typeof delivered === 'boolean' ? delivered : undefined,
  };
}

/** A task's recent runs, newest first — the only record of what it actually did. */
export async function listCronRuns(
  provider: RuntimeProvider,
  runtimeRef: string,
  jobId: string,
  limit = 10,
): Promise<CronRun[]> {
  const res = await provider.exec(runtimeRef, ['cron', 'runs', '--id', jobId, '--limit', String(Math.min(Math.max(limit, 1), 50))]);
  if (res.code !== 0) return [];
  try {
    const body = res.stdout.slice(res.stdout.indexOf('{'));
    const entries = JSON.parse(body).entries;
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((e: any) => e && (e.action === undefined || e.action === 'finished'))
      .map((e: any): CronRun => ({
        runAtMs: num(e.runAtMs) ?? num(e.ts) ?? 0,
        status: String(e.status ?? 'unknown'),
        summary: typeof e.summary === 'string' ? e.summary.slice(0, 4000) : undefined,
        error: typeof e.error === 'string' ? e.error.slice(0, 1000) : undefined,
        durationMs: num(e.durationMs),
        delivered: typeof e.delivered === 'boolean' ? e.delivered : undefined,
        model: typeof e.model === 'string' ? e.model : undefined,
      }))
      .sort((a: CronRun, b: CronRun) => b.runAtMs - a.runAtMs);
  } catch {
    return [];
  }
}

/**
 * List the agent's scheduled tasks, including disabled ones. Throws when the
 * list could not be read: it used to return [] then, so a gateway that
 * hiccuped for a moment made the app and CLI say "no scheduled tasks" to
 * someone whose tasks were fine (seen in the clean-VM regression, 2026-09-23).
 * Callers that want "nothing" on failure say so with .catch(() => []).
 */
export async function listCrons(
  provider: RuntimeProvider,
  runtimeRef: string,
  slug: string,
): Promise<Cron[]> {
  const res = await provider.exec(runtimeRef, ['cron', 'list', '--agent', slug, '--all', '--json']);
  if (res.code !== 0) throw new Error(`cron list failed (${res.code}): ${(res.stderr || res.stdout).slice(0, 200)}`);
  let jobs: unknown;
  try {
    jobs = JSON.parse(res.stdout).jobs;
  } catch {
    throw new Error('cron list returned something other than JSON');
  }
  return Array.isArray(jobs) ? jobs.map(normalizeCron) : [];
}

export interface AddCronOptions {
  name: string;
  /** The prompt fired at the agent when the schedule triggers. */
  message: string;
  /** 5/6-field cron expression, e.g. "0 8 * * 1-5". Exactly one of cron/everyMs. */
  cron?: string;
  everyMs?: number;
  /** IANA tz the expression is evaluated in, e.g. "America/New_York". */
  tz?: string;
  /** Deliver the run's final text to the agent's chat (what a scheduled
   *  briefing is FOR — default true). */
  announce?: boolean;
  /** Where to deliver it. Required to announce: 2026.9 refuses a delivery
   *  that names no channel and recipient, so without one the task is quiet. */
  deliverTo?: CronTarget;
}

/** Where a task's result goes: a chat app and the recipient on it. */
export interface CronTarget { channel: 'telegram' | 'discord' | 'slack'; to: string }

/**
 * The owner's own chat with the agent, on the first app where both exist:
 * the agent's bot and the owner's id there. Undefined = nowhere to post, so
 * tasks stay quiet (their runs are read in the app). Scheduled results went
 * to "whoever chatted last" before 2026.9; 2026.9 refuses that ("Refusing
 * implicit isolated cron delivery … set delivery.channel and delivery.to"),
 * and every app-made task stopped arriving (promise review, 2026-09-29).
 */
export function cronTargetFor(store: Store, agent: { id: string; ownerId: string }): CronTarget | undefined {
  const ids = store.memberIdentities(agent.id, agent.ownerId);
  if (store.getChannelForAgent(agent.id, 'telegram')) {
    const tg = ids.telegram ?? store.knownChannelUserId(agent.ownerId);
    if (tg && /^\d{1,32}$/.test(tg)) return { channel: 'telegram', to: tg };
  }
  for (const kind of ['discord', 'slack'] as const) {
    const id = ids[kind];
    if (store.getChannelForAgent(agent.id, kind) && id && /^[A-Za-z0-9]{1,40}$/.test(id)) return { channel: kind, to: `user:${id}` };
  }
  return undefined;
}

/** Point one task at `target`, or make it quiet when there is none. */
export async function retargetCron(provider: RuntimeProvider, runtimeRef: string, jobId: string, target: CronTarget | undefined): Promise<boolean> {
  const argv = target
    ? ['cron', 'edit', jobId, '--announce', '--best-effort-deliver', '--channel', target.channel, '--to', target.to]
    : ['cron', 'edit', jobId, '--no-deliver'];
  const res = await provider.exec(runtimeRef, argv);
  return res.code === 0;
}

/**
 * Every task of an agent that announces with no explicit recipient, pointed at
 * the owner's chat (or made quiet). Agents also make such tasks themselves, so
 * this runs after each start and daily, not once. Returns how many changed.
 */
export async function retargetImplicitCrons(
  provider: RuntimeProvider, runtimeRef: string, slug: string, target: CronTarget | undefined,
): Promise<{ changed: number; failed: number }> {
  const jobs = await listCrons(provider, runtimeRef, slug);
  let changed = 0, failed = 0;
  for (const j of jobs) {
    if (j.system || !j.implicitDelivery) continue;
    if (await retargetCron(provider, runtimeRef, j.id, target)) changed++; else failed++;
  }
  return { changed, failed };
}

/**
 * Interval → the CLI's duration syntax, seconds-accurate. Rounding to whole
 * minutes turned a 20s interval into `--every 0m`, which the gateway rejects —
 * making that schedule a permanent failure (10th audit). Mirrors
 * cronImport.ts's msToDuration semantics.
 */
export function msToEvery(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

/**
 * Create a scheduled task. The one verb this module lacked — Hatchabot could
 * list/enable/run/delete crons but nothing could CREATE one, so a definition
 * that *describes* a schedule (the Stock Broker's 8am briefing) never actually
 * fired (audit backlog; surfaced by Chris 2026-09-04).
 */
export async function addCron(
  provider: RuntimeProvider,
  runtimeRef: string,
  slug: string,
  opts: AddCronOptions,
): Promise<{ ok: true; id?: string } | { ok: false; error: string }> {
  const argv = ['cron', 'add', '--json', '--agent', slug, '--name', opts.name, '--message', opts.message];
  if (opts.cron) argv.push('--cron', opts.cron);
  else if (opts.everyMs) argv.push('--every', msToEvery(opts.everyMs));
  else return { ok: false, error: 'Give a cron expression or an interval.' };
  if (opts.tz) argv.push('--tz', opts.tz);
  // Not announcing must say so: left unset, the gateway still delivers by
  // default, and on an agent with no chat app that delivery FAILS THE RUN —
  // "Channel is required (no configured channels detected)" — though the agent
  // did its work (found by scripts/regress-autonomous.sh, v2.33.0).
  if (opts.announce !== false && opts.deliverTo) {
    argv.push('--announce', '--best-effort-deliver', '--channel', opts.deliverTo.channel, '--to', opts.deliverTo.to);
  } else argv.push('--no-deliver');
  const res = await provider.exec(runtimeRef, argv);
  if (res.code !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || 'cron add failed').slice(0, 300) };
  }
  try {
    const parsed = JSON.parse(res.stdout);
    return { ok: true, id: parsed?.id ? String(parsed.id) : parsed?.job?.id ? String(parsed.job.id) : undefined };
  } catch {
    return { ok: true };
  }
}

/** The gateway refused because the task is OpenClaw's own, not the owner's to change. */
export class CronSystemOwnedError extends Error {
  readonly userMessage = 'That task is built into OpenClaw (it runs its own upkeep); it cannot be changed or deleted from here.';
  constructor() { super('system-owned cron job'); this.name = 'CronSystemOwnedError'; }
}
const refusedAsSystem = (res: { code: number; stderr: string; stdout: string }): boolean =>
  res.code !== 0 && /system-owned/i.test(`${res.stderr}\n${res.stdout}`);

/** Enable or disable a task. Job ids are globally unique, so no agent filter. */
export async function setCronEnabled(
  provider: RuntimeProvider,
  runtimeRef: string,
  jobId: string,
  enabled: boolean,
): Promise<boolean> {
  const res = await provider.exec(runtimeRef, ['cron', enabled ? 'enable' : 'disable', jobId]);
  if (refusedAsSystem(res)) throw new CronSystemOwnedError();
  return res.code === 0;
}

/** Fire a task immediately ("test fire"). Its result is delivered the task's own
 *  way (e.g. a Telegram announce), not returned here. */
export async function runCronNow(
  provider: RuntimeProvider,
  runtimeRef: string,
  jobId: string,
): Promise<boolean> {
  const res = await provider.exec(runtimeRef, ['cron', 'run', jobId]);
  return res.code === 0;
}

/** Delete a task. */
export async function deleteCron(
  provider: RuntimeProvider,
  runtimeRef: string,
  jobId: string,
): Promise<boolean> {
  const res = await provider.exec(runtimeRef, ['cron', 'rm', jobId]);
  if (refusedAsSystem(res)) throw new CronSystemOwnedError();
  return res.code === 0;
}
