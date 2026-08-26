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
import { WORKSPACE_DIR_TEMPLATE } from '../openclaw/configWriter.js';
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
  /** Where the job's output goes. Without these, adopt dropped delivery
   *  entirely and OpenClaw defaulted to `announce → last` — which fail-closes
   *  ("no route") and, when it does route, delivers the isolated agent's chatty
   *  final reply. Carrying them makes an adopted cron reach the same chat it
   *  did before. */
  sessionTarget?: string; // main | isolated
  deliveryMode?: string; // announce | none
  deliveryChannel?: string; // telegram | last | …
  deliveryTo?: string; // Telegram chatId / E.164
  deliveryAccountId?: string;
}

export interface OpenclawAgentEntry {
  id: string;
  workspace?: string;
  agentDir?: string;
}

/** Resolve a workspace folder to the OpenClaw agent entry (id + its paths). */
export function openclawAgentEntryForWorkspace(
  workspaceDir: string,
  cfgPath = configPath(),
): OpenclawAgentEntry | undefined {
  let cfg: { agents?: { list?: Array<{ id?: string; workspace?: string; agentDir?: string }> } };
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch {
    return undefined;
  }
  const want = resolve(workspaceDir);
  const a = (cfg.agents?.list ?? []).find(
    (x) => (x.workspace && resolve(x.workspace) === want) || (x.agentDir && resolve(x.agentDir) === want),
  );
  return a?.id ? { id: a.id, workspace: a.workspace, agentDir: a.agentDir } : undefined;
}

/** Resolve a workspace folder to the OpenClaw agent id that owns it. */
export function openclawAgentIdForWorkspace(workspaceDir: string, cfgPath = configPath()): string | undefined {
  return openclawAgentEntryForWorkspace(workspaceDir, cfgPath)?.id;
}

/**
 * Repoint an OpenClaw agent's own paths at the container. Its files and crons
 * reference the hand-built install's absolute workspace/agentDir; inside the
 * adopted container that same content lives at WORKSPACE_DIR_TEMPLATE. Fixed
 * string replacement (no regex), longest path first so an agentDir nested under
 * a workspace rewrites before its parent. Returns pairs so callers can reuse
 * the exact mapping (crons here, files in the container).
 */
export function selfPathReplacements(entry: OpenclawAgentEntry, containerSlug: string): Array<[string, string]> {
  const to = WORKSPACE_DIR_TEMPLATE.replace('{slug}', containerSlug);
  const froms = [entry.agentDir, entry.workspace]
    .filter((p): p is string => !!p)
    .map((p) => p.replace(/\/+$/, ''))
    // Drop anything that reduced to empty (e.g. a pathological "/") — an empty
    // `from` in split().join() would insert `to` between every character.
    .filter((p) => p.length > 0);
  return [...new Set(froms)].sort((a, b) => b.length - a.length).map((from) => [from, to] as [string, string]);
}

export function applyReplacements(text: string | undefined, pairs: Array<[string, string]>): string | undefined {
  if (!text) return text;
  let out = text;
  for (const [from, to] of pairs) if (from) out = out.split(from).join(to);
  return out;
}

// Runs INSIDE the container: fixed-string replace each pair across the
// workspace's text files. Double-quoted only, so it survives the single-quoted
// `-e` wrapper below. Best-effort; a bad file is skipped, not fatal.
const REWRITE_SCRIPT =
  'const fs=require("fs"),path=require("path");const pairs=JSON.parse(process.env.PAIRS);const root=process.env.WSDIR;' +
  'function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);' +
  'if(e.isDirectory())walk(p);else if(/\\.(md|txt|json)$/i.test(e.name)){' +
  'let t;try{t=fs.readFileSync(p,"utf8")}catch(_){continue}let o=t;for(const x of pairs){if(!x[0])continue;o=o.split(x[0]).join(x[1])}' +
  'if(o!==t)try{fs.writeFileSync(p,o)}catch(_){}}}}' +
  'try{walk(root)}catch(e){process.exit(2)}';

/**
 * Repoint the adopted workspace's OWN files (SOUL/AGENTS/MEMORY, memory/*.md, …)
 * from the hand-built install's absolute paths to the container's, so the agent
 * reads them at the right place. Runs `node` in the container over the workspace
 * dir. Best-effort — a shell-hostile path (a single quote) skips it rather than
 * risk a broken command.
 */
export async function rewriteWorkspaceFiles(
  deps: { provider: RuntimeProvider; log?: (e: string, d: Record<string, unknown>) => void },
  runtimeRef: string,
  slug: string,
  pairs: Array<[string, string]>,
): Promise<{ rewrote: boolean }> {
  const log = deps.log ?? (() => {});
  if (!pairs.length) return { rewrote: false };
  const wsdir = WORKSPACE_DIR_TEMPLATE.replace('{slug}', slug);
  const json = JSON.stringify(pairs);
  if ([json, wsdir, REWRITE_SCRIPT].some((s) => s.includes("'"))) {
    log('adopt.path_rewrite_skipped', { reason: 'quote in path' });
    return { rewrote: false };
  }
  const cmd = `PAIRS='${json}' WSDIR='${wsdir}' node -e '${REWRITE_SCRIPT}'`;
  try {
    const res = await deps.provider.execShell(runtimeRef, cmd);
    if (res.code !== 0) log('adopt.path_rewrite_failed', { stderr: (res.stderr ?? '').slice(0, 200) });
    return { rewrote: res.code === 0 };
  } catch (err) {
    log('adopt.path_rewrite_error', { error: String(err).slice(0, 200) });
    return { rewrote: false };
  }
}

/** The crons OpenClaw has for one agent id. Empty if the DB is unreadable. */
export function readOpenclawCrons(sourceAgentId: string, dbPath = stateDbPath()): SourceCron[] {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return [];
  }
  // Delivery columns are newer; select them only if present so an older
  // source DB still imports (just without the delivery target).
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(cron_jobs)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  const has = (c: string) => cols.has(c);
  const deliveryCols = [
    'session_target', 'delivery_mode', 'delivery_channel', 'delivery_to', 'delivery_account_id',
  ].filter(has);
  try {
    const rows = db
      .prepare(
        `SELECT name, description, schedule_kind, schedule_expr, schedule_tz, every_ms, at,
                payload_kind, payload_message${deliveryCols.length ? ', ' + deliveryCols.join(', ') : ''}
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
      sessionTarget: (r.session_target as string) ?? undefined,
      deliveryMode: (r.delivery_mode as string) ?? undefined,
      deliveryChannel: (r.delivery_channel as string) ?? undefined,
      deliveryTo: (r.delivery_to as string) ?? undefined,
      deliveryAccountId: (r.delivery_account_id as string) ?? undefined,
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

  // Delivery: carry the source's route so the adopted cron reaches the same
  // chat instead of falling back to `announce → last` (no route → fail-closed,
  // or the isolated agent's chatty reply leaking to whoever chatted last).
  if (c.sessionTarget) args.push('--session', c.sessionTarget);
  if (c.deliveryMode === 'announce') {
    args.push('--announce');
    // A telegram destination is stored either bare (1000000001) or channel-
    // qualified (telegram:1000000001); `--to` wants the bare id.
    const to = c.deliveryTo?.replace(/^telegram:/i, '');
    if (c.deliveryChannel && c.deliveryChannel !== 'last') args.push('--channel', c.deliveryChannel);
    if (to) args.push('--to', to);
    if (c.deliveryAccountId) args.push('--account', c.deliveryAccountId);
  } else if (c.deliveryMode === 'none') {
    args.push('--no-deliver');
  }
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
  opts: { configPath?: string; dbPath?: string; readyTries?: number; readyGapMs?: number } = {},
): Promise<CronMigrateResult> {
  const log = deps.log ?? (() => {});
  const agent = deps.store.getAgent(agentId);
  if (!agent?.runtimeRef) return { total: 0, carried: 0, failed: 0 };

  const entry = openclawAgentEntryForWorkspace(workspaceDir, opts.configPath);
  if (!entry) return { total: 0, carried: 0, failed: 0 };

  const crons = readOpenclawCrons(entry.id, opts.dbPath);
  if (!crons.length) return { total: 0, carried: 0, failed: 0 };

  // Repoint the source's own workspace/agentDir paths at the container copy.
  const pairs = selfPathReplacements(entry, agent.slug);

  // applyWorkspace restarts the container but doesn't wait for the in-container
  // gateway; `cron add` needs it up. Poll a harmless `cron list` until it
  // answers (or give up) so adds don't race the boot.
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  let ready = false;
  for (let i = 0; i < (opts.readyTries ?? 15); i++) {
    try {
      const probe = await deps.provider.exec(agent.runtimeRef, ['cron', 'list', '--agent', agent.slug, '--json']);
      if (probe.code === 0) {
        ready = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(opts.readyGapMs ?? 2000);
  }
  if (!ready) {
    log('cron.migrate_gateway_not_ready', { agentId });
    return { total: crons.length, carried: 0, failed: crons.length };
  }

  let carried = 0;
  let failed = 0;
  for (const c of crons) {
    const rewritten: SourceCron = {
      ...c,
      payloadMessage: applyReplacements(c.payloadMessage, pairs),
      description: applyReplacements(c.description, pairs),
    };
    const args = cronAddArgs(rewritten, agent.slug);
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
