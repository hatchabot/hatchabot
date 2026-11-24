import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

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

function launcher(docker: string) {
  const root = mkdtempSync(join(tmpdir(), 'hb-with-docker-')); dirs.push(root);
  const bin = join(root, 'bin'), home = join(root, 'home'), log = join(root, 'calls.log');
  for (const d of [bin, home]) mkdirSync(d);
  shim(bin, 'docker', docker);
  shim(bin, 'id', 'echo made-up-user');
  shim(bin, 'getent', 'echo "docker:x:990:made-up-user"');
  shim(bin, 'sg', `echo "sg $1" >> '${log}'; [ "$2" = -c ] && exec bash -c "$3"`);
  shim(bin, 'app', `echo "app ran: $* (in docker group: \${HATCHABOT_IN_DOCKER_GROUP:-no})" >> '${log}'`);
  const run = () => {
    const started = Date.now();
    const r = spawnSync('bash', ['scripts/with-docker.sh', join(bin, 'app'), 'serve'], { encoding: 'utf8', timeout: 20_000, env: scriptEnv(home, `${bin}:/usr/bin:/bin`) });
    return { ...r, ms: Date.now() - started };
  };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { run, calls };
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
