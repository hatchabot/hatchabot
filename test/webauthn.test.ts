import { describe, expect, it } from 'vitest';
import { cborDecode, parseAuthenticatorData, verifyAssertion, verifyRegistration, WebAuthnError } from '../src/api/webauthn.js';
import { SoftAuthenticator, cborEncode, type Alg } from './helpers/softAuthenticator.js';

const rpId = 'box.example.com';
const origin = 'https://box.example.com:8443';
const exp = (challenge: string) => ({ challenge, origins: [origin, 'https://box.example.com'], rpId });
const refuses = (fn: () => unknown, why: RegExp) => { expect(fn).toThrow(WebAuthnError); expect(fn).toThrow(why); };

describe('CBOR reader', () => {
  it('RFC 8949 Appendix A examples', () => {
    const hex = (h: string) => cborDecode(Buffer.from(h, 'hex')).value;
    expect(hex('00')).toBe(0);
    expect(hex('17')).toBe(23);
    expect(hex('1818')).toBe(24);
    expect(hex('1903e8')).toBe(1000);
    expect(hex('1a000f4240')).toBe(1000000);
    expect(hex('20')).toBe(-1);
    expect(hex('3863')).toBe(-100);
    expect(hex('3903e7')).toBe(-1000);
    expect(hex('6449455446')).toBe('IETF');
    expect((hex('4401020304') as Buffer).toString('hex')).toBe('01020304');
    expect(hex('83010203')).toEqual([1, 2, 3]);
    expect(hex('f4')).toBe(false);
    expect(hex('f5')).toBe(true);
    expect(hex('f6')).toBe(null);
    const m = hex('a201020304') as Map<number, number>;
    expect([...m]).toEqual([[1, 2], [3, 4]]);
    const m2 = hex('a26161016162820203') as Map<string, unknown>;
    expect(m2.get('a')).toBe(1);
    expect(m2.get('b')).toEqual([2, 3]);
  });

  it('refuses what an authenticator never sends: truncation, indefinite lengths, absurd nesting', () => {
    for (const bad of ['', '18', '19ff', '5803aabb', '6261', '8301', 'a10102'.slice(0, 4), '5f4101ff', '9f01ff', 'bf6161f4ff']) {
      expect(() => cborDecode(Buffer.from(bad, 'hex')), bad).toThrow(WebAuthnError);
    }
    expect(() => cborDecode(Buffer.from('81'.repeat(20) + '00', 'hex'))).toThrow(/nested/);
    expect(() => cborDecode(Buffer.from('98ff', 'hex'))).toThrow(/too long|truncated/);
  });
});

describe('passkeys: registration and sign-in, for each key type', () => {
  for (const alg of ['ES256', 'RS256', 'EdDSA'] as Alg[]) {
    it(`${alg}: registers, then signs in; the counter moves forward`, () => {
      const a = new SoftAuthenticator(alg);
      const cred = verifyRegistration(a.create({ challenge: 'c1', origin, rpId }), exp('c1'));
      expect(cred.credentialId).toBe(a.credentialId.toString('base64url'));
      expect(cred.signCount).toBe(1);
      const r = verifyAssertion(a.get({ challenge: 'c2', origin, rpId }), { publicKey: cred.publicKey, signCount: cred.signCount }, exp('c2'));
      expect(r.signCount).toBe(2);
      expect(r.userVerified).toBe(true);
      // The stored key survives a round trip through JSON (how it is kept).
      const stored = JSON.parse(JSON.stringify(cred.publicKey));
      expect(verifyAssertion(a.get({ challenge: 'c3', origin, rpId }), { publicKey: stored, signCount: 2 }, exp('c3')).signCount).toBe(3);
    });
  }

  it('a passkey that syncs (counter always 0) keeps working', () => {
    const a = new SoftAuthenticator('ES256', false);
    const cred = verifyRegistration(a.create({ challenge: 'c1', origin, rpId }), exp('c1'));
    expect(cred.signCount).toBe(0);
    expect(verifyAssertion(a.get({ challenge: 'c2', origin, rpId }), { publicKey: cred.publicKey, signCount: 0 }, exp('c2')).signCount).toBe(0);
  });
});

describe('passkeys: what is refused', () => {
  const a = new SoftAuthenticator('ES256');
  const cred = verifyRegistration(a.create({ challenge: 'reg', origin, rpId }), exp('reg'));
  const stored = () => ({ publicKey: cred.publicKey, signCount: a.signCount - 0 });
  const fresh = () => ({ publicKey: cred.publicKey, signCount: 0 });

  it('another challenge (a replayed answer)', () => {
    refuses(() => verifyAssertion(a.get({ challenge: 'old', origin, rpId }), fresh(), exp('new')), /challenge/);
    refuses(() => verifyRegistration(new SoftAuthenticator().create({ challenge: 'old', origin, rpId }), exp('new')), /challenge/);
  });

  it('another origin (a phishing page, or http)', () => {
    for (const bad of ['https://box.example.com.evil.example', 'http://box.example.com:8443', 'https://evil.example', 'https://box.example.com:9999']) {
      refuses(() => verifyAssertion(a.get({ challenge: 'c', origin: bad, rpId }), fresh(), exp('c')), /origin/);
      refuses(() => verifyRegistration(new SoftAuthenticator().create({ challenge: 'c', origin: bad, rpId }), exp('c')), /origin/);
    }
  });

  it('another site\'s RP ID', () => {
    refuses(() => verifyAssertion(a.get({ challenge: 'c', origin, rpId: 'evil.example' }), fresh(), exp('c')), /RP ID/);
    refuses(() => verifyRegistration(new SoftAuthenticator().create({ challenge: 'c', origin, rpId: 'evil.example' }), exp('c')), /RP ID/);
  });

  it('the wrong ceremony: a registration answer where a sign-in is expected, and the reverse', () => {
    refuses(() => verifyAssertion(a.get({ challenge: 'c', origin, rpId, type: 'webauthn.create' }), fresh(), exp('c')), /type/);
    const r = a.get({ challenge: 'c', origin, rpId });
    refuses(() => verifyRegistration({ clientDataJSON: r.clientDataJSON, attestationObject: '' }, exp('c')), /type/);
  });

  it('cross-origin use (an iframe on another site)', () => {
    refuses(() => verifyAssertion(a.get({ challenge: 'c', origin, rpId, clientExtra: { crossOrigin: true } }), fresh(), exp('c')), /cross-origin/);
  });

  it('no user presence; no user verification when it is required', () => {
    const b = new SoftAuthenticator('ES256');
    const c = verifyRegistration(b.create({ challenge: 'r', origin, rpId }), exp('r'));
    b.userPresent = false;
    refuses(() => verifyAssertion(b.get({ challenge: 'c', origin, rpId }), { publicKey: c.publicKey, signCount: 0 }, exp('c')), /presence/);
    b.userPresent = true; b.extraFlags = 0;
    refuses(() => verifyAssertion(b.get({ challenge: 'c', origin, rpId }), { publicKey: c.publicKey, signCount: 0 }, { ...exp('c'), requireUserVerification: true }), /verification/);
    expect(verifyAssertion(b.get({ challenge: 'c', origin, rpId }), { publicKey: c.publicKey, signCount: 0 }, exp('c')).userVerified).toBe(false);
  });

  it('a signature from another key, a tampered signature, tampered authenticator data', () => {
    const other = new SoftAuthenticator('ES256');
    refuses(() => verifyAssertion(other.get({ challenge: 'c', origin, rpId }), fresh(), exp('c')), /signature/);
    const r = a.get({ challenge: 'c', origin, rpId });
    const sig = Buffer.from(r.signature, 'base64url'); sig[sig.length - 1]! ^= 1;
    refuses(() => verifyAssertion({ ...r, signature: sig.toString('base64url') }, fresh(), exp('c')), /signature/);
    const ad = Buffer.from(r.authenticatorData, 'base64url'); ad[36]! ^= 0x7f; // the counter
    refuses(() => verifyAssertion({ ...r, authenticatorData: ad.toString('base64url') }, fresh(), exp('c')), /signature/);
    refuses(() => verifyAssertion({ ...r, signature: '' }, fresh(), exp('c')), /signature/);
    // An RS256 key offered an ES256 signature, and the reverse.
    const rsa = new SoftAuthenticator('RS256');
    const rc = verifyRegistration(rsa.create({ challenge: 'r', origin, rpId }), exp('r'));
    refuses(() => verifyAssertion(a.get({ challenge: 'c', origin, rpId }), { publicKey: rc.publicKey, signCount: 0 }, exp('c')), /signature/);
  });

  it('a counter that does not move forward (a copied key)', () => {
    const r = a.get({ challenge: 'c', origin, rpId });
    const now = a.signCount;
    refuses(() => verifyAssertion(r, { publicKey: cred.publicKey, signCount: now }, exp('c')), /counter/);
    refuses(() => verifyAssertion(a.get({ challenge: 'c', origin, rpId }), { publicKey: cred.publicKey, signCount: now + 50 }, exp('c')), /counter/);
    // A key that used to count and now reports 0: also a regression.
    const zero = new SoftAuthenticator('ES256', false);
    const zc = verifyRegistration(zero.create({ challenge: 'r', origin, rpId }), exp('r'));
    refuses(() => verifyAssertion(zero.get({ challenge: 'c', origin, rpId }), { publicKey: zc.publicKey, signCount: 7 }, exp('c')), /counter/);
    void stored;
  });

  it('malformed input is a refusal, never a crash', () => {
    for (const bad of [{}, { clientDataJSON: '!!', attestationObject: 'AA' }, { clientDataJSON: Buffer.from('not json').toString('base64url'), attestationObject: 'AA' }]) {
      expect(() => verifyRegistration(bad as never, exp('c'))).toThrow(WebAuthnError);
    }
    const ok = new SoftAuthenticator().create({ challenge: 'c', origin, rpId });
    expect(() => verifyRegistration({ ...ok, attestationObject: cborEncode(new Map([['fmt', 'none']])).toString('base64url') }, exp('c'))).toThrow(/authenticator data/);
    expect(() => verifyRegistration({ ...ok, attestationObject: cborEncode('text').toString('base64url') }, exp('c'))).toThrow(/not a map/);
    expect(() => parseAuthenticatorData(Buffer.alloc(10))).toThrow(/too short/);
    // The "attested data" flag with nothing behind it.
    const short = Buffer.concat([Buffer.alloc(32), Buffer.from([0x41]), Buffer.alloc(4)]);
    expect(() => parseAuthenticatorData(short)).toThrow(WebAuthnError);
    // A sign-in answer with no credential is not a registration.
    const g = new SoftAuthenticator().get({ challenge: 'c', origin, rpId });
    const cd = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: 'c', origin })).toString('base64url');
    const att = cborEncode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', Buffer.from(g.authenticatorData, 'base64url')]])).toString('base64url');
    expect(() => verifyRegistration({ clientDataJSON: cd, attestationObject: att }, exp('c'))).toThrow(/no credential/);
  });

  it('weak or unknown keys are not enrolled', () => {
    class Weak extends SoftAuthenticator { override coseKey(): Buffer { return cborEncode(new Map<number, unknown>([[1, 3], [3, -257], [-1, Buffer.alloc(128, 1)], [-2, Buffer.from([1, 0, 1])]])); } }
    expect(() => verifyRegistration(new Weak().create({ challenge: 'c', origin, rpId }), exp('c'))).toThrow(/2048/);
    class Odd extends SoftAuthenticator { override coseKey(): Buffer { return cborEncode(new Map<number, unknown>([[1, 2], [3, -35], [-1, 2], [-2, Buffer.alloc(48)], [-3, Buffer.alloc(48)]])); } }
    expect(() => verifyRegistration(new Odd().create({ challenge: 'c', origin, rpId }), exp('c'))).toThrow(/unsupported/);
  });
});
