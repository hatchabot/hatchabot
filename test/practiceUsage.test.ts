import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import type { Agent } from '../src/domain/types.js';
import { dayKey, machineTz, monthKey, monthSpend, monthUnpriced, recordCostDays } from '../src/orchestrator/usage/budgets.js';
import { findUsageSpikes } from '../src/orchestrator/usage/usageAlerts.js';
import { summarizeSourceUsage } from '../src/orchestrator/usage/sourceUsage.js';
import { practicePausedLine, practiceSummary, recordPracticeUsage } from '../src/orchestrator/usage/practiceUsage.js';
import { priceMix } from '../src/orchestrator/sources/modelOptions.js';
import { fakeUsage } from './helpers/usageFake.js';
import { costsFor, spendSeries, windowPricing } from '../src/orchestrator/usage/agentCosts.js';
import { computeUsagePeriod } from '../src/orchestrator/usage/fleetUsage.js';
import { buildRecommendations } from '../src/orchestrator/usage/recommendations.js';
import { buildScorecard } from '../src/orchestrator/usage/modelScorecard.js';

/**
 * Skill practice counts as the agent's own calls (HB-0933). A practice run's
 * transcript goes with its temporary folder, so what it spent is written to
 * practice_usage before Practice answers; these hold every rollup the agent's
 * own calls are in to counting it: its budget, its spike warnings, the usage
 * periods, its source's (a Claude plan's) tokens, and its Usage page.
 */

const OWNER = 'user-owner';
const DAY = 86_400_000;
const tz = machineTz();
const iso = (ms: number) => new Date(ms).toISOString();
const MIX = { model: 'claude-opus-4-8', calls: 3, input: 2_000, output: 600, cacheRead: 40_000, cacheWrite: 5_000 };
const tokensOf = (m: typeof MIX) => m.input + m.output + m.cacheRead + m.cacheWrite;

function world(kind: 'api_key' | 'subscription' = 'api_key') {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind, model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Other', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p2', createdAt: 'now' });
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Garden Notes', slug: 'garden-notes', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'mock://a1',
    persona: '', sharedMemory: false, createdAt: iso(Date.now() - 30 * DAY), updatedAt: 'now' } as unknown as Agent);
  return { store, agent: store.getAgent('a1')! };
}

describe('a practice run is recorded as the agent spending it (HB-0933)', () => {
  it('counts toward its budget at API prices, a model with no price apart', () => {
    const { store, agent } = world();
    const now = Date.now();
    expect(monthSpend(store, monthKey(now, tz), ['a1']).get('a1') ?? 0).toBe(0);
    recordPracticeUsage(store, agent, 'hatchabot-writing', 'completed', [MIX, { model: 'other-vendor/unknown-model', calls: 1, input: 700, output: 300, cacheRead: 0, cacheWrite: 0 }], now);
    const usd = priceMix(MIX.model, MIX)!;
    expect(usd).toBeGreaterThan(0);
    expect(monthSpend(store, monthKey(now, tz), ['a1']).get('a1')).toBeCloseTo(usd, 9);
    expect(monthSpend(store, monthKey(now, tz)).get('a1')).toBeCloseTo(usd, 9);
    expect(monthUnpriced(store, monthKey(now, tz), ['a1']).get('a1')).toBe(1_000);
    // Added to the day's cost the sampler wrote, not in its place.
    store.setCostDays('a1', new Map([[dayKey(now, tz), 1.5]]));
    expect(monthSpend(store, monthKey(now, tz), ['a1']).get('a1')).toBeCloseTo(1.5 + usd, 9);
  });

  it('is in the usage periods and the spike warnings, at the time it ran, on its source', () => {
    const { store, agent } = world();
    const now = Date.now();
    // A week of readings with nothing used, so the agent is measured and quiet.
    for (let d = 8; d >= 0; d--) store.addTokenSample('a1', 'p1', iso(now - d * DAY - 60_000), 1_000);
    const spent = { ...MIX, input: 3_000_000 };
    recordPracticeUsage(store, agent, 'hatchabot-writing', 'timeout', [spent], now - 3_600_000);
    const deltas = store.tokenDeltas(new Set(['a1']), iso(now - 2 * DAY));
    expect(deltas).toContainEqual({ agentId: 'a1', at: iso(now - 3_600_000), prevAt: iso(now - 3_600_000), delta: tokensOf(spent), profileId: 'p1' });
    const spikes = findUsageSpikes(store, [store.getAgent('a1')!], { ratio: 3, minTokens: 1_000_000, newAgentTokens: 1_000_000 }, now);
    expect(spikes.map((s) => [s.agent.id, s.tokens])).toEqual([['a1', tokensOf(spent)]]);
  });

  it('is in the cost badges, the "At API prices" chart and its window, and the periods\' request counts (HB-1246)', () => {
    const { store, agent } = world();
    const now = Date.now();
    recordPracticeUsage(store, agent, 'hatchabot-writing', 'completed', [MIX], now - 3_600_000);
    const usd = priceMix(MIX.model, MIX)!;
    // The badge: a week, and an hour that does not reach back to it.
    expect(costsFor(store, OWNER, 7, now).a1!.cost).toBeCloseTo(Math.round(usd * 100) / 100, 9);
    expect(costsFor(store, OWNER, 7, now).a1!.tier).toBeGreaterThan(0);
    expect(costsFor(store, OWNER, 1 / 24, now - 2 * 3_600_000).a1!.tier).toBe(0);
    // Usage's "At API prices": the window and the chart.
    const w = windowPricing(store, OWNER, 24, now);
    expect(w.agents.a1!.cost).toBeCloseTo(Math.round(usd * 100) / 100, 9);
    expect(w.billing.api).toBeCloseTo(Math.round(usd * 100) / 100, 9);
    const chart = spendSeries(store, OWNER, 'day', { now });
    expect(chart.totals.tokens).toBe(tokensOf(MIX));
    expect(chart.totals.cost).toBeCloseTo(Math.round(usd * 100) / 100, 9);
    expect(chart.buckets.reduce((x, b) => x + b.tokens, 0)).toBe(tokensOf(MIX));
    // The usage periods: its calls are requests, as its tokens already were.
    const day = computeUsagePeriod(store, OWNER, 'day', now);
    expect(day.agents.find((a) => a.id === 'a1')).toMatchObject({ tokens: tokensOf(MIX), requests: MIX.calls });
    expect(day.buckets.reduce((x, b) => x + b.requests, 0)).toBe(MIX.calls);
    expect(computeUsagePeriod(store, OWNER, 'week', now).totals.requests).toBe(MIX.calls);
  });

  it("the calls its source refused are kept, and counted as refused requests, never as the source's refusal of a turn (HB-1497)", () => {
    const { store, agent } = world();
    const now = Date.now();
    // One model with calls and two refusals, one whose every call was refused (no tokens at all).
    const refusedOnly = { model: 'claude-haiku-4-5', calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, refused: 3 };
    expect(recordPracticeUsage(store, agent, 'hatchabot-writing', 'timeout', [{ ...MIX, refused: 2 }, refusedOnly], now - 600_000)).toBe(tokensOf(MIX));
    // Was: the refusals in no row, and a model with no tokens left out.
    expect(store.practiceUsageFor(['a1']).map((r) => [r.model, r.calls, r.refused, r.usd > 0])).toEqual([['claude-haiku-4-5', 0, 3, false], ['claude-opus-4-8', 3, 2, true]]);
    // The usage periods: requests, refused ones.
    const day = computeUsagePeriod(store, OWNER, 'day', now);
    expect(day.agents.find((a) => a.id === 'a1')).toMatchObject({ requests: MIX.calls + 5, limited: 5 });
    expect(day.buckets.reduce((x, b) => x + b.limited, 0)).toBe(5);
    // Its source's counts: requests and refused; not rate-limited by them, which only its own refusals say.
    const src = summarizeSourceUsage(store, OWNER, now).find((s) => s.id === 'p1')!;
    expect(src.window1h).toMatchObject({ requests: MIX.calls + 5, limited: 5 });
    expect(src.window7d).toMatchObject({ requests: MIX.calls + 5, limited: 5 });
    expect([src.status, src.lastLimitAt, src.limitHits7d]).toEqual(['idle', undefined, 0]);
    // The scorecard: apart from its own turns' rate limits.
    const card = buildScorecard(store, OWNER, { now }).rows.find((r) => r.id === 'a1')!;
    expect(card.errors).toEqual({ practiceRefused: 5 });
    expect(card.calls).toBe(MIX.calls);
  });

  it("the usage periods say how much of the window was practice, counted in their figures (HB-1275)", () => {
    const { store, agent } = world();
    const now = Date.now();
    expect(computeUsagePeriod(store, OWNER, 'day', now).practice).toBeUndefined();
    // Two runs in the day, one of them on two models; one three days back, in the week only.
    recordPracticeUsage(store, agent, 'hatchabot-writing', 'completed', [MIX, { ...MIX, model: 'claude-haiku-4-5', calls: 1 }], now - 3_600_000);
    recordPracticeUsage(store, agent, 'hatchabot-writing', 'completed', [MIX], now - 7_200_000);
    recordPracticeUsage(store, agent, 'hatchabot-writing', 'completed', [MIX], now - 3 * DAY);
    const day = computeUsagePeriod(store, OWNER, 'day', now);
    expect(day.practice).toEqual({ runs: 2, calls: 2 * MIX.calls + 1, tokens: 3 * tokensOf(MIX), agents: 1 });
    // In the figures, not besides them.
    expect(day.totals.requests).toBe(day.practice!.calls);
    expect(day.totals.tokens).toBe(day.practice!.tokens);
    expect(computeUsagePeriod(store, OWNER, 'week', now).practice).toEqual({ runs: 3, calls: 3 * MIX.calls + 1, tokens: 4 * tokensOf(MIX), agents: 1 });
    expect(computeUsagePeriod(store, OWNER, 'hour', now + 2 * 3_600_000).practice).toBeUndefined();
  });

  it("a run whose every call its source refused is a run in the usage periods, as on its Usage page (HB-1497 review)", () => {
    const { store, agent } = world();
    const now = Date.now();
    recordPracticeUsage(store, agent, 'hatchabot-writing', 'timeout', [{ model: 'claude-haiku-4-5', calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, refused: 3 }], now - 600_000);
    expect(practiceSummary(store, 'a1', now)).toMatchObject({ runs: 1, calls: 0, tokens: 0 });
    // Was: undefined, the window said to hold no practice though its requests counted three.
    expect(computeUsagePeriod(store, OWNER, 'day', now).practice).toEqual({ runs: 1, calls: 0, tokens: 0, agents: 1 });
  });

  it("is in Recommended's money: a spike's last 24 hours and a loop's cost so far, and their ranks (HB-1246)", () => {
    const now = Date.now();
    const usd = Math.round(priceMix(MIX.model, MIX)! * 100) / 100;
    expect(usd).toBeGreaterThanOrEqual(0.01);
    // A spike warned half an hour ago; the practice that made it ran an hour ago.
    const s = world();
    recordPracticeUsage(s.store, s.agent, 'hatchabot-writing', 'completed', [MIX], now - 3_600_000);
    s.store.addUsageAlert({ agentId: 'a1', ownerId: OWNER, at: iso(now - 1_800_000), tokens: 90e6, usual: 20e6, told: true });
    const spike = buildRecommendations(s.store, OWNER, { now }).items.find((x) => x.kind === 'spike')!;
    expect(spike.rank.money).toBeCloseTo(usd, 9);
    expect(spike.evidence.some((e) => /^≈ \$.* in the last 24 hours at API prices/.test(e))).toBe(true);
    // A loop going two hours, the practice inside them.
    const l = world();
    recordPracticeUsage(l.store, l.agent, 'hatchabot-writing', 'completed', [MIX], now - 3_600_000);
    l.store.openTokenIncident({ id: 'loop1', agentId: 'a1', ownerId: OWNER, kind: 'tool-loop', key: 'k', openedAt: iso(now - 2 * 3_600_000), updatedAt: iso(now),
      count: 9, firstAt: iso(now - 2 * 3_600_000), lastAt: iso(now), text: 'Stuck' } as never);
    const loop = buildRecommendations(l.store, OWNER, { now }).items.find((x) => x.kind === 'loop')!;
    expect(loop.rank.money).toBeGreaterThan(0);
    expect(loop.evidence.some((e) => /^≈ \$.* in the last 2 hours at API prices/.test(e))).toBe(true);
  });

  it("is its source's tokens: a Claude plan's windows and top agents count it, another source's do not", () => {
    const { store, agent } = world('subscription');
    const now = Date.now();
    store.addTokenSample('a1', 'p1', iso(now - 2 * DAY), 1_000);
    store.addTokenSample('a1', 'p1', iso(now - DAY), 1_000);
    recordPracticeUsage(store, agent, 'hatchabot-writing', 'completed', [MIX], now - 600_000);
    expect(store.tokenIncreasesByAgent('p1', iso(now - 3_600_000), new Set(['a1'])).get('a1')).toBe(tokensOf(MIX));
    expect(store.tokenIncreasesByAgent('p2', iso(now - 3_600_000), new Set(['a1'])).get('a1') ?? 0).toBe(0);
    const plan = summarizeSourceUsage(store, OWNER, now).find((s) => s.id === 'p1')!;
    expect(plan.window1h.tokens).toBe(tokensOf(MIX));
    expect(plan.window5h.tokens).toBe(tokensOf(MIX));
    expect(plan.topAgents).toEqual([expect.objectContaining({ name: 'Garden Notes', tokens: tokensOf(MIX) })]);
  });

  it('the source is the one its container runs: a switch saved but not rebuilt still spends the old one', () => {
    const { store } = world();
    const a = { ...store.getAgent('a1')!, aiProfileId: 'p2', appliedProfileId: 'p1' } as Agent;
    recordPracticeUsage(store, a, 'hatchabot-writing', 'completed', [MIX]);
    expect(store.practiceUsageFor(['a1']).map((r) => r.profileId)).toEqual(['p1']);
  });

  it('writes nothing for a run that spent nothing, and on a local source counts no unknown price', () => {
    const { store, agent } = world();
    expect(recordPracticeUsage(store, agent, 'hatchabot-writing', 'unavailable', undefined)).toBe(0);
    expect(recordPracticeUsage(store, agent, 'hatchabot-writing', 'unavailable', [{ ...MIX, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }])).toBe(0);
    expect(store.practiceUsageFor(['a1'])).toEqual([]);
    store.insertAIProfile({ id: 'p3', ownerId: OWNER, name: 'Local', vendor: 'local', kind: 'api_key', model: 'ollama/fixture', secretRef: 'ai/p3', createdAt: 'now' });
    recordPracticeUsage(store, { ...agent, aiProfileId: 'p3' } as Agent, 'hatchabot-writing', 'completed', [{ ...MIX, model: 'ollama/fixture' }]);
    expect(monthUnpriced(store, monthKey(Date.now(), tz), ['a1']).get('a1') ?? 0).toBe(0);
  });

  it('is kept as long as the cost days are', () => {
    const { store, agent } = world();
    const now = Date.now();
    recordPracticeUsage(store, agent, 'hatchabot-writing', 'completed', [MIX], now - 120 * DAY);
    recordPracticeUsage(store, agent, 'hatchabot-writing', 'completed', [MIX], now);
    recordCostDays(store, tz, now);
    expect(store.practiceUsageFor(['a1']).map((r) => r.at)).toEqual([iso(now)]);
  });

  it('its summary: runs, calls, the four parts, its cost, and the last day apart', () => {
    const { store, agent } = world();
    const now = Date.now();
    recordPracticeUsage(store, agent, 'hatchabot-writing', 'completed', [MIX], now - 2 * DAY);
    recordPracticeUsage(store, agent, 'hatchabot-research', 'timeout', [MIX, { ...MIX, model: 'claude-haiku-4-5', calls: 1 }], now - 60_000);
    const s = practiceSummary(store, 'a1', now)!;
    expect(s).toMatchObject({ runs: 2, calls: 7, tokens: 3 * tokensOf(MIX), input: 6_000, output: 1_800, cacheRead: 120_000, cacheWrite: 15_000, last: iso(now - 60_000),
      lastDay: { calls: 4, tokens: 2 * tokensOf(MIX) } });
    expect(s.usd).toBeCloseTo(2 * priceMix(MIX.model, MIX)! + priceMix('claude-haiku-4-5', MIX)!, 6);
    expect(s.byModel).toEqual([{ model: 'claude-opus-4-8', runs: 2, calls: 6, tokens: 2 * tokensOf(MIX) }, { model: 'claude-haiku-4-5', runs: 1, calls: 1, tokens: tokensOf(MIX) }]);
    expect(practiceSummary(store, 'a2', now)).toBeUndefined();
  });
});

describe('Practice waits while the agent is paused by its budget (HB-0933)', () => {
  it('says so for an open pause of this month, its own or the machine’s, and not for a cheaper model or a resumed one', () => {
    const { store } = world();
    const now = Date.now(), month = monthKey(now, tz);
    expect(practicePausedLine(store, 'a1', now)).toBe('');
    store.addBudgetPause('a1', month, 'machine', iso(now));
    expect(practicePausedLine(store, 'a1', now)).toMatch(/^This Hatchabot has reached its budget for \w+, and Practice spends from the same budget\. It can practise again once the budget is raised or the pause ends on \w+ 1\.$/);
    store.resumeBudgetPause('a1', month, iso(now), 'owner');
    expect(practicePausedLine(store, 'a1', now)).toBe('');
    store.addBudgetPause('a1', month, 'a1', iso(now), { fromModel: 'claude-opus-4-8', toModel: 'claude-haiku-4-5' });
    expect(practicePausedLine(store, 'a1', now)).toBe('');
  });
  it('says so as soon as its own pause budget is reached, before the pause is made; not for warn, below it, or once its owner took over', () => {
    const { store, agent } = world();
    const now = Date.now(), month = monthKey(now, tz);
    const line = /^This agent has reached its budget for \w+, and Practice spends from the same budget\./;
    store.setBudget('a1', OWNER, 1, 'pause', iso(now));
    expect(practicePausedLine(store, 'a1', now)).toBe('');
    // Over it, by practice alone: no pause yet (it waits for a quiet moment).
    recordPracticeUsage(store, agent, 'hatchabot-writing', 'completed', [{ ...MIX, input: 2_000_000 }], now);
    expect(monthSpend(store, month, ['a1']).get('a1')).toBeGreaterThan(1);
    expect(store.getBudgetPause('a1', month)).toBeUndefined();
    expect(practicePausedLine(store, 'a1', now)).toMatch(line);
    store.setBudget('a1', OWNER, 1, 'warn', iso(now));
    expect(practicePausedLine(store, 'a1', now)).toBe('');
    store.setBudget('a1', OWNER, 1000, 'pause', iso(now));
    expect(practicePausedLine(store, 'a1', now)).toBe('');
    // Paused, then started by hand: it runs on until the 1st, and may practise.
    store.setBudget('a1', OWNER, 1, 'pause', iso(now));
    store.addBudgetPause('a1', month, 'a1', iso(now));
    store.resumeBudgetPause('a1', month, iso(now), 'owner');
    expect(practicePausedLine(store, 'a1', now)).toBe('');
  });
  it("says so as soon as the machine's pause budget is reached, before its pause is made; not for the Hatchabot agent, nor once its owner took over (HB-1248)", () => {
    const { store, agent } = world();
    const now = Date.now(), month = monthKey(now, tz);
    store.insertAgent({ id: 'ops1', ownerId: OWNER, name: 'Hatchabot', slug: 'hatchabot', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'mock://ops1',
      persona: '', sharedMemory: false, ops: true, createdAt: iso(now - 30 * DAY), updatedAt: 'now' } as unknown as Agent);
    store.setBudget('machine', OWNER, 1, 'pause', iso(now));
    expect(practicePausedLine(store, 'a1', now)).toBe('');
    // Over it, by another agent's spend: no pause yet (it waits for a quiet moment).
    store.setCostDays('ops1', new Map([[dayKey(now, tz), 2]]));
    expect(store.getBudgetPause('a1', month)).toBeUndefined();
    // Was: '' (only its own budget was looked at), so Practice spent in the wait.
    expect(practicePausedLine(store, 'a1', now)).toMatch(/^This Hatchabot has reached its budget for \w+, and Practice spends from the same budget\./);
    // The machine's budget never pauses the Hatchabot agent.
    expect(practicePausedLine(store, 'ops1', now)).toBe('');
    // Its own reached as well: said as its own.
    store.setBudget('a1', OWNER, 1, 'pause', iso(now));
    recordPracticeUsage(store, agent, 'hatchabot-writing', 'completed', [{ ...MIX, input: 2_000_000 }], now);
    expect(practicePausedLine(store, 'a1', now)).toMatch(/^This agent has reached its budget for /);
    store.setBudget('a1', OWNER, null, 'pause', iso(now));
    store.setBudget('machine', OWNER, 1, 'warn', iso(now));
    expect(practicePausedLine(store, 'a1', now)).toBe('');
    // Paused by it, then started by hand: it runs on until the 1st, and may practise.
    store.setBudget('machine', OWNER, 1, 'pause', iso(now));
    store.addBudgetPause('a1', month, 'machine', iso(now));
    store.resumeBudgetPause('a1', month, iso(now), 'owner');
    expect(practicePausedLine(store, 'a1', now)).toBe('');
  });
});

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

describe('GET /v1/agents/:id/usage shows practice, counted in (HB-0933)', () => {
  async function routeWorld() {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'garden-notes', workspace: { files: {}, configPatch: { agentId: 'garden-notes', authMode: 'api-key' } }, env: {} } as never);
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Garden Notes', slug: 'garden-notes', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as never);
    const f = Fastify();
    await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never });
    return { store, provider, f };
  }

  it('adds its practice to the totals, the four parts and the last day, and says how much was practice', async () => {
    const { store, provider, f } = await routeWorld();
    provider.usage.set('*', fakeUsage([{ model: 'claude-opus-4-8', input: 1000, output: 200, session: 's1', at: Date.now() - 60_000 }]));
    const before = (await f.inject({ method: 'GET', url: '/v1/agents/a1/usage', headers: { 'x-hatchabot-owner': OWNER } })).json();
    expect(before.practice).toBeUndefined();
    recordPracticeUsage(store, store.getAgent('a1')!, 'hatchabot-writing', 'completed', [MIX]);
    const res = await f.inject({ method: 'GET', url: '/v1/agents/a1/usage', headers: { 'x-hatchabot-owner': OWNER } });
    expect(res.statusCode).toBe(200);
    const u = res.json();
    expect(u.totalTokens).toBe(before.totalTokens + tokensOf(MIX));
    expect(u.calls).toBe(before.calls + MIX.calls);
    expect([u.input, u.output, u.cacheRead, u.cacheWrite]).toEqual([before.input + MIX.input, before.output + MIX.output, before.cacheRead + MIX.cacheRead, before.cacheWrite + MIX.cacheWrite]);
    expect(u.lastDay.tokens).toBe((before.lastDay?.tokens ?? 0) + tokensOf(MIX));
    expect(u.sessions).toBe(before.sessions);
    expect(u.practice).toMatchObject({ runs: 1, calls: 3, tokens: tokensOf(MIX), byModel: [{ model: 'claude-opus-4-8', runs: 1, calls: 3, tokens: tokensOf(MIX) }] });
  });

  it('the fleet\'s reading (GET /v1/usage) counts it too, priced, and says how much was practice (HB-1246)', async () => {
    const { store, provider, f } = await routeWorld();
    provider.usage.set('*', fakeUsage([{ model: 'claude-opus-4-8', input: 1000, output: 200, session: 's1', at: Date.now() - 60_000 }]));
    const before = (await f.inject({ method: 'GET', url: '/v1/usage', headers: { 'x-hatchabot-owner': OWNER } })).json();
    recordPracticeUsage(store, store.getAgent('a1')!, 'hatchabot-writing', 'completed', [MIX]);
    const after = (await f.inject({ method: 'GET', url: '/v1/usage', headers: { 'x-hatchabot-owner': OWNER } })).json();
    expect(after.totalTokens).toBe(before.totalTokens + tokensOf(MIX));
    expect(after.byBilling.api).toBe(before.byBilling.api + tokensOf(MIX));
    expect(after.agents[0].practice).toMatchObject({ runs: 1, calls: 3, tokens: tokensOf(MIX) });
    expect(after.cost.low).toBeCloseTo(before.cost.low + priceMix(MIX.model, MIX)!, 9);
  });

  it("the day's point in the usage history keeps the counters' total, as the sampler writes it, when the fleet's reading includes practice (HB-1271)", async () => {
    const { store, provider, f } = await routeWorld();
    provider.usage.set('*', fakeUsage([{ model: 'claude-opus-4-8', input: 1000, output: 200, session: 's1', at: Date.now() - 60_000 }]));
    const before = (await f.inject({ method: 'GET', url: '/v1/usage', headers: { 'x-hatchabot-owner': OWNER } })).json();
    const was = (await f.inject({ method: 'GET', url: '/v1/usage/history', headers: { 'x-hatchabot-owner': OWNER } })).json().points.at(-1);
    expect(was.totalTokens).toBe(before.totalTokens);
    recordPracticeUsage(store, store.getAgent('a1')!, 'hatchabot-writing', 'completed', [MIX]);
    const after = (await f.inject({ method: 'GET', url: '/v1/usage', headers: { 'x-hatchabot-owner': OWNER } })).json();
    expect(after.totalTokens).toBe(before.totalTokens + tokensOf(MIX));
    const point = (await f.inject({ method: 'GET', url: '/v1/usage/history', headers: { 'x-hatchabot-owner': OWNER } })).json().points.at(-1);
    // Was: the counters plus lifetime practice, kept over the sampler's smaller total for the rest of the day.
    expect(point.totalTokens).toBe(before.totalTokens);
    expect(point.byBilling).toEqual({ included: 0, api: before.totalTokens, local: 0 });
  });
});
