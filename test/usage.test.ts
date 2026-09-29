import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { agentUsage } from '../src/orchestrator/usage.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import { fakeUsage } from './helpers/usageFake.js';

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const as = { 'x-hatchabot-owner': OWNER };

// Per-call usage as the transcripts record it (2026-09-28: the old source was
// each session's context size, not what the calls used).
const KITCHEN = fakeUsage([
  { model: 'claude-opus-4-8', input: 1000, session: 's1', at: 2000 },
  { model: 'claude-opus-4-8', input: 500, session: 's2', at: 3000 },
  { model: 'claude-sonnet-5', input: 250, session: 's3', at: 1000 },
]);

async function seedRuntime(p: MockProvider, slug = 'kitchen', agentId = 'a1') {
  const { runtimeRef } = await p.provision({
    agentId, slug, workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } }, env: {},
  } as any);
  return runtimeRef;
}

describe('agentUsage aggregation', () => {
  it('sums what the calls used, groups by model (desc), counts conversations, tracks the last call', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.usage.set(ref, KITCHEN);
    const u = await agentUsage(p, ref, 'kitchen');
    expect(u.totalTokens).toBe(1750);
    expect(u.calls).toBe(3);
    expect(u.sessions).toBe(3);
    expect(u.lastActive).toBe(new Date(3000).toISOString());
    expect(u.byModel.map((m) => [m.model, m.tokens, m.sessions, m.calls])).toEqual([
      ['claude-opus-4-8', 1500, 2, 2],
      ['claude-sonnet-5', 250, 1, 1],
    ]);
    expect(p.execLog).toContainEqual(['usage-read', ref]);
  });
  it('counts input, output, cache reads and cache writes, each kept apart', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.usage.set(ref, fakeUsage([{ input: 10, output: 20, cacheRead: 400_000, cacheWrite: 30_000 }]));
    const u = await agentUsage(p, ref, 'kitchen');
    expect(u).toMatchObject({ input: 10, output: 20, cacheRead: 400_000, cacheWrite: 30_000, totalTokens: 430_030 });
  });

  it('computes tokens/hour from the session span (start → last activity)', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    const HOUR = 3_600_000;
    // 6000 tokens over a 2-hour span (first call → last call) → 3000/hr.
    p.usage.set(ref, fakeUsage([{ model: 'm', input: 4000, at: HOUR }, { model: 'm', input: 2000, at: 3 * HOUR }]));
    const u = await agentUsage(p, ref, 'kitchen');
    expect(u.totalTokens).toBe(6000);
    expect(u.spanMs).toBe(2 * HOUR);
    expect(u.tokensPerHour).toBe(3000);
  });

  it('omits tokens/hour when the span is too short to be meaningful (< 10 min)', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.usage.set(ref, fakeUsage([{ model: 'm', input: 2500, at: 1_000 }, { model: 'm', input: 2500, at: 61_000 }]));
    const u = await agentUsage(p, ref, 'kitchen');
    expect(u.tokensPerHour).toBeUndefined();
  });

  it('returns an empty usage on a nonzero exit or bad json', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    const empty = { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, sessions: 0, byModel: [] };
    p.usage.set(ref, { code: 1, stdout: '', stderr: 'down' });
    expect(await agentUsage(p, ref, 'kitchen')).toEqual(empty);
    p.usage.set(ref, { code: 0, stdout: 'not json', stderr: '' });
    expect(await agentUsage(p, ref, 'kitchen')).toEqual(empty);
    await expect(agentUsage(p, ref, 'kitchen', { strict: true })).rejects.toThrow();
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
    provider.usage.set('*', KITCHEN);
    const res = await f.inject({ method: 'GET', url: '/v1/agents/a1/usage', headers: as });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ totalTokens: 1750, sessions: 3 });
  });

  it('answers an error, not "nothing used", when the read fails (review, 2026-09-29)', async () => {
    const { provider, f } = await world();
    provider.usage.set('*', { code: 3, stdout: '', stderr: 'usage read failed for kitchen: database is locked' });
    const res = await f.inject({ method: 'GET', url: '/v1/agents/a1/usage', headers: as });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/Couldn't read Kitchen's usage.*database is locked/);
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
    const refOf = (slug: string) => store.listAllActiveAgents().find((a) => a.slug === slug)!.runtimeRef!;
    provider.usage.set(refOf('kitchen'), KITCHEN); // 1750
    provider.usage.set(refOf('den'), fakeUsage([{ model: 'claude-opus-4-8', input: 9000, at: 5000 }]));
    const f = Fastify();
    await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
    return { f, provider, store };
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
    // Den: 9000 opus-4-8 INPUT tokens @ $5/1M → exactly $0.045 (the split
    // is known now, so low = high).
    expect(body.agents[0].billing).toBe('api');
    expect(body.agents[0].cost.low).toBeCloseTo(0.045, 4);
    expect(body.agents[0].cost.high).toBeCloseTo(0.045, 4);
    expect(body.agents[0].cost.partial).toBe(false);
    // Fleet cost sums both api agents: 0.045 (Den) + Kitchen's 1500 opus input
    // (0.0075) + 250 sonnet input @ $3 (0.00075).
    expect(body.cost.agents).toBe(2);
    expect(body.cost.low).toBeCloseTo(0.05325, 4);
  });

  it('drops an unreachable container to skipped rather than failing the whole list', async () => {
    const { f, provider, store } = await fleetWorld();
    const den = store.listAllActiveAgents().find((a) => a.slug === 'den')!.runtimeRef!;
    const real = provider.execShell.bind(provider);
    provider.execShell = (async (ref: string, script: string) => {
      if (ref === den) throw new Error('container gone');
      return real(ref, script);
    }) as any;
    const res = await f.inject({ method: 'GET', url: '/v1/usage', headers: as });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agents.map((a: any) => a.name)).toEqual(['Kitchen']); // Den dropped
    expect(body.skipped).toBe(2); // the STOPPED agent + the unreachable one
  });

  it('a read that exits non-zero counts as skipped, not as an idle agent (review, 2026-09-29)', async () => {
    const { f, provider, store } = await fleetWorld();
    provider.usage.set(store.listAllActiveAgents().find((a) => a.slug === 'den')!.runtimeRef!, { code: 3, stdout: '', stderr: 'database is locked' });
    const body = (await f.inject({ method: 'GET', url: '/v1/usage', headers: as })).json();
    expect(body.agents.map((a: any) => a.name)).toEqual(['Kitchen']);
    expect(body.counted).toBe(1);
    expect(body.skipped).toBe(2);
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
    provider.usage.set('*', KITCHEN);
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
    provider.usage.set('*', KITCHEN);
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

describe('the reader script itself (2026-09-28)', () => {
  it('sums real calls from a transcript and skips zero-token mirror copies', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const { USAGE_READER_SCRIPT } = await import('../src/orchestrator/usage.js');
    const root = mkdtempSync(join(tmpdir(), 'hb-usage-'));
    mkdirSync(join(root, 'main', 'sessions'), { recursive: true });
    const at = new Date().toISOString();
    const line = (model: string, usage: object) => JSON.stringify({ type: 'message', timestamp: at, message: { model, usage } });
    writeFileSync(join(root, 'main', 'sessions', 's1.jsonl'), [
      line('claude-sonnet-5', { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 }),
      line('claude-sonnet-5', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
      line('delivery-mirror', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ].join('\n'));
    const script = USAGE_READER_SCRIPT.replace('"/home/node/.openclaw/agents"', JSON.stringify(root));
    const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    expect(Object.keys(out.models)).toEqual(['claude-sonnet-5']);
    expect(out.models['claude-sonnet-5']).toMatchObject({ calls: 2, input: 11, output: 6, cacheRead: 100, cacheWrite: 20, sessions: 1 });
    expect(Object.values(out.slots as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(137);
    // What each call carried in (input + cache), and the last day's calls.
    expect(out.models['claude-sonnet-5'].maxCtx).toBe(130);
    expect(out.lastCtx).toBeGreaterThan(0);
    expect(out.day).toEqual({ calls: 2, tokens: 137 });
  });
});

// A failed SQLite read used to fall back to the .jsonl files silently; on
// 2026.9 those are pre-migration leftovers, so a much smaller total was saved
// as a real reading (review, 2026-09-29).
describe('the reader script and the agent database (review, 2026-09-29)', () => {
  async function runReader(build: (root: string) => void): Promise<{ code: number; out?: any; stderr: string }> {
    const { USAGE_READER_SCRIPT } = await import('../src/orchestrator/usage.js');
    const root = mkdtempSync(join(tmpdir(), 'hb-usage-db-'));
    build(root);
    const script = USAGE_READER_SCRIPT.replace('"/home/node/.openclaw/agents"', JSON.stringify(root));
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    return { code: r.status ?? -1, out: r.status === 0 ? JSON.parse(r.stdout) : undefined, stderr: r.stderr };
  }
  const dirsFor = (root: string, slug: string) => {
    mkdirSync(join(root, slug, 'agent'), { recursive: true });
    mkdirSync(join(root, slug, 'sessions'), { recursive: true });
    return { db: join(root, slug, 'agent', 'openclaw-agent.sqlite'), sessions: join(root, slug, 'sessions') };
  };
  const call = (input: number) => ({ model: 'claude-sonnet-5', usage: { input, output: 0, cacheRead: 0, cacheWrite: 0 } });
  const jsonl = (input: number) => JSON.stringify({ type: 'message', timestamp: new Date().toISOString(), message: call(input) });

  it('2026.9: reads transcript_events and ignores the leftover .jsonl files', async () => {
    const r = await runReader((root) => {
      const p = dirsFor(root, 'kitchen');
      const db = new Database(p.db);
      db.exec('CREATE TABLE transcript_events (session_id TEXT, created_at INTEGER, event_json TEXT, event_zstd BLOB)');
      db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, NULL)').run('s1', Date.now(), JSON.stringify({ message: call(700) }));
      db.close();
      writeFileSync(join(p.sessions, 'old.jsonl.reset.2026-09-01'), jsonl(5));
    });
    expect(r.code).toBe(0);
    expect(r.out.models['claude-sonnet-5']).toMatchObject({ calls: 1, input: 700 });
  });

  it('2026.7: a database without a transcript_events table still reads the .jsonl files', async () => {
    const r = await runReader((root) => {
      const p = dirsFor(root, 'numbers');
      const db = new Database(p.db);
      db.exec('CREATE TABLE memory_chunks (id TEXT)');
      db.close();
      writeFileSync(join(p.sessions, 's1.jsonl'), [jsonl(40), jsonl(2)].join('\n'));
    });
    expect(r.code).toBe(0);
    expect(r.out.models['claude-sonnet-5']).toMatchObject({ calls: 2, input: 42 });
  });

  it('a database that exists but cannot be read fails the read instead of answering from the .jsonl files', async () => {
    const r = await runReader((root) => {
      const p = dirsFor(root, 'kitchen');
      writeFileSync(p.db, 'this is not a database, only bytes that fill a page '.repeat(200));
      writeFileSync(join(p.sessions, 'old.jsonl'), jsonl(5));
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toBeUndefined();
    expect(r.stderr).toMatch(/usage read failed for kitchen/);
  });

  it('the sampler stores no reading when the read fails', async () => {
    const { sampleAgentUsage } = await import('../src/orchestrator/sourceUsage.js');
    const { store, provider } = await world();
    provider.usage.set('*', { code: 3, stdout: '', stderr: 'usage read failed for kitchen: database is locked' });
    await sampleAgentUsage({ store, providerFor: () => provider }, store.getAgent('a1')!);
    expect(store.latestTokenTotal('a1')).toBeUndefined();
  });
});
