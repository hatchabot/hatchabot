import { describe, expect, it } from 'vitest';
import { slugify } from '../src/orchestrator/provision.js';
import { regexpEscape } from '../src/domain/regexpEscape.js';

/** slugify as it was before HB-0617, with the quadratic `-+$` trim, to compare against. */
const before = (name: string) => name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';

describe('slugify trims one dash at each end, with no quadratic regexp (HB-0617)', () => {
  it('gives what the regexp version gave, on fixed cases and a seeded fuzz set', () => {
    const fixed = ['', ' ', '-', '---', 'Kitchen Helper', '  Garden  ', '--a--', 'a-b', 'Ünïcode name', '!!!', 'x!', '!x', 'A  B__C', '9 lives'];
    for (const s of fixed) expect(slugify(s), JSON.stringify(s)).toBe(before(s));
    const alphabet = 'aZ9 -_!é\t.';
    // xorshift32: plain multiplication past 2^53 loses its low bits and repeats a few shapes.
    let seed = 0x9e3779b9;
    const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      let s = '';
      for (let n = next() % 12; n > 0; n--) s += alphabet[next() % alphabet.length];
      seen.add(s);
      expect(slugify(s), JSON.stringify(s)).toBe(before(s));
    }
    // Lengths 0–11: the short ones repeat (one empty, ten of length 1); the long ones don't.
    expect(seen.size).toBeGreaterThan(3500);
    for (const ch of alphabet) expect([...seen].some((s) => s.includes(ch)), ch).toBe(true);
  });
});

describe('regexpEscape (HB-0619)', () => {
  it('matches every metacharacter as itself', () => {
    const s = 'v1.2+build*(x)?[y]{3}|^$\\/-z';
    expect(new RegExp(`^${regexpEscape(s)}$`).test(s)).toBe(true);
    expect(new RegExp(`^${regexpEscape('1.2')}$`).test('1x2')).toBe(false);
    // Usable under the u flag too, a version's '-' included.
    expect(new RegExp(`^${regexpEscape('2026.10.1-2/x')}$`, 'u').test('2026.10.1-2/x')).toBe(true);
  });
});
