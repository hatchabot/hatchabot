/**
 * Carrying an OpenClaw agent's scheduled tasks into the container it's adopted
 * into. OpenClaw keeps crons in its global gateway DB (not the workspace), so
 * adopt's file copy leaves them behind. We read them straight from that DB and
 * recreate each inside the new agent via the same in-container `openclaw cron`
 * CLI that crons.ts already drives — brought in DISABLED, so the owner reviews
 * (and fixes any stale paths / delivery) before they fire.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { openclawConfigAgents, openclawUserPath, WORKSPACE_DIR_TEMPLATE } from '../../openclaw/configWriter.js';
import { openclawConfigPath } from './openclawImport.js';
import { sq } from '../apps/apps.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { addedCronId, ensureConversation, listCrons, type Cron } from '../schedules/crons.js';
import { regexpEscape } from '../../domain/regexpEscape.js';

function stateDbPath(): string {
  return process.env.OPENCLAW_STATE_DB || resolve(homedir(), '.openclaw/state/openclaw.sqlite');
}
function configPath(): string {
  return openclawConfigPath();
}

export interface SourceCron {
  /** The task's id in the source's store: how a later adopt knows it carried this one (HB-0985). */
  sourceId?: string;
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
  sessionTarget?: string; // main | isolated | current | session:<key>
  /** The conversation a `current` task is bound to (`agent:<id>:…`). */
  sessionKey?: string;
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
  return `(?<![\\p{L}\\p{N}_.~-])${regexpEscape(from)}(?!${name}|\\.${name})`;
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
//
// `put`: a regular file it changes is written to a new file of its own in
// the same folder (made with O_EXCL, its owner and mode as the file's) and
// renamed over it, so the agent, which reads its files while this runs, has
// the old one or the new one and never one cut short (HB-0629). The new
// file's name is `.hb-` and 12 hex digits, whatever the file's own: one
// made from it was too long for a name near the 255-byte limit, and that
// file was passed by. The walk never reads one (no .md, .txt or .json); a
// regular one it meets is a pass's that was killed before its rename, and is
// removed (HB-1467). A name taken already is tried again with another, five
// times: it left the file as it was, with nothing said (HB-1467). A
// file that is read-only is replaced too, its mode kept: the folder
// decides, as for any rename (written in place, it was refused). Written
// through or in
// place, as it always was: a link (to a regular file only: one to a fifo
// would hang the read), a file with other hard links (a rename would part
// them), one in a folder it cannot add a file to (EACCES, EPERM, EROFS), and
// one whose owner the new file cannot take. Any other failure (ENOSPC,
// EDQUOT, EIO in the write, the sync or the rename) removes the new file and
// leaves the old one as it was. Only regular files and links to them are read,
// and a link only when its real path is inside the workspace (`top`, the
// workspace's own real path): one to a file outside it is left as it is
// (HB-1501). The adopt never copies a link, so the agent made it, and what
// it points at is not the workspace's. A file with other hard links is still
// written in place, wherever they are: which are inside cannot be told
// without a pass of its own, and it is the same user's file either way.
const REWRITE_SCRIPT =
  'const fs=require("fs"),path=require("path"),crypto=require("crypto");const pairs=JSON.parse(process.env.PAIRS);const root=process.env.WSDIR;let top;' +
  'function fileAt(p){try{const r=fs.realpathSync(p);return r.startsWith(top)&&fs.statSync(r).isFile()}catch(_){return false}}' +
  'function put(p,o,link){if(link){fs.writeFileSync(p,o);return}' +
  'const st=fs.lstatSync(p);if(!st.isFile())return;if(st.nlink>1){fs.writeFileSync(p,o);return}' +
  'let t,fd,own=true;for(let i=0;fd===undefined;i++){t=path.join(path.dirname(p),".hb-"+crypto.randomBytes(6).toString("hex"));' +
  'try{fd=fs.openSync(t,"wx",st.mode&4095)}catch(e){if(e.code==="EEXIST"&&i<4)continue;if(e.code==="EACCES"||e.code==="EPERM"||e.code==="EROFS")fs.writeFileSync(p,o);return}}' +
  'try{try{fs.fchownSync(fd,st.uid,st.gid)}catch(e){if(st.uid!==process.getuid()||st.gid!==process.getgid()){own=false;throw e}}' +
  'fs.writeFileSync(fd,o);fs.fchmodSync(fd,st.mode&4095);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(t,p)}' +
  'catch(_){if(fd!==undefined)try{fs.closeSync(fd)}catch(_){}try{fs.unlinkSync(t)}catch(_){}if(!own)fs.writeFileSync(p,o)}}' +
  'function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);' +
  'if(e.isDirectory())walk(p);else if(e.isFile()&&/^\\.hb-[0-9a-f]{12}$/.test(e.name)){try{fs.unlinkSync(p)}catch(_){}}else if(/\\.(md|txt|json)$/i.test(e.name)&&(e.isFile()||e.isSymbolicLink()&&fileAt(p))){' +
  'let t;try{t=fs.readFileSync(p,"utf8")}catch(_){continue}let o=t;for(const x of pairs){if(!x[0])continue;o=o.replace(new RegExp(x[0],"gu"),function(){return x[1]})}' +
  'if(o!==t)try{put(p,o,e.isSymbolicLink())}catch(_){}}}}' +
  'try{top=fs.realpathSync(root)+path.sep;walk(root)}catch(e){process.exit(2)}';

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
      // `job_id` is the task's id, the one the gateway lists and edits it by (crons.ts cronStoreReadShell).
      const rows = db.prepare(`SELECT ${cols.has('job_id') ? 'job_id' : 'NULL AS job_id'}, job_json FROM cron_jobs WHERE ${whose} ORDER BY rowid`)
        .all(sourceAgentId, unowned) as Array<{ job_id: unknown; job_json: string }>;
      const crons: SourceCron[] = [];
      let bad = 0;
      for (const r of rows) {
        let j: unknown;
        try { j = JSON.parse(r.job_json); } catch { bad++; continue; }
        if (!j || typeof j !== 'object') { bad++; continue; }
        const job = j as Record<string, any>;
        // OpenClaw's own upkeep tasks are made by OpenClaw itself, not carried.
        if (typeof job.declarationKey === 'string' && job.declarationKey) continue;
        const cron = sourceCronOfJob(job);
        crons.push(r.job_id !== null && r.job_id !== undefined && r.job_id !== '' ? { ...cron, sourceId: String(r.job_id) } : cron);
      }
      return bad ? { crons, error: `${bad} task${bad > 1 ? 's' : ''} could not be read` } : { crons };
    }
    if (!cols.has('schedule_kind') || !cols.has('payload_kind')) return { crons: [], error: 'the task store has a shape this Hatchabot does not know' };
    // Delivery columns are newer; select them only if present so an older
    // source DB still imports (just without the delivery target).
    const deliveryCols = ['session_target', 'session_key', 'delivery_mode', 'delivery_channel', 'delivery_to', 'delivery_account_id'].filter((c) => cols.has(c));
    const idCol = cols.has('id') ? 'id' : cols.has('job_id') ? 'job_id' : 'NULL';
    const rows = db
      .prepare(
        `SELECT ${idCol} AS source_id, name, description, schedule_kind, schedule_expr, schedule_tz, every_ms, at,
                payload_kind, payload_message${deliveryCols.length ? ', ' + deliveryCols.join(', ') : ''}
           FROM cron_jobs WHERE ${whose} ORDER BY sort_order, created_at_ms`,
      )
      .all(sourceAgentId, unowned) as Array<Record<string, unknown>>;
    return {
      crons: rows.map((r) => ({
        ...(r.source_id === null || r.source_id === undefined || r.source_id === '' ? {} : { sourceId: String(r.source_id) }),
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
        sessionKey: (r.session_key as string) || undefined,
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
    ...(str(j.id) ? { sourceId: str(j.id) } : {}),
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
    sessionKey: str(j.sessionKey),
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
  // Bound to a conversation: its key (remapped to this agent by migrateCrons).
  // Without it a `current` task had no conversation to write its result to.
  if (c.sessionTarget === 'current' && c.sessionKey) args.push('--session-key', c.sessionKey);
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

/**
 * A source conversation key (`agent:<id>:<rest>`) as the adopted agent's,
 * which runs as `slug`. Undefined for another agent's key, or one of no known
 * shape: that binding cannot be carried. A key with no `agent:` prefix (a
 * custom `session:standup`) is already the running agent's own: OpenClaw
 * scopes it to the agent that runs it (toAgentStoreSessionKey), so it is
 * carried as it is.
 */
export function remapSessionKey(key: string, sourceAgentId: string, slug: string): string | undefined {
  if (!/^agent:/i.test(key.trim())) return key;
  const m = /^agent:([^:]+):(.+)$/.exec(key);
  return m && m[1]!.toLowerCase() === sourceAgentId.trim().toLowerCase() ? `agent:${slug}:${m[2]}` : undefined;
}

/**
 * Where a source task runs, as the adopted agent's: a `current` task's
 * conversation and a `session:<key>` target are the source agent's, and were
 * carried as they were (`current` lost its key altogether, HB-0288). Null when
 * the binding is to a conversation that cannot be mapped.
 */
function remapSession(c: SourceCron, sourceAgentId: string, slug: string): Pick<SourceCron, 'sessionTarget' | 'sessionKey'> | null {
  if (c.sessionTarget === 'current' && c.sessionKey) {
    const key = remapSessionKey(c.sessionKey, sourceAgentId, slug);
    return key ? { sessionTarget: 'current', sessionKey: key } : null;
  }
  if (c.sessionTarget?.startsWith('session:')) {
    const key = remapSessionKey(c.sessionTarget.slice('session:'.length), sourceAgentId, slug);
    return key ? { sessionTarget: `session:${key}`, sessionKey: undefined } : null;
  }
  return { sessionTarget: c.sessionTarget, sessionKey: undefined };
}

/** A recipient written bare or channel-qualified (`telegram:…`) is one recipient. */
const bareTo = (to: string | undefined) => to?.replace(/^telegram:/i, '');

/** A source task that names who it goes to: a chat app and a recipient there. */
const namesRecipient = (c: SourceCron) => c.deliveryMode === 'announce' && !!c.deliveryChannel && c.deliveryChannel !== 'last' && !!c.deliveryTo;

/**
 * Whether a task the agent has looks like the source task `c`, which this
 * adopt carries as `as`: the match for a copy an adopt may have made with no
 * record of it (migrateCrons). The whole task, not its name and kind: two
 * one-shots named "Reminder" on different days, or two daily tasks with
 * different prompts, are two tasks, and the second was counted as carried
 * and never added (review R20, 2026-10-23). And who it goes to: the same
 * briefing for two recipients is two tasks (HB-0287). Only a named recipient
 * is compared: an implicit one is re-pointed after the adopt (crons.ts
 * retargetImplicitCrons), so the earlier copy no longer has it. A copy that
 * names another bot than the task is not its copy (HB-0985): the sweep never
 * sets one (it only clears it, moving the task to another app).
 */
function looksLike(c: SourceCron, as: SourceCron, j: Cron): boolean {
  const sameTime = c.scheduleKind === 'cron' ? j.scheduleExpr === c.scheduleExpr && (j.scheduleTz ?? null) === (c.scheduleTz ?? null)
    : c.scheduleKind === 'every' ? j.everyMs === c.everyMs
    : c.scheduleKind === 'at' ? j.atMs !== undefined && j.atMs === (/^\d+$/.test(String(c.at ?? '').trim()) ? Number(c.at) : Date.parse(String(c.at)))
    : true;
  const kindOf = (k: string | undefined) => (k === 'systemEvent' || k === 'command' ? k : 'agentTurn');
  const sameRecipient = !namesRecipient(c) || (j.announce === true && j.deliveryChannel === c.deliveryChannel && bareTo(j.deliveryTo) === bareTo(c.deliveryTo));
  const bot = c.deliveryAccountId?.trim();
  const otherBot = !!bot && !!j.deliveryAccountId && j.deliveryAccountId !== bot;
  return !!c.name && j.name === c.name && j.scheduleKind === c.scheduleKind && sameTime
    && (j.message ?? '') === (as.payloadMessage ?? '') && kindOf(j.payloadKind) === kindOf(c.payloadKind) && sameRecipient && !otherBot;
}

/**
 * A task just as this adopt makes the source task `c` (`as`): the same
 * session and conversation, and a recipient only when the task names one
 * (looksLike compares it then).
 */
const asCarried = (c: SourceCron, as: SourceCron, j: Cron) => !!as.sessionTarget && j.sessionTarget === as.sessionTarget
  && (j.sessionKey ?? undefined) === (as.sessionKey ?? undefined) && (namesRecipient(c) || !j.deliveryTo);

/**
 * What a source task holds, as its fingerprint (HB-1200): what the owner
 * wrote, as the source's store holds it, before the adopt re-points its
 * paths (so the agent it goes to never changes it): its name, description,
 * schedule and payload. Left out: where it runs and who it goes to (the
 * sweep re-points a copy's, and OpenClaw gives a task with none a delivery
 * of its own), and what OpenClaw stamps (its runs, its state, whether it is
 * on), which a SourceCron never reads. Read as looksLike reads them: only
 * the schedule's own fields, a time as a number or a date is one time, and
 * an agent turn written `message`, or with no kind, is one kind.
 */
export function sourceTaskFingerprint(c: SourceCron): string {
  const text = (v: string | undefined) => v || null;
  const at = String(c.at ?? '').trim();
  const when = c.scheduleKind === 'cron' ? [text(c.scheduleExpr), text(c.scheduleTz)]
    : c.scheduleKind === 'every' ? [c.everyMs ?? null]
    : c.scheduleKind === 'at' ? [/^\d+$/.test(at) ? Number(at) : Number.isNaN(Date.parse(at)) ? text(at) : Date.parse(at)]
    : [];
  const kind = c.payloadKind === 'systemEvent' || c.payloadKind === 'command' ? c.payloadKind
    : !c.payloadKind || c.payloadKind === 'agentTurn' || c.payloadKind === 'message' ? 'agentTurn' : c.payloadKind;
  const parts = [text(c.name), text(c.description), text(c.scheduleKind), ...when, kind, text(c.payloadMessage)];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/**
 * The fingerprint a carried record keeps: the source task's, and the copy it
 * became, so a record an older release gave another copy since (it leaves
 * this column as it was) reads as one with none.
 */
const carriedFingerprint = (c: SourceCron, copyId: string | undefined) => `1:${sourceTaskFingerprint(c)}:${copyId ?? ''}`;
/** Whether the source task changed since its record's copy was carried; false for a record that does not say. */
function changedSince(c: SourceCron, record: { copyId?: string; fingerprint?: string }): boolean {
  const kept = /^1:([0-9a-f]{16}):(.*)$/s.exec(record.fingerprint ?? '');
  return !!kept && !!record.copyId && kept[2] === record.copyId && kept[1] !== sourceTaskFingerprint(c);
}

export interface CronMigrateResult {
  total: number;
  carried: number;
  failed: number;
  /**
   * Tasks carried before whose copy is still there, and whose source task
   * changed in the old workspace since: not brought again (HB-1200). Only
   * when there are any. A record from before these were kept is never one.
   */
  changed?: number;
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

  // What adopts here carried before, by each task's id in its source's store
  // (HB-0985). A copy is not known by how it looks now: the sweep re-points a
  // carried copy's conversation and delivery (crons.ts retargetImplicitCrons),
  // and OpenClaw gives one added with no delivery a delivery of its own, so
  // each look-alike rule missed another case. Read once, as `there` is.
  const kept = deps.store.carriedTasks(agentId);
  const keptHere = new Map(kept.filter((k) => k.sourceAgent === entry.id).map((k) => [k.sourceId, k]));
  const thereIds = new Set(there.map((j) => j.id));
  // An agent from before these were kept may hold an older adopt's copies,
  // unrecorded: for it, a task with no record is matched as before. So may one
  // given tasks from a store with no task ids: that store, upgraded, gives
  // them ids, and a later adopt must not add them again.
  const unrecorded = deps.store.mayHoldUnrecordedCarriedTasks(agentId);
  const carriedOne = (c: SourceCron, copyId: string | undefined) => {
    if (c.sourceId) deps.store.recordCarriedTask(agentId, entry.id, c.sourceId, copyId, carriedFingerprint(c, copyId));
    else deps.store.markUnrecordedCarriedTasks(agentId);
  };

  // Each task as this adopt carries it: where it runs here, its own paths
  // re-pointed, what it has of a record, and whether its copy is there.
  // Carried by an adopt before with its copy still there, whatever the copy
  // looks like now, it is this task. One the gateway gave no id for is looked
  // for by look below, and its id recorded when found: counted as there, it
  // was never added again once its owner deleted it.
  const plans = crons.map((c) => {
    const session = remapSession(c, entry.id, agent.slug);
    const rewritten: SourceCron | undefined = session ? {
      ...c,
      ...session,
      payloadMessage: applyReplacements(c.payloadMessage, pairs),
      description: applyReplacements(c.description, pairs),
    } : undefined;
    const record = c.sourceId ? keptHere.get(c.sourceId) : undefined;
    return { c, rewritten, record, copyThere: record?.copyId !== undefined && thereIds.has(record.copyId) };
  });
  // The look-alike match, only where a copy may be there unrecorded: a source
  // with no task ids, an agent marked as one that may hold such copies, or a
  // recorded copy with no id or gone from its id. Never a copy recorded as
  // another task's, nor one another task took in this run: two tasks alike
  // but for their chat, conversation or bot are two (HB-0985). The surest
  // first: a copy just as this adopt makes the task; then the tasks naming a
  // recipient, which only a copy for it fits (taken first by the rest, a copy
  // left a named task none). Those two take a copy for one task. The rest
  // share what is left, as before: a copy the sweep re-pointed shows nothing
  // of which of two tasks alike but for their conversation it was, and
  // giving it to one added the other, whichever came first, perhaps again.
  const seeking = plans.flatMap((p, i) => (p.rewritten && !p.copyThere && (!p.c.sourceId || unrecorded || !!p.record) ? [i] : []));
  const othersCopy = (c: SourceCron, j: Cron) => kept.some((k) => k.copyId === j.id && !(k.sourceAgent === entry.id && k.sourceId === c.sourceId));
  const taken = new Set<string>();
  const found = new Map<number, Cron>();
  const look = (which: number[], fits: (c: SourceCron, as: SourceCron, j: Cron) => boolean, shared = false) => {
    for (const i of which) {
      if (found.has(i)) continue;
      const { c, rewritten } = plans[i]!;
      const j = there!.find((x) => !x.system && !taken.has(x.id) && !othersCopy(c, x) && looksLike(c, rewritten!, x) && fits(c, rewritten!, x));
      if (j) { if (!shared) taken.add(j.id); found.set(i, j); }
    }
  };
  look(seeking, asCarried);
  look(seeking.filter((i) => namesRecipient(plans[i]!.c)), () => true);
  look(seeking, () => true, true);

  let carried = 0;
  let failed = 0;
  let changed = 0;
  for (const [i, { c, rewritten, record, copyThere }] of plans.entries()) {
    if (!rewritten) {
      // Reported, not carried unbound: it would have run somewhere else.
      failed++;
      log('cron.migrate_unmappable_session', { name: c.name ?? '(unnamed)', sessionTarget: c.sessionTarget });
      continue;
    }
    if (copyThere) {
      carried++;
      // Edited in the old workspace since it was carried: its copy stays as
      // it was, and the answer says how many (HB-1200, the owner's choice).
      const edited = changedSince(c, record!);
      if (edited) changed++;
      log('cron.migrate_already_present', { name: c.name, id: record!.copyId, ...(edited ? { changed: true } : {}) });
      continue;
    }
    const same = found.get(i);
    if (same) {
      carried++;
      carriedOne(c, same.id);
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
      // A bound task's conversation must exist before it runs (crons.ts ensureConversation); best-effort.
      if (rewritten.sessionTarget === 'current' && rewritten.sessionKey) {
        await ensureConversation(deps.provider, agent.runtimeRef, agent.slug, rewritten.sessionKey).catch(() => false);
      }
      // With --json the gateway answers the copy it made, kept beside the task's source id.
      const res = await deps.provider.exec(agent.runtimeRef, [...args.slice(0, 2), '--json', ...args.slice(2)]);
      if (res.code === 0) {
        carried++;
        carriedOne(c, addedCronId(res.stdout));
      } else {
        failed++;
        log('cron.migrate_failed', { name: c.name ?? '(unnamed)', stderr: (res.stderr ?? '').slice(0, 200) });
      }
    } catch (err) {
      failed++;
      log('cron.migrate_error', { name: c.name ?? '(unnamed)', error: String(err).slice(0, 200) });
    }
  }
  return { total: crons.length, carried, failed, ...(changed ? { changed } : {}), ...unread };
}
