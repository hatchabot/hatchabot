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

  it('a removal the secret store refuses is said, and the key stays shown as set (HB-0918)', async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'owner', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    const map = new Map<string, string>([['media/gemini-api-key', 'gem-secret'], ['media/brave-api-key', 'brave-secret']]);
    let refuse = true;
    const secrets = {
      async put(r: string, v: string) { map.set(r, v); },
      async get(r: string) { const v = map.get(r); if (v === undefined) throw new Error('missing'); return v; },
      async delete(r: string) { if (refuse) throw Object.assign(new Error('attempt to write a readonly database'), { code: 'SQLITE_READONLY' }); map.delete(r); },
    };
    const f = Fastify();
    await registerRoutes(f, { store, secrets, providers: new Map([['mock', new MockProvider()]]), channel: { kind: 'telegram', pool: { owns: () => false } } } as never);
    const owner = { 'x-hatchabot-owner': 'owner' };
    for (const [url, words] of [['/v1/media-key', /shared Gemini key/], ['/v1/search-key', /fleet search key/]] as const) {
      const res = await f.inject({ method: 'DELETE', url, headers: owner });
      expect(res.statusCode, url).toBe(500);
      expect(res.json().error).toMatch(words);
      expect(res.json().error).toMatch(/readonly database.*still set: try again/);
      expect((await f.inject({ method: 'GET', url, headers: owner })).json()).toEqual({ set: true });
    }
    expect((await f.inject({ method: 'GET', url: '/v1/media-key/reveal', headers: owner })).json()).toEqual({ key: 'gem-secret' });
    // The store writes again: removed, and said so.
    refuse = false;
    for (const url of ['/v1/media-key', '/v1/search-key']) {
      expect((await f.inject({ method: 'DELETE', url, headers: owner })).json()).toEqual({ set: false });
      expect((await f.inject({ method: 'GET', url, headers: owner })).json()).toEqual({ set: false });
    }
  });
});
