import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

// Every test here runs real shell scripts (git, bash, a fake gh) in a sandbox. On the
// self-hosted runner CI shares the machine with other work, and vitest's 5 s was not
// enough under load (land, promote, release, first-run-link; 2026-10-23).
vi.setConfig({ testTimeout: 30_000 });

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
  /**
   * An install whose release-target.sh says v1.1.0 and whose upgrade.sh exits with what rc.txt says.
   * `beside`: another install of the same user (same HOME), in the same root.
   */
  function world(beside?: { root: string; home: string }, name = 'app') {
    const root = beside?.root ?? mkdtempSync(join(tmpdir(), 'hb-follow-channel-')); if (!beside) dirs.push(root);
    const home = beside?.home ?? join(root, 'home'); mkdirSync(home, { recursive: true });
    const bin = join(root, 'bin'); mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'systemctl'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const app = join(root, name); mkdirSync(join(app, 'scripts'), { recursive: true });
    writeFileSync(join(app, 'scripts', 'follow-channel.sh'), readFileSync('scripts/follow-channel.sh'), { mode: 0o755 });
    const asked = join(root, `${name}-asked.log`);
    writeFileSync(join(app, 'scripts', 'release-target.sh'), `#!/usr/bin/env bash\necho "$1" >> ${JSON.stringify(asked)}\necho v1.1.0\n`, { mode: 0o755 });
    const log = join(root, `${name}-upgrades.log`), rc = join(root, `${name}-rc.txt`);
    writeFileSync(join(app, 'scripts', 'upgrade.sh'), `#!/usr/bin/env bash\necho "upgrade $* timer=\${HATCHABOT_UPGRADE_BY_TIMER:-} target=\${HATCHABOT_UPGRADE_TARGET:-}" >> ${JSON.stringify(log)}\nexit "$(cat ${JSON.stringify(rc)})"\n`, { mode: 0o755 });
    const state = join(home, '.local', 'state', 'hatchabot');
    const follow = (...args: string[]) => spawnSync('bash', [join(app, 'scripts', 'follow-channel.sh'), ...args], { encoding: 'utf8', env: scriptEnv(home, `${bin}:/usr/bin:/bin`) });
    const run = (code: number) => {
      writeFileSync(rc, String(code));
      return follow('stable');
    };
    // Its records are its own, keyed on its path as the upgrade lock is (audit #034).
    const key = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', app], { encoding: 'utf8' }).trim();
    return { root, home, run, follow, log, asked, state, tries: join(state, `follow-channel-tries-${key}`), failed: join(state, `follow-channel-failed-${key}`), channelFile: join(home, '.config', 'hatchabot', 'channel') };
  }

  it('asks upgrade.sh as the timer (so it leaves the chosen channel alone), for the release it resolved', () => {
    const w = world();
    expect(w.run(0).status).toBe(0);
    expect(lines(w.log)).toEqual(['upgrade stable timer=1 target=v1.1.0']);
  });

  it('follows the channel chosen last, not the one the timer was installed with (audit #043)', () => {
    const w = world();
    const installed = w.follow('--install', 'stable');
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    expect(readFileSync(w.channelFile, 'utf8').trim()).toBe('stable'); // --install remembers it, as `hatchabot upgrade stable` does
    // `hatchabot upgrade beta` remembers beta (scripts/upgrade.sh); the timer still says stable.
    writeFileSync(w.channelFile, 'beta\n');
    expect(w.run(0).status).toBe(0);
    expect(lines(w.asked)).toEqual(['beta']);
    expect(lines(w.log)).toEqual(['upgrade beta timer=1 target=v1.1.0']);
    // A version there is a pin: the timer leaves the machine alone, and asks nothing.
    writeFileSync(w.channelFile, 'v1.0.0\n');
    expect(w.run(0).status).toBe(0);
    expect(lines(w.asked)).toEqual(['beta']);
    expect(lines(w.log)).toHaveLength(1);
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

  it('a release that failed on one install of the user\'s is still tried on another, and their retries are counted apart (audit #034)', () => {
    const first = world();
    const second = world(first, 'second-app');
    expect(first.run(1).status).toBe(1);
    expect(readFileSync(first.failed, 'utf8').trim()).toBe('v1.1.0');
    expect(second.run(0).status).toBe(0);
    expect(lines(second.log)).toEqual(['upgrade stable timer=1 target=v1.1.0']);
    // A failing install on the second does not make the first wait, or count towards its MAX_TRIES.
    const third = world(first, 'third-app');
    expect(second.run(3).status).toBe(1);
    expect(third.run(3).stdout).toContain('(1 of 8)');
    expect(lines(third.log)).toHaveLength(1);
  });

  it('a record from before, not yet keyed on an install, is taken over: the release stays set aside', () => {
    const w = world();
    mkdirSync(w.state, { recursive: true });
    writeFileSync(join(w.state, 'follow-channel-failed'), 'v1.1.0\n');
    expect(w.run(0).status).toBe(0);
    expect(lines(w.log)).toEqual([]);
    expect(readFileSync(w.failed, 'utf8').trim()).toBe('v1.1.0');
    expect(existsSync(join(w.state, 'follow-channel-failed'))).toBe(false);
  });
});

describe('scripts/follow-channel.sh with the real upgrade.sh (audit #042)', () => {
  it('the release it sets aside is the one upgrade.sh tried, though the channel moved between the two', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-follow-target-')); dirs.push(root);
    const app = join(root, 'app'), home = join(root, 'home'), bin = join(root, 'bin');
    for (const d of [join(app, 'scripts'), home, bin]) mkdirSync(d, { recursive: true });
    const asked = join(root, 'asked'), restarts = join(root, 'restarts');
    const env = scriptEnv(home, `${bin}:/usr/bin:/bin`, { HATCHABOT_INSTALL_CMD: 'true', HATCHABOT_RESTART_CMD: join(app, 'scripts', 'restart.sh'), HATCHABOT_UPGRADE_IMAGE: '0' });
    const git = (...args: string[]) => execFileSync(REAL_GIT, args, { cwd: app, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q', '-b', 'main');
    for (const f of ['follow-channel.sh', 'upgrade.sh']) writeFileSync(join(app, 'scripts', f), readFileSync(join('scripts', f)), { mode: 0o755 });
    // stable names v1.1.0 when asked first, and v1.2.0 from the next question on (promoted meanwhile).
    writeFileSync(join(app, 'scripts', 'release-target.sh'), `#!/usr/bin/env bash\necho "$1" >> ${JSON.stringify(asked)}\nif [ "$(wc -l < ${JSON.stringify(asked)})" -le 1 ]; then echo v1.1.0; else echo v1.2.0; fi\n`, { mode: 0o755 });
    // v1.2.0 does not come up; the others do.
    writeFileSync(join(app, 'scripts', 'restart.sh'), `#!/usr/bin/env bash\ntag="$(git describe --tags --exact-match)"\necho "$tag" >> ${JSON.stringify(restarts)}\n[ "$tag" != v1.2.0 ]\n`, { mode: 0o755 });
    writeFileSync(join(app, '.gitignore'), 'node_modules/\nnode_modules.prev/\n');
    for (const v of ['1.0.0', '1.1.0', '1.2.0']) {
      writeFileSync(join(app, 'package.json'), JSON.stringify({ version: v }));
      git('add', '-A'); git('commit', '-qm', `v${v}`); git('tag', `v${v}`);
    }
    git('checkout', '-q', 'v1.0.0');
    const tick = () => spawnSync('bash', [join(app, 'scripts', 'follow-channel.sh'), 'stable'], { env, encoding: 'utf8' });
    // This install's own record, keyed on its path (audit #034).
    const key = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', app], { encoding: 'utf8' }).trim();
    const failed = join(home, '.local', 'state', 'hatchabot', `follow-channel-failed-${key}`);
    const first = tick();
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain('Upgrading v1.0.0 → v1.1.0'); // what the timer resolved, not a second answer
    expect(lines(asked)).toEqual(['stable']);
    const second = tick();
    expect(second.status, second.stdout + second.stderr).toBe(1);
    expect(readFileSync(failed, 'utf8').trim()).toBe('v1.2.0'); // the release that failed, by its own name
    const third = tick();
    expect(third.status, third.stdout + third.stderr).toBe(0);
    expect(lines(restarts)).toEqual(['v1.1.0', 'v1.2.0', 'v1.1.0']); // tried once, rolled back, not tried again
    expect(git('describe', '--tags', '--exact-match')).toBe('v1.1.0');
  });
});

/** A throwaway origin with v1.0.0 and v1.1.0, and production cloned from it at v1.0.0. */
function prodWorld(v11: Record<string, string> = {}, [oldTag, newTag] = ['v1.0.0', 'v1.1.0']) {
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
  git(src, 'add', '-A'); git(src, 'commit', '-q', '-m', 'v1'); git(src, 'tag', oldTag);
  writeFileSync(join(src, 'package.json'), '{"name":"x","version":"1.1.0"}\n');
  // The new release's ensure-deps: recorded, and it fails when FAKE_DEPS_RC says so.
  writeFileSync(join(src, 'scripts', 'ensure-deps.sh'), `#!/usr/bin/env bash\necho "ensure-deps $*" >> ${JSON.stringify(log)}\nexit "\${FAKE_DEPS_RC:-0}"\n`, { mode: 0o755 });
  for (const [f, body] of Object.entries(v11)) writeFileSync(join(src, f), body, { mode: 0o755 });
  git(src, 'add', '-A'); git(src, 'commit', '-q', '-m', 'v2'); git(src, 'tag', newTag);
  const origin = join(root, 'origin.git');
  git(root, 'clone', '-q', '--bare', src, origin);
  const prod = join(root, 'prod');
  git(root, 'clone', '-q', origin, prod);
  git(prod, 'checkout', '-q', oldTag);
  mkdirSync(join(prod, 'node_modules')); writeFileSync(join(prod, 'node_modules', 'marker'), 'deps');
  const deploy = (extra: Record<string, string> = {}) => spawnSync('bash', [join(prod, 'scripts', 'deploy-release.sh'), newTag], {
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

  it('after a deploy killed right after moving node_modules aside, a failed install still rolls back to those dependencies (audit #033)', () => {
    const w = prodWorld();
    renameSync(join(w.prod, 'node_modules'), join(w.prod, 'node_modules.prev')); // the only working copy
    const r = w.deploy({ FAKE_DEPS_RC: '1' });
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(w.at()).toBe('v1.0.0');
    expect(readFileSync(join(w.prod, 'node_modules', 'marker'), 'utf8')).toBe('deps');
    expect(existsSync(join(w.prod, 'node_modules.prev'))).toBe(false);
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

  describe('asks the listener the service is configured with (audit #030, #031)', () => {
    /** Production's .env (kept out of git status), and a service that answers only at `url`. */
    function serving(env: string, url: string) {
      const w = prodWorld();
      writeFileSync(join(w.prod, '.git', 'info', 'exclude'), '.env\n');
      writeFileSync(join(w.prod, '.env'), env);
      const asked = join(w.root, 'asked.log');
      writeFileSync(join(w.bin, 'curl'), `#!/usr/bin/env bash\necho "\${@: -1}" >> ${JSON.stringify(asked)}\n[ "\${@: -1}" = ${JSON.stringify(url)} ] || exit 7\necho '<script>window.HATCHABOT_VERSION="1.1.0"</script>'\n`, { mode: 0o755 });
      writeFileSync(join(w.bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
      return { ...w, r: w.deploy(), asked: () => lines(asked) };
    }

    it('a service bound to one LAN or IPv6 address is asked there, and the healthy release stays', () => {
      for (const [bind, url] of [['192.0.2.10', 'http://192.0.2.10:9090/'], ['2001:db8::10', 'http://[2001:db8::10]:9090/']] as const) {
        const w = serving(`HATCHABOT_BIND=${bind}\nPORT=9090\n`, url);
        expect(w.r.status, w.r.stdout + w.r.stderr).toBe(0);
        expect(w.r.stdout).toContain('Serving 1.1.0.');
        expect(w.at()).toBe('v1.1.0');
        expect(w.asked()).toEqual([url]);
      }
    });

    it('a name set twice in .env is read as the service reads it: the last one, without its comment', () => {
      const w = serving('PORT=8080\nHATCHABOT_TLS_CERT=\nPORT=9090   # moved off 8080\n', 'http://127.0.0.1:9090/');
      expect(w.r.status, w.r.stdout + w.r.stderr).toBe(0);
      expect(w.asked()).toEqual(['http://127.0.0.1:9090/']);
    });
  });

  it('a fetch that fails before anything changed (another fetch\'s ref lock) says 3, try again — not 1, set aside (audit #032)', () => {
    const w = prodWorld();
    // What a concurrent fetch leaves while it runs: its lock on the remote-tracking ref.
    w.git(w.prod, 'update-ref', '-d', 'refs/remotes/origin/main');
    mkdirSync(join(w.prod, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
    writeFileSync(join(w.prod, '.git', 'refs', 'remotes', 'origin', 'main.lock'), 'held by another fetch');
    const r = w.deploy();
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stderr).toContain('cannot lock ref');
    expect(r.stdout).toContain('nothing was changed');
    expect(w.at()).toBe('v1.0.0');
    expect(existsSync(join(w.prod, 'node_modules', 'marker'))).toBe(true);
    expect(lines(w.log)).toEqual([]); // nothing installed, nothing restarted
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

describe('scripts/follow-latest.sh runs only a release the workflow published (#37)', () => {
  /**
   * Production at v2.159.1, a new tag v2.160.0 whose deploy script only records
   * that it ran, and a fake curl standing in for GitHub: the API's answer for
   * the release and the release's manifest come from files (none = a 404;
   * an `offline` file = no network). Every URL asked for is logged.
   */
  function world(newTag = 'v2.160.0', oldTag = 'v2.159.1') {
    const root = mkdtempSync(join(tmpdir(), 'hb-follow-verify-')); dirs.push(root);
    const ran = join(root, 'ran.log');
    const w = prodWorld({ 'scripts/deploy-release.sh': `#!/usr/bin/env bash\necho "deploy $*" >> ${JSON.stringify(ran)}\n` }, [oldTag, newTag]);
    const gh = join(root, 'gh'); mkdirSync(gh);
    writeFileSync(join(w.bin, 'curl'), [
      '#!/usr/bin/env bash',
      `GH=${JSON.stringify(gh)}`,
      'out=""; fmt=""; url=""',
      'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; -w) fmt="$2"; shift ;; -H|--max-time|--max-filesize|--retry) shift ;; http*) url="$1" ;; esac; shift; done',
      'echo "$url" >> "$GH/urls.log"',
      '[ -e "$GH/offline" ] && { echo "curl: (6) Could not resolve host" >&2; exit 6; }',
      'case "$url" in */releases/tags/*) src="$GH/release.json" ;; */release-manifest.json) src="$GH/manifest.json" ;; *) src=/nonexistent ;; esac',
      'if [ -f "$src" ]; then cp "$src" "$out"; code=200; else echo "Not Found" > "$out"; code=404; fi',
      'printf "%s" "${fmt//%\\{http_code\\}/$code}"',
    ].join('\n') + '\n', { mode: 0o755 });
    writeFileSync(join(w.root, 'follow-latest.sh'), readFileSync('scripts/follow-latest.sh'), { mode: 0o755 });
    const commit = w.git(w.prod, 'rev-parse', `${newTag}^{commit}`);
    const release = (over: Record<string, unknown> = {}) => writeFileSync(join(gh, 'release.json'), JSON.stringify({
      tag_name: newTag, draft: false, immutable: true,
      assets: [{ name: 'hatchabot-v2.160.0-linux-x64.tar.gz' }, { name: 'release-manifest.json' }], ...over,
    }));
    const manifest = (over: Record<string, unknown> = {}) => writeFileSync(join(gh, 'manifest.json'), JSON.stringify({
      schema: 1, version: newTag.slice(1), tag: newTag, commit, createdAt: '2026-10-10T12:00:00Z', ...over,
    }));
    const state = join(w.home, '.local', 'state', 'hatchabot');
    const follow = () => spawnSync('bash', [join(w.root, 'follow-latest.sh')], { encoding: 'utf8', env: { ...w.env, HATCHABOT_PROD_DIR: w.prod } });
    const urls = () => lines(join(gh, 'urls.log'));
    return { ...w, gh, ran, commit, release, manifest, follow, urls, state };
  }

  it('deploys a published, immutable release whose manifest names the tag and its commit', () => {
    const w = world();
    w.release(); w.manifest();
    const r = w.follow();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lines(w.ran)).toEqual(['deploy v2.160.0']);
    expect(w.urls()).toEqual([
      'https://api.github.com/repos/hatchabot/hatchabot/releases/tags/v2.160.0',
      'https://github.com/hatchabot/hatchabot/releases/download/v2.160.0/release-manifest.json',
    ]);
  });

  it('refuses, without running any of the tag\'s code, a manifest for another commit, tag or version', () => {
    for (const [over, why] of [
      [{ commit: 'f'.repeat(40) }, /was built from f{40}, but the tag here is/],
      [{ tag: 'v2.159.9', version: '2.159.9' }, /is for "v2\.159\.9"/],
      [{ version: '2.160.1' }, /is for "v2\.160\.0" \("2\.160\.1"\)/],
    ] as const) {
      const w = world();
      w.release(); w.manifest(over);
      const r = w.follow();
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(why);
      expect(r.stdout).toContain('None of its code was run. It will not be retried');
      expect(lines(w.ran)).toEqual([]);
      expect(readFileSync(join(w.state, 'follow-latest-failed'), 'utf8').trim()).toBe('v2.160.0');
      // Set aside: the next tick does not look again.
      const before = w.urls().length;
      w.follow();
      expect(w.urls()).toHaveLength(before);
    }
  });

  it('refuses a release that is not immutable, or has no manifest', () => {
    for (const [setup, why] of [
      [(w: ReturnType<typeof world>) => { w.release({ immutable: false }); w.manifest(); }, /is not immutable/],
      [(w: ReturnType<typeof world>) => { w.release({ assets: [{ name: 'hatchabot-v2.160.0-linux-x64.tar.gz' }] }); w.manifest(); }, /has no release-manifest\.json/],
      [(w: ReturnType<typeof world>) => { w.release(); }, /listed but not there/],
    ] as const) {
      const w = world();
      setup(w);
      const r = w.follow();
      expect(r.stdout).toMatch(why);
      expect(lines(w.ran)).toEqual([]);
      expect(readFileSync(join(w.state, 'follow-latest-failed'), 'utf8').trim()).toBe('v2.160.0');
    }
  });

  it('a tag that is not (yet) a published release waits, longer each time, then is set aside', () => {
    const w = world();
    const first = w.follow();
    expect(first.stdout).toContain('Not deploying v2.160.0 yet: it is not a published release on GitHub. Looking again later (1 of 8)');
    w.follow();
    expect(w.urls()).toHaveLength(1); // too soon to look again
    writeFileSync(join(w.state, 'follow-latest-tries'), 'v2.160.0 7 0\n');
    expect(w.follow().stdout).toContain('8 times in a row. It will not be looked at again');
    expect(readFileSync(join(w.state, 'follow-latest-failed'), 'utf8').trim()).toBe('v2.160.0');
    expect(lines(w.ran)).toEqual([]);
  });

  it('no network: nothing deployed, nothing set aside, tried again next time', () => {
    const w = world();
    w.release(); w.manifest();
    writeFileSync(join(w.gh, 'offline'), '');
    const r = w.follow();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('GitHub did not answer');
    expect(existsSync(join(w.state, 'follow-latest-failed'))).toBe(false);
    rmSync(join(w.gh, 'offline'));
    expect(w.follow().status).toBe(0);
    expect(lines(w.ran)).toEqual(['deploy v2.160.0']);
  });

  it('a tag from before manifests (older than v2.159.0) is deployed as before, without asking GitHub', () => {
    const w = world('v2.158.9', 'v2.158.0');
    const r = w.follow();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lines(w.ran)).toEqual(['deploy v2.158.9']);
    expect(w.urls()).toEqual([]);
  });
});
