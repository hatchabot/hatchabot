import type { Store } from '../store/store.js';
import type { RuntimeProvider } from '../providers/provider.js';
import type { Agent } from '../domain/types.js';
import { agentUsage } from './usage.js';

/**
 * AI-source usage visibility. Anthropic won't tell a setup-token how much of a
 * Claude plan's 5-hour / weekly allowance is left (its usage endpoint needs the
 * user:profile scope those tokens lack), so we measure what we CAN see:
 *
 *  - every model call an agent makes — OpenClaw logs one line per call, with
 *    its HTTP status, so we count requests and, crucially, 429 "rate limit
 *    reached" answers per source, per hour;
 *  - each agent's cumulative token counter, sampled, so tokens per window are
 *    the sum of its increases.
 *
 * The windows match how Claude plans are limited: the last 5 hours and 7 days.
 */

export interface ModelCall { at: string; provider: string; model: string; status: number }

// docker logs --timestamps prefixes each line with its RFC3339 time; OpenClaw's
// line then reads "[provider-transport-fetch] [model-fetch] response provider=…
// model=… status=429 elapsedMs=…". Start lines (no status) are ignored.
const CALL_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s.*\[model-fetch\] response provider=(\S+)(?:.*?\smodel=(\S+))?.*?\sstatus=(\d{3})\b/;

export function parseModelCalls(text: string): ModelCall[] {
  const out: ModelCall[] = [];
  for (const line of text.split('\n')) {
    const m = CALL_RE.exec(line);
    if (!m) continue;
    // Normalise docker's nanosecond stamp to milliseconds so string order = time order.
    const at = new Date(m[1]!).toISOString();
    out.push({ at, provider: m[2]!, model: m[3] ?? '', status: Number(m[4]) });
  }
  return out;
}

/** UTC hour bucket, e.g. 2026-09-15T17. */
export function hourOf(iso: string): string { return iso.slice(0, 13); }
/** The five-minute slot an instant falls in: "2026-09-25T01:25". */
export function slotOf(iso: string): string {
  const m = Math.floor((Number(iso.slice(14, 16)) || 0) / 5) * 5;
  return `${iso.slice(0, 14)}${String(m).padStart(2, '0')}`;
}

const DAY = 86_400_000;
export /** How many agents to sample at once, and how long one whole pass may take. */
const PASS_CONCURRENCY = Number(process.env.HATCHABOT_USAGE_CONCURRENCY ?? 6);
const PASS_BUDGET_MS = Number(process.env.HATCHABOT_USAGE_PASS_MS ?? 5 * 60_000);
const RETAIN_MS = 8 * DAY;

export interface SampleDeps {
  store: Store;
  providerFor: (hostId: string) => RuntimeProvider;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

/** One pass over every running agent: new model calls since last time + a token sample. */
export async function sampleSourceUsage(deps: SampleDeps, now = Date.now()): Promise<{ agents: number; calls: number; limited: number }> {
  const { store } = deps;
  let agents = 0, calls = 0, limited = 0;
  const nowIso = new Date(now).toISOString();
  // One slow `docker logs` used to hold up every agent behind it: 41 agents
  // × a 60 s kill is 41 minutes, far past the sample interval, with the next
  // pass blocked behind it. Sample a few at a time, and stop starting new ones
  // once the pass has run long enough (audit 2026-09-16).
  const deadline = Date.now() + PASS_BUDGET_MS;
  const running = store.listAllActiveAgents().filter((a) => a.state === 'RUNNING' && a.runtimeRef);
  const queue = [...running];
  const one = async (a: (typeof running)[number]): Promise<void> => {
    const runtimeRef = a.runtimeRef;
    if (!runtimeRef) return;
    agents++;
    const provider = deps.providerFor(a.hostId);
    const cursor = store.usageCursor(a.id);
    const since = cursor?.lastTs ?? new Date(now - 7 * DAY).toISOString(); // first run: a week of history
    try {
      const text = await provider.modelCallLog(runtimeRef, since);
      const fresh = parseModelCalls(text).filter((c) => c.at > since);
      const buckets = new Map<string, { ok: number; limited: number; failed: number }>();
      const slots = new Map<string, { ok: number; limited: number; failed: number }>();
      let lastOk: string | undefined, lastLimited: string | undefined, maxAt = since;
      for (const c of fresh) {
        const b = buckets.get(hourOf(c.at)) ?? { ok: 0, limited: 0, failed: 0 };
        const sb = slots.get(slotOf(c.at)) ?? { ok: 0, limited: 0, failed: 0 };
        if (c.status >= 200 && c.status < 300) { b.ok++; sb.ok++; lastOk = c.at; }
        else if (c.status === 429) { b.limited++; sb.limited++; lastLimited = c.at; store.addLimitHit(a.id, a.aiProfileId, c.at, c.model); limited++; }
        else { b.failed++; sb.failed++; }
        buckets.set(hourOf(c.at), b);
        slots.set(slotOf(c.at), sb);
        if (c.at > maxAt) maxAt = c.at;
      }
      store.addModelCallHours(a.id, a.aiProfileId, buckets);
      store.addModelCallSlots(a.id, a.aiProfileId, slots);
      calls += fresh.length;
      // No new calls: still move the cursor on (minus a little), so an idle agent
      // isn't rescanned from a week ago every pass.
      const next = fresh.length ? maxAt : new Date(Math.max(Date.parse(since), now - 5 * 60_000)).toISOString();
      store.setUsageCursor(a.id, next, lastOk, lastLimited);
    } catch (err) {
      deps.log?.('usage.sample_log_failed', { agentId: a.id, error: String((err as Error).message ?? err).slice(0, 200) });
    }
    try {
      const u = await agentUsage(provider, runtimeRef, a.slug);
      store.addTokenSample(a.id, a.aiProfileId, nowIso, u.totalTokens);
    } catch { /* container busy/unreachable: no token sample this pass */ }
  };
  const worker = async (): Promise<void> => {
    for (;;) {
      const a = queue.shift();
      if (!a || Date.now() > deadline) return;
      await one(a);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PASS_CONCURRENCY, queue.length) }, worker));
  if (queue.length) deps.log?.('usage.sample_incomplete', { remaining: queue.length });
  store.pruneSourceUsage(new Date(now - RETAIN_MS).toISOString());
  return { agents, calls, limited };
}

export interface SourceWindow { requests: number; limited: number; failed: number; tokens: number }
export interface SourceUsage {
  id: string;
  name: string;
  agents: number;
  /** The last hour: what the home screen's "tokens / hr" tile counts (samples are ten minutes apart). */
  window1h: SourceWindow;
  window5h: SourceWindow;
  window24h: SourceWindow;
  window7d: SourceWindow;
  /** limited = the latest call through this source was refused and none has succeeded since. */
  status: 'ok' | 'limited' | 'idle';
  limitedSince?: string;
  lastLimitAt?: string;
  lastOkAt?: string;
  limitHits7d: number;
  /** Token counts need two samples per agent, so they cover only the time since this. */
  tokensSince?: string;
  topAgents: Array<{ name: string; requests: number; tokens: number; limited: number }>;
  /** 168 hourly buckets, oldest first. */
  hourly: Array<{ hour: string; ok: number; limited: number }>;
  /** 288 five-minute buckets covering the last day, oldest first (the chart's hour and day views). */
  slots: Array<{ slot: string; ok: number; limited: number }>;
  /** Other accounts' agents on a source you own count toward the same limit (counts only). */
  others?: { agents: number; requests5h: number; requests7d: number };
}

/** Per-source usage for one viewer: their own agents, plus other accounts' totals on sources they own. */
export function summarizeSourceUsage(store: Store, ownerId: string, now = Date.now()): SourceUsage[] {
  const mine = store.listAgents(ownerId).filter((a) => a.state !== 'DELETED');
  const all = store.listAllActiveAgents();
  const h1 = hourOf(new Date(now - 3_600_000).toISOString());
  const h5 = hourOf(new Date(now - 5 * 3_600_000).toISOString());
  const h24 = hourOf(new Date(now - 24 * 3_600_000).toISOString());
  const d7 = hourOf(new Date(now - 7 * DAY).toISOString());
  const hours = Array.from({ length: 168 }, (_, i) => hourOf(new Date(now - (167 - i) * 3_600_000).toISOString()));
  const t1 = new Date(now - 3_600_000).toISOString();
  const t5 = new Date(now - 5 * 3_600_000).toISOString(), t7 = new Date(now - 7 * DAY).toISOString();
  const t24 = new Date(now - 24 * 3_600_000).toISOString();
  const out: SourceUsage[] = [];
  for (const p of store.listAIProfiles(ownerId)) {
    // Agents CURRENTLY on this source — what "8 agents" means.
    const my = mine.filter((a) => a.aiProfileId === p.id);
    // …but history belongs to whoever spent it. Rows and limit hits are already
    // scoped to this source in SQL, so gate them on ownership, not on where the
    // agent happens to sit now: an agent that moved off after being rate-limited
    // used to erase that hit from BOTH sources' views — the one moment someone
    // would go looking for it (audit 2026-09-16).
    const myIds = new Set(mine.map((a) => a.id));
    const nameOf = new Map(mine.map((a) => [a.id, a.name]));
    const rows = store.modelCallHoursFor(p.id, d7);
    const mineRows = rows.filter((r) => myIds.has(r.agentId));
    const w = (from: string, list = mineRows): Omit<SourceWindow, 'tokens'> => list.filter((r) => r.hour >= from)
      .reduce((s, r) => ({ requests: s.requests + r.ok + r.limited + r.failed, limited: s.limited + r.limited, failed: s.failed + r.failed }), { requests: 0, limited: 0, failed: 0 });
    const tokensFor = (agentIds: Set<string>, fromIso: string) => store.tokenIncreases(p.id, fromIso, agentIds);
    const cursors = my.map((a) => store.usageCursor(a.id)).filter(Boolean) as Array<{ lastOk?: string; lastLimited?: string }>;
    const lastOkAt = cursors.map((c) => c.lastOk).filter(Boolean).sort().at(-1);
    const lastLimitAt = cursors.map((c) => c.lastLimited).filter(Boolean).sort().at(-1);
    const hits = store.limitHitsFor(p.id, t7).filter((h) => myIds.has(h.agentId));
    let status: SourceUsage['status'] = lastOkAt || lastLimitAt ? 'ok' : 'idle';
    let limitedSince: string | undefined;
    // A refusal counts as current only within the limit's own window: a Claude
    // plan's 5-hour window, minutes for an API key. Before this, "rate-limited"
    // stuck from the last refusal until some agent happened to call again — a
    // MacBook showed it 19 hours after its plan had reset (2026-09-25).
    const stillCounts = lastLimitAt ? now - Date.parse(lastLimitAt) <= (p.kind === 'subscription' ? 5 * 3_600_000 : 15 * 60_000) : false;
    if (lastLimitAt && stillCounts && (!lastOkAt || lastLimitAt > lastOkAt)) {
      status = 'limited';
      limitedSince = hits.filter((h) => !lastOkAt || h.at > lastOkAt).map((h) => h.at).sort()[0] ?? lastLimitAt;
    }
    const byAgent = new Map<string, { requests: number; limited: number }>();
    for (const r of mineRows) {
      const b = byAgent.get(r.agentId) ?? { requests: 0, limited: 0 };
      b.requests += r.ok + r.limited + r.failed; b.limited += r.limited;
      byAgent.set(r.agentId, b);
    }
    const perAgentTokens = store.tokenIncreasesByAgent(p.id, t7, myIds);
    const topAgents = mine.map((a: Agent) => ({ name: nameOf.get(a.id) ?? a.name, requests: byAgent.get(a.id)?.requests ?? 0, limited: byAgent.get(a.id)?.limited ?? 0, tokens: perAgentTokens.get(a.id) ?? 0 }))
      .filter((x) => x.requests || x.tokens)
      .sort((x, y) => y.requests - x.requests || y.tokens - x.tokens)
      .slice(0, 5);
    const hourMap = new Map<string, { ok: number; limited: number }>();
    for (const r of mineRows) {
      const b = hourMap.get(r.hour) ?? { ok: 0, limited: 0 };
      b.ok += r.ok + r.failed; b.limited += r.limited;
      hourMap.set(r.hour, b);
    }
    const slotStart = slotOf(new Date(now - DAY).toISOString());
    const slotMap = new Map<string, { ok: number; limited: number }>();
    for (const r of store.modelCallSlotsFor(p.id, slotStart)) {
      if (!myIds.has(r.agentId)) continue;
      const b = slotMap.get(r.slot) ?? { ok: 0, limited: 0 };
      b.ok += r.ok + r.failed; b.limited += r.limited;
      slotMap.set(r.slot, b);
    }
    const slotsList = Array.from({ length: 288 }, (_, i) => slotOf(new Date(now - (287 - i) * 300_000).toISOString()));
    const entry: SourceUsage = {
      id: p.id, name: p.name, agents: my.length,
      window1h: { ...w(h1), tokens: tokensFor(myIds, t1) },
      window5h: { ...w(h5), tokens: tokensFor(myIds, t5) },
      window24h: { ...w(h24), tokens: tokensFor(myIds, t24) },
      window7d: { ...w(d7), tokens: tokensFor(myIds, t7) },
      status, limitedSince, lastLimitAt, lastOkAt, limitHits7d: hits.length, topAgents,
      tokensSince: store.firstTokenSampleAt(p.id, myIds),
      hourly: hours.map((hour) => ({ hour, ...(hourMap.get(hour) ?? { ok: 0, limited: 0 }) })),
      slots: slotsList.map((slot) => ({ slot, ...(slotMap.get(slot) ?? { ok: 0, limited: 0 }) })),
    };
    if (p.ownerId === ownerId) {
      const theirIds = new Set(all.filter((a) => a.aiProfileId === p.id && a.ownerId !== ownerId).map((a) => a.id));
      if (theirIds.size) {
        const theirRows = rows.filter((r) => theirIds.has(r.agentId));
        entry.others = { agents: theirIds.size, requests5h: w(h5, theirRows).requests, requests7d: w(d7, theirRows).requests };
      }
    }
    out.push(entry);
  }
  return out;
}
