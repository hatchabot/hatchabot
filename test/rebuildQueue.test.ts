import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';

/**
 * Rebuilding the fleet is a queue: several at a time, and the ones waiting say
 * so instead of spinning silently. A rebuild that checkpoints first makes an AI
 * call, so those stay few whatever the general limit is.
 */

const OWNER = 'o';
const H = { 'x-hatchabot-owner': OWNER };

async function fleet(n: number, env: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
  const provider = new MockProvider();
  // Hold every rebuild open so the test can see how many run at once.
  let running = 0;
  let peak = 0;
  const release: Array<() => void> = [];
  vi.spyOn(provider, 'provision').mockImplementation(async (spec) => {
    running++; peak = Math.max(peak, running);
    await new Promise<void>((r) => release.push(() => { running--; r(); }));
    return { runtimeRef: `docker://${spec.agentId}` };
  });
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} },
    providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false } },
  } as never);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `rq-${i}`;
    ids.push(id);
    store.insertAgent({
      id, ownerId: OWNER, name: `A${i}`, slug: id, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: `docker://${id}`,
      persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now',
    } as never);
  }
  return { store, f, ids, peak: () => peak, releaseAll: () => release.splice(0).forEach((r) => r()) };
}

describe('rebuilding the fleet', () => {
  it('runs several at a time, and the rest wait their turn visibly', async () => {
    const w = await fleet(8, { HATCHABOT_REBUILD_CONCURRENCY: '3' });
    try {
      for (const id of w.ids) await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/rebuild`, headers: H, payload: {} });
      await new Promise((r) => setTimeout(r, 100));
      expect(w.peak()).toBe(3);                       // three at a time, not one, not all eight
      const list = (await w.f.inject({ method: 'GET', url: '/v1/agents', headers: H })).json() as Array<{ queuedForRebuild?: boolean }>;
      expect(list.filter((a) => a.queuedForRebuild).length).toBe(5); // the rest say they are waiting
    } finally {
      w.releaseAll();
      delete process.env.HATCHABOT_REBUILD_CONCURRENCY;
    }
  });

  it('keeps checkpointing rebuilds few, whatever the general limit is', async () => {
    const w = await fleet(6, { HATCHABOT_REBUILD_CONCURRENCY: '6', HATCHABOT_CHECKPOINT_CONCURRENCY: '2' });
    try {
      for (const id of w.ids) await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/rebuild`, headers: H, payload: { checkpoint: true } });
      await new Promise((r) => setTimeout(r, 100));
      expect(w.peak()).toBe(2); // the AI source is the scarce thing here
    } finally {
      w.releaseAll();
      delete process.env.HATCHABOT_REBUILD_CONCURRENCY;
      delete process.env.HATCHABOT_CHECKPOINT_CONCURRENCY;
    }
  });

  it('tells the app how many run at once, so it can estimate', async () => {
    const w = await fleet(1, { HATCHABOT_REBUILD_CONCURRENCY: '6' });
    try {
      const cfg = (await w.f.inject({ method: 'GET', url: '/v1/config' })).json();
      expect(cfg.rebuildConcurrency).toBe(6);
    } finally {
      w.releaseAll();
      delete process.env.HATCHABOT_REBUILD_CONCURRENCY;
    }
  });
});
