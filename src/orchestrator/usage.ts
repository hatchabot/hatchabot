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
}

const EMPTY: AgentUsage = { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, sessions: 0, byModel: [] };
const MIN_SPAN_MS = 10 * 60_000; // below this, a rate is noise

/** Runs inside the agent's container (node 22+). Static text: nothing of the agent's is spliced in. */
export const USAGE_READER_SCRIPT = String.raw`
const fs = require("fs"); const path = require("path"); const zlib = require("zlib");
const root = "/home/node/.openclaw/agents";
const models = {}; const sessions = new Set(); let first = Infinity, last = 0, bad = 0;
const since = Date.now() - 8 * 86400000; const slots = {};
const dayAgo = Date.now() - 86400000; const day = { calls: 0, tokens: 0 }; let lastCtx = 0, lastCtxAt = 0;
const add = (sid, at, msg) => {
  const u = msg && msg.usage; if (!u || typeof u !== "object") return;
  const n = (x) => (typeof x === "number" && isFinite(x) && x > 0 ? x : 0);
  // A copy of a reply sent to a channel ("delivery-mirror") carries no tokens: not a call.
  const tok = n(u.input) + n(u.output) + n(u.cacheRead) + n(u.cacheWrite); if (!tok) return;
  const m = models[msg.model || "(unknown)"] ||= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, maxCtx: 0, s: new Set() };
  // What this call carried in: the prompt, cached or not. Big = a long conversation re-sent every call.
  const ctx = n(u.input) + n(u.cacheRead) + n(u.cacheWrite);
  if (ctx > m.maxCtx) m.maxCtx = ctx;
  if (at >= lastCtxAt) { lastCtxAt = at; lastCtx = ctx; }
  if (at >= dayAgo) { day.calls++; day.tokens += tok; }
  m.calls++; m.input += n(u.input); m.output += n(u.output); m.cacheRead += n(u.cacheRead); m.cacheWrite += n(u.cacheWrite); m.s.add(sid);
  if (at >= since) { const k = new Date(at - (at % 300000) + 300000).toISOString(); slots[k] = (slots[k] || 0) + tok; }
  sessions.add(sid);
  if (at) { if (at < first) first = at; if (at > last) last = at; }
};
let dirs = []; try { dirs = fs.readdirSync(root); } catch {}
for (const d of dirs) {
  const dbf = path.join(root, d, "agent", "openclaw-agent.sqlite");
  let usedDb = false;
  if (fs.existsSync(dbf)) {
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(dbf, { readOnly: true });
      const rows = db.prepare("SELECT session_id, created_at, event_json, event_zstd FROM transcript_events").all();
      usedDb = true;
      for (const r of rows) {
        let j = r.event_json;
        if (j == null && r.event_zstd) { try { j = zlib.zstdDecompressSync(Buffer.from(r.event_zstd)).toString("utf8"); } catch { bad++; continue; } }
        if (!j || j.indexOf('"usage"') < 0) continue;
        let e; try { e = JSON.parse(j); } catch { continue; }
        add(d + ":" + r.session_id, Number(r.created_at) || 0, e && e.message);
      }
      db.close();
    } catch { usedDb = false; }
  }
  if (usedDb) continue;
  const sd = path.join(root, d, "sessions"); let files = [];
  try { files = fs.readdirSync(sd).filter((f) => /\.jsonl(\.reset\.[^/]*)?$/.test(f) && f.indexOf("trajectory") < 0); } catch {}
  for (const f of files) {
    let text = ""; try { text = fs.readFileSync(path.join(sd, f), "utf8"); } catch { continue; }
    for (const line of text.split(String.fromCharCode(10))) {
      if (line.indexOf('"usage"') < 0) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      add(d + ":" + f.split(".")[0], Date.parse(e.timestamp) || 0, e.message);
    }
  }
}
const out = { models: {}, sessions: sessions.size, first: first === Infinity ? 0 : first, last, bad, slots, day, lastCtx };
for (const [k, m] of Object.entries(models)) out.models[k] = { calls: m.calls, input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite, maxCtx: m.maxCtx, sessions: m.s.size };
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
  let raw: { models?: Record<string, UsageSplit & { calls: number; sessions: number; maxCtx?: number }>; sessions?: number; first?: number; last?: number; slots?: Record<string, number>; day?: { calls?: number; tokens?: number }; lastCtx?: number };
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
  };
}
