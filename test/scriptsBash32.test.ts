import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * macOS runs these with its bash 3.2, which in a Mac's locale reads the bytes
 * of a non-ASCII character right after `$name` as part of the NAME: "$name…"
 * looked up a variable called `name\xe2…` and `set -u` stopped the installer
 * ("name�: unbound variable", 2026-10-06, the first bundle install on a Mac).
 * Write ${name}… instead.
 */
describe('shell scripts run on a Mac (bash 3.2)', () => {
  const files = ['install.sh', ...readdirSync('scripts').filter((f) => f.endsWith('.sh')).map((f) => join('scripts', f))];
  it('no $variable is followed directly by a non-ASCII character', () => {
    const bad: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line)) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 80)}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
