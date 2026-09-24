import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';

/** "Rebuild at once": the owner's number, kept in .env, applied to the queue live. */
const OWNER = 'o';
const H = { 'x-hatchabot-owner': OWNER };
async function box() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  const f = Fastify();
  await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', new MockProvider()]]), channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } } } as never);
  return f;
}
afterEach(() => { delete process.env.HATCHABOT_REBUILD_CONCURRENCY; delete process.env.HATCHABOT_ENV_FILE; });

describe('rebuilds at once', () => {
  it('reads the default, takes a whole number from 1 to the max, writes .env, and refuses others', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-conc-'));
    process.env.HATCHABOT_ENV_FILE = join(dir, '.env');
    writeFileSync(process.env.HATCHABOT_ENV_FILE, 'PORT=8080\n');
    const f = await box();
    const g = await f.inject({ method: 'GET', url: '/v1/rebuild-concurrency', headers: H });
    expect(g.json()).toMatchObject({ atOnce: 6, max: 12, queued: 0 });
    const put = await f.inject({ method: 'PUT', url: '/v1/rebuild-concurrency', headers: H, payload: { atOnce: 3 } });
    expect(put.json()).toEqual({ atOnce: 3 });
    expect(readFileSync(join(dir, '.env'), 'utf8')).toContain('HATCHABOT_REBUILD_CONCURRENCY=3');
    expect((await f.inject({ method: 'GET', url: '/v1/rebuild-concurrency', headers: H })).json().atOnce).toBe(3);
    expect((await f.inject({ method: 'GET', url: '/v1/config', headers: H })).json().rebuildConcurrency).toBe(3);
    for (const bad of [0, 13, 2.5, 'six']) expect((await f.inject({ method: 'PUT', url: '/v1/rebuild-concurrency', headers: H, payload: { atOnce: bad } })).statusCode).toBe(400);
    expect((await f.inject({ method: 'PUT', url: '/v1/rebuild-concurrency', headers: { 'x-hatchabot-owner': 'else' }, payload: { atOnce: 2 } })).statusCode).toBe(403);
  });
});
