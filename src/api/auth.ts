import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { LOCAL_OWNER, type Principal } from './principal.js';
import {
  identityConfigFromEnv,
  IdentityError,
  IdentityVerifier,
  principalFor,
} from './identity.js';

const COOKIE = 'agentclaw_session';
/**
 * Identity mode targets the public internet, where a cookie must not ride
 * plain HTTP. Home installs are http://localhost / tailnet, so the flag is
 * opt-out via AGENTCLAW_INSECURE_COOKIES=1.
 */
const secureCookies = (mode: string) =>
  mode === 'identity' && process.env.AGENTCLAW_INSECURE_COOKIES !== '1';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Identity-mode browser sessions are shorter: the token behind them is too. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface AuthOptions {
  /** Shared password (AGENTCLAW_PASSWORD). Unset = auth disabled, loudly. */
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

export type AuthMode = 'password' | 'identity';

export function authModeFromEnv(env = process.env): AuthMode {
  const raw = (env.AGENTCLAW_AUTH ?? 'password').toLowerCase();
  if (raw === 'identity') return 'identity';
  if (raw !== 'password') {
    throw new Error(`AGENTCLAW_AUTH must be "password" or "identity" (got "${raw}")`);
  }
  return 'password';
}

/**
 * LAN-grade auth: one shared password, exchanged for a signed, httpOnly
 * session cookie. This is deliberately not accounts/identity — it is the
 * "don't let anyone on the wifi own my agents" lock. Real identity arrives
 * when AgentClaw leaves the LAN.
 *
 * The page itself (GET /) and /healthz stay open; every /v1/* call except
 * login requires the cookie. The app shows a password screen on 401.
 */
export async function registerAuth(app: FastifyInstance, opts: AuthOptions): Promise<void> {
  await app.register(fastifyCookie);

  const mode: AuthMode = opts.mode ?? 'password';
  if (mode === 'identity') {
    await registerIdentityAuth(app, opts);
    return;
  }

  if (!opts.password) {
    app.log.warn(
      'AGENTCLAW_PASSWORD is not set — the API is open to anyone who can reach this port.',
    );
  }

  /**
   * Sessions are bound to the current password: its hash rides in the signed
   * payload, so rotating AGENTCLAW_PASSWORD invalidates every existing
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
    const given = (req.body as { password?: string } | null)?.password ?? '';
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(opts.password, 'utf8');
    const match = a.length === b.length && timingSafeEqual(a, b);
    if (!match) {
      // Flat-rate the brute-force path a little; real rate limiting can come
      // with real identity.
      await new Promise((r) => setTimeout(r, 400));
      return reply.code(401).send({ error: 'Wrong password' });
    }
    const exp = Date.now() + TTL_MS;
    reply.setCookie(COOKIE, `${exp}.${sign(exp)}`, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: Math.floor(TTL_MS / 1000),
    });
    return { ok: true };
  });

  app.addHook('onRequest', async (req, reply) => {
    if (!opts.password) {
      req.principal = { ownerId: LOCAL_OWNER, via: 'password' };
      return;
    }
    const path = req.url.split('?')[0] ?? '';
    // /v1/config tells the login screen which mode to render — it must be
    // readable before anyone is authenticated.
    if (path === '/' || path === '/healthz' || path === '/v1/login' || path === '/v1/config') return;
    // Invitees don't have the LAN password — their invite code is their
    // credential. The join surface validates codes itself.
    if (path.startsWith('/join/') || path === '/v1/join' || path.startsWith('/v1/invites/')) return;
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
 * Identity mode: the caller proves who they are with an Identity Platform ID
 * token (Authorization: Bearer …, or a cookie the browser got by posting one
 * to /v1/session). The control plane never sees a password — Google does the
 * authenticating, we do the verifying.
 */
async function registerIdentityAuth(app: FastifyInstance, opts: AuthOptions): Promise<void> {
  const verifier = opts.verifier ?? new IdentityVerifier(identityConfigFromEnv());

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
    if (!sub || Number(expStr) < Date.now()) return undefined;
    return { sub };
  };

  app.post<{ Body: { idToken?: string } }>('/v1/session', async (req, reply) => {
    const idToken = (req.body as { idToken?: string } | null)?.idToken;
    if (!idToken) return reply.code(400).send({ error: 'idToken required' });
    try {
      const token = await verifier.verify(idToken);
      // Sessions never outlive the token that created them by much.
      const exp = Math.min(token.expMs, Date.now() + SESSION_TTL_MS);
      reply.setCookie(COOKIE, mintSession(token.sub, exp), {
        httpOnly: true,
        sameSite: 'strict',
        secure: secureCookies('identity'),
        path: '/',
        maxAge: Math.floor((exp - Date.now()) / 1000),
      });
      const principal = principalFor(token);
      opts.onAuthenticated?.(principal);
      return { ok: true, ownerId: principal.ownerId, email: principal.email };
    } catch (err) {
      if (err instanceof IdentityError) return reply.code(401).send({ error: err.userMessage });
      throw err;
    }
  });

  app.post('/v1/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (path === '/' || path === '/healthz' || path === '/v1/config') return;
    if (path === '/v1/session' || path === '/v1/logout') return;
    if (path.startsWith('/join/') || path === '/v1/join' || path.startsWith('/v1/invites/')) return;

    const cliOwner = cliBearer(req, opts);
    if (cliOwner) {
      req.principal = { ownerId: cliOwner, via: 'identity', subject: cliOwner };
      return;
    }

    // Bearer token (CLI, phone app) — verified on every call.
    const authz = req.headers.authorization;
    if (typeof authz === 'string' && authz.startsWith('Bearer ')) {
      try {
        req.principal = principalFor(await verifier.verify(authz.slice(7)));
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
    return reply.code(401).send({ error: 'auth required' });
  });
}


/**
 * An `agentclaw_…` bearer is a long-lived token this installation minted, not
 * an identity-provider token — resolve it locally.
 */
function cliBearer(req: FastifyRequest, opts: AuthOptions): string | undefined {
  const authz = req.headers.authorization;
  if (typeof authz !== 'string' || !authz.startsWith('Bearer agentclaw_')) return undefined;
  return opts.cliTokenOwner?.(authz.slice(7));
}
