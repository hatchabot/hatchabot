import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * .gitignore leaves the code alone (HB-1528): its `data/`, meant for the data
 * folder at the repository's root, matched src/api/data, the data routes'
 * folder since HB-0874, and a new file there was left out of `git add -A`
 * without a word. Read with the repository's own rules only, whatever the copy
 * of the code is (a work tree or not, as a review's archive is): its .gitignore
 * in a repository of the test's own, made with no global or system git config,
 * a HOME of its own (a global excludes file is read from there) and hooks off,
 * over empty files at the paths src/ has on disk, and a new one in each folder.
 */
const ROOT = resolve(__dirname, '..');
const scratch = mkdtempSync(join(tmpdir(), 'hb-gitignore-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const home = join(scratch, 'home'), repo = join(scratch, 'repo');
const git = (args: string[], input?: string) => spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
  cwd: repo, input, encoding: 'utf8',
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
});
/** Every file under `dir`, as a path from the code's root. */
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [relative(ROOT, join(dir, e.name))] : []));

describe('.gitignore (HB-1528)', () => {
  mkdirSync(home); mkdirSync(repo);
  expect(git(['init', '-q']).status).toBe(0);
  copyFileSync(join(ROOT, '.gitignore'), join(repo, '.gitignore'));
  const there = walk(join(ROOT, 'src'));
  const fresh = [...new Set(there.map((p) => dirname(p)))].map((d) => `${d}/hb-new-file.ts`);
  for (const p of [...there, ...fresh]) { mkdirSync(join(repo, dirname(p)), { recursive: true }); writeFileSync(join(repo, p), ''); }

  it('ignores no file under src/, there now or new in any of its folders', () => {
    expect(there.length).toBeGreaterThan(100);
    expect(there).toContain('src/api/data/skillRoutes.ts');
    // --no-index: judged by the rules alone, as a file not yet added is.
    const r = git(['check-ignore', '--no-index', '-v', '--stdin'], [...there, ...fresh].join('\n') + '\n');
    expect(r.stdout, 'ignored under src/').toBe('');
    expect(r.status, r.stderr).toBe(1); // 1: none of them is ignored
  });

  it('still ignores the data folder at the root', () => {
    for (const p of ['data/x', 'data/hatchabot.sqlite', 'data/embed/keys.json', 'data/derived-builds/_base.log']) {
      expect(git(['check-ignore', '--no-index', '-q', p]).status, p).toBe(0);
    }
  });
});
