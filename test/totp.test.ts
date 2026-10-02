import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, newBackupCode, normalizeBackupCode, backupCodeHash, otpauthUri, totp, totpStep, totpVerify } from '../src/api/totp.js';

describe('HOTP / TOTP (RFC 4226, RFC 6238 test vectors)', () => {
  const seed = Buffer.from('12345678901234567890', 'ascii');

  it('RFC 4226 Appendix D: the ten HOTP values', () => {
    const want = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expect(want.map((_, i) => hotp(seed, i))).toEqual(want);
  });

  it('RFC 6238 Appendix B: SHA-1, SHA-256 and SHA-512, eight digits', () => {
    const s256 = Buffer.from('12345678901234567890123456789012', 'ascii');
    const s512 = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'ascii');
    const rows: Array<[number, string, string, string]> = [
      [59, '94287082', '46119246', '90693936'],
      [1111111109, '07081804', '68084774', '25091201'],
      [1111111111, '14050471', '67062674', '99943326'],
      [1234567890, '89005924', '91819424', '93441116'],
      [2000000000, '69279037', '90698825', '38618901'],
      [20000000000, '65353130', '77737706', '47863826'],
    ];
    for (const [t, a, b, c] of rows) {
      expect(totp(seed, t * 1000, 8, 'sha1'), `sha1 @${t}`).toBe(a);
      expect(totp(s256, t * 1000, 8, 'sha256'), `sha256 @${t}`).toBe(b);
      expect(totp(s512, t * 1000, 8, 'sha512'), `sha512 @${t}`).toBe(c);
    }
  });

  it('base32 (RFC 4648 vectors), both ways, any case and spacing', () => {
    const rows: Array<[string, string]> = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
    for (const [plain, enc] of rows) {
      expect(base32Encode(Buffer.from(plain))).toBe(enc);
      expect(base32Decode(enc).toString()).toBe(plain);
    }
    expect(base32Decode('mzxw 6ytb-oi==').toString()).toBe('foobar');
    expect(base32Encode(seed)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(() => base32Decode('not base32!')).toThrow();
  });

  it('accepts this step and its neighbours, and nothing else', () => {
    const at = 1_700_000_000_000;
    for (const d of [-30_000, 0, 30_000]) expect(totpVerify(seed, totp(seed, at + d), { atMs: at })).toBe(totpStep(at + d));
    expect(totpVerify(seed, totp(seed, at + 60_000), { atMs: at })).toBeUndefined();
    expect(totpVerify(seed, totp(seed, at - 60_000), { atMs: at })).toBeUndefined();
    expect(totpVerify(seed, '12345', { atMs: at })).toBeUndefined();
    expect(totpVerify(seed, 'abcdef', { atMs: at })).toBeUndefined();
    expect(totpVerify(seed, '', { atMs: at })).toBeUndefined();
    expect(totpVerify(Buffer.from('another secret here!'), totp(seed, at), { atMs: at })).toBeUndefined();
  });

  it('a code is good once: the same step, or an earlier one, is refused afterwards', () => {
    const at = 1_700_000_000_000;
    const step = totpVerify(seed, totp(seed, at), { atMs: at })!;
    expect(totpVerify(seed, totp(seed, at), { atMs: at, lastStep: step })).toBeUndefined();
    expect(totpVerify(seed, totp(seed, at - 30_000), { atMs: at, lastStep: step })).toBeUndefined();
    expect(totpVerify(seed, totp(seed, at + 30_000), { atMs: at, lastStep: step })).toBe(step + 1);
  });

  it('the QR holds a standard otpauth address', () => {
    const u = new URL(otpauthUri(seed, 'chris'));
    expect(u.protocol).toBe('otpauth:');
    expect(decodeURIComponent(u.pathname)).toContain('Hatchabot:chris');
    expect(u.searchParams.get('secret')).toBe(base32Encode(seed));
    expect(u.searchParams.get('digits')).toBe('6');
    expect(u.searchParams.get('period')).toBe('30');
  });

  it('backup codes: twelve unambiguous characters, hashed per person, any typing', () => {
    const codes = new Set(Array.from({ length: 200 }, () => newBackupCode()));
    expect(codes.size).toBe(200);
    for (const c of codes) expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTVWXYZ2-9]{4}$/);
    const key = Buffer.alloc(32, 3);
    const [c] = codes;
    expect(backupCodeHash(key, 'a', c!.toLowerCase().replace(/-/g, ' '))).toBe(backupCodeHash(key, 'a', c!));
    expect(backupCodeHash(key, 'b', c!)).not.toBe(backupCodeHash(key, 'a', c!));
    expect(normalizeBackupCode(' ab-cd ')).toBe('ABCD');
  });
});
