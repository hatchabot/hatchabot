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
const IMMUTABLE = 'public, max-age=31536000, immutable';
type Net = { ok: boolean; redirected?: boolean; body: string; cacheControl?: string } | 'offline';
type Answer = { body?: string; cached?: boolean } | undefined;

/** A page as the server stamps it (src/api/machine/pageRoutes.ts), naming these scripts. */
const pageNaming = (release: string, ...scripts: string[]) =>
  `<!doctype html><title>${release}</title>${scripts.map((s) => `<script src="/app/${s}"></script>`).join('')}`;

/**
 * web/sw.js with one shell cache that keeps what is put in it by address, and
 * a network that answers with `net`. `locks` gives it the browser's locks.
 */
function loadFetching(net: (url: string) => Net, opts: { locks?: { request: (name: string, job: () => Promise<unknown>) => Promise<unknown> } } = {}) {
  const at = (r: string | { url: string }) => new URL(typeof r === 'string' ? r : r.url, ORIGIN).href;
  const store = new Map<string, string>();
  const fetched: string[] = [];
  const handlers: Record<string, (e: unknown) => void> = {};
  const answer = (res: Exclude<Net, 'offline'>) => {
    const headers = { get: (n: string) => (n.toLowerCase() === 'cache-control' ? res.cacheControl ?? null : null) };
    const one = (): Record<string, unknown> => ({ ...res, headers, clone: one, text: async () => res.body });
    return one();
  };
  const fetch = async (r: string | { url: string }) => {
    fetched.push(at(r));
    // The network takes a moment, as a real one does, so updates started together overlap.
    await new Promise((done) => setTimeout(done, 2));
    const res = net(at(r));
    if (res === 'offline') throw new TypeError('Failed to fetch');
    return answer(res);
  };
  // A write takes a moment, as a real one does (one the worker is not kept alive for is not done when the event is),
  // and is in the cache a little before its promise says so: two at once are both in before either hears.
  const put = (r: string | { url: string }, res: { body: string }) => new Promise<void>((done) => setTimeout(() => { store.set(at(r), res.body); setTimeout(done, 1); }, 5));
  const cache = {
    // As a browser's: each address fetched, all of them or none kept.
    addAll: async (urls: string[]) => {
      const got = await Promise.all(urls.map(async (u) => { const res = (await fetch(u)) as { ok: boolean; body: string }; if (!res.ok) throw new TypeError('addAll: ' + u); return [u, res] as const; }));
      for (const [u, res] of got) await put(u, res);
    },
    put,
    match: async (r: string | { url: string }) => (store.has(at(r)) ? { body: store.get(at(r)), cached: true } : undefined),
    keys: async () => [...store.keys()].map((url) => ({ url })),
    delete: async (k: { url: string }) => store.delete(k.url),
  };
  const api = {
    open: async () => cache,
    keys: async () => ['hatchabot-shell-v5'],
    delete: async () => true,
    match: cache.match,
  };
  const self = {
    addEventListener: (t: string, fn: (e: unknown) => void) => { handlers[t] = fn; },
    location: { origin: ORIGIN },
    skipWaiting: async () => {},
    ...(opts.locks ? { navigator: { locks: opts.locks } } : {}),
  };
  runInNewContext(readFileSync('web/sw.js', 'utf8'), { self, caches: api, fetch, URL });
  /** One fetch event: what the worker answered with, once the writes it was kept alive for are done. */
  const get = async (path: string, mode = 'no-cors'): Promise<Answer> => {
    let reply: unknown;
    const writes: Promise<unknown>[] = [];
    handlers.fetch!({ request: { url: ORIGIN + path, method: 'GET', mode }, respondWith: (p: unknown) => { reply = p; }, waitUntil: (p: Promise<unknown>) => { writes.push(p); } });
    const res = (await reply) as Answer;
    await Promise.all(writes);
    return res && { body: res.body, ...(res.cached ? { cached: true } : {}) };
  };
  /** The install event, settled: whether it failed. */
  const install = async () => {
    let wait: Promise<unknown> = Promise.resolve();
    handlers.install!({ waitUntil: (p: Promise<unknown>) => { wait = p; } });
    return wait.then(() => 'installed', () => 'failed');
  };
  /** The scripts kept, by address, and the page kept. */
  const kept = () => ({ page: store.get(ORIGIN + '/'), scripts: [...store.keys()].filter((k) => k.includes('/app/')).map((k) => k.slice(ORIGIN.length)).sort() });
  return { store, fetched, get, install, kept };
}

/** A server of one release: its page names its scripts, each answered as the server answers it (src/api/machine/pageRoutes.ts). */
function server(release: { name: string; page: string; scripts: Record<string, string> }) {
  return (url: string): Net => {
    const u = new URL(url);
    if (u.pathname === '/') return { ok: true, body: release.page };
    if (u.pathname.startsWith('/app/')) {
      const name = u.pathname.slice(5), v = u.searchParams.get('v');
      if (!(name in release.scripts)) return v === null ? { ok: false, body: 'Not found' } : { ok: true, body: 'the stand-in', cacheControl: 'no-store' };
      if (v === release.scripts[name]) return { ok: true, body: `${name} of release ${release.name}`, cacheControl: IMMUTABLE };
      return v === null ? { ok: true, body: `${name} now`, cacheControl: 'no-cache' } : { ok: true, body: 'the stand-in', cacheControl: 'no-store' };
    }
    return { ok: true, body: `file ${u.pathname}` };
  };
}
const releaseA = { name: 'A', page: pageNaming('A', 'core.js?v=core-a', 'home.js?v=home-a'), scripts: { 'core.js': 'core-a', 'home.js': 'home-a' } };
const releaseB = { name: 'B', page: pageNaming('B', 'core.js?v=core-b', 'home.js?v=home-a'), scripts: { 'core.js': 'core-b', 'home.js': 'home-a' } };

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

  it('keeps the page with every script it names, each fetched once, and serves them from there', async () => {
    let net: (url: string) => Net = server(releaseA);
    const w = loadFetching((url) => net(url));
    await w.get('/', 'navigate');
    expect(w.kept()).toEqual({ page: releaseA.page, scripts: ['/app/core.js?v=core-a', '/app/home.js?v=home-a'] });
    await w.get('/', 'navigate');
    expect(w.fetched.filter((u) => u.includes('/app/'))).toHaveLength(2);
    expect(await w.get('/app/core.js?v=core-a')).toEqual({ body: 'core.js of release A', cached: true });
    // The next release's page: its new script is kept, the one it no longer names goes, the one it shares stays.
    net = server(releaseB);
    await w.get('/', 'navigate');
    expect(w.kept()).toEqual({ page: releaseB.page, scripts: ['/app/core.js?v=core-b', '/app/home.js?v=home-a'] });
    expect(w.fetched.filter((u) => u.endsWith('home.js?v=home-a'))).toHaveLength(1);
  });

  it('keeps no script fetched on its own: one asked for without a digest, a failed one, or one a page asked for', async () => {
    const w = loadFetching((url) => (url.includes('missing') ? { ok: false, body: 'Not found' } : { ok: true, body: 'code', cacheControl: IMMUTABLE }));
    await w.get('/app/core.js');
    await w.get('/app/missing.js?v=one');
    await w.get('/app/core.js?v=one');
    expect(w.store.size).toBe(0);
  });

  it('keeps no page whose scripts cannot all be had as it names them, and the page kept before keeps its scripts (HB-0894)', async () => {
    let net: (url: string) => Net = server(releaseA);
    const w = loadFetching((url) => net(url));
    await w.get('/', 'navigate');
    // Release A's page came, then the server moved on to B: A's core.js is a stand-in now, never kept.
    net = (url) => (url.endsWith('/') ? { ok: true, body: pageNaming('A again', 'core.js?v=core-gone') } : server(releaseB)(url));
    expect((await w.get('/', 'navigate'))?.body).toBe(pageNaming('A again', 'core.js?v=core-gone'));
    expect(w.kept()).toEqual({ page: releaseA.page, scripts: ['/app/core.js?v=core-a', '/app/home.js?v=home-a'] });
    expect((await w.get('/app/core.js?v=core-gone'))?.body).toBe('the stand-in');
    await w.get('/app/core.js?v=core-gone');
    expect(w.fetched.filter((u) => u.endsWith('v=core-gone'))).toHaveLength(3);
    // The network gone partway: nothing changes either.
    net = (url) => (url.endsWith('/') ? { ok: true, body: releaseB.page } : 'offline');
    await w.get('/', 'navigate');
    expect(w.kept()).toEqual({ page: releaseA.page, scripts: ['/app/core.js?v=core-a', '/app/home.js?v=home-a'] });
  });

  it('install keeps the page it fetches with that page\'s scripts, so the app opens offline after an upgrade (HB-0909)', async () => {
    // Release A's page loaded and its scripts with it; the server is upgraded to B before the worker installs.
    let net: (url: string) => Net = server(releaseB);
    const w = loadFetching((url) => net(url));
    expect(await w.install()).toBe('installed');
    expect(w.kept()).toEqual({ page: releaseB.page, scripts: ['/app/core.js?v=core-b', '/app/home.js?v=home-a'] });
    expect([...w.store.keys()]).toEqual(expect.arrayContaining([`${ORIGIN}/manifest.webmanifest`, `${ORIGIN}/icons/icon-192.png?v=2`]));
    net = () => 'offline';
    expect((await w.get('/', 'navigate'))?.body).toBe(releaseB.page);
    for (const src of ['/app/core.js?v=core-b', '/app/home.js?v=home-a']) expect((await w.get(src))?.cached, src).toBe(true);
  });

  it('an install that cannot keep the page and all its scripts fails, to be tried again, rather than keep part of it', async () => {
    const w = loadFetching((url) => (url.includes('/app/core.js') ? 'offline' : server(releaseB)(url)));
    expect(await w.install()).toBe('failed');
    expect(w.kept()).toEqual({ page: undefined, scripts: [] });
  });

  it('pages of two releases kept at once leave one release\'s page and its scripts, never a mix (HB-0910)', async () => {
    // Two tabs, one on each release, each loading its page and then its scripts, all at once.
    const both = (url: string): Net => {
      const u = new URL(url);
      if (u.pathname === '/') return { ok: true, body: u.searchParams.has('b') ? releaseB.page : releaseA.page };
      return { ok: true, body: `${u.pathname}${u.search}`, cacheControl: IMMUTABLE };
    };
    for (let round = 0; round < 5; round++) {
      const w = loadFetching(both);
      await Promise.all([
        w.get('/?a', 'navigate'), w.get('/app/core.js?v=core-a'), w.get('/app/home.js?v=home-a'),
        w.get('/?b', 'navigate'), w.get('/app/core.js?v=core-b'), w.get('/app/home.js?v=home-a'),
      ]);
      const { page, scripts } = w.kept();
      expect([releaseA.page, releaseB.page]).toContain(page);
      expect(scripts, String(page)).toEqual(page === releaseA.page ? ['/app/core.js?v=core-a', '/app/home.js?v=home-a'] : ['/app/core.js?v=core-b', '/app/home.js?v=home-a']);
    }
  });

  it('takes the browser\'s lock for each change, so a worker installing beside this one waits its turn (HB-0910)', async () => {
    const names: string[] = [];
    let last: Promise<unknown> = Promise.resolve();
    const locks = { request: (name: string, job: () => Promise<unknown>) => { names.push(name); const run = last.then(job); last = run.catch(() => {}); return run; } };
    const w = loadFetching(server(releaseA), { locks });
    await w.get('/', 'navigate');
    expect(names).toEqual(['hatchabot-shell-v5']);
    expect(w.kept().scripts).toHaveLength(2);
  });
});

describe('the service worker (audit, 2026-10-22)', () => {
  it('on activate deletes only its own older shells, never another page\'s caches on the origin', async () => {
    const { caches, handlers } = load(['agentclaw-shell-v2', 'hatchabot-shell-v3', 'hatchabot-shell-v4', 'hatchabot-shell-v5', 'console-offline', 'other-app-v1']);
    let wait: Promise<unknown> = Promise.resolve();
    handlers.activate!({ waitUntil: (p: Promise<unknown>) => { wait = p; } });
    await wait;
    // v4 too: its worker kept a script under any digest it was asked for (HB-0894).
    expect([...caches].sort()).toEqual(['console-offline', 'hatchabot-shell-v5', 'other-app-v1']);
  });
});
