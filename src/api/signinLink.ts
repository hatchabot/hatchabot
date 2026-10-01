import { createPublicKey, verify as verifySig, type KeyObject } from 'node:crypto';
import { statSync, readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Store } from '../store/store.js';

/**
 * One-time sign-in links (Hatchabot Cloud S5; docs/signin-links.md).
 *
 * A provider's account page ("Open my Hatchabot") mints a short-lived link
 * this installation accepts once. The link is signed with Ed25519: the
 * provider keeps the private key, this machine holds only the PUBLIC key
 * (HATCHABOT_SIGNIN_KEY_FILE). So a copy of this machine's files — a backup,
 * a support bundle, a neighbour who read the tenant's home — can check links
 * but never make one. (A shared HMAC key would put a link-minting secret on
 * every instance.)
 *
 *   token  = base64url(JSON claims) "." base64url(Ed25519 signature)
 *   signed = "hatchabot-signin-link/v1\n" + the first part, as ASCII
 *   claims = { v: 1, aud: "<this machine's public URL>", sub: "owner" | "user:<username or email>",
 *              iat: <unix s>, exp: <unix s, ≤ iat + 600>, nonce: "<16–128 base64url chars>" }
 *
 * Unset HATCHABOT_SIGNIN_KEY_FILE and none of this exists: no route, 404.
 */

export const SIGNIN_LINK_CONTEXT = 'hatchabot-signin-link/v1\n';
/** The longest a link may live (exp − iat). */
export const SIGNIN_LINK_MAX_TTL_S = 600;
/** Clock difference allowed between the provider and this machine, each way. */
export const SIGNIN_LINK_SKEW_S = 60;
/** How long a spent nonce is kept: far past any link's life, as the record of the sign-in. */
const KEEP_SPENT_MS = 30 * 24 * 3600_000;
const MAX_TOKEN_CHARS = 2048;
const B64URL = /^[A-Za-z0-9_-]+$/;

export interface SigninClaims {
  v: 1;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  nonce: string;
}

export type SigninRefusal = 'malformed' | 'signature' | 'audience' | 'lifetime' | 'not-yet' | 'expired';

/** The origin a URL names (scheme, host, port), or undefined if it is no http(s) URL. */
export function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check a token: signature first (nothing in an unsigned token is believed),
 * then the claims' shape, the audience, and the time window. The nonce is
 * NOT spent here; that is the caller's single INSERT.
 */
export function verifySigninToken(
  token: string,
  key: KeyObject,
  audience: string,
  nowMs = Date.now(),
): { ok: true; claims: SigninClaims } | { ok: false; reason: SigninRefusal } {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_CHARS) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [body, sigText] = parts as [string, string];
  if (!B64URL.test(body) || !B64URL.test(sigText)) return { ok: false, reason: 'malformed' };
  const sig = Buffer.from(sigText, 'base64url');
  if (sig.length !== 64) return { ok: false, reason: 'malformed' };
  let good = false;
  try { good = verifySig(null, Buffer.from(SIGNIN_LINK_CONTEXT + body, 'ascii'), key, sig); } catch { good = false; }
  if (!good) return { ok: false, reason: 'signature' };

  let c: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'malformed' };
    c = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
  if (c.v !== 1 || typeof c.aud !== 'string' || c.aud.length > 512 || typeof c.sub !== 'string'
    || !(c.sub === 'owner' || /^user:.{1,200}$/s.test(c.sub)) || !int(c.iat) || !int(c.exp)
    || typeof c.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(c.nonce)) {
    return { ok: false, reason: 'malformed' };
  }
  const mine = originOf(audience);
  if (!mine || originOf(c.aud) !== mine) return { ok: false, reason: 'audience' };
  if (c.exp <= c.iat || c.exp - c.iat > SIGNIN_LINK_MAX_TTL_S) return { ok: false, reason: 'lifetime' };
  const now = Math.floor(nowMs / 1000);
  if (c.iat > now + SIGNIN_LINK_SKEW_S) return { ok: false, reason: 'not-yet' };
  if (now > c.exp + SIGNIN_LINK_SKEW_S) return { ok: false, reason: 'expired' };
  return { ok: true, claims: c as unknown as SigninClaims };
}

/**
 * Read the public key file. It must hold an Ed25519 PUBLIC key (PEM): a
 * private key is refused outright — this machine must never be able to mint
 * links — and so is a file anyone but its owner may write (whoever can
 * replace the key can sign in as anyone). Never returns or logs the content.
 */
export function readSigninKey(path: string): { key: KeyObject } | { problem: string } {
  let text: string;
  try {
    const st = statSync(path);
    if (!st.isFile()) return { problem: `${path} is not a file` };
    if (st.mode & 0o022) return { problem: `${path} may be written by others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it` };
    if (st.size > 8192) return { problem: `${path} is too big to be a public key` };
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { problem: `can't read ${path}: ${(err as NodeJS.ErrnoException).code ?? 'error'}` };
  }
  if (/PRIVATE KEY/.test(text)) {
    return { problem: `${path} holds a PRIVATE key. This machine needs only the public half (scripts/signin-link.mjs keygen writes it as .pub); keep the private key with whoever mints the links` };
  }
  try {
    const key = createPublicKey({ key: text, format: 'pem' });
    if (key.asymmetricKeyType !== 'ed25519') return { problem: `${path} is a ${key.asymmetricKeyType ?? 'non-Ed25519'} key; sign-in links use Ed25519` };
    return { key };
  } catch {
    return { problem: `${path} is not a PEM public key` };
  }
}

/** What signing in as a link's subject came to. */
export type LinkSignIn =
  | { kind: 'session'; ownerId: string }
  /** An account that has never chosen a password: send them to choose one. */
  | { kind: 'claim'; ownerId: string; code: string }
  | { kind: 'refused'; why: 'no-account' | 'disabled' | 'not-allowed' };

export interface SigninLinkDeps {
  store: Store;
  /** The mode's own sign-in: set the session cookie on `reply` (or arm a claim). */
  signIn: (req: FastifyRequest, reply: FastifyReply, who: { owner: true } | { user: string }) => LinkSignIn;
  guard: { throttled: (req: FastifyRequest, who?: string) => boolean; noteFailure: (req: FastifyRequest, who?: string) => void };
  /** Test seams. */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export const SIGNIN_LINK_PATH = '/signin/link';

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function page(title: string, html: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#faf8f5;color:#222;margin:0;padding:16px}main{max-width:32rem;margin:12vh auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 4px #0002}h1{font-size:1.2rem;margin:0 0 .5rem}a{color:#9a5b00}
@media (prefers-color-scheme:dark){body{background:#17150f;color:#eee}main{background:#24211a}a{color:#e8a33d}}</style>
</head><body><main><h1>${esc(title)}</h1>${html}</main></body></html>`;
}

/**
 * GET /signin/link?t=<token>. Registered only when HATCHABOT_SIGNIN_KEY_FILE
 * is set. Every answer is no-store and no-referrer, and a success leaves no
 * token in the address bar: it is a 303 to / (or to the password chooser
 * for an account that has none yet).
 */
export function registerSigninLink(app: FastifyInstance, deps: SigninLinkDeps): void {
  const env = deps.env ?? process.env;
  const keyFile = env.HATCHABOT_SIGNIN_KEY_FILE?.trim();
  if (!keyFile) return;
  const now = deps.now ?? Date.now;

  // The key is re-read when the file changes, so a rotated key needs no restart.
  let cache: { stamp: string; result: ReturnType<typeof readSigninKey> } | undefined;
  let warned = '';
  const currentKey = (): KeyObject | undefined => {
    let stamp = 'missing';
    try { const st = statSync(keyFile); stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.mode}`; } catch { /* readSigninKey says why */ }
    if (!cache || cache.stamp !== stamp) cache = { stamp, result: readSigninKey(keyFile) };
    if ('problem' in cache.result) {
      if (warned !== stamp) { warned = stamp; app.log.error({ problem: cache.result.problem }, 'signin_link.key_unusable'); }
      return undefined;
    }
    return cache.result.key;
  };
  {
    const r = readSigninKey(keyFile);
    if ('problem' in r) app.log.error({ problem: r.problem }, 'signin_link.key_unusable');
    else if (!originOf(env.HATCHABOT_PUBLIC_URL)) app.log.error('signin_link.no_public_url: sign-in links name the address they are for; set HATCHABOT_PUBLIC_URL');
    else app.log.info({ audience: originOf(env.HATCHABOT_PUBLIC_URL) }, 'signin_link.enabled');
  }

  const send = (reply: FastifyReply, status: number, title: string, html: string) =>
    reply.code(status).type('text/html; charset=utf-8').send(page(title, html));

  /** Where to get a new link: the provider's page, when there is one. */
  const getAnother = (): string => {
    const by = env.HATCHABOT_MANAGED_BY?.trim();
    const help = env.HATCHABOT_SUPPORT_URL?.trim();
    const where = by ? `your ${esc(by)} account page` : 'the page that gave you this link';
    const link = help && /^https?:\/\//i.test(help) ? ` <a href="${esc(help)}" rel="noopener noreferrer">Get help</a>.` : '';
    return `<p>Get a new one from ${where}.${link}</p><p><a href="/">Sign in another way</a></p>`;
  };
  const spentOrExpired = (reply: FastifyReply) => send(reply, 400, 'This sign-in link has expired or was already used',
    `<p>This sign-in link has expired or was already used — links work once, for a few minutes.</p>${getAnother()}`);

  app.route<{ Querystring: { t?: string } }>({
    method: 'GET',
    url: SIGNIN_LINK_PATH,
    // A HEAD (a link checker, a chat app's preview) must not spend the link.
    exposeHeadRoute: false,
    handler: async (req, reply) => {
      reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
        .header('x-content-type-options', 'nosniff').header('x-frame-options', 'DENY')
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'");
      if (deps.guard.throttled(req)) {
        return send(reply, 429, 'Too many sign-in attempts', '<p>Too many sign-in attempts from here. Wait a few minutes and try again.</p>');
      }
      const refuse = (reason: string, status = 400) => {
        if (status === 400) deps.guard.noteFailure(req); // a broken setup here is not the visitor's miss
        app.log.warn({ reason }, 'signin_link.refused'); // never the token
        return status === 400 ? spentOrExpired(reply) : send(reply, status, 'Sign-in links are not working here right now', `<p>This Hatchabot can't check sign-in links at the moment.</p>${getAnother()}`);
      };
      const key = currentKey();
      const audience = originOf(env.HATCHABOT_PUBLIC_URL);
      if (!key || !audience) return refuse(!key ? 'key-unusable' : 'no-public-url', 503);
      const token = typeof req.query.t === 'string' ? req.query.t : '';
      const v = verifySigninToken(token, key, audience, now());
      if (!v.ok) return refuse(v.reason);
      const { claims } = v;
      // Spent before anything else happens, in one INSERT: the same link
      // opened twice at once signs in once.
      const keepUntil = Math.max(now() + KEEP_SPENT_MS, (claims.exp + SIGNIN_LINK_SKEW_S) * 1000);
      if (!deps.store.spendSigninNonce(claims.nonce, claims.sub, keepUntil, now())) return refuse('replayed');

      const who = claims.sub === 'owner' ? { owner: true as const } : { user: claims.sub.slice('user:'.length) };
      const r = deps.signIn(req, reply, who);
      if (r.kind === 'refused') {
        deps.guard.noteFailure(req);
        app.log.warn({ reason: r.why, sub: claims.sub }, 'signin_link.refused');
        return send(reply, 403, 'This sign-in link is for an account that isn\'t here',
          `<p>The account this link names is not on this Hatchabot, or it is turned off${r.why === 'not-allowed' ? ' or no longer allowed to sign in' : ''}.</p>${getAnother()}`);
      }
      if (r.kind === 'claim') {
        app.log.warn({ ownerId: r.ownerId, sub: claims.sub, via: 'signin-link' }, 'account.claim_by_link');
        return reply.redirect(`/?claim=${encodeURIComponent(r.code)}`, 303);
      }
      app.log.warn({ ownerId: r.ownerId, sub: claims.sub, via: 'signin-link' }, 'account.signed_in_by_link');
      return reply.redirect('/', 303);
    },
  });
}
