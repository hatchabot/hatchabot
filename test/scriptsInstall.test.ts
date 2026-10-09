import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

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

function world(curl: string) {
  const root = mkdtempSync(join(tmpdir(), 'hb-install-')); dirs.push(root);
  const home = join(root, 'home'); mkdirSync(home);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const log = join(root, 'calls.log');
  shim(bin, 'docker', 'case "$1" in version) echo 27.0 ;; esac; exit 0');
  shim(bin, 'uname', 'case "${1:-}" in -m) echo x86_64 ;; *) echo Linux ;; esac');
  shim(bin, 'getconf', 'echo "glibc 2.39"');
  shim(bin, 'curl', curl);
  for (const refuse of ['sudo', 'apt-get', 'brew']) shim(bin, refuse, `echo "${refuse} $*" >> ${JSON.stringify(log)}; exit 1`);
  const dir = join(root, 'hatchabot');
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

describe('install.sh re-run on a clone install (review, 2026-10-09)', () => {
  it('upgrades through upgrade.sh (its lock and rollback) instead of checking out and installing in place', () => {
    const w = world(CHANNELS);
    mkdirSync(join(w.dir, '.git'), { recursive: true }); mkdirSync(join(w.dir, 'scripts'));
    writeFileSync(join(w.dir, '.env'), 'HATCHABOT_SECRET_KEY=made-up\n');
    shim(join(w.dir, 'scripts'), 'with-docker.sh', `echo "with-docker $*" >> ${JSON.stringify(w.log)}`);
    const r = w.run(['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(w.log, 'utf8')).toBe('with-docker ./scripts/upgrade.sh stable\n');
    expect(readFileSync(join(w.home, '.config', 'hatchabot', 'channel'), 'utf8')).toBe('stable\n');
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
