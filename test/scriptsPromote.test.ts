import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

/**
 * scripts/promote.sh in a sandbox: a throwaway repo with a local bare
 * "origin", a temp HOME, hooks off, PATH confined to the system dirs. It used
 * to stamp every promote commit with a fixed Co-Authored-By and an old
 * session URL (review, 2026-09-29); trailers now come only from the caller.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function world() {
  const root = mkdtempSync(join(tmpdir(), 'hb-promote-')); dirs.push(root);
  const home = join(root, 'home'); mkdirSync(home);
  // A fake gh ahead of the real one (/usr/bin/gh): CI's answer comes from
  // HB_CI — "success" (default), "failure", "running:success", "running:failure", "none",
  // "pr-only" (a passing pull-request run on the commit, and no run for the push to main).
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
ci="\${HB_CI:-success}"
echo "gh $*" >> ${JSON.stringify(join(root, 'gh.log'))}
case "$1 $2" in
  "run list") case "$ci" in none) ;; pr-only) case "$*" in *"--event push"*) ;; *) echo "4243 completed success" ;; esac ;; running:*) echo "4242 in_progress " ;; *) echo "4242 completed $ci" ;; esac ;;
  "run watch") [ "\${ci#running:}" = success ] ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const env = {
    HOME: home, PATH: `${bin}:/usr/bin:/bin`,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const work = join(root, 'work'); mkdirSync(join(work, 'scripts'), { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, 'scripts', 'promote.sh'), readFileSync('scripts/promote.sh'), { mode: 0o755 });
  writeFileSync(join(work, 'channels.json'), '{\n  "stable": "v1.0.0",\n  "beta": "v1.0.0"\n}\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'tag', 'v1.1.0');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', '--tags', 'origin', 'main');
  const promote = (extra: Record<string, string> = {}, ...args: string[]) =>
    spawnSync('bash', [join(work, 'scripts', 'promote.sh'), ...args], { cwd: work, env: { ...env, ...extra }, encoding: 'utf8' });
  const channels = () => readFileSync(join(work, 'channels.json'), 'utf8');
  return { root, bin, origin, work, git, promote, channels };
}

describe('scripts/promote.sh', () => {
  it('commits with no trailer of its own', () => {
    const w = world();
    const r = w.promote({}, 'v1.1.0');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const msg = w.git(w.work, 'log', '-1', '--format=%B');
    expect(msg.trim()).toBe('Promote v1.1.0 to stable');
    expect(msg).not.toMatch(/Claude-Session|Co-Authored-By/);
  });

  it('adds the trailers the caller passes', () => {
    const w = world();
    const r = w.promote({ HATCHABOT_PROMOTE_TRAILERS: 'Co-Authored-By: Someone <someone@example.com>' }, 'v1.1.0', 'beta');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.git(w.work, 'log', '-1', '--format=%B').trim()).toBe('Promote v1.1.0 to beta\n\nCo-Authored-By: Someone <someone@example.com>');
  });
});

describe('scripts/promote.sh asks CI first (it was red for eight days unseen, 2026-10-06)', () => {
  it('passed: promotes', () => {
    const w = world();
    const r = w.promote({}, 'v1.1.0');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('✓ CI passed on v1.1.0');
    expect(w.channels()).toContain('"stable": "v1.1.0"');
  });

  it('failed: refuses, names the run, changes nothing', () => {
    const w = world();
    const r = w.promote({ HB_CI: 'failure' }, 'v1.1.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('CI failed on v1.1.0 (failure): https://github.com/hatchabot/hatchabot/actions/runs/4242');
    expect(w.channels()).toContain('"stable": "v1.0.0"');
  });

  it('still running: waits, then follows the result', () => {
    const ok = world();
    const a = ok.promote({ HB_CI: 'running:success' }, 'v1.1.0');
    expect(a.status, a.stdout + a.stderr).toBe(0);
    expect(a.stdout).toContain('still running — waiting');
    const bad = world();
    const b = bad.promote({ HB_CI: 'running:failure' }, 'v1.1.0');
    expect(b.status).toBe(1);
    expect(bad.channels()).toContain('"stable": "v1.0.0"');
  });

  it('no run for the commit: refuses, and says how to go on without the check', () => {
    const w = world();
    const r = w.promote({ HB_CI: 'none' }, 'v1.1.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/No CI run for v1\.1\.0 .*HATCHABOT_PROMOTE_IGNORE_CI=1/);
    const forced = w.promote({ HB_CI: 'none', HATCHABOT_PROMOTE_IGNORE_CI: '1' }, 'v1.1.0');
    expect(forced.status, forced.stdout + forced.stderr).toBe(0);
    expect(forced.stdout).toContain('CI not checked');
  });

  it('a rollback is not held to CI', () => {
    const w = world();
    w.git(w.work, 'tag', 'v0.9.0');
    // Built from scratch, as every script test's environment is (review, 2026-10-09).
    const r = spawnSync('bash', [join(w.work, 'scripts', 'promote.sh'), 'v0.9.0'], {
      cwd: w.work, encoding: 'utf8', input: 'y\n',
      env: scriptEnv(join(w.work, '..', 'home'), `${join(w.work, '..', 'bin')}:/usr/bin:/bin`, { HB_CI: 'failure' }),
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.channels()).toContain('"stable": "v0.9.0"');
  });
});

describe('scripts/promote.sh asks for the live tests (docs/live-tests.md)', () => {
  /** The sandbox with the live register and a record; node on PATH. */
  const withLive = (record: string) => {
    const w = world();
    mkdirSync(join(w.work, 'docs'), { recursive: true });
    writeFileSync(join(w.work, 'scripts', 'live.mjs'), readFileSync('scripts/live.mjs'));
    writeFileSync(join(w.work, 'docs', 'live-test-runs.md'), record);
    w.git(w.work, 'add', '.'); w.git(w.work, 'commit', '-q', '-m', 'live');
    w.git(w.work, 'push', '-q', 'origin', 'main');
    const PATH = `${join(w.work, '..', 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`;
    return { ...w, run: (extra: Record<string, string> = {}) => w.promote({ PATH, ...extra }, 'v1.1.0') };
  };
  const passedAll = async () => {
    // @ts-expect-error — a plain .mjs script
    const { LIVE_TESTS } = await import('../scripts/live.mjs');
    return (LIVE_TESTS as Array<{ name: string }>).map((t) => `| 2026-10-08 | ${t.name} | pass | v1.1.0 | 5 | |`).join('\n') + '\n';
  };

  it('due: refuses, says what to run, changes nothing', () => {
    const w = withLive('');
    const r = w.run();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/live test\(s\) due for v1\.1\.0/);
    expect(r.stderr).toMatch(/Live tests are due for v1\.1\.0 .*HATCHABOT_PROMOTE_IGNORE_LIVE=1/);
    expect(w.channels()).toContain('"stable": "v1.0.0"');
  });

  it('all passed on the release: promotes', async () => {
    const w = withLive(await passedAll());
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('✓ No live test is due for v1.1.0');
    expect(w.channels()).toContain('"stable": "v1.1.0"');
  });

  it('the override goes on without them, and says so', () => {
    const w = withLive('');
    const r = w.run({ HATCHABOT_PROMOTE_IGNORE_LIVE: '1' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Live tests not checked');
  });
});

describe('scripts/promote.sh publishes only the promote (review, 2026-10-09)', () => {
  const originMain = (w: ReturnType<typeof world>) => w.git(w.work, 'rev-parse', 'origin/main').trim();

  it('refuses while local main has a commit origin does not (it rode along with the push)', () => {
    const w = world();
    writeFileSync(join(w.work, 'wip.txt'), 'half done');
    w.git(w.work, 'add', 'wip.txt'); w.git(w.work, 'commit', '-q', '-m', 'wip');
    const before = originMain(w);
    const r = w.promote({}, 'v1.1.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/1 commits ahead, 0 behind/);
    expect(w.git(w.origin, 'rev-parse', 'main').trim()).toBe(before);
  });

  it('refuses a tag that is not on main', () => {
    const w = world();
    w.git(w.work, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(w.work, 'side.txt'), 'x'); w.git(w.work, 'add', 'side.txt'); w.git(w.work, 'commit', '-q', '-m', 'side');
    w.git(w.work, 'tag', 'v1.2.0'); w.git(w.work, 'checkout', '-q', 'main');
    const r = w.promote({}, 'v1.2.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('v1.2.0 is not on main');
    expect(w.channels()).toContain('"stable": "v1.0.0"');
  });

  it('a refused push takes its commit back off, so a re-run does not say "already points at"', () => {
    const w = world();
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(w.bin, 'git'), `#!/usr/bin/env bash\n[ "$1" = push ] && { echo "! [rejected] main -> main (fetch first)" >&2; exit 1; }\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
    const r = w.promote({}, 'v1.1.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('The push to origin was refused');
    expect(w.git(w.work, 'rev-parse', 'HEAD').trim()).toBe(originMain(w));
    expect(w.channels()).toContain('"stable": "v1.0.0"');
    expect(w.git(w.work, 'status', '--porcelain').trim()).toBe('');
    rmSync(join(w.bin, 'git'));
    const again = w.promote({}, 'v1.1.0');
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).not.toContain('already points at');
  });

  it('CI is the run for the push to main — a passing pull-request run on the commit does not count', () => {
    const w = world();
    const r = w.promote({ HB_CI: 'pr-only' }, 'v1.1.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/No CI run for v1\.1\.0/);
    expect(readFileSync(join(w.root, 'gh.log'), 'utf8')).toContain('--event push --branch main');
  });
});

