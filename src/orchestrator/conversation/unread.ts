/**
 * "Unread" for an agent icon: the agent said something you could only have
 * read in Hatchabot's console, after you last had that console open.
 *
 * OpenClaw keeps one record per conversation in sessions.json. A Telegram DM
 * and the web console share the agent's main conversation, and the record
 * remembers which way the last exchange went. Telegram shows its own unread
 * mark, so an exchange that went there is not ours to flag.
 */
export interface SessionEntry {
  updatedAt?: number;
  lastInteractionAt?: number;
  lastTo?: string;
  lastChannel?: string;
  origin?: { from?: string; provider?: string };
  /** 2026.8+: where the last exchange was delivered (`none` = nowhere but the console). */
  delivery?: { kind?: string; channel?: string };
  /** Set by Hatchabot, not OpenClaw (markQuietTasks): a run of a task that delivers nowhere. */
  quietTask?: boolean;
}

/** The task a scheduled run's conversation belongs to: `agent:<id>:cron:<job>[:run:<at>]`. */
export function cronJobOfKey(key: string): string | undefined {
  return /:cron:([^:]+)/.exec(key)?.[1];
}

/**
 * The agent's quiet tasks (delivery "none"), from its task store as
 * crons.ts cronStoreReadShell prints it; undefined when that says nothing
 * readable (2026.7 keeps a file, or the read failed). OpenClaw's own upkeep
 * (a declared job: the weekly skill review, memory dreaming) is quiet too,
 * but holds nothing for the owner to read: never one of them.
 */
export function quietTaskIds(stdout: string): Set<string> | undefined {
  let jobs: unknown;
  try { jobs = JSON.parse(stdout).jobs; } catch { return undefined; }
  if (!Array.isArray(jobs)) return undefined;
  return new Set(jobs
    .filter((j) => j && typeof j === 'object' && (typeof j.id === 'string' || typeof j.id === 'number') && j.delivery?.mode === 'none'
      && !(typeof j.declarationKey === 'string' && j.declarationKey))
    .map((j) => String(j.id)));
}

/**
 * What the agent's scheduled runs look like in its session records: each
 * task's newest run. Unchanged, no task has run since the last read, and its
 * quiet tasks need not be read again.
 */
export function cronRunsSignature(sessions: Record<string, SessionEntry>): string {
  const newest = new Map<string, number>();
  for (const [key, s] of Object.entries(sessions)) {
    const job = cronJobOfKey(key);
    if (!job) continue;
    const at = Number(s && typeof s === 'object' ? s.updatedAt : 0) || 0;
    newest.set(job, Math.max(newest.get(job) ?? 0, at));
  }
  return [...newest].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([j, at]) => `${j}@${at}`).join(',');
}

/** Mark the runs of quiet tasks (consoleActivity counts them on an agent with a bot). */
export function markQuietTasks(sessions: Record<string, SessionEntry>, quiet: ReadonlySet<string>): Record<string, SessionEntry> {
  for (const [key, s] of Object.entries(sessions)) {
    const job = cronJobOfKey(key);
    if (job && quiet.has(job) && s && typeof s === 'object') s.quietTask = true;
  }
  return sessions;
}

/**
 * The shell that prints an agent's session records as `{ "<key>": entry }`,
 * run in its container. Up to OpenClaw 2026.7 that is the sessions.json file
 * itself; from 2026.8 the records live in the agent's SQLite store
 * (`session_nodes.entry_json`, one row per key, the same entry shape), read
 * here with Node's own sqlite module, read-only. Prints {} when neither
 * exists, and nothing when the read failed. Found by the candidate gate on
 * 2026.9.6 (2026-09-24).
 */
export function sessionsReadShell(slug: string): string {
  const base = `/home/node/.openclaw/agents/${slug}`;
  const json = JSON.stringify(`${base}/sessions/sessions.json`);
  const db = JSON.stringify(`${base}/agent/openclaw-agent.sqlite`);
  const node = [
    'const {DatabaseSync}=require("node:sqlite");',
    `const db=new DatabaseSync(${db},{readOnly:true});`,
    'if(!db.prepare("select 1 from sqlite_master where type=? and name=?").get("table","session_nodes"))process.exit(4);',
    'const out={};',
    'for(const r of db.prepare("select session_key,entry_json from session_nodes").all()){try{out[r.session_key]=JSON.parse(r.entry_json)}catch(e){}}',
    'process.stdout.write(JSON.stringify(out));',
  ].join('');
  // Single quotes inside the node script would end the shell quoting; there are none.
  // Neither file (an agent that has never talked) prints {}: "no sessions",
  // told apart from a read that failed and printed nothing (#99).
  // The SQLite store first, as webChat.ts reads it: an agent upgraded from
  // 2026.7 can keep a sessions.json frozen at the upgrade, and read first it
  // hid every exchange since (review, 2026-10-22). Exit 4 is a store with no
  // session table (2026.7): then the file.
  return `if [ -f ${db} ]; then out=$(node -e '${node}' 2>/dev/null); rc=$?; `
    + `if [ $rc -eq 0 ]; then printf "%s" "$out"; elif [ $rc -eq 4 ] && [ -f ${json} ]; then cat ${json}; elif [ $rc -eq 4 ]; then printf "{}"; fi; `
    + `elif [ -f ${json} ]; then cat ${json}; else printf "{}"; fi`;
}

const WEB = new Set(['', 'webchat', 'web', 'internal', 'cli']);

/**
 * Newest activity (ms since epoch) that was not delivered to a messaging app; 0 if none.
 * `keys`: only these conversations — a guest's own, the ones their console
 * shows them. Every conversation counted, another person's private chat lit
 * the guest's badge for something they could not open (review, 2026-10-22).
 */
export function consoleActivity(sessions: Record<string, SessionEntry> | undefined, opts: { webOnly: boolean; keys?: string[] }): number {
  let newest = 0;
  for (const [key, s] of Object.entries(sessions ?? {})) {
    if (!s || typeof s !== 'object') continue;
    if (opts.keys && !opts.keys.includes(key)) continue;
    // Scheduled runs on an agent with a bot are delivered there. Only a
    // web-only agent's scheduled output, and a quiet task's (its task
    // delivers nowhere: HB-0302), have nowhere else to be read.
    if (key.includes(':cron:') && !opts.webOnly && !s.quietTask) continue;
    const to = String(s.lastTo ?? s.origin?.from ?? '');
    // Undefined, not '', when the recipient names no app: '' stopped the ?? at
    // once, and a Telegram conversation recorded only by its origin counted as
    // the console's (#58).
    const channel = String(s.lastChannel ?? (to.includes(':') ? to.split(':')[0] : undefined) ?? s.origin?.provider ?? '').toLowerCase();
    if (!WEB.has(channel)) continue;
    // 2026.8+ records carry a delivery instead: anything but "none" went to an app.
    const delivered = String(s.delivery?.channel ?? s.delivery?.kind ?? 'none').toLowerCase();
    if (delivered !== 'none' && !WEB.has(delivered)) continue;
    const at = Math.max(Number(s.updatedAt) || 0, Number(s.lastInteractionAt) || 0);
    if (at > newest) newest = at;
  }
  return newest;
}
