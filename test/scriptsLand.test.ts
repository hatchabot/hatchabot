import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

/**
 * scripts/land.sh in a sandbox: a throwaway repo with a local bare "origin",
 * a temp HOME, hooks off, and a fake gh whose merge moves origin's main to
 * the pull request's branch (as a rebase merge would when main has not
 * moved). With `required`, main's rules require checks and GitHub's
 * auto-merge merges; without (the dev repo), land.sh merges once every check
 * passed.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function world(prState: 'merge' | 'fail' | 'close' | 'noauto' | 'green' | 'queued' | 'runsdown' | 'statusdown' | 'statusonly' = 'merge', required = true) {
  const root = mkdtempSync(join(tmpdir(), 'hb-land-')); dirs.push(root);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const origin = join(root, 'origin.git');
  const log = join(root, 'gh.log');
  const merged = join(root, 'merged');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
echo "$*" >> "${log}"
land() { b=$(git --git-dir="${origin}" for-each-ref --format='%(refname:short)' 'refs/heads/land/*' | head -1)
         [ -n "$b" ] && git --git-dir="${origin}" update-ref refs/heads/main "refs/heads/$b"; touch "${merged}"; }
case "$1 $2" in
  "api "*/rules/branches/main) ${required ? `echo 1` : `echo 0`} ;;
  # The Actions API, already through --jq: runs as "id<TAB>status<TAB>name", jobs as "name<TAB>state".
  "api "*/actions/runs/11/jobs*) case "${prState}" in
      noauto|green|statusdown) printf 'test\tpass\nprivacy\tskipping\n' ;;
      fail) printf 'test\tpass\nprivacy\tfail\n' ;;
      *) printf 'test\tpending\n' ;;
    esac ;;
  # A green commit status, or (statusdown) a status read that fails.
  "api "*/status) case "${prState}" in
      statusdown) exit 1 ;;
      runsdown|statusonly) printf 'external\tpass\n' ;;
    esac ;;
  # (after the jobs: in a case pattern ? matches the / of runs/11/jobs too)
  "api "*/actions/runs\?*) case "${prState}" in
      queued) echo "11	queued	CI" ;;
      runsdown) exit 1 ;;
      statusonly) ;;
      *) echo "11	completed	CI" ;;
    esac ;;
  "pr create") echo "https://github.com/example-owner/example/pull/7" ;;
  "pr merge") case "$*" in *--auto*) ${required ? ':' : 'exit 1'} ;; *--disable-auto*) ;; *) land ;; esac ;;
  "pr close") ;;
  "pr view")
    if [ -f "${merged}" ]; then echo 'MERGED noauto'; exit 0; fi
    case "${prState}" in
      merge) land; echo 'MERGED auto' ;;
      close) echo 'CLOSED noauto' ;;
      noauto|green|queued|runsdown|statusdown|statusonly) echo 'OPEN noauto' ;;
      *) echo 'OPEN auto' ;;
    esac ;;
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
    cwd: work, encoding: 'utf8', env: { ...env, HATCHABOT_LAND_POLL_SECS: '0', GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', GIT_CONFIG_KEY_1: 'user.name', GIT_CONFIG_VALUE_1: 'Test', GIT_CONFIG_KEY_2: 'user.email', GIT_CONFIG_VALUE_2: 'test@example.org' },
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

  it('a failed check is named, exit 1, and the pull request is closed so nothing merges later', () => {
    const w = world('fail');
    writeFileSync(join(w.work, 'b.txt'), 'two\n'); w.git(w.work, 'add', 'b.txt'); w.git(w.work, 'commit', '-q', '-m', 'Add b');
    const r = w.land();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Check(s) failed: privacy');
    expect(w.ghLog()).toMatch(/pr merge \S+ --repo \S+ --disable-auto/);
    expect(w.ghLog()).toMatch(/pr close \S+ --repo \S+ --delete-branch/);
  });

  it('no required checks (the dev repo): waits for every check to pass, skipped ones too, then merges itself', () => {
    const w = world('green', false);
    writeFileSync(join(w.work, 'b.txt'), 'two\n'); w.git(w.work, 'add', 'b.txt'); w.git(w.work, 'commit', '-q', '-m', 'Add b');
    const r = w.land();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('merging it (rebase) here once every check has passed');
    expect(w.ghLog()).not.toContain('--auto');
    expect(w.ghLog()).toMatch(/pr merge \S+ --repo \S+ --rebase --delete-branch/);
    expect(w.git(w.work, 'rev-parse', 'HEAD')).toBe(w.git(w.origin, 'rev-parse', 'main'));
  });

  it('a run not started yet keeps it waiting: never merged, exit 3 at the timeout', () => {
    const w = world('queued', false);
    writeFileSync(join(w.work, 'b.txt'), 'two\n'); w.git(w.work, 'add', 'b.txt'); w.git(w.work, 'commit', '-q', '-m', 'Add b');
    const r = w.land('--timeout', '0');
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stderr).toContain('Still waiting');
    expect(w.ghLog()).not.toMatch(/pr merge \S+ --repo \S+ --rebase/);
    expect(w.ghLog()).toMatch(/api repos\/\S+\/actions\/runs\?branch=land\/\S+&head_sha=[0-9a-f]{40}/);
  });

  // A read that fails is pending, never nothing: the other source's green
  // alone passed the gate, and land.sh is the dev repo's only gate (A01).
  for (const [state, why] of [
    ['runsdown', 'the Actions runs cannot be read, though a commit status is green'],
    ['statusdown', 'the commit statuses cannot be read, though every job passed'],
    ['statusonly', 'no Actions run yet, only a green commit status'],
  ] as const) {
    it(`${why}: never merged, exit 3 at the timeout`, () => {
      const w = world(state, false);
      writeFileSync(join(w.work, 'b.txt'), 'two\n'); w.git(w.work, 'add', 'b.txt'); w.git(w.work, 'commit', '-q', '-m', 'Add b');
      const r = w.land('--timeout', '0');
      expect(r.status, r.stdout + r.stderr).toBe(3);
      expect(r.stderr).toContain('Still waiting');
      expect(w.ghLog()).not.toMatch(/pr merge \S+ --repo \S+ --rebase/);
      expect(w.git(w.origin, 'rev-parse', 'main')).not.toBe(w.git(w.work, 'rev-parse', 'HEAD'));
    });
  }

  it('checks passed but GitHub turned auto-merge off (a rebase it refuses): says so at once, exit 1', () => {
    const w = world('noauto');
    writeFileSync(join(w.work, 'b.txt'), 'two\n'); w.git(w.work, 'add', 'b.txt'); w.git(w.work, 'commit', '-q', '-m', 'Add b');
    const r = w.land();
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('turned auto-merge off');
  });

  it('more than 100 commits is refused before anything is pushed', () => {
    const w = world('merge');
    for (let i = 0; i < 101; i++) w.git(w.work, 'commit', '-q', '--allow-empty', '-m', `c${i}`);
    const r = w.land();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('more than GitHub rebase-merges at once');
    expect(w.ghLog()).toBe('');
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
