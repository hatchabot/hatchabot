import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('checks both a named UI script and each scenario without treating scenarios as files', () => {
  const root = mkdtempSync(join(tmpdir(), 'hb-coverage-'));
  try {
    for (const d of ['scripts', 'docs', 'test']) mkdirSync(join(root, d));
    copyFileSync('scripts/use-case-coverage.mjs', join(root, 'scripts/use-case-coverage.mjs'));
    writeFileSync(join(root, 'scripts/ui-clickthrough.mjs'), 'home: async () => {},\nheaderDoors: async () => {}');
    const run = (ref: string) => {
      writeFileSync(join(root, 'docs/use-cases.md'), `| J2 | Doors | UI | auto(${ref}) |\n`);
      return spawnSync(process.execPath, [join(root, 'scripts/use-case-coverage.mjs'), '--check'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root } });
    };
    expect(run('ui-clickthrough: home, headerDoors').status).toBe(0);
    expect(run('ui-clickthrough: home, missing').status).toBe(1);
    expect(run('missing-script: home').status).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
