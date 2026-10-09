import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * A test that runs one of the real shell scripts builds the script's
 * environment from scratch (test/helpers/scriptEnv.ts). Spread in from
 * process.env, a HATCHABOT_DB or HATCHABOT_BACKUP_DIR exported in the shell
 * that ran `npm test` reached the script — and uninstall.sh --purge would have
 * deleted that real data directory (review, 2026-10-09).
 */
describe('script tests stay in their sandbox', () => {
  it('no test that runs install.sh or a scripts/*.sh hands it process.env', () => {
    const offenders = readdirSync('test')
      .filter((f) => f.endsWith('.test.ts') && f !== 'scriptTestsSandbox.test.ts')
      .filter((f) => {
        const src = readFileSync(`test/${f}`, 'utf8');
        return /scripts\/[\w-]+\.sh|scripts', '[\w-]+\.sh|\binstall\.sh\b/.test(src) && /\.\.\.process\.env\b/.test(src);
      });
    expect(offenders).toEqual([]);
  });
});
