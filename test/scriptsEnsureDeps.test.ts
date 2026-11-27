import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

// Every test here runs real shell scripts in a sandbox; vitest's 5 s was not
// enough under load on the self-hosted runner (2026-10-23).
vi.setConfig({ testTimeout: 30_000 });

/**
 * scripts/ensure-deps.sh in a sandbox: a made-up install with a lockfile and
 * its stamp, the real node, and npm and sqlite-driver.sh as shims that only
 * record that they were asked. A temp HOME, a PATH of the shims and the
 * system dirs.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const ABI = process.versions.modules;

function install() {
  const root = mkdtempSync(join(tmpdir(), 'hb-ensure-deps-')); dirs.push(root);
  const app = join(root, 'app'), bin = join(root, 'bin'), home = join(root, 'home'), log = join(root, 'calls.log');
  for (const d of [join(app, 'scripts'), join(app, 'node_modules'), bin, home]) mkdirSync(d, { recursive: true });
  writeFileSync(join(app, 'scripts', 'ensure-deps.sh'), readFileSync('scripts/ensure-deps.sh'), { mode: 0o755 });
  writeFileSync(join(app, 'scripts', 'sqlite-driver.sh'), `#!/usr/bin/env bash\necho driver-check >> '${log}'\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env bash\necho "npm $*" >> '${log}'\n`, { mode: 0o755 });
  symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(join(app, 'package-lock.json'), '{"name":"made-up-app","lockfileVersion":3}\n');
  const sum = spawnSync('cksum', [join(app, 'package-lock.json')], { encoding: 'utf8' }).stdout.split(' ')[0]!;
  writeFileSync(join(app, 'node_modules', '.hatchabot-lock-stamp'), `${sum}\n`);
  const run = () => spawnSync('bash', [join(app, 'scripts', 'ensure-deps.sh')], { encoding: 'utf8', env: scriptEnv(home, `${bin}:/usr/bin:/bin`) });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { app, run, calls, abiStamp: join(app, 'node_modules', '.hatchabot-node-abi'), lockStamp: join(app, 'node_modules', '.hatchabot-lock-stamp'), sum };
}

describe('scripts/ensure-deps.sh checks the database driver once per Node (audit #045)', () => {
  it('the same lockfile under another Node: the driver is checked (and compiled if it must be), npm is not run', () => {
    const i = install();
    writeFileSync(i.abiStamp, '115\n'); // checked last under an older Node
    const r = i.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(i.calls()).toEqual(['driver-check']);
    expect(readFileSync(i.abiStamp, 'utf8').trim()).toBe(ABI);
    expect(readFileSync(i.lockStamp, 'utf8')).toBe(`${i.sum}\n`); // the lockfile's stamp is as it was
  });

  it('a stamp from before (no Node recorded): checked once, then up to date', () => {
    const i = install();
    expect(i.run().status).toBe(0);
    expect(i.run().stdout).toContain('Dependencies are up to date.');
    expect(i.calls()).toEqual(['driver-check']);
  });

  it('a changed lockfile installs, checks the driver and records both', () => {
    const i = install();
    writeFileSync(i.lockStamp, 'an-older-sum\n');
    const r = i.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(i.calls()).toEqual(['npm ci --no-audit --no-fund', 'driver-check']);
    expect(readFileSync(i.lockStamp, 'utf8').trim()).toBe(i.sum);
    expect(readFileSync(i.abiStamp, 'utf8').trim()).toBe(ABI);
    expect(i.run().status).toBe(0);
    expect(i.calls()).toHaveLength(2); // nothing more to do
  });

  it('a driver that cannot be made to load under this Node stops it, and is checked again next time', () => {
    const i = install();
    writeFileSync(join(i.app, 'scripts', 'sqlite-driver.sh'), '#!/usr/bin/env bash\necho "could not compile" >&2\nexit 1\n', { mode: 0o755 });
    const r = i.run();
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('Dependencies are up to date.');
    expect(existsSync(i.abiStamp)).toBe(false);
  });
});

describe('scripts/ensure-deps.sh runs one install per folder at a time (HB-1067)', () => {
  const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function until(what: () => boolean, ms = 15_000) {
    const end = Date.now() + ms;
    while (!what()) { if (Date.now() > end) throw new Error('timed out waiting'); await sleepMs(50); }
  }
  // npm ci as a shim that empties node_modules, as npm ci does, and holds
  // there until the test lets it go (or 20 s pass, so none outlives a failed test).
  function heldInstall() {
    const i = install();
    writeFileSync(i.lockStamp, 'an-older-sum\n');
    const release = join(i.app, '..', 'release');
    writeFileSync(join(i.app, '..', 'bin', 'npm'), `#!/usr/bin/env bash
echo "npm $* begun" >> '${join(i.app, '..', 'calls.log')}'
rm -rf node_modules; mkdir node_modules
n=0; while [ ! -e '${release}' ] && [ "$n" -lt 400 ]; do sleep 0.05; n=$((n + 1)); done
echo "npm $* done" >> '${join(i.app, '..', 'calls.log')}'
`, { mode: 0o755 });
    const start = (extra: Record<string, string> = {}) => {
      const p = spawn('bash', [join(i.app, 'scripts', 'ensure-deps.sh')], { env: scriptEnv(join(i.app, '..', 'home'), `${join(i.app, '..', 'bin')}:/usr/bin:/bin`, extra) });
      let out = '';
      p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
      const done = new Promise<number | null>((r) => p.on('close', (code) => r(code)));
      return { done, out: () => out };
    };
    return { ...i, release, start };
  }

  for (const [label, tzA, tzB] of [['in one time zone', '', ''], ['the first in one time zone and the second in another (review of HB-1067)', 'JST-9', 'EST5']] as const) it(`a second run while the first is installing waits, then finds the install done: one npm ci, not two at once (${label})`, async () => {
    const i = heldInstall();
    const a = i.start(tzA ? { TZ: tzA } : {});
    let b: ReturnType<typeof i.start> | undefined;
    try {
      await until(() => i.calls().includes('npm ci --no-audit --no-fund begun'));
      b = i.start(tzB ? { TZ: tzB } : {});
      // Waiting, or (as before the lock) emptying node_modules beside the first.
      await until(() => b!.out().includes('Waiting for another install of the dependencies') || i.calls().filter((c) => c.endsWith('begun')).length > 1);
      await sleepMs(500);
      expect(i.calls()).toEqual(['npm ci --no-audit --no-fund begun']); // the second has not begun one
    } finally {
      writeFileSync(i.release, ''); // let the shims go, however the test went
    }
    if (!b) throw new Error('the second run never started');
    expect(await a.done, a.out()).toBe(0);
    expect(await b.done, b.out()).toBe(0);
    expect(b.out()).toContain('Dependencies are up to date.');
    expect(i.calls()).toEqual(['npm ci --no-audit --no-fund begun', 'npm ci --no-audit --no-fund done', 'driver-check']);
    expect(readFileSync(i.lockStamp, 'utf8').trim()).toBe(i.sum);
    expect(readdirSync(join(i.app, '..', 'home', '.local', 'state', 'hatchabot'))).toEqual([]); // the lock let go
  });

  // HB-1377: the lock is the folder's, its physical path; one with no holder for a minute is a leftover.
  const lockOf = (app: string) => {
    const sum = spawnSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', realpathSync(app)], { encoding: 'utf8' }).stdout.trim();
    return join(app, '..', 'home', '.local', 'state', 'hatchabot', `deps-${sum}.lock.d`);
  };
  const fastRun = (app: string, script: string) => {
    const fast = join(app, '..', 'fast'); mkdirSync(fast, { recursive: true });
    writeFileSync(join(fast, 'sleep'), '#!/bin/bash\n[ "$1" = 1 ] && exit 0\nexec /bin/sleep "$@"\n', { mode: 0o755 });
    return spawnSync('bash', [script], { encoding: 'utf8', env: scriptEnv(join(app, '..', 'home'), `${fast}:${join(app, '..', 'bin')}:/usr/bin:/bin`, { HATCHABOT_DEPS_WAIT_SECS: '3' }) });
  };
  it('a run through a link to the folder waits for the install holding it by the folder\'s own path (HB-1377)', () => {
    const i = install();
    const lock = lockOf(i.app);
    const start = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' } }).stdout.trim().replace(/\s+/g, ' ');
    expect(start).not.toBe('');
    mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, 'owner'), `${process.pid} ${start}\n`);
    const link = join(i.app, '..', 'linked'); symlinkSync(i.app, link);
    for (const via of [i.app, link]) {
      const r = fastRun(i.app, join(via, 'scripts', 'ensure-deps.sh'));
      expect(r.stdout, via).toContain('Waiting for another install of the dependencies');
      expect(r.status, r.stdout + r.stderr).toBe(1);
    }
    expect(i.calls()).toEqual([]);
  });
  it('through a link, the lock a release before 2.193.0 takes by the path as given is waited on too, and both let go after (review of HB-1377)', () => {
    const i = install();
    const link = join(i.app, '..', 'linked'); symlinkSync(i.app, link);
    const sum = spawnSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', link], { encoding: 'utf8' }).stdout.trim();
    const given = join(i.app, '..', 'home', '.local', 'state', 'hatchabot', `deps-${sum}.lock.d`);
    expect(given).not.toBe(lockOf(i.app));
    // An older release's ensure-deps.sh, alive, holding the lock it keys on the link's path.
    const start = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' } }).stdout.trim().replace(/\s+/g, ' ');
    expect(start).not.toBe('');
    mkdirSync(given, { recursive: true }); writeFileSync(join(given, 'owner'), `${process.pid} ${start}\n`);
    const r = fastRun(i.app, join(link, 'scripts', 'ensure-deps.sh'));
    expect(r.stdout).toContain('Waiting for another install of the dependencies');
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(i.calls()).toEqual([]);
    expect(existsSync(lockOf(i.app))).toBe(false); // the one it held while it waited, let go
    // Gone: both taken, the install made, and both let go.
    rmSync(given, { recursive: true });
    const done = fastRun(i.app, join(link, 'scripts', 'ensure-deps.sh'));
    expect(done.status, done.stdout + done.stderr).toBe(0);
    expect(done.stdout).not.toContain('Waiting for another install');
    expect(i.calls()).toContain('driver-check'); // past the lock, to its work
    expect(readdirSync(join(i.app, '..', 'home', '.local', 'state', 'hatchabot'))).toEqual([]);
  });
  it('a lock with no holder written: waited on while it is new, taken over once it is a minute old, not ten (HB-1377)', () => {
    const i = install();
    const lock = lockOf(i.app);
    mkdirSync(lock, { recursive: true });
    const fresh = fastRun(i.app, join(i.app, 'scripts', 'ensure-deps.sh'));
    expect(fresh.status, fresh.stdout + fresh.stderr).toBe(1); // a run that has only just made it
    const old = new Date(Date.now() - 120_000); utimesSync(lock, old, old);
    const r = fastRun(i.app, join(i.app, 'scripts', 'ensure-deps.sh'));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain('Waiting for another install');
    expect(existsSync(lock)).toBe(false);
  });

  it('a lock left by a run that is gone is taken over', () => {
    const i = install();
    const sum = spawnSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', i.app], { encoding: 'utf8' }).stdout.trim();
    const lock = join(i.app, '..', 'home', '.local', 'state', 'hatchabot', `deps-${sum}.lock.d`);
    mkdirSync(lock, { recursive: true });
    const gone = spawnSync('bash', ['-c', 'echo $$']).stdout.toString().trim();
    writeFileSync(join(lock, 'owner'), `${gone} Thu Jan  1 00:00:00 1970\n`);
    const r = i.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain('Waiting for another install');
    expect(existsSync(lock)).toBe(false);
  });
});
