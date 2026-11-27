import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptEnv, systemPathWithout } from './helpers/scriptEnv.js';

// Every test here runs a real shell script in a sandbox; one waits out the
// probe's 5 s deadline, and the machine may be loaded.
vi.setConfig({ testTimeout: 30_000 });

/**
 * scripts/with-docker.sh, which starts the service (and the nightly backup)
 * with access to Docker, in a sandbox: a temp HOME, and docker, sg, id and
 * getent as shims first on the PATH, so nothing asks the real daemon or
 * this machine's groups. The command it starts only writes that it ran.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const shim = (dir: string, name: string, body: string) => writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });

/**
 * `noTimeout`: a machine with neither timeout nor gtimeout on its PATH (a
 * Linux without coreutils' timeout: a Mac has no sg, and never gets that
 * far), the system's other commands linked in, and sleep a shim that notes
 * its pid (`sleeps`). `group`: what getent says of the docker group.
 */
function launcher(docker: string, opts: { noTimeout?: boolean; group?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hb-with-docker-')); dirs.push(root);
  const bin = join(root, 'bin'), home = join(root, 'home'), log = join(root, 'calls.log');
  for (const d of [bin, home]) mkdirSync(d);
  shim(bin, 'docker', docker);
  shim(bin, 'id', 'echo made-up-user');
  writeFileSync(join(root, 'group'), `${opts.group ?? 'docker:x:990:made-up-user'}\n`);
  shim(bin, 'getent', `cat '${join(root, 'group')}'`);
  shim(bin, 'sg', `echo "sg $1" >> '${log}'; [ "$2" = -c ] && exec bash -c "$3"`);
  shim(bin, 'app', `echo "app ran: $* (in docker group: \${HATCHABOT_IN_DOCKER_GROUP:-no})" >> '${log}'`);
  const system = opts.noTimeout ? systemPathWithout(join(root, 'system'), ['timeout', 'gtimeout']) : '/usr/bin:/bin';
  const sleepsAt = join(root, 'sleeps');
  if (opts.noTimeout) {
    const real = spawnSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).stdout.trim();
    shim(bin, 'sleep', `echo $$ >> '${sleepsAt}'; exec '${real}' "$@"`);
  }
  const run = () => {
    const started = Date.now();
    const r = spawnSync('bash', ['scripts/with-docker.sh', join(bin, 'app'), 'serve'], { encoding: 'utf8', timeout: 20_000, env: scriptEnv(home, `${bin}:${system}`) });
    return { ...r, ms: Date.now() - started };
  };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  /** The sleeps started, the watcher's and a probe's, that are still running. */
  const sleeping = () => (existsSync(sleepsAt) ? readFileSync(sleepsAt, 'utf8').split('\n').filter(Boolean).map(Number) : [])
    .filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const sleeps = () => (existsSync(sleepsAt) ? readFileSync(sleepsAt, 'utf8').split('\n').filter(Boolean).length : 0);
  return { bin, log, run, calls, sleeping, sleeps };
}

describe('scripts/with-docker.sh', () => {
  it('a Docker that takes the request and never answers: the command starts anyway, within the probe\'s deadline (HB-1060)', () => {
    // `exec`, so the deadline's signal reaches the waiting process itself.
    const l = launcher('[ "$1" = info ] && exec sleep 30\nexit 0');
    const r = l.run();
    expect(r.signal, 'still waiting on docker info when the test gave up').toBeNull();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(l.calls()).toEqual(['app ran: serve (in docker group: no)']);
    expect(r.ms).toBeLessThan(15_000);
  });

  it('a docker group with a long member list: this user, first in it, is still found, and the command starts through sg docker (HB-1216)', () => {
    // Made-up members, some 20 000 of them after this user: far over what a pipe holds.
    const others = Array.from({ length: 20_000 }, (_, i) => `made-up-member-${i}`).join(',');
    const l = launcher('echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1', { group: `docker:x:990:made-up-user,${others}` });
    const r = l.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(l.calls()).toEqual(['sg docker', 'app ran: serve (in docker group: 1)']);
  });

  it('a docker group that does not list this user (only a name it begins): the command starts as it is', () => {
    const l = launcher('echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1', { group: 'docker:x:990:made-up-user2,made-up-use' });
    expect(l.run().status).toBe(0);
    expect(l.calls()).toEqual(['app ran: serve (in docker group: no)']);
  });

  it('a Linux with no timeout command: a Docker that never answers still holds the start no longer than the deadline, and leaves no sleep behind (HB-1215)', () => {
    const l = launcher('[ "$1" = info ] && exec sleep 30\nexit 0', { noTimeout: true });
    const r = l.run();
    expect(r.signal, 'still waiting on docker info when the test gave up').toBeNull();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(l.calls()).toEqual(['app ran: serve (in docker group: no)']);
    expect(r.ms).toBeLessThan(15_000);
    // The probe's, the watcher's 5 s one and (when it got that far first) its 2 s one: none still running once the command has started.
    expect(l.sleeps()).toBeGreaterThanOrEqual(2);
    expect(l.sleeping()).toEqual([]);
  });

  it('a Linux with no timeout command: a Docker that refuses this user is still told at once, and the command starts through sg docker (HB-1215)', () => {
    const l = launcher('echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1', { noTimeout: true });
    const r = l.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(l.calls()).toEqual(['sg docker', 'app ran: serve (in docker group: 1)']);
    expect(r.ms).toBeLessThan(4_000);
    // The watcher's 5 s sleep went with it (review of HB-1215): it was left running.
    expect(l.sleeping()).toEqual([]);
  });

  it('a Linux with only Homebrew\'s coreutils: gtimeout gives the probe its deadline (HB-1215)', () => {
    const l = launcher('[ "$1" = info ] && exec sleep 30\nexit 0', { noTimeout: true });
    const real = spawnSync('sh', ['-c', 'command -v timeout'], { encoding: 'utf8' }).stdout.trim();
    shim(l.bin, 'gtimeout', `echo "gtimeout $*" >> '${l.log}'; exec '${real}' "$@"`);
    const r = l.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(l.calls()).toEqual(['gtimeout -k 2 5 docker info', 'app ran: serve (in docker group: no)']);
    expect(r.ms).toBeLessThan(15_000);
  });

  it('a Docker that answers: the command starts as it is', () => {
    const l = launcher('exit 0');
    expect(l.run().status).toBe(0);
    expect(l.calls()).toEqual(['app ran: serve (in docker group: no)']);
  });

  it('a Docker that refuses this user, who /etc/group lists in docker: started through sg docker, as before', () => {
    const l = launcher('echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1');
    expect(l.run().status).toBe(0);
    expect(l.calls()).toEqual(['sg docker', 'app ran: serve (in docker group: 1)']);
  });
});
