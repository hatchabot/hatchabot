import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';

/** The JWK fields the three supported key types use. */
export interface JsonWebKey { kty: string; crv?: string; x?: string; y?: string; n?: string; e?: string }

/**
 * Passkeys (WebAuthn), as a relying party, with node:crypto and a CBOR reader
 * of about forty lines. No dependency: the server side of WebAuthn with
 * attestation "none" is parsing two small structures and checking one
 * signature, and a library would be the largest piece of code in the sign-in
 * path that nobody here had read.
 *
 * What is checked (WebAuthn Level 2, §7.1 and §7.2), and nothing is skipped:
 *   - clientDataJSON: the type, OUR challenge, and an origin we serve;
 *   - authenticator data: the RP ID hash, "user present" (and "user verified"
 *     when asked for), the signature counter;
 *   - the signature over authenticatorData || SHA-256(clientDataJSON), with
 *     the public key stored at registration.
 * Attestation is "none": we ask for no statement and verify none. It says
 * which make of authenticator was used, which a home server has no policy
 * about; it adds nothing to whether the key that signs is the key enrolled.
 */

export class WebAuthnError extends Error {}
const fail = (why: string): never => { throw new WebAuthnError(why); };

// ---- CBOR (RFC 8949), the subset authenticators emit ------------------------

type Cbor = number | bigint | string | Buffer | boolean | null | Cbor[] | Map<Cbor, Cbor>;

/** Decode one item at `at`; returns it and the offset after it. Definite lengths only (CTAP2 canonical form). */
export function cborDecode(buf: Buffer, at = 0, depth = 0): { value: Cbor; next: number } {
  if (depth > 8) fail('cbor: nested too deep');
  if (at >= buf.length) fail('cbor: truncated');
  const head = buf[at]!;
  const major = head >> 5, info = head & 31;
  let n: number, p = at + 1;
  if (info < 24) n = info;
  else if (info === 24) { if (p + 1 > buf.length) fail('cbor: truncated'); n = buf[p]!; p += 1; }
  else if (info === 25) { if (p + 2 > buf.length) fail('cbor: truncated'); n = buf.readUInt16BE(p); p += 2; }
  else if (info === 26) { if (p + 4 > buf.length) fail('cbor: truncated'); n = buf.readUInt32BE(p); p += 4; }
  else if (info === 27) {
    if (p + 8 > buf.length) fail('cbor: truncated');
    const big = buf.readBigUInt64BE(p); p += 8;
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) fail('cbor: integer too large');
    n = Number(big);
  } else return fail('cbor: indefinite lengths are not accepted');
  switch (major) {
    case 0: return { value: n, next: p };
    case 1: return { value: -1 - n, next: p };
    case 2: { if (p + n > buf.length) fail('cbor: truncated'); return { value: buf.subarray(p, p + n), next: p + n }; }
    case 3: { if (p + n > buf.length) fail('cbor: truncated'); return { value: buf.toString('utf8', p, p + n), next: p + n }; }
    case 4: {
      if (n > 64) fail('cbor: array too long');
      const arr: Cbor[] = [];
      for (let i = 0; i < n; i++) { const r = cborDecode(buf, p, depth + 1); arr.push(r.value); p = r.next; }
      return { value: arr, next: p };
    }
    case 5: {
      if (n > 64) fail('cbor: map too long');
      const map = new Map<Cbor, Cbor>();
      for (let i = 0; i < n; i++) {
        const k = cborDecode(buf, p, depth + 1); const v = cborDecode(buf, k.next, depth + 1);
        map.set(k.value, v.value); p = v.next;
      }
      return { value: map, next: p };
    }
    case 6: return cborDecode(buf, p, depth + 1); // a tag: the tagged item is what matters here
    default: {
      if (info === 20) return { value: false, next: p };
      if (info === 21) return { value: true, next: p };
      if (info === 22 || info === 23) return { value: null, next: p };
      return fail('cbor: unsupported simple value');
    }
  }
}

// ---- helpers ---------------------------------------------------------------

export const b64u = (b: Buffer): string => b.toString('base64url');
export const fromB64u = (s: string): Buffer => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length > 16_384) fail('not base64url');
  return Buffer.from(s, 'base64url');
};
const sha256 = (b: Buffer | string): Buffer => createHash('sha256').update(b).digest();

const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_BE = 0x08, FLAG_BS = 0x10, FLAG_AT = 0x40;

export interface AuthenticatorData {
  rpIdHash: Buffer;
  flags: number;
  userPresent: boolean;
  userVerified: boolean;
  backupEligible: boolean;
  backedUp: boolean;
  signCount: number;
  credentialId?: Buffer;
  publicKey?: StoredPublicKey;
}

/** A credential's public key as we keep it: a JWK and the COSE algorithm it signs with. */
export interface StoredPublicKey { alg: -7 | -257 | -8; jwk: JsonWebKey }

/** COSE_Key (RFC 9052) → JWK, for the three algorithms asked for: ES256, RS256, EdDSA (Ed25519). */
export function coseToStored(map: Map<Cbor, Cbor>): StoredPublicKey {
  const kty = map.get(1), alg = map.get(3);
  const bytes = (k: number): Buffer => { const v = map.get(k); return Buffer.isBuffer(v) ? v : fail('cose: missing key bytes'); };
  if (kty === 2 && alg === -7) {
    if (map.get(-1) !== 1) fail('cose: ES256 needs curve P-256');
    const x = bytes(-2), y = bytes(-3);
    if (x.length !== 32 || y.length !== 32) fail('cose: bad P-256 point');
    return { alg: -7, jwk: { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) } };
  }
  if (kty === 3 && alg === -257) {
    const n = bytes(-1), e = bytes(-2);
    if (n.length < 256) fail('cose: RSA key under 2048 bits');
    return { alg: -257, jwk: { kty: 'RSA', n: b64u(n), e: b64u(e) } };
  }
  if (kty === 1 && alg === -8) {
    if (map.get(-1) !== 6) fail('cose: EdDSA needs Ed25519');
    const x = bytes(-2);
    if (x.length !== 32) fail('cose: bad Ed25519 key');
    return { alg: -8, jwk: { kty: 'OKP', crv: 'Ed25519', x: b64u(x) } };
  }
  return fail('cose: unsupported key type');
}

export function parseAuthenticatorData(data: Buffer): AuthenticatorData {
  if (data.length < 37) fail('authenticator data too short');
  const flags = data[32]!;
  const out: AuthenticatorData = {
    rpIdHash: data.subarray(0, 32),
    flags,
    userPresent: !!(flags & FLAG_UP),
    userVerified: !!(flags & FLAG_UV),
    backupEligible: !!(flags & FLAG_BE),
    backedUp: !!(flags & FLAG_BS),
    signCount: data.readUInt32BE(33),
  };
  if (flags & FLAG_AT) {
    if (data.length < 55) fail('attested credential data too short');
    const idLen = data.readUInt16BE(53);
    if (idLen < 1 || idLen > 1023 || 55 + idLen > data.length) fail('bad credential id length');
    out.credentialId = Buffer.from(data.subarray(55, 55 + idLen));
    const key = cborDecode(data, 55 + idLen);
    if (!(key.value instanceof Map)) fail('credential public key is not a map');
    out.publicKey = coseToStored(key.value as Map<Cbor, Cbor>);
  }
  return out;
}

interface ClientData { type: string; challenge: string; origin: string; crossOrigin?: boolean }

function checkClientData(json: Buffer, want: { type: string; challenge: string; origins: string[] }): void {
  let c: ClientData;
  try { c = JSON.parse(json.toString('utf8')) as ClientData; } catch { return fail('client data is not JSON'); }
  if (c.type !== want.type) fail(`client data type is ${String(c.type)}`);
  const a = Buffer.from(String(c.challenge ?? '')), b = Buffer.from(want.challenge);
  if (a.length !== b.length || !timingSafeEqual(a, b)) fail('challenge does not match');
  if (!want.origins.includes(String(c.origin))) fail(`origin ${String(c.origin)} is not this Hatchabot`);
  if (c.crossOrigin === true) fail('cross-origin use is refused');
}

function checkRp(auth: AuthenticatorData, rpId: string, requireUv: boolean): void {
  const want = sha256(rpId);
  if (auth.rpIdHash.length !== 32 || !timingSafeEqual(auth.rpIdHash, want)) fail('made for another site (RP ID)');
  if (!auth.userPresent) fail('user presence not asserted');
  if (requireUv && !auth.userVerified) fail('user verification was required');
  // A backed-up credential must be backup-eligible (§6.1): anything else is malformed.
  if (auth.backedUp && !auth.backupEligible) fail('inconsistent backup flags');
}

export interface Expectation {
  /** The challenge we issued, base64url. */
  challenge: string;
  /** Every origin this Hatchabot is opened at (scheme://host[:port]). */
  origins: string[];
  rpId: string;
  requireUserVerification?: boolean;
}

export interface RegisteredCredential {
  credentialId: string; // base64url
  publicKey: StoredPublicKey;
  signCount: number;
  backedUp: boolean;
  userVerified: boolean;
}

/** Verify navigator.credentials.create()'s answer (attestation none). */
export function verifyRegistration(resp: { clientDataJSON: string; attestationObject: string }, exp: Expectation): RegisteredCredential {
  checkClientData(fromB64u(resp.clientDataJSON), { type: 'webauthn.create', challenge: exp.challenge, origins: exp.origins });
  const att = cborDecode(fromB64u(resp.attestationObject)).value;
  if (!(att instanceof Map)) return fail('attestation object is not a map');
  const authData = att.get('authData');
  if (!Buffer.isBuffer(authData)) return fail('attestation object has no authenticator data');
  const auth = parseAuthenticatorData(authData);
  checkRp(auth, exp.rpId, !!exp.requireUserVerification);
  if (!auth.credentialId || !auth.publicKey) return fail('no credential in the answer');
  // The statement (att.get('attStmt')) is not read: attestation none.
  return {
    credentialId: b64u(auth.credentialId), publicKey: auth.publicKey, signCount: auth.signCount,
    backedUp: auth.backedUp, userVerified: auth.userVerified,
  };
}

/** Does this signature come from the stored key? */
export function verifySignature(key: StoredPublicKey, data: Buffer, signature: Buffer): boolean {
  try {
    const pub = createPublicKey({ key: key.jwk, format: 'jwk' });
    if (key.alg === -7) return cryptoVerify('sha256', data, { key: pub, dsaEncoding: 'der' }, signature);
    if (key.alg === -257) return cryptoVerify('sha256', data, pub, signature);
    if (key.alg === -8) return cryptoVerify(null, data, pub, signature);
    return false;
  } catch {
    return false; // a malformed signature or key is a non-match, never a crash
  }
}

/**
 * Verify navigator.credentials.get()'s answer against a stored credential.
 * Returns the new signature counter to store.
 *
 * The counter (§6.1.1): when either side is non-zero the new value must be
 * greater than the stored one; equal or lower means two authenticators hold
 * the same key (a clone), and the sign-in is refused. Passkeys synced between
 * devices always report 0, which is why 0 → 0 passes.
 */
export function verifyAssertion(
  resp: { clientDataJSON: string; authenticatorData: string; signature: string },
  stored: { publicKey: StoredPublicKey; signCount: number },
  exp: Expectation,
): { signCount: number; userVerified: boolean; backedUp: boolean } {
  const clientData = fromB64u(resp.clientDataJSON);
  checkClientData(clientData, { type: 'webauthn.get', challenge: exp.challenge, origins: exp.origins });
  const authData = fromB64u(resp.authenticatorData);
  const auth = parseAuthenticatorData(authData);
  checkRp(auth, exp.rpId, !!exp.requireUserVerification);
  if (!verifySignature(stored.publicKey, Buffer.concat([authData, sha256(clientData)]), fromB64u(resp.signature))) fail('signature does not verify');
  if ((auth.signCount !== 0 || stored.signCount !== 0) && auth.signCount <= stored.signCount) {
    fail('signature counter went backwards: this passkey may have been copied');
  }
  return { signCount: auth.signCount, userVerified: auth.userVerified, backedUp: auth.backedUp };
}
