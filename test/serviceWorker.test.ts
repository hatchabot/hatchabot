import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

/** web/sw.js in a bare context: the caches it holds and the handlers it adds. */
function load(names: string[]) {
  const caches = new Set(names);
  const handlers: Record<string, (e: unknown) => void> = {};
  const self = {
    addEventListener: (t: string, fn: (e: unknown) => void) => { handlers[t] = fn; },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    location: { origin: 'http://localhost:8080' },
  };
  const api = {
    keys: async () => [...caches],
    delete: async (k: string) => caches.delete(k),
    open: async (k: string) => { caches.add(k); return { addAll: async () => {}, put: async () => {} }; },
    match: async () => undefined,
  };
  runInNewContext(readFileSync('web/sw.js', 'utf8'), { self, caches: api, fetch: async () => ({}), URL });
  return { caches, handlers };
}

const ORIGIN = 'http://localhost:8080';
type Net = { ok: boolean; redirected?: boolean; body: string; cacheControl?: string } | 'offline';

/** web/sw.js with one shell cache that keeps what is put in it by address, and a network that answers with `net`. */
function loadFetching(net: (url: string) => Net) {
  const at = (r: string | { url: string }) => new URL(typeof r === 'string' ? r : r.url, ORIGIN).href;
  const store = new Map<string, string>();
  const fetched: string[] = [];
  const handlers: Record<string, (e: unknown) => void> = {};
  const cache = {
    addAll: async () => {},
    // A write takes a moment, as a real one does: one the worker is not kept alive for is not done when the event is.
    put: (r: string | { url: string }, res: { body: string }) => new Promise<void>((done) => setTimeout(() => { store.set(at(r), res.body); done(); }, 5)),
    keys: async () => [...store.keys()].map((url) => ({ url })),
    delete: async (k: { url: string }) => store.delete(k.url),
  };
  const api = {
    open: async () => cache,
    keys: async () => ['hatchabot-shell-v4'],
    delete: async () => true,
    match: async (r: string | { url: string }) => (store.has(at(r)) ? { body: store.get(at(r)), cached: true } : undefined),
  };
  const fetch = async (r: { url: string }) => {
    fetched.push(at(r));
    const res = net(at(r));
    if (res === 'offline') throw new TypeError('Failed to fetch');
    const headers = { get: (n: string) => (n.toLowerCase() === 'cache-control' ? res.cacheControl ?? null : null) };
    return { ...res, headers, clone: () => ({ ...res, headers }) };
  };
  const self = { addEventListener: (t: string, fn: (e: unknown) => void) => { handlers[t] = fn; }, location: { origin: ORIGIN } };
  runInNewContext(readFileSync('web/sw.js', 'utf8'), { self, caches: api, fetch, URL });
  /** One fetch event: what the worker answered with, once the writes it was kept alive for are done. */
  const get = async (path: string, mode = 'no-cors') => {
    let answer: unknown;
    const writes: Promise<unknown>[] = [];
    handlers.fetch!({ request: { url: ORIGIN + path, method: 'GET', mode }, respondWith: (p: unknown) => { answer = p; }, waitUntil: (p: Promise<unknown>) => { writes.push(p); } });
    const res = (await answer) as { body?: string; cached?: boolean } | undefined;
    await Promise.all(writes);
    return res;
  };
  return { store, fetched, get };
}

describe('the service worker and the page\'s scripts (HB-0811)', () => {
  it('keeps the page from each load that reaches the network, but not a redirected one, and falls back to it offline', async () => {
    let net: Net = { ok: true, body: 'page one' };
    const w = loadFetching(() => net);
    expect((await w.get('/', 'navigate'))?.body).toBe('page one');
    expect(w.store.get(ORIGIN + '/')).toBe('page one');
    net = { ok: true, redirected: true, body: 'somewhere else' };
    await w.get('/', 'navigate');
    expect(w.store.get(ORIGIN + '/')).toBe('page one');
    net = 'offline';
    expect(await w.get('/', 'navigate')).toEqual({ body: 'page one', cached: true });
  });

  it('keeps a script by the address the page names it with, one copy of each script', async () => {
    const w = loadFetching((url) => ({ ok: true, body: `code of ${new URL(url).pathname}${new URL(url).search}`, cacheControl: 'public, max-age=31536000, immutable' }));
    await w.get('/app/core.js?v=one');
    await w.get('/app/home.js?v=one');
    expect(await w.get('/app/core.js?v=one')).toEqual({ body: 'code of /app/core.js?v=one', cached: true });
    expect(w.fetched.filter((u) => u.endsWith('/app/core.js?v=one'))).toHaveLength(1);
    await w.get('/app/core.js?v=two');
    expect([...w.store.keys()].sort()).toEqual([`${ORIGIN}/app/core.js?v=two`, `${ORIGIN}/app/home.js?v=one`]);
  });

  it('keeps no script asked for without a digest, nor a failed one', async () => {
    const w = loadFetching((url) => (url.includes('missing') ? { ok: false, body: 'Not found' } : { ok: true, body: 'code', cacheControl: 'public, max-age=31536000, immutable' }));
    await w.get('/app/core.js');
    await w.get('/app/missing.js?v=one');
    expect(w.store.size).toBe(0);
  });

  it('keeps no script the server answered for another digest than the one asked for (HB-0894)', async () => {
    // An older page names release A's digest; the server has moved on and answers with release B's file, not marked immutable.
    const w = loadFetching((url) => (url.endsWith('v=release-a')
      ? { ok: true, body: 'code of release B', cacheControl: 'no-cache' }
      : { ok: true, body: 'code of release B', cacheControl: 'public, max-age=31536000, immutable' }));
    expect((await w.get('/app/core.js?v=release-a'))?.body).toBe('code of release B');
    expect(w.store.size).toBe(0);
    // Asked again, it goes to the server again rather than to a copy kept under the wrong name.
    await w.get('/app/core.js?v=release-a');
    expect(w.fetched.filter((u) => u.endsWith('v=release-a'))).toHaveLength(2);
    await w.get('/app/core.js?v=release-b');
    expect([...w.store.keys()]).toEqual([`${ORIGIN}/app/core.js?v=release-b`]);
  });
});

describe('the service worker (audit, 2026-10-22)', () => {
  it('on activate deletes only its own older shells, never another page\'s caches on the origin', async () => {
    const { caches, handlers } = load(['agentclaw-shell-v2', 'hatchabot-shell-v3', 'hatchabot-shell-v4', 'console-offline', 'other-app-v1']);
    let wait: Promise<unknown> = Promise.resolve();
    handlers.activate!({ waitUntil: (p: Promise<unknown>) => { wait = p; } });
    await wait;
    expect([...caches].sort()).toEqual(['console-offline', 'hatchabot-shell-v4', 'other-app-v1']);
  });
});
