import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store, tokenRise } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { sampleAgentUsage, sampleSourceUsage, summarizeSourceUsage } from '../src/orchestrator/sourceUsage.js';
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
const tokens = (p: MockProvider, n: number) => p.execResponses.set('sessions list', { code: 0, stdout: JSON.stringify({ sessions: [{ totalTokens: n, updatedAt: NOW }] }), stderr: '' });

describe('token counting', () => {
  it('a failed session read writes no sample, so the next good one is not counted as the whole lifetime', async () => {
    const { store, provider, deps } = await world();
    tokens(provider, 5_000_000); await sampleSourceUsage(deps, NOW - 3 * 3_600_000);
    provider.execResponses.set('sessions list', { code: 1, stdout: '', stderr: 'gateway busy' });
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
