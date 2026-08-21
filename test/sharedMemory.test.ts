import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * PATCH /v1/agents/:id { sharedMemory }: the flag must be persisted ONLY after
 * AGENTS.md is rewritten. A failed write must 502 and leave the stored flag
 * unchanged — otherwise the DB and the agent's own file diverge forever (nothing
 * reconciles them). This is the exact regression the ordering was written to fix.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const as = { 'x-agentclaw-owner': OWNER };

async function world(state = 'RUNNING') {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const { runtimeRef } = await provider.provision({
    agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } }, env: {},
  } as any);
  await provider.start(runtimeRef);
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: state as any, aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  store.insertMembership({ id: 'm1', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active' });
  const f = Fastify();
  await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  return { store, provider, f };
}

const patch = (f: any, body: unknown) => f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: as, payload: body });

describe('PATCH sharedMemory', () => {
  it('flips the flag and writes AGENTS.md on success', async () => {
    const { store, provider, f } = await world();
    const res = await patch(f, { sharedMemory: false });
    expect(res.statusCode).toBe(200);
    expect(store.getAgent('a1')!.sharedMemory).toBe(false);
    // The base64 round-trip write was issued.
    expect(provider.execLog.some((c) => c[0] === 'sh' && /base64 -d/.test(c[1] ?? ''))).toBe(true);
  });

  it('502s and leaves the flag UNCHANGED when the AGENTS.md write fails', async () => {
    const { store, provider, f } = await world();
    provider.execResponses.set('sh', { code: 1, stdout: '', stderr: 'disk full' });
    const res = await patch(f, { sharedMemory: false });
    expect(res.statusCode).toBe(502);
    expect(store.getAgent('a1')!.sharedMemory).toBe(true); // not persisted
  });

  it('409s when the agent is not RUNNING', async () => {
    const { store, f } = await world('STOPPED');
    const res = await patch(f, { sharedMemory: false });
    expect(res.statusCode).toBe(409);
    expect(store.getAgent('a1')!.sharedMemory).toBe(true);
  });

  it('400s when the agent has an active non-owner member', async () => {
    const { store, f } = await world();
    store.insertMembership({ id: 'm2', agentId: 'a1', userId: 'someone', role: 'user', status: 'active' });
    const res = await patch(f, { sharedMemory: false });
    expect(res.statusCode).toBe(400);
    expect(store.getAgent('a1')!.sharedMemory).toBe(true);
  });

  it('is atomic: a combined PATCH that 502s on the memory write changes nothing', async () => {
    const { store, provider, f } = await world();
    provider.execResponses.set('sh', { code: 1, stdout: '', stderr: 'disk full' });
    const res = await patch(f, { name: 'Renamed', sharedMemory: false });
    expect(res.statusCode).toBe(502);
    // Neither the name nor the flag was committed — the whole PATCH rolled off.
    expect(store.getAgent('a1')!.name).toBe('Kitchen');
    expect(store.getAgent('a1')!.sharedMemory).toBe(true);
  });
});
