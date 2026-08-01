import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { LOCAL_OWNER } from './principal.js';

const COOKIE = 'agentclaw_session';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
    // Phase 2 (docs/identity.md) plugs the JWKS verifier in here. Failing
    // loudly beats silently serving an installation with no auth at all.
    throw new Error(
      'AGENTCLAW_AUTH=identity is not implemented yet — see docs/identity.md. Use password mode.',
    );
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
    if (path === '/' || path === '/healthz' || path === '/v1/login') return;
    // Invitees don't have the LAN password — their invite code is their
    // credential. The join surface validates codes itself.
    if (path.startsWith('/join/') || path === '/v1/join' || path.startsWith('/v1/invites/')) return;
    if (validSession(req.cookies[COOKIE])) {
      // A valid password session IS the installation's single owner. In
      // identity mode this becomes the verified token subject.
      req.principal = { ownerId: LOCAL_OWNER, via: 'password' };
      return;
    }
    return reply.code(401).send({ error: 'auth required' });
  });
}
