/**
 * The app page and its scripts (HB-0811).
 *
 * web/index.html is markup and styles; its code is classic scripts in
 * web/app/, loaded in order and sharing one global scope (the map in
 * docs/architecture-map.md says what each holds). The join page
 * (web/join.html) takes its scripts from there too.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';

/** If-None-Match against our ETag, by weak comparison (RFC 9110 13.1.2):
 *  any listed tag, W/ or not, or `*`. */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => t.trim() === '*' || bare(t) === bare(etag));
}

/** A page script's file name: the only shape the route reads from disk. */
export const PAGE_SCRIPT_NAME = /^[a-z0-9-]+\.js$/;
/** A script tag the pages name a page script with: `app/x.js` (the app, relative so the click-through can open it as a file) or `/app/x.js` (the join page, under /join/). */
const SCRIPT_TAG = /<script src="\/?app\/([a-z0-9-]+\.js)"><\/script>/g;

const digestOf = (text: string): string => createHash('sha256').update(text).digest('base64url').slice(0, 22);

/** The scripts in web/app/, each read once and again only when its file changes (an edited checkout shows at once). */
export function pageScripts(webDir: string) {
  const dir = join(webDir, 'app');
  const files = new Map<string, { mtime: number; body: string; digest: string }>();
  const read = (name: string) => {
    if (!PAGE_SCRIPT_NAME.test(name)) return undefined;
    let mtime: number;
    try {
      const st = statSync(join(dir, name));
      if (!st.isFile()) return undefined;
      mtime = st.mtimeMs;
    } catch {
      return undefined;
    }
    const had = files.get(name);
    if (had?.mtime === mtime) return had;
    const body = readFileSync(join(dir, name), 'utf8');
    const one = { mtime, body, digest: digestOf(body) };
    files.set(name, one);
    return one;
  };
  /**
   * A page with each of its scripts named by the bytes it is to run: the
   * script's digest is in its address, so a page and its scripts always come
   * from the same release, and a script can be cached for good.
   */
  const stamp = (html: string): string =>
    html.replace(SCRIPT_TAG, (tag, name: string) => {
      const f = read(name);
      return f ? `<script src="/app/${name}?v=${f.digest}"></script>` : tag;
    });
  return { read, stamp };
}

/** A version as one word: what a semantic version holds, anything else made `_` (it goes in an attribute, a comment and an ETag). */
const versionWord = (version: string): string => version.replace(/[^\w.+-]/g, '_');

/**
 * The running version, written into the page so what is loaded is checkable:
 * a meta tag the page's code reads (web/app/core.js), and the same as the text
 * `HATCHABOT_VERSION="X"`, which is what `hatchabot doctor` (versionMarker in
 * src/doctor.ts) and the deploy and upgrade scripts of every release so far
 * look for in the page to see a deploy took. It was an inline script until
 * HB-0812; the page's policy runs none now.
 */
export function versionMarkup(version: string): string {
  const v = versionWord(version);
  return `<meta name="hatchabot-version" content="${v}"><!-- HATCHABOT_VERSION="${v}" -->`;
}

export interface PageDeps {
  /** No page without it (some tests serve the join page alone); the scripts are served either way. */
  webIndexPath?: string;
  /** The version stamped into the page and its ETag. */
  version: string;
}

/** `/` (with a page) and `/app/:name`. Public: the static shell, no data (the auth hooks let them through; src/api/publicRoutes.ts). */
export function registerPageRoutes(app: FastifyInstance, deps: PageDeps, scripts: ReturnType<typeof pageScripts>): void {
  // With no cache headers the browser was free to keep an old copy, so a
  // shipped fix could sit unused behind a stale tab — indistinguishable from
  // "the fix doesn't work". So the running version is stamped in (what's
  // loaded is checkable) and the browser must revalidate every load. It used
  // to be no-store and a disk read per request: 778 KB each time. Now the
  // stamped page is kept in memory (re-read only when the file or one of its
  // scripts changes, so an edited checkout still shows at once), with an ETag
  // over its bytes: a reload whose copy is current costs a 304, and a deploy —
  // a new version stamped in, so new bytes — never matches an old copy
  // (review, 2026-09-29). Weak, because compression changes the bytes on the
  // wire. The scripts' digests are in the page (stamp), so a change to one is
  // a change to the page's ETag too.
  const pageVersion = deps.version;
  const indexPath = deps.webIndexPath;
  let raw: { mtime: number; html: string } | undefined;
  let page: { html: string; etag: string } | undefined;
  const indexPage = (path: string) => {
    const mtime = statSync(path).mtimeMs;
    if (raw?.mtime !== mtime) {
      raw = { mtime, html: readFileSync(path, 'utf8').replace('</head>', `${versionMarkup(pageVersion)}</head>`) };
      page = undefined;
    }
    const html = scripts.stamp(raw.html);
    if (page?.html !== html) page = { html, etag: `W/"${versionWord(pageVersion)}-${digestOf(html)}"` };
    return page;
  };
  if (indexPath) app.get('/', async (req, reply) => {
    const p = indexPage(indexPath);
    reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-cache')
      .header('etag', p.etag)
      .header('x-hatchabot-version', pageVersion);
    if (etagMatches(req.headers['if-none-match'], p.etag)) return reply.code(304).send();
    return reply.send(p.html);
  });

  // A script, by the address the page was stamped with: that address names
  // its bytes, so it is cached for good. Asked for by any other address (an
  // old page's, or none), it is the current file, revalidated each time.
  app.get<{ Params: { name: string }; Querystring: { v?: string } }>('/app/:name', async (req, reply) => {
    const f = scripts.read(req.params.name);
    if (!f) return reply.code(404).send({ error: 'Not found' });
    const etag = `W/"${f.digest}"`;
    reply
      .type('text/javascript; charset=utf-8')
      .header('cache-control', req.query.v === f.digest ? 'public, max-age=31536000, immutable' : 'no-cache')
      .header('etag', etag);
    if (etagMatches(req.headers['if-none-match'], etag)) return reply.code(304).send();
    return reply.send(f.body);
  });
}

export interface PageFileDeps {
  /** No page files without the page (the folder they are in). */
  webIndexPath?: string;
  /** The address to show (reach/appAddress.ts): what /app-qr.svg encodes. */
  appUrl: () => string | undefined;
}

/**
 * The page's other files (HB-0808 step 15 part B): the PWA manifest and
 * service worker, the privacy policy and terms, the icons, and the app's own
 * address as a QR code. Public, like the page: the static shell, no data
 * (the auth hooks let them through; src/api/publicRoutes.ts).
 */
export function registerPageFiles(app: FastifyInstance, deps: PageFileDeps): void {
  if (!deps.webIndexPath) return;
  const appUrlFor = deps.appUrl;
  // PWA assets so the web app is installable to a phone home screen. Served
  // unauthenticated by design — they're the static shell (no data); the auth
  // hook exempts these exact paths. The service worker never caches /v1/*.
  const webDir = dirname(deps.webIndexPath);
  app.get('/manifest.webmanifest', async (_req, reply) =>
    reply.type('application/manifest+json').send(readFileSync(join(webDir, 'manifest.webmanifest'))),
  );
  app.get('/sw.js', async (_req, reply) =>
    reply
      .header('service-worker-allowed', '/')
      .header('cache-control', 'no-cache')
      .type('text/javascript; charset=utf-8')
      .send(readFileSync(join(webDir, 'sw.js'), 'utf8')),
  );
  // Public privacy policy + terms — required on the authorized domain to
  // publish the Google OAuth consent screen (Gmail is a sensitive scope),
  // and reachable without login by design (no data). Auth hook exempts them.
  for (const page of ['privacy', 'terms'] as const) {
    app.get(`/${page}`, async (_req, reply) => {
      const p = join(webDir, `${page}.html`);
      if (!existsSync(p)) return reply.code(404).send({ error: 'Not found' });
      return reply.type('text/html; charset=utf-8').header('cache-control', 'public, max-age=3600').send(readFileSync(p, 'utf8'));
    });
  }
  app.get<{ Params: { name: string } }>('/icons/:name', async (req, reply) => {
    // Whitelist the filename shape — no path traversal reaches the disk read.
    if (!/^[a-z0-9-]+\.png$/.test(req.params.name)) return reply.code(404).send({ error: 'Not found' });
    const p = join(webDir, 'icons', req.params.name);
    if (!existsSync(p)) return reply.code(404).send({ error: 'Not found' });
    return reply.header('cache-control', 'public, max-age=86400').type('image/png').send(readFileSync(p));
  });
  // A QR of the app's own address, so a phone can scan-to-open it. Public
  // (like the other PWA shell assets) — it encodes only the reachable URL,
  // which just opens the login screen, and an <img> can't carry auth anyway.
  app.get('/app-qr.svg', async (req, reply) => {
    const origin = appUrlFor() || `${req.protocol}://${req.headers.host}`;
    const svg = await QRCode.toString(origin, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return reply.header('cache-control', 'no-cache').type('image/svg+xml').send(svg);
  });
}

/**
 * The join page an invite link opens (GET /join/:code; HB-0808 step 15 part
 * B): web/join.html, its scripts named by their bytes as the app page's are
 * (`scripts.stamp`). Public: the code in its address is the credential, and
 * the page itself holds none (src/api/publicRoutes.ts).
 */
export function registerJoinPage(app: FastifyInstance, deps: { webJoinPath?: string }, scripts: ReturnType<typeof pageScripts> | undefined): void {
  if (deps.webJoinPath) {
    const webJoinPath = deps.webJoinPath;
    app.get('/join/:code', async (_req, reply) => {
      const html = readFileSync(webJoinPath, 'utf8');
      return reply.type('text/html; charset=utf-8').send(scripts ? scripts.stamp(html) : html);
    });
  }
}
