import type { FastifyRequest } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Who is making this request. Phase 1 of docs/identity.md: every route reads
 * the caller from here instead of sniffing a header, so switching from the
 * shared password to real accounts is one resolver change, not a rewrite.
 *
 * `ownerId` is the data-scoping key — every store query filters by it, which
 * is why per-user identity needs no schema change.
 */
export interface Principal {
  ownerId: string;
  /** How this principal was established. */
  via: 'password' | 'identity' | 'header';
  /** Set once identity mode lands: the verified token subject. */
  subject?: string;
  email?: string;
}

/** The single owner of a password-mode installation. */
export const LOCAL_OWNER = 'dev-owner';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/**
 * The caller for this request. Auth always sets `request.principal` on an
 * authenticated route — in password mode that is the single local owner, in
 * identity mode the verified token subject.
 */
/**
 * In-process calls on an owner's behalf (the management agent's READS, made
 * by the broker through app.inject). The secret is random per process and
 * never leaves it, and inject's remote address is loopback, so nothing outside
 * this process can use it. Changes never ride this: they execute with the
 * approving person's own sign-in.
 */
const INTERNAL_SECRET = randomBytes(32).toString('hex');
export const internalHeaders = (ownerId: string): Record<string, string> => ({
  'x-hatchabot-internal': INTERNAL_SECRET,
  'x-hatchabot-internal-owner': ownerId,
});
export function internalPrincipal(req: FastifyRequest): Principal | undefined {
  const h = req.headers as Record<string, unknown>;
  const given = h['x-hatchabot-internal'];
  const owner = h['x-hatchabot-internal-owner'];
  if (typeof given !== 'string' || typeof owner !== 'string' || !owner) return undefined;
  if (given.length !== INTERNAL_SECRET.length || !timingSafeEqual(Buffer.from(given), Buffer.from(INTERNAL_SECRET))) return undefined;
  if (req.ip !== '127.0.0.1' && req.ip !== '::1') return undefined;
  return { ownerId: owner, via: 'identity', subject: owner };
}

export function principalOf(req: FastifyRequest): Principal {
  if (req.principal) return req.principal;
  const internal = internalPrincipal(req);
  if (internal) return internal;
  // No verified principal: this is either a test harness or an auth-exempt
  // route that has no business asking who the caller is. The header branch is
  // opt-in so that adding a route under /join/* or /v1/invites/* can never
  // silently become an owner-spoof. Set HATCHABOT_ALLOW_OWNER_HEADER=1 in
  // tests and scripts that need it.
  const raw = (req.headers as Record<string, unknown>)['x-hatchabot-owner'];
  if (process.env.HATCHABOT_ALLOW_OWNER_HEADER === '1' && typeof raw === 'string' && raw) {
    return { ownerId: raw, via: 'header' };
  }
  return { ownerId: LOCAL_OWNER, via: 'password' };
}

export function ownerIdOf(req: FastifyRequest): string {
  return principalOf(req).ownerId;
}
