import { createPublicKey, createVerify } from 'node:crypto';
import type { Principal } from './principal.js';

/**
 * GCP Identity Platform ID-token verification, without the Firebase Admin SDK.
 *
 * An ID token is an RS256 JWT signed by Google. Verification is: fetch the
 * public certs, check the signature, then check the claims are for *this*
 * project and still valid. No vendor SDK, no service-account key — which is
 * why this works unchanged on a laptop, the Spark, or Cloud Run.
 *
 * docs/identity.md phase 2.
 */

/** Google's public x509 certs for securetoken-signed JWTs. */
const CERT_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

export interface IdentityConfig {
  /** GCP project id — both the token audience and part of its issuer. */
  projectId: string;
  /** Web API key. Publishable (it identifies the project, it isn't a secret). */
  apiKey?: string;
  /** Test seam: override cert fetching. */
  fetchCerts?: () => Promise<Record<string, string>>;
  /** Test seam: current time in ms. */
  now?: () => number;
}

export class IdentityError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'IdentityError';
  }
}

export interface VerifiedToken {
  sub: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  expMs: number;
}

export class IdentityVerifier {
  #certs: Record<string, string> = {};
  #fetchedAt = 0;
  readonly #config: IdentityConfig;

  constructor(config: IdentityConfig) {
    if (!config.projectId) {
      throw new Error('HATCHABOT_GCP_PROJECT is required when HATCHABOT_AUTH=identity');
    }
    this.#config = config;
  }

  get issuer(): string {
    return `https://securetoken.google.com/${this.#config.projectId}`;
  }

  /** Google rotates these daily; an hour of caching is well inside that. */
  #lastAttempt = 0;

  async #certFor(kid: string): Promise<string> {
    const now = this.#config.now?.() ?? Date.now();
    const stale = now - this.#fetchedAt > 60 * 60_000;
    // Refetch when the key is unknown (rotation) or the cache aged out — but
    // never more than once a minute, so unauthenticated callers can't drive
    // outbound requests by spamming made-up kids.
    if ((!this.#certs[kid] || stale) && now - this.#lastAttempt > 60_000) {
      this.#lastAttempt = now;
      const fetcher =
        this.#config.fetchCerts ??
        (async () => {
          const res = await fetch(CERT_URL);
          if (!res.ok) throw new Error(`cert fetch failed: ${res.status}`);
          return (await res.json()) as Record<string, string>;
        });
      try {
        this.#certs = await fetcher();
        this.#fetchedAt = now;
      } catch (err) {
        // A Google outage must not log everyone out: keep serving the cached
        // keys and only fail if this particular kid was never seen.
        if (!this.#certs[kid]) {
          throw new IdentityError('Could not reach Google to verify your login.');
        }
      }
    }
    const cert = this.#certs[kid];
    if (!cert) throw new IdentityError('Your login could not be verified — try signing in again.');
    return cert;
  }

  /**
   * Verify an Identity Platform ID token. Throws IdentityError on anything
   * suspicious — a token for another project, an expired one, a bad signature.
   */
  async verify(idToken: string): Promise<VerifiedToken> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new IdentityError('That sign-in token is malformed.');
    const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

    let header: { alg?: string; kid?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      throw new IdentityError('That sign-in token is malformed.');
    }
    if (header.alg !== 'RS256' || !header.kid) {
      throw new IdentityError('That sign-in token uses an unexpected algorithm.');
    }

    const cert = await this.#certFor(header.kid);
    const key = createPublicKey(cert);
    const ok = createVerify('RSA-SHA256')
      .update(`${headerB64}.${payloadB64}`)
      .verify(key, Buffer.from(sigB64, 'base64url'));
    if (!ok) throw new IdentityError('That sign-in token failed verification.');

    const now = Math.floor((this.#config.now?.() ?? Date.now()) / 1000);
    const exp = Number(claims.exp);
    const iat = Number(claims.iat);
    const sub = typeof claims.sub === 'string' ? claims.sub : '';

    if (!Number.isFinite(exp) || exp <= now) throw new IdentityError('Your session expired — sign in again.');
    if (Number.isFinite(iat) && iat > now + 300) throw new IdentityError('That sign-in token is not valid yet.');
    // Audience is the project; issuer is securetoken + project. A token minted
    // for someone else's project must never authenticate here.
    if (claims.aud !== this.#config.projectId) throw new IdentityError('That sign-in is for a different app.');
    if (claims.iss !== this.issuer) throw new IdentityError('That sign-in has an unexpected issuer.');
    if (!sub) throw new IdentityError('That sign-in token has no subject.');

    return {
      sub,
      email: typeof claims.email === 'string' ? claims.email : undefined,
      emailVerified: claims.email_verified === true,
      name: typeof claims.name === 'string' ? claims.name : undefined,
      expMs: exp * 1000,
    };
  }
}

/**
 * The account's stable id. Identity Platform's `sub` (uid) never changes —
 * unlike email, which a user can update — so it is what owns data.
 */
export function principalFor(token: VerifiedToken): Principal {
  // Google-federated sign-ins arrive verified; a fresh email/password signup
  // does not. Refusing unverified emails stops "sign up as anyone" from
  // minting a usable principal.
  if (token.email && !token.emailVerified) {
    throw new IdentityError('Verify your email address, then sign in again.');
  }
  return {
    ownerId: `user-${token.sub}`,
    via: 'identity',
    subject: token.sub,
    email: token.email,
  };
}

export function identityConfigFromEnv(env = process.env): IdentityConfig {
  return {
    projectId: env.HATCHABOT_GCP_PROJECT ?? '',
    apiKey: env.HATCHABOT_IDENTITY_API_KEY,
  };
}
