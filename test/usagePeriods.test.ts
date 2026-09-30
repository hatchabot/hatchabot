import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { computeUsagePeriod, localDay, snapshotDailyUsage } from '../src/orchestrator/fleetUsage.js';

/**
 * Status → Usage by period: from the sampler's records (token counter
 * samples, calls in slots and hours), per agent and per bucket, answering at
 * once with no container in the loop. The lifetime ranking and its "~/hr"
 * average had read as live use when the use was days ago (Chris, 2026-09-25).
 */
const OWNER = 'user-o';
const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000, H = 3_600_000;

function world() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'api', ownerId: OWNER, name: 'Key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/api', createdAt: 'now' });
  store.insertAIProfile({ id: 'sub', ownerId: OWNER, name: 'Max', vendor: 'anthropic', kind: 'subscription', model: 'claude-sonnet-5', secretRef: 'ai/sub', createdAt: 'now' });
  const agent = (id: string, name: string, prof: string, state = 'RUNNING') => store.insertAgent({
    id, ownerId: OWNER, name, slug: id, state, aiProfileId: prof, hostId: 'h1', runtimeRef: `mock://${id}`, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now',
  } as never);
  agent('den', 'Den', 'api'); agent('kitchen', 'Kitchen', 'sub'); agent('attic', 'Attic', 'sub', 'STOPPED');
  // Den: counter samples every 10 minutes; +400 tokens in the last hour, +5000 more earlier today, +20000 six days ago.
  store.addTokenSample('den', 'api', iso(6 * 24 * H + 10 * MIN), 100_000);
  store.addTokenSample('den', 'api', iso(6 * 24 * H), 120_000);
  store.addTokenSample('den', 'api', iso(5 * H), 120_000);
  store.addTokenSample('den', 'api', iso(4 * H), 125_000);
  store.addTokenSample('den', 'api', iso(50 * MIN), 125_000);
  store.addTokenSample('den', 'api', iso(40 * MIN), 125_300);
  store.addTokenSample('den', 'api', iso(10 * MIN), 125_400);
  // Kitchen: a counter reset (session cleared) mid-day: 900 → 200 counts 200, not −700.
  store.addTokenSample('kitchen', 'sub', iso(3 * H), 900);
  store.addTokenSample('kitchen', 'sub', iso(2 * H), 200);
  store.addTokenSample('kitchen', 'sub', iso(30 * MIN), 250);
  // Attic (stopped) used nothing recently; nothing in the last week either.
  store.addTokenSample('attic', 'sub', iso(20 * 24 * H), 5_000);
  // Calls: Den 3 in the last hour (one refused), 4 more earlier today; Kitchen 2 yesterday-ish (in the week).
  const slot = (msAgo: number) => { const d = new Date(NOW - msAgo); d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 5) * 5, 0, 0); return d.toISOString().slice(0, 16); };
  store.addModelCallSlots('den', 'api', new Map([[slot(45 * MIN), { ok: 2, limited: 1, failed: 0 }], [slot(5 * H), { ok: 4, limited: 0, failed: 0 }]]));
  store.addModelCallHours('den', 'api', new Map([[iso(45 * MIN).slice(0, 13), { ok: 2, limited: 1, failed: 0 }], [iso(5 * H).slice(0, 13), { ok: 4, limited: 0, failed: 0 }]]));
  store.addModelCallHours('kitchen', 'sub', new Map([[iso(30 * H).slice(0, 13), { ok: 2, limited: 0, failed: 0 }]]));
  return store;
}

describe('computeUsagePeriod', () => {
  it('the last hour: Den +400 tokens and 3 requests (1 refused), Kitchen +50; buckets are 5 minutes', () => {
    const v = computeUsagePeriod(world(), OWNER, 'hour', NOW);
    expect(v.bucketMinutes).toBe(5);
    expect(v.buckets.length).toBeGreaterThanOrEqual(12);
    expect(v.agents.map((a) => [a.name, a.tokens, a.requests, a.limited])).toEqual([['Den', 400, 3, 1], ['Kitchen', 50, 0, 0]]);
    expect(v.totals).toEqual({ tokens: 450, requests: 3, limited: 1 });
    expect(v.buckets.reduce((s, b) => s + b.tokens, 0)).toBe(450);
    expect(v.buckets.reduce((s, b) => s + b.requests, 0)).toBe(3);
    // Den is API-keyed: an estimate on its current model; Kitchen is included.
    expect(v.agents[0]!.billing).toBe('api');
    expect(v.agents[0]!.cost!.low).toBeCloseTo(400 / 1e6 * 5, 6);
    expect(v.agents[1]!).toMatchObject({ billing: 'included', cost: null });
    expect(v.byBilling).toEqual({ included: 50, api: 400, local: 0 });
  });

  it('the last day: earlier hours count, a counter drop counts nothing, hourly buckets', () => {
    const v = computeUsagePeriod(world(), OWNER, 'day', NOW);
    expect(v.bucketMinutes).toBe(60);
    const den = v.agents.find((a) => a.name === 'Den')!, kitchen = v.agents.find((a) => a.name === 'Kitchen')!;
    expect(den.tokens).toBe(5_400); // 5000 four hours ago + 400 in the last hour
    expect(den.requests).toBe(7);
    expect(kitchen.tokens).toBe(50); // the drop counts nothing (a sum over sessions; night review), then +50
    expect(v.agents.map((a) => a.name)).toEqual(['Den', 'Kitchen']); // by tokens, desc; Attic used nothing
  });

  it('the last week: the six-day-old use counts, two-hour buckets, requests from the hourly table', () => {
    const v = computeUsagePeriod(world(), OWNER, 'week', NOW);
    expect(v.bucketMinutes).toBe(120);
    const den = v.agents.find((a) => a.name === 'Den')!, kitchen = v.agents.find((a) => a.name === 'Kitchen')!;
    expect(den.tokens).toBe(25_400);
    expect(den.requests).toBe(7);
    expect(kitchen.requests).toBe(2);
    expect(v.buckets.reduce((s, b) => s + b.requests, 0)).toBe(9);
  });

  it('prices a window at the agent\'s measured rate, not the input..output bracket (2026-09-28)', () => {
    const store = world();
    // Mostly cache reads: $0.60 per million tokens, where the bracket said $5..$25.
    store.setAgentTokenRate('den', 0.6 / 1e6, false, iso(0));
    const den = computeUsagePeriod(store, OWNER, 'hour', NOW).agents[0]!;
    expect(den.cost!.low).toBeCloseTo(400 * 0.6 / 1e6, 9);
    expect(den.cost!.high).toBe(den.cost!.low);
  });

  // 2026-09-30: an unpriced model showed "est. $0.00+"; and billing followed
  // the agent's current source, not the one the tokens were spent on.
  it('an API model with no known price is marked unpriced, not priced at $0', () => {
    const store = world();
    store.insertAIProfile({ id: 'odd', ownerId: OWNER, name: 'Odd key', vendor: 'anthropic', kind: 'api_key', model: 'claude-made-up-9', secretRef: 'ai/odd', createdAt: 'now' });
    store.insertAgent({ id: 'shed', ownerId: OWNER, name: 'Shed', slug: 'shed', state: 'RUNNING', aiProfileId: 'odd', hostId: 'h1', runtimeRef: 'mock://shed', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    store.addTokenSample('shed', 'odd', iso(50 * MIN), 1_000);
    store.addTokenSample('shed', 'odd', iso(20 * MIN), 3_000);
    const v = computeUsagePeriod(store, OWNER, 'hour', NOW);
    const shed = v.agents.find((a) => a.name === 'Shed')!;
    expect(shed).toMatchObject({ billing: 'api', cost: null, unpriced: true, model: 'claude-made-up-9' });
    // The total still prices Den, and says it is not the whole story.
    expect(v.cost).toMatchObject({ agents: 1, partial: true });
  });

  it('tokens are billed to the source each reading was taken on', () => {
    const store = world();
    // Den moved from its API key to the subscription 30 minutes ago.
    store.setAgentAIProfile('den', 'sub');
    store.addTokenSample('den', 'sub', iso(5 * MIN), 125_900); // +500 on the subscription
    const v = computeUsagePeriod(store, OWNER, 'hour', NOW);
    const den = v.agents.find((a) => a.name === 'Den')!;
    expect(den.tokens).toBe(900);
    // Most of the hour was on the subscription: the row says so, and the API part keeps its price.
    expect(den).toMatchObject({ billing: 'included', profileName: 'Max' });
    expect(den.cost!.low).toBeCloseTo(400 / 1e6 * 5, 6);
    expect(v.byBilling).toEqual({ included: 550, api: 400, local: 0 });
  });

  it('a few hours back: 6 hours in 15-minute bars counts the last hours, not the morning (2026-09-28)', () => {
    const v = computeUsagePeriod(world(), OWNER, '6h', NOW);
    expect(v.bucketMinutes).toBe(15);
    expect(v.buckets.length).toBeGreaterThanOrEqual(24);
    const den = v.agents.find((a) => a.name === 'Den')!;
    expect(den.tokens).toBe(5_400); // 5000 four hours ago + 400 in the last hour
    expect(computeUsagePeriod(world(), OWNER, '3h', NOW).agents.find((a) => a.name === 'Den')!.tokens).toBe(400);
    expect(computeUsagePeriod(world(), OWNER, '12h', NOW).bucketMinutes).toBe(30);
  });

  it('a busy agent read every 10 minutes fills every 5-minute bar, not every other one (review, 2026-09-29)', () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'sub', ownerId: OWNER, name: 'Max', vendor: 'anthropic', kind: 'subscription', model: 'claude-sonnet-5', secretRef: 'ai/sub', createdAt: 'now' });
    store.insertAgent({ id: 'busy', ownerId: OWNER, name: 'Busy', slug: 'busy', state: 'RUNNING', aiProfileId: 'sub', hostId: 'h1', runtimeRef: 'mock://busy', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    // Readings on the 10-minute marks, +1000 tokens each: 500 per 5 minutes.
    for (let m = 70, total = 1000; m >= 0; m -= 10, total += 1000) store.addTokenSample('busy', 'sub', iso(m * MIN), total);
    const v = computeUsagePeriod(store, OWNER, 'hour', NOW);
    // The reading at the window's start counts (its span began before it: the first bar takes that part).
    expect(v.agents[0]!.tokens).toBe(7000);
    expect(v.buckets.reduce((s, b) => s + b.tokens, 0)).toBe(7000);
    const inner = v.buckets.filter((b) => b.at >= iso(55 * MIN) && b.at < iso(0));
    expect(inner.map((b) => b.tokens)).toEqual(Array(11).fill(500));
    // A long gap (stopped for hours) lands in the 20 minutes before its reading, not across the day.
    store.addTokenSample('busy', 'sub', iso(-5 * H), 11_000); // a reading five hours on: a later view
    const later = computeUsagePeriod(store, OWNER, 'day', NOW + 5 * H);
    expect(later.buckets.find((b) => b.at === iso(-4 * H))!.tokens).toBe(3000);
    expect(later.buckets.filter((b) => b.at > iso(0) && b.at < iso(-4 * H)).every((b) => b.tokens === 0)).toBe(true);
  });

  it('an idle agent first read 3 hours ago does not make the day or week partial (review, 2026-09-29)', () => {
    const store = world();
    store.insertAgent({ id: 'idle', ownerId: OWNER, name: 'Idle', slug: 'idle', state: 'RUNNING', aiProfileId: 'sub', hostId: 'h1', runtimeRef: 'mock://idle', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    // Its first reading found no calls in the transcripts' last 8 days, so there was nothing to backfill.
    store.addTokenSample('idle', 'sub', iso(3 * H), 42_000);
    expect(computeUsagePeriod(store, OWNER, 'day', NOW).countingSince).toBeUndefined();
    expect(computeUsagePeriod(store, OWNER, 'week', NOW).countingSince).toBeUndefined();
  });

  it('scopes to the caller', () => {
    expect(computeUsagePeriod(world(), 'someone-else', 'day', NOW).agents).toEqual([]);
  });
});

describe('GET /v1/usage/periods', () => {
  it('answers from the store for a valid period and refuses a bad one', async () => {
    const store = world();
    const f = Fastify();
    await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} } as never, providers: new Map([['mock', new MockProvider()]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never });
    const prev = process.env.HATCHABOT_ALLOW_OWNER_HEADER; process.env.HATCHABOT_ALLOW_OWNER_HEADER = '1';
    try {
      const r = await f.inject({ method: 'GET', url: '/v1/usage/periods?period=week', headers: { 'x-hatchabot-owner': OWNER } });
      expect(r.statusCode).toBe(200);
      expect(r.json().period).toBe('week');
      expect(r.json().agents.map((a: any) => a.name)).toEqual(['Den', 'Kitchen']);
      expect((await f.inject({ method: 'GET', url: '/v1/usage/periods?period=month', headers: { 'x-hatchabot-owner': OWNER } })).statusCode).toBe(400);
    } finally { if (prev === undefined) delete process.env.HATCHABOT_ALLOW_OWNER_HEADER; else process.env.HATCHABOT_ALLOW_OWNER_HEADER = prev; }
  });
});

describe('the daily trend point (review, 2026-09-29)', () => {
  function withTz<T>(tz: string, f: () => T): T {
    const prev = process.env.TZ; process.env.TZ = tz;
    try { return f(); } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
  }
  function trendWorld() {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'api', ownerId: OWNER, name: 'Key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/api', createdAt: 'now' });
    store.insertAIProfile({ id: 'sub', ownerId: OWNER, name: 'Max', vendor: 'anthropic', kind: 'subscription', model: 'claude-sonnet-5', secretRef: 'ai/sub', createdAt: 'now' });
    for (const [id, prof] of [['den', 'api'], ['kitchen', 'sub']] as const) {
      store.insertAgent({ id, ownerId: OWNER, name: id, slug: id, state: 'RUNNING', aiProfileId: prof, hostId: 'h1', runtimeRef: `mock://${id}`, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    }
    return store;
  }

  it('days are the host\'s own: 21:00 on a UTC−4 host is that day, not the next', () => withTz('America/New_York', () => {
    const store = trendWorld();
    const now = Date.parse('2026-09-29T01:00:00.000Z'); // 21:00 on Sep 28 in New York
    expect(localDay(now)).toEqual({ day: '2026-09-28', startIso: '2026-09-28T04:00:00.000Z' });
    store.addTokenSample('kitchen', 'sub', '2026-09-28T03:50:00.000Z', 100);   // 23:50 on the 27th
    store.addTokenSample('kitchen', 'sub', '2026-09-28T04:10:00.000Z', 300);   // +200 on the 28th
    store.addTokenSample('kitchen', 'sub', '2026-09-29T00:50:00.000Z', 1000);  // +700 at 20:50
    store.addTokenSample('kitchen', 'sub', '2026-09-29T01:00:00.000Z', 1500);  // +500 at 21:00
    snapshotDailyUsage(store, now);
    expect(store.listUsageSnapshots(OWNER, 30).map((s) => [s.day, s.usedTokens])).toEqual([['2026-09-28', 1400]]);
  }));

  it('the day\'s API cost is the day\'s own use at the agent\'s rate, and a snapshot without a cost keeps it', () => withTz('UTC', () => {
    const store = trendWorld();
    const now = Date.parse('2026-09-28T12:00:00.000Z');
    store.setAgentTokenRate('den', 2 / 1e6, false, '2026-09-28T00:00:00.000Z'); // $2 per million
    store.addTokenSample('den', 'api', '2026-09-27T23:00:00.000Z', 5_000_000); // lifetime: not today's cost
    store.addTokenSample('den', 'api', '2026-09-28T11:00:00.000Z', 6_000_000); // +1M today
    store.addTokenSample('kitchen', 'sub', '2026-09-28T11:00:00.000Z', 9_000_000); // included: no cost
    snapshotDailyUsage(store, now);
    const day = () => store.listUsageSnapshots(OWNER, 30).find((s) => s.day === '2026-09-28')!;
    expect(day().costLow).toBeCloseTo(2, 9);
    expect(day().costHigh).toBeCloseTo(2, 9);
    // The CLI's rollup (any snapshot without a cost) leaves it alone.
    store.upsertUsageSnapshot(OWNER, { day: '2026-09-28', totalTokens: 16_000_000, byBilling: {} });
    expect(day().costHigh).toBeCloseTo(2, 9);
    // The next pass still has it, with the new use added.
    store.addTokenSample('den', 'api', '2026-09-28T11:10:00.000Z', 6_500_000);
    snapshotDailyUsage(store, now + 600_000);
    expect(day().costHigh).toBeCloseTo(3, 9);
  }));

  it('yesterday is finished on the first pass after midnight', () => withTz('UTC', () => {
    const store = trendWorld();
    store.addTokenSample('kitchen', 'sub', '2026-09-27T23:40:00.000Z', 1000);
    snapshotDailyUsage(store, Date.parse('2026-09-27T23:45:00.000Z'));
    store.addTokenSample('kitchen', 'sub', '2026-09-27T23:55:00.000Z', 1600); // after that pass, before midnight
    store.addTokenSample('kitchen', 'sub', '2026-09-28T00:05:00.000Z', 1700);
    snapshotDailyUsage(store, Date.parse('2026-09-28T00:05:00.000Z'));
    expect(store.listUsageSnapshots(OWNER, 30).map((s) => [s.day, s.usedTokens])).toEqual([['2026-09-27', 600], ['2026-09-28', 100]]);
  }));
});
