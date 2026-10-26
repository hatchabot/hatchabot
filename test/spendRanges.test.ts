/**
 * The Usage chart's range and View by → Cost's window are names of their own
 * (a range of Object's, such as ?range=constructor, hung the service: audit
 * #061), and tokens on a model with no known price are reported as such, never
 * folded into the dollars as $0 (audit #062). Made-up agents and numbers.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { HOUR_FIELDS } from '../src/orchestrator/usage.js';
import { isCostPeriod, isSpendRange, spendSeries, type SpendRange } from '../src/orchestrator/agentCosts.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-20T12:30:00Z');
const OWNER = 'owner-spend';
const as = (who: string) => ({ 'x-hatchabot-owner': who });
const hour = (ms: number) => new Date(ms).toISOString().slice(0, 13);

async function world() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'home-server', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'Anthropic API (household)', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/key', createdAt: 'now' });
  const f = Fastify();
  await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', new MockProvider()]]), channel: { kind: 'telegram', pool: { owns: () => false } } as never } as never);
  for (const [id, name] of [['s-meals', 'Meal Planner'], ['s-budget', 'Budget Tracker']]) {
    store.insertAgent({ id, ownerId: OWNER, name, slug: id, state: 'RUNNING', aiProfileId: 'key', hostId: 'h1', runtimeRef: `mock://${id}`,
      persona: '', sharedMemory: true, webOnly: true, createdAt: '2026-08-01T00:00:00Z', updatedAt: 'now' } as never);
  }
  /** One model's input tokens in the hour `at`. */
  const used = (agentId: string, models: Record<string, number>, at = NOW - 2 * HOUR) => store.setModelProfile(agentId, {
    hourly: true, since: NOW - 30 * 24 * HOUR, promptErrors: 0, crons: 0,
    models: Object.fromEntries(Object.entries(models).map(([m, input]) => [m, { input, output: 0, cacheRead: 0, cacheWrite: 0, h: { [hour(at)]: HOUR_FIELDS.map((k) => (k === 'input' ? input : 0)) } }])),
  } as never, new Date(NOW).toISOString());
  return { f, store, used };
}

describe('a range is one of the chart\'s own (audit #061)', () => {
  it('names that are Object\'s, not the table\'s, are not ranges or windows', () => {
    for (const x of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '', 'year', 7, undefined, ['week']]) {
      expect(isSpendRange(x)).toBe(false);
      expect(isCostPeriod(x)).toBe(false);
    }
    for (const r of ['1h', '3h', '6h', '9h', '12h', 'day', 'week', 'month']) expect(isSpendRange(r)).toBe(true);
    for (const p of ['1h', '1d', '1w', '1m']) expect(isCostPeriod(p)).toBe(true);
  });

  it('spendSeries refuses one at once instead of looping', () => {
    const store = new Store(new Database(':memory:'));
    for (const r of ['constructor', '__proto__', 'toString']) {
      expect(() => spendSeries(store, OWNER, r as SpendRange, { now: NOW })).toThrow(/range is one of/);
    }
    expect(spendSeries(store, OWNER, 'week', { now: NOW }).range).toBe('week');
  });

  it('GET /v1/usage/spend and GET /v1/costs answer 400 to them, and keep answering', async () => {
    const w = await world();
    for (const r of ['constructor', '__proto__', 'toString']) {
      const res = await w.f.inject({ method: 'GET', url: `/v1/usage/spend?range=${r}`, headers: as(OWNER) });
      expect(res.statusCode, r).toBe(400);
      expect(res.json().error).toMatch(/range is one of/);
      expect((await w.f.inject({ method: 'GET', url: `/v1/costs?period=${r}`, headers: as(OWNER) })).statusCode, r).toBe(400);
    }
    expect((await w.f.inject({ method: 'GET', url: '/v1/usage/spend?range=day', headers: as(OWNER) })).statusCode).toBe(200);
    expect((await w.f.inject({ method: 'GET', url: '/v1/costs?period=1d', headers: as(OWNER) })).statusCode).toBe(200);
  });
});

describe('tokens on a model with no known price (audit #062)', () => {
  it('all of it: the tokens counted, the dollars 0, and marked unpriced with the model', async () => {
    const w = await world();
    w.used('s-meals', { 'made-up-cloud-model': 1_000_000 });
    const d = spendSeries(w.store, OWNER, 'day', { now: NOW });
    expect(d.totals).toMatchObject({ cost: 0, tokens: 1_000_000 });
    expect(d.unpriced).toEqual({ tokens: 1_000_000, models: ['made-up-cloud-model'] });
  });

  it('part of it: the priced part in the dollars, the rest marked; one agent picked counts only its own', async () => {
    const w = await world();
    w.used('s-meals', { 'claude-opus-4-8': 1_000_000, 'vendor/made-up-cloud-model': 500_000 });
    w.used('s-budget', { 'claude-opus-4-8': 2_000_000 });
    const d = spendSeries(w.store, OWNER, 'day', { now: NOW });
    expect(d.totals.cost).toBe(15); // 3M input at $5 per 1M
    expect(d.unpriced).toEqual({ tokens: 500_000, models: ['made-up-cloud-model'] });
    expect(spendSeries(w.store, OWNER, 'day', { now: NOW, agentId: 's-budget' }).unpriced).toBeUndefined();
    const res = (await w.f.inject({ method: 'GET', url: '/v1/usage/spend?range=day', headers: as(OWNER) })).json();
    expect(res).toHaveProperty('totals');
  });

  it('all priced, or a local model: no mark', async () => {
    const w = await world();
    w.used('s-meals', { 'claude-opus-4-8': 1_000_000, 'ollama/qwen3:8b': 400_000 });
    expect(spendSeries(w.store, OWNER, 'day', { now: NOW }).unpriced).toBeUndefined();
  });
});
