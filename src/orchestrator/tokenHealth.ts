import type { Agent, AIProfile } from '../domain/types.js';
import type { Store, TokenActionRow, TokenIncidentRow } from '../store/store.js';
import type { CacheTally, Mix4, TokenHealthRaw } from './usage.js';
import { priceMix } from './modelOptions.js';
import { effectiveModel } from './provision.js';
import { channelHandlerTimeoutMs, OPENCLAW_HANDLER_TIMEOUT_MS } from './channelTimeout.js';
import { compactingNow } from './compactionState.js';
export { LOOP_LINE, parseLoopLines, type LoopMark, type LoopMarkKind } from './loopLines.js';

/**
 * The token steward's evidence (docs/features.md, "Token steward"): per agent,
 * how big its conversations are, how the prompt cache fares, where its tokens
 * go (a person's turns, follow-ups, scheduled tasks), what its scheduled tasks
 * cost and how they fail, how much of every turn is instruction files, its
 * thinking level, and LOOP SIGNALS — the same work repeated without progress.
 *
 * Built only from what Hatchabot already holds: the usage sampler's transcript
 * read (agent_token_health, the same read as the model profile), the loop lines
 * that pass saw in the gateway log (agent_loop_marks), and the consults
 * Hatchabot brokers itself (agent_events). Nothing here runs in a container or
 * wakes an agent; an asleep agent shows its last reading and its age.
 *
 * The evidence for every threshold is the 2026-10-04 measurement (the
 * hatchabot-cloud repo, docs/measurements-2026-10-01.md, "T1 completed"):
 * context is 93–98% of a heavy chat agent's bill; heavy agents ran 200–700K
 * per call and never compacted; the first call of a new turn hit the cache
 * 12% of the time against 96% inside a turn; a 100K cap was the largest lever.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const THRESHOLDS = {
  /** A conversation is LARGE when its median context per call reaches this (T1: the heavy agents ran 200–700K; 93–98% of their bill was context). */
  largeConversation: 150_000,
  /** Its main conversation is worth compacting NOW at this size (one agent's 446K could not be summarised within 5 minutes). */
  compactNow: 250_000,
  /** The cap to suggest for a large conversation: OpenClaw then compacts at about this − 20K (T1: a 100K cap was −42% to −60%; 150K keeps more of a long chat). */
  suggestedCap: 150_000,
  /** Smallest and largest cap Hatchabot will write (a cap below this would compact every few turns). */
  capMin: 50_000,
  capMax: 1_000_000,
  /** The new-turn cache break: a turn's first call within 5 minutes of the previous one hitting less than this … (T1: 12% against 96% inside a turn) */
  firstTurnHitLow: 0.5,
  /** … over at least this many such calls. */
  minCacheCalls: 10,
  /** Instruction files injected into every turn above this many characters (OpenClaw's own caps: 20K a file, 60K in all). */
  instructionChars: 40_000,
  bootstrapMaxChars: 20_000,
  bootstrapTotalMaxChars: 60_000,
  /** Thinking in more than this share of a conversation's calls: worth a look on a simple agent. */
  thinkingShare: 0.5,
  /** (a) The same channel message stalled and retried at least this many times. */
  channelRetryLoop: 3,
  /** A retry loop is still going while its last stall is this recent (the 5-minute handler limit + OpenClaw's 3-minute backoff cap + slack). */
  channelActiveMs: 15 * 60_000,
  /** (b) At least this many failed compactions … */
  compactionFailLoop: 3,
  /** … within this long. */
  compactionFailWindowMs: 6 * HOUR,
  /** (c) A scheduled task failing this many runs in a row … */
  taskFailStreak: 3,
  /** … or started again within this long after an error … */
  taskRerunWindowMs: 15 * 60_000,
  /** … this many times in a day. */
  taskRerunLoop: 3,
  /** (d) Two agents consulting each other at least this many times, both ways … */
  pingPongMin: 6,
  /** … each consult within this long of the one before. */
  pingPongGapMs: 10 * 60_000,
  /** (e) A turn with at least this many tool calls (or one OpenClaw's loop guard stopped). */
  toolLoopTurn: 80,
  /** (f) Model calls failing this many times in a row (rate limits apart) … */
  failStreak: 5,
  /** … and rate-limited this many times in a row (reported; the source's banner already says so). */
  limitStreak: 5,
  /** A loop signal is news (an incident) while its last occurrence is this recent. */
  activeMs: 6 * HOUR,
  /** How far back the report lists loop signals. */
  lookbackMs: 7 * DAY,
  /** A failing scheduled task counts as a live loop for this long after its last failed run. */
  taskActiveMs: 2 * DAY,
  /** Lines kept by the fast compaction (`--max-lines`) unless asked otherwise. */
  keepLines: 200,
} as const;

// ---------------------------------------------------------------------------
// Loop signals
// ---------------------------------------------------------------------------

export type LoopKind = 'channel-retry' | 'compaction-failing' | 'task-failing' | 'consult-ping-pong' | 'tool-loop' | 'model-failing' | 'rate-limited';
export interface LoopSignal {
  kind: LoopKind;
  /** What it is about: the channel event, the task id, the other agent. */
  key: string;
  count: number;
  first: string;
  last: string;
  /** Still going (its last occurrence is recent): an incident. */
  active: boolean;
  detail: Record<string, unknown>;
}

interface StoredMark { kind: string; key: string; at: string; ms?: number; channel?: string }
const iso = (t: number) => new Date(t).toISOString();

/** Marks within `gapMs` of each other are one occurrence (a stall and its "keeping for retry" line). */
function occurrences(times: number[], gapMs = 30_000): number[] {
  const out: number[] = [];
  for (const t of [...times].sort((a, b) => a - b)) if (!out.length || t - out[out.length - 1]! > gapMs) out.push(t);
  return out;
}

/**
 * Every loop signal for one agent. Counts and times only. `consults` are the
 * brokered consults it took part in (either side); `now` decides what is
 * still going.
 */
export function loopSignals(input: {
  agentId: string;
  health?: TokenHealthRaw;
  marks: StoredMark[];
  consults?: Array<{ to: string; from: string; at: string }>;
  now: number;
}): LoopSignal[] {
  const { health: h, now } = input;
  const T = THRESHOLDS;
  const out: LoopSignal[] = [];
  const since = now - T.lookbackMs;
  const ms = (s: string) => Date.parse(s);

  // (a) The same channel message retried again and again.
  const byEvent = new Map<string, { channel?: string; stalls: number[]; retries: number[]; dead: boolean; limitMs?: number; row?: NonNullable<TokenHealthRaw['ingress']>[number] }>();
  for (const m of input.marks) {
    if (!['stall', 'retry', 'deadletter'].includes(m.kind) || !m.key) continue;
    const e = byEvent.get(m.key) ?? { stalls: [], retries: [], dead: false };
    if (m.channel) e.channel = m.channel;
    if (m.kind === 'stall') { e.stalls.push(ms(m.at)); if (m.ms) e.limitMs = m.ms; }
    else if (m.kind === 'retry') e.retries.push(ms(m.at));
    else e.dead = true;
    byEvent.set(m.key, e);
  }
  for (const r of h?.ingress ?? []) {
    if (!r.id) continue;
    const e = byEvent.get(r.id) ?? { stalls: [], retries: [], dead: false };
    e.row = r; if (r.ch) e.channel = r.ch;
    if (r.st === 'failed') e.dead = true;
    byEvent.set(r.id, e);
  }
  const starts = input.marks.filter((m) => m.kind === 'compactStart').map((m) => ms(m.at));
  for (const [id, e] of byEvent) {
    const times = occurrences([...e.stalls, ...e.retries]);
    const row = e.row;
    const pending = row ? row.st === 'pending' || row.st === 'claimed' : false;
    // The queue counts claims; a message that finally went through was tried once more than it failed.
    const fromRow = row ? (pending || row.st === 'failed' ? row.att : Math.max(0, row.att - 1)) : 0;
    const count = Math.max(times.length, fromRow);
    if (count < T.channelRetryLoop) continue;
    const limitMs = e.limitMs ?? OPENCLAW_HANDLER_TIMEOUT_MS;
    const firstT = Math.min(...[row?.first || Infinity, times.length ? times[0]! - limitMs : Infinity]);
    const lastT = Math.max(row?.last ?? 0, times.length ? times[times.length - 1]! : 0);
    if (lastT < since) continue;
    const done = row ? row.st === 'completed' || row.st === 'failed' : false;
    const active = !e.dead && !done && (pending || now - lastT <= T.channelActiveMs);
    const compaction = starts.some((t) => t >= firstT - 60_000 && t <= lastT);
    out.push({ kind: 'channel-retry', key: `${e.channel ?? 'channel'}:${id}`, count, first: iso(firstT), last: iso(lastT), active,
      detail: { channel: e.channel ?? 'channel', event: id, limitMs, compaction, ...(e.dead ? { deadLettered: true } : {}), ...(row ? { status: row.st } : {}) } });
  }

  // (b) Compaction failing again and again.
  const fails = input.marks.filter((m) => m.kind === 'compactFail').map((m) => ms(m.at)).filter((t) => t >= since).sort((a, b) => a - b);
  if (fails.length) {
    const last = fails[fails.length - 1]!;
    const recent = fails.filter((t) => t > last - T.compactionFailWindowMs);
    if (recent.length >= T.compactionFailLoop) {
      out.push({ kind: 'compaction-failing', key: 'compaction', count: recent.length, first: iso(recent[0]!), last: iso(last),
        active: now - last <= T.activeMs, detail: { windowHours: T.compactionFailWindowMs / HOUR } });
    }
  }

  // (c) A scheduled task failing and running again.
  for (const j of h?.jobs ?? []) {
    if (j.last < since) continue;
    const reruns = (j.rr ?? []).filter(([at, gap]) => gap <= T.taskRerunWindowMs && at > j.last - DAY);
    const failing = j.streak >= T.taskFailStreak;
    const rerunning = reruns.length >= T.taskRerunLoop;
    if (!failing && !rerunning) continue;
    const lastBad = j.lastStatus === 'error' || j.lastStatus === 'interrupted';
    out.push({ kind: 'task-failing', key: j.id, count: Math.max(j.streak, reruns.length), first: iso(rerunning ? reruns[0]![0] : j.first), last: iso(j.last),
      // Still going only while it's switched on and failed lately: a task the owner
      // paused, or one that last failed days ago, is history, not a loop (2026-10-04).
      active: lastBad && !j.off && now - j.last <= T.taskActiveMs,
      detail: { task: j.name ?? j.id, streak: j.streak, reruns: reruns.length, failed: j.error + j.interrupted, runs: j.runs } });
  }

  // (d) Two agents consulting each other back and forth.
  const pairs = new Map<string, Array<{ at: number; dir: string }>>();
  for (const c of input.consults ?? []) {
    if (c.to !== input.agentId && c.from !== input.agentId) continue;
    const other = c.to === input.agentId ? c.from : c.to;
    const l = pairs.get(other) ?? [];
    l.push({ at: ms(c.at), dir: c.from === input.agentId ? 'out' : 'in' });
    pairs.set(other, l);
  }
  for (const [other, list] of pairs) {
    list.sort((a, b) => a.at - b.at);
    let best: typeof list = [];
    let run: typeof list = [];
    for (const c of list) {
      if (run.length && c.at - run[run.length - 1]!.at > T.pingPongGapMs) run = [];
      run.push(c);
      const both = run.some((x) => x.dir === 'in') && run.some((x) => x.dir === 'out');
      if (both && run.length >= T.pingPongMin && run.length >= best.length) best = [...run];
    }
    if (best.length && best[best.length - 1]!.at >= since) {
      const last = best[best.length - 1]!.at;
      out.push({ kind: 'consult-ping-pong', key: other, count: best.length, first: iso(best[0]!.at), last: iso(last), active: now - last <= T.activeMs,
        detail: { with: other, self: input.agentId, minutes: Math.max(1, Math.round((last - best[0]!.at) / 60_000)) } });
    }
  }

  // (e) Runaway tool loops.
  const big = (h?.big ?? []).filter(([at, n]) => at >= since && n >= T.toolLoopTurn);
  const guard = (h?.guard ?? []).filter((at) => at >= since);
  if (big.length || guard.length) {
    const times = [...big.map(([at]) => at), ...guard].sort((a, b) => a - b);
    const last = times[times.length - 1]!;
    out.push({ kind: 'tool-loop', key: 'tools', count: big.length + guard.length, first: iso(times[0]!), last: iso(last), active: now - last <= T.activeMs,
      detail: { bigTurns: big.length, maxTools: big.reduce((m, [, n]) => Math.max(m, n), 0), guardStops: guard.length } });
  }

  // (f) Model calls failing in a row; rate limits apart.
  const streaks = (h?.streaks ?? []).filter(([, last]) => last >= since);
  const failing = streaks.filter(([, , n, lim]) => n - lim >= T.failStreak);
  const limited = streaks.filter(([, , , lim]) => lim >= T.limitStreak);
  for (const [kind, list] of [['model-failing', failing], ['rate-limited', limited]] as const) {
    if (!list.length) continue;
    const worst = list.reduce((a, b) => (b[2] > a[2] ? b : a));
    const last = Math.max(...list.map(([, l]) => l));
    out.push({ kind, key: 'calls', count: kind === 'rate-limited' ? worst[3] : worst[2] - worst[3], first: iso(Math.min(...list.map(([f]) => f))), last: iso(last),
      active: now - last <= T.activeMs, detail: { streaks: list.length, longest: worst[2] } });
  }
  return out;
}

/** The two agents of a consult loop in a stable order: one incident (and key) for the pair. */
export function consultPair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}
/** Whether an incident shows on this agent: its own, or a consult loop it is half of (key "x+y"). */
export function incidentConcerns(i: Pick<TokenIncidentRow, 'agentId' | 'kind' | 'key'>, agentId: string): boolean {
  return i.agentId === agentId || (i.kind === 'consult-ping-pong' && i.key.split('+').includes(agentId));
}

// ---------------------------------------------------------------------------
// Incident wording
// ---------------------------------------------------------------------------

const K = (n: number) => (n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}K`);
/** "08:19" today, "Oct 3 08:19" before: the machine's own time zone, as the owner reads it. */
export function clockOf(t: string | number, now = Date.now()): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`;
}
const chan = (c: unknown) => (typeof c === 'string' && c && c !== 'channel' ? c[0]!.toUpperCase() + c.slice(1) : 'Chat-app');

/** What the owner reads under Alerts and on the manager's chat, and the fix. */
export function incidentWords(s: LoopSignal, ctx: { conversationK?: number; agentName?: (id: string) => string; now?: number; fleetLimitMs?: number } = {}): { text: string; fix: string } {
  const now = ctx.now ?? Date.now();
  const T = THRESHOLDS;
  const d = s.detail;
  const fleetMin = Math.round((ctx.fleetLimitMs ?? channelHandlerTimeoutMs() ?? OPENCLAW_HANDLER_TIMEOUT_MS) / 60_000);
  switch (s.kind) {
    case 'channel-retry': {
      const limitMin = Math.max(1, Math.round(Number(d.limitMs ?? OPENCLAW_HANDLER_TIMEOUT_MS) / 60_000));
      const size = ctx.conversationK ? `a ${ctx.conversationK}K conversation` : 'its conversation';
      const why = d.compaction ? `compacting ${size} takes longer than the ${limitMin}-minute limit` : `it did not get going within the ${limitMin}-minute limit`;
      return {
        text: `Stuck: ${chan(d.channel)} message retried ${s.count} times since ${clockOf(s.first, now)} — ${why}`,
        fix: d.compaction
          ? `Have Hatchabot compact it keeping the last ${T.keepLines} lines (it takes seconds, so it finishes between retries), or rebuild it so the ${fleetMin}-minute limit applies and the summary can finish. Left alone, OpenClaw keeps retrying until 8 tries and 24 hours.`
          : `Rebuild it so the ${fleetMin}-minute limit applies, and look at its log for what held the message. Left alone, OpenClaw keeps retrying until 8 tries and 24 hours.`,
      };
    }
    case 'compaction-failing':
      return {
        text: `Compaction failing: ${s.count} attempts failed since ${clockOf(s.first, now)}`,
        fix: `Have Hatchabot compact it keeping the last ${T.keepLines} lines, or give it a context cap so it compacts earlier, when there is less to summarise.`,
      };
    case 'task-failing':
      return {
        text: Number(d.reruns) >= T.taskRerunLoop
          ? `Scheduled task "${String(d.task)}" re-ran ${String(d.reruns)} times after errors in a day`
          : `Scheduled task "${String(d.task)}" failed ${String(d.streak)} runs in a row (last ${clockOf(s.last, now)})`,
        fix: 'Look at the task and its last error (its Schedules tab, or ask Hatchabot); turn it off until it is fixed. '
          + 'If it is an app\'s task (its page → App), the app says why: often an account it needs is not attached.',
      };
    case 'consult-ping-pong': {
      // One incident for the pair: both named, in a stable order.
      const [x, y] = consultPair(String(d.self ?? ''), String(d.with ?? ''));
      const name = (id: string) => (id && ctx.agentName?.(id)) || 'another agent';
      return {
        text: `Consult loop: "${name(x)}" and "${name(y)}" asked each other ${s.count} times in ${String(d.minutes)} minutes`,
        fix: `Take one off the other's peers, or tell them when to stop asking. Hatchabot refuses a consult while one is in flight between them; this is them starting new ones.`,
      };
    }
    case 'tool-loop':
      return {
        text: Number(d.guardStops)
          ? `Tool loop: OpenClaw's loop guard stopped ${String(d.guardStops)} of its runs (since ${clockOf(s.first, now)})`
          : `Tool loop: a turn made ${String(d.maxTools)} tool calls (${String(d.bigTurns)} such turn${Number(d.bigTurns) === 1 ? '' : 's'} since ${clockOf(s.first, now)})`,
        fix: 'Look at what it was doing (its log); a narrower task or a stronger model usually ends it.',
      };
    case 'model-failing':
      return {
        text: `Model calls failing: ${s.count} in a row (last ${clockOf(s.last, now)})`,
        fix: 'Check its AI source and its health; if the model is the problem, try another one.',
      };
    case 'rate-limited':
      return { text: `Rate-limited ${s.count} calls in a row (last ${clockOf(s.last, now)})`, fix: 'Its AI source is at its limit; spread the work or add a source.' };
  }
}

// ---------------------------------------------------------------------------
// The report (get_token_health)
// ---------------------------------------------------------------------------

export interface TokenHealthRow {
  agent: string;
  id: string;
  state: string;
  model: string;
  billing: 'plan' | 'api' | 'local';
  /** How old the reading is (hours); none = never read. */
  readHoursAgo?: number;
  conversation?: {
    calls: number;
    /** Context per call, thousands of tokens: median, 90th percentile, largest. */
    ctxK: { p50: number; p90: number; max: number };
    /** Share of conversation calls that carried more than 100K. */
    over100kShare: number;
    /** The main conversation (Telegram DM and console) at its last call, thousands. */
    mainNowK?: number;
    mainAt?: string;
    largest?: { kind: string; nowK: number };
    compactions30d: number;
    lastCompaction?: { at: string; beforeK: number };
    /** A compaction of the main conversation running now (from the ledger and this process), since when. */
    compacting?: { since: string; beforeK?: number };
    /** mainNowK is the size a compaction left, newer than the last measured call (until the next call measures it again). */
    mainAfterCompaction?: { at: string; beforeK?: number; already?: boolean };
  };
  /** The context cap: set by Hatchabot (and whether it is in the agent's config), and what OpenClaw then compacts at. */
  contextCap?: { tokens?: number; applied: boolean; compactsAtK?: number; model?: string };
  cache?: {
    /** Cache reads ÷ everything carried in: a turn's first call within 5 minutes of the previous one … */
    firstOfTurnHit?: number;
    firstOfTurnCalls: number;
    /** … turns starting after a longer pause (0% is normal: the 5-minute cache is gone) … */
    afterPauseCalls: number;
    /** … and calls inside a turn. */
    insideHit?: number;
    insideCalls: number;
  };
  /** The 30 days at API list prices (USD), by what started the work. */
  cost30d?: { chat: number; followups: number; scheduled: number; total: number; partial?: true };
  scheduled?: {
    tasks: number | null;
    runs30d: number;
    failed30d: number;
    reruns30d: number;
    perTask: Array<{ id: string; name?: string; runs: number; runsPerDay: number; costPerRunUSD?: number; failed: number; streak: number; reruns: number; lastStatus: string; lastRun: string }>;
  };
  instructions?: {
    files: Record<string, number>;
    /** What OpenClaw puts in every turn (each file to 20K characters, 60K in all) and about how many tokens. */
    injectedChars: number;
    tokensPerTurn: number;
    truncated: string[];
  };
  thinking?: { level: string; shareOfCalls?: number };
  loops: LoopSignal[];
  incidents: Array<Pick<TokenIncidentRow, 'id' | 'kind' | 'text' | 'fix' | 'openedAt' | 'count'>>;
  /** Plain flags for the steward: large-conversation, compact-now, cache-break, big-instructions, task-failing, thinking-heavy, loop. */
  flags: string[];
}

export interface TokenHealthReport {
  generatedAt: string;
  rows: TokenHealthRow[];
  omitted: number;
  thresholds: typeof THRESHOLDS;
  /** The newest compactions and caps (the token ledger). */
  actions: TokenActionRow[];
  notes: string[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const kOf = (n: number) => Math.round(n / 1000);
const mix = (m: Mix4) => ({ input: m[0], output: m[1], cacheRead: m[2], cacheWrite: m[3] });
function priced(byModel: Record<string, Mix4> | undefined): { usd: number; partial: boolean } {
  let usd = 0, partial = false;
  for (const [model, m] of Object.entries(byModel ?? {})) {
    const p = priceMix(model, mix(m));
    if (p === undefined) { if (m.some((x) => x > 0)) partial = true; } else usd += p;
  }
  return { usd, partial };
}
const hit = (c: CacheTally | undefined) => (c && c[2] > 0 ? r2(c[1] / c[2]) : undefined);

/** The files' injected size, as OpenClaw caps it (system-prompt.md: 20,000 characters a file, 60,000 in all). */
export function injectedSize(files: Record<string, number>): { chars: number; truncated: string[] } {
  const T = THRESHOLDS;
  let chars = 0; const truncated: string[] = [];
  for (const [name, size] of Object.entries(files)) {
    if (name === 'BOOTSTRAP.md') continue; // only on a brand-new workspace
    if (size > T.bootstrapMaxChars) truncated.push(name);
    chars += Math.min(size, T.bootstrapMaxChars);
  }
  if (chars > T.bootstrapTotalMaxChars) { chars = T.bootstrapTotalMaxChars; truncated.push('(total)'); }
  return { chars, truncated };
}

/** The provider and id OpenClaw files a model under (`anthropic/claude-sonnet-5`). */
export function modelRefOf(agent: Pick<Agent, 'model'>, profile: Pick<AIProfile, 'vendor' | 'model' | 'models'>): { provider: string; id: string } {
  const provider = profile.vendor === 'local' ? 'ollama' : profile.vendor === 'google' ? 'google' : profile.vendor === 'openai' ? 'openai' : 'anthropic';
  return { provider, id: effectiveModel(agent, profile) };
}

function stateOf(a: Agent): string {
  if (a.state === 'STOPPED' && a.hibernatedAt) return 'asleep';
  if (a.state === 'RUNNING') return 'awake';
  return a.state.toLowerCase();
}

export function tokenHealthRow(a: Agent, profile: AIProfile | undefined, stored: { health: TokenHealthRaw; at: string } | undefined, ctx: {
  now: number; marks: StoredMark[]; consults: Array<{ to: string; from: string; at: string }>; incidents: TokenIncidentRow[];
  cap?: { tokens?: number; appliedModel?: string };
  /** The owner's enabled scheduled tasks, from the model profile (null = unreadable). */
  crons?: number | null;
  /** Its latest compaction of the main conversation, from the token ledger. */
  compaction?: TokenActionRow;
  /** Whether that compaction is running in this process now. */
  compacting?: boolean;
}): TokenHealthRow {
  const T = THRESHOLDS;
  const h = stored?.health;
  const model = profile ? effectiveModel(a, profile) : a.model ?? '(unknown)';
  const billing: TokenHealthRow['billing'] = profile?.vendor === 'local' ? 'local' : profile?.kind === 'subscription' ? 'plan' : 'api';
  const flags: string[] = [];
  const row: TokenHealthRow = { agent: a.name, id: a.id, state: stateOf(a), model, billing, loops: [], incidents: [], flags };
  if (stored) row.readHoursAgo = Math.round((Math.max(0, ctx.now - Date.parse(stored.at)) / HOUR) * 10) / 10;
  if (ctx.cap?.tokens || ctx.cap?.appliedModel) {
    row.contextCap = { ...(ctx.cap.tokens ? { tokens: ctx.cap.tokens, compactsAtK: kOf(ctx.cap.tokens - Math.min(20_000, ctx.cap.tokens / 4)) } : {}),
      applied: !!ctx.cap.tokens && !!ctx.cap.appliedModel, ...(ctx.cap.appliedModel ? { model: ctx.cap.appliedModel } : {}) };
  }
  row.incidents = ctx.incidents.filter((i) => incidentConcerns(i, a.id) && !i.clearedAt).map((i) => ({ id: i.id, kind: i.kind, text: i.text, ...(i.fix ? { fix: i.fix } : {}), openedAt: i.openedAt, count: i.count }));
  if (h) {
    const mainNow = h.main?.[a.slug];
    row.conversation = {
      calls: h.conv.calls,
      ctxK: { p50: kOf(h.conv.p50), p90: kOf(h.conv.p90), max: kOf(h.conv.max) },
      over100kShare: h.conv.calls ? r2(h.conv.over100k / h.conv.calls) : 0,
      ...(mainNow ? { mainNowK: kOf(mainNow.ctx), mainAt: iso(mainNow.at) } : {}),
      ...(h.top?.[0] ? { largest: { kind: h.top[0].kind, nowK: kOf(h.top[0].ctx) } } : {}),
      compactions30d: h.compactions?.n ?? 0,
      ...(h.compactions?.last ? { lastCompaction: { at: iso(h.compactions.last), beforeK: kOf(h.compactions.before) } } : {}),
    };
    if (h.conv.calls >= 10 && h.conv.p50 >= T.largeConversation) flags.push('large-conversation');
    // The size Hatchabot measured is the last call's, so a compaction since
    // then (or one running) is newer news: without this the advice to compact
    // stayed after it was done, and a second click got "Already compacted"
    // (2026-10-10).
    const cp = ctx.compaction;
    const cd = (cp?.detail ?? {}) as { beforeK?: number; afterK?: number; reason?: string };
    const cpAt = cp ? Date.parse(cp.at) : NaN;
    let mainCtx = mainNow?.ctx ?? 0;
    if (cp && cp.outcome === 'running' && ctx.compacting) {
      row.conversation.compacting = { since: cp.at, ...(cd.beforeK !== undefined ? { beforeK: cd.beforeK } : {}) };
    } else if (cp && (cp.outcome === 'ok' || /already compacted/i.test(cd.reason ?? '')) && mainNow && cpAt > mainNow.at) {
      const already = cd.afterK === undefined;
      if (cd.afterK !== undefined) { mainCtx = cd.afterK * 1000; row.conversation.mainNowK = cd.afterK; } else mainCtx = 0;
      row.conversation.mainAfterCompaction = { at: cp.at, ...(cd.beforeK !== undefined ? { beforeK: cd.beforeK } : {}), ...(already ? { already: true } : {}) };
    }
    if (mainCtx >= T.compactNow && !row.conversation.compacting) flags.push('compact-now');
    row.cache = {
      ...(hit(h.cache.first5) !== undefined ? { firstOfTurnHit: hit(h.cache.first5) } : {}),
      firstOfTurnCalls: h.cache.first5[0], afterPauseCalls: h.cache.firstCold[0],
      ...(hit(h.cache.inside) !== undefined ? { insideHit: hit(h.cache.inside) } : {}),
      insideCalls: h.cache.inside[0],
    };
    if (h.cache.first5[0] >= T.minCacheCalls && (hit(h.cache.first5) ?? 1) < T.firstTurnHitLow) flags.push('cache-break');
    if (billing !== 'local') {
      const c = priced(h.split.chat), f = priced(h.split.followup), s = priced(h.split.scheduled);
      row.cost30d = { chat: r2(c.usd), followups: r2(f.usd), scheduled: r2(s.usd), total: r2(c.usd + f.usd + s.usd), ...(c.partial || f.partial || s.partial ? { partial: true as const } : {}) };
    }
    const days = Math.max(1, Math.min(30, (ctx.now - h.since) / DAY));
    const jobs = h.jobs ?? [];
    const perTask = jobs.map((j) => {
      const jd = Math.max(1, Math.min(days, (ctx.now - j.first) / DAY));
      const cost = billing === 'local' ? undefined : priced(h.jobTokens?.[j.id]);
      const reruns = (j.rr ?? []).filter(([, gap]) => gap <= T.taskRerunWindowMs).length;
      return { id: j.id, ...(j.name ? { name: j.name } : {}), runs: j.runs, runsPerDay: r2(j.runs / jd),
        ...(cost && j.runs && !cost.partial && cost.usd > 0 ? { costPerRunUSD: r2(cost.usd / j.runs) } : {}),
        failed: j.error + j.interrupted, streak: j.streak, reruns, lastStatus: j.lastStatus, lastRun: iso(j.last) };
    }).sort((x, y) => y.runs - x.runs);
    row.scheduled = {
      tasks: typeof ctx.crons === 'number' ? ctx.crons : null,
      runs30d: jobs.reduce((s, j) => s + j.runs, 0),
      failed30d: jobs.reduce((s, j) => s + j.error + j.interrupted, 0),
      reruns30d: perTask.reduce((s, j) => s + j.reruns, 0),
      perTask: perTask.slice(0, 6),
    };
    const files = h.files?.[a.slug] ?? {};
    if (Object.keys(files).length) {
      const inj = injectedSize(files);
      row.instructions = { files, injectedChars: inj.chars, tokensPerTurn: Math.round(inj.chars / 4), truncated: inj.truncated };
      if (inj.chars >= T.instructionChars || inj.truncated.length) flags.push('big-instructions');
    }
    const level = h.cfg?.agentThinking?.[a.slug] ?? h.cfg?.modelThinking?.[`${profile ? modelRefOf(a, profile).provider : 'anthropic'}/${model}`] ?? h.cfg?.thinkingDefault;
    row.thinking = { level: level ?? 'model default', ...(h.thinking?.of ? { shareOfCalls: r2(h.thinking.calls / h.thinking.of) } : {}) };
    if ((h.thinking?.of ?? 0) >= 10 && h.thinking.calls / h.thinking.of > T.thinkingShare) flags.push('thinking-heavy');
  }
  row.loops = loopSignals({ agentId: a.id, health: h, marks: ctx.marks, consults: ctx.consults, now: ctx.now });
  if (row.loops.some((l) => l.kind === 'task-failing')) flags.push('task-failing');
  if (row.loops.some((l) => l.active && l.kind !== 'rate-limited')) flags.push('loop');
  return row;
}

/**
 * The report for one owner: their own agents (archived ones are not reviewed),
 * costliest first. Stored data only.
 */
export function buildTokenHealth(store: Store, ownerId: string, opts: { now?: number; limit?: number; agentId?: string } = {}): TokenHealthReport {
  const now = opts.now ?? Date.now();
  const limit = Math.min(Math.max(1, opts.limit ?? 40), 100);
  let agents = store.listAgents(ownerId).filter((a) => a.state !== 'DELETED' && a.state !== 'ARCHIVED');
  if (opts.agentId) agents = agents.filter((a) => a.id === opts.agentId);
  const ids = agents.map((a) => a.id);
  const healths = store.tokenHealths(ids) as Map<string, { health: TokenHealthRaw; at: string }>;
  const since = new Date(now - THRESHOLDS.lookbackMs).toISOString();
  const marks = store.loopMarks(ids, since);
  const consults = store.consultEvents(store.listAgents(ownerId).map((a) => a.id), since);
  const incidents = store.listTokenIncidents({ ownerId, open: true });
  const crons = store.modelProfiles(ids) as Map<string, { profile: { crons?: number | null } }>;
  const compactions = store.lastMainCompactions(ids);
  const profiles = new Map<string, AIProfile | undefined>();
  const profileOf = (id: string) => { if (!profiles.has(id)) profiles.set(id, store.getAIProfile(id)); return profiles.get(id); };
  const rows = agents.map((a) => tokenHealthRow(a, profileOf(a.aiProfileId), healths.get(a.id), {
    now, marks: marks.filter((m) => m.agentId === a.id), consults, incidents, cap: store.getContextCap(a.id), crons: crons.get(a.id)?.profile.crons,
    compaction: compactions.get(a.id), compacting: compactingNow.has(a.id),
  })).sort((x, y) => (y.cost30d?.total ?? -1) - (x.cost30d?.total ?? -1) || (y.conversation?.calls ?? 0) - (x.conversation?.calls ?? 0));
  const shown = rows.slice(0, limit);
  return {
    generatedAt: new Date(now).toISOString(),
    rows: shown,
    omitted: rows.length - shown.length,
    thresholds: THRESHOLDS,
    actions: store.listTokenActions({ ownerId, limit: 10 }),
    notes: [
      'Last 30 days from each agent\'s own transcripts, as the usage pass last read them (readHoursAgo); asleep agents are not woken. Costs are API list prices; on a Claude plan that is an equivalent, not a bill.',
      'Context per call = what each model call carried in (prompt + cache). The cache: a turn\'s first call within 5 minutes of the previous one should read most of it back; 0% after a longer pause is normal (the cache lasts 5 minutes).',
      'loops are counts and times (no message text): channel-retry = a chat-app message retried after OpenClaw\'s handler limit; compaction-failing; task-failing; consult-ping-pong; tool-loop; model-failing (rate-limited is the source\'s limit). active = still going.',
    ],
  };
}
