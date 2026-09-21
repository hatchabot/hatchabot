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
 * Optional allowlist for identity mode: HATCHABOT_ALLOWED_EMAILS="a@x.com, b@y.org".
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
function throttleKey(req: FastifyRequest): string { return req.ip || 'unknown'; }
function throttled(req: FastifyRequest): boolean {
  const f = failures.get(throttleKey(req));
  if (!f) return false;
  if (Date.now() > f.until) { failures.delete(throttleKey(req)); return false; }
  return f.n >= failLimit();
}
function noteFailure(req: FastifyRequest): void {
  const k = throttleKey(req);
  const f = failures.get(k);
  if (!f || Date.now() > f.until) failures.set(k, { n: 1, until: Date.now() + FAIL_WINDOW_MS });
  else f.n += 1;
  if (failures.size > 10_000) failures.clear(); // bounded; a flood just resets everyone's count
}
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
/** Identity-mode browser sessions are shorter: the token behind them is too. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

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

  const sign = (exp: number): string =>
    createHmac('sha256', opts.secret).update(`session:${exp}:${pwEpoch}`).digest('hex');

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
    if (throttled(req)) return reply.code(429).send({ error: 'Too many failed attempts — try again later.' });
    const given = (req.body as { password?: string } | null)?.password ?? '';
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(opts.password, 'utf8');
    const match = a.length === b.length && timingSafeEqual(a, b);
    if (!match) {
      // Flat-rate the brute-force path a little; real rate limiting can come
      // with real identity.
      noteFailure(req);
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

  registerAccountRoutes(app, { store, secret: opts.secret, onAuthenticated: opts.onAuthenticated, cliTokenOwner: opts.cliTokenOwner }, { throttled, noteFailure });

  app.post('/v1/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    reply.clearCookie(LEGACY_COOKIE, { path: '/' });
    return { ok: true };
  });

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
      { throttled, noteFailure },
      { bootstrap: false }, // the host owner is the Google account; nobody bootstraps
    );
  }

  // The browser trades a verified ID token for a short session cookie, so the
  // token itself never sits in localStorage and every page load isn't a
  // round-trip to Google.
  const sign = (payload: string): string =>
    createHmac('sha256', opts.secret).update(payload).digest('hex');

  const mintSession = (sub: string, expMs: number): string => {
    const payload = `${sub}:${expMs}`;
    return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
  };

  const readSession = (cookie: string | undefined): { sub: string } | undefined => {
    if (!cookie) return undefined;
    const [b64, sig] = cookie.split('.');
    if (!b64 || !sig) return undefined;
    const payload = Buffer.from(b64, 'base64url').toString('utf8');
    const expected = sign(payload);
    if (sig.length !== expected.length) return undefined;
    if (!timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) return undefined;
    const [sub, expStr] = payload.split(':');
    // NaN never compares true, so a missing exp would fail OPEN — guard it
    // the same way password-mode's validSession does.
    const exp = Number(expStr);
    if (!sub || !Number.isFinite(exp) || exp < Date.now()) return undefined;
    return { sub };
  };

  app.post<{ Body: { idToken?: string } }>('/v1/session', async (req, reply) => {
    const idToken = (req.body as { idToken?: string } | null)?.idToken;
    if (!idToken) return reply.code(400).send({ error: 'idToken required' });
    if (throttled(req)) return reply.code(429).send({ error: 'Too many failed attempts — try again later.' });
    try {
      const token = await verifier.verify(idToken);
      const denied = allowedEmailProblem(token.email);
      if (denied) return reply.code(403).send({ error: denied });
      // Sessions never outlive the token that created them by much.
      const exp = Math.min(token.expMs, Date.now() + SESSION_TTL_MS);
      reply.setCookie(COOKIE, mintSession(token.sub, exp), {
        httpOnly: true,
        sameSite: 'strict',
        secure: requestIsHttps(req),
        path: '/',
        maxAge: Math.floor((exp - Date.now()) / 1000),
      });
      const principal = principalFor(token);
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

  app.decorate('principalFromCookieHeader', (header: string | undefined): Principal | undefined => {
    const session = readSession(cookieValue(header, COOKIE));
    return session
      ? { ownerId: `user-${session.sub}`, via: 'identity', subject: session.sub }
      : undefined;
  });

  app.addHook('onRequest', async (req, reply) => {
    { const internal = internalPrincipal(req); if (internal) { req.principal = internal; return; } }
    const path = req.url.split('?')[0] ?? '';
    if (path === '/' || path === '/healthz' || path === '/v1/config') return;
    if (path === '/v1/session' || path === '/v1/logout') return;
    // Sign-in, claiming an invitation, and the bootstrap route (which answers
    // with "this installation signs in with Google" rather than a bare 401).
    if (localAccounts && (path === '/v1/login' || path === '/v1/local-accounts/claim' || path === '/v1/local-accounts/bootstrap')) return;
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
      req.principal = { ownerId: cliOwner, via: 'identity', subject: cliOwner };
      return;
    }

    // Bearer token (CLI, phone app) — verified on every call.
    const authz = req.headers.authorization;
    if (typeof authz === 'string' && authz.startsWith('Bearer ')) {
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
      req.principal = { ownerId: `user-${session.sub}`, via: 'identity', subject: session.sub };
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
function cliBearer(req: FastifyRequest, opts: AuthOptions): string | undefined {
  const authz = req.headers.authorization;
  if (typeof authz !== 'string') return undefined;
  if (!authz.startsWith('Bearer hatchabot_') && !authz.startsWith('Bearer agentclaw_')) return undefined;
  return opts.cliTokenOwner?.(authz.slice(7));
}
