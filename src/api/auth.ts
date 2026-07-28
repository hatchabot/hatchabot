import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';

const COOKIE = 'agentclaw_session';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface AuthOptions {
  /** Shared password (AGENTCLAW_PASSWORD). Unset = auth disabled, loudly. */
  password?: string;
  /** Key material for signing session cookies — we reuse the secret-store key. */
  secret: Buffer;
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

  if (!opts.password) {
    app.log.warn(
      'AGENTCLAW_PASSWORD is not set — the API is open to anyone who can reach this port.',
    );
  }

  const sign = (exp: number): string =>
    createHmac('sha256', opts.secret).update(`session:${exp}`).digest('hex');

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
    if (!opts.password) return;
    const path = req.url.split('?')[0] ?? '';
    if (path === '/' || path === '/healthz' || path === '/v1/login') return;
    if (validSession(req.cookies[COOKIE])) return;
    return reply.code(401).send({ error: 'auth required' });
  });
}
