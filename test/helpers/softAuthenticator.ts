import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

/**
 * A software authenticator for tests: makes the same bytes a real one does
 * (CTAP2 canonical CBOR, authenticator data, COSE keys, signatures), so the
 * relying-party code is exercised on real structures rather than on its own
 * idea of them.
 */
const b64u = (b: Buffer) => b.toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

// ---- a small CBOR encoder (ints, bytes, text, maps) ---------------------------
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
export function cborEncode(v: unknown): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cborEncode(k), cborEncode(x)])]);
  throw new Error('unsupported');
}

export type Alg = 'ES256' | 'RS256' | 'EdDSA';

export class SoftAuthenticator {
  readonly credentialId = Buffer.from(sha256(`cred-${Math.random()}`).subarray(0, 20));
  private key: KeyObject;
  private pub: KeyObject;
  signCount = 0;
  /** Flags to set beyond UP: UV 0x04, BE 0x08, BS 0x10. */
  extraFlags = 0x04;
  userPresent = true;

  constructor(readonly alg: Alg = 'ES256', readonly counts = true) {
    const pair = alg === 'ES256' ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : alg === 'RS256' ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ed25519');
    this.key = pair.privateKey; this.pub = pair.publicKey;
  }

  coseKey(): Buffer {
    const jwk = this.pub.export({ format: 'jwk' }) as { x?: string; y?: string; n?: string; e?: string };
    const u = (s?: string) => Buffer.from(s ?? '', 'base64url');
    if (this.alg === 'ES256') return cborEncode(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, u(jwk.x)], [-3, u(jwk.y)]]));
    if (this.alg === 'RS256') return cborEncode(new Map<number, unknown>([[1, 3], [3, -257], [-1, u(jwk.n)], [-2, u(jwk.e)]]));
    return cborEncode(new Map<number, unknown>([[1, 1], [3, -8], [-1, 6], [-2, u(jwk.x)]]));
  }

  private authData(rpId: string, attested: boolean): Buffer {
    const flags = (this.userPresent ? 0x01 : 0) | this.extraFlags | (attested ? 0x40 : 0);
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counts ? ++this.signCount : 0);
    const base = Buffer.concat([sha256(rpId), Buffer.from([flags]), count]);
    if (!attested) return base;
    const len = Buffer.alloc(2); len.writeUInt16BE(this.credentialId.length);
    return Buffer.concat([base, Buffer.alloc(16), len, this.credentialId, this.coseKey()]);
  }

  private clientData(type: string, challenge: string, origin: string, extra: Record<string, unknown> = {}): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...extra }));
  }

  /** What navigator.credentials.create() sends back (attestation "none"). */
  create(o: { challenge: string; origin: string; rpId: string; clientExtra?: Record<string, unknown> }) {
    const att = cborEncode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', this.authData(o.rpId, true)]]));
    return { id: b64u(this.credentialId), clientDataJSON: b64u(this.clientData('webauthn.create', o.challenge, o.origin, o.clientExtra)), attestationObject: b64u(att) };
  }

  /** What navigator.credentials.get() sends back. */
  get(o: { challenge: string; origin: string; rpId: string; type?: string; clientExtra?: Record<string, unknown> }) {
    const authData = this.authData(o.rpId, false);
    const clientData = this.clientData(o.type ?? 'webauthn.get', o.challenge, o.origin, o.clientExtra);
    const data = Buffer.concat([authData, sha256(clientData)]);
    const signature = this.alg === 'EdDSA' ? sign(null, data, this.key) : sign('sha256', data, this.key);
    return { id: b64u(this.credentialId), clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature) };
  }
}
