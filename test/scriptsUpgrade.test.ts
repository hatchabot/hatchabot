import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * scripts/upgrade.sh against a throwaway git origin: a failed install rolls
 * back and leaves the machine with its dependencies; a leftover
 * node_modules.prev (an interrupted run) does not read as "local changes";
 * two upgrades at once are refused (30th audit).
 */
// The machine's global commit hooks (a PII scan) must not run on these throwaway repositories.
const noHooks = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...noHooks } }).trim();
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function world() {
  const root = mkdtempSync(join(tmpdir(), 'hb-upgrade-')); dirs.push(root);
  const home = join(root, 'home'); mkdirSync(home);
  const src = join(root, 'src'); mkdirSync(src);
  git(src, 'init', '-q', '-b', 'main');
  git(src, 'config', 'user.email', 'test@example.com'); git(src, 'config', 'user.name', 'Test');
  mkdirSync(join(src, 'scripts'));
  writeFileSync(join(src, 'scripts', 'upgrade.sh'), readFileSync('scripts/upgrade.sh'), { mode: 0o755 });
  writeFileSync(join(src, 'scripts', 'release-target.sh'), readFileSync('scripts/release-target.sh'), { mode: 0o755 });
  writeFileSync(join(src, '.gitignore'), 'node_modules/\nnode_modules.prev/\n');
  writeFileSync(join(src, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
  writeFileSync(join(src, 'channels.json'), '{"stable":"v1.0.0","beta":"v1.0.0"}\n');
  git(src, 'add', '-A'); git(src, 'commit', '-q', '-m', 'v1'); git(src, 'tag', 'v1.0.0');
  writeFileSync(join(src, 'package.json'), '{"name":"x","version":"1.1.0"}\n');
  writeFileSync(join(src, 'channels.json'), '{"stable":"v1.1.0","beta":"v1.1.0"}\n');
  git(src, 'add', '-A'); git(src, 'commit', '-q', '-m', 'v2'); git(src, 'tag', 'v1.1.0');
  const origin = join(root, 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', src, origin], { env: { ...process.env, ...noHooks } });
  const install = join(root, 'install');
  execFileSync('git', ['clone', '-q', origin, install], { env: { ...process.env, ...noHooks } });
  git(install, 'checkout', '-q', 'v1.0.0');
  mkdirSync(join(install, 'node_modules')); writeFileSync(join(install, 'node_modules', 'marker'), 'deps');
  return { root, home, install };
}
const run = (install: string, home: string, env: Record<string, string>, args: string[] = []) =>
  spawnSync('bash', [join(install, 'scripts', 'upgrade.sh'), ...args], {
    encoding: 'utf8', env: { ...process.env, ...noHooks, HOME: home, TMPDIR: join(home, 'tmp'), HATCHABOT_RESTART_CMD: 'true', HATCHABOT_UPGRADE_IMAGE: '0', ...env },
  });

describe('scripts/upgrade.sh', () => {
  it('a failed install rolls back to the old release with its dependencies intact', () => {
    const w = world(); mkdirSync(join(w.home, 'tmp'));
    const r = run(w.install, w.home, { HATCHABOT_INSTALL_CMD: 'false' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    expect(existsSync(join(w.install, 'node_modules', 'marker'))).toBe(true);
    expect(existsSync(join(w.install, 'node_modules.prev'))).toBe(false);
  });

  it('a leftover node_modules.prev from an interrupted run does not block the next upgrade', () => {
    const w = world(); mkdirSync(join(w.home, 'tmp'));
    mkdirSync(join(w.install, 'node_modules.prev')); writeFileSync(join(w.install, 'node_modules.prev', 'old'), 'x');
    const r = run(w.install, w.home, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.1.0');
    expect(existsSync(join(w.install, 'node_modules.prev'))).toBe(false);
    expect(readFileSync(join(w.home, '.config', 'hatchabot', 'channel'), 'utf8').trim()).toBe('stable');
  });

  it('two upgrades of one install at once: the second is refused', async () => {
    const w = world(); mkdirSync(join(w.home, 'tmp'));
    // Hold the lock the script takes (TMPDIR/hatchabot-upgrade-<cksum of the dir>.lock.d, a directory: macOS has no flock) as a running upgrade would.
    const sum = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', w.install], { encoding: 'utf8' }).trim();
    const lock = join(w.home, 'tmp', `hatchabot-upgrade-${sum}.lock.d`);
    mkdirSync(lock);
    const second = run(w.install, w.home, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(second.status, second.stdout + second.stderr).toBe(4);
    expect(second.stdout).toMatch(/Another upgrade/);
    // A crash's leftover (older than an hour) is not a running upgrade.
    execFileSync('touch', ['-d', '2 hours ago', lock]);
    const third = run(w.install, w.home, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(third.status, third.stdout + third.stderr).toBe(0);
  }, 20_000);
});
