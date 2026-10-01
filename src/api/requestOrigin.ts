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
 */
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();
/** host[:port] as a URL would print it: lower case, no default port. */
function normHost(h: string | undefined, scheme: string): string | undefined {
  if (!h) return undefined;
  try { return new URL(`${scheme}//${h}`).host.toLowerCase(); } catch { return undefined; }
}

/** Why this browser request is from somewhere else (undefined: it is not). Check state-changing requests and upgrades only. */
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
  try { const pub = env.HATCHABOT_PUBLIC_URL?.trim(); if (pub) mine.push(new URL(pub).host.toLowerCase()); } catch { /* unparsable: not ours */ }
  return mine.includes(theirs) ? undefined : `origin: ${theirs}`;
}

/** Every state-changing request through Fastify. (WebSocket upgrades never reach Fastify: the console proxy calls foreignRequest itself.) */
export function registerOriginCheck(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!UNSAFE.has(req.method)) return;
    const why = foreignRequest(req);
    if (!why) return;
    app.log.warn({ method: req.method, path: req.url.split('?')[0], why }, 'request.foreign_refused');
    return reply.code(403).send({ error: 'This request came from another site, so it was refused. Open Hatchabot at its own address and try again.' });
  });
}
