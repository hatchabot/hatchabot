import { routedPath } from './routedPath.js';
import type { FastifyInstance } from 'fastify';
import type { RequestLike } from './sessionCookie.js';

/**
 * Refuse what a browser sends to this Hatchabot on another site's behalf.
 *
 * The session cookie is SameSite=Strict, which keeps it off requests from
 * other SITES — but a site is the registrable domain, and on a hosted
 * Hatchabot every tenant is <name>.my.hatchabot.com: until that suffix is on
 * the Public Suffix List, a neighbouring tenant's page is the SAME site, and
 * the browser sends this tenant's cookie with its form posts, fetches and
 * WebSockets. So every state-changing request (POST, PUT, PATCH, DELETE) and
 * every WebSocket upgrade (the console proxy) must come from this origin:
 *
 *  - `Sec-Fetch-Site` (every current browser sends it, and a page cannot set
 *    it): `same-origin` and `none` (typed, bookmarked) pass; `same-site` and
 *    `cross-site` are refused. When it is there it decides alone: a reverse
 *    proxy that rewrites Host would otherwise make our own pages look foreign.
 *  - Without it (an older browser), an `Origin` header must name this
 *    machine: the host the browser addressed (Host, or X-Forwarded-Host from
 *    a proxy), or HATCHABOT_PUBLIC_URL's. `Origin: null` (a sandboxed page,
 *    such as a file this app serves sandboxed) is refused.
 *  - Neither header: not a browser (the CLI, a runner, another Hatchabot, an
 *    agent's call, the management agent in-process). Passes; those carry
 *    their own credentials, which a page elsewhere cannot attach.
 *
 * Nothing is exempt. Every request that legitimately arrives from another
 * site is a GET: Google's OAuth callback, a one-time sign-in link from the
 * provider's page. Telegram is polled, Slack is Socket Mode and Discord is
 * its gateway, so no chat service posts to us.
 *
 * Reads too (foreignRead, 2026-10-01). Not every GET here only reads: a
 * Download (/v1/agents/:id/backup) stops the agent, the console proxy wakes a
 * sleeping one and reaches its gateway as the owner, a junk sign-in link is
 * a counted failure, and many reads run docker commands or call Telegram per
 * agent. A neighbour's <img>, link or no-cors fetch could start any of them.
 * So a browser GET or HEAD that says it came from another site is refused
 * too, except:
 *
 *  - the pages people are SENT to by links, and only as a page visit
 *    (Sec-Fetch-Mode navigate, Sec-Fetch-Dest document): the app (/, with a
 *    reset link's ?claim=), an invitation (/join/<code>), a sign-in link from
 *    the provider's page, Google's consent coming back, the legal pages.
 *    Those validate their own codes, and an <img> of one is nobody visiting.
 *  - static public files with no data and no side effect (the PWA shell,
 *    /healthz).
 *
 * Only Sec-Fetch-Site counts for reads: a GET carries no Origin, and a browser
 * without Fetch Metadata (pre-2023 Safari) is not protected here. Every other
 * method (OPTIONS, and anything the console proxy's catch-all accepts) is
 * judged like a write.
 */
const READS = new Set(['GET', 'HEAD']);

/** Where another site may send a browser: a person following a link. */
const LANDINGS: readonly RegExp[] = [
  /^\/$/,
  /^\/join\/[A-Za-z0-9_-]{1,64}$/,
  /^\/signin\/link$/,
  /^\/v1\/connections\/google\/callback$/,
  /^\/(privacy|terms)$/,
];
/** Static, public, no data, no side effect: fine to be fetched from anywhere. */
const PUBLIC_FILES: readonly RegExp[] = [
  /^\/healthz$/,
  /^\/manifest\.webmanifest$/,
  /^\/sw\.js$/,
  /^\/icons\/[a-z0-9-]+\.png$/,
  /^\/app-qr\.svg$/,
];

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();
/** host[:port] as a URL would print it: lower case, no default port. */
function normHost(h: string | undefined, scheme: string): string | undefined {
  if (!h) return undefined;
  try { return new URL(`${scheme}//${h}`).host.toLowerCase(); } catch { return undefined; }
}

/** Why this browser request is from somewhere else (undefined: it is not). For every method but GET/HEAD, and for upgrades (reads: foreignRead). */
export function foreignRequest(req: RequestLike, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const site = first(req.headers['sec-fetch-site'])?.toLowerCase();
  if (site === 'same-origin' || site === 'none') return undefined;
  if (site === 'same-site' || site === 'cross-site') return `sec-fetch-site: ${site}`;
  const origin = first(req.headers.origin);
  if (!origin) return undefined;
  if (origin === 'null') return 'origin: null';
  let o: URL;
  try { o = new URL(origin); } catch { return 'origin: unreadable'; }
  const theirs = o.host.toLowerCase();
  const mine = [first(req.headers.host), first(req.headers['x-forwarded-host'])].map((h) => normHost(h, o.protocol));
  // …and its public address (docs/public-access.md), when it has one.
  for (const name of ['HATCHABOT_PUBLIC_URL', 'HATCHABOT_PUBLIC_ACCESS_URL'] as const) {
    try { const pub = env[name]?.trim(); if (pub) mine.push(new URL(pub).host.toLowerCase()); } catch { /* unparsable: not ours */ }
  }
  return mine.includes(theirs) ? undefined : `origin: ${theirs}`;
}

/**
 * Why this browser GET/HEAD from another site is refused (undefined: it is
 * not refused). `path` is the path alone, without the query.
 */
export function foreignRead(method: string, path: string, headers: RequestLike['headers']): string | undefined {
  if (!READS.has(method.toUpperCase())) return undefined;
  const site = first(headers['sec-fetch-site'])?.toLowerCase();
  if (site !== 'same-site' && site !== 'cross-site') return undefined;
  if (PUBLIC_FILES.some((re) => re.test(path))) return undefined;
  if (LANDINGS.some((re) => re.test(path))) {
    const mode = first(headers['sec-fetch-mode'])?.toLowerCase();
    const dest = first(headers['sec-fetch-dest'])?.toLowerCase();
    if ((!mode || mode === 'navigate') && (!dest || dest === 'document')) return undefined;
    return `sec-fetch-site: ${site}, ${mode ?? '-'}/${dest ?? '-'} (not a page visit)`;
  }
  return `sec-fetch-site: ${site}`;
}

/** Every request through Fastify. (WebSocket upgrades never reach Fastify: the console proxy calls foreignRequest itself.) */
export function registerOriginCheck(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const path = routedPath(req.url) ?? '';
    const why = READS.has(req.method) ? foreignRead(req.method, path, req.headers) : foreignRequest(req);
    if (!why) return;
    app.log.warn({ method: req.method, path, why }, 'request.foreign_refused');
    return reply.code(403).send({ error: 'This request came from another site, so it was refused. Open Hatchabot at its own address and try again.' });
  });
}
