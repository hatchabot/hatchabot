import { createHash } from 'node:crypto';
import type { Agent } from '../../domain/types.js';
import type { ExecResult, RuntimeProvider } from '../../providers/provider.js';

/**
 * Chat on the web (2026-09-29): a person the owner trusts talks to an agent
 * from Hatchabot's own page instead of a chat app.
 *
 * Step 2: a guest's turn is a NON-OWNER turn — a member's rights, exactly like
 * a Telegram member's. OpenClaw decides owner status per turn from the
 * gateway client's scopes: the `agent` RPC sets senderIsOwner only when the
 * connection holds `operator.admin` (2026.9.6 agent-turn-service,
 * clientHasAdminScope; the same test in 2026.7.1-2's agent handler). A
 * non-owner turn loses the owner-only tools (GATEWAY_OWNER_ONLY_CORE_TOOLS:
 * `automations` — the old `cron` — `gateway`, `plugins`, `sessions`, `nodes`,
 * `terminal`, `computer`, `conversations_*`, `openclaw`, …) and the
 * admin-only commands (/config set, /new, /reset).
 *
 * So the turn is sent by a small WebSocket client run INSIDE the agent's
 * container, on loopback, with the gateway's own shared token and only
 * `operator.read` + `operator.write` — the same trusted local backend path
 * OpenClaw's own helpers use. Nothing in the agent's config changes, the
 * owner's console authenticates exactly as before, and Hatchabot stays the
 * only thing the gateway trusts. The client refuses to send the message
 * unless the gateway's hello proves the connection holds no admin scope.
 * Proven live 2026-09-29 on a throwaway 2026.9.6 agent: the step-1 CLI turn
 * reported `automations` and `gateway` callable, this path did not.
 *
 * The agent's own owner keeps owner rights (they have the console anyway).
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
export const WEB_CHAT_MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function webChatPrefix(displayName: string, messageId?: string): string {
  // Brackets and line breaks would let a chosen name close the marker early
  // and pass what follows as something else.
  const name = displayName.replace(/[[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48) || 'Someone';
  if (messageId !== undefined && !WEB_CHAT_MESSAGE_ID.test(messageId)) throw new Error('invalid web chat message id');
  return `[${name} via the web app${messageId ? `; message ${messageId}` : ''}]`;
}

const PREFIX_RE = /^\s*\[[^\]\n]{1,60} via the web app(?:; message ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?\]\s*\n?/;
export function stripWebChatPrefix(text: string): string {
  return text.replace(PREFIX_RE, '');
}

/** Whose rights a web turn carries: the agent's owner, or a member (every guest). */
export type WebChatRights = 'owner' | 'member';

/** The gateway scopes each kind of turn connects with. A member's never include operator.admin. */
export const WEB_CHAT_SCOPES: Record<WebChatRights, readonly string[]> = {
  member: ['operator.read', 'operator.write'],
  owner: ['operator.admin', 'operator.read', 'operator.write'],
};

/** What the in-container client says by its exit code. */
export const TURN_EXIT = {
  /** The gateway did not prove a member's turn would be a non-owner turn. */
  rightsUnproven: 21,
  /** The gateway refused it as owner-only (a /new, /reset or /config command). */
  ownerOnly: 23,
  /** A run of this session is already in flight. */
  inFlight: 25,
  timeout: 124,
} as const;

export type WebChatTurnResult =
  | { kind: 'reply'; text: string }
  | { kind: 'timeout' }
  | { kind: 'busy' }
  /** Something only the owner may do (a /new, /reset or /config command). */
  | { kind: 'owner-only' }
  /** This agent's gateway could not be made to run a limited turn: never falls back to the owner's. */
  | { kind: 'needs-rebuild'; detail: string }
  | { kind: 'failed'; code: number; detail: string };

/**
 * The in-container client (CommonJS, node 22+: global WebSocket). REQ is
 * base64 JSON { agentId, sessionKey, message, messageId?, scopes, rights, timeoutMs }.
 * Prints the reply on stdout; see TURN_EXIT for the rest. The gateway's
 * credential never leaves the container: it is read from the agent's own
 * openclaw.json, as the agent's own CLI reads it.
 */
export const TURN_SCRIPT = String.raw`
// hatchabot-webchat-turn
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const env = process.env;
const done = (code, msg) => { if (msg) process.stderr.write(String(msg).slice(0, 2000)); process.exit(code); };
let req;
try { req = JSON.parse(Buffer.from(env.REQ || "", "base64").toString("utf8")); } catch { done(2, "bad request"); }
const member = req.rights !== "owner";
const scopes = Array.isArray(req.scopes) ? req.scopes.map(String) : [];
if (member && scopes.includes("operator.admin")) done(2, "a member turn asked for operator.admin");
setTimeout(() => done(124, "no answer in time"), Math.max(1000, Number(req.timeoutMs) || 280000)).unref();
if (typeof WebSocket !== "function") done(21, "this runtime's node has no WebSocket client");
const home = env.HOME || "/home/node";
const cfgPath = env.CFG_PATH || env.OPENCLAW_CONFIG_PATH || path.join(env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw"), "openclaw.json");
let cfg;
// No parse detail: it can quote the file, credential and all.
try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch (e) { done(21, "gateway config unreadable (" + String((e && e.code) || e && e.name || "error") + ")"); }
const gw = (cfg && cfg.gateway) || {}, a = gw.auth || {};
const mode = a.mode || (a.token ? "token" : a.password ? "password" : "none");
let auth;
if (mode === "token") {
  const t = typeof a.token === "string" ? a.token : env.OPENCLAW_GATEWAY_TOKEN;
  if (!t) done(21, "no gateway token");
  auth = { token: t };
} else if (mode === "password" || mode === "trusted-proxy") {
  // The console with identities: people come through Hatchabot's proxy, and
  // this local client uses the loopback password, as the agent's own CLI does.
  const p = typeof a.password === "string" ? a.password : env.OPENCLAW_GATEWAY_PASSWORD;
  if (!p) done(21, "no gateway password");
  auth = { password: p };
} else if (mode !== "none") done(21, "gateway auth mode " + mode + " is not supported");
const port = Number(env.GW_PORT || gw.port) || 18789;
const ws = new WebSocket("ws://127.0.0.1:" + port);
let n = 0, finished = false;
const pending = new Map();
const call = (method, params) => new Promise((resolve, reject) => {
  const id = "hb" + (++n);
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ type: "req", id, method, params }));
});
const textOf = (payloads) => (Array.isArray(payloads) ? payloads : []).map((p) => {
  if (!p) return "";
  const t = typeof p.text === "string" ? p.text.trim() : "";
  const m = typeof p.mediaUrl === "string" && p.mediaUrl ? p.mediaUrl : "";
  return [t, m].filter(Boolean).join("\n");
}).filter(Boolean).join("\n\n");
const refusedAsOwnerOnly = (e) => /missing scope|operator\.admin/i.test(String((e && (e.message || e.code)) || ""));
async function run() {
  const hello = await call("connect", {
    minProtocol: 4, maxProtocol: 4,
    client: { id: "gateway-client", version: "hatchabot-webchat", platform: process.platform, mode: "backend", displayName: "Hatchabot web chat" },
    role: "operator", scopes, caps: [], ...(auth ? { auth } : {}),
  });
  const granted = hello && hello.auth && Array.isArray(hello.auth.scopes) ? hello.auth.scopes : null;
  // The proof: a member's message is sent only on a connection the gateway
  // itself says holds no operator.admin. Anything else is refused here.
  if (member && (!granted || granted.includes("operator.admin"))) {
    done(21, "the gateway did not limit this connection (granted: " + JSON.stringify(granted) + ")");
  }
  let res;
  try {
    res = await call("agent", {
      message: String(req.message || ""), agentId: req.agentId, sessionKey: req.sessionKey,
      deliver: false, timeout: Math.max(1, Math.floor((Number(req.timeoutMs) || 280000) / 1000)),
      idempotencyKey: "hb-web-" + (req.messageId ? req.sessionKey + "-" + req.messageId : crypto.randomUUID()),
    });
  } catch (e) {
    if (member && refusedAsOwnerOnly(e)) done(23, "owner-only: " + JSON.stringify(e));
    done(1, "agent call failed: " + JSON.stringify(e));
  }
  finished = true;
  const status = res && res.status;
  if (status === "ok" || status === "completed") { process.stdout.write(textOf(res.result && res.result.payloads), () => done(0)); return; }
  if (status === "timeout") done(124, "the run timed out");
  if (status === "in_flight") done(25, "a run is already in flight");
  done(1, "run ended " + String(status) + ": " + String((res && res.summary) || "").slice(0, 300));
}
ws.onmessage = (ev) => {
  let f; try { f = JSON.parse(String(ev.data)); } catch { return; }
  if (f.type === "event" && f.event === "connect.challenge") { run().catch((e) => done(1, "handshake failed: " + JSON.stringify(e && (e.message || e)))); return; }
  if (f.type !== "res") return;
  const p = pending.get(f.id); if (!p) return;
  // The agent RPC answers twice: "accepted" first, then the final result.
  if (f.ok && f.payload && f.payload.status === "accepted") return;
  pending.delete(f.id);
  if (f.ok) p.resolve(f.payload); else p.reject(f.error || { message: "error" });
};
ws.onerror = (e) => { if (!finished) done(1, "gateway connection failed: " + String((e && e.message) || "")); };
ws.onclose = (e) => { if (!finished) done(1, "gateway closed the connection: " + String(e && e.code) + " " + String((e && e.reason) || "")); };
`;

/**
 * The shell that runs TURN_SCRIPT in the container. Every value is base64
 * (a fixed character set), so plain quoting is safe; the message itself is
 * inside REQ and never meets the shell.
 */
export function turnScript(req: { agentId: string; sessionKey: string; message: string; messageId?: string; rights: WebChatRights; timeoutMs: number }): string {
  if (!SLUG_RE.test(req.agentId) || !/^web:[0-9a-f]{16}$/.test(req.sessionKey)) throw new Error('unexpected agent slug or session key');
  if (req.messageId !== undefined && !WEB_CHAT_MESSAGE_ID.test(req.messageId)) throw new Error('invalid web chat message id');
  const body = { ...req, scopes: WEB_CHAT_SCOPES[req.rights] };
  const b64 = Buffer.from(TURN_SCRIPT, 'utf8').toString('base64');
  const r64 = Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
  return `T=/tmp/hatchabot-webturn-$$.cjs; echo ${b64} | base64 -d > $T || exit 2; REQ='${r64}' node $T; rc=$?; rm -f $T; exit $rc`;
}

/**
 * THE transport: one turn in this person's web session. A guest's turn is a
 * member's (non-owner) turn; only the agent's owner gets an owner's. When the
 * agent's gateway cannot prove the limit, the answer is 'needs-rebuild' —
 * never the owner's path instead.
 */
export async function runWebChatTurn(
  provider: RuntimeProvider,
  agent: Pick<Agent, 'slug' | 'runtimeRef'>,
  turn: { userId: string; displayName: string; text: string; messageId?: string; rights: WebChatRights },
  timeoutMs: number,
): Promise<WebChatTurnResult> {
  const message = `${webChatPrefix(turn.displayName, turn.messageId)}\n${turn.text}`;
  const script = turnScript({ agentId: agent.slug, sessionKey: webChatSessionKey(turn.userId), message, messageId: turn.messageId, rights: turn.rights, timeoutMs });
  // The client stops itself at timeoutMs; the exec gets a little longer so it can say so.
  const res: ExecResult = await provider.execShell(agent.runtimeRef!, script, { timeoutMs: timeoutMs + 15_000 });
  const detail = (res.stderr || res.stdout || '').slice(-300);
  if (res.timedOut || res.code === TURN_EXIT.timeout) return { kind: 'timeout' };
  if (res.code === 0) return { kind: 'reply', text: res.stdout.trim() };
  if (res.code === TURN_EXIT.rightsUnproven) return { kind: 'needs-rebuild', detail };
  if (res.code === TURN_EXIT.ownerOnly) return { kind: 'owner-only' };
  if (res.code === TURN_EXIT.inFlight) return { kind: 'busy' };
  return { kind: 'failed', code: res.code, detail };
}

export interface WebChatMessage {
  role: 'user' | 'assistant';
  text: string;
  at?: string;
  messageId?: string;
}

/**
 * Reads one session's dialogue inside the container (or off the stopped
 * agent's volume). Static text: the slug and the store key arrive as env
 * values, both validated to a fixed character set before they get here.
 *
 *  - 2026.9 keeps sessions in the agent's openclaw-agent.sqlite: every
 *    session window of the key (session_windows — a reset starts a new one)
 *    and their transcript_events, plus any archived window.
 *  - 2026.7 keeps sessions/sessions.json (key → sessionId) and <id>.jsonl;
 *    a reset renames the file <id>.jsonl.reset.<ts>, and its key is only
 *    in the session's <id>.trajectory.jsonl ("session.started"), when kept.
 */
export const HISTORY_SCRIPT = String.raw`
// hatchabot-webchat-history
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const env = process.env;
const root = (env.AGENTS_DIR || "/home/node/.openclaw/agents") + "/" + env.SLUG; // AGENTS_DIR: tests only
const key = env.SKEY, cap = Number(env.CAP) || 100;
const wanted = new Set((env.PENDING || "").split(",").filter(Boolean)), received = new Set();
let complete = true;
const prefix = /^\s*\[[^\]\n]{1,60} via the web app(?:; message ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?\]/;
const NL = String.fromCharCode(10);
// An image-only reply is still a reply: shown as [image], not dropped.
const textOf = (c) => typeof c === "string" ? c : Array.isArray(c)
  ? c.map((p) => !p ? "" : p.type === "text" ? p.text : /image/.test(p.type || "") ? "[image]" : "").filter(Boolean).join(NL) : "";
// What textOf shows as [image], told apart: two different pictures are two
// replies, though both read "[image]" (HB-0912).
const imagesOf = (c) => {
  const parts = Array.isArray(c) ? c.filter((p) => p && p.type !== "text" && /image/.test(p.type || "")) : [];
  if (!parts.length) return "";
  const h = require("crypto").createHash("sha256");
  for (const p of parts) h.update(JSON.stringify(p) + NL);
  return h.digest("hex");
};
// Read newest first, and only as far back as the newest CAP need: a long
// chat read its whole history, and kept every id in it, to show 100
// (HB-0897, HB-1172). Each message keeps the place reading oldest first
// gave it (its source in that order, then its place there), so the order,
// and the copies dropped, are as they were. A source is read until its
// events are an hour older than the oldest of the newest CAP (its times may
// step back a little); while a delivery id is not found yet, the rest is
// only looked through for it, as all of it was before.
//
// An event recorded twice (a window as it moves to an archive) kept the
// place of the copy reading oldest first met first. Newest first, the copy
// met first can be the other: on meeting a second copy, all of it is read
// again oldest first, as before, at what that cost (HB-1172).
const seen = new Set(), keep = [];
let fwd = false, stop = false; // fwd: all of it, oldest first; stop: a copy met
const order = (a, b) => (a.ms - b.ms) || (a.r - b.r) || (a.p - b.p);
const SLACK = 3600000;
let floor = null; // the oldest of the newest CAP so far: nothing older can show
const looking = () => received.size < wanted.size;
const emit = (m) => {
  keep.push(m);
  if (keep.length === cap) { keep.sort(order); floor = keep[0]; }
  else if (keep.length >= 2 * cap + 64) { keep.sort(order); keep.splice(0, keep.length - cap); floor = keep[0]; }
};
// A delivered reply is recorded twice, same text, at the same moment: keep
// one. The same words sent again later (a daily notice) are a new message,
// and so is a different picture (one a copy marks as a delivery's, before
// or after it, is not).
// Replies with the same text one after another are held as a run, newest
// first, and decided oldest first against the reply before them, as reading
// forward did.
let run = [], lastRank = null, head;
const settle = (prev = null) => {
  const n = run.length;
  for (let k = 0; k < n; k++) {
    const m = run[fwd ? k : n - 1 - k];
    if (prev && prev.role === "assistant" && prev.text === m.text && (prev.img === m.img || prev.mirror || m.mirror) && Math.abs(m.ms - prev.ms) < 60000) continue;
    prev = m; emit(m);
  }
  if (n && head === undefined) head = prev; // newest first, the newest kept of all read
  run = [];
};
// Source r begins: a run goes on into it only from the source next to it.
const begin = (r) => { if (run.length && r !== lastRank + (fwd ? 1 : -1)) settle(); lastRank = r; };
// One event of source r, at place p. False: nothing older in it can show.
const take = (e, r, p) => {
  if (!e || typeof e !== "object") { complete = false; return true; }
  const m = e.message;
  const raw = e.timestamp || (m && m.timestamp) || "";
  const when = typeof raw === "string" ? Date.parse(raw) : typeof raw === "number" ? raw : NaN;
  // Older than all that can show, and no run held that it could change.
  const past = !fwd && !!floor && !run.length && when < floor.ms - SLACK;
  if (past && !looking()) return false;
  if (e.type !== "message" || !m) return true;
  if (!past && e.id) { if (seen.has(e.id)) { if (fwd) return true; stop = true; return false; } seen.add(e.id); }
  const role = m.role;
  if (role !== "user" && role !== "assistant") return true;
  const t = textOf(m.content).trim();
  if (!t || t === "NO_REPLY" || t.indexOf("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>") === 0) return true;
  // What OpenClaw itself put in the conversation (a finished background task
  // arrives as a "user" message with provenance inter_session) is not
  // something this person wrote. What they wrote carries the web-app line.
  if (role === "user" && m.provenance && !prefix.test(t)) return true;
  const messageId = role === "user" ? prefix.exec(t)?.[1] : undefined;
  if (messageId && wanted.has(messageId)) received.add(messageId);
  if (past) return true;
  const at = typeof raw === "string" ? raw : new Date(raw).toISOString();
  const c = { role, text: t, at, ms: Date.parse(at) || 0, r, p, img: role === "assistant" ? imagesOf(m.content) : "", mirror: !!(m.openclawDeliveryMirror || m.model === "delivery-mirror") };
  if (run.length && (role !== "assistant" || run[0].text !== t)) settle();
  if (role === "assistant") run.push(c);
  else { emit(c); if (head === undefined) head = c; }
  return true;
};
const line = (l, r, p) => { let e; try { e = JSON.parse(l); } catch { complete = false; return true; } return take(e, r, p); };
// All of it again, oldest first, from nothing kept.
const again = (pass) => {
  seen.clear(); keep.length = 0; run = []; lastRank = null; head = undefined; floor = null; received.clear();
  stop = false; fwd = true; pass();
};
// Text from its start, a line at a time (oldest first).
const linesOn = (text, r) => { let at = 0, i, p = 0; while ((i = text.indexOf(NL, at)) >= 0) { const l = text.slice(at, i); if (l) line(l, r, p++); at = i + 1; } const l = text.slice(at); if (l) line(l, r, p++); };
// A file from its start, a megabyte at a time (oldest first).
const fileLinesOn = (file, r) => {
  const fd = fs.openSync(file, "r");
  try {
    const dec = new (require("string_decoder").StringDecoder)("utf8"), buf = Buffer.alloc(1 << 20);
    let rest = "", p = 0;
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) {
      rest += dec.write(buf.subarray(0, n));
      let at = 0, i;
      while ((i = rest.indexOf(NL, at)) >= 0) { const l = rest.slice(at, i); if (l) line(l, r, p++); at = i + 1; }
      rest = rest.slice(at);
    }
    rest += dec.end();
    if (rest) line(rest, r, p++);
  } finally { try { fs.closeSync(fd); } catch {} }
};
// Text from its end, a line at a time.
const linesBack = (text, r) => {
  let end = text.length, p = 0;
  for (;;) {
    const i = end > 0 ? text.lastIndexOf(NL, end - 1) : -1;
    const l = text.slice(i + 1, end);
    if (l && !line(l, r, p--)) return;
    if (i < 0) return;
    end = i;
  }
};
// A file from its end, a megabyte at a time: never all of it at once.
const fileLinesBack = (file, r) => {
  const fd = fs.openSync(file, "r");
  try {
    let pos = fs.fstatSync(fd).size, tail = [], p = 0;
    while (pos > 0) {
      const n = Math.min(1 << 20, pos), b = Buffer.alloc(n); pos -= n;
      let got = 0;
      while (got < n) { const k = fs.readSync(fd, b, got, n - got, pos + got); if (k <= 0) break; got += k; }
      let end = got;
      for (let i; end > 0 && (i = b.lastIndexOf(10, end - 1)) >= 0; end = i) {
        const piece = b.subarray(i + 1, end);
        const l = (tail.length ? Buffer.concat([piece, ...tail]) : piece).toString("utf8");
        tail = [];
        if (l && !line(l, r, p--)) return;
      }
      if (end > 0) tail.unshift(b.subarray(0, end)); // a line that began in an earlier megabyte
    }
    const l = Buffer.concat(tail).toString("utf8");
    if (l) line(l, r, p--);
  } finally { try { fs.closeSync(fd); } catch {} }
};
// StatementSync.iterate came in the release that took node:sqlite out from
// behind its flag (Node 22.13.0 and 23.4.0): on an older Node the require
// below fails and no database is read at all, so where the database is read,
// iterate is there. OpenClaw 2026.9, which writes the database, needs Node
// 24.16+ (scripts/build-runtime-image.sh), and a stopped agent is read in
// the default runtime image, which Hatchabot builds on node:22-slim or newer.
// The .all() is a guard only: it holds a whole window in memory (HB-1172).
const each = (q, ...args) => typeof q.iterate === "function" ? q.iterate(...args) : q.all(...args);
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
      const q = db.prepare("SELECT seq, event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq DESC");
      // An archive is read only when it is reached: one at a time.
      let arch = null, rowids = null;
      try { rowids = db.prepare("SELECT rowid AS rid FROM session_transcript_archives WHERE session_key = ?").all(key).map((a) => a.rid); }
      catch (e) {
        if (/no such table/i.test(String(e && e.message))) rowids = [];
        else if (/no such column/i.test(String(e && e.message))) arch = [...each(db.prepare("SELECT encoding, archive_blob FROM session_transcript_archives WHERE session_key = ?"), key)];
        else throw e;
      }
      const one = rowids ? db.prepare("SELECT encoding, archive_blob FROM session_transcript_archives WHERE rowid = ?") : null;
      const count = rowids ? rowids.length : arch.length;
      const qOn = db.prepare("SELECT seq, event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq");
      const windowOf = (w) => {
        begin(w);
        for (const row of each(fwd ? qOn : q, ids[w])) {
          let j = row.event_json;
          if (j == null && row.event_zstd) { try { j = zlib.zstdDecompressSync(Buffer.from(row.event_zstd)).toString("utf8"); } catch { complete = false; continue; } }
          if (typeof j !== "string") { complete = false; continue; }
          let go = true;
          try { go = take(JSON.parse(j), w, Number(row.seq)); } catch { complete = false; }
          if (!go) break;
        }
      };
      const archiveOf = (a) => {
        const row = rowids ? one.get(rowids[a]) : arch[a];
        if (!row) return;
        begin(ids.length + a);
        try { (fwd ? linesOn : linesBack)(row.encoding === "zstd" ? zlib.zstdDecompressSync(Buffer.from(row.archive_blob)).toString("utf8") : Buffer.from(row.archive_blob).toString("utf8"), ids.length + a); } catch { complete = false; }
      };
      const pass = () => {
        // Oldest first: each window of the key, then its archived ones.
        if (fwd) { for (let w = 0; w < ids.length; w++) windowOf(w); for (let a = 0; a < count; a++) archiveOf(a); return; }
        // Newest first: the windows, then the archives. The archives come
        // after every window, read oldest first: the first of them follows
        // the newest kept of the windows.
        for (let w = ids.length - 1; w >= 0 && !stop; w--) windowOf(w);
        settle();
        const lead = head === undefined ? null : head;
        for (let a = count - 1; a >= 0 && !stop; a--) archiveOf(a);
        if (count) settle(lead);
      };
      pass();
      if (stop) again(pass);
    }
  } catch (e) {
    // Busy, locked, corrupt: say so rather than show an empty conversation.
    process.stderr.write("history read failed: " + String((e && e.message) || e));
    process.exit(3);
  } finally { try { if (db) db.close(); } catch {} }
}
if (!fromDb) {
  const sd = path.join(root, "sessions");
  // Absent is a conversation not started yet; unreadable or corrupt is a
  // read that failed, and says so (the panel offers to try again).
  const failed = (what, e) => { process.stderr.write("history read failed: " + what + ": " + String((e && (e.code || e.message)) || e)); process.exit(3); };
  const read = (f) => { try { return fs.readFileSync(path.join(sd, f), "utf8"); } catch (e) { if (e && e.code === "ENOENT") return null; failed(f, e); } };
  // A conversation's file: false when it is not there.
  const readLines = (f, r) => { try { (fwd ? fileLinesOn : fileLinesBack)(path.join(sd, f), r); return true; } catch (e) { if (e && e.code === "ENOENT") return false; failed(f, e); } };
  let sid = null;
  const index = read("sessions.json");
  if (index != null) {
    let j; try { j = JSON.parse(index); } catch (e) { failed("sessions.json", e); }
    sid = j && j[key] && j[key].sessionId;
  }
  // Conversations of this key that a reset ended, oldest first.
  let files = [];
  try { files = fs.readdirSync(sd); } catch (e) { if (!e || e.code !== "ENOENT") failed("the sessions folder", e); }
  const ofKey = (id) => {
    for (const f of files) {
      if (f.indexOf(id + ".trajectory.jsonl") !== 0) continue;
      let fd; try { fd = fs.openSync(path.join(sd, f), "r"); } catch { complete = false; continue; }
      try {
        const b = Buffer.alloc(65536); const n = fs.readSync(fd, b, 0, b.length, 0);
        for (const l of b.subarray(0, n).toString("utf8").split(String.fromCharCode(10))) {
          if (!l) continue;
          let t; try { t = JSON.parse(l); } catch { complete = false; continue; }
          if (t && t.type === "session.started") return t.sessionKey === key;
        }
      } finally { try { fs.closeSync(fd); } catch {} }
    }
    // An unclassified reset could hold this person's pending message.
    // Readable history is still useful, but cannot prove its absence.
    complete = false;
    return false;
  };
  const resets = files.map((f) => /^([A-Za-z0-9-]+)\.jsonl\.reset\.(.+)$/.exec(f)).filter((m) => m && m[1] !== sid && ofKey(m[1]))
    .sort((a, b) => (a[2] < b[2] ? -1 : 1));
  const pass = () => {
    // Oldest first: the resets, then the current conversation.
    if (fwd) {
      for (let k = 0; k < resets.length; k++) { begin(k); if (!readLines(resets[k][0], k)) complete = false; }
      if (sid && /^[A-Za-z0-9-]+$/.test(sid)) { begin(resets.length); if (!readLines(sid + ".jsonl", resets.length)) complete = false; }
      return;
    }
    // Newest first: the current conversation, then the resets.
    if (sid && /^[A-Za-z0-9-]+$/.test(sid)) { begin(resets.length); if (!readLines(sid + ".jsonl", resets.length)) complete = false; }
    for (let k = resets.length - 1; k >= 0 && !stop; k--) { begin(k); if (!readLines(resets[k][0], k)) complete = false; }
  };
  pass();
  if (stop) again(pass);
}
settle();
keep.sort(order);
const messages = keep.slice(-cap).map((m) => ({ role: m.role, text: m.text, at: m.at }));
process.stdout.write(JSON.stringify({ messages, delivery: { checked: complete ? [...wanted] : [], received: [...wanted].filter((id) => received.has(id)) } }));
`;

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KEY_RE = /^agent:[a-z0-9][a-z0-9_-]{0,63}:web:[0-9a-f]{16}$/;

export function historyScript(slug: string, storeKey: string, cap = 100, pending: readonly string[] = []): string {
  if (!SLUG_RE.test(slug) || !KEY_RE.test(storeKey)) throw new Error('unexpected agent slug or session key');
  if (pending.length > 100 || pending.some((id) => !WEB_CHAT_MESSAGE_ID.test(id))) throw new Error('invalid web chat delivery ids');
  const b64 = Buffer.from(HISTORY_SCRIPT, 'utf8').toString('base64');
  // Every value is from a fixed character set (checked above), so plain quoting is safe.
  return `set -e; T=/tmp/hatchabot-webchat-$$.cjs; echo ${b64} | base64 -d > $T; SLUG='${slug}' SKEY='${storeKey}' CAP='${Math.max(1, Math.min(500, Math.floor(cap)))}' PENDING='${pending.join(',')}' node $T; rm -f $T`;
}

/** This person's conversation with its web marker removed, plus requested
 * delivery evidence from the entire readable transcript, before the cap. */
export async function webChatHistory(
  provider: RuntimeProvider,
  agent: Pick<Agent, 'slug' | 'runtimeRef' | 'state'>,
  userId: string,
  cap = 100,
  pending: readonly string[] = [],
): Promise<{ messages: WebChatMessage[]; delivery?: { checked: string[]; received: string[] } }> {
  const s = historyScript(agent.slug, webChatStoreKey(agent.slug, userId), cap, pending);
  const res = agent.state === 'RUNNING'
    ? await provider.execShell(agent.runtimeRef!, s)
    : await provider.execShellOnVolume(agent.runtimeRef!, s, { readOnly: true });
  if (res.code !== 0) throw new Error((res.stderr || res.stdout || 'history read failed').slice(-200));
  const j = JSON.parse(res.stdout || '{}') as { messages?: Array<{ role?: string; text?: string; at?: string }>; delivery?: { checked?: string[]; received?: string[] } };
  const messages = (j.messages ?? [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      text: m.role === 'user' ? stripWebChatPrefix(m.text!) : m.text!,
      ...(m.at ? { at: m.at } : {}),
      ...(m.role === 'user' && PREFIX_RE.exec(m.text!)?.[1] ? { messageId: PREFIX_RE.exec(m.text!)![1] } : {}),
    }));
  const requested = new Set(pending);
  const relevant = (ids: unknown) => Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && requested.has(id)) : [];
  return { messages, ...(pending.length ? { delivery: { checked: relevant(j.delivery?.checked), received: relevant(j.delivery?.received) } } : {}) };
}
