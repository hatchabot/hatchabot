import type { RuntimeProvider } from '../providers/provider.js';

/**
 * Per-agent token usage: what each model call actually used, summed over the
 * agent's transcripts. Every assistant message OpenClaw records carries the
 * call's `usage` — input, output, cache reads and cache writes — in the
 * agent's own store (2026.9: `transcript_events` in each agent's SQLite
 * database, zstd-compressed or not; 2026.7: the session `.jsonl` files).
 *
 * Until 2026-09-28 this read `sessions list` and summed each session's
 * `totalTokens` — which OpenClaw sets to the size of the conversation's
 * context at its LAST call, not a running total. The usage views then
 * counted context growth: a 400K-token conversation making a thousand calls
 * a day barely registered (Meeting Scheduler QA: 540M tokens on 09-27, shown
 * as almost nothing), while a new or woken conversation counted its whole
 * context as fresh use (Cooking Teacher's 72K on a day it did nothing).
 *
 * Every agent in the container counts (the Hatchabot agent and OpenClaw's
 * default "main", whose heartbeats and Control UI turns spend the same plan).
 * A full read costs ~1 s on a 65,000-event agent; totals only ever rise,
 * except when a transcript is deleted (the views count a drop as nothing).
 */
export interface UsageSplit {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface AgentUsage extends UsageSplit {
  /** input + output + cache reads + cache writes: everything the calls moved. */
  totalTokens: number;
  /** Model calls recorded. */
  calls: number;
  /** Conversations with at least one call. */
  sessions: number;
  /** When the newest call was made. */
  lastActive?: string;
  byModel: Array<{ model: string; tokens: number; sessions: number; calls: number; maxContext?: number } & UsageSplit>;
  /** The last 24 hours, from the transcripts. */
  lastDay?: { calls: number; tokens: number };
  /** Tokens the newest call carried in (prompt + cache): the size of the conversation now. */
  lastContext?: number;
  /** The largest any call carried in. */
  maxContext?: number;
  /** Active span in ms: first call → latest call. */
  spanMs?: number;
  /** Lifetime average tokens/hour (totalTokens ÷ span); undefined under 10 min. */
  tokensPerHour?: number;
  /** The last 8 days of calls as [end of 5-minute slot, tokens], oldest first: a first sample backfills from it. */
  recent?: Array<[string, number]>;
  /** The same 8 days as [end of 5-minute slot, calls]: the full count of successful calls. */
  recentCalls?: Array<[string, number]>;
  /** The last 30 days by model, for the model scorecard (modelScorecard.ts). */
  profile?: ModelProfile;
  /** Token health (tokenHealth.ts): conversation size, cache, cost split, scheduled runs, instruction files, loop signals. */
  health?: TokenHealthRaw;
}

/** [input, output, cacheRead, cacheWrite] */
export type Mix4 = [number, number, number, number];
/** [calls, cacheRead, carried in (input + cacheRead + cacheWrite)] */
export type CacheTally = [number, number, number];
/**
 * What the reader says about an agent's token health (USAGE_READER_SCRIPT,
 * the `health` part): counts, sizes and times, never text. Interpreted by
 * tokenHealth.ts, whose thresholds decide what is a problem.
 */
export interface TokenHealthRaw {
  v: 1;
  since: number;
  /** Context per call (input + cache) on conversations (not scheduled runs or sub-agents), last 30 days. */
  conv: { calls: number; p50: number; p90: number; max: number; over100k: number };
  /** Each agent directory's main conversation (`agent:<slug>:main`, Telegram DM and console share it): its last call's context. */
  main: Record<string, { ctx: number; at: number }>;
  /** The largest conversations by their last call's context. */
  top: Array<{ kind: string; ctx: number; at: number; calls: number }>;
  /** Conversations: a turn's first call within 5 min of the previous call, after more, and calls inside a turn. */
  cache: { first5: CacheTally; firstCold: CacheTally; inside: CacheTally };
  /** Token mixes per model: a person's turns, follow-ups (a command finished, a sub-agent settled), scheduled work. */
  split: { chat: Record<string, Mix4>; followup: Record<string, Mix4>; scheduled: Record<string, Mix4> };
  /** Scheduled runs' tokens per task id ("(recovered)" when the key was lost). */
  jobTokens: Record<string, Record<string, Mix4>>;
  thinking: { calls: number; of: number };
  cfg: { thinkingDefault?: string; agentThinking: Record<string, string>; modelThinking: Record<string, string>; caps: Record<string, number> } | null;
  /** Bytes of each instruction file, per agent directory. */
  files: Record<string, Record<string, number>>;
  compactions: { n: number; last: number; before: number };
  /** Scheduled tasks' runs in the 30 days (OpenClaw's own upkeep jobs left out); rr = [start, ms since the error before it]. */
  jobs: Array<{ id: string; name?: string; off?: boolean; runs: number; ok: number; error: number; interrupted: number; skipped: number; streak: number; first: number; last: number; lastStatus: string; rr: Array<[number, number]> }> | null;
  /** Channel messages the gateway tried more than once (its ingress queue). */
  ingress: Array<{ ch: string; acct: string; id: string; st: string; att: number; first: number; last: number; why: string; fr: string }> | null;
  /** Turns with many tool calls: [end, tool calls]. */
  big: Array<[number, number]>;
  /** Runs OpenClaw's tool-loop guard stopped. */
  guard: number[];
  /** Model calls failing in a row: [first, last, calls, of which rate-limited]. */
  streaks: Array<[number, number, number, number]>;
}
/** The reader's floors (USAGE_READER_SCRIPT): the thresholds in tokenHealth.ts must be at or above them. */
export const READER_FLOORS = { bigTurn: 20, streak: 2 } as const;

/** How one model's turns ended, counted from the transcripts (never their text). */
export interface TurnErrors {
  /** OpenClaw rejected a tool call the model wrote ("Provider completed tool call with malformed JSON arguments" and kin). */
  malformedToolCall: number;
  /** The call failed for another reason (overloaded, HTTP error, connection, terminated). */
  providerError: number;
  /** Refused for a rate limit: the source's, not the model's. */
  rateLimited: number;
  /** Stopped before it answered (aborted, idle timeout). */
  aborted: number;
  /** The answer ran out of output room (stopReason "length"). */
  truncated: number;
  /** Tool results that came back as errors (bad arguments, or the tool itself failing). */
  toolFailed: number;
  /** Failed calls OpenClaw retried within the same turn (those turns do not count as failed). */
  retried: number;
}
export interface WindowModelStats extends UsageSplit {
  calls: number;
  /** Calls whose answer asked for at least one tool. */
  toolUseCalls: number;
  /** Turns: from a message (a person, a task, a peer) to the model's final answer. */
  turns: number;
  toolTurns: number;
  /** Tool calls across those turns. */
  toolCalls: number;
  /** Turns that ended in an error (rate limits included; retried ones not). */
  failedTurns: number;
  /** Failed or truncated turns in the last 7 days. */
  failed7d: number;
  first: number;
  last: number;
  /** What a call carried in (input + cache), median and 90th percentile. */
  ctxP50: number;
  ctxP90: number;
  err: TurnErrors;
  /** The same counts per UTC hour ("2026-10-03T01"), only hours with something in them; see HOUR_FIELDS. Absent in profiles read before v2.118. */
  h?: Record<string, number[]>;
}

/**
 * What each number of an hour's bucket (WindowModelStats.h) is. `failed` are
 * turns that ended in an error after any retry, `limitedTurns` the part of
 * them that were rate limits (the source's, not the model's); `malformed` are
 * malformed tool calls whether or not OpenClaw retried them.
 */
export const HOUR_FIELDS = ['calls', 'input', 'output', 'cacheRead', 'cacheWrite', 'turns', 'toolTurns', 'toolCalls', 'failed', 'malformed', 'toolFailed', 'limitedTurns', 'truncated'] as const;
export type HourField = (typeof HOUR_FIELDS)[number];
export interface ModelProfile {
  /** Start of the window (ms). */
  since: number;
  models: Record<string, WindowModelStats>;
  /** OpenClaw's prompt-error events in the window. */
  promptErrors: number;
  /** Purpose excerpts by OpenClaw agent directory (the agent's slug, and "main"). */
  purposes: Record<string, string>;
  /** Enabled scheduled tasks of the owner's (OpenClaw's own upkeep jobs not counted); null = unreadable. */
  crons: number | null;
  /** The agent's first recorded call ever (ms), to know how much of the window it existed for. */
  firstCall: number;
  /** Each model's `h` hour buckets were read (v2.118+): an empty model list then means idle, not unknown. */
  hourly?: boolean;
}

const EMPTY: AgentUsage = { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, sessions: 0, byModel: [] };
const MIN_SPAN_MS = 10 * 60_000; // below this, a rate is noise
/** How far back a reading's `recent` slots reach (the script's `since`): a first reading knows this much history. */
export const FIRST_READ_REACH_MS = 8 * 86_400_000;

/** Runs inside the agent's container (node 22+). Static text: nothing of the agent's is spliced in. */
export const USAGE_READER_SCRIPT = String.raw`
const fs = require("fs"); const path = require("path"); const zlib = require("zlib");
const root = "/home/node/.openclaw/agents";
const models = {}; const sessions = new Set(); let first = Infinity, last = 0, bad = 0;
const since = Date.now() - 8 * 86400000; const slots = {};
const dayAgo = Date.now() - 86400000; const day = { calls: 0, tokens: 0 }; let lastCtx = 0, lastCtxAt = 0;
// Calls per 5-minute slot: OpenClaw logs only calls slower than 1 s, so the
// transcripts are the one full count (review, 2026-09-29).
const callSlots = {};
// One call can be in two places (a deleted session's archive row and its
// published .deleted file): each event id counts once.
const seen = new Set();
const n = (x) => (typeof x === "number" && isFinite(x) && x > 0 ? x : 0);
// The model scorecard (modelScorecard.ts): the last 30 days per model — the
// calls' split, what each carried in, how the turns used tools, and how they
// ended. Counts only; no text leaves the container but the Purpose excerpt.
const W30 = Date.now() - 30 * 86400000, W7 = Date.now() - 7 * 86400000;
const win = {}; const turnOf = {}; let promptErrors = 0;
// Token health (tokenHealth.ts): per conversation, how big it is, how the cache
// fares on a turn's first call and inside a turn, where the cost goes (chat,
// follow-ups, scheduled), and the loop signals the transcripts carry. Counts,
// sizes and times only. The floors below only keep the output small: the
// thresholds that decide are tokenHealth.ts's (a test keeps them above these).
const BIG_TURN_FLOOR = 20, STREAK_FLOOR = 2, WARM = 300000;
const keyOf = {}; const hs = {};
const HW = { conv: [], over100k: 0, latest: {}, cache: { first5: [0, 0, 0], firstCold: [0, 0, 0], inside: [0, 0, 0] },
  split: { chat: {}, followup: {}, scheduled: {} }, jobTok: {}, think: [0, 0], comp: { n: 0, last: 0, before: 0 }, big: [], guard: [], streaks: [] };
const kindOf = (key) => !key ? "conv" : key.indexOf(":subagent:") >= 0 ? "sub" : /^agent:[^:]+:(cron|recovered)(:|$)/.test(key) ? "sched" : "conv";
const LOOP_GUARD = /tool-loop|tool loop|compaction_loop_persisted/i;
const addMix = (bucket, model, u) => { const m = bucket[model] ||= [0, 0, 0, 0]; m[0] += n(u.input); m[1] += n(u.output); m[2] += n(u.cacheRead); m[3] += n(u.cacheWrite); };
const flushStreak = (s) => { if (s.fail && s.fail.n >= STREAK_FLOOR && HW.streaks.length < 200) HW.streaks.push([s.fail.first, s.fail.last, s.fail.n, s.fail.limited]); s.fail = null; };
const health = (sid, at, msg) => {
  if (!(at >= W30)) return;
  const key = keyOf[sid] || ""; const kind = kindOf(key);
  const s = hs[sid] ||= { opener: "person", fresh: true, lastCall: 0, fail: null };
  if (msg.role === "user") {
    const p = msg.provenance || {};
    s.opener = !p.kind ? "person" : p.kind === "internal_system" && p.sourceTool === "cron" ? "cron" : p.kind === "heartbeat" || p.sourceTool === "heartbeat" ? "heartbeat" : "followup";
    s.fresh = true; return;
  }
  if (msg.role !== "assistant" || msg.openclawDeliveryMirror || msg.model === "delivery-mirror") return;
  const model = msg.model || "(unknown)"; const u = msg.usage || {};
  const sr = msg.stopReason;
  // Model calls failing in a row (a streak per conversation; rate limits marked).
  if (sr === "error") {
    const lim = LIMITED.test(String(msg.errorMessage || ""));
    if (!s.fail) s.fail = { first: at, last: at, n: 0, limited: 0 };
    s.fail.n++; s.fail.last = at; if (lim) s.fail.limited++;
  } else flushStreak(s);
  if ((sr === "error" || sr === "aborted") && LOOP_GUARD.test(String(msg.errorMessage || "")) && HW.guard.length < 200) HW.guard.push(at);
  const tok = n(u.input) + n(u.output) + n(u.cacheRead) + n(u.cacheWrite);
  if (!tok) return;
  const carried = n(u.input) + n(u.cacheRead) + n(u.cacheWrite);
  const cls = kind === "sched" || s.opener === "cron" || s.opener === "heartbeat" ? "scheduled" : s.opener === "followup" ? "followup" : "chat";
  addMix(HW.split[cls], model, u);
  if (kind === "sched") { const p = key.split(":"); const job = p[2] === "cron" && p[3] ? p[3] : "(recovered)"; addMix(HW.jobTok[job] ||= {}, model, u); }
  if (kind === "conv") {
    HW.conv.push(carried); if (carried > 100000) HW.over100k++;
    const l = HW.latest[sid] ||= { key, at: 0, ctx: 0, calls: 0 }; l.calls++;
    if (at >= l.at) { l.at = at; l.ctx = carried; }
    const gap = s.lastCall ? at - s.lastCall : -1;
    const c = s.fresh ? (gap >= 0 ? (gap <= WARM ? HW.cache.first5 : HW.cache.firstCold) : null) : (gap >= 0 && gap <= WARM ? HW.cache.inside : null);
    if (c) { c[0]++; c[1] += n(u.cacheRead); c[2] += carried; }
    HW.think[1]++;
    if (Array.isArray(msg.content) && msg.content.some((p) => p && (p.type === "thinking" || p.type === "redacted_thinking"))) HW.think[0]++;
  }
  s.fresh = false; s.lastCall = at;
};
const P = (model) => win[model] ||= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, toolUseCalls: 0, turns: 0, toolTurns: 0, toolCalls: 0, failedTurns: 0, failed7d: 0, first: 0, last: 0, ctx: [],
  err: { malformedToolCall: 0, providerError: 0, rateLimited: 0, aborted: 0, truncated: 0, toolFailed: 0, retried: 0 }, h: {} };
// The same counts per UTC hour (HOUR_FIELDS in usage.ts), so the model-change
// ledger can read a model's use from a switch on (modelLedger.ts).
const H = (model, at) => { const k = new Date(at).toISOString().slice(0, 13); return P(model).h[k] ||= [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; };
// OpenClaw's pre-dispatch rejections of a tool call the model wrote badly (2026.9.6).
const MALFORMED = /malformed JSON arguments|incomplete or malformed tool call|incomplete tool call|invalid JSON arguments|unresolved tool calls/i;
const LIMITED = /rate_limit|rate limit|\b429\b/i;
const prof = (sid, at, msg) => {
  if (!(at >= W30)) return;
  const t = turnOf[sid] ||= { open: false, tools: 0, failed: "", model: "" };
  if (msg.role === "user") { t.open = true; t.tools = 0; t.failed = ""; return; }
  if (msg.role === "toolResult") { if (msg.isError === true && t.model) { P(t.model).err.toolFailed++; H(t.model, at)[10]++; } return; }
  if (msg.role !== "assistant" || msg.openclawDeliveryMirror || msg.model === "delivery-mirror") return;
  const model = msg.model || "(unknown)"; t.model = model;
  const m = P(model); const u = msg.usage || {};
  const tok = n(u.input) + n(u.output) + n(u.cacheRead) + n(u.cacheWrite);
  const parts = Array.isArray(msg.content) ? msg.content.filter((p) => p && p.type === "toolCall").length : 0;
  const hb = H(model, at);
  if (tok > 0) {
    m.calls++; m.input += n(u.input); m.output += n(u.output); m.cacheRead += n(u.cacheRead); m.cacheWrite += n(u.cacheWrite);
    m.ctx.push(n(u.input) + n(u.cacheRead) + n(u.cacheWrite));
    if (parts) m.toolUseCalls++;
    hb[0]++; hb[1] += n(u.input); hb[2] += n(u.output); hb[3] += n(u.cacheRead); hb[4] += n(u.cacheWrite);
  }
  if (!m.first || at < m.first) m.first = at; if (at > m.last) m.last = at;
  // A call after a failed one, before anyone wrote again: OpenClaw retried, and
  // the turn goes on — it did not fail after all.
  if (!t.open) {
    if (t.failed) {
      const f = P(t.failed); f.err.retried++; f.turns--; f.failedTurns--; if (t.failedAt >= W7) f.failed7d--;
      const fb = H(t.failed, t.failedAt); fb[5]--; fb[8]--; if (t.failedLimited) fb[11]--;
      t.failed = "";
    }
    t.open = true; t.tools = 0;
  }
  t.tools += parts;
  const sr = msg.stopReason;
  if (sr === "toolUse" && parts) return;
  t.open = false; m.turns++; hb[5]++;
  if (t.tools) { m.toolTurns++; m.toolCalls += t.tools; hb[6]++; hb[7] += t.tools; }
  if (t.tools >= BIG_TURN_FLOOR && HW.big.length < 300) HW.big.push([at, t.tools]);
  if (sr === "error" || sr === "aborted" || sr === "timeout") {
    const e = String(msg.errorMessage || "");
    const limited = LIMITED.test(e);
    if (limited) { m.err.rateLimited++; hb[11]++; }
    else if (MALFORMED.test(e)) { m.err.malformedToolCall++; hb[9]++; }
    else if (sr === "error") m.err.providerError++;
    else m.err.aborted++;
    m.failedTurns++; hb[8]++; if (at >= W7) m.failed7d++; t.failed = model; t.failedAt = at; t.failedLimited = limited;
  } else {
    t.failed = "";
    if (sr === "length") { m.err.truncated++; hb[12]++; if (at >= W7) m.failed7d++; }
  }
};
const ev = (sid, at, e) => {
  if (!e) return;
  if (e.type === "custom" && /prompt-error/.test(String(e.customType || ""))) { if (at >= W30) promptErrors++; return; }
  if (e.type === "compaction") {
    if (e.id) { if (seen.has(e.id)) return; seen.add(e.id); }
    if (at >= W30) { HW.comp.n++; if (at >= HW.comp.last) { HW.comp.last = at; HW.comp.before = n(e.tokensBefore); } }
    return;
  }
  const msg = e.message; if (!msg || typeof msg !== "object") return;
  if (e.id) { if (seen.has(e.id)) return; seen.add(e.id); }
  health(sid, at, msg);
  prof(sid, at, msg);
  add(sid, at, msg);
};
// Only these lines are parsed: calls, what people wrote, failed tools, prompt errors, compactions.
const wanted = (s) => s.indexOf('"usage"') >= 0 || s.indexOf('"role":"user"') >= 0 || s.indexOf('"isError":true') >= 0 || s.indexOf("prompt-error") >= 0 || s.indexOf('"compaction"') >= 0;
const add = (sid, at, msg) => {
  const u = msg && msg.usage; if (!u || typeof u !== "object") return;
  // A copy of a reply sent to a channel ("delivery-mirror") carries no tokens: not a call.
  const tok = n(u.input) + n(u.output) + n(u.cacheRead) + n(u.cacheWrite); if (!tok) return;
  const m = models[msg.model || "(unknown)"] ||= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, maxCtx: 0, s: new Set() };
  // What this call carried in: the prompt, cached or not. Big = a long conversation re-sent every call.
  const ctx = n(u.input) + n(u.cacheRead) + n(u.cacheWrite);
  if (ctx > m.maxCtx) m.maxCtx = ctx;
  if (at >= lastCtxAt) { lastCtxAt = at; lastCtx = ctx; }
  if (at >= dayAgo) { day.calls++; day.tokens += tok; }
  m.calls++; m.input += n(u.input); m.output += n(u.output); m.cacheRead += n(u.cacheRead); m.cacheWrite += n(u.cacheWrite); m.s.add(sid);
  if (at >= since) { const k = new Date(at - (at % 300000) + 300000).toISOString(); slots[k] = (slots[k] || 0) + tok; callSlots[k] = (callSlots[k] || 0) + 1; }
  sessions.add(sid);
  if (at) { if (at < first) first = at; if (at > last) last = at; }
};
const lines = (d, sid, text) => {
  for (const line of text.split(String.fromCharCode(10))) {
    if (!wanted(line)) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    ev(d + ":" + sid, Date.parse(e.timestamp) || 0, e);
  }
};
let dirs = []; try { dirs = fs.readdirSync(root); } catch {}
for (const d of dirs) {
  const dbf = path.join(root, d, "agent", "openclaw-agent.sqlite");
  let usedDb = false;
  let sqlite = null; try { sqlite = require("node:sqlite"); } catch {}
  if (sqlite && fs.existsSync(dbf)) {
    // Only a DB without the table (2026.7 keeps its calls in the .jsonl files)
    // falls back. Any other failure — busy, locked, corrupt — fails the whole
    // read: on 2026.9 the .jsonl files are pre-migration leftovers, and a
    // much smaller total saved as a reading made the next good one count
    // hundreds of millions of tokens as new use (review, 2026-09-29).
    // A deleted or reset session leaves transcript_events for
    // session_transcript_archives (a cron run, hours after it ran): read both,
    // or a cron-heavy agent's history shrinks (review, 2026-09-29).
    let db = null, rows = null, archives = [];
    try {
      db = new sqlite.DatabaseSync(dbf, { readOnly: true });
      try { db.exec("PRAGMA busy_timeout = 3000"); } catch {}
      try { rows = db.prepare("SELECT session_id, created_at, event_json, event_zstd FROM transcript_events").all(); }
      catch (e) { if (!/no such table/i.test(String(e && e.message))) throw e; }
      if (rows) {
        try { archives = db.prepare("SELECT session_id, encoding, archive_blob FROM session_transcript_archives").all(); }
        catch (e) { if (!/no such table/i.test(String(e && e.message))) throw e; }
        // Which conversation each session is (main, a chat app's, a scheduled
        // run's): for token health only, so any failure here just leaves it unknown.
        try { for (const k of db.prepare("SELECT session_id, session_key FROM session_windows").all()) if (k.session_key) keyOf[d + ":" + k.session_id] = String(k.session_key); } catch {}
        try { for (const k of db.prepare("SELECT session_id, session_key FROM session_transcript_archives").all()) if (k.session_key && !keyOf[d + ":" + k.session_id]) keyOf[d + ":" + k.session_id] = String(k.session_key); } catch {}
      }
    } catch (e) {
      process.stderr.write("usage read failed for " + d + ": " + String((e && e.message) || e));
      process.exit(3);
    } finally { try { if (db) db.close(); } catch {} }
    if (rows) {
      usedDb = true;
      // In conversation order, so a turn's calls are read in sequence (a stable
      // sort keeps the table's order for events written in the same ms).
      rows.sort((a, b) => (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : (Number(a.created_at) || 0) - (Number(b.created_at) || 0)));
      for (const r of rows) {
        let j = r.event_json;
        if (j == null && r.event_zstd) { try { j = zlib.zstdDecompressSync(Buffer.from(r.event_zstd)).toString("utf8"); } catch { bad++; continue; } }
        if (!j || !wanted(j)) continue;
        let e; try { e = JSON.parse(j); } catch { continue; }
        ev(d + ":" + r.session_id, Number(r.created_at) || 0, e);
      }
      for (const a of archives) {
        let text; try { text = a.encoding === "zstd" ? zlib.zstdDecompressSync(Buffer.from(a.archive_blob)).toString("utf8") : Buffer.from(a.archive_blob).toString("utf8"); } catch { bad++; continue; }
        lines(d, a.session_id, text);
      }
    }
  }
  // Session files: 2026.7's transcripts, and on 2026.9 what never reached the
  // database — sessions reset before the upgrade (.reset.*), and deleted
  // ones published as .deleted.*(.zst), which the event ids de-duplicate.
  const sd = path.join(root, d, "sessions"); let files = [];
  try { files = fs.readdirSync(sd).filter((f) => /\.jsonl(\.(reset|deleted)\.[^/]*)?$/.test(f) && f.indexOf("trajectory") < 0); } catch {}
  // A pre-migration .jsonl whose session the database already holds is the same calls again.
  if (usedDb) files = files.filter((f) => /\.(reset|deleted)\./.test(f));
  try { const sj = JSON.parse(fs.readFileSync(path.join(sd, "sessions.json"), "utf8")); for (const [k, v] of Object.entries(sj || {})) if (v && v.sessionId && !keyOf[d + ":" + v.sessionId]) keyOf[d + ":" + v.sessionId] = k; } catch {}
  for (const f of files) {
    let text = "";
    try { const raw = fs.readFileSync(path.join(sd, f)); text = (f.endsWith(".zst") ? zlib.zstdDecompressSync(raw) : raw).toString("utf8"); } catch { bad++; continue; }
    lines(d, f.split(".")[0], text);
  }
}
for (const s of Object.values(hs)) flushStreak(s);
const out = { models: {}, sessions: sessions.size, first: first === Infinity ? 0 : first, last, bad, slots, callSlots, day, lastCtx };
for (const [k, m] of Object.entries(models)) out.models[k] = { calls: m.calls, input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite, maxCtx: m.maxCtx, sessions: m.s.size };
// The 30-day profile: context size per call as its median and 90th percentile (nearest rank).
const rank = (c, p) => (c.length ? c[Math.max(0, Math.ceil(p * c.length) - 1)] : 0);
const wm = {};
for (const [k, m] of Object.entries(win)) {
  const c = m.ctx.sort((a, b) => a - b); const { ctx, ...rest } = m;
  // Only the hours with something in them.
  const h = {}; for (const [hk, v] of Object.entries(m.h)) if (v.some((x) => x)) h[hk] = v;
  if (m.calls || m.turns || m.err.toolFailed) wm[k] = { ...rest, h, ctxP50: rank(c, 0.5), ctxP90: rank(c, 0.9) };
}
// What each agent says it is for: the first lines of a Purpose (or Role,
// Mission, "What you do") section of its SOUL.md, else its AGENTS.md.
const purposes = {};
const HEAD = /^#{1,3}[ \t]+(?:your[ \t]+|my[ \t]+)?(purpose|role|mission|job|what you do)\b.*$/im;
for (const d of dirs) {
  for (const f of ["SOUL.md", "AGENTS.md"]) {
    let t = ""; try { t = fs.readFileSync(path.join(root, d, "agent", f), "utf8").slice(0, 65536); } catch { continue; }
    const h = HEAD.exec(t); if (!h) continue;
    const body = t.slice(h.index + h[0].length).split(/\n#{1,6}[ \t]/)[0].replace(/\s+/g, " ").trim();
    if (body) { purposes[d] = body.slice(0, 240); break; }
  }
}
// The owner's scheduled tasks (OpenClaw's own upkeep jobs carry a declaration key).
let crons = null;
try {
  const sq = require("node:sqlite"); const sf = path.join(root, "..", "state", "openclaw.sqlite");
  if (fs.existsSync(sf)) {
    const sdb = new sq.DatabaseSync(sf, { readOnly: true });
    try { sdb.exec("PRAGMA busy_timeout = 2000"); crons = sdb.prepare("SELECT enabled, declaration_key FROM cron_jobs").all().filter((j) => j.enabled && !j.declaration_key).length; }
    finally { sdb.close(); }
  }
} catch { crons = null; }
// Token health: the instruction files OpenClaw puts in every turn (sizes only),
// the thinking and context settings, scheduled runs, and channel messages that
// were retried (the gateway's own ingress queue: counts and times, no payload).
const files = {};
for (const d of dirs) {
  const f = {};
  for (const name of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "BOOTSTRAP.md", "MEMORY.md", "TOOLS.md"]) {
    try { const st = fs.statSync(path.join(root, d, "agent", name)); if (st.isFile()) f[name] = st.size; } catch {}
  }
  files[d] = f;
}
let cfg = null;
try {
  const c = JSON.parse(fs.readFileSync(path.join(root, "..", "openclaw.json"), "utf8")) || {};
  const ag = c.agents || {}; const def = ag.defaults || {};
  const lvl = (v) => (typeof v === "string" && v.length < 20 ? v : undefined);
  const agentThinking = {};
  for (const e of Array.isArray(ag.list) ? ag.list : []) if (e && e.id && lvl(e.thinkingDefault)) agentThinking[e.id] = lvl(e.thinkingDefault);
  for (const [id, e] of Object.entries(ag.entries || {})) if (e && lvl(e.thinkingDefault)) agentThinking[id] = lvl(e.thinkingDefault);
  const modelThinking = {};
  for (const [ref, e] of Object.entries(def.models || {})) if (e && e.params && lvl(e.params.thinking)) modelThinking[ref] = lvl(e.params.thinking);
  const caps = {};
  for (const [p, pv] of Object.entries((c.models && c.models.providers) || {})) for (const m of (pv && Array.isArray(pv.models) ? pv.models : [])) if (m && m.id && typeof m.contextTokens === "number") caps[p + "/" + m.id] = m.contextTokens;
  cfg = { thinkingDefault: lvl(def.thinkingDefault), agentThinking, modelThinking, caps };
} catch { cfg = null; }
let jobs = null, ingress = null;
try {
  const sq = require("node:sqlite"); const sf = path.join(root, "..", "state", "openclaw.sqlite");
  if (fs.existsSync(sf)) {
    const sdb = new sq.DatabaseSync(sf, { readOnly: true });
    try {
      sdb.exec("PRAGMA busy_timeout = 2000");
      try {
        const names = {}; const system = new Set();
        const off = new Set();
        for (const j of sdb.prepare("SELECT job_id, name, declaration_key, enabled FROM cron_jobs").all()) { if (Number(j.enabled) === 0) off.add(j.job_id); if (j.declaration_key) system.add(j.job_id); else names[j.job_id] = String(j.name || "").slice(0, 60); }
        const byJob = {};
        for (const r of sdb.prepare("SELECT job_id, status, started_at_ms, finished_at_ms FROM cron_run_receipts WHERE started_at_ms >= ? ORDER BY started_at_ms").all(W30)) {
          if (system.has(r.job_id)) continue;
          const j = byJob[r.job_id] ||= { id: r.job_id, name: names[r.job_id], off: off.has(r.job_id) || undefined, runs: 0, ok: 0, error: 0, interrupted: 0, skipped: 0, streak: 0, first: 0, last: 0, lastStatus: "", rr: [], prevErrAt: 0 };
          const at = Number(r.started_at_ms) || 0;
          j.runs++; if (!j.first) j.first = at; j.last = at; j.lastStatus = r.status;
          if (j.prevErrAt && j.rr.length < 50) j.rr.push([at, at - j.prevErrAt]);
          if (r.status === "error" || r.status === "interrupted") { j[r.status]++; j.streak++; j.prevErrAt = Number(r.finished_at_ms) || at; }
          else { if (r.status === "ok") j.ok++; else if (r.status === "skipped") j.skipped++; if (r.status !== "running") { j.streak = 0; j.prevErrAt = 0; } }
        }
        jobs = Object.values(byJob).map(({ prevErrAt, ...j }) => j);
      } catch { jobs = null; }
      try {
        ingress = sdb.prepare("SELECT channel_id, account_id, event_id, status, attempts, received_at, last_attempt_at, updated_at, last_error, failed_reason FROM channel_ingress_events WHERE attempts >= 2 AND updated_at >= ? ORDER BY updated_at DESC LIMIT 50").all(W30)
          .map((r) => ({ ch: String(r.channel_id || "").slice(0, 20), acct: String(r.account_id || "").slice(0, 64), id: String(r.event_id || "").replace(/^0+(?=\d)/, "").slice(0, 40), st: String(r.status || ""), att: Number(r.attempts) || 0,
            first: Number(r.received_at) || 0, last: Number(r.last_attempt_at) || Number(r.updated_at) || 0,
            why: /handler-timeout|stalled/i.test(String(r.last_error || "")) ? "handler-timeout" : r.last_error ? "error" : "", fr: r.failed_reason ? String(r.failed_reason).slice(0, 40) : "" }));
      } catch { ingress = null; }
    } finally { sdb.close(); }
  }
} catch { jobs = null; ingress = null; }
const main = {}; const top = [];
for (const [sid, l] of Object.entries(HW.latest)) {
  const d = sid.split(":")[0];
  if (l.key === "agent:" + d + ":main" && (!main[d] || l.at > main[d].at)) main[d] = { ctx: l.ctx, at: l.at };
  const kind = l.key === "agent:" + d + ":main" ? "main" : /:(group|channel|room):/.test(l.key) ? "group" : /:(direct|dm):|telegram|slack|discord/.test(l.key) ? "chat-app" : l.key ? "other" : "unknown";
  top.push({ kind, ctx: l.ctx, at: l.at, calls: l.calls });
}
top.sort((a, b) => b.ctx - a.ctx);
const cs = HW.conv.sort((a, b) => a - b);
out.health = { v: 1, since: W30,
  conv: { calls: cs.length, p50: rank(cs, 0.5), p90: rank(cs, 0.9), max: cs.length ? cs[cs.length - 1] : 0, over100k: HW.over100k },
  main, top: top.slice(0, 5), cache: HW.cache, split: HW.split, jobTokens: HW.jobTok, thinking: { calls: HW.think[0], of: HW.think[1] },
  cfg, files, compactions: HW.comp, jobs, ingress, big: HW.big, guard: HW.guard, streaks: HW.streaks };
out.window = { since: W30, models: wm, promptErrors, hourly: true };
out.purposes = purposes; out.crons = crons;
process.stdout.write(JSON.stringify(out));
`;

/**
 * `strict`: a failed or unreadable read throws instead of answering zero. The
 * usage sampler needs that — a zero saved as a counter reading made the next
 * good one count the agent's whole lifetime as fresh use (night review).
 */
export async function agentUsage(
  provider: RuntimeProvider,
  runtimeRef: string,
  _slug: string,
  opts: { strict?: boolean } = {},
): Promise<AgentUsage> {
  const b64 = Buffer.from(USAGE_READER_SCRIPT, 'utf8').toString('base64');
  const res = await provider.execShell(runtimeRef, `node -e "$(echo ${b64} | base64 -d)"`);
  if (res.code !== 0) {
    if (opts.strict) throw new Error(`usage read exited ${res.code}: ${res.stderr.slice(-200)}`);
    return EMPTY;
  }
  let raw: { models?: Record<string, UsageSplit & { calls: number; sessions: number; maxCtx?: number }>; sessions?: number; first?: number; last?: number; slots?: Record<string, number>; callSlots?: Record<string, number>; day?: { calls?: number; tokens?: number }; lastCtx?: number;
    window?: { since?: number; models?: Record<string, WindowModelStats>; promptErrors?: number; hourly?: boolean }; purposes?: Record<string, string>; crons?: number | null;
    health?: TokenHealthRaw };
  try {
    raw = JSON.parse(res.stdout);
    if (!raw || typeof raw.models !== 'object') throw new Error('no usage object');
  } catch (err) {
    if (opts.strict) throw err;
    return EMPTY;
  }
  const byModel = Object.entries(raw.models ?? {}).map(([model, m]) => {
    const tokens = m.input + m.output + m.cacheRead + m.cacheWrite;
    return { model, tokens, calls: m.calls, sessions: m.sessions, input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite,
      ...(typeof m.maxCtx === 'number' ? { maxContext: m.maxCtx } : {}) };
  }).sort((a, b) => b.tokens - a.tokens);
  const sum = (k: keyof UsageSplit | 'calls' | 'tokens') => byModel.reduce((s, m) => s + (m[k] as number), 0);
  const totalTokens = sum('tokens');
  const first = Number(raw.first) || 0, last = Number(raw.last) || 0;
  const spanMs = first && last > first ? last - first : undefined;
  return {
    totalTokens,
    input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'),
    calls: sum('calls'),
    sessions: Number(raw.sessions) || 0,
    lastActive: last > 0 ? new Date(last).toISOString() : undefined,
    byModel,
    spanMs,
    tokensPerHour: spanMs && spanMs >= MIN_SPAN_MS ? Math.round(totalTokens / (spanMs / 3_600_000)) : undefined,
    ...(raw.day && typeof raw.day.calls === 'number' ? { lastDay: { calls: raw.day.calls, tokens: Number(raw.day.tokens) || 0 } } : {}),
    ...(typeof raw.lastCtx === 'number' ? { lastContext: raw.lastCtx } : {}),
    ...(byModel.some((m) => m.maxContext !== undefined) ? { maxContext: Math.max(...byModel.map((m) => m.maxContext ?? 0)) } : {}),
    recent: Object.entries(raw.slots ?? {}).filter(([k, v]) => !Number.isNaN(Date.parse(k)) && typeof v === 'number').sort(([a], [b]) => a.localeCompare(b)),
    recentCalls: Object.entries(raw.callSlots ?? {}).filter(([k, v]) => !Number.isNaN(Date.parse(k)) && typeof v === 'number').sort(([a], [b]) => a.localeCompare(b)),
    ...(raw.window && typeof raw.window.models === 'object' ? {
      profile: {
        since: Number(raw.window.since) || 0,
        models: raw.window.models ?? {},
        promptErrors: Number(raw.window.promptErrors) || 0,
        ...(raw.window.hourly === true ? { hourly: true } : {}),
        purposes: raw.purposes && typeof raw.purposes === 'object' ? raw.purposes : {},
        crons: typeof raw.crons === 'number' ? raw.crons : null,
        firstCall: first,
      },
    } : {}),
    ...(raw.health && raw.health.v === 1 && typeof raw.health.conv === 'object' ? { health: raw.health } : {}),
  };
}
