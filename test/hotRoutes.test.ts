import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

const OWNER = 'user-owner';
const H = { 'x-hatchabot-owner': OWNER };

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

/** Fourteen running agents, each with a bot; every container read takes a moment and is counted while it runs. */
async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' } as any);
  for (let i = 0; i < 14; i++) {
    const id = `a${i}`;
    const { runtimeRef } = await provider.provision({ agentId: id, slug: `helper-${i}`, workspace: { files: {}, configPatch: { agentId: `helper-${i}`, authMode: 'api-key' } as any }, env: {} });
    await provider.start(runtimeRef);
    store.insertAgent({ id, ownerId: OWNER, name: `Helper ${i}`, slug: `helper-${i}`, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as any);
    store.insertChannel({ id: `c${i}`, agentId: id, kind: 'telegram', accountId: `HelperBot${i}`, secretRef: `s${i}`, deepLink: `https://t.me/HelperBot${i}`, createdAt: 'now' } as never);
  }
  let now = 0, most = 0, reads = 0;
  const shell = provider.execShell.bind(provider);
  provider.execShell = async (...args: Parameters<MockProvider['execShell']>) => {
    now++; reads++; most = Math.max(most, now);
    try { await new Promise((r) => setTimeout(r, 15)); return await shell(...args); } finally { now--; }
  };
  const f = Fastify();
  await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  return { f, peak: () => most, reads: () => reads, reset: () => { most = 0; reads = 0; } };
}

describe('hot routes read containers six at a time (HB-0058)', () => {
  it('/v1/usage and /v1/pending never have more than six reads in flight', async () => {
    const w = await world();
    const usage = await w.f.inject({ method: 'GET', url: '/v1/usage', headers: H });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().counted).toBe(14);
    expect(w.peak()).toBeLessThanOrEqual(6);
    w.reset();
    const pending = await w.f.inject({ method: 'GET', url: '/v1/pending', headers: H });
    expect(pending.statusCode).toBe(200);
    expect(w.reads()).toBe(14);
    expect(w.peak()).toBeLessThanOrEqual(6);
  });
});
