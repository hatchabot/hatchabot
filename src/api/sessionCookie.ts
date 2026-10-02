import type { FastifyReply, FastifyRequest } from 'fastify';
import { isPublic } from './trust.js';

/**
 * The browser session cookie, in every sign-in mode (auth.ts, accountsAuth.ts).
 *
 * Over HTTPS it is `__Host-hatchabot_session`. The prefix makes the browser
 * refuse the cookie unless it is Secure, Path=/ and has no Domain, so it can
 * only ever have been set by this exact host. That matters on a hosted
 * Hatchabot: every tenant is <name>.my.hatchabot.com, and until that suffix is
 * on the Public Suffix List each tenant is SAME-SITE with every other. A
 * neighbour's page can set a cookie for Domain=.my.hatchabot.com (or
 * hatchabot.com), and SameSite does nothing about it: a plain-named cookie
 * from there either signs the visitor in as the neighbour's chosen account
 * (fixation) or, with a longer Path, shadows the real one and signs them out.
 * A `__Host-` cookie cannot be planted that way.
 *
 * Over plain HTTP (a home LAN) the prefix is impossible (it needs Secure), so
 * the name stays `hatchabot_session`.
 *
 * Reading: a `__Host-` cookie, when the request has one, is the only one
 * looked at. Otherwise the plain name is accepted, except over HTTPS on a
 * hosted install (HATCHABOT_MANAGED_BY): that is exactly the cookie a
 * neighbour can plant, and a hosted install never handed one out over HTTPS
 * that is worth keeping. On a home install over HTTPS (Tailscale, a TLS
 * proxy) a plain cookie from before this change still works, and the first
 * request that shows it is answered with the same value under the new name
 * (and the plain one cleared), so nobody is signed out by the upgrade.
 */
export const SESSION_COOKIE = 'hatchabot_session';
export const HOST_SESSION_COOKIE = '__Host-hatchabot_session';
/** Set by pre-rename servers; cleared on logout, never read. */
const LEGACY_RENAME_COOKIE = 'agentclaw_session';

/** What a request looks like to these helpers: Fastify's, or a raw upgrade request. */
export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  protocol?: string;
  /** A TLS socket says `encrypted: true`. */
  socket?: object | null;
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();

/**
 * Did the browser reach us over HTTPS — directly, through a terminating proxy
 * that says so (X-Forwarded-Proto), or at the https HATCHABOT_PUBLIC_URL's own
 * host (a proxy that terminates TLS for that name without saying so)? A wrong
 * "yes" only costs that client its sign-in (the browser drops a Secure
 * cookie over http), never anyone else's.
 */
export function requestIsHttps(req: RequestLike, env: NodeJS.ProcessEnv = process.env): boolean {
  // The public listener is only ever reached through Funnel, which is HTTPS
  // and nothing else: decided by the connection, not by a header a stranger
  // could leave out to be handed a cookie without Secure and __Host-.
  if (isPublic(req)) return true;
  const proto = first(req.headers['x-forwarded-proto']);
  if (proto) return proto.toLowerCase() === 'https';
  if (req.protocol === 'https' || (req.socket as { encrypted?: boolean } | null | undefined)?.encrypted) return true;
  const pub = env.HATCHABOT_PUBLIC_URL?.trim();
  if (!pub) return false;
  try {
    const u = new URL(pub);
    const host = (first(req.headers['x-forwarded-host']) ?? first(req.headers.host) ?? '').toLowerCase();
    return u.protocol === 'https:' && !!host && host === u.host.toLowerCase();
  } catch {
    return false;
  }
}

const managed = (env: NodeJS.ProcessEnv) => !!env.HATCHABOT_MANAGED_BY?.trim();

/** One cookie's value from a raw `Cookie:` header (the first of that name). */
export function cookieFromHeader(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return part.slice(eq + 1).trim(); }
  }
  return undefined;
}

/**
 * The session cookie this request carries, by the rules above, and whether it
 * came under the plain name over HTTPS (a cookie to move to the new name).
 */
export function readSessionCookie(
  cookieHeader: string | undefined, https: boolean, env: NodeJS.ProcessEnv = process.env,
): { value: string; plainOverHttps: boolean } | undefined {
  const host = cookieFromHeader(cookieHeader, HOST_SESSION_COOKIE);
  if (host !== undefined) return host ? { value: host, plainOverHttps: false } : undefined;
  if (https && managed(env)) return undefined;
  const plain = cookieFromHeader(cookieHeader, SESSION_COOKIE);
  return plain ? { value: plain, plainOverHttps: https } : undefined;
}

/** The session value a request carries (see readSessionCookie). */
export function sessionValue(req: RequestLike, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const h = req.headers.cookie;
  return readSessionCookie(Array.isArray(h) ? h.join('; ') : h, requestIsHttps(req, env), env)?.value;
}

const baseOpts = { httpOnly: true, sameSite: 'strict' as const, path: '/' };

/** Hand out a session: `__Host-` over HTTPS, the plain name over HTTP. */
export function setSessionCookie(reply: FastifyReply, req: FastifyRequest, value: string, maxAgeS: number): void {
  const https = requestIsHttps(req);
  reply.setCookie(https ? HOST_SESSION_COOKIE : SESSION_COOKIE, value, { ...baseOpts, secure: https, maxAge: Math.max(0, Math.floor(maxAgeS)) });
  // A plain one left from before would only confuse whoever looks at the jar.
  if (https && cookieFromHeader(req.headers.cookie, SESSION_COOKIE) !== undefined) reply.clearCookie(SESSION_COOKIE, { path: '/' });
  // A sign-in at the public address also gets the public pass (publicAccess.ts):
  // every place a session is handed out comes through here, so none can forget it.
  req.server.publicAccess?.sessionMinted(req, reply, value);
}

/**
 * After a request was signed in by a plain-named cookie over HTTPS (a home
 * install's session from before `__Host-`): give the browser the same value
 * under the new name and drop the old one, so the move happens without a
 * sign-in. The value's own expiry still decides how long it lasts.
 */
export function upgradeSessionCookie(req: FastifyRequest, reply: FastifyReply, maxAgeS: number): void {
  const h = req.headers.cookie;
  const https = requestIsHttps(req);
  const got = readSessionCookie(Array.isArray(h) ? h.join('; ') : h, https);
  if (!got?.plainOverHttps) return;
  reply.setCookie(HOST_SESSION_COOKIE, got.value, { ...baseOpts, secure: true, maxAge: Math.max(0, Math.floor(maxAgeS)) });
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Sign this browser out: every name a session cookie has had. */
export function clearSessionCookies(reply: FastifyReply, req: FastifyRequest): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(LEGACY_RENAME_COOKIE, { path: '/' });
  // A __Host- cookie can only be overwritten by one with the same attributes (Secure, Path=/).
  if (requestIsHttps(req)) reply.clearCookie(HOST_SESSION_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'strict' });
  req.server.publicAccess?.sessionCleared(req, reply);
}

/** Any of our session cookies (the public pass and the device cookie included), for stripping from what is forwarded to an agent's gateway. */
export const SESSION_COOKIE_NAME = /^(__Host-)?(hatchabot|agentclaw)_(session|pub|device)$/;
