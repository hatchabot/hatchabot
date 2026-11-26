/*
 * Hatchabot service worker — just enough for an installable, offline-tolerant
 * app shell. Deliberately conservative about caching:
 *   - /v1/* (live, authenticated data) is NEVER cached — always the network.
 *   - navigations are network-first, falling back to the cached shell offline.
 *   - static shell assets (icons, manifest) are cache-first.
 *   - the page's scripts (/app/*.js, HB-0811) are cache-first by the address
 *     the page names them with, which carries their digest.
 * The offline shell is the page and every script it names, kept together or
 * not at all (keepShell): at install, and from each load of the page that
 * reaches the network. So a shell offline always has its scripts (HB-0909),
 * and the scripts kept are always the ones that shell names, one release's,
 * however many tabs update it at once (HB-0910).
 * Bump CACHE to ship a new shell.
 */
// Bumped to evict a shell cached before the app was served no-store: an old
// copy of index.html made shipped fixes invisible. `activate` deletes every
// older shell cache of its own, and only those: the agents' consoles share
// this origin and may keep caches of their own (audit, 2026-10-22).
// v5: a v4 worker kept a script under any digest it was asked for, and one
// asked for an older release's digest kept the newer bytes under it (HB-0894).
const CACHE = 'hatchabot-shell-v5';
const STATIC = ['/manifest.webmanifest', '/icons/icon-192.png?v=2'];
const SCRIPT = /^\/app\/[a-z0-9-]+\.js$/;

/** The scripts a page names, as the server stamps them (src/api/machine/pageRoutes.ts, pageScripts): `/app/x.js?v=<digest>`. */
const scriptsOf = (html) => [...html.matchAll(/<script src="(\/app\/[a-z0-9-]+\.js\?v=[\w-]+)"><\/script>/g)].map((m) => m[1]);
/** The bytes of the digest asked for: the server marks those immutable, and answers another digest with a stand-in it marks no-store (HB-0894). */
const exact = (res) => res.ok && /\bimmutable\b/.test(res.headers.get('cache-control') || '');

// One change to the shell at a time: across this worker and one installing
// beside it where the browser has locks, else within this worker.
let lastChange = Promise.resolve();
const oneAtATime = (change) => {
  const locks = self.navigator && self.navigator.locks;
  if (locks) return locks.request(CACHE, change);
  const run = lastChange.then(change);
  lastChange = run.catch(() => {});
  return run;
};

/**
 * Keep `page` (an answer for `/`) as the offline shell with every script it
 * names, or change nothing: a script that cannot be had as the page names it
 * (the network gone, or the server moved on to another release since) leaves
 * the shell kept before, and its scripts, as they were. Then every script the
 * new shell does not name goes.
 */
const keepShell = (page) => oneAtATime(async () => {
  const names = scriptsOf(await page.clone().text());
  const c = await caches.open(CACHE);
  const missing = [];
  for (const name of names) if (!(await c.match(name))) missing.push(name);
  const fetched = await Promise.all(missing.map(async (name) => {
    const res = await fetch(name);
    if (!exact(res)) throw new Error(`${name} is not the script the page names`);
    return [name, res];
  }));
  for (const [name, res] of fetched) await c.put(name, res);
  await c.put('/', page);
  for (const k of await c.keys()) {
    const u = new URL(k.url);
    if (SCRIPT.test(u.pathname) && !names.includes(u.pathname + u.search)) await c.delete(k);
  }
});

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(STATIC))
      .then(() => fetch('/'))
      .then((page) => {
        if (!page.ok || page.redirected) throw new Error('no page to keep');
        return keepShell(page);
      })
      .then(() => self.skipWaiting()),
  );
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
      if (res.ok && !res.redirected && url.pathname === '/') keep(keepShell(res.clone()));
      return res;
    }).catch(() => caches.match('/')));
    return;
  }

  // A script is kept only with the shell that names it (keepShell), never on
  // its own: kept here, one tab's could push out the script another's shell
  // needs, and two at once each pushed out the other's (HB-0910).
  if (SCRIPT.test(url.pathname) && url.searchParams.has('v')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
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
