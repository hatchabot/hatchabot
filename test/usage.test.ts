import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { agentUsage } from '../src/orchestrator/usage.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const as = { 'x-hatchabot-owner': OWNER };

const SESSIONS_JSON = JSON.stringify({
  sessions: [
    { totalTokens: 1000, model: 'claude-opus-4-8', updatedAt: 2000 },
    { totalTokens: 500, model: 'claude-opus-4-8', updatedAt: 3000 },
    { totalTokens: 250, model: 'claude-sonnet-5', updatedAt: 1000 },
  ],
});

async function seedRuntime(p: MockProvider, slug = 'kitchen', agentId = 'a1') {
  const { runtimeRef } = await p.provision({
    agentId, slug, workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } }, env: {},
  } as any);
  return runtimeRef;
}

describe('agentUsage aggregation', () => {
  it('sums totalTokens, groups by model (desc), counts sessions, tracks last active', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.execResponses.set('sessions list', { code: 0, stdout: SESSIONS_JSON, stderr: '' });
    const u = await agentUsage(p, ref, 'kitchen');
    expect(u.totalTokens).toBe(1750);
    expect(u.sessions).toBe(3);
    expect(u.lastActive).toBe(new Date(3000).toISOString());
    expect(u.byModel).toEqual([
      { model: 'claude-opus-4-8', tokens: 1500, sessions: 2 },
      { model: 'claude-sonnet-5', tokens: 250, sessions: 1 },
    ]);
    expect(p.execLog).toContainEqual(['sessions', 'list', '--agent', 'kitchen', '--json']);
  });

  it('computes tokens/hour from the session span (start → last activity)', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    const HOUR = 3_600_000;
    // 6000 tokens over a 2-hour span → 3000/hr.
    p.execResponses.set('sessions list', {
      code: 0, stderr: '',
      stdout: JSON.stringify({ sessions: [
        { totalTokens: 4000, model: 'm', sessionStartedAt: 0, updatedAt: HOUR },
        { totalTokens: 2000, model: 'm', sessionStartedAt: HOUR, updatedAt: 2 * HOUR },
      ] }),
    });
    const u = await agentUsage(p, ref, 'kitchen');
    expect(u.totalTokens).toBe(6000);
    expect(u.spanMs).toBe(2 * HOUR);
    expect(u.tokensPerHour).toBe(3000);
  });

  it('omits tokens/hour when the span is too short to be meaningful (< 10 min)', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.execResponses.set('sessions list', {
      code: 0, stderr: '',
      stdout: JSON.stringify({ sessions: [{ totalTokens: 5000, model: 'm', sessionStartedAt: 0, updatedAt: 60_000 }] }),
    });
    const u = await agentUsage(p, ref, 'kitchen');
    expect(u.tokensPerHour).toBeUndefined();
  });

  it('returns an empty usage on a nonzero exit or bad json', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.execResponses.set('sessions list', { code: 1, stdout: '', stderr: 'down' });
    expect(await agentUsage(p, ref, 'kitchen')).toEqual({ totalTokens: 0, sessions: 0, byModel: [] });
    p.execResponses.set('sessions list', { code: 0, stdout: 'not json', stderr: '' });
    expect(await agentUsage(p, ref, 'kitchen')).toEqual({ totalTokens: 0, sessions: 0, byModel: [] });
  });
});

async function world(state = 'RUNNING') {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const runtimeRef = await seedRuntime(provider);
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: state as any, aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  const f = Fastify();
  await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  return { store, provider, f };
}

describe('GET /v1/agents/:id/usage', () => {
  it('returns aggregated usage for a RUNNING agent', async () => {
    const { provider, f } = await world();
    provider.execResponses.set('sessions list', { code: 0, stdout: SESSIONS_JSON, stderr: '' });
    const res = await f.inject({ method: 'GET', url: '/v1/agents/a1/usage', headers: as });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ totalTokens: 1750, sessions: 3 });
  });

  it('409s when the agent is not RUNNING', async () => {
    const { f } = await world('STOPPED');
    const res = await f.inject({ method: 'GET', url: '/v1/agents/a1/usage', headers: as });
    expect(res.statusCode).toBe(409);
  });

  it('404s for an agent the caller does not own', async () => {
    const { f } = await world();
    const res = await f.inject({ method: 'GET', url: '/v1/agents/a1/usage', headers: { 'x-hatchabot-owner': 'someone-else' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/usage (fleet rollup)', () => {
  async function fleetWorld() {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    // Two RUNNING agents (different totals so ranking is observable), one STOPPED.
    for (const [id, slug, name, state] of [
      ['a1', 'kitchen', 'Kitchen', 'RUNNING'],
      ['a2', 'den', 'Den', 'RUNNING'],
      ['a3', 'attic', 'Attic', 'STOPPED'],
    ] as const) {
      const { runtimeRef } = await provider.provision({ agentId: id, slug, workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } }, env: {} } as any);
      store.insertAgent({ id, ownerId: OWNER, name, slug, state, aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
    }
    // Den out-uses Kitchen — it should rank first.
    provider.execResponses.set('sessions list --agent kitchen', { code: 0, stdout: SESSIONS_JSON, stderr: '' }); // 1750
    provider.execResponses.set('sessions list --agent den', {
      code: 0, stdout: JSON.stringify({ sessions: [{ totalTokens: 9000, model: 'claude-opus-4-8', updatedAt: 5000 }] }), stderr: '',
    });
    const f = Fastify();
    await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
    return { f, provider };
  }

  it('ranks RUNNING agents by tokens and counts stopped ones as skipped (live-only)', async () => {
    const { f } = await fleetWorld();
    const res = await f.inject({ method: 'GET', url: '/v1/usage', headers: as });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agents.map((a: any) => a.name)).toEqual(['Den', 'Kitchen']); // desc by tokens
    expect(body.agents[0]).toMatchObject({ name: 'Den', totalTokens: 9000 });
    expect(body.totalTokens).toBe(10750);
    expect(body.counted).toBe(2);
    expect(body.skipped).toBe(1); // the STOPPED agent, not shown as zero
  });

  it('attaches an API cost RANGE per agent and a fleet total (api-keyed only)', async () => {
    const { f } = await fleetWorld();
    const body = (await f.inject({ method: 'GET', url: '/v1/usage', headers: as })).json();
    // Den: 9000 opus-4-8 tokens @ [5,25]/1M → low $0.045, high $0.225.
    expect(body.agents[0].billing).toBe('api');
    expect(body.agents[0].cost.low).toBeCloseTo(0.045, 4);
    expect(body.agents[0].cost.high).toBeCloseTo(0.225, 4);
    expect(body.agents[0].cost.partial).toBe(false);
    // Fleet cost sums both api agents; low = 0.045 (Den) + 0.00825 (Kitchen).
    expect(body.cost.agents).toBe(2);
    expect(body.cost.low).toBeCloseTo(0.05325, 4);
  });

  it('drops an unreachable container to skipped rather than failing the whole list', async () => {
    const { f, provider } = await fleetWorld();
    provider.exec = (async (_ref: string, argv: string[]) => {
      if (argv.includes('den')) throw new Error('container gone');
      return { code: 0, stdout: SESSIONS_JSON, stderr: '' };
    }) as any;
    const res = await f.inject({ method: 'GET', url: '/v1/usage', headers: as });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agents.map((a: any) => a.name)).toEqual(['Kitchen']); // Den dropped
    expect(body.skipped).toBe(2); // the STOPPED agent + the unreachable one
  });

  it('scopes to the caller — another user sees none of these agents', async () => {
    const { f } = await fleetWorld();
    const res = await f.inject({ method: 'GET', url: '/v1/usage', headers: { 'x-hatchabot-owner': 'someone-else' } });
    expect(res.json()).toMatchObject({ agents: [], counted: 0, skipped: 0 });
  });

  it('does not bill subscription (included) or local agents — cost is null', async () => {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'sub', ownerId: OWNER, name: 'Max', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', secretRef: 'ai/sub', createdAt: 'now' });
    store.insertAIProfile({ id: 'loc', ownerId: OWNER, name: 'Ollama', vendor: 'local', kind: 'api_key', model: 'gpt-oss', secretRef: 'ai/loc', createdAt: 'now' });
    for (const [id, slug, name, prof] of [['s1', 'sub-agent', 'Maxie', 'sub'], ['l1', 'loc-agent', 'Local', 'loc']] as const) {
      const { runtimeRef } = await provider.provision({ agentId: id, slug, workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } }, env: {} } as any);
      store.insertAgent({ id, ownerId: OWNER, name, slug, state: 'RUNNING', aiProfileId: prof, hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
    }
    provider.execResponses.set('sessions list', { code: 0, stdout: SESSIONS_JSON, stderr: '' });
    const f = Fastify();
    await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
    const body = (await f.inject({ method: 'GET', url: '/v1/usage', headers: as })).json();
    const byName = Object.fromEntries(body.agents.map((a: any) => [a.name, a]));
    expect(byName.Maxie).toMatchObject({ billing: 'included', cost: null });
    expect(byName.Local).toMatchObject({ billing: 'local', cost: null });
    expect(body.cost).toBeNull(); // nothing billable → no fleet cost at all
  });
});

describe('usage history (snapshot trend)', () => {
  it('the fleet usage view records a daily snapshot; history returns non-negative deltas', async () => {
    const store = new Store(new Database(':memory:'));
    // seed two prior days directly, then hit /v1/usage to record today.
    store.upsertUsageSnapshot(OWNER, { day: '2026-09-01', totalTokens: 1000, byBilling: { api: 1000, included: 0, local: 0 }, costLow: 0.01, costHigh: 0.05 });
    store.upsertUsageSnapshot(OWNER, { day: '2026-09-02', totalTokens: 1750, byBilling: { api: 1750, included: 0, local: 0 } });
    // upsert same day overwrites (not duplicate)
    store.upsertUsageSnapshot(OWNER, { day: '2026-09-02', totalTokens: 1800, byBilling: { api: 1800, included: 0, local: 0 } });

    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } }, env: {} } as any);
    store.setAgentRuntimeRef('a1', runtimeRef);
    provider.execResponses.set('sessions list', { code: 0, stdout: SESSIONS_JSON, stderr: '' });
    const f = Fastify();
    await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });

    const usage = (await f.inject({ method: 'GET', url: '/v1/usage', headers: as })).json();
    expect(usage.byBilling.api).toBe(1750); // 1000+500+250, all on the api-key profile
    const hist = (await f.inject({ method: 'GET', url: '/v1/usage/history', headers: as })).json();
    // 3 distinct days (two seeded + today), oldest→newest, first has no delta
    expect(hist.points.length).toBe(3);
    expect(hist.points[0].delta).toBeUndefined();
    expect(hist.points[1].delta).toBe(800);  // 1800 - 1000
    expect(hist.points.every((p: any) => p.delta === undefined || p.delta >= 0)).toBe(true);
  });

  it('a dip in the cumulative counter clamps the delta to 0, never negative', async () => {
    const store = new Store(new Database(':memory:'));
    store.upsertUsageSnapshot(OWNER, { day: '2026-09-01', totalTokens: 5000, byBilling: {} });
    store.upsertUsageSnapshot(OWNER, { day: '2026-09-02', totalTokens: 3000, byBilling: {} }); // session reset dip
    const snaps = store.listUsageSnapshots(OWNER, 30);
    expect(snaps.map((s) => s.day)).toEqual(['2026-09-01', '2026-09-02']); // oldest→newest
    expect(snaps[0]!.totalTokens).toBe(5000);
  });
});
