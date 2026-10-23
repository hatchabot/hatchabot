import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

// Every test here runs real shell scripts (git, bash, a fake gh) in a sandbox. On the
// self-hosted runner CI shares the machine with other work, and vitest's 5 s was not
// enough under load (land, promote, release, first-run-link; 2026-10-23).
vi.setConfig({ testTimeout: 30_000 });

/**
 * Which releases scripts/upgrade-check.sh upgrades from by default (--list:
 * it names them and checks nothing), in a throwaway repo: a temp HOME, hooks
 * off. It took the tag before the newest, so from a pull request or a version
 * commit — always past the newest tag — it skipped the release installs run
 * (audit, 2026-10-20).
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'hb-upgrade-check-')); dirs.push(root);
  const home = join(root, 'home'); mkdirSync(home);
  const work = join(root, 'work'); mkdirSync(join(work, 'scripts'), { recursive: true });
  const env = scriptEnv(home, '/usr/bin:/bin');
  let n = 0;
  const git = (...args: string[]) => {
    // Each tag a second apart: the script orders them by creation date.
    const at = `${1760000000 + n++} +0000`;
    const r = spawnSync('git', args, { cwd: work, env: { ...env, GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  writeFileSync(join(work, 'scripts', 'upgrade-check.sh'), readFileSync('scripts/upgrade-check.sh'), { mode: 0o755 });
  git('init', '-q', '-b', 'main');
  const release = (tag: string) => {
    writeFileSync(join(work, 'v.txt'), tag); git('add', '.'); git('commit', '-q', '-m', tag); git('tag', '-a', tag, '-m', tag);
  };
  for (const t of ['v1.0.0', 'v2.0.0', 'v2.5.0', 'v2.6.0']) release(t);
  const list = () => {
    const r = spawnSync('bash', [join(work, 'scripts', 'upgrade-check.sh'), '--list'], { cwd: work, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stdout + r.stderr);
    return r.stdout.trim().split('\n');
  };
  return { git, release, list, work };
}

describe('scripts/upgrade-check.sh upgrades from the release installs run now', () => {
  it('past the newest tag (a pull request, a version commit): the newest tag', () => {
    const w = repo();
    writeFileSync(join(w.work, 'next.txt'), 'x'); w.git('add', '.'); w.git('commit', '-q', '-m', 'next');
    expect(w.list()).toEqual(['v1.0.0', 'v2.0.0', 'v2.6.0']);
  });

  it('on a release tag itself: the one before it', () => {
    const w = repo();
    expect(w.list()).toEqual(['v1.0.0', 'v2.0.0', 'v2.5.0']);
  });

  it('the newest is v2.0.0: listed once', () => {
    const w = repo();
    writeFileSync(join(w.work, 'next.txt'), 'x'); w.git('add', '.'); w.git('commit', '-q', '-m', 'next');
    w.git('tag', '-d', 'v2.5.0'); w.git('tag', '-d', 'v2.6.0');
    expect(w.list()).toEqual(['v1.0.0', 'v2.0.0']);
  });
});
