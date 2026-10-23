import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Every test here runs real shell scripts (git, bash, a fake gh) in a sandbox. On the
// self-hosted runner CI shares the machine with other work, and vitest's 5 s was not
// enough under load (land, promote, release, first-run-link; 2026-10-23).
vi.setConfig({ testTimeout: 30_000 });

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
