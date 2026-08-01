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
 * The caller for this request. Auth sets `request.principal`; until identity
 * mode exists, a password-mode session IS the local owner. The legacy
 * `x-agentclaw-owner` header still works for scripts and tests.
 */
export function principalOf(req: FastifyRequest): Principal {
  if (req.principal) return req.principal;
  const raw = (req.headers as Record<string, unknown>)['x-agentclaw-owner'];
  if (typeof raw === 'string' && raw) return { ownerId: raw, via: 'header' };
  return { ownerId: LOCAL_OWNER, via: 'password' };
}

export function ownerIdOf(req: FastifyRequest): string {
  return principalOf(req).ownerId;
}
