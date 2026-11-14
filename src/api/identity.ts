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
const CERT_TIMEOUT_MS = 10_000;

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
  constructor(readonly userMessage: string, readonly statusCode = 401) {
    super(userMessage);
    this.name = 'IdentityError';
  }
}

/** The token could not be checked at all, which says nothing about the token (HB-0424). */
export class IdentityUnavailableError extends IdentityError {
  constructor(userMessage: string) {
    super(userMessage, 503);
    this.name = 'IdentityUnavailableError';
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
  #certs = new Map<string, string>();
  #fetchedAt = -Infinity;
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
  #lastAttempt = -Infinity;
  /** The fetch under way, if any; true when it brought new certs. */
  #inflight: Promise<boolean> | undefined;
  /** The last fetch failed: an unknown key may simply be one we could not get. */
  #lastFetchFailed = false;

  /** One deadline covers the headers and body, including an injected fetcher. */
  async #fetchCerts(): Promise<Map<string, string>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const certs = await Promise.race([
        Promise.resolve().then(async () => {
          if (this.#config.fetchCerts) return this.#config.fetchCerts();
          const res = await fetch(CERT_URL, { signal: controller.signal });
          if (!res.ok) throw new Error(`cert fetch failed: ${res.status}`);
          return res.json() as Promise<unknown>;
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('certificate fetch timed out'));
          }, CERT_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
      if (!certs || typeof certs !== 'object' || Array.isArray(certs)) throw new Error('invalid certificates');
      const entries = Object.entries(certs);
      if (!entries.length || entries.some(([, value]) => typeof value !== 'string' || !value)) throw new Error('invalid certificates');
      return new Map(entries as Array<[string, string]>);
    } finally {
      clearTimeout(timer);
    }
  }

  async #certFor(kid: string): Promise<string> {
    const now = this.#config.now?.() ?? Date.now();
    const stale = now - this.#fetchedAt > 60 * 60_000;
    // An unknown kid may have started a refresh, but a fresh cached key is
    // already enough to check this token. Do not queue it behind that fetch.
    const cached = this.#certs.get(kid);
    if (cached && !stale) return cached;
    // Refetch when the key is unknown (rotation) or the cache aged out — but
    // never more than once a minute, so unauthenticated callers can't drive
    // outbound requests by spamming made-up kids.
    if ((!cached || stale) && !this.#inflight && now - this.#lastAttempt > 60_000) {
      this.#lastAttempt = now;
      this.#inflight = this.#fetchCerts()
        .then((certs) => { this.#certs = certs; this.#fetchedAt = now; this.#lastFetchFailed = false; return true; }, () => { this.#lastFetchFailed = true; return false; })
        .finally(() => { this.#inflight = undefined; });
    }
    // A fetch under way, this request's or another's, is waited for: the
    // throttle used to send the second of two first sign-ins straight to
    // the empty cache, and it was refused while the first got in.
    if (this.#inflight) await this.#inflight;
    // A Google outage must not log everyone out: keep serving the cached
    // keys and only fail if this particular kid was never seen. Between
    // fetches too: the once-a-minute limit made a retry look like a bad key.
    if (this.#lastFetchFailed && !this.#certs.has(kid)) {
      throw new IdentityUnavailableError('Could not reach Google to verify your login.');
    }
    const cert = this.#certs.get(kid);
    if (!cert) throw new IdentityError('Your login could not be verified — try signing in again.');
    return cert;
  }

  /**
   * Verify an Identity Platform ID token. Throws IdentityError on anything
   * suspicious — a token for another project, an expired one, a bad signature.
   */
  async verify(idToken: unknown): Promise<VerifiedToken> {
    if (typeof idToken !== 'string') throw new IdentityError('That sign-in token is malformed.');
    const parts = idToken.split('.');
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new IdentityError('That sign-in token is malformed.');
    const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      if (!header || typeof header !== 'object' || Array.isArray(header) || !claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('invalid token shape');
    } catch {
      throw new IdentityError('That sign-in token is malformed.');
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
      throw new IdentityError('That sign-in token uses an unexpected algorithm.');
    }

    const cert = await this.#certFor(header.kid);
    let key;
    try { key = createPublicKey(cert); }
    catch { throw new IdentityUnavailableError('Could not read Google\'s signing key to verify your login.'); }
    const ok = createVerify('RSA-SHA256')
      .update(`${headerB64}.${payloadB64}`)
      .verify(key, Buffer.from(sigB64, 'base64url'));
    if (!ok) throw new IdentityError('That sign-in token failed verification.');

    const now = Math.floor((this.#config.now?.() ?? Date.now()) / 1000);
    const exp = claims.exp;
    const iat = claims.iat;
    const sub = typeof claims.sub === 'string' ? claims.sub : '';

    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= now) throw new IdentityError('Your session expired — sign in again.');
    if (typeof iat !== 'number' || !Number.isFinite(iat)) throw new IdentityError('That sign-in token is malformed.');
    if (iat > now + 300) throw new IdentityError('That sign-in token is not valid yet.');
    if ((claims.email !== undefined && typeof claims.email !== 'string') || (claims.email_verified !== undefined && typeof claims.email_verified !== 'boolean') || (claims.name !== undefined && typeof claims.name !== 'string')) {
      throw new IdentityError('That sign-in token is malformed.');
    }
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

/** The same installation policy applies to sessions, bearer tokens and invitations. */
export function admittedPrincipal(token: VerifiedToken): Principal {
  const principal = principalFor(token);
  const denied = allowedEmailProblem(token.email);
  if (denied) throw new IdentityError(denied, 403);
  return principal;
}

/** Optional identity allowlist; unset admits everyone the provider verifies. */
export function allowedEmailProblem(email: string | undefined): string | undefined {
  const raw = process.env.HATCHABOT_ALLOWED_EMAILS?.trim();
  if (!raw) return undefined;
  const allowed = new Set(raw.split(/[\s,]+/).filter(Boolean).map((e) => e.toLowerCase()));
  if (email && allowed.has(email.toLowerCase())) return undefined;
  return 'This installation only admits listed accounts.';
}

export function identityConfigFromEnv(env = process.env): IdentityConfig {
  return {
    projectId: env.HATCHABOT_GCP_PROJECT ?? '',
    apiKey: env.HATCHABOT_IDENTITY_API_KEY,
  };
}
