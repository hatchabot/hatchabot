import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

/**
 * The channel timers and the production deploy, in a sandbox: a temp HOME, a
 * PATH of shims (systemctl, curl, a git that can be told to fail) and the
 * system dirs, hooks off, an environment built from scratch, and a throwaway
 * git origin standing in for GitHub (review, 2026-10-09):
 *  - follow-channel.sh / follow-latest.sh set a release aside only when it was
 *    tried and did not come up (exit 1); one whose install keeps failing is
 *    retried less and less often, then set aside;
 *  - deploy-release.sh restarts nothing when the install failed, installs
 *    through ensure-deps.sh, and a step that fails part-way puts prod back.
 */
const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const lines = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : []);

describe('scripts/follow-channel.sh', () => {
  /** An install whose release-target.sh says v1.1.0 and whose upgrade.sh exits with what rc.txt says. */
  function world() {
    const root = mkdtempSync(join(tmpdir(), 'hb-follow-channel-')); dirs.push(root);
    const home = join(root, 'home'); mkdirSync(home);
    const app = join(root, 'app'); mkdirSync(join(app, 'scripts'), { recursive: true });
    writeFileSync(join(app, 'scripts', 'follow-channel.sh'), readFileSync('scripts/follow-channel.sh'), { mode: 0o755 });
    writeFileSync(join(app, 'scripts', 'release-target.sh'), '#!/usr/bin/env bash\necho v1.1.0\n', { mode: 0o755 });
    const log = join(root, 'upgrades.log'), rc = join(root, 'rc.txt');
    writeFileSync(join(app, 'scripts', 'upgrade.sh'), `#!/usr/bin/env bash\necho "upgrade $* timer=\${HATCHABOT_UPGRADE_BY_TIMER:-}" >> ${JSON.stringify(log)}\nexit "$(cat ${JSON.stringify(rc)})"\n`, { mode: 0o755 });
    const state = join(home, '.local', 'state', 'hatchabot');
    const run = (code: number) => {
      writeFileSync(rc, String(code));
      return spawnSync('bash', [join(app, 'scripts', 'follow-channel.sh'), 'stable'], { encoding: 'utf8', env: scriptEnv(home, '/usr/bin:/bin') });
    };
    return { run, log, state, tries: join(state, 'follow-channel-tries'), failed: join(state, 'follow-channel-failed') };
  }

  it('asks upgrade.sh as the timer (so it leaves the chosen channel alone)', () => {
    const w = world();
    expect(w.run(0).status).toBe(0);
    expect(lines(w.log)).toEqual(['upgrade stable timer=1']);
  });

  it('a release that keeps failing to install is retried less and less often, then set aside', () => {
    const w = world();
    const first = w.run(3);
    expect(first.status).toBe(1);
    expect(first.stdout).toContain('tried again later (1 of 8)');
    expect(readFileSync(w.tries, 'utf8')).toMatch(/^v1\.1\.0 1 \d+\n$/);
    // Ten minutes later is too soon after the first failure? No: the first retry is the next tick.
    // Straight away is too soon.
    w.run(3);
    expect(lines(w.log)).toHaveLength(1);
    // Six minutes on: the next tick tries again; the wait then doubles.
    writeFileSync(w.tries, `v1.1.0 1 ${Math.floor(Date.now() / 1000) - 6 * 60}\n`);
    w.run(3);
    expect(lines(w.log)).toHaveLength(2);
    writeFileSync(w.tries, `v1.1.0 2 ${Math.floor(Date.now() / 1000) - 6 * 60}\n`);
    w.run(3);
    expect(lines(w.log)).toHaveLength(2); // 15 minutes now
    // The eighth failure in a row sets it aside, like a release that did not start.
    writeFileSync(w.tries, 'v1.1.0 7 0\n');
    const last = w.run(3);
    expect(last.stdout).toContain('did not complete 8 times in a row');
    expect(readFileSync(w.failed, 'utf8').trim()).toBe('v1.1.0');
    w.run(0);
    expect(lines(w.log)).toHaveLength(3); // not tried again
  });

  it('only exit 1 — tried and rolled back — sets a release aside at once; 2 and 4 are tried again next time', () => {
    for (const code of [2, 4]) {
      const w = world();
      w.run(code); w.run(code);
      expect(lines(w.log)).toHaveLength(2);
      expect(existsSync(w.failed)).toBe(false);
    }
    const w = world();
    w.run(1);
    expect(readFileSync(w.failed, 'utf8').trim()).toBe('v1.1.0');
  });
});

/** A throwaway origin with v1.0.0 and v1.1.0, and production cloned from it at v1.0.0. */
function prodWorld(v11: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hb-deploy-')); dirs.push(root);
  const home = join(root, 'home'); mkdirSync(home);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const log = join(root, 'calls.log');
  writeFileSync(join(bin, 'systemctl'), `#!/usr/bin/env bash\necho "systemctl $*" >> ${JSON.stringify(log)}\nexit "\${FAKE_SYSTEMCTL_RC:-0}"\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env bash\necho "npm $*" >> ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), '#!/usr/bin/env bash\necho \'<script>window.HATCHABOT_VERSION="1.1.0"</script>\'\n', { mode: 0o755 });
  symlinkSync(process.execPath, join(bin, 'node'));
  const env = scriptEnv(home, `${bin}:/usr/bin:/bin`);
  const git = (cwd: string, ...args: string[]) => execFileSync(REAL_GIT, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
  const src = join(root, 'src'); mkdirSync(join(src, 'scripts'), { recursive: true });
  git(src, 'init', '-q', '-b', 'main');
  writeFileSync(join(src, '.gitignore'), 'node_modules/\nnode_modules.prev/\n');
  writeFileSync(join(src, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
  writeFileSync(join(src, 'scripts', 'deploy-release.sh'), readFileSync('scripts/deploy-release.sh'), { mode: 0o755 });
  git(src, 'add', '-A'); git(src, 'commit', '-q', '-m', 'v1'); git(src, 'tag', 'v1.0.0');
  writeFileSync(join(src, 'package.json'), '{"name":"x","version":"1.1.0"}\n');
  // The new release's ensure-deps: recorded, and it fails when FAKE_DEPS_RC says so.
  writeFileSync(join(src, 'scripts', 'ensure-deps.sh'), `#!/usr/bin/env bash\necho "ensure-deps $*" >> ${JSON.stringify(log)}\nexit "\${FAKE_DEPS_RC:-0}"\n`, { mode: 0o755 });
  for (const [f, body] of Object.entries(v11)) writeFileSync(join(src, f), body, { mode: 0o755 });
  git(src, 'add', '-A'); git(src, 'commit', '-q', '-m', 'v2'); git(src, 'tag', 'v1.1.0');
  const origin = join(root, 'origin.git');
  git(root, 'clone', '-q', '--bare', src, origin);
  const prod = join(root, 'prod');
  git(root, 'clone', '-q', origin, prod);
  git(prod, 'checkout', '-q', 'v1.0.0');
  mkdirSync(join(prod, 'node_modules')); writeFileSync(join(prod, 'node_modules', 'marker'), 'deps');
  const deploy = (extra: Record<string, string> = {}) => spawnSync('bash', [join(prod, 'scripts', 'deploy-release.sh'), 'v1.1.0'], {
    encoding: 'utf8', env: { ...env, HATCHABOT_PROD_DIR: prod, ...extra },
  });
  const at = () => git(prod, 'describe', '--tags', '--exact-match');
  return { root, home, bin, env, log, prod, deploy, at, git };
}

describe('scripts/deploy-release.sh (review, 2026-10-09)', () => {
  it('serves the new release, installed through ensure-deps (it compiles the driver and writes the stamp; bare npm ci did neither)', () => {
    const w = prodWorld();
    const r = w.deploy();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Serving 1.1.0.');
    expect(lines(w.log)).toEqual(['ensure-deps --quiet', 'systemctl --user restart hatchabot']);
    expect(existsSync(join(w.prod, 'node_modules.prev'))).toBe(false);
  });

  it('an install that fails: back on the old release with its dependencies, exit 3, and the service is NOT restarted', () => {
    const w = prodWorld();
    const r = w.deploy({ FAKE_DEPS_RC: '1' });
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(w.at()).toBe('v1.0.0');
    expect(existsSync(join(w.prod, 'node_modules', 'marker'))).toBe(true);
    expect(lines(w.log).filter((l) => l.startsWith('systemctl'))).toEqual([]);
  });

  it('a release whose service does not restart: rolled back, the old one restarted, exit 1', () => {
    const w = prodWorld();
    const r = w.deploy({ FAKE_SYSTEMCTL_RC: '1' });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(w.at()).toBe('v1.0.0');
    expect(existsSync(join(w.prod, 'node_modules', 'marker'))).toBe(true);
    expect(lines(w.log).filter((l) => l.startsWith('systemctl'))).toHaveLength(2);
  });

  it('a step that fails part-way (the checkout, after node_modules moved aside) puts prod back and says 3, not 1', () => {
    const w = prodWorld();
    writeFileSync(join(w.bin, 'git'), `#!/usr/bin/env bash\n[ "$1 $2 $3" = "checkout --quiet v1.1.0" ] && { echo "error: simulated" >&2; exit 1; }\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`, { mode: 0o755 });
    const r = w.deploy();
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(existsSync(join(w.prod, 'node_modules', 'marker'))).toBe(true);
    expect(existsSync(join(w.prod, 'node_modules.prev'))).toBe(false);
  });

  it('takes its lock in the user\'s state folder, not /tmp', () => {
    const w = prodWorld();
    const sum = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', w.prod], { encoding: 'utf8' }).trim();
    mkdirSync(join(w.home, '.local', 'state', 'hatchabot', `upgrade-${sum}.lock.d`), { recursive: true });
    const r = w.deploy();
    expect(r.status, r.stdout + r.stderr).toBe(4);
  });
});

describe('scripts/follow-latest.sh (review, 2026-10-09)', () => {
  it('a tag whose deploy keeps failing to install waits longer each time, then is set aside', () => {
    // v1.1.0's deploy script: recorded, and exits with what rc.txt says.
    const root = mkdtempSync(join(tmpdir(), 'hb-follow-latest-rc-')); dirs.push(root);
    const rc = join(root, 'rc.txt'), deploys = join(root, 'deploys.log');
    const w = prodWorld({ 'scripts/deploy-release.sh': `#!/usr/bin/env bash\necho "deploy $*" >> ${JSON.stringify(deploys)}\nexit "$(cat ${JSON.stringify(rc)})"\n` });
    mkdirSync(join(w.prod, 'scripts'), { recursive: true });
    writeFileSync(join(w.root, 'follow-latest.sh'), readFileSync('scripts/follow-latest.sh'), { mode: 0o755 });
    const state = join(w.home, '.local', 'state', 'hatchabot');
    const follow = (code: number) => {
      writeFileSync(rc, String(code));
      return spawnSync('bash', [join(w.root, 'follow-latest.sh')], { encoding: 'utf8', env: { ...w.env, HATCHABOT_PROD_DIR: w.prod } });
    };
    expect(follow(3).stdout).toContain('tried again later (1 of 8)');
    follow(3);
    expect(lines(deploys)).toHaveLength(1); // too soon
    writeFileSync(join(state, 'follow-latest-tries'), 'v1.1.0 7 0\n');
    expect(follow(3).stdout).toContain('did not complete 8 times in a row');
    expect(readFileSync(join(state, 'follow-latest-failed'), 'utf8').trim()).toBe('v1.1.0');
    follow(0);
    expect(lines(deploys)).toHaveLength(2);
  });
});
