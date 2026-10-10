import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

/**
 * scripts/land.sh in a sandbox: a throwaway repo with a local bare "origin",
 * a temp HOME, hooks off, and a fake gh whose "merge" moves origin's main to
 * the pull request's branch (as a rebase merge would when main has not moved).
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function world(prState: 'merge' | 'fail' | 'close' = 'merge') {
  const root = mkdtempSync(join(tmpdir(), 'hb-land-')); dirs.push(root);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const origin = join(root, 'origin.git');
  const log = join(root, 'gh.log');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "pr create") echo "https://github.com/example-owner/example/pull/7" ;;
  "pr merge") ;;
  "pr view")
    case "${prState}" in
      merge) b=$(git --git-dir="${origin}" for-each-ref --format='%(refname:short)' 'refs/heads/land/*' | head -1)
             [ -n "$b" ] && git --git-dir="${origin}" update-ref refs/heads/main "refs/heads/$b"; echo MERGED ;;
      close) echo CLOSED ;;
      *) echo OPEN ;;
    esac ;;
  # Like gh: exit 8 while checks are still pending.
  "pr checks") if [ "${prState}" = fail ]; then printf 'test\tpass\t1m\turl\nprivacy\tfail\t8s\turl\n'; exit 1; else printf 'test\tpending\t0\turl\n'; exit 8; fi ;;
esac
`, { mode: 0o755 });
  const env = scriptEnv(join(root, 'home'), `${bin}:/usr/bin:/bin`, {});
  mkdirSync(join(root, 'home'), { recursive: true });
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.org', ...args], { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const work = join(root, 'work'); mkdirSync(join(work, 'scripts'), { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, 'scripts', 'land.sh'), readFileSync('scripts/land.sh'), { mode: 0o755 });
  writeFileSync(join(work, 'a.txt'), 'one\n');
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'start');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', 'main');
  const land = (...args: string[]) => spawnSync('bash', [join(work, 'scripts', 'land.sh'), ...args], {
    cwd: work, encoding: 'utf8', env: { ...env, GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', GIT_CONFIG_KEY_1: 'user.name', GIT_CONFIG_VALUE_1: 'Test', GIT_CONFIG_KEY_2: 'user.email', GIT_CONFIG_VALUE_2: 'test@example.org' },
  });
  const ghLog = () => { try { return readFileSync(log, 'utf8'); } catch { return ''; } };
  return { work, origin, git, land, ghLog };
}

describe('scripts/land.sh lands commits on main through a pull request', () => {
  it('pushes a branch, opens the pull request, asks for a rebase merge, and brings main to what landed', () => {
    const w = world('merge');
    writeFileSync(join(w.work, 'b.txt'), 'two\n'); w.git(w.work, 'add', 'b.txt'); w.git(w.work, 'commit', '-q', '-m', 'Add b');
    writeFileSync(join(w.work, 'scratch.txt'), 'not committed\n'); // work in progress stays put
    const r = w.land('--footer', 'Made by a test');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('✓ landed 1 commit(s): https://github.com/example-owner/example/pull/7');
    expect(w.ghLog()).toMatch(/pr create --repo .* --base main --head land\/\S+ --title Add b --body - Add b\s+Made by a test/);
    expect(w.ghLog()).toMatch(/pr merge \S+ --repo \S+ --auto --rebase --delete-branch/);
    expect(w.git(w.work, 'rev-parse', 'HEAD')).toBe(w.git(w.origin, 'rev-parse', 'main'));
    expect(readFileSync(join(w.work, 'scratch.txt'), 'utf8')).toBe('not committed\n');
  });

  it('nothing to land: says so and does nothing', () => {
    const w = world('merge');
    const r = w.land();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Nothing to land');
    expect(w.ghLog()).toBe('');
  });

  it('a failed check is named, exit 1, and the pull request is left open', () => {
    const w = world('fail');
    writeFileSync(join(w.work, 'b.txt'), 'two\n'); w.git(w.work, 'add', 'b.txt'); w.git(w.work, 'commit', '-q', '-m', 'Add b');
    const r = w.land();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Check(s) failed: privacy');
  });

  it('a closed pull request is exit 1; a main that moved on is refused before pushing anything', () => {
    const closed = world('close');
    writeFileSync(join(closed.work, 'b.txt'), 'two\n'); closed.git(closed.work, 'add', 'b.txt'); closed.git(closed.work, 'commit', '-q', '-m', 'Add b');
    expect(closed.land().status).toBe(1);

    const behind = world('merge');
    // Someone else landed a commit meanwhile.
    behind.git(behind.work, 'commit', '-q', '--allow-empty', '-m', 'elsewhere');
    behind.git(behind.work, 'push', '-q', 'origin', 'main');
    behind.git(behind.work, 'reset', '-q', '--hard', 'HEAD~1');
    writeFileSync(join(behind.work, 'b.txt'), 'two\n'); behind.git(behind.work, 'add', 'b.txt'); behind.git(behind.work, 'commit', '-q', '-m', 'Add b');
    const r = behind.land();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('main moved on');
    expect(behind.ghLog()).toBe('');
  });
});
