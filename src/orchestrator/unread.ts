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
}

/**
 * The shell that prints an agent's session records as `{ "<key>": entry }`,
 * run in its container. Up to OpenClaw 2026.7 that is the sessions.json file
 * itself; from 2026.8 the records live in the agent's SQLite store
 * (`session_nodes.entry_json`, one row per key, the same entry shape), read
 * here with Node's own sqlite module, read-only. Prints nothing when neither
 * exists. Found by the candidate gate on 2026.9.6 (2026-09-24).
 */
export function sessionsReadShell(slug: string): string {
  const base = `/home/node/.openclaw/agents/${slug}`;
  const json = JSON.stringify(`${base}/sessions/sessions.json`);
  const db = JSON.stringify(`${base}/agent/openclaw-agent.sqlite`);
  const node = [
    'const {DatabaseSync}=require("node:sqlite");',
    `const db=new DatabaseSync(${db},{readOnly:true});`,
    'const out={};',
    'for(const r of db.prepare("select session_key,entry_json from session_nodes").all()){try{out[r.session_key]=JSON.parse(r.entry_json)}catch(e){}}',
    'process.stdout.write(JSON.stringify(out));',
  ].join('');
  // Single quotes inside the node script would end the shell quoting; there are none.
  return `if [ -f ${json} ]; then cat ${json}; elif [ -f ${db} ]; then node -e '${node}' 2>/dev/null || true; fi`;
}

const WEB = new Set(['', 'webchat', 'web', 'internal', 'cli']);

/** Newest activity (ms since epoch) that was not delivered to a messaging app; 0 if none. */
export function consoleActivity(sessions: Record<string, SessionEntry> | undefined, opts: { webOnly: boolean }): number {
  let newest = 0;
  for (const [key, s] of Object.entries(sessions ?? {})) {
    if (!s || typeof s !== 'object') continue;
    // Scheduled runs on an agent with a bot are delivered there. Only a
    // web-only agent's scheduled output has nowhere else to be read.
    if (key.includes(':cron:') && !opts.webOnly) continue;
    const to = String(s.lastTo ?? s.origin?.from ?? '');
    const channel = String(s.lastChannel ?? (to.includes(':') ? to.split(':')[0] : '') ?? s.origin?.provider ?? '').toLowerCase();
    if (!WEB.has(channel)) continue;
    // 2026.8+ records carry a delivery instead: anything but "none" went to an app.
    const delivered = String(s.delivery?.channel ?? s.delivery?.kind ?? 'none').toLowerCase();
    if (delivered !== 'none' && !WEB.has(delivered)) continue;
    const at = Math.max(Number(s.updatedAt) || 0, Number(s.lastInteractionAt) || 0);
    if (at > newest) newest = at;
  }
  return newest;
}
