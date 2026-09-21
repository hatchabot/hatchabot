import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
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

const webIndexPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html');

describe('GET /app-qr.svg', () => {
  it('serves an SVG QR of the app URL (public, no auth needed for an <img>)', async () => {
    const store = new Store(new Database(':memory:'));
    const f = Fastify();
    await registerRoutes(f, {
      store,
      secrets: new MemSecrets(),
      providers: new Map([['mock', new MockProvider()]]),
      channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
      webIndexPath,
      publicUrl: 'https://spark.example:8080',
    });
    const res = await f.inject({ method: 'GET', url: '/app-qr.svg' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/svg/);
    expect(res.body).toMatch(/<svg/);
  });
});

describe('browser hardening headers', () => {
  it('forbids framing by other sites, sniffing, and cross-site referrers on every response', async () => {
    const store = new Store(new Database(':memory:'));
    const f = Fastify();
    await registerRoutes(f, {
      store,
      secrets: new MemSecrets(),
      providers: new Map([['mock', new MockProvider()]]),
      channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
      webIndexPath,
    });
    for (const url of ['/', '/healthz', '/v1/config', '/app-qr.svg', '/join/nope']) {
      const res = await f.inject({ method: 'GET', url });
      expect(res.headers['x-frame-options'], url).toBe('SAMEORIGIN');
      expect(res.headers['x-content-type-options'], url).toBe('nosniff');
      expect(res.headers['referrer-policy'], url).toBe('same-origin');
    }
  });
});
