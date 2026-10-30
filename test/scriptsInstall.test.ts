import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

// Every test here runs real shell scripts (git, bash, a fake gh) in a sandbox. On the
// self-hosted runner CI shares the machine with other work, and vitest's 5 s was not
// enough under load (land, promote, release, first-run-link; 2026-10-23).
vi.setConfig({ testTimeout: 30_000 });

/**
 * install.sh and install-service.sh in a sandbox (review, 2026-10-09): a temp
 * HOME, a PATH of shims (docker, curl, uname, getconf, systemctl, sudo, apt-get
 * — the last two only refuse) and the system dirs, an environment built from
 * scratch, and no terminal (setsid), so no question can wait on anyone.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const hasSetsid = spawnSync('sh', ['-c', 'command -v setsid']).status === 0;
const shim = (bin: string, name: string, body: string) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });

function world(curl: string, folder = 'hatchabot') {
  const root = mkdtempSync(join(tmpdir(), 'hb-install-')); dirs.push(root);
  const home = join(root, 'home'); mkdirSync(home);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const log = join(root, 'calls.log');
  shim(bin, 'docker', 'case "$1" in version) echo 27.0 ;; esac; exit 0');
  shim(bin, 'uname', 'case "${1:-}" in -m) echo x86_64 ;; *) echo Linux ;; esac');
  shim(bin, 'getconf', 'echo "glibc 2.39"');
  shim(bin, 'curl', curl);
  for (const refuse of ['sudo', 'apt-get', 'brew']) shim(bin, refuse, `echo "${refuse} $*" >> ${JSON.stringify(log)}; exit 1`);
  const dir = join(root, folder);
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const cmd = [resolve('install.sh'), ...args];
    return spawnSync(hasSetsid ? 'setsid' : 'bash', hasSetsid ? ['bash', ...cmd] : cmd, {
      encoding: 'utf8', timeout: 30_000, input: '',
      env: scriptEnv(home, `${bin}:/usr/bin:/bin`, { HATCHABOT_DIR: dir, ...extra }),
    });
  };
  return { root, home, bin, dir, log, run };
}
const CHANNELS = `case "$*" in *channels.json*) printf '{\\n  "stable": "v2.0.0",\\n  "beta": "v2.1.0"\\n}\\n' ;; *releases/latest*) echo '{"tag_name": "v2.2.0"}' ;; *) exit 22 ;; esac`;

describe('install.sh picks the release, and says so when it cannot (review, 2026-10-09)', () => {
  it('on musl (no GNU_LIBC_VERSION) it goes on to the native install instead of ending silently', () => {
    const w = world(CHANNELS);
    shim(w.bin, 'getconf', 'exit 1');
    const r = w.run(['v9.9.9'], { HATCHABOT_DRY_RUN: '1' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('channel v9.9.9 → release v9.9.9 · no bundle for this machine · native');
  });

  it('no network: a message, not a silent exit', () => {
    const w = world('exit 6');
    const r = w.run(['stable'], { HATCHABOT_DRY_RUN: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Could not reach github.com');
  });

  it('a captive portal\'s page is not "stable is not named": it stops, and does not install the newest', () => {
    const w = world(`case "$*" in *channels.json*) echo '<html>Sign in to the cafe wifi</html>' ;; *) echo '{"tag_name": "v9.9.9"}' ;; esac`);
    const r = w.run(['stable'], { HATCHABOT_DRY_RUN: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not Hatchabot's channels file");
    expect(r.stdout).not.toContain('v9.9.9');
  });

  it('the channel named in channels.json; stable never falls back to the newest, beta does', () => {
    const w = world(CHANNELS);
    expect(w.run(['stable'], { HATCHABOT_DRY_RUN: '1' }).stdout).toContain('channel stable → release v2.0.0');
    const unnamed = world(`case "$*" in *channels.json*) echo '{"beta": "v2.1.0"}' ;; *releases/latest*) echo '{"tag_name": "v2.2.0"}' ;; esac`);
    const stable = unnamed.run(['stable'], { HATCHABOT_DRY_RUN: '1' });
    expect(stable.status).toBe(1);
    expect(stable.stdout).not.toContain('v2.2.0');
    const beta = world(`case "$*" in *channels.json*) echo '{"stable": "v2.0.0"}' ;; *releases/latest*) echo '{"tag_name": "v2.2.0"}' ;; esac`);
    expect(beta.run(['beta'], { HATCHABOT_DRY_RUN: '1' }).stdout).toContain('channel beta → release v2.2.0');
  });
});

/** The service unit setup-host.sh installs, running from dir: a finished setup. */
const serviceUnit = (home: string, dir: string) => {
  mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(join(home, '.config', 'systemd', 'user', 'hatchabot.service'), `[Service]\nWorkingDirectory=${dir}\nEnvironmentFile=${dir}/.env\n`);
};

describe('install.sh re-run on a clone install (review, 2026-10-09)', () => {
  it('upgrades through upgrade.sh (its lock and rollback) instead of checking out and installing in place', () => {
    const w = world(CHANNELS);
    mkdirSync(join(w.dir, '.git'), { recursive: true }); mkdirSync(join(w.dir, 'scripts'));
    writeFileSync(join(w.dir, '.env'), 'HATCHABOT_SECRET_KEY=made-up\n');
    serviceUnit(w.home, w.dir);
    shim(join(w.dir, 'scripts'), 'with-docker.sh', `echo "with-docker $*" >> ${JSON.stringify(w.log)}`);
    const r = w.run(['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(w.log, 'utf8')).toBe('with-docker ./scripts/upgrade.sh stable\n');
    expect(readFileSync(join(w.home, '.config', 'hatchabot', 'channel'), 'utf8')).toBe('stable\n');
  });
});

describe('install.sh re-run on an install whose folder has a % in its name (audit, 2026-10-29)', () => {
  it('reads the folder back from the unit, which doubles the %, and upgrades it', () => {
    const w = world(CHANNELS, 'hatchabot-%q');
    mkdirSync(join(w.dir, '.git'), { recursive: true }); mkdirSync(join(w.dir, 'scripts'));
    writeFileSync(join(w.dir, '.env'), 'HATCHABOT_SECRET_KEY=made-up\n');
    serviceUnit(w.home, w.dir.replace(/%/g, '%%'));
    shim(join(w.dir, 'scripts'), 'with-docker.sh', `echo "with-docker $*" >> ${JSON.stringify(w.log)}`);
    const r = w.run(['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(w.log, 'utf8')).toBe('with-docker ./scripts/upgrade.sh stable\n');
  });
});

describe('install.sh re-run after a first setup that stopped part-way finishes the setup (audit #041)', () => {
  it('a bundle unpacked but never set up (no .env, no service): setup-host.sh, not "Already on"', () => {
    const w = world(CHANNELS);
    mkdirSync(join(w.dir, 'scripts'), { recursive: true });
    writeFileSync(join(w.dir, 'BUNDLE.json'), '{"tag":"v2.0.0","platform":"linux-x64"}\n');
    shim(join(w.dir, 'scripts'), 'with-docker.sh', `echo "with-docker $*" >> ${JSON.stringify(w.log)}`);
    const r = w.run(['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('did not finish — finishing it now');
    expect(readFileSync(w.log, 'utf8')).toBe('with-docker ./scripts/setup-host.sh\n');
  });

  it('one unpacked at an older release: set up on that one, and the upgrade named for later', () => {
    const w = world(CHANNELS);
    mkdirSync(join(w.dir, 'scripts'), { recursive: true });
    writeFileSync(join(w.dir, 'BUNDLE.json'), '{"tag":"v1.9.0","platform":"linux-x64"}\n');
    writeFileSync(join(w.dir, '.env'), 'HATCHABOT_SECRET_KEY=made-up\n'); // setup got as far as .env
    shim(join(w.dir, 'scripts'), 'with-docker.sh', `echo "with-docker $*" >> ${JSON.stringify(w.log)}`);
    const r = w.run(['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('on v1.9.0, the release unpacked then; once it is set up, hatchabot upgrade takes it to v2.0.0');
    expect(readFileSync(w.log, 'utf8')).toBe('with-docker ./scripts/setup-host.sh\n');
    expect(readFileSync(join(w.dir, '.env'), 'utf8')).toBe('HATCHABOT_SECRET_KEY=made-up\n');
  });

  it('a set-up bundle install (its service runs from it) is upgraded, as before', () => {
    const w = world(CHANNELS);
    mkdirSync(join(w.dir, 'scripts'), { recursive: true });
    writeFileSync(join(w.dir, 'BUNDLE.json'), '{"tag":"v2.0.0","platform":"linux-x64"}\n');
    writeFileSync(join(w.dir, '.env'), 'HATCHABOT_SECRET_KEY=made-up\n');
    serviceUnit(w.home, w.dir);
    shim(join(w.dir, 'scripts'), 'with-docker.sh', `echo "with-docker $*" >> ${JSON.stringify(w.log)}`);
    const r = w.run(['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(w.log, 'utf8')).toBe('with-docker ./scripts/upgrade.sh stable\n');
  });

  it('a clone whose setup wrote .env and then stopped: checked out at the release and set up, its .env kept', () => {
    const w = world(CHANNELS);
    symlinkSync(process.execPath, join(w.bin, 'node'));
    for (const t of ['make', 'g++', 'python3']) shim(w.bin, t, 'exit 0'); // the build tools the native install asks for, never run here
    const git = (cwd: string, ...args: string[]) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: scriptEnv(w.home, `${w.bin}:/usr/bin:/bin`) });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    };
    const src = join(w.root, 'src'); mkdirSync(join(src, 'scripts'), { recursive: true });
    git(src, 'init', '-q', '-b', 'main');
    writeFileSync(join(src, '.gitignore'), '.env\n');
    shim(join(src, 'scripts'), 'with-docker.sh', `echo "with-docker $* at $(git describe --tags --exact-match)" >> ${JSON.stringify(w.log)}`);
    git(src, 'add', '-A'); git(src, 'commit', '-q', '-m', 'v1.9'); git(src, 'tag', 'v1.9.0');
    git(src, 'commit', '-q', '--allow-empty', '-m', 'v2'); git(src, 'tag', 'v2.0.0');
    git(w.root, 'clone', '-q', src, w.dir); git(w.dir, 'checkout', '-q', 'v1.9.0');
    writeFileSync(join(w.dir, '.env'), 'HATCHABOT_SECRET_KEY=made-up\n');
    const r = w.run(['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(w.log, 'utf8')).toBe('with-docker ./scripts/setup-host.sh at v2.0.0\n');
    expect(readFileSync(join(w.dir, '.env'), 'utf8')).toBe('HATCHABOT_SECRET_KEY=made-up\n');
  });
});

describe('the units\' PATH holds a folder with a space in its name (audit #044)', () => {
  const ANALYZE = '/usr/bin/systemd-analyze';
  /** systemd's own reading of a generated unit, offline: only the unit's folder searched, no generators, nothing started. */
  const verify = (home: string, unit: string) => spawnSync(ANALYZE, ['verify', '--man=no', '--generators=no', '--recursive-errors=no', unit], {
    encoding: 'utf8', env: scriptEnv(home, '/usr/bin:/bin', { SYSTEMD_UNIT_PATH: dirname(unit), SYSTEMD_ENVIRONMENT_GENERATOR_PATH: '/dev/null', SYSTEMD_LOG_COLOR: '0' }),
  });
  function units() {
    const root = mkdtempSync(join(tmpdir(), 'hb-unit-path-')); dirs.push(root);
    const home = join(root, 'home'); mkdirSync(home);
    const bin = join(root, 'bin'); mkdirSync(bin);
    // Node where a bundle install in such a folder keeps it (made-up names; a quote and a % too).
    const nodeDir = join(root, 'node "binaries" 100%'); mkdirSync(nodeDir);
    shim(nodeDir, 'node', 'exit 0');
    for (const t of ['systemctl', 'docker']) shim(bin, t, 'exit 0');
    for (const t of ['getent', 'pgrep']) shim(bin, t, 'exit 1');
    shim(bin, 'loginctl', 'echo Linger=yes');
    const app = join(root, 'app'); mkdirSync(join(app, 'scripts'), { recursive: true }); mkdirSync(join(app, 'deploy')); mkdirSync(join(app, 'node_modules', '.bin'), { recursive: true });
    for (const f of ['install-service.sh', 'follow-channel.sh']) writeFileSync(join(app, 'scripts', f), readFileSync(join('scripts', f)), { mode: 0o755 });
    for (const u of ['hatchabot.service', 'hatchabot-backup.service', 'hatchabot-backup.timer']) writeFileSync(join(app, 'deploy', u), readFileSync(join('deploy', u)));
    for (const f of ['scripts/with-docker.sh', 'scripts/backup-volumes.sh', 'node_modules/.bin/tsx']) shim(app, f, 'exit 0');
    writeFileSync(join(app, '.env'), 'HATCHABOT_SECRET_KEY=made-up\n');
    const env = scriptEnv(home, `${nodeDir}:${bin}:/usr/bin:/bin`);
    const run = (script: string, ...args: string[]) => spawnSync('bash', [join(app, 'scripts', script), ...args], { encoding: 'utf8', input: '', env });
    return { home, nodeDir, run, unit: (name: string) => join(home, '.config', 'systemd', 'user', name) };
  }

  it('is written quoted whole, the quote and the % escaped for systemd', () => {
    const w = units();
    const a = w.run('install-service.sh');
    expect(a.status, a.stdout + a.stderr).toBe(0);
    const b = w.run('follow-channel.sh', '--install', 'stable');
    expect(b.status, b.stdout + b.stderr).toBe(0);
    const want = `Environment="PATH=${w.nodeDir.replace(/"/g, '\\"').replace(/%/g, '%%')}:`;
    for (const u of ['hatchabot.service', 'hatchabot-backup.service', 'hatchabot-follow-channel.service']) {
      const text = readFileSync(w.unit(u), 'utf8');
      expect(text, u).toContain(want);
      expect(text, u).toMatch(/^Environment="PATH=.*:\/usr\/bin:\/bin"$/m);
    }
  });

  it.skipIf(!existsSync(ANALYZE))('systemd reads it as one assignment (systemd-analyze verify)', () => {
    const w = units();
    expect(w.run('install-service.sh').status).toBe(0);
    expect(w.run('follow-channel.sh', '--install', 'stable').status).toBe(0);
    for (const u of ['hatchabot.service', 'hatchabot-backup.service', 'hatchabot-follow-channel.service']) {
      const r = verify(w.home, w.unit(u));
      expect(r.stderr, u).not.toContain('Invalid environment assignment');
      expect(r.status, `${u}: ${r.stderr}`).toBe(0);
    }
  });

  it('every unit a script writes quotes its PATH (the templates, the timers)', () => {
    const files = ['deploy/hatchabot.service', 'deploy/hatchabot-backup.service', 'scripts/install-service.sh', 'scripts/follow-channel.sh', 'scripts/follow-latest.sh', 'scripts/privacy-sync.sh'];
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/^Environment=PATH=/m);
  });
});

describe('the units hold an install folder with a % or a $ in its name (audit, 2026-10-29)', () => {
  const ANALYZE = '/usr/bin/systemd-analyze';
  const verify = (home: string, unit: string) => spawnSync(ANALYZE, ['verify', '--man=no', '--generators=no', '--recursive-errors=no', unit], {
    encoding: 'utf8', env: scriptEnv(home, '/usr/bin:/bin', { SYSTEMD_UNIT_PATH: dirname(unit), SYSTEMD_ENVIRONMENT_GENERATOR_PATH: '/dev/null', SYSTEMD_LOG_COLOR: '0' }),
  });
  function install() {
    const root = mkdtempSync(join(tmpdir(), 'hb-unit-dir-')); dirs.push(root);
    const home = join(root, 'home'), bin = join(root, 'bin'), app = join(root, 'install-%q a$b ${HOME}');
    for (const d of [home, bin, join(app, 'scripts'), join(app, 'deploy'), join(app, 'node_modules', '.bin')]) mkdirSync(d, { recursive: true });
    for (const t of ['systemctl', 'docker', 'node']) shim(bin, t, 'exit 0');
    for (const t of ['getent', 'pgrep']) shim(bin, t, 'exit 1');
    shim(bin, 'loginctl', 'echo Linger=yes');
    for (const f of ['install-service.sh', 'follow-channel.sh']) writeFileSync(join(app, 'scripts', f), readFileSync(join('scripts', f)), { mode: 0o755 });
    for (const u of ['hatchabot.service', 'hatchabot-backup.service', 'hatchabot-backup.timer']) writeFileSync(join(app, 'deploy', u), readFileSync(join('deploy', u)));
    for (const f of ['scripts/with-docker.sh', 'scripts/backup-volumes.sh', 'node_modules/.bin/tsx']) shim(app, f, 'exit 0');
    writeFileSync(join(app, '.env'), 'HATCHABOT_SECRET_KEY=made-up\n');
    const env = scriptEnv(home, `${bin}:/usr/bin:/bin`);
    for (const [script, ...args] of [['install-service.sh'], ['follow-channel.sh', '--install', 'stable']]) {
      const r = spawnSync('bash', [join(app, 'scripts', script!), ...args], { encoding: 'utf8', input: '', cwd: app, env });
      expect(r.status, script + r.stdout + r.stderr).toBe(0);
    }
    return { home, app, unit: (name: string) => join(home, '.config', 'systemd', 'user', name) };
  }

  it('writes the folder with % doubled, and $ doubled in ExecStart\'s arguments', () => {
    const w = install();
    const pct = w.app.replace(/%/g, '%%'), arg = pct.replace(/\$/g, '$$$$');
    const main = readFileSync(w.unit('hatchabot.service'), 'utf8');
    expect(main).toContain(`\nWorkingDirectory=${pct}\n`);
    expect(main).toContain(`\nEnvironmentFile=${pct}/.env\n`);
    expect(main).toContain(`\nExecStart="${pct}/scripts/with-docker.sh" "${arg}/node_modules/.bin/tsx" src/index.ts\n`);
    expect(readFileSync(w.unit('hatchabot-backup.service'), 'utf8')).toContain(`\nExecStart="${pct}/scripts/with-docker.sh" "${arg}/scripts/backup-volumes.sh"\n`);
    expect(readFileSync(w.unit('hatchabot-follow-channel.service'), 'utf8')).toContain(`\nExecStart=/usr/bin/env bash "${arg}/scripts/follow-channel.sh" stable\n`);
  });

  it.skipIf(!existsSync(ANALYZE))('systemd finds the programs there (systemd-analyze verify)', () => {
    const w = install();
    for (const u of ['hatchabot.service', 'hatchabot-backup.service', 'hatchabot-follow-channel.service']) {
      const r = verify(w.home, w.unit(u));
      expect(r.status, `${u}: ${r.stderr}`).toBe(0);
    }
  });
});

describe('scripts/install-service.sh without a docker group or $USER (review, 2026-10-09)', () => {
  it('goes on to the end (rootless Docker, podman, Docker Desktop for Linux have no docker group)', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-install-service-')); dirs.push(root);
    const home = join(root, 'home'); mkdirSync(home);
    const bin = join(root, 'bin'); mkdirSync(bin);
    const app = join(root, 'app'); mkdirSync(join(app, 'scripts'), { recursive: true }); mkdirSync(join(app, 'deploy'));
    writeFileSync(join(app, 'scripts', 'install-service.sh'), readFileSync('scripts/install-service.sh'), { mode: 0o755 });
    for (const u of ['hatchabot.service', 'hatchabot-backup.service', 'hatchabot-backup.timer']) writeFileSync(join(app, 'deploy', u), readFileSync(join('deploy', u)));
    writeFileSync(join(app, '.env'), 'HATCHABOT_SECRET_KEY=made-up\n');
    const log = join(root, 'calls.log');
    for (const t of ['systemctl', 'loginctl', 'docker', 'node', 'pgrep']) shim(bin, t, `echo "${t} $*" >> ${JSON.stringify(log)}; exit 0`);
    shim(bin, 'getent', 'exit 2'); // no such group
    const r = spawnSync('bash', [join(app, 'scripts', 'install-service.sh')], { encoding: 'utf8', input: '', env: scriptEnv(home, `${bin}:/usr/bin:/bin`) });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Lingering/);
    expect(existsSync(join(home, '.config', 'systemd', 'user', 'hatchabot.service'))).toBe(true);
    expect(readFileSync(log, 'utf8')).toMatch(/loginctl show-user \S+/); // the user's name, though $USER is not set
  });
});
