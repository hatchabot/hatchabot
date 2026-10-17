import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * .gitleaks.toml (the CI "secrets" job): the default rules and no allowlist.
 * The publisher's gate scans every published file with gitleaks' default rules
 * and ignores this file, so an allowed value would pass CI and then block the
 * release (v2.164.0, 2026-10-17); before that, a word-list allowlist hid
 * real-looking values (audit issue #42, 2026-10-09). The behaviour itself is
 * checked by scripts/gitleaks-regression.sh, which CI runs with the pinned
 * binary; here it runs too when a gitleaks binary is on hand (HB_GITLEAKS, or
 * on PATH).
 */
const ROOT = join(__dirname, '..');
const config = readFileSync(join(ROOT, '.gitleaks.toml'), 'utf8');
const settings = config.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));

describe('.gitleaks.toml', () => {
  it('is the default rules and nothing else: no allowlist, no rule of its own', () => {
    expect(settings).toEqual(['[extend]', 'useDefault = true']);
  });

  const bin = process.env.HB_GITLEAKS || (spawnSync('sh', ['-c', 'command -v gitleaks'], { encoding: 'utf8' }).stdout.trim() || '');
  it.skipIf(!bin)('reports ordinary values whatever they are called, and the old sample values wherever they are', () => {
    const r = spawnSync('bash', [join(ROOT, 'scripts', 'gitleaks-regression.sh'), bin], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});
