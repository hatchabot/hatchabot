import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';

/**
 * The agent list carries what the tile's tooltip shows about the runtime: the
 * OpenClaw version, when its process started (uptime), and how often Docker
 * had to start it again since the last rebuild, with how the last run ended
 * (2026-10-07: a new agent's gateway quit with 135, a memory fault, and nothing
 * on screen said so). Made-up data only.
 */
describe('GET /v1/agents runtime facts', () => {
  const OWNER = 'owner-1';
  async function app(info: Record<string, unknown>, state = 'RUNNING') {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'p', ownerId: OWNER, name: 'Plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-sonnet-5', secretRef: 'ai/p', createdAt: 'now' } as never);
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} } as never);
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Helper', slug: 'a1', state, runtimeRef, aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    provider.infoOverride.set(runtimeRef, info as never);
    const f = Fastify();
    await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } } } as never);
    const r = await f.inject({ method: 'GET', url: '/v1/agents', headers: { 'x-hatchabot-owner': OWNER } });
    const body = r.json();
    return (Array.isArray(body) ? body : body.agents)[0];
  }

  it('gives the version, the start time and the restarts with the last exit code', async () => {
    const a = await app({ openclawVersion: '2026.9.6', startedAt: '2026-10-07T19:41:52.000Z', restartCount: 1, lastExitCode: 135 });
    expect(a.openclawVersion).toBe('2026.9.6');
    expect(a.startedAt).toBe('2026-10-07T19:41:52.000Z');
    expect(a.restarts).toBe(1);
    expect(a.lastExitCode).toBe(135);
  });

  it('says nothing about restarts that never happened, and no uptime when it is stopped', async () => {
    const a = await app({ startedAt: '2026-10-07T19:34:03.000Z', restartCount: 0, lastExitCode: 0 });
    expect(a.restarts).toBeUndefined();
    expect(a.lastExitCode).toBeUndefined();
    const s = await app({ startedAt: '2026-10-07T19:34:03.000Z', restartCount: 0 }, 'STOPPED');
    expect(s.startedAt).toBeUndefined();
  });
});
