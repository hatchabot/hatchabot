import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * .gitleaks.toml (the CI "secrets" job). Its allowlist was a word list
 * ("fake|example|…") matched against the whole assignment, so a setting whose
 * name held one of those words hid a real-looking value beside it (audit issue
 * #42, 2026-10-09). Now each exception is an exact fixture value, for one rule,
 * in the files that hold it. The behaviour itself is checked by
 * scripts/gitleaks-regression.sh, which CI runs with the pinned binary; here
 * it runs too when a gitleaks binary is on hand (HB_GITLEAKS, or on PATH).
 */
const ROOT = join(__dirname, '..');
const config = readFileSync(join(ROOT, '.gitleaks.toml'), 'utf8');
/** Each [[…allowlists]] block, as text. */
const blocks = config.split(/^\[\[/m).filter((b) => /^(rules\.)?allowlists\]\]/.test(b));

describe('.gitleaks.toml exceptions', () => {
  it('has no word list: nothing like fake|example|made-up matched against a whole match', () => {
    expect(config).not.toMatch(/regexTarget\s*=\s*"match"/);
    expect(config).not.toMatch(/'''[^']*\b(fake|example|made-?up)\b[^']*\|/i);
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('every exception is an exact value, for one rule, and only in named files', () => {
    for (const b of blocks) {
      expect(b, b).toMatch(/^rules\.allowlists\]\]/); // under a [[rules]] id: one rule, not all of them
      expect(b, b).toMatch(/condition\s*=\s*"AND"/);
      expect(b, b).toMatch(/paths\s*=\s*\['''\^\(?[^']+\$'''\]/);
      expect(b, b).toMatch(/regexTarget\s*=\s*"secret"/);
      for (const re of b.match(/regexes\s*=\s*\[[\s\S]*?\]/)![0].match(/'''[^']*'''/g)!) expect(re, b).toMatch(/^'''\^.*\$'''$/);
    }
  });

  const bin = process.env.HB_GITLEAKS || (spawnSync('sh', ['-c', 'command -v gitleaks'], { encoding: 'utf8' }).stdout.trim() || '');
  it.skipIf(!bin)('reports ordinary values whatever they are called; keeps known fixtures quiet only where they live', () => {
    const r = spawnSync('bash', [join(ROOT, 'scripts', 'gitleaks-regression.sh'), bin], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});
