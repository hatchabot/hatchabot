/*
 * AgentClaw service worker — just enough for an installable, offline-tolerant
 * app shell. Deliberately conservative about caching:
 *   - /v1/* (live, authenticated data) is NEVER cached — always the network.
 *   - navigations are network-first, falling back to the cached shell offline.
 *   - static shell assets (icons, manifest) are cache-first.
 * Bump CACHE to ship a new shell.
 */
const CACHE = 'agentclaw-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // mutations always hit the network
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // third-party: leave alone
  if (url.pathname.startsWith('/v1/')) return; // live data: never cached

  if (req.mode === 'navigate') {
    // Fresh page when online; the cached shell when not.
    e.respondWith(fetch(req).catch(() => caches.match('/')));
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
