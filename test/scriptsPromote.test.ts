import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  // HB_CI — "success" (default), "failure", "running:success", "running:failure", "none".
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
ci="\${HB_CI:-success}"
echo "gh $*" >> ${JSON.stringify(join(root, 'gh.log'))}
case "$1 $2" in
  "run list") case "$ci" in none) ;; running:*) echo "4242 in_progress " ;; *) echo "4242 completed $ci" ;; esac ;;
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
  return { work, git, promote, channels };
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
    const r = spawnSync('bash', [join(w.work, 'scripts', 'promote.sh'), 'v0.9.0'], {
      cwd: w.work, encoding: 'utf8', input: 'y\n',
      env: { ...process.env, HOME: join(w.work, '..', 'home'), PATH: `${join(w.work, '..', 'bin')}:/usr/bin:/bin`, HB_CI: 'failure',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
        GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.channels()).toContain('"stable": "v0.9.0"');
  });
});
