import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

/**
 * scripts/upgrade.sh against a throwaway git origin: a failed install rolls
 * back and leaves the machine with its dependencies; a leftover
 * node_modules.prev (an interrupted run) does not read as "local changes";
 * two upgrades at once are refused (30th audit). Everything runs with a temp
 * HOME, a PATH of shims and the system dirs, hooks off, and an environment
 * built from scratch.
 */
const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function world() {
  const root = mkdtempSync(join(tmpdir(), 'hb-upgrade-')); dirs.push(root);
  const home = join(root, 'home'); mkdirSync(join(home, 'tmp'), { recursive: true });
  const bin = join(root, 'bin'); mkdirSync(bin);
  const env = scriptEnv(home, `${bin}:/usr/bin:/bin`);
  const git = (cwd: string, ...args: string[]) => execFileSync(REAL_GIT, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
  const src = join(root, 'src'); mkdirSync(src);
  git(src, 'init', '-q', '-b', 'main');
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
  git(root, 'clone', '-q', '--bare', src, origin);
  const install = join(root, 'install');
  git(root, 'clone', '-q', origin, install);
  git(install, 'checkout', '-q', 'v1.0.0');
  mkdirSync(join(install, 'node_modules')); writeFileSync(join(install, 'node_modules', 'marker'), 'deps');
  // The restart the script asks for, recorded rather than done.
  const restarts = join(root, 'restarts.log');
  writeFileSync(join(bin, 'fake-restart'), `#!/usr/bin/env bash\necho restart >> ${JSON.stringify(restarts)}\nexit "\${FAKE_RESTART_RC:-0}"\n`, { mode: 0o755 });
  return { root, home, install, bin, env, git, restarts };
}
type World = ReturnType<typeof world>;
const run = (w: World, extra: Record<string, string>, args: string[] = []) =>
  spawnSync('bash', [join(w.install, 'scripts', 'upgrade.sh'), ...args], {
    encoding: 'utf8', env: { ...w.env, HATCHABOT_RESTART_CMD: join(w.bin, 'fake-restart'), HATCHABOT_UPGRADE_IMAGE: '0', ...extra },
  });
const restarted = (w: World) => (existsSync(w.restarts) ? readFileSync(w.restarts, 'utf8').split('\n').filter(Boolean).length : 0);
/** The upgrade lock: a directory in the user's state folder, keyed on the install's path. */
const lockOf = (w: World) => {
  const sum = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', w.install], { encoding: 'utf8' }).trim();
  return join(w.home, '.local', 'state', 'hatchabot', `upgrade-${sum}.lock.d`);
};

describe('scripts/upgrade.sh', () => {
  it('a failed install rolls back to the old release with its dependencies intact — and does not restart it', () => {
    const w = world();
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'false' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    expect(existsSync(join(w.install, 'node_modules', 'marker'))).toBe(true);
    expect(existsSync(join(w.install, 'node_modules.prev'))).toBe(false);
    // The old release never stopped: restarting it anyway restarted production
    // every ten minutes while a release that cannot install kept failing (review, 2026-10-09).
    expect(restarted(w)).toBe(0);
  });

  it('a release that does not come up is rolled back, the old one restarted, and says 1', () => {
    const w = world();
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true', FAKE_RESTART_RC: '1' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    expect(existsSync(join(w.install, 'node_modules', 'marker'))).toBe(true);
    expect(restarted(w)).toBe(2); // onto the new one, then back onto the old
  });

  it('a leftover node_modules.prev from an interrupted run does not block the next upgrade', () => {
    const w = world();
    mkdirSync(join(w.install, 'node_modules.prev')); writeFileSync(join(w.install, 'node_modules.prev', 'old'), 'x');
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.1.0');
    expect(existsSync(join(w.install, 'node_modules.prev'))).toBe(false);
    expect(readFileSync(join(w.home, '.config', 'hatchabot', 'channel'), 'utf8').trim()).toBe('stable');
  });

  it('two upgrades of one install at once: the second is refused (the lock is in the user\'s state folder, not /tmp)', () => {
    const w = world();
    const lock = lockOf(w);
    mkdirSync(lock, { recursive: true });
    const second = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(second.status, second.stdout + second.stderr).toBe(4);
    expect(second.stdout).toMatch(/Another upgrade/);
    // A crash's leftover (older than an hour) is not a running upgrade.
    execFileSync('touch', ['-d', '2 hours ago', lock]);
    const third = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(third.status, third.stdout + third.stderr).toBe(0);
    expect(existsSync(lock)).toBe(false);
  }, 20_000);
});

describe('scripts/upgrade.sh says 1 only for a release that did not come up (review, 2026-10-09)', () => {
  it('no network to origin: 3, not 1 (the channel timer blacklisted releases it never tried)', () => {
    const w = world();
    w.git(w.install, 'remote', 'set-url', 'origin', join(w.root, 'gone.git'));
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stderr).toMatch(/Could not fetch the releases/);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
  });

  it('a channel that does not exist: 2', () => {
    const w = world();
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['nightly']);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toMatch(/Unknown channel 'nightly'/);
  });

  it('a step that fails part-way (the checkout, after node_modules was moved aside) puts everything back and says 3', () => {
    const w = world();
    writeFileSync(join(w.bin, 'git'), `#!/usr/bin/env bash\n[ "$1 $2 $3" = "checkout --quiet v1.1.0" ] && { echo "error: simulated" >&2; exit 1; }\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`, { mode: 0o755 });
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stdout).toMatch(/stopped part-way/);
    expect(existsSync(join(w.install, 'node_modules', 'marker'))).toBe(true);
    expect(existsSync(join(w.install, 'node_modules.prev'))).toBe(false);
    expect(restarted(w)).toBe(0);
  });

  it('the channel timer does not rewrite the channel someone chose by hand', () => {
    const w = world();
    mkdirSync(join(w.home, '.config', 'hatchabot'), { recursive: true });
    writeFileSync(join(w.home, '.config', 'hatchabot', 'channel'), 'beta\n');
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true', HATCHABOT_UPGRADE_BY_TIMER: '1' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(join(w.home, '.config', 'hatchabot', 'channel'), 'utf8').trim()).toBe('beta');
  });
});

describe('scripts/release-target.sh on a bundle install (no clone: it asks GitHub)', () => {
  /** release-target.sh in a tree with no .git, and a curl that answers `body` (or fails). */
  function bundleTree(curl: string) {
    const root = mkdtempSync(join(tmpdir(), 'hb-target-')); dirs.push(root);
    mkdirSync(join(root, 'app', 'scripts'), { recursive: true }); mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'home'));
    writeFileSync(join(root, 'app', 'scripts', 'release-target.sh'), readFileSync('scripts/release-target.sh'), { mode: 0o755 });
    writeFileSync(join(root, 'bin', 'curl'), `#!/usr/bin/env bash\n${curl}\n`, { mode: 0o755 });
    return (channel: string) => spawnSync('bash', [join(root, 'app', 'scripts', 'release-target.sh'), channel], { encoding: 'utf8', env: scriptEnv(join(root, 'home'), `${join(root, 'bin')}:/usr/bin:/bin`) });
  }

  it('no network: 3 and a message (it used to end silently with curl\'s own code)', () => {
    const r = bundleTree('exit 6')('stable');
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/Could not fetch channels\.json/);
  });

  it('a captive portal\'s page is not "stable is not named" — no fall back to the newest release', () => {
    const r = bundleTree(`case "$*" in *channels.json*) echo '<html><body>Sign in to the cafe wifi</body></html>' ;; *) echo '{"tag_name": "v9.9.9"}' ;; esac`)('stable');
    expect(r.status).toBe(3);
    expect(r.stdout).not.toContain('v9.9.9');
    expect(r.stderr).toMatch(/not a channels file/);
  });

  it('a channels file names the release; beta not named falls back to the newest, stable never does', () => {
    const named = bundleTree(`case "$*" in *channels.json*) printf '{\\n  "stable": "v2.0.0"\\n}\\n' ;; *) echo '{"tag_name": "v2.1.0"}' ;; esac`);
    expect(named('stable').stdout.trim()).toBe('v2.0.0');
    expect(named('beta').stdout.trim()).toBe('v2.1.0');
    const noStable = bundleTree(`case "$*" in *channels.json*) echo '{"beta": "v2.0.0"}' ;; *) echo '{"tag_name": "v2.1.0"}' ;; esac`)('stable');
    expect(noStable.status).toBe(3);
    expect(noStable.stdout).not.toContain('v2.1.0');
  });
});
