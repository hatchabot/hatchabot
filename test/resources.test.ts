import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MockProvider } from '../src/providers/mockProvider.js';
import { parseByteSize } from '../src/providers/provider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';

/** Live CPU and memory per agent (docker stats), scoped like everything else. */

describe('parseByteSize', () => {
  it('reads docker\'s units', () => {
    expect(parseByteSize('629.1MiB')).toBe(Math.round(629.1 * 1024 ** 2));
    expect(parseByteSize('1GiB')).toBe(1024 ** 3);
    expect(parseByteSize('2.5GB')).toBe(2.5e9);
    expect(parseByteSize('512kB')).toBe(512e3);
    expect(parseByteSize('0B')).toBe(0);
    expect(parseByteSize('nonsense')).toBe(0);
  });
});

describe('GET /v1/resources', () => {
  async function box() {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
    const provider = new MockProvider();
    const agent = (id: string, ownerId: string, extra: Record<string, unknown> = {}) => store.insertAgent({
      id, ownerId, name: id, slug: id, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: `docker://hatchabot-${id}-1234`,
      persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now', ...extra,
    } as never);
    agent('mine', 'o'); agent('theirs', 'other'); agent('shared-with-me', 'other');
    store.insertMembership({ id: 'm1', agentId: 'shared-with-me', userId: 'o', role: 'user', status: 'active' } as never);
    provider.statsRows = [
      { name: 'hatchabot-mine-1234', cpuPct: 1.5, memBytes: 300e6, memLimitBytes: 2e9, pids: 20, memPeakBytes: 2e9, memCapHits: 1203, memOomKills: 0 },
      { name: 'hatchabot-theirs-1234', cpuPct: 0.5, memBytes: 900e6, memLimitBytes: 2e9, pids: 30 },
      { name: 'hatchabot-shared-with-me-1234', cpuPct: 0.1, memBytes: 100e6, memLimitBytes: 2e9, pids: 10 },
      { name: 'hatchabot-embedder', cpuPct: 0, memBytes: 629e6, memLimitBytes: 1e9, pids: 43 },
      { name: 'hatchabot-embed-door', cpuPct: 0, memBytes: 18e6, memLimitBytes: 128e6, pids: 7 },
      { name: 'hatchabot-doorman-abc', cpuPct: 0, memBytes: 12e6, memLimitBytes: 128e6, pids: 5 },
    ];
    const f = Fastify();
    await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false } } } as never);
    return f;
  }

  it('the machine owner sees every agent and the machine-level containers, with totals', async () => {
    const f = await box();
    const r = (await f.inject({ method: 'GET', url: '/v1/resources', headers: { 'x-hatchabot-owner': 'o' } })).json();
    const h = r.hosts[0];
    expect(h.containers.map((c: any) => c.agentName ?? c.role).sort()).toEqual(['doorman', 'embed-door', 'embedder', 'mine', 'shared-with-me', 'theirs']);
    // Peak and cap hits travel with the row: five 2026.9 agents had hit a 2 GiB cap hundreds of times unseen (2026-09-24).
    expect(h.containers.find((c: any) => c.agentName === 'mine')).toMatchObject({ cpuPct: 1.5, memBytes: 300e6, memLimitBytes: 2e9, role: 'agent', mine: true, memPeakBytes: 2e9, memCapHits: 1203, memOomKills: 0 });
    expect(h.containers.find((c: any) => c.agentName === 'theirs').mine).toBe(false);
    expect(h.totals).toMatchObject({ cpuPct: 2.1, memBytes: 300e6 + 900e6 + 100e6 + 629e6 + 18e6 + 12e6 });
    // Peaks (a row without one counts its current use) and caps add up, against the machine's RAM.
    expect(h.totals.memPeakBytes).toBe(2e9 + 900e6 + 100e6 + 629e6 + 18e6 + 12e6);
    expect(h.totals.memCapBytes).toBe(2e9 * 3 + 1e9 + 128e6 * 2);
    expect(h.totals.machineMemBytes).toBeGreaterThan(0);
  });

  it('another account sees its own and shared agents only — no machine containers, nobody else\'s', async () => {
    const f = await box();
    const r = (await f.inject({ method: 'GET', url: '/v1/resources', headers: { 'x-hatchabot-owner': 'other' } })).json();
    const names = r.hosts[0].containers.map((c: any) => c.agentName ?? c.role).sort();
    expect(names).toEqual(['shared-with-me', 'theirs']); // the local host is everyone's to list; its agents are not
  });
});
