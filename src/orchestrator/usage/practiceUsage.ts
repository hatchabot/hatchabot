import { randomUUID } from 'node:crypto';
import type { Agent } from '../../domain/types.js';
import type { PracticeUsageRow, Store } from '../../store/store.js';
import type { PracticeSpent } from '../skills/skillTrials.js';
import { LOCAL_MODEL, priceMix, type TokenMix } from '../sources/modelOptions.js';
import { dayKey, MACHINE, machineTz, monthKey, monthName, nextMonth, pauseDue } from './budgets.js';

/**
 * What skill Practice spent (HB-0933), counted once. A practice run calls the
 * agent's model on its source with a temporary state folder, and on the
 * runtime it runs on (2026.9.8) its transcript lands in that folder, removed
 * when the run ends, so the usage sampler never sees it. The run reads it
 * before the folder goes (skillTrials.ts `stateSpent`; what the run reported
 * when it holds no call), and Practice writes a row per model in
 * `practice_usage` before it answers, priced as a cost day is. Each row is
 * added wherever the agent's own calls count: its budget totals
 * (Store.costBetween, Store.unpricedBetween), its spike warnings and the usage
 * periods (Store.tokenDeltas), and its source's tokens, a Claude plan's among
 * them (Store.tokenIncreasesByAgent), and its Usage page adds it to the
 * agent's own reading and says how much was practice (practiceSummary,
 * foldPractice). So do the fleet's reading (GET /v1/usage), the cost badges,
 * the "At API prices" chart and its window pricing (practiceMixes), and the
 * usage periods' request counts (HB-1246); a source's request counts in
 * Settings → AI (summarizeSourceUsage) and the model scorecard's calls,
 * tokens and month (buildScorecard, HB-1270).
 */

/** Write one run's spend, and the calls its source refused (HB-1497); the tokens it came to. */
export function recordPracticeUsage(store: Store, agent: Agent, skill: string, status: string, spent: PracticeSpent[] | undefined,
  now = Date.now(), opts: { tz?: string } = {}): number {
  const tz = opts.tz ?? machineTz();
  if (!spent?.length) return 0;
  // The source its container runs on: a switch saved but not yet rebuilt still calls the old one.
  const profileId = agent.appliedProfileId ?? agent.aiProfileId;
  const local = store.getAIProfile(profileId)?.vendor === 'local';
  const at = new Date(now).toISOString(), day = dayKey(now, tz), run = randomUUID();
  const rows: PracticeUsageRow[] = [];
  let total = 0;
  for (const s of spent) {
    const tokens = s.input + s.output + s.cacheRead + s.cacheWrite;
    // A model whose calls were all refused spent nothing, and is kept for the refusals (HB-1497).
    const refused = s.refused ?? 0;
    if (!(tokens > 0) && !(refused > 0)) continue;
    total += tokens;
    const usd = tokens > 0 ? priceMix(s.model, s) : 0;
    rows.push({
      agentId: agent.id, run, model: s.model, ...(profileId ? { profileId } : {}), at, day, skill, status,
      calls: s.calls, input: s.input, output: s.output, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite,
      ...(refused > 0 ? { refused } : {}),
      usd: usd ?? 0,
      // No price known is not $0: kept apart, as a cost day's are (budgets.ts dailyCosts).
      unpricedTokens: usd === undefined && !local && !LOCAL_MODEL.test(s.model) ? tokens : 0,
    });
  }
  if (rows.length) store.addPracticeUsage(rows);
  return total;
}

/** One practice row as a model's token mix at the time it ran. */
export interface PracticeMix { model: string; at: number; calls: number; mix: TokenMix; profileId?: string }

/**
 * Each agent's practice rows that ran after `fromMs` and by `nowMs`, as token
 * mixes: what the cost badges and the "At API prices" chart add to the
 * agent's own hour buckets, which do not hold them (HB-1246).
 */
export function practiceMixes(store: Store, agentIds: Iterable<string>, fromMs: number, nowMs: number): Map<string, PracticeMix[]> {
  const out = new Map<string, PracticeMix[]>();
  if (!Number.isFinite(fromMs)) return out;
  for (const r of store.practiceUsageFor(agentIds, new Date(fromMs).toISOString())) {
    const at = Date.parse(r.at);
    if (!(at > fromMs) || at > nowMs) continue;
    const list = out.get(r.agentId) ?? [];
    list.push({ model: r.model, at, calls: r.calls, mix: { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite }, ...(r.profileId ? { profileId: r.profileId } : {}) });
    out.set(r.agentId, list);
  }
  return out;
}

export interface PracticeSummary {
  runs: number;
  calls: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** At API prices, as the budgets count it. */
  usd: number;
  /** When the newest run was. */
  last: string;
  /** The last 24 hours of it. */
  lastDay: { calls: number; tokens: number };
  byModel: Array<{ model: string; runs: number; calls: number; tokens: number }>;
}

/** An agent's practice runs as its Usage page shows them; undefined for none kept. */
export function practiceSummary(store: Store, agentId: string, now = Date.now()): PracticeSummary | undefined {
  const rows = store.practiceUsageFor([agentId]);
  if (!rows.length) return undefined;
  const dayAgo = new Date(now - 86_400_000).toISOString();
  const runs = new Set<string>(), byModel = new Map<string, { model: string; runs: Set<string>; calls: number; tokens: number }>();
  const s: PracticeSummary = { runs: 0, calls: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, last: '', lastDay: { calls: 0, tokens: 0 }, byModel: [] };
  for (const r of rows) {
    const tokens = r.input + r.output + r.cacheRead + r.cacheWrite;
    runs.add(r.run);
    s.calls += r.calls; s.tokens += tokens; s.usd += r.usd;
    s.input += r.input; s.output += r.output; s.cacheRead += r.cacheRead; s.cacheWrite += r.cacheWrite;
    if (r.at > s.last) s.last = r.at;
    if (r.at >= dayAgo) { s.lastDay.calls += r.calls; s.lastDay.tokens += tokens; }
    const m = byModel.get(r.model) ?? { model: r.model, runs: new Set<string>(), calls: 0, tokens: 0 };
    m.runs.add(r.run); m.calls += r.calls; m.tokens += tokens;
    byModel.set(r.model, m);
  }
  s.runs = runs.size;
  s.usd = Math.round(s.usd * 1e6) / 1e6;
  s.byModel = [...byModel.values()].map((m) => ({ model: m.model, runs: m.runs.size, calls: m.calls, tokens: m.tokens })).sort((a, b) => b.tokens - a.tokens);
  return s;
}

/**
 * The agent's usage reading (from its own transcripts) with its practice
 * added, which those transcripts do not hold. `practice` says how much of it
 * all was practice.
 */
export function foldPractice<U extends { totalTokens: number; calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; lastDay?: { calls: number; tokens: number } }>(u: U, p: PracticeSummary | undefined): U & { practice?: PracticeSummary } {
  if (!p) return u;
  const lastDay = u.lastDay || p.lastDay.tokens ? { calls: (u.lastDay?.calls ?? 0) + p.lastDay.calls, tokens: (u.lastDay?.tokens ?? 0) + p.lastDay.tokens } : undefined;
  return {
    ...u, totalTokens: u.totalTokens + p.tokens, calls: u.calls + p.calls,
    input: u.input + p.input, output: u.output + p.output, cacheRead: u.cacheRead + p.cacheRead, cacheWrite: u.cacheWrite + p.cacheWrite,
    ...(lastDay ? { lastDay } : {}), practice: p,
  };
}

/**
 * Why Practice waits: the agent is paused by a budget this month, its own or
 * the machine's, or one of them is reached and the pause is on its way
 * (pauseDue) ("" when not). Said as the budget reached, which is true of both
 * (HB-1248).
 */
export function practicePausedLine(store: Store, agentId: string, now = Date.now(), tz = machineTz()): string {
  const month = monthKey(now, tz);
  const p = store.getBudgetPause(agentId, month);
  const open = p && !p.resumedAt && p.kind === 'pause' ? p : undefined;
  const agent = open ? undefined : store.getAgent(agentId);
  const scope = open ? open.scope : agent ? pauseDue(store, agent, month) : undefined;
  if (!scope) return '';
  return `${scope === MACHINE ? 'This Hatchabot has' : 'This agent has'} reached its budget for ${monthName(month)}, and Practice spends from the same budget. It can practise again once the budget is raised or the pause ends on ${monthName(nextMonth(month))} 1.`;
}
