import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store, tokenRise } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { sampleAgentUsage, sampleSourceUsage, summarizeSourceUsage } from '../src/orchestrator/sourceUsage.js';
import { totalOf } from './helpers/usageFake.js';
import { runPostureSweep } from '../src/orchestrator/posture.js';

// Night review, 2026-09-27: usage, limits and sweeps.

const OWNER = 'user-o';
const NOW = Date.parse('2026-09-15T18:00:00Z');

async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  for (const id of ['A', 'B']) {
    store.insertAIProfile({ id, ownerId: OWNER, name: `Source ${id}`, vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', secretRef: `ai/${id}`, createdAt: 'now' } as any);
  }
  const { runtimeRef } = await provider.provision({ agentId: 'x', slug: 'x', workspace: { files: {}, configPatch: { agentId: 'x', authMode: 'api-key' } as any }, env: {} });
  await provider.start(runtimeRef);
  store.insertAgent({ id: 'x', ownerId: OWNER, name: 'X', slug: 'x', state: 'PROVISIONING', aiProfileId: 'A', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
  store.setAgentRuntimeRef('x', runtimeRef);
  store.setAgentState('x', 'RUNNING');
  return { store, provider, deps: { store, providerFor: () => provider } };
}
const line = (at: string, status: number) => `${at} [model-fetch] response provider=anthropic model=claude-opus-4-8 status=${status} elapsedMs=10`;
const tokens = (p: MockProvider, n: number) => p.usage.set('*', totalOf(n));

describe('token counting', () => {
  it('a failed session read writes no sample, so the next good one is not counted as the whole lifetime', async () => {
    const { store, provider, deps } = await world();
    tokens(provider, 5_000_000); await sampleSourceUsage(deps, NOW - 3 * 3_600_000);
    provider.usage.set('*', { code: 1, stdout: '', stderr: 'gateway busy' });
    await sampleSourceUsage(deps, NOW - 2 * 3_600_000);
    tokens(provider, 5_000_100); await sampleSourceUsage(deps, NOW - 1 * 3_600_000);
    expect(summarizeSourceUsage(store, OWNER, NOW).find((s) => s.id === 'A')!.window5h.tokens).toBe(100);
  });
  it('a drop in the summed counter counts nothing', () => {
    expect(tokenRise(1000, 1500)).toBe(500);
    expect(tokenRise(5_000_000, 200)).toBe(0);
  });
  it('the per-agent sample is exported for a rebuild to take before the container goes', async () => {
    const { store, provider, deps } = await world();
    provider.modelCallLines = line('2026-09-15T17:58:00.000Z', 429);
    tokens(provider, 42);
    const r = await sampleAgentUsage(deps, store.getAgent('x')!, NOW);
    expect(r).toEqual({ calls: 1, limited: 1 });
    expect(store.latestTokenTotal('x')).toBe(42);
  });
});

describe('rate-limited follows the source that refused', () => {
  it('an agent switched away after a 429 leaves the old source limited and the new one clear', async () => {
    const { store, provider, deps } = await world();
    provider.modelCallLines = line('2026-09-15T17:30:00.000Z', 429);
    tokens(provider, 10);
    await sampleSourceUsage(deps, NOW - 20 * 60_000);
    store.setAgentAIProfile('x', 'B');
    const view = summarizeSourceUsage(store, OWNER, NOW);
    expect(view.find((s) => s.id === 'A')!.status).toBe('limited');
    expect(view.find((s) => s.id === 'B')!.status).not.toBe('limited');
  });
});

describe('the day\'s own use is kept beside the lifetime total', () => {
  it('is never lowered by a later, smaller count', () => {
    const store = new Store(new Database(':memory:'));
    store.upsertUsageSnapshot(OWNER, { day: '2026-09-15', totalTokens: 3_000_000, byBilling: {} });
    store.setUsageUsed(OWNER, '2026-09-15', 1200);
    store.setUsageUsed(OWNER, '2026-09-15', 800);
    expect(store.listUsageSnapshots(OWNER)[0]!.usedTokens).toBe(1200);
  });
});

describe('the posture sweep', () => {
  it('does not log the same change again after a restart the same day', async () => {
    const { store } = await world();
    const logged: string[] = [];
    const log = (e: string) => { logged.push(e); };
    runPostureSweep(store, { authMode: 'password', log });
    const first = logged.length;
    expect(first).toBeGreaterThan(0); // the first sweep of the day reports what it found
    runPostureSweep(store, { authMode: 'password', log });
    expect(logged.length).toBe(first);
  });
});

describe('a zero reading between two real ones (2026-09-28)', () => {
  it('does not turn the agent\'s whole history into new use', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { Store } = await import('../src/store/store.js');
    const store = new Store(new Database(':memory:'));
    store.addTokenSample('a1', 'p1', '2026-09-27T02:48:00.000Z', 72391);
    store.addTokenSample('a1', 'p1', '2026-09-27T02:58:00.000Z', 0);      // caught mid-stop
    store.addTokenSample('a1', 'p1', '2026-09-28T13:32:00.000Z', 72391);  // woke, same total
    store.addTokenSample('a1', 'p1', '2026-09-28T14:00:00.000Z', 72891);  // 500 real
    const ids = new Set(['a1']);
    expect(store.tokenDeltas(ids, '2026-09-28T00:00:00.000Z').reduce((s, d) => s + d.delta, 0)).toBe(500);
    expect(store.tokenIncreasesByAgent('p1', '2026-09-28T00:00:00.000Z', ids).get('a1') ?? 0).toBe(500);
    // A new agent's real start from zero still counts.
    store.addTokenSample('b1', 'p1', '2026-09-28T10:00:00.000Z', 0);
    store.addTokenSample('b1', 'p1', '2026-09-28T11:00:00.000Z', 1200);
    expect(store.tokenIncreasesByAgent('p1', '2026-09-28T00:00:00.000Z', new Set(['b1'])).get('b1')).toBe(1200);
  });
});

describe('real usage, backfilled (2026-09-28)', () => {
  it('an agent\'s first reading writes its last days, so a day window shows the day\'s calls at once', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { Store } = await import('../src/store/store.js');
    const { MockProvider } = await import('../src/providers/mockProvider.js');
    const { sampleAgentUsage } = await import('../src/orchestrator/sourceUsage.js');
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'k', workspace: { files: {}, configPatch: { agentId: 'k', authMode: 'api-key' } }, env: {} } as never);
    const now = Date.parse('2026-09-28T12:00:00.000Z');
    // 5,000,000 tokens over the agent's life; 30,000 of them in the last two hours.
    provider.usage.set(runtimeRef, { models: { m: { calls: 3, input: 5_000_000, output: 0, cacheRead: 0, cacheWrite: 0, sessions: 1 } }, sessions: 1, first: 1, last: now - 60_000,
      slots: { '2026-09-28T10:05:00.000Z': 10_000, '2026-09-28T11:30:00.000Z': 20_000 } });
    await sampleAgentUsage({ store, providerFor: () => provider } as never, { id: 'a1', hostId: 'h1', aiProfileId: 'p1', runtimeRef, slug: 'k' } as never, now);
    expect(store.tokenIncreasesByAgent('p1', '2026-09-28T09:00:00.000Z', new Set(['a1'])).get('a1')).toBe(30_000);
    expect(store.tokenIncreasesByAgent('p1', '2026-09-28T11:00:00.000Z', new Set(['a1'])).get('a1')).toBe(20_000);
    // Each slot's rise is bounded by its own five minutes, so a chart that
    // spreads a rise between readings keeps it there (review, 2026-09-29).
    expect(store.tokenDeltas(new Set(['a1']), '2026-09-28T09:00:00.000Z').map((d) => [d.prevAt, d.at, d.delta])).toEqual([
      ['2026-09-28T10:00:00.000Z', '2026-09-28T10:05:00.000Z', 10_000],
      ['2026-09-28T11:25:00.000Z', '2026-09-28T11:30:00.000Z', 20_000],
    ]);
  });
  it('a reading stores the agent\'s price per token from its own mix of input, output and cache', async () => {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({ agentId: 'a2', slug: 'r', workspace: { files: {}, configPatch: { agentId: 'r', authMode: 'api-key' } }, env: {} } as never);
    const { fakeUsage } = await import('./helpers/usageFake.js');
    // 1M cache reads on Opus ($5 in): $0.50, i.e. $0.50 per million.
    provider.usage.set(runtimeRef, fakeUsage([{ model: 'claude-opus-4-8', cacheRead: 1_000_000, at: 1 }]));
    await sampleAgentUsage({ store, providerFor: () => provider } as never, { id: 'a2', hostId: 'h1', aiProfileId: 'p1', runtimeRef, slug: 'r' } as never, NOW);
    expect(store.agentTokenRate('a2')!.usdPerToken * 1e6).toBeCloseTo(0.5, 9);
  });
  it('context-size samples from before the switch are dropped once', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { Store } = await import('../src/store/store.js');
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE token_samples (agent_id TEXT NOT NULL, profile_id TEXT, at TEXT NOT NULL, total INTEGER NOT NULL, PRIMARY KEY (agent_id, at))`);
    db.prepare(`INSERT INTO token_samples VALUES ('a1','p1','2026-09-28T00:00:00.000Z', 246000)`).run();
    const store = new Store(db);
    expect(store.latestTokenTotal('a1')).toBeUndefined();
    expect(store.listUsageSnapshots('o1', 30)).toHaveLength(0);
    store.addTokenSample('a1', 'p1', '2026-09-28T01:00:00.000Z', 10);
    store.upsertUsageSnapshot('o1', { day: '2026-09-28', totalTokens: 10, byBilling: {} });
    new Store(db); // a restart: nothing dropped again
    expect(store.latestTokenTotal('a1')).toBe(10);
    expect(store.listUsageSnapshots('o1', 30)).toHaveLength(1);
  });
});
