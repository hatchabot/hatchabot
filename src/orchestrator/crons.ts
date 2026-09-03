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
    everyMs: typeof s.every_ms === 'number' ? s.every_ms : undefined,
    atMs: typeof s.at_ms === 'number' ? s.at_ms : undefined,
    payloadKind: p.kind,
    message:
      typeof p.message === 'string' ? p.message
      : typeof p.command === 'string' ? p.command
      : typeof p.shell === 'string' ? p.shell
      : undefined,
  };
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
 * Create a scheduled task. The one verb this module lacked — AgentClaw could
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
  else if (opts.everyMs) argv.push('--every', `${Math.round(opts.everyMs / 60_000)}m`);
  else return { ok: false, error: 'Give a cron expression or an interval.' };
  if (opts.tz) argv.push('--tz', opts.tz);
  if (opts.announce !== false) argv.push('--announce', '--best-effort-deliver');
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
