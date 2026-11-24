/*
 * Hatchabot service worker — just enough for an installable, offline-tolerant
 * app shell. Deliberately conservative about caching:
 *   - /v1/* (live, authenticated data) is NEVER cached — always the network.
 *   - navigations are network-first, falling back to the cached shell offline.
 *   - static shell assets (icons, manifest) are cache-first.
 *   - the page's scripts (/app/*.js, HB-0811) are cache-first by the address
 *     the page names them with, which carries their digest; one copy of each
 *     is kept, and only bytes the server said are that digest's. The page
 *     itself is cached afresh on every load that reaches the network, so the
 *     shell offline is a page whose scripts are kept.
 * Bump CACHE to ship a new shell.
 */
// Bumped to evict a shell cached before the app was served no-store: an old
// copy of index.html made shipped fixes invisible. `activate` deletes every
// older shell cache of its own, and only those: the agents' consoles share
// this origin and may keep caches of their own (audit, 2026-10-22).
const CACHE = 'hatchabot-shell-v4';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png?v=2'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => /^(hatchabot|agentclaw)-shell-/.test(k) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // mutations always hit the network
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // third-party: leave alone
  if (url.pathname.startsWith('/v1/')) return; // live data: never cached

  // A cache write the worker is kept alive for; one that fails costs only the offline copy.
  const keep = (write) => e.waitUntil(write.catch(() => {}));

  if (req.mode === 'navigate') {
    // Fresh page when online; the cached shell when not. A redirected
    // response is not kept: a browser refuses one from the cache for a page.
    e.respondWith(fetch(req).then((res) => {
      if (res.ok && !res.redirected && url.pathname === '/') { const copy = res.clone(); keep(caches.open(CACHE).then((c) => c.put('/', copy))); }
      return res;
    }).catch(() => caches.match('/')));
    return;
  }

  if (/^\/app\/[a-z0-9-]+\.js$/.test(url.pathname) && url.searchParams.has('v')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      // Kept only when the server answered with the bytes the digest names
      // (it marks those immutable). Asked for an older release's digest, it
      // answers with the current file, marked no-cache: kept, those bytes sat
      // under the older digest for good (HB-0894).
      if (res.ok && /\bimmutable\b/.test(res.headers.get('cache-control') || '')) {
        const copy = res.clone();
        keep(caches.open(CACHE).then(async (c) => {
          await c.put(req, copy);
          // The copy an older page named goes: one of each script is kept.
          for (const k of await c.keys()) {
            const u = new URL(k.url);
            if (u.pathname === url.pathname && u.search !== url.search) await c.delete(k);
          }
        }));
      }
      return res;
    })));
    return;
  }

  // Shell assets: serve cached, else fetch and cache the static ones.
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
