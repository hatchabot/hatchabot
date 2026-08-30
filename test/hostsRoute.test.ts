import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { hostname } from 'node:os';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

describe('GET /v1/hosts names the local machine concretely', () => {
  it('serves the live hostname for the local host, and not for a runner', async () => {
    const store = new Store(new Database(':memory:'));
    // The stored name is a LABEL written once at first boot; the card wants the
    // machine, which also stays right if the box is later renamed.
    store.insertHost({ id: 'h1', ownerId: 'dev-owner', kind: 'local', provider: 'mock', name: 'This machine (old-name)', settings: {}, createdAt: 'now' });
    store.insertHost({ id: 'h2', ownerId: 'dev-owner', kind: 'cloud', provider: 'mock', name: 'Laptop runner', settings: {}, createdAt: 'now' });
    const app = Fastify();
    await registerRoutes(app, {
      store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]),
      channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
    });
    const rows = JSON.parse((await app.inject({ method: 'GET', url: '/v1/hosts' })).body);
    const local = rows.find((h: any) => h.id === 'h1');
    const runner = rows.find((h: any) => h.id === 'h2');
    expect(local.hostname).toBe(hostname());
    expect(local.name).toBe('This machine (old-name)'); // label untouched
    expect(runner.hostname).toBeUndefined(); // a runner is named by its label
    await app.close();
  });
});
