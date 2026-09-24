import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { eventLabel } from '../src/orchestrator/eventLabels.js';
import { parseCgroupMemory } from '../src/providers/provider.js';

/**
 * A container whose process quit on its own and was started again by
 * Docker's restart policy leaves no trace anywhere a person looks (Genetic
 * Algorithm Trading, 2026-09-24: exit 0 a second after a message, nothing in
 * the container log). Hatchabot notices the restart count going up, writes a
 * Setup-log line with the exit code, and flags the agent.
 */
const OWNER = 'user-owner';
const as = { 'x-hatchabot-owner': OWNER };
async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' });
  const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'trader', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} });
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Trader', slug: 'trader', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
  store.setAgentRuntimeRef('a1', runtimeRef); store.setAgentState('a1', 'RUNNING');
  const f = Fastify();
  await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} } as never, providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never });
  const prev = process.env.HATCHABOT_ALLOW_OWNER_HEADER;
  process.env.HATCHABOT_ALLOW_OWNER_HEADER = '1';
  const done = () => { if (prev === undefined) delete process.env.HATCHABOT_ALLOW_OWNER_HEADER; else process.env.HATCHABOT_ALLOW_OWNER_HEADER = prev; };
  return { store, f, provider, runtimeRef, done };
}

describe('a container restarted by Docker on its own', () => {
  it('gets a Setup-log line with the exit code when its restart count goes up, and the list flags it', async () => {
    const { store, f, provider, runtimeRef, done } = await world();
    try {
      provider.infoOverride.set(runtimeRef, { restartCount: 0, lastExitCode: 0, startedAt: '2026-09-24T20:50:27.000Z' });
      let list = (await f.inject({ method: 'GET', url: '/v1/agents', headers: as })).json();
      expect(list[0].selfRestarts).toBeUndefined(); // 0 restarts: nothing to say
      expect(store.listEvents(['a1']).some((e) => e.event === 'runtime.self_restarted')).toBe(false);

      provider.infoOverride.set(runtimeRef, { restartCount: 1, lastExitCode: 0, startedAt: '2026-09-24T21:08:56.000Z' });
      list = (await f.inject({ method: 'GET', url: '/v1/agents', headers: as })).json();
      expect(list[0].selfRestarts).toBe(1);
      const ev = store.listEvents(['a1']).find((e) => e.event === 'runtime.self_restarted');
      expect(ev?.detail).toMatchObject({ count: 1, exitCode: 0, startedAt: '2026-09-24T21:08:56.000Z' });

      // Seen once: the same count again records nothing more.
      await f.inject({ method: 'GET', url: '/v1/agents', headers: as });
      expect(store.listEvents(['a1']).filter((e) => e.event === 'runtime.self_restarted')).toHaveLength(1);

      const log = (await f.inject({ method: 'GET', url: '/v1/agents/a1/events', headers: as })).json();
      expect(log.events[0].label).toMatch(/quit on its own.*exit 0.*Docker started it again.*time 1/);
    } finally { done(); }
  });

  it('a container seen for the first time with restarts already on it is not reported (it happened before we looked)', async () => {
    const { store, f, provider, runtimeRef, done } = await world();
    try {
      provider.infoOverride.set(runtimeRef, { restartCount: 3, lastExitCode: 137 });
      const list = (await f.inject({ method: 'GET', url: '/v1/agents', headers: as })).json();
      expect(list[0].selfRestarts).toBe(3); // still flagged on the card
      expect(store.listEvents(['a1']).some((e) => e.event === 'runtime.self_restarted')).toBe(false);
    } finally { done(); }
  });

  it('says what the exit code means', () => {
    expect(eventLabel('runtime.self_restarted', { count: 2, exitCode: 137 })).toMatch(/killed for memory \(exit 137\).*time 2/);
    expect(eventLabel('runtime.self_restarted', { count: 1, exitCode: 0 })).toMatch(/quit cleanly \(exit 0\) without saying why/);
    expect(eventLabel('runtime.self_restarted', { count: 1 })).toMatch(/exit unknown/);
  });
});

describe('cgroup memory: peak and cap hits', () => {
  it('reads memory.events and memory.peak', () => {
    expect(parseCgroupMemory('low 0\nhigh 0\nmax 1203\noom 0\noom_kill 0\noom_group_kill 0\n', '2147483648\n'))
      .toEqual({ memCapHits: 1203, memOomKills: 0, memPeakBytes: 2147483648 });
  });
  it('says nothing it cannot read', () => {
    expect(parseCgroupMemory(undefined, undefined)).toEqual({});
    expect(parseCgroupMemory('garbage', 'not a number')).toEqual({});
  });
});
