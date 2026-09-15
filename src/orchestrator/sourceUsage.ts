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

const DAY = 86_400_000;
export const RETAIN_MS = 8 * DAY;

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
  for (const a of store.listAllActiveAgents()) {
    if (a.state !== 'RUNNING' || !a.runtimeRef) continue;
    agents++;
    const provider = deps.providerFor(a.hostId);
    const cursor = store.usageCursor(a.id);
    const since = cursor?.lastTs ?? new Date(now - 7 * DAY).toISOString(); // first run: a week of history
    try {
      const text = await provider.modelCallLog(a.runtimeRef, since);
      const fresh = parseModelCalls(text).filter((c) => c.at > since);
      const buckets = new Map<string, { ok: number; limited: number; failed: number }>();
      let lastOk: string | undefined, lastLimited: string | undefined, maxAt = since;
      for (const c of fresh) {
        const b = buckets.get(hourOf(c.at)) ?? { ok: 0, limited: 0, failed: 0 };
        if (c.status >= 200 && c.status < 300) { b.ok++; lastOk = c.at; }
        else if (c.status === 429) { b.limited++; lastLimited = c.at; store.addLimitHit(a.id, a.aiProfileId, c.at, c.model); limited++; }
        else b.failed++;
        buckets.set(hourOf(c.at), b);
        if (c.at > maxAt) maxAt = c.at;
      }
      store.addModelCallHours(a.id, a.aiProfileId, buckets);
      calls += fresh.length;
      // No new calls: still move the cursor on (minus a little), so an idle agent
      // isn't rescanned from a week ago every pass.
      const next = fresh.length ? maxAt : new Date(Math.max(Date.parse(since), now - 5 * 60_000)).toISOString();
      store.setUsageCursor(a.id, next, lastOk, lastLimited);
    } catch (err) {
      deps.log?.('usage.sample_log_failed', { agentId: a.id, error: String((err as Error).message ?? err).slice(0, 200) });
    }
    try {
      const u = await agentUsage(provider, a.runtimeRef, a.slug);
      store.addTokenSample(a.id, a.aiProfileId, nowIso, u.totalTokens);
    } catch { /* container busy/unreachable: no token sample this pass */ }
  }
  store.pruneSourceUsage(new Date(now - RETAIN_MS).toISOString());
  return { agents, calls, limited };
}

export interface SourceWindow { requests: number; limited: number; failed: number; tokens: number }
export interface SourceUsage {
  id: string;
  name: string;
  agents: number;
  window5h: SourceWindow;
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
  /** Other accounts' agents on a source you own count toward the same limit (counts only). */
  others?: { agents: number; requests5h: number; requests7d: number };
}

/** Per-source usage for one viewer: their own agents, plus other accounts' totals on sources they own. */
export function summarizeSourceUsage(store: Store, ownerId: string, now = Date.now()): SourceUsage[] {
  const mine = store.listAgents(ownerId).filter((a) => a.state !== 'DELETED');
  const all = store.listAllActiveAgents();
  const h5 = hourOf(new Date(now - 5 * 3_600_000).toISOString());
  const d7 = hourOf(new Date(now - 7 * DAY).toISOString());
  const hours = Array.from({ length: 168 }, (_, i) => hourOf(new Date(now - (167 - i) * 3_600_000).toISOString()));
  const t5 = new Date(now - 5 * 3_600_000).toISOString(), t7 = new Date(now - 7 * DAY).toISOString();
  const out: SourceUsage[] = [];
  for (const p of store.listAIProfiles(ownerId)) {
    const my = mine.filter((a) => a.aiProfileId === p.id);
    const myIds = new Set(my.map((a) => a.id));
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
    if (lastLimitAt && (!lastOkAt || lastLimitAt > lastOkAt)) {
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
    const topAgents = my.map((a: Agent) => ({ name: a.name, requests: byAgent.get(a.id)?.requests ?? 0, limited: byAgent.get(a.id)?.limited ?? 0, tokens: perAgentTokens.get(a.id) ?? 0 }))
      .filter((x) => x.requests || x.tokens)
      .sort((x, y) => y.requests - x.requests || y.tokens - x.tokens)
      .slice(0, 5);
    const hourMap = new Map<string, { ok: number; limited: number }>();
    for (const r of mineRows) {
      const b = hourMap.get(r.hour) ?? { ok: 0, limited: 0 };
      b.ok += r.ok + r.failed; b.limited += r.limited;
      hourMap.set(r.hour, b);
    }
    const entry: SourceUsage = {
      id: p.id, name: p.name, agents: my.length,
      window5h: { ...w(h5), tokens: tokensFor(myIds, t5) },
      window7d: { ...w(d7), tokens: tokensFor(myIds, t7) },
      status, limitedSince, lastLimitAt, lastOkAt, limitHits7d: hits.length, topAgents,
      tokensSince: store.firstTokenSampleAt(p.id, myIds),
      hourly: hours.map((hour) => ({ hour, ...(hourMap.get(hour) ?? { ok: 0, limited: 0 }) })),
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
