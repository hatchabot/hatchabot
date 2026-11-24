import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store, type TokenIncidentRow } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { HOUR_FIELDS, type HourField, type TokenHealthRaw, type WindowModelStats } from '../src/orchestrator/usage/usage.js';
import type { StoredProfile } from '../src/orchestrator/usage/modelScorecard.js';
import type { PendingConfirm } from '../src/mgmt/pendingStore.js';
import { buildRecommendations, CHEAPER_MIN_USD, GROUP, isCostCard, NO_BUDGET_FROM_USD } from '../src/orchestrator/usage/recommendations.js';
import { runBudgets, type BudgetDeps } from '../src/orchestrator/usage/budgets.js';
import { runUsageAlerts } from '../src/orchestrator/usage/usageAlerts.js';
import { loopCovering } from '../src/orchestrator/usage/tokenWatch.js';
import { buildTokenHealth } from '../src/orchestrator/usage/tokenHealth.js';
import { recordChange } from '../src/orchestrator/usage/modelLedger.js';
import { REST_BY_NAME } from '../src/mgmt/restTools.js';
import { COVERAGE } from '../src/mgmt/coverage.js';
import { publicClassFor } from '../src/api/publicRoutes.js';
import { OPS_AGENTS_MD, OPS_MODEL_REVIEW_MESSAGE } from '../src/ops/opsAgent.js';

/** Recommended (docs/recommendations-design.md). Every name, figure and id is made up. */

const HOUR = 3_600_000, DAY = 86_400_000, MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const OWNER = 'owner-rec', OTHER = 'other-rec';
const as = (who = OWNER) => ({ 'x-hatchabot-owner': who });
/** Mid-morning on the 10th: the month is not half gone. */
const NOW = Date.parse('2026-10-10T12:00:00Z');

function stats(p: Partial<WindowModelStats> = {}, hours?: Record<number, Partial<Record<HourField, number>>>): WindowModelStats {
  const h: Record<string, number[]> = {};
  for (const [ms, c] of Object.entries(hours ?? {})) h[iso(Number(ms)).slice(0, 13)] = HOUR_FIELDS.map((f) => c[f] ?? 0);
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, toolUseCalls: 0, turns: 0, toolTurns: 0, toolCalls: 0, failedTurns: 0, failed7d: 0,
    first: 0, last: 0, ctxP50: 0, ctxP90: 0, ...(hours ? { h } : {}), ...p } as unknown as WindowModelStats;
}
const profile = (now: number, models: Record<string, WindowModelStats>, hourly = false): StoredProfile =>
  ({ since: now - 30 * DAY, models, promptErrors: 0, crons: 0, firstCall: now - 30 * DAY, ...(hourly ? { hourly: true } : {}) } as StoredProfile);
/** 30 days on Opus 4.8: 10M in, 1M out = $75 a month; on Haiku 4.5 the same mix is $15. */
const steady = (now: number, turns = 200) => profile(now, { 'claude-opus-4-8': stats({ input: 10e6, output: 1e6, calls: 400, turns, toolTurns: 20, toolCalls: 30, first: now - 30 * DAY, last: now - HOUR }) });
function health(p: Partial<TokenHealthRaw> = {}, now = NOW): TokenHealthRaw {
  return {
    v: 1, since: now - 30 * DAY, conv: { calls: 0, p50: 0, p90: 0, max: 0, over100k: 0 }, main: {}, top: [],
    cache: { first5: [0, 0, 0], firstCold: [0, 0, 0], inside: [0, 0, 0] }, split: { chat: {}, followup: {}, scheduled: {} }, jobTokens: {},
    thinking: { calls: 0, of: 0 }, cfg: null, files: {}, compactions: { n: 0, last: 0, before: 0 }, jobs: null, ingress: null, big: [], guard: [], streaks: [], ...p,
  };
}
const incident = (agentId: string, p: Partial<TokenIncidentRow> = {}, now = NOW): TokenIncidentRow => ({
  id: `ti_${agentId}_task-failing_job-1_${now}`, agentId, ownerId: OWNER, kind: 'task-failing', key: 'job-1', openedAt: iso(now - 3 * HOUR), updatedAt: iso(now),
  count: 9, firstAt: iso(now - 4 * HOUR), lastAt: iso(now - 10 * MIN), text: 'Scheduled task "Prices" failed 9 runs in a row (last 11:50)', fix: 'Turn it off until it is fixed.', ...p,
});

function world() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'Family key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', models: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'], secretRef: 'ai/key', createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'k2', ownerId: OTHER, name: 'Theirs', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/k2', createdAt: 'now' } as never);
  const agent = (id: string, name: string, extra: Record<string, unknown> = {}, owner = OWNER) => store.insertAgent({
    id, ownerId: owner, name, slug: id, state: 'RUNNING', aiProfileId: owner === OWNER ? 'key' : 'k2', hostId: 'h1', runtimeRef: `mock://${id}`,
    persona: '', sharedMemory: true, webOnly: true, createdAt: '2026-08-01T00:00:00Z', updatedAt: 'now', ...extra,
  } as never);
  const list = (opts: { now?: number; machineOwner?: boolean; includeDismissed?: boolean } = {}) => buildRecommendations(store, OWNER, { now: NOW, tz: 'UTC', ...opts });
  return { store, agent, list };
}

/** A loop on an agent that burns $1 of Opus input an hour for the last 4 hours. */
function loopAgent(w: ReturnType<typeof world>, id = 'recipe', name = 'Recipe Box') {
  w.agent(id, name);
  const hours: Record<number, Partial<Record<HourField, number>>> = {};
  for (let k = 1; k <= 4; k++) hours[NOW - k * HOUR] = { input: 200_000, calls: 10, turns: 1 };
  w.store.setModelProfile(id, profile(NOW, { 'claude-opus-4-8': stats({ input: 800_000, calls: 40, turns: 4 }, hours) }, true), iso(NOW));
  w.store.openTokenIncident(incident(id));
}

describe('the list: each check becomes an item, ranked', () => {
  it('a loop: per-day burn from its recent cost, the fix as a button, an Alerts line', () => {
    const w = world();
    loopAgent(w);
    const [it] = w.list().items;
    expect(it).toMatchObject({ kind: 'loop', title: 'Recipe Box is stuck in a loop', alert: true, agents: [{ id: 'recipe', name: 'Recipe Box' }] });
    // $4 over the 4 hours since it began → $24 a day.
    expect(it!.effect).toMatchObject({ usdPerDay: 24, usdPerMonth: 720, billing: 'api' });
    expect(it!.effect!.text).toBe('stops ≈ $24 a day');
    expect(it!.evidence).toContain('≈ $4.00 in the last 4 hours at API prices');
    expect(it!.action).toMatchObject({ kind: 'pause-task', method: 'PATCH', path: '/v1/agents/recipe/crons/job-1', body: { enabled: false } });
    expect(it!.id).toBe(`loop:${incident('recipe').id}`);
  });

  it('a cheaper model: only with evidence "ok", its saving priced on its own mix, through the model route', () => {
    const w = world();
    w.agent('stock', 'Stock Watcher');
    w.store.setModelProfile('stock', steady(NOW), iso(NOW));
    const it = w.list().items.find((x) => x.kind === 'cheaper-model')!;
    expect(it.title).toBe('Stock Watcher could use a cheaper model');
    // $75 a month on Opus 4.8; $15 on Haiku 4.5: $60 less.
    expect(it.effect).toMatchObject({ usdPerMonth: 60, billing: 'api', text: '≈ $60 a month' });
    expect(it.evidence[0]).toBe('Evidence: ok — 200 turns on claude-opus-4-8 over 30 days');
    expect(it.action).toMatchObject({ kind: 'set-model', method: 'POST', path: '/v1/agents/stock/model', body: { model: 'claude-haiku-4-5' } });
    expect(it.rank).toEqual({ group: GROUP['cheaper-model'], money: 60 });
  });

  it('thin evidence (fewer than 10 turns on its model) gives no cheaper-model item', () => {
    const w = world();
    w.agent('stock', 'Stock Watcher');
    w.store.setModelProfile('stock', steady(NOW, 6), iso(NOW));
    expect(w.list().items.filter((x) => x.kind === 'cheaper-model')).toEqual([]);
    // …and a small saving gives none either.
    expect(CHEAPER_MIN_USD).toBe(5);
  });

  it('the Hatchabot agent itself is never offered a cheaper model', () => {
    const w = world();
    w.agent('ops', 'Hatchabot', { ops: true });
    w.store.setModelProfile('ops', steady(NOW), iso(NOW));
    expect(w.list().items.filter((x) => x.kind === 'cheaper-model')).toEqual([]);
  });

  it('a big conversation: saving per call × calls, at the cache-read price', () => {
    const w = world();
    w.agent('budget', 'Budget Tracker');
    w.store.setTokenHealth('budget', health({ conv: { calls: 300, p50: 200_000, p90: 260_000, max: 300_000, over100k: 300 }, main: { budget: { ctx: 180_000, at: NOW - HOUR } } }), iso(NOW));
    const it = w.list().items.find((x) => x.kind === 'big-conversation')!;
    // 200K median → the 150K cap compacts at 130K: 70K a call × 300 calls a month × $0.50 per million (Opus 4.8 cache read).
    expect(it.effect).toMatchObject({ usdPerMonth: 10.5, tokensPerMonth: 21_000_000 });
    expect(it.effect!.text).toBe('≈ 35% fewer tokens per call: ≈ $11 a month');
    expect(it.action).toMatchObject({ kind: 'context-cap', method: 'PUT', path: '/v1/agents/budget/context-cap', body: { tokens: 150_000 } });
    // Over 250K now: compact first, with the cap as the second button.
    w.store.setTokenHealth('budget', health({ conv: { calls: 300, p50: 200_000, p90: 260_000, max: 320_000, over100k: 300 }, main: { budget: { ctx: 310_000, at: NOW - HOUR } } }), iso(NOW));
    const now = w.list().items.find((x) => x.kind === 'big-conversation')!;
    expect(now.title).toBe("Budget Tracker's conversation is 310K tokens");
    expect(now.action).toMatchObject({ kind: 'compact', path: '/v1/agents/budget/compact', body: { mode: 'summarise' } });
    expect(now.secondary.map((a) => a.kind)).toEqual(['context-cap']);
  });

  it('a big conversation during a switch of source is judged by the source it still runs, as the cap route is (HB-1170)', () => {
    const w = world();
    w.store.insertAIProfile({ id: 'box', ownerId: OWNER, name: 'Ollama', vendor: 'local', kind: 'api_key', model: 'qwen3', secretRef: 'ai/box', createdAt: 'now' } as never);
    const big = () => health({ conv: { calls: 300, p50: 200_000, p90: 260_000, max: 300_000, over100k: 300 } });
    // Running the local model, saved onto the key: no cap to offer until the rebuild (the route refuses one).
    w.agent('toCloud', 'Garden Planner');
    w.store.setAgentApplied('toCloud', 'box', 'qwen3');
    w.store.setTokenHealth('toCloud', big(), iso(NOW));
    // Running the key's model, saved onto the local source: its cap still saves money until the rebuild.
    w.agent('toLocal', 'Budget Tracker', { aiProfileId: 'box' });
    w.store.setAgentApplied('toLocal', 'key', 'claude-opus-4-8');
    w.store.setTokenHealth('toLocal', big(), iso(NOW));
    const items = w.list().items.filter((x) => x.kind === 'big-conversation');
    expect(items.map((x) => x.agents[0]!.id)).toEqual(['toLocal']);
    expect(items[0]!.action).toMatchObject({ kind: 'context-cap', path: '/v1/agents/toLocal/context-cap' });
    expect(items[0]!.effect).toMatchObject({ usdPerMonth: 10.5, billing: 'api' });
    // Context now's Cap cell reads the row's billing: a menu for the one running the key, none for the one running local.
    const rows = new Map(buildTokenHealth(w.store, OWNER, { now: NOW }).rows.map((r) => [r.id, r]));
    expect(rows.get('toLocal')).toMatchObject({ billing: 'api', model: 'claude-opus-4-8' });
    expect(rows.get('toCloud')).toMatchObject({ billing: 'local', model: 'qwen3' });
  });

  it('a compaction running or done since the size was measured: the advice catches up (2026-10-10)', async () => {
    const { compactingNow } = await import('../src/orchestrator/memory/compactionState.js');
    const w = world();
    w.agent('budget', 'Budget Tracker');
    w.store.setTokenHealth('budget', health({ conv: { calls: 300, p50: 200_000, p90: 260_000, max: 320_000, over100k: 300 }, main: { budget: { ctx: 310_000, at: NOW - HOUR } } }), iso(NOW));
    const owner = w.store.getAgent('budget')!.ownerId;
    const compaction = (id: string, at: number, outcome: string, detail: Record<string, unknown>) =>
      w.store.addTokenAction({ id, agentId: 'budget', ownerId: owner, kind: 'compaction', at: iso(at), by: 'owner', via: 'recommendation', detail: { mode: 'summarise', session: 'main', beforeK: 310, ...detail }, outcome });
    const card = () => w.list().items.find((x) => x.kind === 'big-conversation');

    // Running in this process: the card says so, with no second Compact button.
    compaction('ta_run', NOW - 2 * 60_000, 'running', {});
    compactingNow.add('budget');
    try {
      expect(card()!.title).toBe("Budget Tracker's conversation is being compacted");
      expect(card()!.action).toMatchObject({ kind: 'open-agent' });
      expect(card()!.concern).toContain('the result goes to your chat');
    } finally { compactingNow.delete('budget'); }
    // A "running" row this process is not running (a restart cut it off): the advice stands.
    expect(card()!.action).toMatchObject({ kind: 'compact' });

    // Done after the measured call: the size it left (14K) stands, so no Compact
    // button; the cap advice (from the 30-day median) remains.
    compaction('ta_ok', NOW - 60_000, 'ok', { afterK: 14 });
    expect(card()!.action).toMatchObject({ kind: 'context-cap' });
    expect(card()!.secondary).toEqual([]);
    // "Already compacted" (recorded as failed before this fix): done too.
    compaction('ta_already', NOW - 30_000, 'failed', { reason: 'Already compacted' });
    expect(card()!.action).toMatchObject({ kind: 'context-cap' });
    // A compaction older than the measured call is no news: the advice stands.
    w.store.setTokenHealth('budget', health({ conv: { calls: 300, p50: 200_000, p90: 260_000, max: 320_000, over100k: 300 }, main: { budget: { ctx: 300_000, at: NOW } } }), iso(NOW));
    expect(card()!.action).toMatchObject({ kind: 'compact' });
  });

  it('an agent over ~$20 a month with no budget is offered the suggested one', () => {
    const w = world();
    w.agent('stock', 'Stock Watcher');
    w.store.setModelProfile('stock', steady(NOW), iso(NOW));
    const it = w.list().items.find((x) => x.kind === 'no-budget')!;
    expect(it.title).toBe('Stock Watcher costs about $75 a month and has no budget');
    expect(it.action).toMatchObject({ kind: 'set-budget', method: 'PUT', path: '/v1/agents/stock/budget', body: { usd: 100, atLimit: 'warn' } });
    expect(NO_BUDGET_FROM_USD).toBe(20);
    w.store.setBudget('stock', OWNER, 100, 'warn', iso(NOW));
    expect(w.list().items.some((x) => x.kind === 'no-budget')).toBe(false);
  });

  it('a budget at 100% and one past 80% before mid-month; the machine\'s for its owner', () => {
    const w = world();
    w.agent('a1', 'Garden Notes');
    w.agent('a2', 'Trip Planner');
    w.store.setBudget('a1', OWNER, 50, 'pause', iso(NOW));
    w.store.setBudget('a2', OWNER, 50, 'warn', iso(NOW));
    w.store.setCostDays('a1', new Map([['2026-10-05', 55]]));
    w.store.setCostDays('a2', new Map([['2026-10-05', 42]]));
    const items = w.list().items;
    const lim = items.find((x) => x.id === 'budget:a1')!;
    expect(lim).toMatchObject({ kind: 'budget-limit', alert: true, title: 'Garden Notes passed its $50 budget' });
    expect(lim.action).toMatchObject({ kind: 'set-budget', path: '/v1/agents/a1/budget', body: { atLimit: 'pause' } });
    const pace = items.find((x) => x.id === 'budget-pace:a2')!;
    expect(pace.kind).toBe('budget-pace');
    expect(pace.alert).toBeUndefined();
    expect(items.indexOf(lim)).toBeLessThan(items.indexOf(pace));
    // Past mid-month an 80% budget is no longer news.
    expect(buildRecommendations(w.store, OWNER, { now: Date.parse('2026-10-20T12:00:00Z'), tz: 'UTC' }).items.some((x) => x.kind === 'budget-pace')).toBe(false);
    w.store.setBudget('machine', OWNER, 80, 'warn', iso(NOW));
    expect(w.list({ machineOwner: true }).items.find((x) => x.id === 'budget:machine')).toMatchObject({ machine: true, kind: 'budget-limit' });
    expect(w.list().items.some((x) => x.id === 'budget:machine')).toBe(false);
  });

  it('a rate-limited source is ONE item for the source, naming its agents — not one per agent', () => {
    const w = world();
    w.agent('a1', 'Garden Notes');
    w.agent('a2', 'Trip Planner');
    w.store.addLimitHit('a1', 'key', iso(NOW - 5 * MIN), 'claude-opus-4-8');
    w.store.addLimitHit('a2', 'key', iso(NOW - 4 * MIN), 'claude-opus-4-8');
    const limits = w.list().items.filter((x) => x.kind === 'rate-limit');
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({ id: 'limit:key', title: 'Family key is rate-limited' });
    expect(limits[0]!.agents.map((a) => a.name).sort()).toEqual(['Garden Notes', 'Trip Planner']);
  });

  it('ranked: loop, budget at 100%, spike, rate limit, budget pace, switch back, then savings by money', () => {
    const w = world();
    loopAgent(w);
    w.agent('a1', 'Garden Notes'); w.agent('a2', 'Trip Planner'); w.agent('a3', 'Piano Practice'); w.agent('stock', 'Stock Watcher');
    w.store.setBudget('a1', OWNER, 10, 'warn', iso(NOW)); w.store.setCostDays('a1', new Map([['2026-10-05', 12]]));
    w.store.setBudget('a2', OWNER, 10, 'warn', iso(NOW)); w.store.setCostDays('a2', new Map([['2026-10-05', 9]]));
    w.store.addUsageAlert({ agentId: 'a3', ownerId: OWNER, at: iso(NOW - HOUR), tokens: 90e6, usual: 20e6, told: true });
    w.store.addLimitHit('a1', 'key', iso(NOW - 5 * MIN), 'claude-opus-4-8');
    w.store.setModelProfile('stock', steady(NOW), iso(NOW));
    const kinds = w.list().items.map((x) => x.kind);
    expect(kinds.slice(0, 5)).toEqual(['loop', 'budget-limit', 'spike', 'rate-limit', 'budget-pace']);
    // Savings: the $60 cheaper model before the budget suggestion ($0 at stake).
    expect(kinds.slice(5)).toEqual(['cheaper-model', 'no-budget']);
  });
});

describe('one cause, one item', () => {
  it('a loop absorbs its agent\'s spike, budget and step lines ("…which is also why it passed …")', () => {
    const w = world();
    loopAgent(w);
    w.store.addUsageAlert({ agentId: 'recipe', ownerId: OWNER, at: iso(NOW - 30 * MIN), tokens: 120e6, usual: 20e6, told: false });
    w.store.setBudget('recipe', OWNER, 50, 'warn', iso(NOW));
    w.store.setCostDays('recipe', new Map([['2026-10-09', 60]]));
    w.store.setSpendAlert('recipe', OWNER, 25, iso(NOW));
    const items = w.list().items;
    expect(items.map((x) => x.kind)).toEqual(['loop']);
    const [loop] = items;
    expect(loop!.absorbs?.sort()).toEqual(['budget:recipe', 'spike:recipe']);
    expect(loop!.concern).toMatch(/— which is also why it passed its budget and passed \$50 this month$/);
    expect(loop!.evidence.some((e) => e.startsWith('Recipe Box used 120M tokens in 24 hours'))).toBe(true);
    expect(loop!.evidence.some((e) => e.startsWith('Over its $50 budget for October'))).toBe(true);
  });

  it('a loop stuck compacting stands for its conversation item', () => {
    const w = world();
    w.agent('stock', 'Stock Watcher');
    w.store.setTokenHealth('stock', health({ conv: { calls: 300, p50: 200_000, p90: 260_000, max: 460_000, over100k: 300 }, main: { stock: { ctx: 446_000, at: NOW - HOUR } } }), iso(NOW));
    w.store.openTokenIncident(incident('stock', { id: 'ti_stock_retry', kind: 'channel-retry', key: 'telegram:123', text: 'Stuck: Telegram message retried 12 times since 08:19 — compacting a 446K conversation takes longer than the 5-minute limit' }));
    const items = w.list().items;
    expect(items.map((x) => x.kind)).toEqual(['loop']);
    expect(items[0]!.action).toMatchObject({ kind: 'compact', body: { mode: 'lines', lines: 200 } });
    expect(items[0]!.absorbs).toEqual(['conversation:stock']);
  });

  it('a compaction card is merged only when it runs the same compaction: a summary is not the loop\'s line trim (HB-1055)', () => {
    const w = world();
    w.agent('stock', 'Stock Watcher');
    w.store.setTokenHealth('stock', health({ conv: { calls: 300, p50: 200_000, p90: 260_000, max: 460_000, over100k: 300 }, main: { stock: { ctx: 446_000, at: NOW - HOUR } } }), iso(NOW));
    w.store.openTokenIncident(incident('stock', { id: 'ti_stock_retry', kind: 'channel-retry', key: 'telegram:123', text: 'Stuck: Telegram message retried 12 times since 08:19 — compacting a 446K conversation takes longer than the 5-minute limit' }));
    w.agent('budget', 'Budget Tracker');
    w.store.setTokenHealth('budget', health({ conv: { calls: 300, p50: 200_000, p90: 260_000, max: 320_000, over100k: 300 }, main: { budget: { ctx: 310_000, at: NOW - HOUR } } }), iso(NOW));
    const card = (id: string, agentId: string, agentName: string, body: Record<string, unknown>, at = NOW - HOUR) => w.store.putMgmtProposal({
      id, ownerId: OWNER, chatId: 0, fromUserId: 0, messageId: 0, tool: 'compact_agent',
      resolved: { agentId, agentName, rest: { call: { method: 'POST', path: `/v1/agents/${agentId}/compact`, body }, card: '🗜 …' } },
      summary: `🗜 Compact "${agentName}"'s conversation`, createdAtMs: at, expiresAtMs: NOW + DAY, status: 'pending', source: 'agent',
    } as PendingConfirm);
    card('c_sum', 'stock', 'Stock Watcher', { mode: 'summarise' });
    card('c_wide', 'stock', 'Stock Watcher', { mode: 'lines', lines: 1000 });
    card('c_trim_b', 'budget', 'Budget Tracker', { mode: 'lines', lines: 200 });
    let items = w.list().items;
    // The loop keeps its own trim; the summary and the wider trim are cards of their own.
    const loop = items.find((x) => x.kind === 'loop')!;
    expect(loop.proposalId).toBeUndefined();
    expect(loop.action).toMatchObject({ kind: 'compact', path: '/v1/agents/stock/compact', body: { mode: 'lines', lines: 200 } });
    expect(items.find((x) => x.id === 'card:c_sum')).toMatchObject({ kind: 'proposal', action: { kind: 'confirm-card', label: 'Compact it now' } });
    expect(items.find((x) => x.id === 'card:c_wide')).toMatchObject({ kind: 'proposal', action: { label: 'Compact it (keep the last 1000 lines)' } });
    // A conversation item's summary is not a trim either.
    const conv = items.find((x) => x.id === 'conversation:budget')!;
    expect(conv.proposalId).toBeUndefined();
    expect(conv.action).toMatchObject({ kind: 'compact', body: { mode: 'summarise' } });
    expect(items.find((x) => x.id === 'card:c_trim_b')).toMatchObject({ kind: 'proposal' });
    // The same compaction, proposed: one item, its click. No line count is the default 200; no mode is a summary.
    card('c_trim', 'stock', 'Stock Watcher', { mode: 'lines' }, NOW - 2 * HOUR);
    card('c_sum_b', 'budget', 'Budget Tracker', {}, NOW - 2 * HOUR);
    items = w.list().items;
    expect(items.find((x) => x.kind === 'loop')).toMatchObject({ proposalId: 'c_trim', action: { kind: 'confirm-card', path: '/v1/proposals/c_trim/confirm' } });
    expect(items.find((x) => x.id === 'conversation:budget')).toMatchObject({ proposalId: 'c_sum_b', action: { kind: 'confirm-card' } });
    expect(items.some((x) => x.id === 'card:c_trim' || x.id === 'card:c_sum_b')).toBe(false);
    expect(items.some((x) => x.id === 'card:c_sum')).toBe(true);
  });

  it('the Hatchabot agent\'s card for the same change merges into the item, marked as its proposal; others stand alone; non-cost cards are not items', () => {
    const w = world();
    w.agent('stock', 'Stock Watcher');
    w.store.setModelProfile('stock', steady(NOW), iso(NOW));
    const card = (id: string, tool: string, resolved: Record<string, unknown>, extra: Partial<PendingConfirm> = {}) => w.store.putMgmtProposal({
      id, ownerId: OWNER, chatId: 0, fromUserId: 0, messageId: 0, tool, resolved: { agentId: 'stock', agentName: 'Stock Watcher', ...resolved }, summary: `${tool} card\nsecond line`,
      createdAtMs: NOW - HOUR, expiresAtMs: NOW + DAY, status: 'pending', source: 'agent', ...extra,
    } as PendingConfirm);
    card('c_model', 'set_model', { model: 'claude-haiku-4-5' }, { note: 'short answers only' });
    card('c_step', 'set_spend_alert', { rest: { call: { method: 'PUT', path: '/v1/agents/stock/spend-alert', body: { every: 20 } }, card: '🔔 …' } });
    card('c_snap', 'snapshot_agent', { rest: { call: { method: 'POST', path: '/v1/agents/stock/snapshots', body: {} }, card: '📸 …' } });
    const items = w.list().items;
    const cheaper = items.filter((x) => x.kind === 'cheaper-model');
    expect(cheaper).toHaveLength(1);
    expect(cheaper[0]).toMatchObject({ proposedBy: 'agent', proposalId: 'c_model', action: { kind: 'confirm-card', path: '/v1/proposals/c_model/confirm', label: 'Switch to claude-haiku-4-5' } });
    expect(cheaper[0]!.evidence).toContain('Its reason: “short answers only”');
    expect(items.find((x) => x.id === 'card:c_step')).toMatchObject({ kind: 'proposal', proposedBy: 'agent', action: { label: 'Tell me every $20' } });
    expect(items.some((x) => x.id === 'card:c_snap')).toBe(false);
    expect(isCostCard({ tool: 'set_cron_enabled', resolved: { agentId: 'x', agentName: 'x', rest: { call: { method: 'PATCH', path: '/x', body: { enabled: true } }, card: '' } } })).toBe(false);
  });

  it('a card is merged only when it does what the item says: removing a budget is not "Raise it" (#181)', () => {
    const w = world();
    w.agent('a1', 'Garden Notes');
    w.store.setBudget('a1', OWNER, 50, 'pause', iso(NOW));
    w.store.setCostDays('a1', new Map([['2026-10-05', 55]]));
    w.store.setTokenHealth('a1', health({ conv: { calls: 300, p50: 200_000, p90: 260_000, max: 300_000, over100k: 300 }, main: { a1: { ctx: 180_000, at: NOW - HOUR } } }), iso(NOW));
    const raise = w.list().items.find((x) => x.id === 'budget:a1')!.action!;
    expect(w.list().items.find((x) => x.id === 'conversation:a1')!.action).toMatchObject({ kind: 'context-cap', body: { tokens: 150_000 } });
    const card = (id: string, tool: string, path: string, body: Record<string, unknown>) => w.store.putMgmtProposal({
      id, ownerId: OWNER, chatId: 0, fromUserId: 0, messageId: 0, tool, resolved: { agentId: 'a1', agentName: 'Garden Notes', rest: { call: { method: 'PUT', path, body }, card: '💵 …' } },
      summary: `💵 ${tool} card`, createdAtMs: NOW - HOUR, expiresAtMs: NOW + DAY, status: 'pending', source: 'agent',
    } as PendingConfirm);
    card('c_remove', 'set_budget', '/v1/agents/a1/budget', { usd: null });
    card('c_cap', 'set_context_cap', '/v1/agents/a1/context-cap', { tokens: null });
    let items = w.list().items;
    const lim = items.find((x) => x.id === 'budget:a1')!;
    expect(lim.action).toEqual(raise);
    expect(lim.proposalId).toBeUndefined();
    expect(items.find((x) => x.id === 'card:c_remove')).toMatchObject({ kind: 'proposal', action: { label: 'Remove its budget' } });
    expect(items.find((x) => x.id === 'card:c_cap')).toMatchObject({ kind: 'proposal', action: { label: 'Remove its cap' } });
    expect(items.find((x) => x.id === 'conversation:a1')!.action).toMatchObject({ kind: 'context-cap', body: { tokens: 150_000 } });
    // The same raise, proposed by the Hatchabot agent: one item, its click.
    card('c_raise', 'set_budget', '/v1/agents/a1/budget', { ...raise.body });
    items = w.list().items;
    expect(items.find((x) => x.id === 'budget:a1')).toMatchObject({ proposalId: 'c_raise', action: { kind: 'confirm-card' } });
    expect(items.some((x) => x.id === 'card:c_raise')).toBe(false);
  });

  it('the quality guard\'s switch-back card is the switch-back item', () => {
    const w = world();
    w.agent('piano', 'Piano Practice', { model: 'claude-haiku-4-5' });
    const change = recordChange(w.store, { agentId: 'piano', from: 'claude-sonnet-5', to: 'claude-haiku-4-5', by: 'owner', via: 'app', source: 'model' }, NOW - 8 * DAY)!;
    w.store.setModelChangeOutcome(change.id, 'worse', undefined, ['failed turns 0% → 13.3% of turns (4 on claude-haiku-4-5)'], iso(NOW - DAY));
    w.store.putMgmtProposal({ id: 'g1', ownerId: OWNER, chatId: 0, fromUserId: 0, messageId: 0, tool: 'set_model', resolved: { agentId: 'piano', agentName: 'Piano Practice', model: 'claude-sonnet-5', guardOf: change.id },
      summary: '↩ Switch "Piano Practice" back to claude-sonnet-5\n…\nBefore (claude-sonnet-5, 30 days): 120 turns\nAfter (claude-haiku-4-5, 7 days): 30 turns', createdAtMs: NOW - DAY, expiresAtMs: NOW + DAY, status: 'pending', source: 'guard' } as PendingConfirm);
    const it = w.list().items.find((x) => x.kind === 'switch-back')!;
    expect(it).toMatchObject({ id: `switch-back:${change.id}`, proposedBy: 'guard', title: 'Piano Practice does worse on claude-haiku-4-5', action: { kind: 'confirm-card', path: '/v1/proposals/g1/confirm', label: 'Switch back to claude-sonnet-5' } });
    expect(it.evidence).toEqual(['Before (claude-sonnet-5, 30 days): 120 turns', 'After (claude-haiku-4-5, 7 days): 30 turns']);
  });
});

describe('Not now', () => {
  it('puts an item away until its cause changes', () => {
    const w = world();
    loopAgent(w);
    const [it] = w.list().items;
    w.store.dismissRecommendation(OWNER, it!.id, it!.fingerprint, iso(NOW));
    expect(w.list().items).toEqual([]);
    expect(w.list().dismissed).toBe(1);
    expect(w.list({ includeDismissed: true }).items).toHaveLength(1);
    // A budget suggestion comes back when the suggested figure moves.
    w.agent('stock', 'Stock Watcher');
    w.store.setModelProfile('stock', steady(NOW), iso(NOW));
    const nb = w.list().items.find((x) => x.kind === 'no-budget')!;
    w.store.dismissRecommendation(OWNER, nb.id, nb.fingerprint, iso(NOW));
    expect(w.list().items.some((x) => x.kind === 'no-budget')).toBe(false);
    w.store.setModelProfile('stock', profile(NOW, { 'claude-opus-4-8': stats({ input: 40e6, output: 1e6, calls: 400, turns: 200, first: NOW - 30 * DAY, last: NOW - HOUR }) }), iso(NOW));
    expect(w.list().items.some((x) => x.kind === 'no-budget')).toBe(true);
  });
});

describe('one cause, one message a day', () => {
  it('a spike on an agent whose loop was told today is recorded, not sent; without a loop it is sent', async () => {
    const w = world();
    w.agent('recipe', 'Recipe Box', { createdAt: '2026-01-01T00:00:00Z' });
    w.agent('stock', 'Stock Watcher', { createdAt: '2026-01-01T00:00:00Z' });
    const now = Date.now();
    const i = incident('recipe', {}, now);
    w.store.openTokenIncident(i);
    w.store.markTokenIncidentTold(i.id, iso(now - HOUR));
    expect(loopCovering(w.store, 'recipe', now)?.id).toBe(i.id);
    expect(loopCovering(w.store, 'stock', now)).toBeUndefined();
    // Told two days ago and still open: a new day, so it no longer speaks for today's spike.
    w.store.markTokenIncidentTold(i.id, iso(now - 2 * DAY));
    expect(loopCovering(w.store, 'recipe', now)).toBeUndefined();
    w.store.markTokenIncidentTold(i.id, iso(now - HOUR));
    // The spike check itself: findUsageSpikes is fed through a store stub of its readings.
    const told: string[] = [];
    const fake = Object.create(w.store) as Store;
    fake.firstTokenSample = () => iso(now - 30 * DAY);
    fake.tokenDeltas = (ids: Set<string>) => [...ids].flatMap((id) => [
      ...Array.from({ length: 7 }, (_, k) => ({ agentId: id, at: iso(now - (k + 1.5) * DAY), delta: 1e6 })),
      { agentId: id, at: iso(now - HOUR), delta: 100e6 },
    ]) as never;
    await runUsageAlerts({ store: fake, tell: async (_o, a) => { told.push(a.name); return true; } }, now);
    expect(told).toEqual(['Stock Watcher']);
    const rows = w.store.usageAlertsSince(iso(now - DAY), { ownerId: OWNER });
    expect(rows.find((r) => r.agentId === 'recipe')).toMatchObject({ told: false, covered: i.id });
    expect(rows.find((r) => r.agentId === 'stock')).toMatchObject({ told: true });
    expect(rows.find((r) => r.agentId === 'stock')!.covered).toBeUndefined();
  });
});

describe('enforcement is untouched', () => {
  it('building the list changes nothing: a pause budget still pauses, steps still tell', async () => {
    const w = world();
    w.agent('trip', 'Trip Planner');
    w.store.setBudget('trip', OWNER, 20, 'pause', iso(NOW));
    w.store.setModelProfile('trip', profile(NOW, { 'claude-opus-4-8': stats({}, { [NOW - 2 * DAY]: { input: 25 * 200_000 } }) }, true), iso(NOW));
    const deps: BudgetDeps = {
      store: w.store, tz: 'UTC', tell: async () => true, isBusy: () => false,
      pause: async (a) => { w.store.setAgentState(a.id, 'STOPPED'); return true; }, resume: async () => true,
    };
    await runBudgets(deps, NOW);
    expect(w.store.getAgent('trip')!.state).toBe('STOPPED');
    const before = JSON.stringify([w.store.listBudgetPauses({ open: true }), w.store.listBudgets()]);
    const it = w.list().items.find((x) => x.id === 'budget:trip')!;
    expect(it.title).toBe('Trip Planner is paused by its budget');
    w.store.dismissRecommendation(OWNER, it.id, it.fingerprint, iso(NOW));
    w.list();
    expect(JSON.stringify([w.store.listBudgetPauses({ open: true }), w.store.listBudgets()])).toBe(before);
    expect(w.store.getAgent('trip')!.state).toBe('STOPPED');
  });
});

// ---------------------------------------------------------------------------
// The routes and the actions
// ---------------------------------------------------------------------------

const CRON_JSON = JSON.stringify({ jobs: [{ id: 'job-1', name: 'Prices', enabled: true, agentId: 'recipe', schedule: { kind: 'cron', expr: '0 9 * * *' }, payload: { kind: 'agentTurn', message: 'Check the prices' } }] });

async function app() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  provider.execResponses.set('cron list', { code: 0, stdout: CRON_JSON, stderr: '' });
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'Family key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', models: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'], secretRef: 'ai/key', createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'k2', ownerId: OTHER, name: 'Theirs', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/k2', createdAt: 'now' } as never);
  const add = async (id: string, name: string, owner = OWNER, extra: Record<string, unknown> = {}) => {
    const { runtimeRef } = await provider.provision({ agentId: id, slug: id, workspace: { files: {}, configPatch: { agentId: id, authMode: 'api-key' } }, env: {} } as never);
    await provider.start(runtimeRef);
    store.insertAgent({ id, ownerId: owner, name, slug: id, state: 'RUNNING', runtimeRef, aiProfileId: owner === OWNER ? 'key' : 'k2', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: '2026-08-01T00:00:00Z', updatedAt: 'now', ...extra } as never);
  };
  await add('stock', 'Stock Watcher');
  await add('recipe', 'Recipe Box');
  await add('theirs', 'Theirs', OTHER);
  const f = Fastify();
  await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } } as never } as never);
  return { f, store, provider };
}
const events = (store: Store, id: string) => store.listEvents([id], 50).filter((e) => e.event === 'recommendation.acted');

describe('the routes', () => {
  it('GET the owner\'s list and an agent\'s; another owner\'s agent is not theirs', async () => {
    const { f, store } = await app();
    const now = Date.now();
    store.setModelProfile('stock', steady(now), iso(now));
    store.setModelProfile('theirs', steady(now), iso(now));
    const r = await f.inject({ method: 'GET', url: '/v1/recommendations', headers: as() });
    expect(r.statusCode).toBe(200);
    const ids = r.json().items.map((x: { id: string }) => x.id);
    expect(ids).toContain('cheaper:stock');
    expect(ids.some((id: string) => id.includes('theirs'))).toBe(false);
    const one = await f.inject({ method: 'GET', url: '/v1/agents/stock/recommendations', headers: as() });
    expect(one.json().items.every((x: { agents: Array<{ id: string }> }) => x.agents.some((a) => a.id === 'stock'))).toBe(true);
    expect((await f.inject({ method: 'GET', url: '/v1/agents/theirs/recommendations', headers: as() })).statusCode).toBe(404);
  });

  it('a cost card on an agent archived since stays in the home screen\'s cards list, as Recommended no longer has it (HB-1095)', async () => {
    const { f, store } = await app();
    const now = Date.now();
    store.putMgmtProposal({
      id: 'c_model', ownerId: OWNER, chatId: 0, fromUserId: 0, messageId: 0, tool: 'set_model', resolved: { agentId: 'stock', agentName: 'Stock Watcher', model: 'claude-haiku-4-5' },
      summary: 'Switch Stock Watcher to claude-haiku-4-5', createdAtMs: now - HOUR, expiresAtMs: now + DAY, status: 'pending', source: 'agent',
    } as PendingConfirm);
    const card = async () => (await f.inject({ method: 'GET', url: '/v1/proposals', headers: as() })).json().pending.find((p: { confirmId: string }) => p.confirmId === 'c_model');
    expect(await card()).toMatchObject({ recommended: true });
    expect((await f.inject({ method: 'GET', url: '/v1/recommendations', headers: as() })).json().items.some((x: { proposalId?: string }) => x.proposalId === 'c_model')).toBe(true);
    store.setAgentState('stock', 'ARCHIVED');
    expect((await f.inject({ method: 'GET', url: '/v1/recommendations', headers: as() })).json().items.some((x: { proposalId?: string }) => x.proposalId === 'c_model')).toBe(false);
    expect(await card()).toMatchObject({ recommended: false });
  });

  it('a card filed for an item the owner put off with Not now stays in the cards list, as Recommended does not show it (HB-1269)', async () => {
    const { f, store } = await app();
    const now = Date.now();
    store.setModelProfile('stock', steady(now), iso(now));
    const list = async () => (await f.inject({ method: 'GET', url: '/v1/recommendations', headers: as() })).json();
    const card = async (id: string) => (await f.inject({ method: 'GET', url: '/v1/proposals', headers: as() })).json().pending.find((p: { confirmId: string }) => p.confirmId === id);
    // Not now on the cheaper model, before any card for it.
    const item = (await list()).items.find((x: { id: string }) => x.id === 'cheaper:stock');
    expect(item.action.body.model).toBe('claude-haiku-4-5');
    expect((await f.inject({ method: 'POST', url: '/v1/recommendations/cheaper:stock/dismiss', headers: as(), payload: {} })).statusCode).toBe(200);
    // Later the Hatchabot agent files the same switch: it would merge into the item put off.
    const put = (id: string, model: string) => store.putMgmtProposal({
      id, ownerId: OWNER, chatId: 0, fromUserId: 0, messageId: 0, tool: 'set_model', resolved: { agentId: 'stock', agentName: 'Stock Watcher', model },
      summary: `Switch Stock Watcher to ${model}`, createdAtMs: now, expiresAtMs: now + DAY, status: 'pending', source: 'agent',
    } as PendingConfirm);
    put('c_put_off', 'claude-haiku-4-5');
    expect((await list()).items.some((x: { proposalId?: string }) => x.proposalId === 'c_put_off')).toBe(false);
    expect(await card('c_put_off')).toMatchObject({ recommended: false });
    // A card Recommended does show (its own item) is still left out of the cards list.
    put('c_other', 'claude-sonnet-5');
    expect((await list()).items.some((x: { proposalId?: string }) => x.proposalId === 'c_other')).toBe(true);
    expect(await card('c_other')).toMatchObject({ recommended: true });
  });

  it('the cards list never fails or writes for Recommended: a build that throws shows every card, and the poll prunes nothing (HB-1269 review)', async () => {
    const { f, store } = await app();
    const now = Date.now();
    const put = (id: string, tool: string, resolved: Record<string, unknown>) => store.putMgmtProposal({
      id, ownerId: OWNER, chatId: 0, fromUserId: 0, messageId: 0, tool, resolved,
      summary: `card ${id}`, createdAtMs: now, expiresAtMs: now + DAY, status: 'pending', source: 'agent',
    } as unknown as PendingConfirm);
    const cards = async () => {
      const r = await f.inject({ method: 'GET', url: '/v1/proposals', headers: as() });
      return { status: r.statusCode, body: r.body, pending: r.statusCode === 200 ? r.json().pending.map((p: { confirmId: string; recommended: boolean }) => [p.confirmId, p.recommended]) : [] };
    };
    put('c_backup', 'run_backup', { rest: { call: { method: 'POST', path: '/v1/backups/run', body: {} }, card: 'Back up' } });
    put('c_model', 'set_model', { agentId: 'stock', agentName: 'Stock Watcher', model: 'claude-haiku-4-5' });
    expect((await cards()).pending).toEqual([['c_backup', false], ['c_model', true]]);
    // The home screen polls this every few seconds: it reads Recommended, never tidies it.
    const prune = vi.spyOn(store, 'pruneRecommendationDismissals');
    try {
      await cards();
      expect(prune).not.toHaveBeenCalled();
    } finally { prune.mockRestore(); }
    // A read inside the build that fails: every card is shown (none hidden), and the reason is not sent.
    const broken = vi.spyOn(store, 'listTokenIncidents').mockImplementation(() => { throw new Error('a read that fails inside'); });
    try {
      const out = await cards();
      expect(out.status).toBe(200);
      expect(out.pending).toEqual([['c_backup', false], ['c_model', false]]);
      expect(out.body).not.toContain('a read that fails inside');
    } finally { broken.mockRestore(); }
  });

  it('a Recommended build that keeps failing is logged once a minute, and again at once for another reason, not at every poll (HB-1269 review)', async () => {
    const { f, store } = await app();
    const now = Date.now();
    store.putMgmtProposal({
      id: 'c_model', ownerId: OWNER, chatId: 0, fromUserId: 0, messageId: 0, tool: 'set_model', resolved: { agentId: 'stock', agentName: 'Stock Watcher', model: 'claude-haiku-4-5' },
      summary: 'Switch Stock Watcher to claude-haiku-4-5', createdAtMs: now, expiresAtMs: now + DAY, status: 'pending', source: 'agent',
    } as PendingConfirm);
    let ahead = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now + ahead);
    let why = 'a read that fails inside';
    const broken = vi.spyOn(store, 'listTokenIncidents').mockImplementation(() => { throw new Error(why); });
    const warn = vi.spyOn(f.log, 'warn');
    const logged = () => warn.mock.calls.filter((c) => c[1] === 'proposals.recommended_failed').map((c) => (c[0] as { err: string }).err);
    const poll = async () => expect((await f.inject({ method: 'GET', url: '/v1/proposals', headers: as() })).statusCode).toBe(200);
    try {
      for (let i = 0; i < 5; i++) { ahead = i * 4_000; await poll(); } // the home screen's polls, 4 s apart
      expect(logged()).toEqual(['a read that fails inside']);
      why = 'another fault'; ahead = 20_000; await poll(); await poll();
      expect(logged()).toEqual(['a read that fails inside', 'another fault']);
      ahead = 20_000 + 61_000; await poll();
      expect(logged()).toEqual(['a read that fails inside', 'another fault', 'another fault']);
    } finally { warn.mockRestore(); broken.mockRestore(); clock.mockRestore(); }
  });

  it('each action goes through the card\'s own route, the ledger says via "recommendation", and the timeline has a line', async () => {
    const { f, store } = await app();
    const now = Date.now();
    store.setModelProfile('stock', steady(now), iso(now));
    const items = (await f.inject({ method: 'GET', url: '/v1/recommendations', headers: as() })).json().items as Array<{ id: string; kind: string; action: { method: string; path: string; body: unknown } }>;
    const act = async (kind: string) => {
      const it = items.find((x) => x.kind === kind)!;
      const r = await f.inject({ method: it.action.method as 'POST', url: it.action.path, headers: { ...as(), 'x-hatchabot-recommendation': it.id }, payload: it.action.body as object });
      expect(r.statusCode, r.body).toBe(200);
      return it;
    };
    // The cheaper model: the model route, in the ledger as the recommendation's (the guard judges it a week on).
    await act('cheaper-model');
    expect(store.getAgent('stock')!.model).toBe('claude-haiku-4-5');
    const [change] = store.listModelChanges({ agentId: 'stock', limit: 5 });
    expect(change).toMatchObject({ to: 'claude-haiku-4-5', by: 'owner', via: 'recommendation', outcome: 'pending' });
    expect(change!.why).toMatch(/^Recommended: claude-opus-4-8 → claude-haiku-4-5/);
    // The suggested budget: the budget route, recorded with the token actions.
    await act('no-budget');
    expect(store.getBudget('stock')).toMatchObject({ usd: 100, atLimit: 'warn' });
    expect(store.listTokenActions({ agentId: 'stock', limit: 5 }).find((t) => t.kind === 'budget')).toMatchObject({ by: 'owner', via: 'recommendation' });
    expect(events(store, 'stock').map((e) => (e.detail as { route: string }).route).sort()).toEqual(['POST /v1/agents/:id/model', 'PUT /v1/agents/:id/budget']);
    // A plain request (no item) is not a recommendation's.
    await f.inject({ method: 'PUT', url: '/v1/agents/stock/budget', headers: as(), payload: { usd: 120 } });
    expect(events(store, 'stock')).toHaveLength(2);
  });

  it('an action whose page hung up before the answer is still on the timeline (HB-1405 review)', async () => {
    const { f, store } = await app();
    // The budget route is slow to answer (a loaded machine); the server sees its caller go meanwhile.
    let reached!: () => void, release!: () => void, serverSaw!: Promise<void>;
    const entered = new Promise<void>((r) => { reached = r; });
    const held = new Promise<void>((r) => { release = r; });
    f.addHook('preHandler', async (req) => {
      if (req.routeOptions.url !== '/v1/agents/:id/budget') return;
      serverSaw = new Promise<void>((r) => { req.raw.socket.once('close', () => r()); });
      reached(); await held;
    });
    try {
      await f.listen({ port: 0, host: '127.0.0.1' });
      const { port } = f.server.address() as AddressInfo;
      const body = JSON.stringify({ usd: 100, atLimit: 'warn' });
      const call = httpRequest({ host: '127.0.0.1', port, method: 'PUT', path: '/v1/agents/stock/budget',
        headers: { ...as(), 'x-hatchabot-recommendation': 'no-budget:stock', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
      const hungUp = new Promise<void>((r) => { call.on('error', () => r()); call.on('close', () => r()); });
      call.end(body);
      await entered;
      call.destroy();
      await hungUp;
      await serverSaw;
      release();
      // Its answer goes to nobody, but the budget was set: the line is there.
      await vi.waitFor(() => expect(store.getBudget('stock')).toMatchObject({ usd: 100 }), { timeout: 2000, interval: 20 });
      await vi.waitFor(() => expect(events(store, 'stock').map((e) => (e.detail as { route: string }).route)).toEqual(['PUT /v1/agents/:id/budget']), { timeout: 2000, interval: 20 });
    } finally { await f.close(); }
  });

  it('a context cap and a paused task, through their routes', async () => {
    const { f, store, provider } = await app();
    const now = Date.now();
    store.setTokenHealth('stock', health({ conv: { calls: 300, p50: 200_000, p90: 260_000, max: 300_000, over100k: 300 }, main: { stock: { ctx: 180_000, at: now - HOUR } } }, now), iso(now));
    store.openTokenIncident(incident('recipe', {}, now));
    const items = (await f.inject({ method: 'GET', url: '/v1/recommendations', headers: as() })).json().items as Array<{ id: string; kind: string; action: { method: string; path: string; body: unknown } }>;
    for (const kind of ['big-conversation', 'loop']) {
      const it = items.find((x) => x.kind === kind)!;
      const r = await f.inject({ method: it.action.method as 'PUT', url: it.action.path, headers: { ...as(), 'x-hatchabot-recommendation': it.id }, payload: it.action.body as object });
      expect(r.statusCode, r.body).toBe(200);
    }
    expect(store.getContextCap('stock')?.tokens).toBe(150_000);
    expect(store.listTokenActions({ agentId: 'stock', limit: 5 }).find((t) => t.kind === 'context-cap')).toMatchObject({ via: 'recommendation' });
    expect(provider.execLog).toContainEqual(['cron', 'disable', 'job-1']);
    expect(events(store, 'recipe')).toHaveLength(1);
  });

  it('a card item\'s click confirms the card: the ledger says the card\'s, the timeline the recommendation\'s', async () => {
    const { f, store } = await app();
    const now = Date.now();
    store.setAgentModel('stock', 'claude-haiku-4-5');
    const change = recordChange(store, { agentId: 'stock', from: 'claude-opus-4-8', to: 'claude-haiku-4-5', by: 'owner', via: 'app', source: 'model' }, now - 8 * DAY)!;
    store.setModelChangeOutcome(change.id, 'worse', undefined, ['failed turns up'], iso(now - DAY));
    store.putMgmtProposal({ id: 'g1', ownerId: OWNER, chatId: 0, fromUserId: 0, messageId: 0, tool: 'set_model', resolved: { agentId: 'stock', agentName: 'Stock Watcher', model: 'claude-opus-4-8', guardOf: change.id },
      summary: '↩ Switch "Stock Watcher" back to claude-opus-4-8', createdAtMs: now, expiresAtMs: now + DAY, status: 'pending', source: 'guard', risk: 'disruptive' } as PendingConfirm);
    const it = (await f.inject({ method: 'GET', url: '/v1/recommendations', headers: as() })).json().items.find((x: { kind: string }) => x.kind === 'switch-back');
    expect(it.action.path).toBe('/v1/proposals/g1/confirm');
    const r = await f.inject({ method: 'POST', url: it.action.path, headers: { ...as(), 'x-hatchabot-recommendation': it.id }, payload: {} });
    expect(r.statusCode, r.body).toBe(200);
    expect(store.getAgent('stock')!.model).toBe('claude-opus-4-8');
    expect(store.listModelChanges({ agentId: 'stock', limit: 1 })[0]).toMatchObject({ via: 'guard' });
    expect(events(store, 'stock')).toHaveLength(1);
  });

  it('Not now: gone from the list until the cause changes; a spike\'s warning is cleared with it', async () => {
    const { f, store } = await app();
    const now = Date.now();
    store.addUsageAlert({ agentId: 'stock', ownerId: OWNER, at: iso(now - HOUR), tokens: 90e6, usual: 20e6, told: true });
    const get = async () => (await f.inject({ method: 'GET', url: '/v1/recommendations', headers: as() })).json().items.map((x: { id: string }) => x.id);
    expect(await get()).toContain('spike:stock');
    const r = await f.inject({ method: 'POST', url: `/v1/recommendations/${encodeURIComponent('spike:stock')}/dismiss`, headers: as(), payload: {} });
    expect(r.statusCode).toBe(200);
    expect(await get()).not.toContain('spike:stock');
    expect(store.usageAlertsSince(iso(now - DAY), { ownerId: OWNER })).toEqual([]);
    // Another owner cannot put mine away, and a gone item is a 404.
    expect((await f.inject({ method: 'POST', url: `/v1/recommendations/${encodeURIComponent('spike:stock')}/dismiss`, headers: as(OTHER), payload: {} })).statusCode).toBe(404);
    // A new spike is a new cause.
    store.addUsageAlert({ agentId: 'stock', ownerId: OWNER, at: iso(now - MIN), tokens: 95e6, usual: 20e6, told: true });
    expect(await get()).toContain('spike:stock');
  });

  it('classified, in the coverage ledger, a manager tool, and the weekly review reads the list', () => {
    expect(publicClassFor('GET', '/v1/recommendations')).toBe('signed-in');
    expect(publicClassFor('GET', '/v1/agents/:id/recommendations')).toBe('signed-in');
    expect(publicClassFor('POST', '/v1/recommendations/:id/dismiss')).toBe('signed-in');
    // The actions keep their own class: confirming a card stays a step-up at the public address.
    expect(publicClassFor('POST', '/v1/proposals/:id/:verb')).toBe('step-up');
    expect(COVERAGE['POST /v1/recommendations/:id/dismiss']).toMatch(/^app: browser/);
    expect(REST_BY_NAME.get('list_recommendations')).toMatchObject({ tier: 'read' });
    expect(OPS_MODEL_REVIEW_MESSAGE).toMatch(/Start from list_recommendations/);
    expect(OPS_MODEL_REVIEW_MESSAGE).toMatch(/the list does not already offer/);
    expect(OPS_AGENTS_MD).toContain('RECOMMENDED FIRST. list_recommendations');
  });
});
