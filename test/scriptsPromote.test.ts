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
  const env = {
    HOME: home, PATH: '/usr/bin:/bin',
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
  return { work, git, promote };
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
