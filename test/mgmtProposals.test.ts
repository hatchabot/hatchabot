import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/** Proposals live in the database: listed on the home screen, approvable from
 *  anywhere the owner is signed in, gone for everyone else, single-use. */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}
const A = { 'x-hatchabot-owner': 'owner-a' };
const B = { 'x-hatchabot-owner': 'owner-b' };

async function server(db: Database.Database) {
  const store = new Store(db);
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]),
    channel: { pool: { availableCount: () => 0 } } as any,
    mgmtLlmComplete: async () => ({ stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'run_backup', input: {} }] }) as any,
  });
  return { store, f };
}

describe('management proposals', () => {
  it('list, survive a restart, stay private to their owner, and resolve once', async () => {
    const db = new Database(':memory:');
    const one = await server(db);
    for (const o of ['owner-a', 'owner-b']) {
      one.store.insertHost({ id: `h-${o}`, ownerId: o, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
      one.store.insertAIProfile({ id: `p-${o}`, ownerId: o, name: 'Key', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/x', createdAt: 'now' });
    }
    await one.f.inject({ method: 'POST', url: '/v1/mgmt/chat/mode', headers: A, payload: { readWrite: true } });
    // The scripted model keeps proposing; the step cap ends the turn. One card is enough.
    await one.f.inject({ method: 'POST', url: '/v1/mgmt/chat', headers: A, payload: { message: 'back everything up' } });
    const listed = (await one.f.inject({ method: 'GET', url: '/v1/proposals', headers: A })).json();
    expect(listed.pending.length).toBeGreaterThan(0);
    expect(listed.pending[0].summary).toMatch(/Back up every agent/);
    const id = listed.pending[0].confirmId;

    // Another account sees nothing and cannot touch it.
    expect((await one.f.inject({ method: 'GET', url: '/v1/proposals', headers: B })).json().pending).toEqual([]);
    expect((await one.f.inject({ method: 'POST', url: `/v1/proposals/${id}/confirm`, headers: B })).statusCode).toBe(404);

    // "Restart": a new server on the same database still has the card.
    const two = await server(db);
    const after = (await two.f.inject({ method: 'GET', url: '/v1/proposals', headers: A })).json();
    expect(after.pending.map((p: any) => p.confirmId)).toContain(id);

    const ok = await two.f.inject({ method: 'POST', url: `/v1/proposals/${id}/cancel`, headers: A });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().text).toMatch(/Cancelled/);
    expect((await two.f.inject({ method: 'POST', url: `/v1/proposals/${id}/confirm`, headers: A })).statusCode).toBe(409);
    const end = (await two.f.inject({ method: 'GET', url: '/v1/proposals', headers: A })).json();
    expect(end.pending.map((p: any) => p.confirmId)).not.toContain(id);
    expect(end.recent.find((r: any) => r.confirmId === id)?.status).toBe('cancelled');
    expect((await two.f.inject({ method: 'POST', url: `/v1/proposals/${id}/explode`, headers: A })).statusCode).toBe(404);
  });
});
