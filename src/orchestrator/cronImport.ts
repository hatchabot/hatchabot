/**
 * Carrying an OpenClaw agent's scheduled tasks into the container it's adopted
 * into. OpenClaw keeps crons in its global gateway DB (not the workspace), so
 * adopt's file copy leaves them behind. We read them straight from that DB and
 * recreate each inside the new agent via the same in-container `openclaw cron`
 * CLI that crons.ts already drives — brought in DISABLED, so the owner reviews
 * (and fixes any stale paths / delivery) before they fire.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { RuntimeProvider } from '../providers/provider.js';
import type { Store } from '../store/store.js';

function stateDbPath(): string {
  return process.env.OPENCLAW_STATE_DB || resolve(homedir(), '.openclaw/state/openclaw.sqlite');
}
function configPath(): string {
  return process.env.OPENCLAW_CONFIG || resolve(homedir(), '.openclaw/openclaw.json');
}

export interface SourceCron {
  name?: string;
  description?: string;
  scheduleKind?: string;
  scheduleExpr?: string;
  scheduleTz?: string;
  everyMs?: number;
  at?: string;
  payloadKind?: string;
  payloadMessage?: string;
}

/** Resolve a workspace folder to the OpenClaw agent id that owns it. */
export function openclawAgentIdForWorkspace(workspaceDir: string, cfgPath = configPath()): string | undefined {
  let cfg: { agents?: { list?: Array<{ id?: string; workspace?: string; agentDir?: string }> } };
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch {
    return undefined;
  }
  const want = resolve(workspaceDir);
  return (cfg.agents?.list ?? []).find(
    (a) => (a.workspace && resolve(a.workspace) === want) || (a.agentDir && resolve(a.agentDir) === want),
  )?.id;
}

/** The crons OpenClaw has for one agent id. Empty if the DB is unreadable. */
export function readOpenclawCrons(sourceAgentId: string, dbPath = stateDbPath()): SourceCron[] {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return [];
  }
  try {
    const rows = db
      .prepare(
        `SELECT name, description, schedule_kind, schedule_expr, schedule_tz, every_ms, at,
                payload_kind, payload_message
           FROM cron_jobs WHERE agent_id = ? ORDER BY sort_order, created_at_ms`,
      )
      .all(sourceAgentId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      name: (r.name as string) ?? undefined,
      description: (r.description as string) ?? undefined,
      scheduleKind: (r.schedule_kind as string) ?? undefined,
      scheduleExpr: (r.schedule_expr as string) ?? undefined,
      scheduleTz: (r.schedule_tz as string) ?? undefined,
      everyMs: (r.every_ms as number) ?? undefined,
      at: (r.at as string) ?? undefined,
      payloadKind: (r.payload_kind as string) ?? undefined,
      payloadMessage: (r.payload_message as string) ?? undefined,
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function msToDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

/**
 * The `openclaw cron add` argv for a source cron, targeted at `slug`, always
 * created disabled. Returns null when the schedule can't be represented.
 */
export function cronAddArgs(c: SourceCron, slug: string): string[] | null {
  const args = ['cron', 'add', '--agent', slug, '--disabled'];
  if (c.name) args.push('--name', c.name);
  if (c.description) args.push('--description', c.description);

  if (c.scheduleKind === 'cron' && c.scheduleExpr) {
    args.push('--cron', c.scheduleExpr);
    if (c.scheduleTz) args.push('--tz', c.scheduleTz);
  } else if (c.scheduleKind === 'every' && c.everyMs) {
    args.push('--every', msToDuration(c.everyMs));
  } else if (c.scheduleKind === 'at' && c.at) {
    args.push('--at', String(c.at));
  } else {
    return null;
  }

  if (c.payloadKind === 'command') args.push('--command', c.payloadMessage ?? '');
  else args.push('--message', c.payloadMessage ?? '');
  return args;
}

export interface CronMigrateResult {
  total: number;
  carried: number;
  failed: number;
}

/**
 * Recreate an OpenClaw agent's crons inside its adopted container (disabled).
 * Best-effort: a failure on one job is counted, not thrown. The agent must be
 * running (its in-container gateway serves `cron add`).
 */
export async function migrateCrons(
  deps: { store: Store; provider: RuntimeProvider; log?: (e: string, d: Record<string, unknown>) => void },
  agentId: string,
  workspaceDir: string,
  opts: { configPath?: string; dbPath?: string } = {},
): Promise<CronMigrateResult> {
  const log = deps.log ?? (() => {});
  const agent = deps.store.getAgent(agentId);
  if (!agent?.runtimeRef) return { total: 0, carried: 0, failed: 0 };

  const sourceId = openclawAgentIdForWorkspace(workspaceDir, opts.configPath);
  if (!sourceId) return { total: 0, carried: 0, failed: 0 };

  const crons = readOpenclawCrons(sourceId, opts.dbPath);
  let carried = 0;
  let failed = 0;
  for (const c of crons) {
    const args = cronAddArgs(c, agent.slug);
    if (!args) {
      failed++;
      log('cron.migrate_unmappable', { name: c.name ?? '(unnamed)', kind: c.scheduleKind });
      continue;
    }
    try {
      const res = await deps.provider.exec(agent.runtimeRef, args);
      if (res.code === 0) carried++;
      else {
        failed++;
        log('cron.migrate_failed', { name: c.name ?? '(unnamed)', stderr: (res.stderr ?? '').slice(0, 200) });
      }
    } catch (err) {
      failed++;
      log('cron.migrate_error', { name: c.name ?? '(unnamed)', error: String(err).slice(0, 200) });
    }
  }
  return { total: crons.length, carried, failed };
}
