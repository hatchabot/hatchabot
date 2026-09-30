import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { LOCAL_OWNER, internalPrincipal, type Principal } from './principal.js';
import { registerAccountRoutes, sessionAccount } from './accountsAuth.js';
import type { Store } from '../store/store.js';
import {
  identityConfigFromEnv,
  IdentityError,
  IdentityVerifier,
  principalFor,
} from './identity.js';

const COOKIE = 'hatchabot_session';

/**
 * Optional allowlist for identity mode: HATCHABOT_ALLOWED_EMAILS="a@example.com, b@example.org".
 * Unset = anyone the identity provider accepts may sign in (the household
 * default). Set = only these addresses become tenants; everyone else is 403.
 */
function allowedEmailProblem(email: string | undefined): string | undefined {
  const raw = process.env.HATCHABOT_ALLOWED_EMAILS?.trim();
  if (!raw) return undefined;
  const allowed = new Set(raw.split(/[\s,]+/).filter(Boolean).map((e) => e.toLowerCase()));
  if (email && allowed.has(email.toLowerCase())) return undefined;
  return 'This installation only admits listed accounts.';
}

/**
 * Per-client throttle for the credential endpoints: after LIMIT failures in
 * the window a client gets 429 until it expires. The old flat 400 ms sleep
 * was defeated by parallel connections.
 */
const failLimit = () => Number(process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW ?? 10); // read per call (tests tune it)
const FAIL_WINDOW_MS = Number(process.env.HATCHABOT_LOGIN_WINDOW_MS ?? 15 * 60_000);
const failures = new Map<string, { n: number; until: number }>();
/**
 * Whom to count a failure against. Behind `tailscale serve` or a local reverse
 * proxy every client arrives from loopback, so counting the socket address
 * locked EVERYONE out after one person's ten misses (26th audit). A loopback
 * peer's X-Forwarded-For names the real client (trusted only from loopback:
 * a remote client cannot forge its way to a different bucket). The account
 * being tried is a second bucket, so hopping addresses does not help either.
 */
/** Set at boot when the docker daemon is rootless (index.ts), or by an operator: containers share this process's loopback. */
export function loopbackIsRemote(): boolean {
  return process.env.HATCHABOT_CONTAINERS_ON_LOOPBACK === '1';
}
function throttleKeys(req: FastifyRequest, who?: string): string[] {
  let ip = req.ip || 'unknown';
  const bare = ip.replace(/^::ffff:/, '');
  // Under a rootless daemon every agent container is a loopback peer of this
  // process (its packets arrive from 127.0.0.1), so loopback is not "local"
  // there: no forwarded-for trust, no shared bucket with the owner's CLI.
  // Under a rootless daemon containers are loopback peers too; forwarded-for is
  // still how proxied people get their own bucket — a container that forges
  // it only escapes into a bucket of its own, and the per-account bucket still
  // caps guessing. Without it, one agent's ten misses locked out everyone
  // behind the proxy (use-case audit, 2026-09-27).
  if (bare === '127.0.0.1' || bare === '::1' || bare.startsWith('127.')) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) ip = `fwd:${first}`;
  }
  const keys = [`ip:${ip}`];
  if (who) keys.push(`user:${who.trim().toLowerCase()}`);
  return keys;
}
export function throttled(req: FastifyRequest, who?: string): boolean {
  for (const k of throttleKeys(req, who)) {
    const f = failures.get(k);
    if (!f) continue;
    if (Date.now() > f.until) { failures.delete(k); continue; }
    // A shared bucket (the one password, the first-run code) is a ceiling on
    // everyone together, not a lock: at the per-client limit, ten misses from
    // anyone locked the owner out too (regression review, 2026-09-28).
    const limit = k.startsWith('user:*') ? failLimit() * 10 : failLimit();
    if (f.n >= limit) return true;
  }
  return false;
}
export function noteFailure(req: FastifyRequest, who?: string): void {
  for (const k of throttleKeys(req, who)) {
    const f = failures.get(k);
    if (!f || Date.now() > f.until) failures.set(k, { n: 1, until: Date.now() + FAIL_WINDOW_MS });
    else f.n += 1;
  }
  // Bounded: expired entries go first, then client buckets with the fewest
  // misses; an account's bucket goes last. Dropping the oldest by insertion
  // let a flood of junk evict the very account being guessed at, and with it
  // the per-account cap (night review, 2026-09-27).
  if (failures.size > 10_000) {
    const now = Date.now();
    for (const [k, f] of failures) if (now > f.until) failures.delete(k);
    if (failures.size > 8_000) {
      const order = [...failures.entries()].sort(([ka, a], [kb, b]) =>
        (ka.startsWith('user:') ? 1 : 0) - (kb.startsWith('user:') ? 1 : 0) || a.n - b.n);
      for (const [k] of order.slice(0, failures.size - 8_000)) failures.delete(k);
    }
  }
}
/** A recovered account starts clean: the lock-out someone ran up on it ends. */
export function clearFailures(who: string): void {
  failures.delete(`user:${who.trim().toLowerCase()}`);
}
/** Password mode has one password, so one bucket for it: forged forwarded-for addresses each got a fresh client bucket and unlimited guesses (night review). */
const PASSWORD_BUCKET = '*shared-password*';
/** Test hook. */
export function _resetLoginThrottle(): void { failures.clear(); }
const LEGACY_COOKIE = 'agentclaw_session'; // set by pre-rename servers; cleared on logout, never read
/**
 * Mark the session cookie `secure` only when the request actually arrived over
 * HTTPS (directly or via a terminating proxy). Setting it unconditionally
 * breaks every plain-HTTP install: the browser silently DISCARDS a secure
 * cookie on an http:// origin, so login appears to succeed and then loops.
 * On HTTPS the flag still does its job.
 */
function requestIsHttps(req: FastifyRequest): boolean {
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (proto ?? req.protocol) === 'https';
}
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/**
 * Identity-mode browser sessions: ours once Google's token is verified. They
 * used to end with that token (Google's last about an hour), so the owner
 * signed in again every hour (Chris, 2026-09-28). The allowed-emails list is
 * still enforced on every request: the email rides in the signed cookie.
 */
export function sessionTtlMs(raw = process.env.HATCHABOT_SESSION_DAYS): number {
  // An empty or mistyped value (`HATCHABOT_SESSION_DAYS=` reaches us as '')
  // gave 0 or NaN: every Google sign-in "succeeded" into an already-expired
  // cookie and looped back to the login screen (review, 2026-09-29).
  const days = Number(raw);
  if (raw !== undefined && raw.trim() !== '' && Number.isFinite(days) && days > 0) return days * 24 * 60 * 60 * 1000;
  if (raw !== undefined && !warnedSessionDays) {
    warnedSessionDays = true;
    console.warn(`HATCHABOT_SESSION_DAYS=${JSON.stringify(raw)} is not a positive number of days; using 14.`);
  }
  return 14 * 24 * 60 * 60 * 1000;
}
let warnedSessionDays = false;

export interface AuthOptions {
  /** Shared password (HATCHABOT_PASSWORD). Unset = auth disabled, loudly. */
  password?: string;
  /** Key material for signing session cookies — we reuse the secret-store key. */
  secret: Buffer;
  /**
   * `password` — one shared password for the whole installation (default;
   *   a home install never needs a cloud identity provider).
   * `identity` — per-user accounts via GCP Identity Platform. See
   *   docs/identity.md; the verifier lands in phase 2.
   */
  mode?: AuthMode;
  /** Test seam / DI for identity mode. */
  verifier?: IdentityVerifier;
  /** Accounts mode keeps its credentials in the store. */
  store?: Store;
  /**
   * Called on each successful identity authentication. Phase 3 uses it to
   * hand a password-mode installation's data to its first real account.
   */
  onAuthenticated?: (principal: Principal) => void;
  /**
   * Resolves a long-lived CLI token to its owner. Works in BOTH auth modes,
   * so a Google-only account can still use the CLI (Google has no headless
   * password flow to offer it).
   */
  cliTokenOwner?: (token: string) => string | undefined;
  /** A token's scope: undefined = full owner access, 'rehost' = only what a
   *  peer server needs to move an agent here. */
  cliTokenScope?: (token: string) => string | undefined;
}

export type AuthMode = 'password' | 'accounts' | 'identity';

/** Local username/password accounts alongside Google sign-in (identity mode). */
export function localAccountsEnabled(env = process.env): boolean {
  return env.HATCHABOT_LOCAL_ACCOUNTS === '1';
}

export function authModeFromEnv(env = process.env): AuthMode {
  const raw = (env.HATCHABOT_AUTH ?? 'password').toLowerCase();
  if (raw === 'identity') return 'identity';
  if (raw === 'accounts') return 'accounts';
  if (raw !== 'password') {
    throw new Error(`HATCHABOT_AUTH must be "password", "accounts" or "identity" (got "${raw}")`);
  }
  return 'password';
}

/**
 * Is anyone actually being authenticated? Password mode needs a password to be
 * set; accounts and identity modes authenticate by construction, whatever
 * HATCHABOT_PASSWORD says (accounts mode ignores it entirely).
 */
export function authIsEnabled(mode: AuthMode, password: string | undefined): boolean {
  return mode !== 'password' || !!password;
}

/**
 * Where to listen. With auth OFF every request is the owner, and agent
 * containers can reach this process over the docker bridge — so binding
 * 0.0.0.0 there would hand the fleet to any prompt-injected agent. With auth
 * on, listen everywhere so a tailnet or LAN client can reach the app.
 * HATCHABOT_BIND always wins.
 */
export function bindHostFor(env: NodeJS.ProcessEnv, mode: AuthMode): string {
  if (env.HATCHABOT_BIND) return env.HATCHABOT_BIND;
  return authIsEnabled(mode, env.HATCHABOT_PASSWORD) ? '0.0.0.0' : '127.0.0.1';
}

/**
 * LAN-grade auth: one shared password, exchanged for a signed, httpOnly
 * session cookie. This is deliberately not accounts/identity — it is the
 * "don't let anyone on the wifi own my agents" lock. Real identity arrives
 * when Hatchabot leaves the LAN.
 *
 * The page itself (GET /) and /healthz stay open; every /v1/* call except
 * login requires the cookie. The app shows a password screen on 401.
 */
declare module 'fastify' {
  interface FastifyInstance {
    /** Resolve a principal from a raw Cookie header — for a WebSocket upgrade,
     *  which Fastify never sees and so has no `request.principal`. Returns
     *  undefined when the caller is not authenticated. Same session logic as
     *  the onRequest hooks; deliberately the ONLY seam, so the two can't drift. */
    principalFromCookieHeader?: (cookieHeader: string | undefined) => Principal | undefined;
  }
}

/** Pull one cookie's value out of a raw `Cookie:` header. */
function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * "Sign out everywhere": ends every session the signed-in person has, on every
 * device, by bumping their sign-in epoch (store.session_epochs), and clears
 * this browser's cookie. Plain /v1/logout still only forgets this browser's
 * copy — a cookie copied off a shared device kept working for its full 14
 * days with no way to end it short of rotating the secret key (review,
 * 2026-09-29). Not auth-exempt: only a signed-in person ends their own.
 */
function registerLogoutEverywhere(app: FastifyInstance, store: Store | undefined, signsIn = true): void {
  app.post('/v1/logout/everywhere', async (req, reply) => {
    // The management agent's in-process reads never sign anyone out.
    if (internalPrincipal(req)) return reply.code(403).send({ error: 'Only the person themselves can sign out everywhere.' });
    const who = req.principal?.ownerId;
    if (!who) return reply.code(401).send({ error: 'auth required' });
    if (!signsIn) return reply.code(400).send({ error: 'Nobody signs in to this installation, so there are no sessions to end.' });
    if (!store) return reply.code(503).send({ error: 'This server has no database to record the sign-out in.' });
    store.bumpSessionEpoch(who);
    // …and their command-line sign-ins, which never read the epoch
    // (2026-09-30). A Google-signed-in CLI keeps its own refresh token on
    // that computer; the confirm tells them to run `hatchabot logout` there.
    const cliTokens = store.revokePersonalCliTokens(who);
    if (cliTokens) app.log.warn({ owner: who, revoked: cliTokens }, 'logout_everywhere.cli_tokens_revoked');
    reply.clearCookie(COOKIE, { path: '/' });
    reply.clearCookie(LEGACY_COOKIE, { path: '/' });
    return { ok: true, cliTokens };
  });
}

/** The console proxy: a browser reaches an agent's Control UI through here, with its cookie. */
const CONSOLE_PATH = /^\/v1\/agents\/[^/]+\/ui(\/|$)/;

export async function registerAuth(app: FastifyInstance, opts: AuthOptions): Promise<void> {
  await app.register(fastifyCookie);

  const mode: AuthMode = opts.mode ?? 'password';
  if (mode === 'identity') {
    await registerIdentityAuth(app, opts);
    return;
  }
  if (mode === 'accounts') {
    registerAccountsAuth(app, opts);
    return;
  }

  if (!opts.password) {
    app.log.warn(
      'HATCHABOT_PASSWORD is not set — the API is open to anyone who can reach this port.',
    );
  }

  /**
   * Sessions are bound to the current password: its hash rides in the signed
   * payload, so rotating HATCHABOT_PASSWORD invalidates every existing
   * session instead of leaving 30-day cookies valid.
   */
  const pwEpoch = createHmac('sha256', opts.secret)
    .update(`pw:${opts.password ?? ''}`)
    .digest('hex')
    .slice(0, 16);

  // The one owner's sign-in epoch is signed in too, so "sign out everywhere"
  // ends every device's session without changing the password. Epoch 0 signs
  // exactly what it did before, so existing sessions survive the upgrade
  // (review, 2026-09-29).
  const epochNow = (): number => opts.store?.sessionEpoch(LOCAL_OWNER) ?? 0;
  const sign = (exp: number, epoch = epochNow()): string =>
    createHmac('sha256', opts.secret).update(`session:${exp}:${pwEpoch}${epoch ? `:e${epoch}` : ''}`).digest('hex');

  const validSession = (token: string | undefined): boolean => {
    if (!token) return false;
    const [expStr, sig] = token.split('.');
    const exp = Number(expStr);
    if (!expStr || !sig || !Number.isFinite(exp) || exp < Date.now()) return false;
    const expected = sign(exp);
    return (
      sig.length === expected.length &&
      timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))
    );
  };

  app.post<{ Body: { password?: string } }>('/v1/login', async (req, reply) => {
    if (!opts.password) return { ok: true }; // auth disabled
    if (throttled(req, PASSWORD_BUCKET)) return reply.code(429).send({ error: 'Too many failed attempts — try again later.' });
    const given = (req.body as { password?: string } | null)?.password ?? '';
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(opts.password, 'utf8');
    const match = a.length === b.length && timingSafeEqual(a, b);
    if (!match) {
      // Flat-rate the brute-force path a little; real rate limiting can come
      // with real identity.
      noteFailure(req, PASSWORD_BUCKET);
      await new Promise((r) => setTimeout(r, 400));
      return reply.code(401).send({ error: 'Wrong password' });
    }
    const exp = Date.now() + TTL_MS;
    reply.setCookie(COOKIE, `${exp}.${sign(exp)}`, {
      httpOnly: true,
      sameSite: 'strict',
      // Behind HTTPS (Tailscale serve, a terminating proxy) the 30-day cookie
      // must not ride a forced plaintext request; plain-HTTP LAN installs
      // still work because the flag is only set when the request came in
      // encrypted. Same rule as identity mode below.
      secure: requestIsHttps(req),
      path: '/',
      maxAge: Math.floor(TTL_MS / 1000),
    });
    return { ok: true };
  });

  // Symmetric with identity mode: lock the app on a shared screen, or switch
  // who this tab is. Exempt from auth below — logging out with an already
  // dead session must succeed, not 401.
  app.post('/v1/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    reply.clearCookie(LEGACY_COOKIE, { path: '/' });
    return { ok: true };
  });
  registerLogoutEverywhere(app, opts.store, !!opts.password);

  app.decorate('principalFromCookieHeader', (header: string | undefined): Principal | undefined => {
    if (!opts.password) return { ownerId: LOCAL_OWNER, via: 'password' };
    return validSession(cookieValue(header, COOKIE))
      ? { ownerId: LOCAL_OWNER, via: 'password' }
      : undefined;
  });

  app.addHook('onRequest', async (req, reply) => {
    { const internal = internalPrincipal(req); if (internal) { req.principal = internal; return; } }
    if (!opts.password) {
      req.principal = { ownerId: LOCAL_OWNER, via: 'password' };
      return;
    }
    const path = req.url.split('?')[0] ?? '';
    // /v1/config tells the login screen which mode to render — it must be
    // readable before anyone is authenticated.
    if (path === '/' || path === '/healthz' || path === '/v1/login' || path === '/v1/config') return;
    if (path === '/v1/logout') return;
    // PWA shell assets carry no data — reachable before login so the app can install.
    if (path === '/manifest.webmanifest' || path === '/sw.js' || path === '/app-qr.svg' || path.startsWith('/icons/')) return;
    if (path === '/privacy' || path === '/terms') return; // public legal pages (Google OAuth consent screen)
    // Invitees don't have the LAN password — their invite code is their
    // credential. The join surface validates codes itself.
    if (path.startsWith('/join/') || path === '/v1/join' || path.startsWith('/v1/invites/')) return;
    // Google's OAuth redirect is a CROSS-SITE top-level navigation: the
    // strict-SameSite session cookie deliberately stays home, so this one
    // path authenticates by its single-use state token instead (issued to an
    // authenticated owner at /start; consumed exactly once in the handler).
    if (path === '/v1/connections/google/callback') return;
    // Agent-to-agent consult: authenticated by the CALLER AGENT's own call
    // token inside the handler (not a user session), so it's exempt here.
    if (/^\/v1\/agents\/[^/]+\/message$/.test(path)) return;
    const cliOwner = cliBearer(req, opts);
    if (cliOwner) {
      req.principal = { ownerId: cliOwner, via: 'identity', subject: cliOwner };
      return;
    }
    if (validSession(req.cookies[COOKIE])) {
      // A valid password session IS the installation's single owner. In
      // identity mode this becomes the verified token subject.
      req.principal = { ownerId: LOCAL_OWNER, via: 'password' };
      return;
    }
    return reply.code(401).send({ error: 'auth required' });
  });
}

/**
 * Accounts mode: several local accounts, each with its own username and
 * password, kept in this installation's database. Same session cookie shape as
 * the other modes; the difference is that the cookie names WHICH account, and
 * every route then scopes to that owner id.
 */
function registerAccountsAuth(app: FastifyInstance, opts: AuthOptions): void {
  const store = opts.store;
  if (!store) throw new Error('accounts mode needs a store (registerAuth opts.store)');

  registerAccountRoutes(app, { store, secret: opts.secret, onAuthenticated: opts.onAuthenticated, cliTokenOwner: opts.cliTokenOwner }, { throttled, noteFailure, clearFailures });

  app.post('/v1/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    reply.clearCookie(LEGACY_COOKIE, { path: '/' });
    return { ok: true };
  });
  registerLogoutEverywhere(app, store);

  app.decorate('principalFromCookieHeader', (header: string | undefined): Principal | undefined => {
    const id = sessionAccount(store, opts.secret, cookieValue(header, COOKIE));
    return id ? { ownerId: id, via: 'password', subject: id } : undefined;
  });

  app.addHook('onRequest', async (req, reply) => {
    { const internal = internalPrincipal(req); if (internal) { req.principal = internal; return; } }
    const path = req.url.split('?')[0] ?? '';
    if (path === '/' || path === '/healthz' || path === '/v1/config') return;
    if (path === '/v1/login' || path === '/v1/logout') return;
    // First run has no accounts and therefore no way to authenticate; the
    // route itself refuses once account #1 exists.
    if (path === '/v1/local-accounts/bootstrap') return;
    // An invitation is claimed by someone who cannot sign in yet — the code is
    // the credential, and the route validates it.
    if (path === '/v1/local-accounts/claim') return;
    // "Forgot password?" is asked by someone who cannot sign in. The route
    // answers the same whatever the username, rate-limits, and only ever sends
    // a link to a Telegram account already proven to be that person's.
    if (path === '/v1/local-accounts/recover') return;
    // …and so is using a recovery code: it IS the credential, checked in the route.
    if (path === '/v1/local-accounts/recover-with-code') return;
    if (path.startsWith('/join/') || path === '/v1/join' || path.startsWith('/v1/invites/')) return;
    if (path === '/manifest.webmanifest' || path === '/sw.js' || path === '/app-qr.svg' || path.startsWith('/icons/')) return;
    if (path === '/privacy' || path === '/terms') return;
    if (path === '/v1/connections/google/callback') return;
    if (/^\/v1\/agents\/[^/]+\/message$/.test(path)) return;

    const cliOwner = cliBearer(req, opts);
    if (cliOwner) {
      // ownerForCliToken checks only the hash and expiry, so a token minted by
      // an account that has since been removed or disabled would still
      // authenticate as that owner — removal has to mean revoked (audit
      // 2026-09-16).
      const owner = store.localAccount(cliOwner);
      if (!owner || owner.disabled) {
        return reply.code(401).send({ error: 'That access token belongs to an account that no longer exists.' });
      }
      req.principal = { ownerId: cliOwner, via: 'identity', subject: cliOwner };
      return;
    }
    const id = sessionAccount(store, opts.secret, req.cookies[COOKIE]);
    if (id) {
      req.principal = { ownerId: id, via: 'password', subject: id };
      opts.onAuthenticated?.(req.principal);
      return;
    }
    return reply.code(401).send({ error: 'auth required' });
  });
}

/** With an allowlist set, is this Google owner still on it? True = refuse. */
function cliAllowlistProblem(opts: AuthOptions, ownerId: string): boolean {
  const raw = process.env.HATCHABOT_ALLOWED_EMAILS?.trim();
  if (!raw || !opts.store) return false;
  const allowed = raw.split(/[\s,]+/).filter(Boolean);
  return !allowed.some((e) => opts.store!.ownerForEmail(e) === ownerId);
}

/**
 * Identity mode: the caller proves who they are with an Identity Platform ID
 * token (Authorization: Bearer …, or a cookie the browser got by posting one
 * to /v1/session). The control plane never sees a password — Google does the
 * authenticating, we do the verifying.
 */
async function registerIdentityAuth(app: FastifyInstance, opts: AuthOptions): Promise<void> {
  const verifier = opts.verifier ?? new IdentityVerifier(identityConfigFromEnv());
  // HATCHABOT_LOCAL_ACCOUNTS=1 keeps local username/password accounts alongside
  // Google sign-in: the owner signs in with Google, everyone else gets an
  // invitation link — nobody else needs a cloud project to exist.
  const localAccounts = opts.store && localAccountsEnabled();
  if (localAccounts && opts.store) {
    registerAccountRoutes(
      app,
      { store: opts.store, secret: opts.secret, onAuthenticated: opts.onAuthenticated, cliTokenOwner: opts.cliTokenOwner },
      { throttled, noteFailure, clearFailures },
      { bootstrap: false }, // the host owner is the Google account; nobody bootstraps
    );
  }

  // The browser trades a verified ID token for a short session cookie, so the
  // token itself never sits in localStorage and every page load isn't a
  // round-trip to Google.
  const sign = (payload: string): string =>
    createHmac('sha256', opts.secret).update(payload).digest('hex');

  // Payload: sub:exp:e<epoch>[:email]. The epoch field starts with "e" and
  // has no "@", so it never reads as an email; a cookie from before it
  // (sub:exp[:email]) is epoch 0 and keeps working until the person's first
  // "sign out everywhere" (review, 2026-09-29).
  const epochOf = (ownerId: string): number => opts.store?.sessionEpoch(ownerId) ?? 0;
  const mintSession = (sub: string, expMs: number, email?: string): string => {
    const epoch = epochOf(`user-${sub}`);
    const payload = `${sub}:${expMs}:e${epoch}${email ? `:${email}` : ''}`;
    return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
  };

  const readSession = (cookie: string | undefined): { sub: string; email?: string } | undefined => {
    if (!cookie) return undefined;
    const [b64, sig] = cookie.split('.');
    if (!b64 || !sig) return undefined;
    const payload = Buffer.from(b64, 'base64url').toString('utf8');
    const expected = sign(payload);
    if (sig.length !== expected.length) return undefined;
    if (!timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) return undefined;
    const [sub, expStr, ...rest] = payload.split(':');
    // NaN never compares true, so a missing exp would fail OPEN — guard it
    // the same way password-mode's validSession does.
    const exp = Number(expStr);
    if (!sub || !Number.isFinite(exp) || exp < Date.now()) return undefined;
    // Minted before the person's last "sign out everywhere": over.
    const epochField = rest[0] !== undefined && /^e\d+$/.test(rest[0]) ? rest.shift()! : 'e0';
    if (Number(epochField.slice(1)) < epochOf(`user-${sub}`)) return undefined;
    // A long session still answers to the allowed-emails list, checked now.
    // (Sessions from before the email rode along were an hour long; they
    // are refused once a list is set.)
    const email = rest.length ? rest.join(':') : undefined;
    if (process.env.HATCHABOT_ALLOWED_EMAILS?.trim() && allowedEmailProblem(email)) return undefined;
    // The email rides along to the principal: without it shares were stored
    // "from another user" and the own-address guard never fired (review,
    // 2026-09-29). Only verified emails are ever minted (see /v1/session).
    return { sub, email };
  };

  app.post<{ Body: { idToken?: string } }>('/v1/session', async (req, reply) => {
    const idToken = (req.body as { idToken?: string } | null)?.idToken;
    if (!idToken) return reply.code(400).send({ error: 'idToken required' });
    if (throttled(req)) return reply.code(429).send({ error: 'Too many failed attempts — try again later.' });
    try {
      const token = await verifier.verify(idToken);
      // principalFor refuses an unverified email. It ran AFTER the cookie
      // was set, so the 401 carried a working 14-day session and "verify
      // your email" gated nothing (review, 2026-09-29). Judge first, mint last.
      const principal = principalFor(token);
      const denied = allowedEmailProblem(token.email);
      if (denied) return reply.code(403).send({ error: denied });
      const exp = Date.now() + sessionTtlMs();
      reply.setCookie(COOKIE, mintSession(token.sub, exp, token.email), {
        httpOnly: true,
        sameSite: 'strict',
        secure: requestIsHttps(req),
        path: '/',
        maxAge: Math.floor((exp - Date.now()) / 1000),
      });
      opts.onAuthenticated?.(principal);
      return { ok: true, ownerId: principal.ownerId, email: principal.email };
    } catch (err) {
      noteFailure(req);
      if (err instanceof IdentityError) return reply.code(401).send({ error: err.userMessage });
      throw err;
    }
  });

  app.post('/v1/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    reply.clearCookie(LEGACY_COOKIE, { path: '/' });
    return { ok: true };
  });
  registerLogoutEverywhere(app, opts.store);

  app.decorate('principalFromCookieHeader', (header: string | undefined): Principal | undefined => {
    const session = readSession(cookieValue(header, COOKIE));
    if (session) return { ownerId: `user-${session.sub}`, via: 'identity', subject: session.sub, email: session.email };
    // A local account's session, as the request hook accepts it: without this
    // their console's WebSocket was always refused (night review).
    if (localAccounts && opts.store) {
      const id = sessionAccount(opts.store, opts.secret, cookieValue(header, COOKIE));
      const owner = id ? opts.store.localAccount(id) : undefined;
      if (id && owner && !owner.disabled) return { ownerId: id, via: 'password', subject: id };
    }
    return undefined;
  });

  app.addHook('onRequest', async (req, reply) => {
    { const internal = internalPrincipal(req); if (internal) { req.principal = internal; return; } }
    const path = req.url.split('?')[0] ?? '';
    if (path === '/' || path === '/healthz' || path === '/v1/config') return;
    if (path === '/v1/session' || path === '/v1/logout') return;
    // Sign-in, claiming an invitation, and the bootstrap route (which answers
    // with "this installation signs in with Google" rather than a bare 401).
    // Recovery too: local accounts forget passwords here as anywhere (the
    // Telegram link was unreachable in this mode — 24th audit, low).
    if (localAccounts && (path === '/v1/login' || path === '/v1/local-accounts/claim' || path === '/v1/local-accounts/bootstrap'
      || path === '/v1/local-accounts/recover' || path === '/v1/local-accounts/recover-with-code')) return;
    if (path.startsWith('/join/') || path === '/v1/join' || path.startsWith('/v1/invites/')) return;
    // PWA shell assets carry no data — reachable before login so the app can install.
    if (path === '/manifest.webmanifest' || path === '/sw.js' || path === '/app-qr.svg' || path.startsWith('/icons/')) return;
    if (path === '/privacy' || path === '/terms') return; // public legal pages (Google OAuth consent screen)
    // Cross-site OAuth redirect: strict-SameSite keeps the session cookie
    // home, so the single-use state token is this path's credential.
    if (path === '/v1/connections/google/callback') return;
    // Agent-to-agent consult: authenticated by the CALLER AGENT's own call
    // token inside the handler (not a user session), so it's exempt here.
    if (/^\/v1\/agents\/[^/]+\/message$/.test(path)) return;

    const cliOwner = cliBearer(req, opts);
    if (cliOwner) {
      // Same rule as accounts mode: a local account that was disabled or
      // removed takes its tokens with it (26th audit).
      const local = localAccounts ? opts.store?.localAccount(cliOwner) : undefined;
      if (local?.disabled) return reply.code(401).send({ error: 'That access token belongs to an account that no longer exists.' });
      // A Google account's token answers to the allowlist too: an email taken
      // off HATCHABOT_ALLOWED_EMAILS kept working through its 90-day tokens
      // (night review). Its email is the one its last sign-in recorded.
      if (!local && cliAllowlistProblem(opts, cliOwner)) {
        return reply.code(403).send({ error: 'That access token belongs to an account this installation no longer allows.' });
      }
      req.principal = { ownerId: cliOwner, via: 'identity', subject: cliOwner };
      return;
    }

    // Bearer token (CLI, phone app) — verified on every call. Not on the
    // console proxy: OpenClaw 2026.9's Control UI sends the AGENT's gateway
    // token as `Authorization: Bearer …` on its own fetches (workspace icon,
    // avatar, config). That token is for the gateway, not for us; judging it
    // here refused the request before the owner's cookie was even looked at,
    // and the UI retried the icon thousands of times an hour (2026-09-24).
    // The cookie decides those requests; the proxy still strips our tokens.
    const authz = req.headers.authorization;
    if (typeof authz === 'string' && authz.startsWith('Bearer ') && !CONSOLE_PATH.test(path)) {
      try {
        const token = await verifier.verify(authz.slice(7));
        const denied = allowedEmailProblem(token.email);
        if (denied) return reply.code(403).send({ error: denied });
        req.principal = principalFor(token);
        opts.onAuthenticated?.(req.principal);
        return;
      } catch (err) {
        const msg = err instanceof IdentityError ? err.userMessage : 'auth required';
        return reply.code(401).send({ error: msg });
      }
    }

    // Browser session cookie minted from an already-verified token.
    const session = readSession(req.cookies[COOKIE]);
    if (session) {
      req.principal = { ownerId: `user-${session.sub}`, via: 'identity', subject: session.sub, email: session.email };
      return;
    }
    // …or a local account's session, when those run alongside Google. The two
    // cookie shapes are signed with different material, so one never validates
    // as the other.
    if (localAccounts && opts.store) {
      const id = sessionAccount(opts.store, opts.secret, req.cookies[COOKIE]);
      if (id) {
        const owner = opts.store.localAccount(id);
        if (owner && !owner.disabled) {
          req.principal = { ownerId: id, via: 'password', subject: id };
          return;
        }
      }
    }
    return reply.code(401).send({ error: 'auth required' });
  });
}


/**
 * A `hatchabot_…` bearer is a long-lived token this installation minted, not
 * an identity-provider token — resolve it locally.
 */
/** What a rehost-scoped token may call: the other server's move, and nothing else. */
const REHOST_PATHS = new Set(['/v1/agents/preflight', '/v1/agents/restore', '/v1/agents']);
function cliBearer(req: FastifyRequest, opts: AuthOptions): string | undefined {
  const authz = req.headers.authorization;
  if (typeof authz !== 'string') return undefined;
  if (!authz.startsWith('Bearer hatchabot_') && !authz.startsWith('Bearer agentclaw_')) return undefined;
  const token = authz.slice(7);
  const owner = opts.cliTokenOwner?.(token);
  if (!owner) return undefined;
  // The token a peer server holds for moving agents here used to be a full
  // owner token: a hostile peer could read bot tokens and credentials, delete
  // agents, mint more tokens (26th audit). A scoped one opens three routes.
  const scope = opts.cliTokenScope?.(token);
  if (scope === 'rehost') {
    const path = req.url.split('?')[0] ?? '';
    const ok = REHOST_PATHS.has(path) && (path === '/v1/agents' ? req.method === 'GET' : req.method === 'POST');
    if (!ok) return undefined;
  }
  return owner;
}
