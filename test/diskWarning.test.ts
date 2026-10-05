import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * 2026-09-30: an agent over HATCHABOT_AGENT_DISK_WARN_GB, as measured by the
 * daily sweep, reaches the owner's agent list (the page's Alerts reason).
 */
class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';

describe('disk warning on the agent list', () => {
  it('the owner sees diskOver for an agent past the warning; not for one under it; a member never', async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'ai/p1', createdAt: 'now' });
    for (const id of ['big', 'small']) {
      store.insertAgent({ id, ownerId: OWNER, name: id, slug: id, state: 'STOPPED', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
    }
    store.insertMembership({ id: 'm1', agentId: 'big', userId: 'user-guest', role: 'user', status: 'active' } as any);
    store.setAgentDiskBytes('big', 15e9, '2026-09-30T03:00:00.000Z');
    store.setAgentDiskBytes('small', 1e9);
    const f = Fastify();
    await registerRoutes(f, {
      store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]),
      channel: { pool: { availableCount: () => 0, owns: () => false }, release: async () => {} } as any,
    });
    const list = (await f.inject({ method: 'GET', url: '/v1/agents', headers: { 'x-hatchabot-owner': OWNER } })).json() as Array<Record<string, any>>;
    expect(list.find((a) => a.id === 'big')!.diskOver).toEqual({ bytes: 15e9, warnBytes: 10e9, measuredAt: '2026-09-30T03:00:00.000Z' });
    expect(list.find((a) => a.id === 'small')!.diskOver).toBeUndefined();
    const guest = (await f.inject({ method: 'GET', url: '/v1/agents', headers: { 'x-hatchabot-owner': 'user-guest' } })).json() as Array<Record<string, any>>;
    const seen = guest.find((a) => a.id === 'big');
    expect(seen).toBeDefined();
    expect(seen!.diskOver).toBeUndefined();
  });
});
