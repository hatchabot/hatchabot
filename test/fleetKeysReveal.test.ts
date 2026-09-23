import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';

/** The fleet's Gemini and Brave keys can be shown again — to the machine owner only. */
describe('revealing the fleet keys', () => {
  it('the machine owner sees them; another account does not; an unset key is a 404', async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'owner', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    const map = new Map<string, string>([['media/gemini-api-key', 'gem-secret']]);
    const secrets = { async put(r: string, v: string) { map.set(r, v); }, async get(r: string) { const v = map.get(r); if (v === undefined) throw new Error('missing'); return v; }, async delete(r: string) { map.delete(r); } };
    const f = Fastify();
    await registerRoutes(f, { store, secrets, providers: new Map([['mock', new MockProvider()]]), channel: { kind: 'telegram', pool: { owns: () => false } } } as never);
    expect((await f.inject({ method: 'GET', url: '/v1/media-key/reveal', headers: { 'x-hatchabot-owner': 'owner' } })).json()).toEqual({ key: 'gem-secret' });
    expect((await f.inject({ method: 'GET', url: '/v1/media-key/reveal', headers: { 'x-hatchabot-owner': 'member' } })).statusCode).toBe(403);
    expect((await f.inject({ method: 'GET', url: '/v1/search-key/reveal', headers: { 'x-hatchabot-owner': 'owner' } })).statusCode).toBe(404);
  });
});
