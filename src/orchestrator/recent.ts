import type { SessionEntry } from './unread.js';

/**
 * "Recent": each agent's last word, for the home screen — who spoke last and
 * the first words of it, or the scheduled task that ran.
 *
 * Cost: nothing new on a quiet agent. The app's list poll already reads every
 * running agent's session records once a minute (unread.ts). Only when a
 * record moved since the last capture does ONE more exec read the last few
 * transcript events of just the conversations that moved. The result is kept
 * in the store, so an agent that is asleep or stopped keeps its last line
 * (and is never woken, never exec'd, to get it).
 *
 * Privacy: the capture holds every recent conversation's last line; what a
 * person is SHOWN is decided per viewer (`previewFor`) and mirrors what the
 * console shows them — the owner's console reads every conversation; a
 * web-chat guest's reads only their own; anyone else reads none here. Text is
 * cleaned and cut to PREVIEW_MAX characters at capture, and never logged.
 */

export const PREVIEW_MAX = 120;
/** How far back "recent" reaches. */
export const RECENT_DAYS = 7;
/** Rows on the home screen; "Show all" lifts it. */
export const RECENT_CAP = 8;
/** Conversations kept per agent (the newest), and read per capture. */
const KEEP_SESSIONS = 40;
const READ_SESSIONS = 16;

/** One conversation's last line, as captured (already cleaned and cut). */
export interface RecentLine {
  /** When the conversation last moved (its session record), ms. */
  at: number;
  role: 'user' | 'assistant';
  text: string;
  /** For a user line from a messaging app: the sender's id there, and the name the app gave. */
  senderId?: string;
  senderName?: string;
  /** The scheduled task this line belongs to (its run, or its prompt in the conversation). */
  task?: string;
}

/** What is kept per agent: when it was last active, and the last line of each recent conversation. */
export interface RecentRecord {
  lastActiveAt: number;
  sessions: Record<string, RecentLine>;
}

// ---------------------------------------------------------------------------
// In the container: the last line of named conversations
// ---------------------------------------------------------------------------

/**
 * Reads the last message of each named conversation (KEYS_B64: a base64 JSON
 * list of session keys), in the agent's container. 2026.9 keeps transcripts
 * in the agent's SQLite (`transcript_events` by `session_nodes.current_session_id`,
 * newest by the (session_id, seq) primary key); 2026.7 in `sessions/<id>.jsonl`
 * (only its tail is read). The inbound context OpenClaw puts above a channel
 * message (`Conversation info ⟦openclaw:ctx⟧` and friends) is taken off here,
 * keeping the sender's id and name from it; everything else about the text is
 * cleaned by `cleanPreview` on this side. Prints `{"v":1,"s":{key:{…}}}`.
 */
export const RECENT_SCRIPT = String.raw`
// hatchabot-recent
const fs = require("fs"), path = require("path");
let zlib = null; try { zlib = require("zlib"); } catch {}
const env = process.env;
const root = (env.AGENTS_DIR || "/home/node/.openclaw/agents") + "/" + env.SLUG; // AGENTS_DIR: tests only
let keys = []; try { keys = JSON.parse(Buffer.from(env.KEYS_B64 || "", "base64").toString("utf8")); } catch {}
if (!Array.isArray(keys)) keys = [];
keys = keys.filter((k) => typeof k === "string" && k.length < 300).slice(0, 40);
const NL = String.fromCharCode(10);
const MARK = "⟦openclaw:ctx⟧";
const textOf = (c) => typeof c === "string" ? c : Array.isArray(c)
  ? c.map((p) => !p ? "" : p.type === "text" ? p.text : /image/.test(p.type || "") ? "[image]" : "").filter(Boolean).join(NL) : "";
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
// The inbound context above a channel message: header lines ending in the
// marker (2026.9) or "(untrusted metadata):" (older), each followed by a json
// fence or lines up to a blank one; "Context: <marker>" runs to the end.
function unwrap(t) {
  t = t.replace(/^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */, "");
  let sender = null;
  if (t.indexOf(MARK) < 0 && t.indexOf("(untrusted metadata):") < 0 && t.indexOf("<active_memory_plugin>") < 0) return { body: t, sender };
  const lines = t.split(NL), keep = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l === "Context: " + MARK) break;
    const header = (l.length > MARK.length && l.endsWith(MARK)) || /\(untrusted metadata\):$/.test(l)
      || (l === "Context:" && (lines[i + 1] || "").trim() === "<active_memory_plugin>");
    if (!header) { keep.push(lines[i]); continue; }
    let j = i + 1;
    if ((lines[j] || "").trim() === "\u0060\u0060\u0060json") {
      let k = j + 1; const body = [];
      while (k < lines.length && lines[k].trim() !== "\u0060\u0060\u0060") body.push(lines[k++]);
      const o = parse(body.join(NL));
      if (o && typeof o === "object") {
        const s = /^Sender\b/.test(l) ? o : o.sender;
        if (s && typeof s === "object" && !sender) sender = { id: s.id != null ? String(s.id) : undefined, name: s.name || s.label || s.username || undefined };
      }
      j = k + 1;
    } else if ((lines[j] || "").trim() === "<active_memory_plugin>") {
      while (j < lines.length && lines[j].trim() !== "</active_memory_plugin>") j++;
      j++;
    } else {
      while (j < lines.length && lines[j].trim() !== "") j++;
    }
    while (j < lines.length && lines[j].trim() === "") j++;
    i = j - 1;
  }
  return { body: keep.join(NL), sender };
}
const CRON = /^\[cron:\S+ ([^\]\n]{1,80})\]/;
const usable = (m) => {
  if (!m || (m.role !== "user" && m.role !== "assistant")) return null;
  const raw = textOf(m.content).trim();
  if (!raw || raw === "NO_REPLY" || raw === "HEARTBEAT_OK" || raw.indexOf("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>") === 0) return null;
  // What OpenClaw itself put in a conversation as a "user" message (a
  // finished background task) is nobody's line; a web-app line is a person's.
  if (m.role === "user" && m.provenance && !/^\s*\[[^\]\n]{1,60} via the web app\]/.test(raw)) return null;
  return raw;
};
let sqlite = null; try { sqlite = require("node:sqlite"); } catch {}
const dbf = path.join(root, "agent", "openclaw-agent.sqlite");
const jsonf = path.join(root, "sessions", "sessions.json");
let db = null, store = null;
if (fs.existsSync(jsonf)) { try { store = JSON.parse(fs.readFileSync(jsonf, "utf8")); } catch {} }
else if (sqlite && fs.existsSync(dbf)) {
  try { db = new sqlite.DatabaseSync(dbf, { readOnly: true }); try { db.exec("PRAGMA busy_timeout = 2000"); } catch {} } catch { db = null; }
}
const decode = (r) => {
  if (r.event_json != null) return parse(r.event_json);
  if (r.event_zstd && zlib && zlib.zstdDecompressSync) { try { return parse(zlib.zstdDecompressSync(Buffer.from(r.event_zstd)).toString("utf8")); } catch {} }
  return null;
};
function eventsOf(key) {
  // [newest-first tail, oldest-first head]
  if (db) {
    let sid = null;
    try { const r = db.prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?").get(key); sid = r && r.current_session_id; } catch {}
    if (!sid) { try { const r = db.prepare("SELECT session_id FROM session_windows WHERE session_key = ? ORDER BY updated_at DESC LIMIT 1").get(key); sid = r && r.session_id; } catch {} }
    if (!sid) return [[], []];
    let tail = [], head = [];
    try { tail = db.prepare("SELECT event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq DESC LIMIT 60").all(sid).map(decode); } catch {}
    if (key.indexOf(":cron:") >= 0) { try { head = db.prepare("SELECT event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq ASC LIMIT 6").all(sid).map(decode); } catch {} }
    return [tail, head];
  }
  const e = store && store[key];
  const sid = e && e.sessionId;
  if (!sid || !/^[A-Za-z0-9-]+$/.test(sid)) return [[], []];
  const f = path.join(root, "sessions", sid + ".jsonl");
  let fd; try { fd = fs.openSync(f, "r"); } catch { return [[], []]; }
  try {
    const size = fs.fstatSync(fd).size;
    const read = (from, n) => { const b = Buffer.alloc(n); const got = fs.readSync(fd, b, 0, n, from); return b.subarray(0, got).toString("utf8"); };
    const TAIL = 262144, HEAD = 32768;
    const tailText = read(Math.max(0, size - TAIL), Math.min(size, TAIL));
    let tl = tailText.split(NL); if (size > TAIL) tl = tl.slice(1);
    const tail = tl.map(parse).filter(Boolean).reverse();
    const head = key.indexOf(":cron:") >= 0 ? read(0, Math.min(size, HEAD)).split(NL).slice(0, 12).map(parse).filter(Boolean) : [];
    return [tail, head];
  } finally { try { fs.closeSync(fd); } catch {} }
}
const out = {};
for (const key of keys) {
  try {
    const [tail, head] = eventsOf(key);
    let last = null, lastUserRaw = null;
    for (const e of tail) {
      if (!e || e.type !== "message" || !e.message) continue;
      const raw = usable(e.message); if (raw == null) continue;
      if (!last) last = { role: e.message.role, raw };
      if (e.message.role === "user") { lastUserRaw = raw; break; }
    }
    if (!last) continue;
    let task = null;
    const lu = lastUserRaw != null ? unwrap(lastUserRaw).body.trim() : "";
    const m = CRON.exec(lu); if (m) task = m[1].trim();
    if (!task && key.indexOf(":cron:") >= 0) {
      for (const e of head) {
        if (!e || e.type !== "message" || !e.message || e.message.role !== "user") continue;
        const c = CRON.exec(unwrap(textOf(e.message.content).trim()).body.trim()); if (c) { task = c[1].trim(); break; }
      }
    }
    const u = last.role === "user" ? unwrap(last.raw) : { body: last.raw, sender: null };
    let body = u.body.trim(); if (task && last.role === "user") body = body.replace(CRON, "").trim();
    const o = { role: last.role, text: body.slice(0, 600) };
    if (u.sender && u.sender.id) o.senderId = String(u.sender.id).slice(0, 64);
    if (u.sender && u.sender.name) o.senderName = String(u.sender.name).slice(0, 64);
    if (task) o.task = task.slice(0, 80);
    out[key] = o;
  } catch {}
}
try { if (db) db.close(); } catch {}
process.stdout.write(JSON.stringify({ v: 1, s: out }));
`;

/** The shell that runs RECENT_SCRIPT for these conversations. Keys travel base64, so nothing in them reaches the shell. */
export function recentReadShell(slug: string, keys: string[]): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) throw new Error('unexpected agent slug');
  const s64 = Buffer.from(RECENT_SCRIPT, 'utf8').toString('base64');
  const k64 = Buffer.from(JSON.stringify(keys.slice(0, READ_SESSIONS)), 'utf8').toString('base64');
  return `SLUG='${slug}' KEYS_B64='${k64}' node -e "eval(Buffer.from('${s64}','base64').toString('utf8'))" 2>/dev/null || true`;
}

/** What RECENT_SCRIPT printed, checked field by field (it reads the agent's own files: not trusted). */
export function parseRecentRead(stdout: string): Record<string, { role: 'user' | 'assistant'; text: string; senderId?: string; senderName?: string; task?: string }> {
  let j: unknown;
  try { j = JSON.parse(stdout); } catch { return {}; }
  const s = (j as { v?: unknown; s?: unknown })?.s;
  if ((j as { v?: unknown })?.v !== 1 || !s || typeof s !== 'object') return {};
  const out: ReturnType<typeof parseRecentRead> = {};
  for (const [key, raw] of Object.entries(s as Record<string, unknown>)) {
    const r = raw as Record<string, unknown> | null;
    if (!r || (r.role !== 'user' && r.role !== 'assistant') || typeof r.text !== 'string') continue;
    const str = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? oneLine(v).slice(0, n) : undefined);
    out[key] = {
      role: r.role,
      text: r.text,
      ...(str(r.senderId, 64) ? { senderId: str(r.senderId, 64) } : {}),
      ...(str(r.senderName, 64) ? { senderName: str(r.senderName, 64) } : {}),
      ...(str(r.task, 80) ? { task: str(r.task, 80) } : {}),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;
const oneLine = (s: string) => s.replace(CONTROL, '').replace(/\s+/g, ' ').trim();

/**
 * A message as one plain line: no Hatchabot web-app marker, no OpenClaw
 * timestamp prefix, no markdown, no control or direction characters, cut to
 * `max` characters on a word where it can be.
 */
export function cleanPreview(raw: string, max = PREVIEW_MAX): string {
  let t = String(raw ?? '');
  t = t.replace(/^\s*\[[^\]\n]{1,60} via the web app\]\s*/, '');
  t = t.replace(/^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */, '');
  t = t.replace(/```[^\n]*\n?/g, ' ') // code fences (keep what was inside)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, '$1') // links
    .replace(/<\/?[a-zA-Z][^>]*>/g, '') // html tags
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/^\s{0,3}>\s?/gm, '') // quotes
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '') // list markers
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, ' ') // rules
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2') // bold, strike
    .replace(/(^|[\s(])[*_](?=\S)([^*_\n]*?\S)[*_](?=[\s).,!?:;]|$)/g, '$1$2') // italics
    .replace(/`+([^`]*)`+/g, '$1') // inline code
    .replace(/\|/g, ' ');
  t = oneLine(t);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:!?-]+$/, '') + '…';
}

// ---------------------------------------------------------------------------
// Capture: which conversations to read, and merging what came back
// ---------------------------------------------------------------------------

const atOf = (s: SessionEntry | undefined) => Math.max(Number(s?.updatedAt) || 0, Number(s?.lastInteractionAt) || 0);

/** Conversations that are a person's own (a web-chat guest's), read even when not among the newest. */
export const isPersonalKey = (key: string) => /^agent:[^:]+:(guest|web):[0-9a-f]{16}$/.test(key);

/**
 * The conversations to read now: the ones in the window that moved since the
 * record captured them (or never were), newest first — the newest few, plus
 * any person's own conversation. Empty when nothing moved: the common case,
 * and then no exec happens at all.
 */
export function keysToRead(sessions: Record<string, SessionEntry> | undefined, prev: RecentRecord | undefined, now = Date.now()): string[] {
  const since = now - RECENT_DAYS * 86_400_000;
  const moved = Object.entries(sessions ?? {})
    .filter(([key, s]) => !!s && typeof s === 'object' && !key.includes(':subagent:'))
    .map(([key, s]) => ({ key, at: atOf(s) }))
    .filter(({ key, at }) => at >= since && at > (prev?.sessions[key]?.at ?? 0))
    .sort((a, b) => b.at - a.at);
  const newest = moved.slice(0, 8).map((m) => m.key);
  const personal = moved.filter((m) => isPersonalKey(m.key) && !newest.includes(m.key)).map((m) => m.key);
  return [...newest, ...personal].slice(0, READ_SESSIONS);
}

/** The newest activity in a session list (as unread.ts's lastActiveFor). */
export function newestActivity(sessions: Record<string, SessionEntry> | undefined): number {
  let n = 0;
  for (const s of Object.values(sessions ?? {})) if (s && typeof s === 'object') n = Math.max(n, atOf(s));
  return n;
}

/**
 * The record after a sessions read (and, when one ran, a transcript read of
 * `read`'s keys): activity from the sessions, lines from the read, older
 * lines kept, conversations past the window or gone from the agent dropped.
 */
export function mergeRecent(
  prev: RecentRecord | undefined,
  sessions: Record<string, SessionEntry> | undefined,
  read: ReturnType<typeof parseRecentRead>,
  requested: string[] = Object.keys(read),
  now = Date.now(),
): RecentRecord {
  const since = now - RECENT_DAYS * 86_400_000;
  const lines: Record<string, RecentLine> = {};
  for (const [key, line] of Object.entries(prev?.sessions ?? {})) {
    if (sessions && !(key in sessions)) continue; // the conversation is gone (deleted, or a run cleaned up)
    if (line.at >= since) lines[key] = line;
  }
  // A conversation that was read but had nothing to show (only tool output,
  // say) is remembered as empty, so the next poll does not read it again.
  for (const key of requested) {
    if (!(key in read)) lines[key] = { at: atOf(sessions?.[key]) || now, role: 'assistant', text: '' };
  }
  for (const [key, r] of Object.entries(read)) {
    const at = atOf(sessions?.[key]) || now;
    const text = cleanPreview(r.text);
    if (!text && !r.task) continue;
    lines[key] = { at, role: r.role, text, ...(r.senderId ? { senderId: r.senderId } : {}), ...(r.senderName ? { senderName: cleanPreview(r.senderName, 40) } : {}), ...(r.task ? { task: cleanPreview(r.task, 60) } : {}) };
  }
  const kept = Object.entries(lines).sort((a, b) => b[1].at - a[1].at).slice(0, KEEP_SESSIONS);
  return {
    lastActiveAt: Math.max(newestActivity(sessions), prev?.lastActiveAt ?? 0),
    sessions: Object.fromEntries(kept),
  };
}

// ---------------------------------------------------------------------------
// What one person is shown
// ---------------------------------------------------------------------------

/**
 * Who is looking, as the console sees them:
 *  - owner: the owner's console reads every conversation;
 *  - guest: a web-chat guest's reads only their own (their console
 *    conversation, or their Hatchabot web-chat one);
 *  - none: anyone else (a Telegram-only member) reads nothing of it here.
 */
export type RecentViewer =
  | { kind: 'owner'; userId: string }
  | { kind: 'guest'; userId: string; keys: string[] }
  | { kind: 'none'; userId: string };

/** Names for the people on this agent, by a channel id or by their own conversation's key. */
export interface RecentPeople {
  /** Channel user id (Telegram, Discord, Slack) → the person's Hatchabot user id and name. */
  byChannelId: Map<string, { userId: string; name?: string }>;
  /** A guest's own conversation key → their user id and name. */
  byKey: Map<string, { userId: string; name?: string }>;
}

export interface RecentPreview {
  at: number;
  /** "you" (the viewer), "person" (someone else: `name`), "agent", or "task" (`task` ran). */
  by: 'you' | 'person' | 'agent' | 'task';
  name?: string;
  task?: string;
  text: string;
}

/** The conversations this viewer may read, newest first. */
function readable(record: RecentRecord, viewer: RecentViewer): Array<[string, RecentLine]> {
  if (viewer.kind === 'none') return [];
  const all = Object.entries(record.sessions).filter(([, l]) => l.text || l.task).sort((a, b) => b[1].at - a[1].at);
  if (viewer.kind === 'owner') return all;
  return all.filter(([key]) => viewer.keys.includes(key));
}

/**
 * The line this viewer is shown for an agent, or undefined. Only from a
 * conversation they could read in its console; a speaker nobody can name is
 * "Someone", never a guess at who.
 */
export function previewFor(record: RecentRecord | undefined, viewer: RecentViewer, people: RecentPeople): RecentPreview | undefined {
  if (!record) return undefined;
  const [key, line] = readable(record, viewer)[0] ?? [];
  if (!key || !line) return undefined;
  if (line.task) return { at: line.at, by: 'task', task: line.task, text: line.role === 'assistant' ? line.text : '' };
  if (line.role === 'assistant') return { at: line.at, by: 'agent', text: line.text };
  // A person's line: whose?
  const own = people.byKey.get(key);
  if (own) return own.userId === viewer.userId ? { at: line.at, by: 'you', text: line.text } : { at: line.at, by: 'person', name: own.name || 'Someone', text: line.text };
  if (isPersonalKey(key)) return undefined; // someone's own conversation we cannot place: say nothing
  if (line.senderId) {
    const who = people.byChannelId.get(line.senderId);
    if (who?.userId === viewer.userId) return { at: line.at, by: 'you', text: line.text };
    return { at: line.at, by: 'person', name: who?.name || line.senderName || 'Someone', text: line.text };
  }
  // Typed at the console (no channel envelope): only the owner reaches these conversations.
  return viewer.kind === 'owner' ? { at: line.at, by: 'you', text: line.text } : undefined;
}

/** The one dim line under a row: a Alerts state first, else who said what, else the task that ran. */
export function previewLine(p: RecentPreview | undefined, needsYou?: string): string {
  if (needsYou) return cleanPreview(`alert: ${needsYou}`);
  if (!p) return '';
  if (p.by === 'task') return `⏰ ${p.task} ran`;
  if (p.by === 'you') return cleanPreview(`You: ${p.text}`);
  if (p.by === 'person') return cleanPreview(`${p.name}: ${p.text}`);
  return p.text;
}

export interface RecentRow {
  id: string;
  at: number;
  unread: boolean;
}

/**
 * The rows, in order: only agents active in the last RECENT_DAYS; for the
 * home screen (`all` false) unread ones first, then newest first, at most
 * RECENT_CAP; for "Show all", every one, newest first.
 */
export function orderRecent<T extends RecentRow>(rows: T[], opts: { now?: number; all?: boolean; cap?: number } = {}): T[] {
  const since = (opts.now ?? Date.now()) - RECENT_DAYS * 86_400_000;
  const inWindow = rows.filter((r) => r.at > 0 && r.at >= since);
  const newest = (a: T, b: T) => b.at - a.at || a.id.localeCompare(b.id);
  if (opts.all) return inWindow.sort(newest);
  return inWindow.sort((a, b) => Number(b.unread) - Number(a.unread) || newest(a, b)).slice(0, opts.cap ?? RECENT_CAP);
}

/** A stored record, checked (it came from the database, but shapes change between releases). */
export function asRecentRecord(v: unknown): RecentRecord | undefined {
  const r = v as Partial<RecentRecord> | null | undefined;
  if (!r || typeof r !== 'object' || typeof r.lastActiveAt !== 'number' || !r.sessions || typeof r.sessions !== 'object') return undefined;
  const sessions: Record<string, RecentLine> = {};
  for (const [k, l] of Object.entries(r.sessions)) {
    if (l && typeof l === 'object' && typeof l.at === 'number' && (l.role === 'user' || l.role === 'assistant') && typeof l.text === 'string') sessions[k] = l;
  }
  return { lastActiveAt: r.lastActiveAt, sessions };
}

/**
 * Keeps each agent's record current, riding on the sessions reads the app's
 * poll already does: `note` is handed every fresh read. A read that shows no
 * moved conversation costs a database look at most; one that does runs ONE
 * exec for the moved conversations, in the background, one at a time per
 * agent. Only ever called with a RUNNING agent's read — nothing here starts,
 * wakes or execs into an agent that is asleep or stopped.
 */
export class RecentTracker {
  readonly #inFlight = new Set<string>();
  constructor(private readonly deps: {
    get: (agentId: string) => unknown;
    set: (agentId: string, record: RecentRecord) => void;
    /** Run a shell in the agent's container (only ever a running one). */
    exec: (agentId: string, script: string) => Promise<{ code: number; stdout: string }>;
    now?: () => number;
  }) {}

  record(agentId: string): RecentRecord | undefined {
    return asRecentRecord(this.deps.get(agentId));
  }

  /** A fresh sessions read for a running agent. Resolves when any capture it started is stored. */
  async note(agent: { id: string; slug: string }, sessions: Record<string, unknown> | undefined): Promise<void> {
    if (!sessions || this.#inFlight.has(agent.id)) return;
    const now = this.deps.now?.() ?? Date.now();
    const s = sessions as Record<string, SessionEntry>;
    const prev = this.record(agent.id);
    const keys = keysToRead(s, prev, now);
    if (!keys.length) {
      // Nothing new to read; only the activity time may have moved.
      const at = newestActivity(s);
      if (!prev || at > prev.lastActiveAt) this.deps.set(agent.id, mergeRecent(prev, s, {}, [], now));
      return;
    }
    this.#inFlight.add(agent.id);
    try {
      const res = await this.deps.exec(agent.id, recentReadShell(agent.slug, keys));
      // No answer from the script (node missing, a crash): nothing is marked read, the next poll tries again.
      if (res.code !== 0 || !/^\{"v":1,/.test(res.stdout.trim())) return;
      this.deps.set(agent.id, mergeRecent(this.record(agent.id), s, parseRecentRead(res.stdout), keys, now));
    } catch {
      /* a container hiccup: the next poll tries again */
    } finally {
      this.#inFlight.delete(agent.id);
    }
  }
}
