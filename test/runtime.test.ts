import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { parseDistTags } from '../src/openclaw/npmVersion.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const as = { 'x-hatchabot-owner': OWNER };

describe('parseDistTags', () => {
  it('picks latest + extended-stable, ignores beta/alpha, tolerates junk', () => {
    expect(parseDistTags({ latest: '2026.7.1-2', 'extended-stable': '2026.6.34', beta: '2026.8.1-beta.2' }))
      .toEqual({ latest: '2026.7.1-2', extendedStable: '2026.6.34' });
    expect(parseDistTags(null)).toEqual({ latest: undefined, extendedStable: undefined });
    expect(parseDistTags({ latest: 5 })).toEqual({ latest: undefined, extendedStable: undefined });
  });
});

async function world(tags: { latest?: string; extendedStable?: string }) {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider(); // currentImageInfo → openclawVersion 'mock'
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
    openclawDistTags: async () => tags,
  });
  return f;
}

describe('GET /v1/runtime', () => {
  it('reports the image version, npm latest, and no upgrade when they match', async () => {
    const f = await world({ latest: 'mock', extendedStable: '2026.6.34' });
    const res = await f.inject({ method: 'GET', url: '/v1/runtime', headers: as });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      imageVersion: 'mock', npmLatest: 'mock', npmExtendedStable: '2026.6.34', upgradeAvailable: false,
    });
  });

  it('flags upgradeAvailable when npm latest differs from the image', async () => {
    const f = await world({ latest: '2026.9.9' });
    const res = await f.inject({ method: 'GET', url: '/v1/runtime', headers: as });
    expect(res.json()).toMatchObject({ imageVersion: 'mock', npmLatest: '2026.9.9', upgradeAvailable: true });
  });

  it('degrades gracefully when npm is unreachable (empty tags)', async () => {
    const f = await world({});
    const res = await f.inject({ method: 'GET', url: '/v1/runtime', headers: as });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.imageVersion).toBe('mock');
    expect(body.npmLatest).toBeUndefined();
    expect(body.upgradeAvailable).toBe(false);
  });
});
