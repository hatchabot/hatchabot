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
 * scripts/land.sh in a sandbox: a throwaway repo with a local bare "origin",
 * a temp HOME, hooks off, and a fake gh whose merge moves origin's main to
 * the pull request's branch (as a rebase merge would when main has not
 * moved). With `required`, main's rules require checks and GitHub's
 * auto-merge merges; without (the dev repo), land.sh merges once every check
 * passed.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A gitleaks stand-in: finds nothing, a value in the new commits or in the tree, or cannot run. */
type Gitleaks = 'clean' | 'commit-hit' | 'tree-hit' | 'broken';

/** The gitleaks version CI's secrets job pins (the V= of its step), from the real workflow. */
const CI_GITLEAKS = /name: gitleaks on the new commits[\s\S]*?\bV=([0-9][0-9.]*)/.exec(readFileSync('.github/workflows/ci.yml', 'utf8'))![1]!;

function world(prState: 'merge' | 'fail' | 'kitfail' | 'close' | 'noauto' | 'green' | 'queued' | 'runsdown' | 'statusdown' | 'statusonly' | 'stuck' = 'merge', required = true, gitleaks?: Gitleaks, gitleaksVersion = CI_GITLEAKS) {
  const root = mkdtempSync(join(tmpdir(), 'hb-land-')); dirs.push(root);
  const bin = join(root, 'bin'); mkdirSync(bin);
  // Each call logged with where it ran and GITLEAKS_CONFIG; the config it was
  // given is kept, and a dir scan lists its folder and the tree in it.
  const glLog = join(root, 'gitleaks.log');
  if (gitleaks) writeFileSync(join(bin, 'gitleaks'), `#!/bin/sh
[ "$1" != version ] || { echo "${gitleaksVersion}"; exit 0; }
echo "$1|\${GITLEAKS_CONFIG:-unset}|$*" >> "${glLog}"
out=; prev=
for a in "$@"; do
  case "$prev" in --report-path) out="$a" ;; --config) cp "$a" "${root}/config-used" ;; esac
  prev="$a"
done
[ "$1" != dir ] || { ls -A . > "${root}/dir-root"; ls -A tree > "${root}/dir-tree"; }
case "${gitleaks}:$1" in
  broken:*) echo 'FTL unknown flag: --report-template' >&2; exit 1 ;;
  commit-hit:git) printf 'b.txt:1: generic-api-key (commit 0123456789ab)\n' > "$out"; exit 3 ;;
  tree-hit:dir) printf 'tree/b.txt:1: generic-api-key\n' > "$out"; exit 3 ;;
esac
: > "$out"
`, { mode: 0o755 });
  const origin = join(root, 'origin.git');
  const log = join(root, 'gh.log');
  const merged = join(root, 'merged');
  const closed = join(root, 'closed');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
echo "$*" >> "${log}"
land() { b=$(git --git-dir="${origin}" for-each-ref --format='%(refname:short)' 'refs/heads/land/*' | head -1)
         [ -n "$b" ] && git --git-dir="${origin}" update-ref refs/heads/main "refs/heads/$b"; touch "${merged}"; }
case "$1 $2" in
  "api "*/rules/branches/main) ${required ? `echo 1` : `echo 0`} ;;
  # The Actions API, already through --jq: runs as "id<TAB>status<TAB>name", jobs as "name<TAB>state".
  "api "*/actions/runs/11/jobs*) case "${prState}" in
      noauto|green|statusdown) printf 'test\tpass\nprivacy\tskipping\nkit-checks\tpass\n' ;;
      fail|stuck) printf 'test\tpass\nprivacy\tfail\n' ;;
      kitfail) printf 'test\tpass\nkit-checks\tfail\n' ;;
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
  # stuck: a failed check, and GitHub refuses both turning auto-merge off and closing (an outage).
  "pr merge") case "$*" in *--auto*) ${required ? ':' : 'exit 1'} ;; *--disable-auto*) [ "${prState}" != stuck ] || exit 1 ;; *) land ;; esac ;;
  "pr close") [ "${prState}" != stuck ] || exit 1; touch "${closed}" ;;
  "pr view")
    if [ -f "${merged}" ]; then echo 'MERGED noauto'; exit 0; fi
    if [ -f "${closed}" ]; then echo 'CLOSED noauto'; exit 0; fi
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
  writeFileSync(join(work, '.gitleaks.toml'), '# the config on main\n');
  // The real workflow, whose gitleaks pin land.sh reads.
  mkdirSync(join(work, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(work, '.github', 'workflows', 'ci.yml'), readFileSync('.github/workflows/ci.yml'));
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'start');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', 'main');
  const land = (...args: string[]) => spawnSync('bash', [join(work, 'scripts', 'land.sh'), ...args], {
    cwd: work, encoding: 'utf8', env: { ...env, GITLEAKS_CONFIG: join(root, 'a-config-of-ones-own.toml'), HATCHABOT_LAND_POLL_SECS: '0', GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', GIT_CONFIG_KEY_1: 'user.name', GIT_CONFIG_VALUE_1: 'Test', GIT_CONFIG_KEY_2: 'user.email', GIT_CONFIG_VALUE_2: 'test@example.org' },
  });
  const ghLog = () => { try { return readFileSync(log, 'utf8'); } catch { return ''; } };
  const kept = (f: string) => { try { return readFileSync(join(root, f), 'utf8'); } catch { return undefined; } };
  return { work, origin, git, land, ghLog, glLog: () => kept('gitleaks.log') ?? '', kept };
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

  it('--no-wait with nothing that will merge it (the dev repo): not "landed", exit 3, with the command (HB-0439)', () => {
    const w = world('green', false);
    writeFileSync(join(w.work, 'b.txt'), 'two\n'); w.git(w.work, 'add', 'b.txt'); w.git(w.work, 'commit', '-q', '-m', 'Add b');
    const before = w.git(w.origin, 'rev-parse', 'main');
    const r = w.land('--no-wait');
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stdout).not.toContain('merging it (rebase) here');
    expect(r.stderr).toContain('Nothing will merge https://github.com/example-owner/example/pull/7 by itself');
    expect(r.stderr).toMatch(/gh pr merge https:\/\/github\.com\/example-owner\/example\/pull\/7 --repo \S+ --rebase --delete-branch/);
    expect(r.stderr).toContain('git pull --rebase');
    expect(w.git(w.origin, 'rev-parse', 'main')).toBe(before);
    expect(w.ghLog()).not.toMatch(/pr merge \S+ --repo \S+ --rebase --delete-branch/);
  });

  it('--no-wait with GitHub\'s auto-merge on: it merges by itself, exit 0, and says so', () => {
    const w = world('stuck', true);
    writeFileSync(join(w.work, 'b.txt'), 'two\n'); w.git(w.work, 'add', 'b.txt'); w.git(w.work, 'commit', '-q', '-m', 'Add b');
    const r = w.land('--no-wait');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('GitHub merges it (rebase) once its required checks pass');
    expect(r.stdout).toContain('git pull --rebase');
    expect(w.ghLog()).toMatch(/pr merge \S+ --repo \S+ --auto --rebase --delete-branch/);
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
    expect(r.stderr).toContain('the pull request is closed'); // GitHub said so
    expect(w.ghLog()).toMatch(/pr merge \S+ --repo \S+ --disable-auto/);
    expect(w.ghLog()).toMatch(/pr close \S+ --repo \S+ --delete-branch/);
  });

  it('a failed check whose pull request GitHub does not close is said as still open, exit 3 (audit #046)', () => {
    const w = world('stuck');
    writeFileSync(join(w.work, 'b.txt'), 'two\n'); w.git(w.work, 'add', 'b.txt'); w.git(w.work, 'commit', '-q', '-m', 'Add b');
    const r = w.land();
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stderr).toContain('Check(s) failed: privacy');
    expect(r.stderr).not.toContain('the pull request is closed');
    expect(r.stderr).toContain('closing the pull request failed: https://github.com/example-owner/example/pull/7 is still open, with auto-merge on');
    expect(r.stderr).toContain('gh pr close https://github.com/example-owner/example/pull/7');
    expect(w.ghLog()).toMatch(/pr close \S+ --repo \S+ --delete-branch/);
  });

  it('the kit checks (kit-checks, its own workflow) count: a hit there is a failed check, never merged', () => {
    const w = world('kitfail', false);
    writeFileSync(join(w.work, 'b.txt'), 'two\n'); w.git(w.work, 'add', 'b.txt'); w.git(w.work, 'commit', '-q', '-m', 'Add b');
    const r = w.land();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Check(s) failed: kit-checks');
    expect(w.ghLog()).not.toMatch(/pr merge \S+ --repo \S+ --rebase/);
    expect(w.ghLog()).toMatch(/pr close \S+ --repo \S+ --delete-branch/);
    expect(w.git(w.origin, 'rev-parse', 'main')).not.toBe(w.git(w.work, 'rev-parse', 'HEAD'));
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

  describe("CI's gitleaks scans, before anything is pushed (HB-0852)", () => {
    const addB = (w: ReturnType<typeof world>) => {
      writeFileSync(join(w.work, 'b.txt'), 'two\n');
      writeFileSync(join(w.work, '.gitleaks.toml'), '# this change loosens it\n');
      w.git(w.work, 'add', '.'); w.git(w.work, 'commit', '-q', '-m', 'Add b');
    };
    const nothingPushed = (w: ReturnType<typeof world>, before: string) => {
      expect(w.ghLog()).toBe('');
      expect(w.git(w.origin, 'rev-parse', 'main')).toBe(before);
      expect(w.git(w.origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/land/')).toBe('');
    };

    it('without gitleaks: says the scan was skipped, and lands', () => {
      const w = world('merge');
      addB(w);
      const r = w.land();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain('• gitleaks is not installed, so the secrets scan CI runs was skipped here (CI still runs it).');
    });

    it("finding nothing: the new commits with main's config, then the tree alone with the default rules, and it lands", () => {
      const w = world('merge', true, 'clean');
      addB(w);
      const r = w.land();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain("✓ gitleaks: nothing in the new commits or the tree, as CI's secrets job scans them");
      // The version CI pins: nothing said of it.
      expect(r.stdout).not.toContain('• gitleaks here is');
      expect(r.stdout).not.toContain("CI's gitleaks version was not found");
      const [commits, tree] = w.glLog().trim().split('\n');
      expect(commits).toMatch(/^git\|.*\|git --log-opts=origin\/main\.\.HEAD --config \S+ --redact --no-banner --exit-code 3 /);
      // The config as main has it, not as the change made it.
      expect(w.kept('config-used')).toBe('# the config on main\n');
      // The tree in a folder with no config or ignore list beside it, and none named.
      expect(tree).toMatch(/^dir\|unset\|dir \. --redact --no-banner --exit-code 3 /);
      expect(tree).not.toContain('--config');
      expect(w.kept('dir-root')).toBe('tree\n');
      expect(w.kept('dir-tree')!.split('\n')).toEqual(expect.arrayContaining(['.gitleaks.toml', 'a.txt', 'b.txt', 'scripts']));
    });

    it('with no config on main nor in the change: the commits too are scanned with the default rules, not a config named in the environment', () => {
      const w = world('merge', true, 'clean');
      w.git(w.work, 'rm', '-q', '.gitleaks.toml'); w.git(w.work, 'commit', '-q', '-m', 'No config');
      w.git(w.work, 'push', '-q', 'origin', 'main');
      writeFileSync(join(w.work, 'b.txt'), 'two\n'); w.git(w.work, 'add', 'b.txt'); w.git(w.work, 'commit', '-q', '-m', 'Add b');
      const r = w.land();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const [commits, tree] = w.glLog().trim().split('\n');
      expect(commits).toMatch(/^git\|unset\|git --log-opts=origin\/main\.\.HEAD --redact --no-banner --exit-code 3 /);
      expect(tree).toMatch(/^dir\|unset\|/);
    });

    it('a value in the new commits: refused, exit 2, naming the file and line, with nothing pushed', () => {
      const w = world('merge', true, 'commit-hit');
      const before = w.git(w.origin, 'rev-parse', 'main');
      addB(w);
      const r = w.land();
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toBe(
        "✗ gitleaks found what CI's secrets job will refuse, in the new commits, so nothing was pushed:\n" +
        '  b.txt:1: generic-api-key (commit 0123456789ab)\n' +
        'Change the value (a made-up one must not look like a key either), commit, and land again.\n',
      );
      nothingPushed(w, before);
    });

    it("a value in the tree under the default rules: refused likewise, the file named as it is in the repo", () => {
      const w = world('merge', true, 'tree-hit');
      const before = w.git(w.origin, 'rev-parse', 'main');
      addB(w);
      const r = w.land();
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toContain("in the tree (gitleaks' default rules), so nothing was pushed:\n  b.txt:1: generic-api-key\n");
      nothingPushed(w, before);
    });

    it('a gitleaks of another version than CI pins: said, and it still scans and lands', () => {
      const w = world('merge', true, 'clean', '8.18.0');
      addB(w);
      const r = w.land();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain(
        `• gitleaks here is 8.18.0, but CI's secrets job runs ${CI_GITLEAKS} (.github/workflows/ci.yml): their default rules can differ, ` +
        `so the tree may pass here and not there, or the other way. Install gitleaks ${CI_GITLEAKS} to scan as CI does.\n`,
      );
      expect(r.stdout).toContain("✓ gitleaks: nothing in the new commits or the tree, as CI's secrets job scans them");
      expect(w.glLog().trim().split('\n')).toHaveLength(2);
    });

    it('a workflow whose pin cannot be read: said, so the two do not drift unnoticed', () => {
      const w = world('merge', true, 'clean');
      addB(w);
      w.git(w.work, 'rm', '-q', '.github/workflows/ci.yml'); w.git(w.work, 'commit', '-q', '-m', 'No workflow');
      const r = w.land();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain(
        `• CI's gitleaks version was not found in .github/workflows/ci.yml (the V= of its step "gitleaks on the new commits"), so this gitleaks (${CI_GITLEAKS}) was not checked against it.\n`,
      );
    });

    it('a gitleaks that cannot run: refused, saying what it said, with nothing pushed', () => {
      const w = world('merge', true, 'broken');
      const before = w.git(w.origin, 'rev-parse', 'main');
      addB(w);
      const r = w.land();
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toContain('✗ gitleaks could not scan the new commits, so nothing was pushed: FTL unknown flag: --report-template (update gitleaks, or uninstall it to land without the scan).');
      nothingPushed(w, before);
    });
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
