import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { HOUR_FIELDS, type HourField, type WindowModelStats } from '../src/orchestrator/usage.js';
import type { StoredProfile } from '../src/orchestrator/modelScorecard.js';
import { agentCost, COST_BANDS, COST_PERIODS, costsFor, priceParts, SPEND_RANGES, spendSeries, tierOf, TtlCache, windowPricing } from '../src/orchestrator/agentCosts.js';
import { priceMix } from '../src/orchestrator/modelOptions.js';
import { publicClassFor } from '../src/api/publicRoutes.js';

/** The home screen's cost badges: GET /v1/costs and what it is figured from (made-up agents and numbers). */

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-04T12:30:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const OWNER = 'owner-costs', MEMBER = 'member-costs', GUEST = 'guest-costs', STRANGER = 'stranger-costs';
const as = (who: string) => ({ 'x-hatchabot-owner': who });

type Split = Partial<Record<HourField, number>>;
/** A model's stats from hour buckets: { [ms]: counts }. */
function model(byHour: Record<number, Split>): WindowModelStats {
  const h: Record<string, number[]> = {};
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  for (const [ms, c] of Object.entries(byHour)) {
    h[iso(Number(ms)).slice(0, 13)] = HOUR_FIELDS.map((f) => c[f] ?? 0);
    for (const k of Object.keys(sum) as Array<keyof typeof sum>) sum[k] += c[k] ?? 0;
  }
  return {
    ...sum, toolUseCalls: 0, turns: 0, toolTurns: 0, toolCalls: 0, failedTurns: 0, failed7d: 0, first: 0, last: 0, ctxP50: 0, ctxP90: 0,
    err: { malformedToolCall: 0, providerError: 0, rateLimited: 0, aborted: 0, truncated: 0, toolFailed: 0, retried: 0 }, h,
  };
}
const profile = (models: Record<string, WindowModelStats>, opts: { hourly?: boolean; firstCall?: number } = {}): StoredProfile =>
  ({ since: NOW - 30 * DAY, models, promptErrors: 0, crons: 0, firstCall: opts.firstCall ?? NOW - 60 * DAY, ...(opts.hourly === false ? {} : { hourly: true }) });
const stored = (p: StoredProfile, at = NOW - 5 * 60_000) => ({ profile: p, at: iso(at) });
const API = { kind: 'api_key', vendor: 'anthropic' };
const AGENT = { createdAt: '2026-08-01T00:00:00Z' };

describe('bands (by the cost of a week, in absolute dollars)', () => {
  it('are $10 / $50 / $100, one list', () => {
    expect(COST_BANDS).toEqual([10, 50, 100]);
  });
  it('no use is tier 0, whatever the figure', () => {
    expect(tierOf(0, false)).toBe(0);
    expect(tierOf(0, true)).toBe(1); // used, on a local model: under $10
  });
  it('boundaries: under $10, $10–50, $50–100, over $100 — each band takes its lower edge', () => {
    expect(tierOf(9.99, true)).toBe(1);
    expect(tierOf(10, true)).toBe(2);
    expect(tierOf(49.99, true)).toBe(2);
    expect(tierOf(50, true)).toBe(3);
    expect(tierOf(99.99, true)).toBe(3);
    expect(tierOf(100, true)).toBe(4);
    expect(tierOf(12_000, true)).toBe(4);
  });
});

describe('agentCost: the last 7 days at API prices', () => {
  it('prices input, output, cache reads at a tenth and cache writes at 1.25× (Opus 4.8)', () => {
    const p = profile({ 'claude-opus-4-8': model({ [NOW - DAY]: { input: 1e6, output: 1e5, cacheRead: 1e7, cacheWrite: 1e6 } }) });
    // (1M + 1.25 × 1M + 0.1 × 10M) × $5 + 0.1M × $25 = $16.25 + $2.50
    const c = agentCost(AGENT, stored(p), API, 7, NOW);
    expect(c).toMatchObject({ cost: 18.75, weekly: 18.75, tier: 2, priced: true }); // $10–50
    expect(c.monthly).toBeCloseTo(18.75 * 30 / 7, 2);
    expect(c.plan).toBeUndefined();
  });

  it('cache reads at each model\'s own share: Opus 5.5 a twentieth, Fable 5.1 a fortieth', () => {
    const reads = { cacheRead: 1e7 };
    expect(agentCost(AGENT, stored(profile({ 'claude-opus-5-5': model({ [NOW - HOUR]: reads }) })), API, 7, NOW).cost).toBe(2);    // 10M × $4 × 0.05
    expect(agentCost(AGENT, stored(profile({ 'claude-fable-5-1': model({ [NOW - HOUR]: reads }) })), API, 7, NOW).cost).toBe(2.5); // 10M × $10 × 0.025
    expect(agentCost(AGENT, stored(profile({ 'claude-haiku-4-5': model({ [NOW - HOUR]: reads }) })), API, 7, NOW).cost).toBe(1);  // 10M × $1 × 0.1
  });

  it('sums every model it ran on, dated and vendor-prefixed ids included', () => {
    const p = profile({
      'anthropic/claude-sonnet-5-20260101': model({ [NOW - 2 * DAY]: { input: 1e6 } }), // $2
      'claude-haiku-4-5': model({ [NOW - 3 * DAY]: { output: 1e6 } }),                  // $5
    });
    expect(agentCost(AGENT, stored(p), API, 7, NOW).cost).toBe(7);
  });

  it('counts only the window: an hour 8 days back is out, the current hour is in', () => {
    const p = profile({ 'claude-haiku-4-5': model({ [NOW - 8 * DAY]: { input: 50e6 }, [NOW - 7 * DAY + 2 * HOUR]: { input: 1e6 }, [NOW]: { input: 2e6 } }) });
    expect(agentCost(AGENT, stored(p), API, 7, NOW).cost).toBe(3);
  });

  it('scales: weekly is the 7 days, monthly × 30/7; another window scales to a week', () => {
    const p = profile({ 'claude-haiku-4-5': model({ [NOW - DAY]: { input: 7e6 }, [NOW - 10 * DAY]: { input: 7e6 } }) });
    const week = agentCost(AGENT, stored(p), API, 7, NOW);
    expect(week).toMatchObject({ cost: 7, weekly: 7, monthly: 30 });
    const fortnight = agentCost(AGENT, stored(p), API, 14, NOW);
    expect(fortnight).toMatchObject({ cost: 14, weekly: 7, monthly: 30 });
  });

  it('the bands follow the week: $120 a week is the top one, $60 the next', () => {
    expect(agentCost(AGENT, stored(profile({ 'claude-opus-4-8': model({ [NOW - DAY]: { input: 12e6 } }) })), API, 7, NOW)).toMatchObject({ weekly: 60, tier: 3 });
    const p = profile({ 'claude-opus-4-8': model({ [NOW - DAY]: { input: 24e6 } }) }); // $120
    expect(agentCost(AGENT, stored(p), API, 7, NOW)).toMatchObject({ weekly: 120, tier: 4 });
  });

  it('nothing in the window: tier 0; never read: tier 0', () => {
    const p = profile({ 'claude-opus-4-8': model({ [NOW - 9 * DAY]: { input: 24e6 } }) });
    expect(agentCost(AGENT, stored(p), API, 7, NOW)).toMatchObject({ cost: 0, tier: 0, priced: true });
    expect(agentCost(AGENT, undefined, API, 7, NOW)).toMatchObject({ cost: 0, tier: 0 });
  });

  it('a Claude plan is marked: not billed per token, but it counts against the plan', () => {
    const p = profile({ 'claude-sonnet-5': model({ [NOW - DAY]: { input: 10e6 } }) });
    expect(agentCost(AGENT, stored(p), { kind: 'subscription', vendor: 'anthropic' }, 7, NOW)).toMatchObject({ cost: 20, plan: true });
  });

  it('a local model costs nothing, and is never "no price known"', () => {
    const p = profile({ 'qwen3:8b': model({ [NOW - DAY]: { input: 9e6 } }) });
    expect(agentCost(AGENT, stored(p), { kind: 'api_key', vendor: 'local' }, 7, NOW)).toMatchObject({ cost: 0, tier: 1, priced: true, local: true });
    // An ollama/ model on another source is local too.
    const q = profile({ 'ollama/llama3': model({ [NOW - DAY]: { input: 9e6 } }) });
    expect(agentCost(AGENT, stored(q), API, 7, NOW)).toMatchObject({ cost: 0, priced: true });
  });

  it('a model with no price: priced false (no badge); mixed with a priced one, the priced part and partial', () => {
    const alone = profile({ 'gemini-9-pro': model({ [NOW - DAY]: { input: 9e6 } }) });
    expect(agentCost(AGENT, stored(alone), { kind: 'api_key', vendor: 'google' }, 7, NOW)).toMatchObject({ cost: 0, priced: false, tier: 1 });
    const mixed = profile({ 'gemini-9-pro': model({ [NOW - DAY]: { input: 9e6 } }), 'claude-haiku-4-5': model({ [NOW - DAY]: { input: 3e6 } }) });
    expect(agentCost(AGENT, stored(mixed), API, 7, NOW)).toMatchObject({ cost: 3, priced: true, partial: true });
  });

  it('a profile from before the hour buckets: its daily average × 7, marked approx; one read before the window, nothing', () => {
    // 30 days covered, 30M input tokens on Haiku: $30 → $7 a week.
    const old = profile({ 'claude-haiku-4-5': { ...model({}), input: 30e6, h: undefined } }, { hourly: false });
    const approx = agentCost(AGENT, stored(old, NOW - HOUR), API, 7, NOW);
    expect(approx.approx).toBe(true);
    expect(approx.cost).toBeCloseTo(7, 1);
    expect(agentCost(AGENT, stored(old, NOW - 8 * DAY), API, 7, NOW)).toMatchObject({ cost: 0, tier: 0 });
    // Ten days old: ten days' use is the whole of it, scaled to the week.
    const young = profile({ 'claude-haiku-4-5': { ...model({}), input: 10e6, h: undefined } }, { hourly: false, firstCall: NOW - 10 * DAY });
    expect(agentCost(AGENT, stored(young, NOW - HOUR), API, 7, NOW).cost).toBeCloseTo(7, 1);
  });
});

describe('cost windows (View by → Cost\'s pills)', () => {
  it('eight windows, a week the default; each with bands about the week\'s scaled, rising, and a chip floor below its first band', () => {
    expect(Object.keys(COST_PERIODS)).toEqual(['1h', '3h', '6h', '9h', '12h', '1d', '1w', '1m']);
    // Usage's ranges are the same windows (Chris, 2026-10-06).
    expect(Object.values(SPEND_RANGES).map((r) => r.hours)).toEqual(Object.values(COST_PERIODS).map((p) => p.hours));
    expect(COST_PERIODS['1w']).toMatchObject({ hours: 168, bands: COST_BANDS, chipMin: 1, suffix: '/wk' });
    expect(COST_PERIODS['1m']!.hours).toBe(720); // the sampler keeps 30 days of hour buckets
    for (const [k, p] of Object.entries(COST_PERIODS)) {
      expect(p.bands.length, k).toBe(3);
      expect([...p.bands].sort((a, b) => a - b), k).toEqual([...p.bands]);
      expect(p.chipMin, k).toBeLessThan(p.bands[0]!);
      // Within a factor of two of the week's edges scaled to the window.
      p.bands.forEach((edge, i) => { const scaled = COST_BANDS[i]! * p.hours / 168; expect(edge / scaled, `${k} ${edge}`).toBeGreaterThan(0.5); expect(edge / scaled, `${k} ${edge}`).toBeLessThan(2); });
    }
  });

  it('the last hour is exact: the current hour so far, plus the covered part of the one before', () => {
    // NOW is 12:30. The 11:00 bucket is half inside the last hour, the 12:00 one (30 minutes so far) all of it.
    const p = profile({ 'claude-haiku-4-5': model({ [NOW - HOUR]: { input: 2e6 }, [NOW]: { input: 1e6 }, [NOW - 3 * HOUR]: { input: 9e6 } }) });
    expect(agentCost(AGENT, stored(p), API, 1 / 24, NOW).cost).toBe(2); // $1 of the 11:00 hour + $1
    expect(agentCost(AGENT, stored(p), API, 3 / 24, NOW).cost).toBe(7.5); // + half of 09:00
  });

  it('with a window\'s bands the tier is the window\'s cost against them', () => {
    const p = profile({ 'claude-haiku-4-5': model({ [NOW]: { input: 1.2e6 } }) }); // $1.20 this hour
    expect(agentCost(AGENT, stored(p), API, 3 / 24, NOW, COST_PERIODS['3h']!.bands)).toMatchObject({ cost: 1.2, tier: 3 });
    expect(agentCost(AGENT, stored(p), API, 7, NOW)).toMatchObject({ weekly: 1.2, tier: 1 }); // the week's rate against $10/$50/$100
  });
});

describe('a window at API prices, part by part (Usage)', () => {
  it('the parts add up to the price, model by model', () => {
    const mix = { input: 1e6, output: 2e5, cacheRead: 5e6, cacheWrite: 3e6 };
    for (const m of ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5-5']) {
      const p = priceParts(m, mix)!;
      expect(p.input + p.cacheWrite + p.cacheRead + p.output, m).toBeCloseTo(priceMix(m, mix)!, 9);
    }
    expect(priceParts('gemini-9-pro', mix)).toBeUndefined();
  });

  it('every agent of the owner\'s, plan ones too; a month at the pace; by model; another owner\'s and local ones left out', async () => {
    const w = await world();
    const now = Date.now();
    w.store.setModelProfile('c-big', profile({ 'claude-opus-4-8': model({ [now - HOUR]: { cacheWrite: 1.6e6, output: 0.2e6 } }) }), iso(now)); // $10 + $5
    w.store.setModelProfile('c-plan', profile({ 'claude-sonnet-5': model({ [now - HOUR]: { input: 2.5e6 } }) }), iso(now)); // $5 on the plan
    const pr = windowPricing(w.store, OWNER, 24, now);
    expect(pr.total).toBeCloseTo(20, 6);
    expect(pr.parts).toMatchObject({ cacheWrite: 10, output: 5, input: 5, cacheRead: 0 });
    expect(pr.billing).toEqual({ api: 15, plan: 5 });
    expect(pr.monthly).toBeCloseTo(600, 6);
    expect(pr.models).toEqual([{ model: 'claude-opus-4-8', cost: 15 }, { model: 'claude-sonnet-5', cost: 5 }]);
    expect(Object.keys(pr.agents).sort()).toEqual(['c-big', 'c-plan']);
    expect(pr.unpriced).toBe(true); // Garden Notes on gemini-9-pro
    expect(windowPricing(w.store, STRANGER, 24, now).total).toBe(0);
  });
});

describe('spend over time (the Usage chart)', () => {
  it('slices of the range, part by part, tokens beside; one agent or all; the plan share', async () => {
    const w = await world();
    const now = Date.parse('2026-10-05T12:30:00Z');
    w.store.setModelProfile('c-big', profile({ 'claude-opus-4-8': model({ [now - 2 * HOUR]: { cacheWrite: 1.6e6, output: 0.2e6 }, [now - 30 * HOUR]: { input: 1e6 } }) }), iso(now));
    w.store.setModelProfile('c-plan', profile({ 'claude-sonnet-5': model({ [now - 2 * HOUR]: { input: 2.5e6 } }) }), iso(now));
    const day = spendSeries(w.store, OWNER, 'day', { now });
    // The last 24 hours to the minute (12:30 back to 12:30): 25 hourly bars, the first and last partial.
    expect(day.buckets).toHaveLength(25);
    expect(day.bucketHours).toBe(1);
    expect(day.buckets[0]!.at).toBe('2026-10-04T12:00:00.000Z');
    expect(day.buckets.at(-1)!.at).toBe('2026-10-05T12:00:00.000Z');
    const b = day.buckets.find((x) => x.at === '2026-10-05T10:00:00.000Z')!;
    expect(b).toMatchObject({ cacheWrite: 10, output: 5, input: 5, cacheRead: 0, tokens: 4.3e6 });
    expect(day.totals.cost).toBe(20); // the hour 30 h ago is outside; tokens on a model with no price count, at no cost
    expect(day.planShare).toBe(0.25);
    const week = spendSeries(w.store, OWNER, 'week', { now });
    expect(week.buckets).toHaveLength(57);
    // The last hour, to the minute: the current hour so far and half of the one before; the 10:00 hour is outside.
    const hour = spendSeries(w.store, OWNER, '1h', { now });
    expect(hour.buckets.map((x) => x.at)).toEqual(['2026-10-05T11:00:00.000Z', '2026-10-05T12:00:00.000Z']);
    expect(hour.totals.cost).toBe(0);
    const six = spendSeries(w.store, OWNER, '6h', { now });
    expect(six.totals.cost).toBe(20);
    expect(six.monthly).toBe(2400);
    expect(week.totals.cost).toBe(25); // now with the $5 of input 30 hours ago
    const one = spendSeries(w.store, OWNER, 'day', { now, agentId: 'c-plan' });
    expect(one.totals).toMatchObject({ cost: 5, input: 5 });
    expect(one.planShare).toBe(1);
    expect(spendSeries(w.store, STRANGER, 'month', { now }).totals.cost).toBe(0);
    const r = await w.f.inject({ method: 'GET', url: '/v1/usage/spend?range=year', headers: as(OWNER) });
    expect(r.statusCode).toBe(400);
    expect((await w.f.inject({ method: 'GET', url: '/v1/usage/spend?range=day&agent=c-big', headers: as(STRANGER) })).statusCode).toBe(404);
    expect((await w.f.inject({ method: 'GET', url: '/v1/usage/spend?range=month', headers: as(OWNER) })).json().buckets.length).toBeGreaterThanOrEqual(30);
    expect((await w.f.inject({ method: 'GET', url: '/v1/usage/spend?range=12h', headers: as(OWNER) })).statusCode).toBe(200);
    // A combination of agents; the picker's choices with each one's cost; by model; a month at the pace.
    const pick = spendSeries(w.store, OWNER, 'day', { now, agentIds: ['c-plan'] });
    expect(pick.totals.cost).toBe(5);
    expect(pick.choices.map((c) => c.id).slice(0, 2)).toEqual(['c-big', 'c-plan']);
    expect(pick.choices.find((c) => c.id === 'c-big')!.cost).toBe(15);
    expect(day.models).toEqual([{ model: 'claude-opus-4-8', cost: 15 }, { model: 'claude-sonnet-5', cost: 5 }]);
    expect(day.monthly).toBe(600);
    expect(one.choices).toEqual([]);
    const sel = (await w.f.inject({ method: 'GET', url: '/v1/usage/spend?range=day&agents=c-plan,c-elsewhere', headers: as(OWNER) })).json();
    expect(sel.totals.cost).toBeGreaterThanOrEqual(0); // an id that is not theirs is dropped, not an error
  });
});

describe('TtlCache', () => {
  it('answers from the cache inside the window and computes again after it', () => {
    const cache = new TtlCache<number>(5 * 60_000);
    let n = 0;
    expect(cache.get('k', 1_000, () => ++n).value).toBe(1);
    expect(cache.get('k', 1_000 + 4 * 60_000, () => ++n).value).toBe(1);
    expect(cache.get('other', 2_000, () => ++n).value).toBe(2);
    expect(cache.get('k', 1_000 + 5 * 60_000, () => ++n).value).toBe(3);
    // A clock that went backwards never serves a "future" answer.
    expect(cache.get('k', 0, () => ++n).value).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// The route.
// ---------------------------------------------------------------------------

async function world() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'API key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/key', createdAt: 'now' });
  store.insertAIProfile({ id: 'plan', ownerId: OWNER, name: 'Max', vendor: 'anthropic', kind: 'subscription', model: 'claude-sonnet-5', secretRef: 'ai/plan', createdAt: 'now' });
  store.insertAIProfile({ id: 'gem', ownerId: OWNER, name: 'Gemini', vendor: 'google', kind: 'api_key', model: 'gemini-9-pro', secretRef: 'ai/gem', createdAt: 'now' });
  store.insertAIProfile({ id: 'oll', ownerId: OWNER, name: 'Ollama', vendor: 'local', kind: 'api_key', model: 'qwen3:8b', createdAt: 'now' } as never);
  const provider = new MockProvider();
  const execShell = vi.spyOn(provider, 'execShell');
  const exec = vi.spyOn(provider, 'exec');
  const start = vi.spyOn(provider, 'start');
  const f = Fastify();
  await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false } } as never } as never);
  const agent = (id: string, name: string, src: string, state = 'RUNNING') => store.insertAgent({
    id, ownerId: OWNER, name, slug: id, state, aiProfileId: src, hostId: 'h1', runtimeRef: `mock://${id}`,
    persona: '', sharedMemory: true, webOnly: true, createdAt: '2026-08-01T00:00:00Z', updatedAt: 'now',
  } as never);
  const now = Date.now();
  agent('c-big', 'Research Desk', 'key');
  store.setModelProfile('c-big', profile({ 'claude-opus-4-8': model({ [now - DAY]: { input: 24e6 } }) }), iso(now)); // $120/wk
  agent('c-plan', 'Meal Planner', 'plan', 'STOPPED');
  store.setHibernated('c-plan', iso(now - HOUR));
  store.setModelProfile('c-plan', profile({ 'claude-sonnet-5': model({ [now - 2 * DAY]: { input: 6e6 } }) }), iso(now - HOUR)); // $12/wk
  agent('c-gem', 'Garden Notes', 'gem');
  store.setModelProfile('c-gem', profile({ 'gemini-9-pro': model({ [now - DAY]: { input: 1e6 } }) }), iso(now));
  agent('c-local', 'Tide Tables', 'oll');
  store.setModelProfile('c-local', profile({ 'qwen3:8b': model({ [now - DAY]: { input: 1e6 } }) }), iso(now));
  agent('c-idle', 'Tax Filing', 'key');
  store.insertMembership({ id: 'm1', agentId: 'c-big', userId: MEMBER, role: 'user', displayName: 'Robin', channelUserId: '4242', status: 'active' } as never);
  store.insertMembership({ id: 'm2', agentId: 'c-plan', userId: GUEST, role: 'user', displayName: 'Sam', status: 'active', webChat: true } as never);
  const costs = async (who: string, q = '') => {
    const r = await f.inject({ method: 'GET', url: `/v1/costs${q}`, headers: as(who) });
    return { status: r.statusCode, body: r.json() as { off?: boolean; days: number; at?: string; agents: Record<string, { cost: number; weekly: number; monthly: number; tier: number; priced: boolean; plan?: boolean; local?: boolean }> } };
  };
  return { f, store, costs, execShell, exec, start };
}

describe('GET /v1/costs', () => {
  afterEach(() => { delete process.env.HATCHABOT_COST_BADGES; });

  it('the owner gets every agent of theirs, from what the sampler stored', async () => {
    const w = await world();
    const { status, body } = await w.costs(OWNER);
    expect(status).toBe(200);
    expect(body.days).toBe(7);
    expect(Object.keys(body.agents).sort()).toEqual(['c-big', 'c-gem', 'c-idle', 'c-local', 'c-plan']);
    expect(body.agents['c-big']).toMatchObject({ cost: 120, weekly: 120, tier: 4, priced: true });
    expect(body.agents['c-plan']).toMatchObject({ weekly: 12, tier: 2, plan: true });
    expect((body as unknown as { bands: number[] }).bands).toEqual([10, 50, 100]);
    expect(body.agents['c-gem']).toMatchObject({ priced: false });
    expect(body.agents['c-local']).toMatchObject({ cost: 0, local: true });
    expect(body.agents['c-idle']).toMatchObject({ cost: 0, tier: 0 });
  });

  it('period=3h: that window, its bands and chip; an unknown period, or period with days, is refused', async () => {
    const w = await world();
    const r = await w.f.inject({ method: 'GET', url: '/v1/costs?period=3h', headers: as(OWNER) });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({ period: '3h', hours: 3, bands: [0.2, 1, 2], chipMin: 0.02, suffix: '/3h' });
    expect(b.agents['c-big']).toMatchObject({ cost: 0, tier: 0 }); // its use was a day ago
    const m = (await w.f.inject({ method: 'GET', url: '/v1/costs?period=1m', headers: as(OWNER) })).json();
    expect(m.agents['c-big']).toMatchObject({ cost: 120, tier: 2 }); // $120 in 30 days: the $40–200 band
    expect((await w.f.inject({ method: 'GET', url: '/v1/costs?period=2h', headers: as(OWNER) })).statusCode).toBe(400);
    expect((await w.f.inject({ method: 'GET', url: '/v1/costs?period=1w&days=7', headers: as(OWNER) })).statusCode).toBe(400);
    expect((await w.f.inject({ method: 'GET', url: '/v1/costs?period=1w', headers: as(OWNER) })).json().agents['c-big']).toMatchObject({ cost: 120, weekly: 120, tier: 4 });
  });

  it('never reads a container, starts or wakes an agent', async () => {
    const w = await world();
    await w.costs(OWNER);
    expect(w.execShell).not.toHaveBeenCalled();
    expect(w.exec).not.toHaveBeenCalled();
    expect(w.start).not.toHaveBeenCalled();
    expect(w.store.getAgent('c-plan')).toMatchObject({ state: 'STOPPED' });
  });

  it('scoped like the list: a member sees the shared agent\'s cost; a web-chat guest gets none; a stranger nothing', async () => {
    const w = await world();
    expect(Object.keys((await w.costs(MEMBER)).body.agents)).toEqual(['c-big']);
    expect((await w.costs(GUEST)).body.agents).toEqual({});
    expect((await w.costs(STRANGER)).body.agents).toEqual({});
  });

  it('cached for five minutes per person: a new reading shows on the next window', async () => {
    const w = await world();
    const first = await w.costs(OWNER);
    w.store.setModelProfile('c-idle', profile({ 'claude-haiku-4-5': model({ [Date.now() - HOUR]: { input: 6e6 } }) }), iso(Date.now()));
    const second = await w.costs(OWNER);
    expect(second.body.at).toBe(first.body.at);
    expect(second.body.agents['c-idle']!.cost).toBe(0);
    // Another person's answer is their own.
    expect(Object.keys((await w.costs(MEMBER)).body.agents)).toEqual(['c-big']);
    // Another window is another answer, computed now.
    expect((await w.costs(OWNER, '?days=14')).body.agents['c-idle']!.cost).toBe(6);
  });

  it('refuses a window that is not 1–30 whole days', async () => {
    const w = await world();
    for (const q of ['?days=0', '?days=31', '?days=2.5', '?days=x']) expect((await w.costs(OWNER, q)).status, q).toBe(400);
  });

  it('HATCHABOT_COST_BADGES=off: off, and no figures', async () => {
    process.env.HATCHABOT_COST_BADGES = 'off';
    const w = await world();
    const { body } = await w.costs(OWNER);
    expect(body).toMatchObject({ off: true, agents: {} });
  });

  it('is a signed-in read at the public address', () => {
    expect(publicClassFor('GET', '/v1/costs')).toBe('signed-in');
    expect(publicClassFor('GET', '/v1/model-prices')).toBe('signed-in');
  });

  it('costsFor and the route agree', async () => {
    const w = await world();
    const direct = costsFor(w.store, OWNER, 7);
    const { body } = await w.costs(OWNER);
    expect(body.agents['c-big']!.weekly).toBe(direct['c-big']!.weekly);
  });
});

describe('GET /v1/model-prices', () => {
  it('the server\'s list, its date and source, and the models here it cannot price', async () => {
    const w = await world();
    const r = await w.f.inject({ method: 'GET', url: '/v1/model-prices', headers: as(OWNER) });
    expect(r.statusCode).toBe(200);
    const d = r.json();
    expect(d.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d.source).toBe('https://platform.claude.com/docs/en/about-claude/pricing');
    expect(d).toMatchObject({ cacheWrite: 1.25, cacheReadDefault: 0.1, unpriced: ['gemini-9-pro'], local: ['qwen3:8b'] });
    expect(d.models.find((m: { id: string }) => m.id === 'claude-opus-4-8')).toMatchObject({ label: 'Opus 4.8', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
    expect(d.models.find((m: { id: string }) => m.id === 'claude-opus-5-5')).toMatchObject({ cacheRead: 0.2, cacheReadShare: 0.05 });
    // A stranger has no sources: the list, and nothing of the owner's.
    const s = (await w.f.inject({ method: 'GET', url: '/v1/model-prices', headers: as(STRANGER) })).json();
    expect(s.models.length).toBe(d.models.length);
    expect(s).toMatchObject({ unpriced: [], local: [] });
  });
});
