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

let fleetNo = 0;
async function fleet(n: number, env: Record<string, string> = {}) {
  // Ids unique per world: the busy flag is process-wide, and a previous
  // world's rebuilds may still hold it when the next test starts.
  const tag = ++fleetNo;
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
    const id = `rq-${tag}-${i}`;
    ids.push(id);
    store.insertAgent({
      id, ownerId: OWNER, name: `A${i}`, slug: id, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: `docker://${id}`,
      persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now',
    } as never);
  }
  return { store, f, ids, provider, peak: () => peak, releaseAll: () => release.splice(0).forEach((r) => r()) };
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

  it('keeps checkpoint turns few, whatever the general limit is — and frees their slot once the turn ends', async () => {
    const w = await fleet(6, { HATCHABOT_REBUILD_CONCURRENCY: '6', HATCHABOT_CHECKPOINT_CONCURRENCY: '2' });
    // Hold every checkpoint turn open too, and count them.
    let turns = 0, turnPeak = 0;
    const turnRelease: Array<() => void> = [];
    const realExec = w.provider.exec.bind(w.provider);
    vi.spyOn(w.provider, 'exec').mockImplementation(async (ref: string, argv: string[], o?: { timeoutMs?: number }) => {
      if (argv[0] !== 'agent') return realExec(ref, argv, o);
      turns++; turnPeak = Math.max(turnPeak, turns);
      await new Promise<void>((r) => turnRelease.push(() => { turns--; r(); }));
      return { code: 0, stdout: '', stderr: '' };
    });
    try {
      for (const id of w.ids) expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/rebuild`, headers: H, payload: { checkpoint: true } })).statusCode).toBe(202);
      await new Promise((r) => setTimeout(r, 100));
      expect(turnPeak).toBe(2); // the AI source is the scarce thing here
      expect(w.peak()).toBe(0);  // nothing past its checkpoint yet
      for (let i = 0; i < 6 && w.peak() < 6; i++) {
        turnRelease.splice(0).forEach((r) => r());
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(turnPeak).toBe(2);
      expect(w.peak()).toBe(6); // all six rebuild at once once their checkpoints are done
    } finally {
      w.releaseAll();
      delete process.env.HATCHABOT_REBUILD_CONCURRENCY;
      delete process.env.HATCHABOT_CHECKPOINT_CONCURRENCY;
    }
  });

  it('a rebuild that waited its turn is skipped if the agent was stopped or moved meanwhile (night review)', async () => {
    const w = await fleet(3, { HATCHABOT_REBUILD_CONCURRENCY: '1' });
    try {
      for (const id of w.ids) expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/rebuild`, headers: H, payload: {} })).statusCode).toBe(202);
      await new Promise((r) => setTimeout(r, 50));
      expect(w.peak()).toBe(1);
      const [, stopped, moved] = w.ids as [string, string, string];
      w.store['db'].prepare(`UPDATE agents SET state = 'STOPPED' WHERE id = ?`).run(stopped);
      w.store.setAgentMigratedTo(moved, 'Desktop (2026-09-28)');
      for (let i = 0; i < 4; i++) { w.releaseAll(); await new Promise((r) => setTimeout(r, 80)); }
      expect(w.peak()).toBe(1);
      const why = w.store.listEvents([stopped, moved]).filter((e) => e.event === 'rebuild.skipped').map((e) => (e.detail as { why?: string }).why);
      expect(why.sort()).toEqual(['moved to another Hatchabot', 'stopped by its owner']);
      expect(w.store.getAgent(stopped)!.state).toBe('STOPPED');
    } finally {
      w.releaseAll();
      delete process.env.HATCHABOT_REBUILD_CONCURRENCY;
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
