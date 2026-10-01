import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Authenticator-app codes: HOTP (RFC 4226) and TOTP (RFC 6238), with
 * node:crypto and nothing else. SHA-1, six digits, 30-second steps: what every
 * authenticator app accepts from a QR code without options.
 */
export const TOTP_STEP_S = 30;
export const TOTP_DIGITS = 6;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    value &= (1 << bits) - 1; // keep only the bits not yet written: no overflow on long inputs
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

/** RFC 4226 §5.3. `algo` is only for the RFC 6238 test vectors; the app uses SHA-1. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS, algo: 'sha1' | 'sha256' | 'sha512' = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algo, secret).update(msg).digest();
  const off = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[off]! & 0x7f) << 24) | (mac[off + 1]! << 16) | (mac[off + 2]! << 8) | mac[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const totpStep = (atMs: number): number => Math.floor(atMs / 1000 / TOTP_STEP_S);

export function totp(secret: Buffer, atMs = Date.now(), digits = TOTP_DIGITS, algo: 'sha1' | 'sha256' | 'sha512' = 'sha1'): string {
  return hotp(secret, totpStep(atMs), digits, algo);
}

/**
 * Check a typed code: this step, the one before and the one after (a phone's
 * clock is never exact). Returns the step it matched, so the caller can refuse
 * that step and every earlier one from then on: a code read over a shoulder,
 * or caught on the wire, cannot be used a second time.
 */
export function totpVerify(secret: Buffer, code: string, opts: { atMs?: number; lastStep?: number } = {}): number | undefined {
  const typed = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) return undefined;
  const now = totpStep(opts.atMs ?? Date.now());
  let matched: number | undefined;
  // Every candidate is computed and compared, whichever matches.
  for (const step of [now - 1, now, now + 1]) {
    const want = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(want, Buffer.from(typed)) && matched === undefined) matched = step;
  }
  if (matched === undefined) return undefined;
  if (opts.lastStep !== undefined && matched <= opts.lastStep) return undefined;
  return matched;
}

export const newTotpSecret = (): Buffer => randomBytes(20);

/** What the QR code holds (the Key Uri Format every authenticator reads). */
export function otpauthUri(secret: Buffer, account: string, issuer = 'Hatchabot'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_S}`;
}

/**
 * One-time backup codes, for the day the phone is gone. Twelve characters
 * from an alphabet with no look-alikes: 30^12, about 59 bits, behind the same
 * lockout as the six-digit code. Shown once; only a keyed hash is kept.
 */
const BACKUP_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export function newBackupCode(): string {
  let out = '';
  while (out.length < 12) {
    for (const b of randomBytes(24)) {
      if (b >= 240) continue; // 240 = 8 × 30: keep the draw uniform
      out += BACKUP_ALPHABET[b % 30];
      if (out.length === 12) break;
    }
  }
  return out.match(/.{4}/g)!.join('-');
}
export const normalizeBackupCode = (v: string): string => v.toUpperCase().replace(/[^A-Z0-9]/g, '');
export function backupCodeHash(key: Buffer, ownerId: string, code: string): string {
  return createHmac('sha256', key).update(`backup-code:${ownerId}:${normalizeBackupCode(code)}`).digest('hex');
}
