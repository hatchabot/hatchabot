import { createHash } from 'node:crypto';
import type { Agent } from '../domain/types.js';
import type { ExecResult, RuntimeProvider } from '../providers/provider.js';

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
 * base64 JSON { agentId, sessionKey, message, scopes, rights, timeoutMs }.
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
} else if (mode === "password") {
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
      idempotencyKey: "hb-web-" + crypto.randomUUID(),
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
export function turnScript(req: { agentId: string; sessionKey: string; message: string; rights: WebChatRights; timeoutMs: number }): string {
  if (!SLUG_RE.test(req.agentId) || !/^web:[0-9a-f]{16}$/.test(req.sessionKey)) throw new Error('unexpected agent slug or session key');
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
  turn: { userId: string; displayName: string; text: string; rights: WebChatRights },
  timeoutMs: number,
): Promise<WebChatTurnResult> {
  const message = `${webChatPrefix(turn.displayName)}\n${turn.text}`;
  const script = turnScript({ agentId: agent.slug, sessionKey: webChatSessionKey(turn.userId), message, rights: turn.rights, timeoutMs });
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
