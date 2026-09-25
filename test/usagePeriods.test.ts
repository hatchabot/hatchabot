import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { computeUsagePeriod } from '../src/orchestrator/fleetUsage.js';

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

  it('the last day: earlier hours count, a counter reset counts the new total, hourly buckets', () => {
    const v = computeUsagePeriod(world(), OWNER, 'day', NOW);
    expect(v.bucketMinutes).toBe(60);
    const den = v.agents.find((a) => a.name === 'Den')!, kitchen = v.agents.find((a) => a.name === 'Kitchen')!;
    expect(den.tokens).toBe(5_400); // 5000 four hours ago + 400 in the last hour
    expect(den.requests).toBe(7);
    expect(kitchen.tokens).toBe(250); // 200 after the reset + 50
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
