import { timingSafeEqual } from 'node:crypto';

/** A value's bytes, if it has any to compare: a string (as UTF-8) or an ArrayBuffer view. */
const bytesOf = (v: unknown): NodeJS.ArrayBufferView | undefined =>
  typeof v === 'string' ? Buffer.from(v, 'utf8') : ArrayBuffer.isView(v) ? (v as NodeJS.ArrayBufferView) : undefined;

/**
 * Are two secrets the same? Strings are compared as their UTF-8 bytes, in
 * constant time when the lengths match. Bytes, not characters: 64 accented
 * letters are 64 characters but 128 bytes, and timingSafeEqual throws on a
 * length mismatch, so a check of character counts let a malformed value
 * through to a 500 instead of a plain "no" (audit, 2026-10-22; HB-0602).
 * Anything else — a number, null, an array or object from a JSON body — is
 * never equal: timingSafeEqual throws on those too.
 */
export function safeEqual(a: unknown, b: unknown): boolean {
  const x = bytesOf(a), y = bytesOf(b);
  return !!x && !!y && x.byteLength === y.byteLength && timingSafeEqual(x, y);
}
