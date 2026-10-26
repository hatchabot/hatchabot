import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
