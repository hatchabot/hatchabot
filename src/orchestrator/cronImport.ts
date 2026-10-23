/**
 * Carrying an OpenClaw agent's scheduled tasks into the container it's adopted
 * into. OpenClaw keeps crons in its global gateway DB (not the workspace), so
 * adopt's file copy leaves them behind. We read them straight from that DB and
 * recreate each inside the new agent via the same in-container `openclaw cron`
 * CLI that crons.ts already drives — brought in DISABLED, so the owner reviews
 * (and fixes any stale paths / delivery) before they fire.
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { openclawConfigAgents, openclawUserPath, WORKSPACE_DIR_TEMPLATE } from '../openclaw/configWriter.js';
import { openclawConfigPath } from './openclawImport.js';
import { sq } from './apps.js';
import type { RuntimeProvider } from '../providers/provider.js';
import type { Store } from '../store/store.js';
import { listCrons, type Cron } from './crons.js';

function stateDbPath(): string {
  return process.env.OPENCLAW_STATE_DB || resolve(homedir(), '.openclaw/state/openclaw.sqlite');
}
function configPath(): string {
  return openclawConfigPath();
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
  let cfg: { agents?: unknown };
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch {
    return undefined;
  }
  const want = resolve(workspaceDir);
  const a = openclawConfigAgents(cfg).find(
    (x) => (x.workspace && openclawUserPath(x.workspace) === want) || (x.agentDir && openclawUserPath(x.agentDir) === want),
  );
  return a?.id ? { id: a.id, workspace: a.workspace, agentDir: a.agentDir } : undefined;
}

/**
 * The agent OpenClaw runs a task with no agent of its own as: the entry
 * marked `default`, else the first, else "main" (OpenClaw's
 * resolveDefaultAgentId).
 */
export function openclawDefaultAgentId(cfgPath = configPath()): string {
  let cfg: { agents?: unknown } | undefined;
  try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch { cfg = undefined; }
  const agents = openclawConfigAgents(cfg);
  const chosen = (agents.find((a) => (a as { default?: unknown }).default) ?? agents[0])?.id?.trim();
  return (chosen || 'main').toLowerCase();
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
export function selfPathReplacements(entry: OpenclawAgentEntry, containerSlug: string, home?: string): Array<[string, string]> {
  const to = WORKSPACE_DIR_TEMPLATE.replace('{slug}', containerSlug);
  const froms = [entry.agentDir, entry.workspace]
    .filter((p): p is string => !!p)
    // A `~/…` path as written and as the absolute path the files and tasks
    // name it by: only the written form was rewritten (review 2026-10-22, A11).
    .flatMap((p) => (p === '~' || p.startsWith('~/') ? [p, openclawUserPath(p, home)] : [p]))
    .map((p) => p.replace(/\/+$/, ''))
    // Drop anything that reduced to empty (e.g. a pathological "/") — an empty
    // `from` in split().join() would insert `to` between every character.
    .filter((p) => p.length > 0);
  return [...new Set(froms)].sort((a, b) => b.length - a.length).map((from) => [from, to] as [string, string]);
}

/**
 * A pattern (for the `gu` flags) matching `from` only as a whole path or a
 * parent of one. A plain substring replace also rewrote a sibling that merely
 * starts the same (`/src/agent` inside `/src/agent-two`), pointing adopted
 * tasks at a folder that does not exist (#80). A trailing `.` still counts as
 * the end of the path (the end of a sentence), `.bak` does not.
 */
export function pathPattern(from: string): string {
  // `+ @ % =` go on a name too: `/data/work+archive` is another folder (A12).
  // Only after it: before it they end a setting (`WS=/home/…`, `--dir=…`).
  const name = '[\\p{L}\\p{N}_~+@%=-]';
  return `(?<![\\p{L}\\p{N}_.~-])${from.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?!${name}|\\.${name})`;
}

export function applyReplacements(text: string | undefined, pairs: Array<[string, string]>): string | undefined {
  if (!text) return text;
  let out = text;
  for (const [from, to] of pairs) if (from) out = out.replace(new RegExp(pathPattern(from), 'gu'), () => to);
  return out;
}

// Runs INSIDE the container: replace each pair across the workspace's text
// files. PAIRS holds [pathPattern(from), to]. Double-quoted only, so it
// reads the same inside the single-quoted `-e` wrapper below. Best-effort; a
// bad file is skipped, not fatal.
const REWRITE_SCRIPT =
  'const fs=require("fs"),path=require("path");const pairs=JSON.parse(process.env.PAIRS);const root=process.env.WSDIR;' +
  'function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);' +
  'if(e.isDirectory())walk(p);else if(/\\.(md|txt|json)$/i.test(e.name)){' +
  'let t;try{t=fs.readFileSync(p,"utf8")}catch(_){continue}let o=t;for(const x of pairs){if(!x[0])continue;o=o.replace(new RegExp(x[0],"gu"),function(){return x[1]})}' +
  'if(o!==t)try{fs.writeFileSync(p,o)}catch(_){}}}}' +
  'try{walk(root)}catch(e){process.exit(2)}';

/**
 * Repoint the adopted workspace's OWN files (SOUL/AGENTS/MEMORY, memory/*.md, …)
 * from the hand-built install's absolute paths to the container's, so the agent
 * reads them at the right place. Runs `node` in the container over the workspace
 * dir. Best-effort. Each value is shell-quoted: a path with an apostrophe
 * (`/data/owner's workspace`) used to skip the whole pass (review 2026-10-22, A35).
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
  const json = JSON.stringify(pairs.filter(([from]) => from).map(([from, to]) => [pathPattern(from), to]));
  const cmd = `PAIRS=${sq(json)} WSDIR=${sq(wsdir)} node -e ${sq(REWRITE_SCRIPT)}`;
  try {
    const res = await deps.provider.execShell(runtimeRef, cmd);
    if (res.code !== 0) log('adopt.path_rewrite_failed', { stderr: (res.stderr ?? '').slice(0, 200) });
    return { rewrote: res.code === 0 };
  } catch (err) {
    log('adopt.path_rewrite_error', { error: String(err).slice(0, 200) });
    return { rewrote: false };
  }
}

/**
 * The crons OpenClaw has for one agent id, or why they could not be read.
 * Two store shapes: one column per field (older OpenClaw), and 2026.9's one
 * `job_json` per task (the shape crons.ts cronStoreReadShell reads). Reading
 * only the first, a 2026.9 source threw, the throw read as "no tasks", and
 * adopt carried none of them without a word (review of 2026-10-22, A45). No
 * store file is no tasks; a store that cannot be read, or has neither shape,
 * is an error the caller reports.
 */
export function readOpenclawCronStore(sourceAgentId: string, dbPath = stateDbPath(), cfgPath = configPath()): { crons: SourceCron[]; error?: string } {
  if (!existsSync(dbPath)) return { crons: [] };
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    return { crons: [], error: `the task store could not be opened (${String((err as Error)?.message ?? err).slice(0, 120)})` };
  }
  try {
    const cols = new Set((db.prepare(`PRAGMA table_info(cron_jobs)`).all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.size) return { crons: [] }; // no task table: no tasks
    // A task made without --agent is stored with none and runs as the
    // default agent: it is the default agent's too (final audit, 2026-10-22).
    const unowned = sourceAgentId.trim().toLowerCase() === openclawDefaultAgentId(cfgPath) ? 1 : 0;
    const whose = `(agent_id = ? OR (? = 1 AND agent_id IS NULL))`;
    if (cols.has('job_json')) {
      const rows = db.prepare(`SELECT job_json FROM cron_jobs WHERE ${whose} ORDER BY rowid`).all(sourceAgentId, unowned) as Array<{ job_json: string }>;
      const crons: SourceCron[] = [];
      let bad = 0;
      for (const r of rows) {
        let j: unknown;
        try { j = JSON.parse(r.job_json); } catch { bad++; continue; }
        if (!j || typeof j !== 'object') { bad++; continue; }
        const job = j as Record<string, any>;
        // OpenClaw's own upkeep tasks are made by OpenClaw itself, not carried.
        if (typeof job.declarationKey === 'string' && job.declarationKey) continue;
        crons.push(sourceCronOfJob(job));
      }
      return bad ? { crons, error: `${bad} task${bad > 1 ? 's' : ''} could not be read` } : { crons };
    }
    if (!cols.has('schedule_kind') || !cols.has('payload_kind')) return { crons: [], error: 'the task store has a shape this Hatchabot does not know' };
    // Delivery columns are newer; select them only if present so an older
    // source DB still imports (just without the delivery target).
    const deliveryCols = ['session_target', 'delivery_mode', 'delivery_channel', 'delivery_to', 'delivery_account_id'].filter((c) => cols.has(c));
    const rows = db
      .prepare(
        `SELECT name, description, schedule_kind, schedule_expr, schedule_tz, every_ms, at,
                payload_kind, payload_message${deliveryCols.length ? ', ' + deliveryCols.join(', ') : ''}
           FROM cron_jobs WHERE ${whose} ORDER BY sort_order, created_at_ms`,
      )
      .all(sourceAgentId, unowned) as Array<Record<string, unknown>>;
    return {
      crons: rows.map((r) => ({
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
      })),
    };
  } catch (err) {
    return { crons: [], error: `the task store could not be read (${String((err as Error)?.message ?? err).slice(0, 120)})` };
  } finally {
    db.close();
  }
}

/** One 2026.9 `job_json` task as a SourceCron (the gateway's camelCase JSON, as crons.ts normalizeCron reads it). */
function sourceCronOfJob(j: Record<string, any>): SourceCron {
  const s = (j.schedule ?? {}) as Record<string, any>;
  const p = (j.payload ?? {}) as Record<string, any>;
  const d = (j.delivery && typeof j.delivery === 'object' ? j.delivery : {}) as Record<string, any>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const at = s.at ?? s.atMs;
  return {
    name: str(j.name) ?? str(j.displayName),
    description: str(j.description),
    scheduleKind: str(s.kind),
    scheduleExpr: str(s.expr),
    scheduleTz: str(s.tz),
    everyMs: typeof s.everyMs === 'number' ? s.everyMs : typeof s.every_ms === 'number' ? s.every_ms : undefined,
    at: at === undefined || at === null ? undefined : String(at),
    payloadKind: str(p.kind),
    payloadMessage: str(p.message) ?? str(p.text) ?? str(p.command),
    sessionTarget: str(j.sessionTarget),
    // The gateway reads a stored delivery with no mode as "announce" (crons.ts pendingRetarget).
    deliveryMode: str(d.mode) ?? (j.delivery && typeof j.delivery === 'object' ? 'announce' : undefined),
    deliveryChannel: str(d.channel),
    deliveryTo: str(d.to),
    deliveryAccountId: str(d.accountId),
  };
}

/** The crons OpenClaw has for one agent id; empty when they could not be read (readOpenclawCronStore says why). */
export function readOpenclawCrons(sourceAgentId: string, dbPath = stateDbPath()): SourceCron[] {
  return readOpenclawCronStore(sourceAgentId, dbPath).crons;
}

/** Whole seconds only: 1500 ms rounded to "2s" ran a third less often than the source (B49, 2026-10-22). */
function msToDuration(ms: number): string | null {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0 && ms > 0) return `${ms / 1000}s`;
  return null;
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
    const every = msToDuration(c.everyMs);
    if (!every) return null;
    args.push('--every', every);
  } else if (c.scheduleKind === 'at' && c.at) {
    args.push('--at', String(c.at));
  } else {
    return null;
  }

  // A system event (a main-session reminder) is its own payload: sent as
  // `--message` it became an agent turn, or `cron add` refused it ("Main jobs
  // require --system-event"; review of 2026-10-22, B36). A kind not known
  // here is not guessed at.
  if (c.payloadKind === 'command') args.push('--command', c.payloadMessage ?? '');
  else if (c.payloadKind === 'systemEvent') args.push('--system-event', c.payloadMessage ?? '');
  else if (!c.payloadKind || c.payloadKind === 'agentTurn' || c.payloadKind === 'message') args.push('--message', c.payloadMessage ?? '');
  else return null;

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
  /** The source's tasks could not all be read: how, for the owner. */
  error?: string;
  /** The agent's gateway never answered: nothing was tried (the caller may try again). */
  notReady?: boolean;
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

  const read = readOpenclawCronStore(entry.id, opts.dbPath, opts.configPath);
  const crons = read.crons;
  const unread = read.error ? { error: read.error } : {};
  if (read.error) log('cron.migrate_unreadable', { error: read.error });
  if (!crons.length) return { total: 0, carried: 0, failed: 0, ...unread };

  // Repoint the source's own workspace/agentDir paths at the container copy.
  const pairs = selfPathReplacements(entry, agent.slug);

  // applyWorkspace restarts the container but doesn't wait for the in-container
  // gateway; `cron add` needs it up. Poll a harmless `cron list` until it
  // answers (or give up) so adds don't race the boot.
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  // What it answers is kept: a task brought over before (an adopt run again,
  // or retried after a partial import) is there already, disabled, and adding
  // it again made a second copy (B37, 2026-10-22).
  let there: Cron[] | undefined;
  for (let i = 0; i < (opts.readyTries ?? 15); i++) {
    try {
      there = await listCrons(deps.provider, agent.runtimeRef, agent.slug);
      break;
    } catch {
      /* not up yet */
    }
    await sleep(opts.readyGapMs ?? 2000);
  }
  if (!there) {
    log('cron.migrate_gateway_not_ready', { agentId });
    return { total: crons.length, carried: 0, failed: crons.length, notReady: true, ...unread };
  }

  let carried = 0;
  let failed = 0;
  for (const c of crons) {
    const rewritten: SourceCron = {
      ...c,
      payloadMessage: applyReplacements(c.payloadMessage, pairs),
      description: applyReplacements(c.description, pairs),
    };
    const same = there.find((j) => !j.system && !!c.name && j.name === c.name && j.scheduleKind === c.scheduleKind
      && (c.scheduleKind === 'cron' ? j.scheduleExpr === c.scheduleExpr : c.scheduleKind === 'every' ? j.everyMs === c.everyMs : true));
    if (same) {
      carried++;
      log('cron.migrate_already_present', { name: c.name, id: same.id });
      continue;
    }
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
  return { total: crons.length, carried, failed, ...unread };
}
