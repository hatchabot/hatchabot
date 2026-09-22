import type { RuntimeProvider } from '../providers/provider.js';

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
    name: typeof j.name === 'string' ? j.name : undefined,
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

/** List the agent's scheduled tasks, including disabled ones. */
export async function listCrons(
  provider: RuntimeProvider,
  runtimeRef: string,
  slug: string,
): Promise<Cron[]> {
  const res = await provider.exec(runtimeRef, ['cron', 'list', '--agent', slug, '--all', '--json']);
  if (res.code !== 0) return [];
  try {
    const jobs = JSON.parse(res.stdout).jobs;
    return Array.isArray(jobs) ? jobs.map(normalizeCron) : [];
  } catch {
    return [];
  }
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
  if (opts.announce !== false) argv.push('--announce', '--best-effort-deliver');
  else argv.push('--no-deliver');
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

/** Enable or disable a task. Job ids are globally unique, so no agent filter. */
export async function setCronEnabled(
  provider: RuntimeProvider,
  runtimeRef: string,
  jobId: string,
  enabled: boolean,
): Promise<boolean> {
  const res = await provider.exec(runtimeRef, ['cron', enabled ? 'enable' : 'disable', jobId]);
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
  return res.code === 0;
}
