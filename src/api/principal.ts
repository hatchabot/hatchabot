import type { FastifyRequest } from 'fastify';

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
export function principalOf(req: FastifyRequest): Principal {
  if (req.principal) return req.principal;
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
