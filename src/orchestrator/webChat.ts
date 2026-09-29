import { createHash } from 'node:crypto';
import type { Agent } from '../domain/types.js';
import type { ExecResult, RuntimeProvider } from '../providers/provider.js';

/**
 * Chat on the web (2026-09-29): a person the owner trusts talks to an agent
 * from Hatchabot's own page instead of a chat app.
 *
 * Step 1 of 2. A turn goes through `openclaw agent` — the operator's CLI — so
 * OpenClaw treats the writer as the agent's owner: through it they can use the
 * owner-only tools (`cron`: schedule tasks; `gateway`: change the agent's
 * configuration). That is accepted for now and said plainly wherever web chat
 * is granted. Step 2 replaces runWebChatTurn with a limited guest identity;
 * nothing else here should need to change.
 *
 * Each person has their OWN OpenClaw session, keyed from their account id, so
 * their history shows only their conversation. Memory stays one per agent, as
 * it is for every other way in.
 */

/** The bare session key for one person on one agent: `web:` + 16 hex of sha256(userId). */
export function webChatSessionKey(userId: string): string {
  return `web:${createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, 16)}`;
}

/**
 * The key OpenClaw stores it under. A bare key given with `--agent` is scoped
 * to that agent (dist/session-key: toAgentStoreSessionKey), verified against
 * 2026.9.6 and 2026.7.1's `openclaw agent --help`: "agent:<id>:<key>".
 */
export function webChatStoreKey(slug: string, userId: string): string {
  return `agent:${slug}:${webChatSessionKey(userId)}`;
}

/** What the agent is told about who writes: a short first line, stripped again in the history. */
export function webChatPrefix(displayName: string): string {
  // Brackets and line breaks would let a chosen name close the marker early
  // and pass what follows as something else.
  const name = displayName.replace(/[[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48) || 'Someone';
  return `[${name} via the web app]`;
}

const PREFIX_RE = /^\s*\[[^\]\n]{1,60} via the web app\]\s*\n?/;
export function stripWebChatPrefix(text: string): string {
  return text.replace(PREFIX_RE, '');
}

/**
 * THE transport: one turn in this person's web session, answered on stdout.
 * The message travels as an argv element (no shell), like the owner's ask.
 */
export async function runWebChatTurn(
  provider: RuntimeProvider,
  agent: Pick<Agent, 'slug' | 'runtimeRef'>,
  turn: { userId: string; displayName: string; text: string },
  timeoutMs: number,
): Promise<ExecResult> {
  const message = `${webChatPrefix(turn.displayName)}\n${turn.text}`;
  return provider.exec(
    agent.runtimeRef!,
    ['agent', '--agent', agent.slug, '--session-key', webChatSessionKey(turn.userId), '-m', message],
    { timeoutMs },
  );
}

export interface WebChatMessage {
  role: 'user' | 'assistant';
  text: string;
  at?: string;
}

/**
 * Reads one session's dialogue inside the container (or off the stopped
 * agent's volume). Static text: the slug and the store key arrive as env
 * values, both validated to a fixed character set before they get here.
 *
 *  - 2026.9 keeps sessions in the agent's openclaw-agent.sqlite: every
 *    session window of the key (session_windows — a reset starts a new one)
 *    and their transcript_events, plus any archived window.
 *  - 2026.7 keeps sessions/sessions.json (key → sessionId) and <id>.jsonl.
 */
export const HISTORY_SCRIPT = String.raw`
// hatchabot-webchat-history
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const env = process.env;
const root = (env.AGENTS_DIR || "/home/node/.openclaw/agents") + "/" + env.SLUG; // AGENTS_DIR: tests only
const key = env.SKEY, cap = Number(env.CAP) || 100;
const events = []; const seen = new Set();
const take = (e) => {
  if (!e || e.type !== "message" || !e.message) return;
  if (e.id) { if (seen.has(e.id)) return; seen.add(e.id); }
  events.push(e);
};
const lines = (text) => { for (const l of text.split(String.fromCharCode(10))) { if (!l) continue; try { take(JSON.parse(l)); } catch {} } };
let sqlite = null; try { sqlite = require("node:sqlite"); } catch {}
const dbf = path.join(root, "agent", "openclaw-agent.sqlite");
let fromDb = false;
if (sqlite && fs.existsSync(dbf)) {
  let db = null;
  try {
    db = new sqlite.DatabaseSync(dbf, { readOnly: true });
    try { db.exec("PRAGMA busy_timeout = 3000"); } catch {}
    let ids = null;
    try { ids = db.prepare("SELECT session_id FROM session_windows WHERE session_key = ?").all(key).map((r) => r.session_id); }
    catch (e) { if (!/no such table/i.test(String(e && e.message))) throw e; }
    if (ids) {
      fromDb = true;
      const q = db.prepare("SELECT event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq");
      for (const id of ids) for (const r of q.all(id)) {
        let j = r.event_json;
        if (j == null && r.event_zstd) { try { j = zlib.zstdDecompressSync(Buffer.from(r.event_zstd)).toString("utf8"); } catch { continue; } }
        try { take(JSON.parse(j)); } catch {}
      }
      let arch = [];
      try { arch = db.prepare("SELECT encoding, archive_blob FROM session_transcript_archives WHERE session_key = ?").all(key); }
      catch (e) { if (!/no such table/i.test(String(e && e.message))) throw e; }
      for (const a of arch) {
        try { lines(a.encoding === "zstd" ? zlib.zstdDecompressSync(Buffer.from(a.archive_blob)).toString("utf8") : Buffer.from(a.archive_blob).toString("utf8")); } catch {}
      }
    }
  } catch (e) {
    // Busy, locked, corrupt: say so rather than show an empty conversation.
    process.stderr.write("history read failed: " + String((e && e.message) || e));
    process.exit(3);
  } finally { try { if (db) db.close(); } catch {} }
}
if (!fromDb) {
  const sd = path.join(root, "sessions");
  let sid = null;
  try { const j = JSON.parse(fs.readFileSync(path.join(sd, "sessions.json"), "utf8")); sid = j && j[key] && j[key].sessionId; } catch {}
  if (sid && /^[A-Za-z0-9-]+$/.test(sid)) { try { lines(fs.readFileSync(path.join(sd, sid + ".jsonl"), "utf8")); } catch {} }
}
const textOf = (c) => typeof c === "string" ? c : Array.isArray(c)
  ? c.map((p) => p && p.type === "text" ? p.text : "").filter(Boolean).join(String.fromCharCode(10)) : "";
const out = [];
for (const e of events) {
  const m = e.message, role = m.role;
  if (role !== "user" && role !== "assistant") continue;
  const t = textOf(m.content).trim();
  if (!t || t === "NO_REPLY" || t.indexOf("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>") === 0) continue;
  // What OpenClaw itself put in the conversation (a finished background task
  // arrives as a "user" message with provenance inter_session) is not
  // something this person wrote. What they wrote carries the web-app line.
  if (role === "user" && m.provenance && !/^\s*\[[^\]\n]{1,60} via the web app\]/.test(t)) continue;
  const at = e.timestamp || m.timestamp || "";
  const prev = out[out.length - 1];
  // A delivered reply is recorded twice, same text: keep one.
  if (prev && role === "assistant" && prev.role === role && prev.text === t) continue;
  out.push({ role, text: t, at: typeof at === "string" ? at : new Date(at).toISOString() });
}
out.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
process.stdout.write(JSON.stringify({ messages: out.slice(-cap) }));
`;

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KEY_RE = /^agent:[a-z0-9][a-z0-9_-]{0,63}:web:[0-9a-f]{16}$/;

export function historyScript(slug: string, storeKey: string, cap = 100): string {
  if (!SLUG_RE.test(slug) || !KEY_RE.test(storeKey)) throw new Error('unexpected agent slug or session key');
  const b64 = Buffer.from(HISTORY_SCRIPT, 'utf8').toString('base64');
  // Every value is from a fixed character set (checked above), so plain quoting is safe.
  return `set -e; T=/tmp/hatchabot-webchat-$$.cjs; echo ${b64} | base64 -d > $T; SLUG='${slug}' SKEY='${storeKey}' CAP='${Math.max(1, Math.min(500, Math.floor(cap)))}' node $T; rm -f $T`;
}

/** This person's web conversation, newest last, with the "[… via the web app]" line taken off. */
export async function webChatHistory(
  provider: RuntimeProvider,
  agent: Pick<Agent, 'slug' | 'runtimeRef' | 'state'>,
  userId: string,
  cap = 100,
): Promise<WebChatMessage[]> {
  const s = historyScript(agent.slug, webChatStoreKey(agent.slug, userId), cap);
  const res = agent.state === 'RUNNING'
    ? await provider.execShell(agent.runtimeRef!, s)
    : await provider.execShellOnVolume(agent.runtimeRef!, s, { readOnly: true });
  if (res.code !== 0) throw new Error((res.stderr || res.stdout || 'history read failed').slice(-200));
  const j = JSON.parse(res.stdout || '{}') as { messages?: Array<{ role?: string; text?: string; at?: string }> };
  return (j.messages ?? [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      text: m.role === 'user' ? stripWebChatPrefix(m.text!) : m.text!,
      ...(m.at ? { at: m.at } : {}),
    }));
}
