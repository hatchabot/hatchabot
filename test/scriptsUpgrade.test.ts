import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { hangingStep, scriptEnv, systemPathWithout } from './helpers/scriptEnv.js';

// Every test here runs real shell scripts (git, bash, a fake gh) in a sandbox. On the
// self-hosted runner CI shares the machine with other work, and vitest's 5 s was not
// enough under load (land, promote, release, first-run-link; 2026-10-23).
vi.setConfig({ testTimeout: 30_000 });

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
  writeFileSync(join(src, 'scripts', 'upgrade-helpers.sh'), readFileSync('scripts/upgrade-helpers.sh'), { mode: 0o644 });
  writeFileSync(join(src, 'scripts', 'release-target.sh'), readFileSync('scripts/release-target.sh'), { mode: 0o755 });
  writeFileSync(join(src, '.gitignore'), 'node_modules/\nnode_modules.prev/\ndata/\n');
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
  return { root, home, src, origin, install, bin, env, git, restarts };
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
    expect(readFileSync(join(w.install, 'data', 'channel'), 'utf8').trim()).toBe('stable');
  });

  it('after a run killed right after moving node_modules aside, a failed install still rolls back to those dependencies (audit #033)', () => {
    const w = world();
    renameSync(join(w.install, 'node_modules'), join(w.install, 'node_modules.prev')); // the only working copy
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'false' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    expect(readFileSync(join(w.install, 'node_modules', 'marker'), 'utf8')).toBe('deps');
    expect(existsSync(join(w.install, 'node_modules.prev'))).toBe(false);
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

describe('scripts/upgrade.sh moves node_modules only under the dependencies\' lock (HB-1212)', () => {
  const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function until(what: () => boolean, ms = 30_000) {
    const end = Date.now() + ms;
    while (!what()) { if (Date.now() > end) throw new Error('timed out waiting'); await sleepMs(50); }
  }
  const started = (cmd: string[], env: Record<string, string>) => {
    const p = spawn('bash', cmd, { env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    const done = new Promise<number | null>((r) => p.on('close', (code) => r(code)));
    return { done, out: () => out };
  };

  it('a restart\'s npm ci under way in the folder: the upgrade waits for it, then moves the whole tree aside, not half of it', async () => {
    const w = world();
    // ensure-deps.sh in the install, as a restart runs it (left out of git, as
    // .git/info/exclude says), its npm ci a shim that empties node_modules as
    // npm ci does and holds there until the test lets it go (a minute at most).
    writeFileSync(join(w.install, 'scripts', 'ensure-deps.sh'), readFileSync('scripts/ensure-deps.sh'), { mode: 0o755 });
    writeFileSync(join(w.install, 'scripts', 'sqlite-driver.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(w.install, 'package-lock.json'), '{"name":"made-up-app","lockfileVersion":3}\n');
    writeFileSync(join(w.install, '.git', 'info', 'exclude'), 'scripts/ensure-deps.sh\nscripts/sqlite-driver.sh\npackage-lock.json\n');
    symlinkSync(process.execPath, join(w.bin, 'node'));
    const release = join(w.root, 'release'), calls = join(w.root, 'npm.log');
    writeFileSync(join(w.bin, 'npm'), `#!/usr/bin/env bash
echo begun >> '${calls}'
rm -rf node_modules; mkdir node_modules; echo x > node_modules/half
n=0; while [ ! -e '${release}' ] && [ "$n" -lt 1200 ]; do sleep 0.05; n=$((n + 1)); done
echo x > node_modules/whole
echo done >> '${calls}'
`, { mode: 0o755 });
    // The upgrade's own install step: writes down what it found moved aside.
    writeFileSync(join(w.bin, 'record-aside'), `#!/usr/bin/env bash\nls node_modules.prev > '${join(w.root, 'aside.log')}'\nmkdir -p node_modules\n`, { mode: 0o755 });
    const deps = started([join(w.install, 'scripts', 'ensure-deps.sh')], w.env);
    let up: ReturnType<typeof started> | undefined;
    let ended = false;
    let upDone: Promise<number | null> | undefined;
    try {
      await until(() => existsSync(calls) && readFileSync(calls, 'utf8').includes('begun'));
      up = started([join(w.install, 'scripts', 'upgrade.sh'), 'stable'], {
        ...w.env, HATCHABOT_RESTART_CMD: join(w.bin, 'fake-restart'), HATCHABOT_UPGRADE_IMAGE: '0', HATCHABOT_INSTALL_CMD: join(w.bin, 'record-aside'),
      });
      upDone = up.done.then((code) => { ended = true; return code; });
      // Waiting, or (as before the lock) moving the half-made tree and going on.
      await until(() => up!.out().includes('Waiting for an install of the dependencies') || ended || existsSync(join(w.root, 'aside.log')));
      await sleepMs(300);
      expect(existsSync(join(w.root, 'aside.log')), up.out()).toBe(false); // nothing moved yet
    } finally {
      writeFileSync(release, ''); // let the shim go, however the test went
    }
    expect(await deps.done, deps.out()).toBe(0);
    expect(await upDone, up!.out()).toBe(0);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.1.0');
    // What went aside was the tree npm had finished.
    expect(readFileSync(join(w.root, 'aside.log'), 'utf8').split('\n').filter(Boolean).sort()).toEqual(['half', 'whole']);
    expect(readdirSync(join(w.home, '.local', 'state', 'hatchabot')).filter((n) => n.startsWith('deps-'))).toEqual([]); // let go
  }, 90_000);

  it('a rollback that cannot have the lock leaves the old dependencies aside and says so, and keeps the record: the next run puts them back (review of HB-1212)', () => {
    const w = world();
    // Half an hour of one-second waits, made instant: only `sleep 1`, the lock's.
    const fast = join(w.root, 'fast'); mkdirSync(fast);
    writeFileSync(join(fast, 'sleep'), '#!/bin/bash\n[ "$1" = 1 ] && exit 0\nexec /bin/sleep "$@"\n', { mode: 0o755 });
    // An install that fails part-way with another npm holding the lock: this
    // test's own process stands for it, alive throughout, its start as ps gives it.
    const start = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' } }).stdout.trim().replace(/\s+/g, ' ');
    expect(start).not.toBe('');
    const state = join(w.home, '.local', 'state', 'hatchabot');
    writeFileSync(join(w.bin, 'install-held'), `#!/usr/bin/env bash
L="${state}/deps-$(printf %s "$PWD" | cksum | cut -d' ' -f1).lock.d"
mkdir -p "$L"; printf '%s\\n' '${process.pid} ${start}' > "$L/owner"
mkdir -p node_modules; echo x > node_modules/half
exit 1
`, { mode: 0o755 });
    const r = run(w, { HATCHABOT_DEPS_WAIT_SECS: '3', HATCHABOT_INSTALL_CMD: join(w.bin, 'install-held'), PATH: `${fast}:${w.bin}:/usr/bin:/bin` }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stdout).toContain('has held');
    expect(r.stdout).toContain("for half an hour, so v1.0.0's were left in node_modules.prev, not put back.");
    expect(r.stdout).not.toContain('nothing was moved');
    expect(r.stdout).toContain('Then run hatchabot upgrade: it puts v1.0.0 back first, from its record.');
    expect(readdirSync(state).filter((n) => n.endsWith('.from'))).toHaveLength(1); // the record stays
    expect(readdirSync(join(w.install, 'node_modules.prev'))).toEqual(['marker']);
    expect(restarted(w)).toBe(0);
    // The npm gone (its lock with it), the next run puts them back before anything else.
    for (const n of readdirSync(state).filter((x) => x.startsWith('deps-'))) rmSync(join(state, n), { recursive: true });
    const next = run(w, { HATCHABOT_INSTALL_CMD: 'false' }, ['stable']);
    expect(next.stdout).toContain('was cut off part-way — putting v1.0.0 back first');
    expect(next.status, next.stdout + next.stderr).toBe(3);
    expect(readdirSync(join(w.install, 'node_modules'))).toEqual(['marker']);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
  }, 200_000);

  it('a rollback after a failed restart that cannot have the lock says what to run next, still 1, and keeps the record (review of HB-1212)', () => {
    const w = world();
    const fast = join(w.root, 'fast'); mkdirSync(fast);
    writeFileSync(join(fast, 'sleep'), '#!/bin/bash\n[ "$1" = 1 ] && exit 0\nexec /bin/sleep "$@"\n', { mode: 0o755 });
    const start = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' } }).stdout.trim().replace(/\s+/g, ' ');
    expect(start).not.toBe('');
    const state = join(w.home, '.local', 'state', 'hatchabot');
    // The new release's restart fails, with another npm holding the lock meanwhile (this test's process stands for it).
    writeFileSync(join(w.bin, 'restart-held'), `#!/usr/bin/env bash
L="${state}/deps-$(printf %s "$PWD" | cksum | cut -d' ' -f1).lock.d"
mkdir -p "$L"; printf '%s\\n' '${process.pid} ${start}' > "$L/owner"
exit 1
`, { mode: 0o755 });
    const r = run(w, { HATCHABOT_DEPS_WAIT_SECS: '3', HATCHABOT_INSTALL_CMD: 'true', HATCHABOT_RESTART_CMD: join(w.bin, 'restart-held'), PATH: `${fast}:${w.bin}:/usr/bin:/bin` }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain("for half an hour, so v1.0.0's were left in node_modules.prev, not put back.");
    expect(r.stdout).toContain('So the rollback did not finish either: v1.0.0 is not back as it was.\nThen run hatchabot upgrade: it puts v1.0.0 back first, from its record.'); // HB-1383
    expect(readdirSync(state).filter((n) => n.endsWith('.from'))).toHaveLength(1); // the record stays
    expect(readdirSync(join(w.install, 'node_modules.prev'))).toEqual(['marker']);
  }, 200_000);
});

describe('the dependencies\' lock is the folder\'s, however it is reached, and one left with no holder is not waited on for long (HB-1377)', () => {
  const fastSleep = (w: World) => { const fast = join(w.root, 'fast'); mkdirSync(fast); writeFileSync(join(fast, 'sleep'), '#!/bin/bash\n[ "$1" = 1 ] && exit 0\nexec /bin/sleep "$@"\n', { mode: 0o755 }); return fast; };
  const lockFor = (w: World, dir: string) => {
    const sum = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', realpathSync(dir)], { encoding: 'utf8' }).trim();
    return join(w.home, '.local', 'state', 'hatchabot', `deps-${sum}.lock.d`);
  };
  it('an npm holding it for the folder by its own path: an upgrade run through a link to the folder waits for it too', () => {
    const w = world();
    const fast = fastSleep(w);
    const start = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' } }).stdout.trim().replace(/\s+/g, ' ');
    expect(start).not.toBe('');
    const lock = lockFor(w, w.install);
    mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, 'owner'), `${process.pid} ${start}\n`);
    const link = join(w.root, 'linked'); symlinkSync(w.install, link);
    const r = spawnSync('bash', [join(link, 'scripts', 'upgrade.sh'), 'stable'], {
      encoding: 'utf8', env: { ...w.env, PATH: `${fast}:${w.bin}:/usr/bin:/bin`, HATCHABOT_RESTART_CMD: join(w.bin, 'fake-restart'), HATCHABOT_UPGRADE_IMAGE: '0', HATCHABOT_INSTALL_CMD: 'true', HATCHABOT_DEPS_WAIT_SECS: '3' },
    });
    expect(r.stdout).toContain('Waiting for an install of the dependencies');
    expect(r.stdout).toContain('so nothing was moved');
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(existsSync(join(w.install, 'node_modules', 'marker'))).toBe(true);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
  });
  it('through a link, the lock a release before 2.193.0 keys on the path as given is waited on too (review of HB-1377)', () => {
    const w = world();
    const fast = fastSleep(w);
    const link = join(w.root, 'linked'); symlinkSync(w.install, link);
    const sum = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', link], { encoding: 'utf8' }).trim();
    const given = join(w.home, '.local', 'state', 'hatchabot', `deps-${sum}.lock.d`);
    expect(given).not.toBe(lockFor(w, w.install));
    const start = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' } }).stdout.trim().replace(/\s+/g, ' ');
    expect(start).not.toBe('');
    mkdirSync(given, { recursive: true }); writeFileSync(join(given, 'owner'), `${process.pid} ${start}\n`);
    const r = spawnSync('bash', [join(link, 'scripts', 'upgrade.sh'), 'stable'], {
      encoding: 'utf8', env: { ...w.env, PATH: `${fast}:${w.bin}:/usr/bin:/bin`, HATCHABOT_RESTART_CMD: join(w.bin, 'fake-restart'), HATCHABOT_UPGRADE_IMAGE: '0', HATCHABOT_INSTALL_CMD: 'true', HATCHABOT_DEPS_WAIT_SECS: '3' },
    });
    expect(r.stdout).toContain('Waiting for an install of the dependencies');
    expect(r.stdout).toContain(`The install that holds it is by a release before 2.193.0, under the lock it keys on ${link} as given: ${given}.`);
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(existsSync(join(w.install, 'node_modules', 'marker'))).toBe(true);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    expect(existsSync(lockFor(w, w.install))).toBe(false); // the one it held while it waited, let go
  });
  it('one with no holder written two minutes after it was made: taken over, not waited on for ten', () => {
    const w = world();
    const fast = fastSleep(w);
    const lock = lockFor(w, w.install);
    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 120_000); utimesSync(lock, old, old);
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true', HATCHABOT_DEPS_WAIT_SECS: '3', PATH: `${fast}:${w.bin}:/usr/bin:/bin` }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain('Waiting for an install of the dependencies');
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.1.0');
  });
});

describe('scripts/upgrade.sh cut off part-way through the install (HB-0043)', () => {
  /**
   * An install step that leaves half a node_modules and then hangs, as
   * `npm ci` cut off would; `started` says it got there. The upgrade runs in
   * its own process group, so a signal reaches it and the install as a stop
   * of the service or a Ctrl-C does.
   */
  function cutOff(w: World, signal: NodeJS.Signals, where: 'install' | 'restart' = 'install') {
    const started = join(w.root, 'started');
    const hang = hangingStep(started);
    writeFileSync(join(w.bin, 'hanging-step'), hang, { mode: 0o755 });
    const p = spawn('bash', [join(w.install, 'scripts', 'upgrade.sh'), 'stable'], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...w.env, HATCHABOT_UPGRADE_IMAGE: '0',
        HATCHABOT_INSTALL_CMD: where === 'install' ? join(w.bin, 'hanging-step') : 'true',
        HATCHABOT_RESTART_CMD: where === 'restart' ? join(w.bin, 'hanging-step') : join(w.bin, 'fake-restart') },
    });
    let out = '';
    p.stdout!.on('data', (c) => (out += c)); p.stderr!.on('data', (c) => (out += c));
    return new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        if (existsSync(started)) { clearInterval(poll); process.kill(-p.pid!, signal); }
        else if (Date.now() - t0 > 15_000) { clearInterval(poll); process.kill(-p.pid!, 'SIGKILL'); reject(new Error(`never reached the ${where}: ${out}`)); }
      }, 20);
      p.on('exit', (code) => resolve({ code, out }));
    });
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`${signal} in the install: the old release and its dependencies are put back at once, and it says 3`, async () => {
      const w = world();
      const r = await cutOff(w, signal);
      expect(r.code, r.out).toBe(3);
      expect(r.out).toMatch(/stopped part-way — putting v1\.0\.0 back/);
      expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
      expect(readFileSync(join(w.install, 'node_modules', 'marker'), 'utf8')).toBe('deps');
      expect(existsSync(join(w.install, 'node_modules', 'half-installed'))).toBe(false);
      expect(existsSync(join(w.install, 'node_modules.prev'))).toBe(false);
      expect(restarted(w)).toBe(0);
      // Nothing left for the next run to repair.
      const next = run(w, { HATCHABOT_INSTALL_CMD: 'false' }, ['stable']);
      expect(next.stdout).not.toMatch(/cut off part-way/);
    });
  }

  it('killed in the install (SIGKILL, a power cut): the next run puts the old release back first, not "Already on" the new one', async () => {
    const w = world();
    const r = await cutOff(w, 'SIGKILL');
    expect(r.code).toBe(null);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.1.0'); // half-way: the new code, half its dependencies
    // A next run whose install fails too: it must still end on the old release with its own dependencies.
    const next = run(w, { HATCHABOT_INSTALL_CMD: 'false' }, ['stable']);
    expect(next.status, next.stdout + next.stderr).toBe(3);
    expect(next.stdout).toMatch(/cut off part-way — putting v1\.0\.0 back first/);
    expect(next.stdout).toMatch(/Upgrading v1\.0\.0 → v1\.1\.0/);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    expect(readFileSync(join(w.install, 'node_modules', 'marker'), 'utf8')).toBe('deps');
    expect(existsSync(join(w.install, 'node_modules.prev'))).toBe(false);
    expect(restarted(w)).toBe(0); // the service never left the old release
    // And one that installs: on the new release.
    const third = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(third.status, third.stdout + third.stderr).toBe(0);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.1.0');
  });

  it('killed while the service restarts onto the new release: the next run restarts the old one it put back', async () => {
    const w = world();
    await cutOff(w, 'SIGKILL', 'restart');
    const next = run(w, { HATCHABOT_INSTALL_CMD: 'false' }, ['stable']);
    expect(next.stdout).toMatch(/cut off part-way — putting v1\.0\.0 back first/);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    expect(readFileSync(join(w.install, 'node_modules', 'marker'), 'utf8')).toBe('deps');
    expect(restarted(w)).toBe(1); // back onto the old release
  });
});

describe('scripts/upgrade.sh cut off while it removes a node_modules.prev (HB-0266)', () => {
  const REAL_RM = spawnSync('sh', ['-c', 'command -v rm'], { encoding: 'utf8' }).stdout.trim();
  /** An rm that, removing a node_modules.prev holding `file`, deletes that one file and signals the upgrade. */
  const cutRm = (w: World, file: string, signal: string) => writeFileSync(join(w.bin, 'rm'), `#!/usr/bin/env bash
if [ "$1 $2" = "-rf node_modules.prev" ] && [ -f node_modules.prev/${file} ]; then ${JSON.stringify(REAL_RM)} -f node_modules.prev/${file}; kill -${signal} "$PPID"; exit 1; fi
exec ${JSON.stringify(REAL_RM)} "$@"
`, { mode: 0o755 });
  const installNew = (w: World) => {
    writeFileSync(join(w.bin, 'install-new'), '#!/usr/bin/env bash\nmkdir -p node_modules && echo new > node_modules/new-marker\n', { mode: 0o755 });
    return { HATCHABOT_INSTALL_CMD: join(w.bin, 'install-new') };
  };
  const at = (w: World) => w.git(w.install, 'describe', '--tags', '--exact-match');

  for (const signal of ['KILL', 'TERM']) {
    it(`SIG${signal} once the new release is up, while the old dependencies are removed: the next run leaves the new release alone`, () => {
      const w = world();
      cutRm(w, 'marker', signal);
      const first = run(w, installNew(w), ['stable']);
      // Stopped by a signal it can see, it says what is true: upgraded (HB-0266).
      if (signal === 'TERM') { expect(first.status, first.stdout + first.stderr).toBe(0); expect(first.stdout).toContain('Now on v1.1.0.'); }
      expect(at(w)).toBe('v1.1.0');
      const next = run(w, installNew(w), ['stable']);
      expect(next.stdout).not.toMatch(/cut off part-way/);
      expect(next.stdout).toMatch(/Already on v1\.1\.0/);
      expect(at(w)).toBe('v1.1.0');
      expect(readFileSync(join(w.install, 'node_modules', 'new-marker'), 'utf8')).toBe('new\n');
      expect(restarted(w)).toBe(1);
    });
  }

  it('SIGTERM while a stale node_modules.prev is removed, before anything moved: node_modules is left alone', () => {
    const w = world();
    mkdirSync(join(w.install, 'node_modules.prev')); writeFileSync(join(w.install, 'node_modules.prev', 'stale'), 'x');
    cutRm(w, 'stale', 'TERM');
    const r = run(w, installNew(w), ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stdout).not.toMatch(/Rolling back/);
    expect(at(w)).toBe('v1.0.0');
    expect(readFileSync(join(w.install, 'node_modules', 'marker'), 'utf8')).toBe('deps');
    expect(restarted(w)).toBe(0);
  });
});

describe('scripts/upgrade.sh with its checkout cut off part-way (HB-0266)', () => {
  it('HEAD and index still on the old release, files rewritten: the rollback puts every tracked file back', () => {
    const w = world();
    writeFileSync(join(w.src, 'added.txt'), 'only in v1.2.0\n');
    w.git(w.src, 'add', '-A'); w.git(w.src, 'commit', '-q', '-m', 'v3'); w.git(w.src, 'tag', 'v1.2.0');
    w.git(w.src, 'push', '-q', w.origin, 'main', 'v1.2.0');
    w.git(w.install, 'fetch', '-q', '--tags', 'origin');
    // The checkout writes the new files, then stops before it records the new HEAD and index.
    writeFileSync(join(w.bin, 'git'), `#!/usr/bin/env bash
if [ "$1 $2 $3" = "checkout --quiet v1.2.0" ]; then
  ${JSON.stringify(REAL_GIT)} "$@" || exit 1
  ${JSON.stringify(REAL_GIT)} update-ref --no-deref HEAD "$(${JSON.stringify(REAL_GIT)} rev-parse 'v1.0.0^{commit}')"
  ${JSON.stringify(REAL_GIT)} read-tree v1.0.0
  exit 1
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`, { mode: 0o755 });
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['v1.2.0']);
    expect(r.status, r.stdout + r.stderr).toBe(3);
    rmSync(join(w.bin, 'git'));
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    expect(w.git(w.install, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(w.install, 'added.txt'))).toBe(false);
    expect(readFileSync(join(w.install, 'node_modules', 'marker'), 'utf8')).toBe('deps');
    expect(restarted(w)).toBe(0);
  });
});

describe('scripts/upgrade.sh killed in the checkout, leaving .git/index.lock (HB-0372)', () => {
  /** An upgrade killed by SIGKILL while its git holds the index lock, its files rewritten and HEAD not moved yet. */
  async function killedInCheckout(w: World) {
    const started = join(w.root, 'in-checkout');
    writeFileSync(join(w.src, 'added.txt'), 'only in v1.2.0\n');
    w.git(w.src, 'add', '-A'); w.git(w.src, 'commit', '-q', '-m', 'v3'); w.git(w.src, 'tag', 'v1.2.0');
    w.git(w.src, 'push', '-q', w.origin, 'main', 'v1.2.0');
    w.git(w.install, 'fetch', '-q', '--tags', 'origin');
    writeFileSync(join(w.bin, 'git'), `#!/usr/bin/env bash
if [ "$1 $2 $3" = "checkout --quiet v1.2.0" ]; then
  ${JSON.stringify(REAL_GIT)} "$@" || exit 1
  ${JSON.stringify(REAL_GIT)} update-ref --no-deref HEAD "$(${JSON.stringify(REAL_GIT)} rev-parse 'v1.0.0^{commit}')"
  ${JSON.stringify(REAL_GIT)} read-tree v1.0.0
  : > .git/index.lock
  touch ${JSON.stringify(started)}
  exec sleep 30
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`, { mode: 0o755 });
    const p = spawn('bash', [join(w.install, 'scripts', 'upgrade.sh'), 'v1.2.0'], { detached: true, stdio: 'ignore', env: { ...w.env, HATCHABOT_RESTART_CMD: join(w.bin, 'fake-restart'), HATCHABOT_UPGRADE_IMAGE: '0', HATCHABOT_INSTALL_CMD: 'true' } });
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        if (existsSync(started)) { clearInterval(poll); process.kill(-p.pid!, 'SIGKILL'); }
        else if (Date.now() - t0 > 15_000) { clearInterval(poll); process.kill(-p.pid!, 'SIGKILL'); reject(new Error('never reached the checkout')); }
      }, 20);
      p.on('exit', () => resolve());
    });
    rmSync(join(w.bin, 'git'));
    const record = lockOf(w).replace(/\.lock\.d$/, '.from');
    const indexLock = join(w.install, '.git', 'index.lock');
    return { record, indexLock };
  }

  it('its own stale lock goes, every tracked file is put back, and the upgrade it asked for finishes', async () => {
    const w = world();
    const k = await killedInCheckout(w);
    expect(readFileSync(k.record, 'utf8')).toMatch(/^from v1\.0\.0\nto v1\.2\.0\npins-recorded\nsays-started\ngit \d+ /);
    execFileSync('touch', ['-d', '10 minutes ago', k.record]); execFileSync('touch', ['-d', '9 minutes ago', k.indexLock]);
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'false' }, ['v1.2.0']);
    expect(r.status, r.stdout + r.stderr).toBe(3); // the repair, then this run's install fails: the old release, whole
    expect(r.stdout).toContain('Removing the .git/index.lock');
    expect(existsSync(k.indexLock)).toBe(false);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    expect(w.git(w.install, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(w.install, 'added.txt'))).toBe(false);
    expect(readFileSync(join(w.install, 'node_modules', 'marker'), 'utf8')).toBe('deps');
    const next = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['v1.2.0']);
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.2.0');
  });

  it('git killed alone, the upgrade living on: the dependencies go back, and a later run takes the lock as its own', () => {
    const w = world();
    writeFileSync(join(w.src, 'added.txt'), 'only in v1.2.0\n');
    w.git(w.src, 'add', '-A'); w.git(w.src, 'commit', '-q', '-m', 'v3'); w.git(w.src, 'tag', 'v1.2.0');
    w.git(w.src, 'push', '-q', w.origin, 'main', 'v1.2.0');
    w.git(w.install, 'fetch', '-q', '--tags', 'origin');
    writeFileSync(join(w.bin, 'git'), `#!/usr/bin/env bash
if [ "$1 $2 $3" = "checkout --quiet v1.2.0" ]; then
  ${JSON.stringify(REAL_GIT)} "$@" || exit 1
  ${JSON.stringify(REAL_GIT)} update-ref --no-deref HEAD "$(${JSON.stringify(REAL_GIT)} rev-parse 'v1.0.0^{commit}')"
  ${JSON.stringify(REAL_GIT)} read-tree v1.0.0
  : > .git/index.lock
  kill -9 $$
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`, { mode: 0o755 });
    const first = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['v1.2.0']);
    expect(first.status, first.stdout + first.stderr).not.toBe(0);
    rmSync(join(w.bin, 'git'));
    expect(readFileSync(join(w.install, 'node_modules', 'marker'), 'utf8')).toBe('deps');
    const record = lockOf(w).replace(/\.lock\.d$/, '.from');
    const lock = join(w.install, '.git', 'index.lock');
    expect(readFileSync(record, 'utf8').match(/^git /gm)).toHaveLength(1);
    execFileSync('touch', ['-d', '10 minutes ago', record]); execFileSync('touch', ['-d', '9 minutes ago', lock]);
    const next = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['v1.2.0']);
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(next.stdout).toContain('Removing the .git/index.lock');
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.2.0');
  });

  it('a git someone else is running here keeps its lock; a hand edit made since the kill is kept and named', async () => {
    const w = world();
    const k = await killedInCheckout(w);
    execFileSync('touch', ['-d', '10 minutes ago', k.record]); execFileSync('touch', ['-d', '9 minutes ago', k.indexLock]);
    const fakeGit = join(w.root, 'other', 'git');
    mkdirSync(dirname(fakeGit));
    writeFileSync(fakeGit, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    const person = spawn(fakeGit, [], { cwd: w.install, stdio: 'ignore', env: w.env });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const held = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['v1.2.0']);
      expect(held.status, held.stdout + held.stderr).toBe(3);
      expect(held.stdout).toMatch(/index\.lock is held by a git running there \(pid \d+\)/);
      expect(existsSync(k.indexLock)).toBe(true);
    } finally { person.kill('SIGKILL'); }
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(join(w.install, 'package.json'), '{"name":"hand-patched"}\n');
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'false' }, ['v1.2.0']);
    expect(r.stdout, r.stdout + r.stderr).toMatch(/match neither v1\.0\.0 nor v1\.2\.0/);
    const where = /kept in (\S+):/.exec(r.stdout)![1]!;
    expect(readFileSync(join(where, 'package.json'), 'utf8')).toBe('{"name":"hand-patched"}\n');
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
  });

  it('a lock it cannot prove is its own stays, and says so', async () => {
    const w = world();
    const k = await killedInCheckout(w); // just now: too fresh to be sure no one else's git holds it
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['v1.2.0']);
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stdout).toMatch(/index\.lock is in the way, and nothing shows it is that upgrade's own/);
    expect(existsSync(k.indexLock)).toBe(true);
    expect(existsSync(k.record)).toBe(true);
  });

  it('a repair that stops at such a lock, before the release is touched, exits 7 to a timer that says it knows 7, and 3 to any other (HB-1431)', () => {
    const w = world();
    const record = lockOf(w).replace(/\.lock\.d$/, '.from');
    mkdirSync(dirname(record), { recursive: true });
    w.git(w.install, 'checkout', '-q', 'v1.1.0');
    writeFileSync(record, 'from v1.0.0\nto v1.1.0\n');
    const lock = join(w.install, '.git', 'index.lock');
    writeFileSync(lock, '');
    const older = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(older.status, older.stdout + older.stderr).toBe(3);
    expect(older.stdout).toMatch(/index\.lock is in the way, and nothing shows it is that upgrade's own/);
    for (const extra of [{ HATCHABOT_UPGRADE_REPAIR_ONLY: '1' }, {}] as Record<string, string>[]) {
      const r = run(w, { HATCHABOT_INSTALL_CMD: 'true', HATCHABOT_UPGRADE_BY_TIMER: '1', HATCHABOT_FOLLOW_KNOWS_7: '1', ...extra }, ['stable']);
      expect(r.status, r.stdout + r.stderr).toBe(7);
    }
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(record, 'utf8')).toBe('from v1.0.0\nto v1.1.0\n');
    expect(restarted(w)).toBe(0);
    // A failure past the repair is 3 still, to a caller that knows 7 too.
    rmSync(lock);
    const install = run(w, { HATCHABOT_INSTALL_CMD: 'false', HATCHABOT_UPGRADE_BY_TIMER: '1', HATCHABOT_FOLLOW_KNOWS_7: '1' }, ['stable']);
    expect(install.status, install.stdout + install.stderr).toBe(3);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
  });

  it('a lock with no record is another git\'s: refused with nothing moved', () => {
    const w = world();
    writeFileSync(join(w.install, '.git', 'index.lock'), '');
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stdout).toContain('index.lock is held, so nothing was changed');
    expect(readFileSync(join(w.install, 'node_modules', 'marker'), 'utf8')).toBe('deps');
    expect(existsSync(join(w.install, 'node_modules.prev'))).toBe(false);
  });
});

describe('the upgrade lock knows its holder (#226)', () => {
  /** The holder line upgrade.sh writes: pid and its start time, as ps tells it. */
  const holder = (pid: number) => `${pid} ${execFileSync('bash', ['-c', `LC_ALL=C ps -o lstart= -p ${pid} | tr -s ' ' | sed 's/^ //;s/ $//'`], { encoding: 'utf8' }).trim()}`;
  const hold = (lock: string, owner: string, age?: string) => {
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner'), `${owner}\n`);
    if (age) execFileSync('touch', ['-d', age, lock]);
  };

  it('a lock whose upgrade is still running is not taken, however old it is', () => {
    const w = world();
    const lock = lockOf(w);
    hold(lock, holder(process.pid), '2 hours ago');
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(4);
    expect(r.stdout).toMatch(/Another upgrade/);
    expect(readFileSync(join(lock, 'owner'), 'utf8').trim()).toBe(holder(process.pid));
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
  });

  /** A real upgrade, holding the lock (its install hangs) in time zone `tz`, until `stop`. */
  async function holding(w: World, tz: string) {
    const started = join(w.root, 'started');
    writeFileSync(join(w.bin, 'hanging-step'), hangingStep(started), { mode: 0o755 });
    const p = spawn('bash', [join(w.install, 'scripts', 'upgrade.sh'), 'stable'], {
      detached: true, stdio: 'ignore',
      env: { ...w.env, TZ: tz, HATCHABOT_UPGRADE_IMAGE: '0', HATCHABOT_INSTALL_CMD: join(w.bin, 'hanging-step'), HATCHABOT_RESTART_CMD: join(w.bin, 'fake-restart') },
    });
    const ended = new Promise((r) => p.on('exit', r));
    const t0 = Date.now();
    while (!existsSync(started)) {
      if (Date.now() - t0 > 15_000) { process.kill(-p.pid!, 'SIGKILL'); throw new Error('the holder never reached its install'); }
      await new Promise((r) => setTimeout(r, 20));
    }
    return { stop: async () => { process.kill(-p.pid!, 'SIGTERM'); await ended; } };
  }

  it('a holder started in another time zone is still the holder: it writes its start in UTC too, and that is what is judged (review of HB-1067)', async () => {
    const w = world();
    const h = await holding(w, 'JST-9');
    try {
      expect(readFileSync(join(lockOf(w), 'owner.utc'), 'utf8')).toMatch(/^\d+ \w{3} \w{3} +\d+ [\d:]+ \d{4}\n$/);
      const r = run(w, { HATCHABOT_INSTALL_CMD: 'true', TZ: 'EST5' }, ['stable']);
      expect(r.status, r.stdout + r.stderr).toBe(4);
      expect(r.stdout).toMatch(/Another upgrade/);
    } finally { await h.stop(); }
  });

  it('a release before this one, in the holder\'s zone, still reads this one\'s holder as running (its owner line is as it always was)', async () => {
    // The holder check every release from #226 to this one runs (follow-latest.sh's
    // repair runs an older release's deploy-release.sh against the same lock).
    const olderCheck = `proc_start() { LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//'; }
lock_left_over() {
  local owner pid
  owner="$(cat "$LOCK_PATH/owner" 2>/dev/null)" || owner=""
  if [ -z "$owner" ]; then [ -n "$(find "$LOCK_PATH" -maxdepth 0 -mmin +60 2>/dev/null)" ]; return; fi
  pid="\${owner%% *}"
  case "$pid" in ''|*[!0-9]*) return 0 ;; esac
  if [ "$owner" = "$pid" ]; then ! kill -0 "$pid" 2>/dev/null; else [ "$owner" != "$pid $(proc_start "$pid")" ]; fi
}
if lock_left_over; then echo gone; else echo held; fi`;
    const w = world();
    const h = await holding(w, 'JST-9');
    try {
      const r = spawnSync('bash', ['-c', olderCheck], { encoding: 'utf8', env: { ...w.env, TZ: 'JST-9', LOCK_PATH: lockOf(w) } });
      expect(r.stdout.trim(), r.stderr).toBe('held');
    } finally { await h.stop(); }
  });

  it('a lock whose holder is gone is taken at once, young or not; so is one whose pid now belongs to another process', () => {
    for (const owner of [`${spawnSync('true').pid} Thu Jan 1 00:00:00 2026`, `${process.pid} Thu Jan 1 00:00:00 2026`]) {
      const w = world();
      const lock = lockOf(w);
      hold(lock, owner);
      const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
      expect(r.status, owner + r.stdout + r.stderr).toBe(0);
      expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.1.0');
      expect(existsSync(lock)).toBe(false);
      expect(existsSync(`${lock}.clearing`)).toBe(false);
    }
  }, 20_000);

  it('what is installed is read once the lock is held: an upgrade that finished meanwhile is not taken backwards (audit #035)', () => {
    const w = world();
    // A newer release (not what stable names): another upgrade puts the machine on it.
    writeFileSync(join(w.src, 'package.json'), '{"name":"x","version":"1.2.0"}\n');
    w.git(w.src, 'commit', '-q', '-am', 'v3'); w.git(w.src, 'tag', 'v1.2.0');
    w.git(w.src, 'push', '-q', w.origin, 'refs/tags/v1.2.0');
    // That other upgrade finishes just as this one takes the lock (which it
    // takes before it resolves stable, fifth review): the lock's mkdir moves the
    // tree first, fetching as that upgrade would.
    const realMkdir = spawnSync('sh', ['-c', 'command -v mkdir'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).stdout.trim();
    const once = join(w.root, 'other-upgrade-pending'); writeFileSync(once, '');
    writeFileSync(join(w.bin, 'mkdir'), `#!/usr/bin/env bash
case "$*" in *.lock.d) [ -f ${JSON.stringify(once)} ] && rm -f ${JSON.stringify(once)} && ${JSON.stringify(REAL_GIT)} -C ${JSON.stringify(w.install)} fetch -q --tags origin && ${JSON.stringify(REAL_GIT)} -C ${JSON.stringify(w.install)} checkout -q v1.2.0 ;; esac
exec ${JSON.stringify(realMkdir)} "$@"
`, { mode: 0o755 });
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true', HATCHABOT_UPGRADE_BY_TIMER: '1' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(once)).toBe(false); // the other upgrade did run
    expect(r.stdout).toContain('On v1.2.0, which is newer than stable (v1.1.0)');
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.2.0');
    expect(restarted(w)).toBe(0);
  });

  it('only its holder lets the lock go: one another run took over is left in place', () => {
    const w = world();
    const lock = lockOf(w);
    // Mid-upgrade, the lock comes to name someone else (as if it were cleared and taken).
    writeFileSync(join(w.bin, 'take-over'), `#!/bin/sh\necho "1 someone else" > ${JSON.stringify(join(lock, 'owner'))}\n`, { mode: 0o755 });
    const r = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'take-over') }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(join(lock, 'owner'), 'utf8').trim()).toBe('1 someone else');
  });
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
    // The timer named the channel it read; the one there now is another: it
    // changes nothing, routine to the timer (twelfth and thirteenth reviews).
    expect(r.status, r.stdout + r.stderr).toBe(4);
    expect(r.stdout).toContain('The channel changed while this waited: this machine now follows beta, not stable');
    expect(readFileSync(join(w.home, '.config', 'hatchabot', 'channel'), 'utf8').trim()).toBe('beta');
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
  });
});

describe('a git install\'s disk, said as the disk: exit 5, which the timer never counts against the release (review of HB-0470)', () => {
  const back = (w: World) => {
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    expect(readFileSync(join(w.install, 'node_modules', 'marker'), 'utf8')).toBe('deps');
    expect(existsSync(join(w.install, 'node_modules.prev'))).toBe(false);
    expect(existsSync(lockOf(w).replace(/\.lock\.d$/, '.from'))).toBe(false);
    expect(restarted(w)).toBe(0);
  };
  it('npm ci stopped by a full disk', () => {
    const w = world();
    writeFileSync(join(w.bin, 'nospc-install'), '#!/bin/sh\necho "npm ERR! code ENOSPC" >&2\necho "npm ERR! nospc ENOSPC: no space left on device, write" >&2\nexit 1\n', { mode: 0o755 });
    const r = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'nospc-install') }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(5);
    expect(r.stderr).toContain('npm ERR! code ENOSPC'); // shown as before, where it was
    expect(r.stdout).toMatch(/The disk holding .* is full.*so v1\.1\.0 could not be installed/);
    back(w);
  });
  it('the checkout stopped by a full disk', () => {
    const w = world();
    writeFileSync(join(w.bin, 'git'), `#!/usr/bin/env bash\n[ "$1 $2 $3" = "checkout --quiet v1.1.0" ] && { echo "error: unable to write file package.json: No space left on device" >&2; exit 128; }\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`, { mode: 0o755 });
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(5);
    expect(r.stdout).toContain('so v1.1.0 could not be checked out');
    back(w);
  });
  it('a write that came up short, its words naming no errno, is the disk: git\'s "unable to write new index file"; one that names a permission is the machine\'s too, the file named (eighth and tenth reviews)', () => {
    const w = world();
    const gitSays = (said: string) => writeFileSync(join(w.bin, 'git'), `#!/usr/bin/env bash\n[ "$1 $2 $3" = "checkout --quiet v1.1.0" ] && { echo ${JSON.stringify(said)} >&2; exit 128; }\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`, { mode: 0o755 });
    gitSays('fatal: unable to write new index file');
    writeFileSync(join(w.bin, 'df'), '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/made-up 1000000 1000000 0 100% /"\n', { mode: 0o755 });
    const full = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(full.status, full.stdout + full.stderr).toBe(5);
    expect(full.stdout).toContain('is full (0 MB free), so v1.1.0 could not be checked out');
    back(w);
    rmSync(join(w.bin, 'df')); // room enough: its words alone say the disk
    const words = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(words.status, words.stdout + words.stderr).toBe(5);
    back(w);
    gitSays('error: unable to write file package.json: Permission denied');
    const perm = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(perm.status, perm.stdout + perm.stderr).toBe(5);
    expect(perm.stdout).toContain('This user could not write package.json (above: no permission there, or a read-only disk), so v1.1.0 could not be checked out.');
    expect(perm.stdout).not.toContain('is full');
    back(w);
  });
  it('the disk\'s words kept in memory win over the log\'s earlier ones, when the log stopped taking lines part-way (eighth review)', () => {
    if (process.getuid?.() === 0) return; // root writes a read-only file anyway
    const w = world();
    // A warning that reaches the log; then the log takes no more lines (as on the disk that filled), and the step says ENOSPC.
    writeFileSync(join(w.bin, 'late-nospc-install'), `#!/bin/sh
echo "npm WARN a made-up warning" >&2
log="$(ls "$HOME"/.local/state/hatchabot/upgrade-*.step.* | head -n 1)"
i=0; until grep -q "made-up warning" "$log" 2>/dev/null || [ "$i" -gt 200 ]; do sleep 0.05; i=$((i + 1)); done
chmod 444 "$log"
echo "npm ERR! nospc ENOSPC: no space left on device, write" >&2
exit 1
`, { mode: 0o755 });
    const r = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'late-nospc-install') }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(5);
    expect(r.stdout).toContain('so v1.1.0 could not be installed');
    back(w);
  });
  it('a rollback that did not work is said, with what to run, and is 3, never the disk alone; its record stays for the next run (eighth review)', () => {
    const w = world();
    // The install fails on a nearly full disk, and the forced checkout back fails too.
    writeFileSync(join(w.bin, 'git'), `#!/usr/bin/env bash\n[ "$1 $2 $3" = "checkout --quiet --force" ] && { echo "error: unable to unlink old 'package.json': Permission denied" >&2; exit 1; }\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`, { mode: 0o755 });
    writeFileSync(join(w.bin, 'df'), '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/made-up 1000000 989760 10240 99% /"\n', { mode: 0o755 });
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'false' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stdout).toMatch(/Putting v1\.0\.0 back did not work either \(above\), so .* may be part-way between v1\.0\.0 and v1\.1\.0\./);
    expect(r.stdout).toContain('is full (10 MB free): free about 1 GB first.');
    expect(r.stdout).toContain('Then run hatchabot upgrade: it puts v1.0.0 back first, from its record.');
    expect(r.stdout).not.toContain('so v1.1.0 could not be installed');
    expect(existsSync(lockOf(w).replace(/\.lock\.d$/, '.from'))).toBe(true);
    rmSync(join(w.bin, 'git')); rmSync(join(w.bin, 'df'));
    const next = run(w, { HATCHABOT_INSTALL_CMD: 'false' }, ['stable']);
    expect(next.stdout).toContain('was cut off part-way — putting v1.0.0 back first');
    expect(next.status, next.stdout + next.stderr).toBe(3);
    back(w);
  });
  it('the checkout and the install in another language: still the disk, as both are asked in English (fourth review of HB-0470)', () => {
    // Each says it in English only when its messages' locale is C (LC_ALL, else LC_MESSAGES, else LANG), as git and npm do.
    const fr = { LANG: 'fr_FR.UTF-8', LC_ALL: 'fr_FR.UTF-8' };
    const say = (en: string, other: string) => `if [ "\${LC_ALL:-\${LC_MESSAGES:-\${LANG:-}}}" = C ]; then echo ${JSON.stringify(en)} >&2; else echo ${JSON.stringify(other)} >&2; fi`;
    const w = world();
    writeFileSync(join(w.bin, 'nospc-install'), `#!/bin/sh\n${say('npm ERR! nospc ENOSPC: No space left on device, write', 'npm ERR! nospc : Aucun espace disponible sur le périphérique')}\nexit 1\n`, { mode: 0o755 });
    const r = run(w, { ...fr, HATCHABOT_INSTALL_CMD: join(w.bin, 'nospc-install') }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(5);
    expect(r.stdout).toContain('so v1.1.0 could not be installed');
    back(w);
    const v = world();
    writeFileSync(join(v.bin, 'git'), `#!/usr/bin/env bash\nif [ "$1 $2 $3" = "checkout --quiet v1.1.0" ]; then ${say('error: unable to write file package.json: No space left on device', "erreur : impossible d'écrire package.json : Aucun espace disponible sur le périphérique")}; exit 128; fi\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`, { mode: 0o755 });
    const c = run(v, { ...fr, HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(c.status, c.stdout + c.stderr).toBe(5);
    expect(c.stdout).toContain('so v1.1.0 could not be checked out');
    back(v);
  });
  // A record that says the disk's words (a link to /dev/full) and one this user cannot add to (its own words; root writes it anyway).
  it.skipIf(process.getuid?.() === 0)('the checkout\'s record that cannot take "restarted" is judged like a step, by its words: the disk is 5, and so is a permission, the record named (fifth, sixth, eighth and tenth reviews of HB-0470)', () => {
    for (const how of ['full', 'denied'] as const) {
      if (how === 'full' && !existsSync('/dev/full')) continue;
      const w = world();
      const from = lockOf(w).replace(/\.lock\.d$/, '.from');
      const spoil = how === 'full' ? `rm -f ${JSON.stringify(from)} && ln -s /dev/full ${JSON.stringify(from)}` : `chmod 444 ${JSON.stringify(from)}`;
      writeFileSync(join(w.bin, 'spoil-install'), `#!/bin/sh\n${spoil}\n`, { mode: 0o755 });
      writeFileSync(join(w.bin, 'df'), `#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho ${how === 'full' ? '"/dev/made-up 1000000 989760 10240 99% /"' : '"/dev/made-up 100000000 1000000 99000000 1% /"'}\n`, { mode: 0o755 });
      const r = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'spoil-install') }, ['stable']);
      expect(r.status, `${how}: ${r.stdout}${r.stderr}`).toBe(5);
      expect(r.stdout).toContain(`Could not write ${from}`);
      if (how === 'full') expect(r.stdout).toContain('so v1.1.0 could not be started');
      else expect(r.stdout).toContain(`This user could not write ${from} (above: no permission there, or a read-only disk), so v1.1.0 could not be started.`);
      back(w);
      expect(existsSync(from)).toBe(false);
    }
  });
  it('words of its own: the release\'s with room left (npm\'s lockfile mismatch with 100 MB free, 3), the disk\'s under 64 MB (50 MB, 5: eighth review; the sixth had them win there)', () => {
    const w = world();
    writeFileSync(join(w.bin, 'mismatch-install'), '#!/bin/sh\necho "npm ERR! code EUSAGE" >&2\necho "npm ERR! \`npm ci\` can only install packages when your package.json and package-lock.json are in sync." >&2\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(w.bin, 'df'), '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/made-up 1000000 897600 102400 90% /"\n', { mode: 0o755 });
    const r = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'mismatch-install') }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stdout).not.toContain('is full');
    back(w);
    writeFileSync(join(w.bin, 'df'), '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/made-up 1000000 948800 51200 99% /"\n', { mode: 0o755 });
    const low = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'mismatch-install') }, ['stable']);
    expect(low.status, low.stdout + low.stderr).toBe(5);
    expect(low.stdout).toContain('is full (50 MB free)');
    back(w);
    // With nothing said, the room left still decides.
    const quiet = world();
    writeFileSync(join(quiet.bin, 'df'), '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/made-up 1000000 948800 51200 99% /"\n', { mode: 0o755 });
    expect(run(quiet, { HATCHABOT_INSTALL_CMD: 'false' }, ['stable']).status).toBe(5);
    back(quiet);
  });
  // A step log that cannot be written (a folder where it would go stands in for the full disk it would show).
  it('the step\'s words are judged from memory when its log cannot be written (sixth review of HB-0470)', () => {
    const w = world();
    writeFileSync(join(w.bin, 'nospc-install'), '#!/bin/sh\necho "npm ERR! nospc ENOSPC: no space left on device, write" >&2\nexit 1\n', { mode: 0o755 });
    // mktemp makes the log; then the log is made a folder, so no line reaches it.
    const realMktemp = spawnSync('sh', ['-c', 'command -v mktemp'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).stdout.trim();
    writeFileSync(join(w.bin, 'mktemp'), `#!/usr/bin/env bash\nf="$(${JSON.stringify(realMktemp)} "$@")" || exit $?\ncase "$f" in *.step.*) rm -f "$f"; mkdir "$f" ;; esac\necho "$f"\n`, { mode: 0o755 });
    const r = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'nospc-install') }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(5);
    expect(r.stdout).toMatch(/The disk holding .* is full.*so v1\.1\.0 could not be installed/);
    back(w);
  });
  it('the step\'s errors are kept in the state folder, not TMPDIR (which may be the same full disk), and not left there (fourth review of HB-0470)', () => {
    const w = world();
    const seen = join(w.root, 'state-during-install');
    writeFileSync(join(w.bin, 'look-install'), `#!/bin/sh\nls ${JSON.stringify(join(w.home, '.local', 'state', 'hatchabot'))} > ${JSON.stringify(seen)}\necho "npm ERR! nospc ENOSPC: no space left on device, write" >&2\nexit 1\n`, { mode: 0o755 });
    const r = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'look-install') }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(5);
    expect(readFileSync(seen, 'utf8').split('\n').filter((n) => n.includes('.step.'))).toHaveLength(1);
    expect(readdirSync(join(w.home, '.local', 'state', 'hatchabot')).filter((n) => n.includes('.step.'))).toEqual([]);
    back(w);
  });
  it('an install that failed with next to nothing left on the disk, whatever it said', () => {
    const w = world();
    writeFileSync(join(w.bin, 'df'), '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/made-up 1000000 989760 10240 99% /"\n', { mode: 0o755 });
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'false' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(5);
    expect(r.stdout).toContain('is full (10 MB free)');
    back(w);
  });
  it('a step is judged by its own words: a warning the checkout printed does not decide the silent install that failed after it (seventh review)', () => {
    const w = world();
    writeFileSync(join(w.bin, 'df'), '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/made-up 1000000 989760 10240 99% /"\n', { mode: 0o755 });
    writeFileSync(join(w.bin, 'git'), `#!/usr/bin/env bash\ncase " $* " in *" checkout "*) echo "warning: a made-up note from the checkout" >&2 ;; esac\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`, { mode: 0o755 });
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'false' }, ['stable']);
    expect(r.stderr).toContain('a made-up note from the checkout');
    expect(r.status, r.stdout + r.stderr).toBe(5); // the install said nothing: the room left decides
    expect(r.stdout).toContain('is full (10 MB free)');
    back(w);
  });
  it('a pin whose record has a folder in its way: named and refused (2), never called the disk (fifth review)', () => {
    const w = world();
    const inWay = lockOf(w).replace(/\.lock\.d$/, '.pin.tmp');
    mkdirSync(inWay, { recursive: true }); // a folder where the record goes
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['v1.1.0']);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stdout).toContain(`${inWay} is in the way`);
    expect(r.stdout).not.toContain('Pinned to');
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
  });
  it('the folder for the upgrade\'s lock that cannot be made: a file in its way named (2), else the machine\'s, 5 (seventh and ninth reviews)', () => {
    const w = world();
    const notADir = join(w.root, 'state-is-a-file'); writeFileSync(notADir, '');
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true', XDG_STATE_HOME: notADir }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stdout).toContain(`${notADir} is in the way`);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    for (const [said, rc] of [['Permission denied', 5], ['No space left on device', 5]] as const) {
      writeFileSync(join(w.bin, 'mkdir'), `#!/bin/sh\ncase "$*" in *.local/state/hatchabot) echo "mkdir: cannot create directory: ${said}" >&2; exit 1 ;; esac\nexec /bin/mkdir "$@"\n`, { mode: 0o755 });
      const m = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
      expect(m.status, said + m.stdout + m.stderr).toBe(rc);
      expect(m.stdout).toContain('where upgrades keep their lock');
      expect(m.stderr).toContain(said);
    }
    rmSync(join(w.bin, 'mkdir'));
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
  });
  it('the record written before anything moves: a folder in its way named (2), else the machine\'s, 5 (seventh and ninth reviews)', () => {
    const w = world();
    const record = lockOf(w).replace(/\.lock\.d$/, '.from');
    mkdirSync(record, { recursive: true });
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stdout).toContain(`${record} is in the way`);
    rmSync(record, { recursive: true });
    for (const [said, rc] of [['Permission denied', 5], ['No space left on device', 5]] as const) {
      writeFileSync(join(w.bin, 'mv'), `#!/bin/sh\ncase "$*" in *.from.tmp*) echo "mv: cannot move: ${said}" >&2; exit 1 ;; esac\nexec /bin/mv "$@"\n`, { mode: 0o755 });
      const m = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
      expect(m.status, said + m.stdout + m.stderr).toBe(rc);
      expect(m.stdout).toContain(`Could not write ${record}`);
      expect(existsSync(record)).toBe(false);
    }
    rmSync(join(w.bin, 'mv'));
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
  });
  it('a command that exits 5 for its own reasons is not the disk: 3', () => {
    const w = world();
    // Under set -e, what is installed cannot be read: git ends with 5 (as curl 5 or a node fatal error might).
    writeFileSync(join(w.bin, 'git'), `#!/usr/bin/env bash\ncase "$1 $2" in "describe --tags"|"rev-parse --short") exit 5 ;; esac\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`, { mode: 0o755 });
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(3);
  });
  it('a lock whose holder cannot be written is let go: 5, and the next run is not told "another upgrade" (second review)', () => {
    const w = world();
    // The holder's file cannot be put in place (a full disk): mv of owner.<pid> fails, every other mv is the real one.
    writeFileSync(join(w.bin, 'mv'), `#!/bin/sh\ncase "$*" in *.lock.d/owner.*) echo "mv: No space left on device" >&2; exit 1 ;; esac\nexec /bin/mv "$@"\n`, { mode: 0o755 });
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(5);
    expect(r.stdout).toContain('Could not take the upgrade lock');
    expect(r.stdout).not.toContain('Another upgrade');
    expect(existsSync(lockOf(w))).toBe(false);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    rmSync(join(w.bin, 'mv'));
    const again = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(again.status, again.stdout + again.stderr).toBe(0);
  });
  it('~/.local/state/hatchabot this user cannot write in: the machine\'s, 5, with what mkdir said and the folder named; never counted against the release (eighth and ninth reviews)', () => {
    if (process.getuid?.() === 0) return; // root writes anywhere
    const w = world();
    const locks = dirname(lockOf(w)); mkdirSync(locks, { recursive: true });
    chmodSync(locks, 0o555);
    try {
      const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
      expect(r.status, r.stdout + r.stderr).toBe(5);
      expect(r.stdout).toContain(`Could not take the upgrade lock ${lockOf(w)} (above)`);
      expect(r.stdout).toContain(`Check that ${locks} is a folder this user can write in`);
      expect(r.stderr).toContain('Permission denied');
    } finally { chmodSync(locks, 0o755); }
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
  });
  it('a lock let go just as this run asked for it is taken on a second try, not called a full disk (third review)', () => {
    const w = world();
    const once = join(w.root, 'mkdir-once');
    // The first mkdir of the lock fails as if another run held it, and that run has let it go by the time this one looks.
    writeFileSync(join(w.bin, 'mkdir'), `#!/bin/sh\ncase "$1" in *.lock.d) [ -f ${JSON.stringify(once)} ] || { : > ${JSON.stringify(once)}; echo "mkdir: File exists" >&2; exit 1; } ;; esac\nexec /bin/mkdir "$@"\n`, { mode: 0o755 });
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain('Could not take the upgrade lock');
    expect(existsSync(once)).toBe(true);
  });
  it('a file where the lock goes is named, not taken for another upgrade or the disk (third review)', () => {
    const w = world();
    mkdirSync(dirname(lockOf(w)), { recursive: true });
    writeFileSync(lockOf(w), 'not a lock\n');
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stdout).toContain(`${lockOf(w)} is in the way of the upgrade lock`);
    expect(r.stdout).not.toContain('Another upgrade');
    expect(readFileSync(lockOf(w), 'utf8')).toBe('not a lock\n');
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
  });
  it('a symlink where the lock goes, dangling or to a folder, is named too: no run made it, and it is not the disk (fourth review)', () => {
    for (const to of ['nowhere-made-up', '.']) {
      const w = world();
      mkdirSync(dirname(lockOf(w)), { recursive: true });
      symlinkSync(to, lockOf(w));
      const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
      expect(r.status, `${to}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stdout).toContain(`${lockOf(w)} is in the way of the upgrade lock`);
      expect(r.stdout).not.toContain('Could not take the upgrade lock');
      expect(r.stdout).not.toContain('Another upgrade');
      expect(lstatSync(lockOf(w)).isSymbolicLink()).toBe(true);
      expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    }
  });
  it('ENOSPC from the inotify watcher limit is not the disk: it counts against the release (second review)', () => {
    const w = world();
    writeFileSync(join(w.bin, 'watchers-install'), `#!/bin/sh\necho "Error: ENOSPC: System limit for number of file watchers reached, watch '/made/up'" >&2\nexit 1\n`, { mode: 0o755 });
    const r = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'watchers-install') }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stdout).not.toContain('is full');
    back(w);
  });
  it('a channel file that cannot be written: the pin is not said made, and this install\'s own channel stays (second review)', () => {
    const w = world();
    mkdirSync(join(w.install, 'data')); writeFileSync(join(w.install, 'data', 'channel'), 'stable\n');
    // A release from before v2.169.0 reads only the user's file: the pin goes there. A folder where it goes.
    mkdirSync(join(w.home, '.config', 'hatchabot', 'channel'), { recursive: true });
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['v1.1.0']);
    expect(r.status, r.stdout + r.stderr).toBe(2); // in the way, named (fifth review)
    expect(r.stdout).toContain(`${join(w.home, '.config', 'hatchabot', 'channel')} is in the way`);
    expect(r.stdout).not.toContain('Pinned to');
    expect(readFileSync(join(w.install, 'data', 'channel'), 'utf8')).toBe('stable\n');
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    // Naming a channel by hand with a folder where it goes: named too.
    rmSync(join(w.install, 'data', 'channel')); mkdirSync(join(w.install, 'data', 'channel'));
    expect(run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['beta']).status).toBe(2);
  });
  it('a channel file is written whole or not at all: a write that fails leaves the old value, not an empty file (fourth review)', () => {
    // A folder where the new value is written first: named (2, fifth review), and the old value kept.
    const w = world();
    mkdirSync(join(w.install, 'data', 'channel.tmp'), { recursive: true }); writeFileSync(join(w.install, 'data', 'channel'), 'stable\n');
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['beta']);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stdout).toContain(`${join(w.install, 'data', 'channel.tmp')} is in the way`);
    expect(readFileSync(join(w.install, 'data', 'channel'), 'utf8')).toBe('stable\n');
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    // A pin taken off when its release did not install: the user's file it went in cannot take the old value back.
    const v = world();
    const user = join(v.home, '.config', 'hatchabot', 'channel');
    mkdirSync(dirname(user), { recursive: true }); writeFileSync(user, 'beta\n');
    writeFileSync(join(v.bin, 'plant-install'), `#!/bin/sh\nmkdir ${JSON.stringify(`${user}.tmp`)}\nexit 1\n`, { mode: 0o755 });
    const p = run(v, { HATCHABOT_INSTALL_CMD: join(v.bin, 'plant-install') }, ['v1.1.0']);
    expect(p.status, p.stdout + p.stderr).toBe(3);
    expect(p.stdout).toContain(`Could not put ${user} back to beta`);
    expect(readFileSync(user, 'utf8')).toBe('v1.1.0\n'); // whole, and the message says so
    expect(v.git(v.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
  });
  // A folder this user cannot write; root writes it anyway.
  it.skipIf(process.getuid?.() === 0)('a channel file whose write fails is the machine\'s: a permission 5 (ninth review), the disk\'s words, in any language, 5 (fifth and sixth reviews)', () => {
    const w = world();
    const data = join(w.install, 'data');
    mkdirSync(data); writeFileSync(join(data, 'channel'), 'stable\n');
    execFileSync('chmod', ['555', data]);
    try {
      const denied = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['beta']);
      expect(denied.status, denied.stdout + denied.stderr).toBe(5);
      expect(denied.stderr).toContain('Permission denied');
      expect(denied.stdout).toContain('Could not write which channel this machine follows');
    } finally { execFileSync('chmod', ['755', data]); }
    // The rename into place says the disk only when asked in English (LC_ALL exported to it); the user's locale is German.
    writeFileSync(join(w.bin, 'mv'), `#!/usr/bin/env bash\ncase "$3" in */data/channel) if [ "\${LC_ALL:-}" = C ]; then echo "mv: cannot move: No space left on device" >&2; else echo "mv: Verschieben nicht möglich: Auf dem Gerät ist kein Speicherplatz mehr verfügbar" >&2; fi; exit 1 ;; esac\nexec /bin/mv "$@"\n`, { mode: 0o755 });
    const full = run(w, { HATCHABOT_INSTALL_CMD: 'true', LANG: 'de_DE.UTF-8' }, ['beta']);
    expect(full.status, full.stdout + full.stderr).toBe(5);
    expect(readFileSync(join(data, 'channel'), 'utf8')).toBe('stable\n');
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
  });
  it('a channel file that is a link to a file (stow, dotfiles) is written through, the link kept; a link to no file is named (sixth review)', () => {
    const w = world();
    const data = join(w.install, 'data'); mkdirSync(data);
    const dot = join(w.root, 'dotfiles'); mkdirSync(dot);
    writeFileSync(join(dot, 'channel'), 'stable\n');
    symlinkSync(join('..', '..', 'dotfiles', 'channel'), join(data, 'channel'));
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['beta']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lstatSync(join(data, 'channel')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dot, 'channel'), 'utf8')).toBe('beta\n');
    expect(readdirSync(dot)).toEqual(['channel']); // its .tmp went beside it, and was renamed
    for (const [name, to] of [['dangling', join(w.root, 'nowhere-made-up')], ['folder', dot]] as const) {
      const v = world();
      mkdirSync(join(v.install, 'data'));
      symlinkSync(to, join(v.install, 'data', 'channel'));
      const bad = run(v, { HATCHABOT_INSTALL_CMD: 'true' }, ['beta']);
      expect(bad.status, `${name}: ${bad.stdout}${bad.stderr}`).toBe(2);
      expect(bad.stdout).toContain(`${join(v.install, 'data', 'channel')} is in the way`);
      expect(lstatSync(join(v.install, 'data', 'channel')).isSymbolicLink()).toBe(true);
    }
  });
});

describe('the channel chosen last is the install\'s own (HB-0235)', () => {
  const userFile = (w: World) => join(w.home, '.config', 'hatchabot', 'channel');
  it('naming a channel writes this install\'s data/channel, and leaves the user\'s one file (another install\'s) alone', () => {
    const w = world();
    mkdirSync(dirname(userFile(w)), { recursive: true });
    writeFileSync(userFile(w), 'beta\n');
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(join(w.install, 'data', 'channel'), 'utf8').trim()).toBe('stable');
    expect(readFileSync(userFile(w), 'utf8').trim()).toBe('beta');
    expect(w.git(w.install, 'status', '--porcelain')).toBe(''); // data/ is ignored: no "local changes" next time
  });

  it('with no channel of its own, the user\'s file is followed, as before v2.169.0', () => {
    const w = world();
    mkdirSync(dirname(userFile(w)), { recursive: true });
    writeFileSync(userFile(w), 'v1.0.0\n');
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' });
    expect(r.stdout).toContain('Already on v1.0.0 (v1.0.0).');
  });

  it('a pin to a release from before v2.169.0 goes in the user\'s file, the only one that release reads', () => {
    const w = world();
    mkdirSync(join(w.install, 'data')); writeFileSync(join(w.install, 'data', 'channel'), 'stable\n');
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['v1.0.0']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(userFile(w), 'utf8').trim()).toBe('v1.0.0');
    expect(existsSync(join(w.install, 'data', 'channel'))).toBe(false);
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

  it.each(['stable', 'latest'])('a stalled %s lookup has both deadlines and names the timed-out request (HB-0623)', (channel) => {
    const r = bundleTree('case " $* " in *" --connect-timeout 10 --max-time 60 "*) exit 28 ;; esac; exit 99')(channel);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/Timed out.*60 seconds/);
    expect(r.stderr).toMatch(channel === 'stable' ? /channels.json/ : /newest release/);
    expect(r.stdout).toBe('');
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

describe('a version named by hand on a clone is a pin only once it can be (HB-0428)', () => {
  const channel = (w: World) => { const f = join(w.install, 'data', 'channel'); return existsSync(f) ? readFileSync(f, 'utf8').trim() : undefined; };
  it('a dirty tree: refused, no pin', () => {
    const w = world();
    mkdirSync(join(w.install, 'data')); writeFileSync(join(w.install, 'data', 'channel'), 'stable\n');
    writeFileSync(join(w.install, 'package.json'), 'edited\n');
    const r = run(w, {}, ['v1.1.0']);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stdout).not.toContain('Pinned');
    expect(channel(w)).toBe('stable');
  });
  it('no such tag: refused, no pin', () => {
    const w = world();
    const r = run(w, {}, ['v9.9.9']);
    expect(r.status).toBe(2);
    expect(channel(w)).toBeUndefined();
  });
  it('an install that fails, a release that does not start: the channel is put back', () => {
    const w = world();
    mkdirSync(join(w.install, 'data')); writeFileSync(join(w.install, 'data', 'channel'), 'beta\n');
    const failed = run(w, { HATCHABOT_INSTALL_CMD: 'false' }, ['v1.1.0']);
    expect(failed.status, failed.stdout + failed.stderr).toBe(3);
    expect(channel(w)).toBe('beta');
    const bad = run(w, { HATCHABOT_INSTALL_CMD: 'true', FAKE_RESTART_RC: '1' }, ['v1.1.0']);
    expect(bad.status, bad.stdout + bad.stderr).toBe(1);
    expect(channel(w)).toBe('beta');
  });
  describe('a pin completed earlier is the person\'s, whatever a later upgrade leaves', () => {
    /** Releases from v2.169.0 on: the pin goes in data/channel. The timer is a tracked script from here. */
    const later = () => {
      const w = world();
      mkdirSync(join(w.install, 'data')); writeFileSync(join(w.install, 'data', 'channel'), 'stable\n');
      for (const f of ['follow-channel.sh', 'follow-tries.sh']) writeFileSync(join(w.src, 'scripts', f), readFileSync(join('scripts', f)), { mode: 0o755 });
      for (const tag of ['v3.1.0', 'v3.2.0']) {
        writeFileSync(join(w.src, 'package.json'), `{"name":"x","version":"${tag.slice(1)}"}\n`);
        w.git(w.src, 'add', '-A'); w.git(w.src, 'commit', '-q', '-m', tag); w.git(w.src, 'tag', tag);
      }
      w.git(w.src, 'push', '-q', w.origin, 'main', '--tags');
      writeFileSync(join(w.bin, 'die-in-install'), '#!/bin/sh\nkill -9 "$PPID"\nexit 1\n', { mode: 0o755 });
      return w;
    };
    const state = (w: World, ext: string) => lockOf(w).replace(/\.lock\.d$/, ext);
    const tick = (w: World) => spawnSync('bash', [join(w.install, 'scripts', 'follow-channel.sh'), 'stable'], {
      encoding: 'utf8', env: { ...w.env, HATCHABOT_RESTART_CMD: join(w.bin, 'fake-restart'), HATCHABOT_UPGRADE_IMAGE: '0', HATCHABOT_INSTALL_CMD: 'true' },
    });
    const at = (w: World) => w.git(w.install, 'describe', '--tags', '--exact-match');
    /** The repair's own clock (HB-1431): a repair that failed waits; its wait made over, the next tick repairs again. */
    const waitOver = (w: World) => {
      const f = join(dirname(lockOf(w)), `follow-channel-tries-${basename(lockOf(w)).replace(/^upgrade-|\.lock\.d$/g, '')}.repair`);
      expect(existsSync(f), f).toBe(true);
      writeFileSync(f, readFileSync(f, 'utf8').replace(/ \d+\n$/, ' 0\n'));
    };
    /** A lock nothing shows is the upgrade's own: older than the record, so every repair stops on it. */
    const stuckLock = (w: World) => {
      const f = join(w.install, '.git', 'index.lock');
      writeFileSync(f, '');
      const old = new Date(Date.now() - 2 * 3600_000);
      utimesSync(f, old, old);
      return f;
    };
    const killedLater = (w: World) => {
      expect(run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['v3.1.0']).status).toBe(0);
      expect(channel(w)).toBe('v3.1.0');
      const r = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'die-in-install') }, ['v3.2.0']);
      expect(r.signal, r.stdout + r.stderr).toBe('SIGKILL');
      expect(channel(w)).toBe('v3.2.0');
      expect(readFileSync(state(w, '.pin'), 'utf8')).toContain('channel v3.1.0');
    };

    it('a later pin killed, its repair failing tick after tick: back to the pin, and it stays', () => {
      const w = later();
      killedLater(w);
      const lock = stuckLock(w);
      for (let i = 0; i < 3; i++) {
        if (i) waitOver(w);
        const r = tick(w);
        expect(r.status, r.stdout + r.stderr).toBe(1);
        expect(channel(w), `tick ${i}: ${r.stdout}`).toBe('v3.1.0');
        expect(existsSync(state(w, '.pin'))).toBe(false);
        expect(existsSync(state(w, '.from'))).toBe(true);
      }
      // The lock cleared by a person: repaired, on the pinned release and still pinned, the timer quiet.
      rmSync(lock);
      waitOver(w);
      const fixed = tick(w);
      expect(fixed.status, fixed.stdout + fixed.stderr).toBe(0);
      expect(at(w)).toBe('v3.1.0');
      expect(channel(w)).toBe('v3.1.0');
      expect(existsSync(state(w, '.from'))).toBe(false);
      expect(tick(w).stdout).toBe('');
    });
    it('a failed rollback leaves the record with no kill: the pin it was on stays through the repairs', () => {
      const w = later();
      expect(run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['v3.1.0']).status).toBe(0);
      // The install fails with a lock in the way, so the checkout back fails too.
      writeFileSync(join(w.bin, 'lock-and-fail'), `#!/bin/sh\n: > ${JSON.stringify(join(w.install, '.git', 'index.lock'))}\nexit 1\n`, { mode: 0o755 });
      const r = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'lock-and-fail') }, ['v3.2.0']);
      expect(r.status, r.stdout + r.stderr).toBe(3);
      expect(channel(w)).toBe('v3.1.0');
      expect(existsSync(state(w, '.from'))).toBe(true);
      expect(existsSync(state(w, '.pin'))).toBe(false);
      for (let i = 0; i < 2; i++) {
        if (i) waitOver(w);
        const t = tick(w);
        expect(t.status, t.stdout + t.stderr).toBe(1);
        expect(channel(w), `tick ${i}: ${t.stdout}`).toBe('v3.1.0');
      }
    });
    it('a one-time pin an upgrade.sh from before the record left still comes off', () => {
      const w = later();
      killedLater(w);
      // What that upgrade.sh leaves: the pin, its checkout's record as it wrote it, no pin record.
      rmSync(state(w, '.pin'));
      writeFileSync(state(w, '.from'), readFileSync(state(w, '.from'), 'utf8').replace('pins-recorded\n', ''));
      stuckLock(w);
      const r = tick(w);
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(channel(w), r.stdout).toBeUndefined();
    });
  });
  it('a release that comes up is pinned', () => {
    const w = world();
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['v1.1.0']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Pinned to v1.1.0');
    expect(readFileSync(join(w.home, '.config', 'hatchabot', 'channel'), 'utf8').trim()).toBe('v1.1.0'); // from before v2.169.0: the user's file
  });
});

describe('the runtime image step uses the daemon .env names (HB-0431)', () => {
  // A release that moves OpenClaw: the image step has what it needs. Docker and the
  // fetch are shims that write down which daemon they were pointed at.
  function imageWorld() {
    const w = world();
    mkdirSync(join(w.src, 'docker'));
    writeFileSync(join(w.src, 'docker', 'Dockerfile.runtime'), 'ARG OPENCLAW_VERSION=2026.9.9\n');
    writeFileSync(join(w.src, 'scripts', 'build-runtime-image.sh'), `#!/usr/bin/env bash\necho "fetch \${DOCKER_HOST:-default}" >> ${JSON.stringify(join(w.root, 'docker.log'))}\n`, { mode: 0o755 });
    w.git(w.src, 'add', '-A'); w.git(w.src, 'commit', '-q', '-m', 'v3'); w.git(w.src, 'tag', 'v1.2.0');
    w.git(w.src, 'push', '-q', w.origin, 'main', '--tags');
    writeFileSync(join(w.bin, 'docker'), `#!/usr/bin/env bash\necho "$1 \${DOCKER_HOST:-default}" >> ${JSON.stringify(join(w.root, 'docker.log'))}\ncase "$1" in image) echo 2026.1.1 ;; esac\n`, { mode: 0o755 });
    return w;
  }
  const log = (w: World) => readFileSync(join(w.root, 'docker.log'), 'utf8').trim().split('\n');
  const up = (w: World, extra: Record<string, string> = {}) => run(w, { HATCHABOT_INSTALL_CMD: 'true', HATCHABOT_UPGRADE_IMAGE: '1', ...extra }, ['v1.2.0']);

  it('looks and fetches there, the last line of .env winning over the shell', () => {
    const w = imageWorld();
    writeFileSync(join(w.install, '.env'), "DOCKER_HOST=unix:///tmp/old.sock\nDOCKER_HOST='unix:///tmp/synthetic-tenant.sock'\n");
    w.git(w.install, 'config', 'core.excludesFile', '/dev/null');
    writeFileSync(join(w.install, '.git', 'info', 'exclude'), '.env\n');
    const r = up(w, { DOCKER_HOST: 'unix:///tmp/shell.sock' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(log(w)).toEqual(['image unix:///tmp/synthetic-tenant.sock', 'fetch unix:///tmp/synthetic-tenant.sock']);
  });
  it('no line in .env: the daemon it would have used, as before', () => {
    const w = imageWorld();
    writeFileSync(join(w.install, '.git', 'info', 'exclude'), '.env\n');
    writeFileSync(join(w.install, '.env'), 'HATCHABOT_SECRET_KEY=made-up\n');
    expect(up(w).status).toBe(0);
    expect(log(w)).toEqual(['image default', 'fetch default']);
  });
  it('a line with spaces around the =: the daemon the service gets on Linux; on a Mac, sourced, it sets none (review of HB-1210)', () => {
    for (const mac of [false, true]) {
      const w = imageWorld();
      writeFileSync(join(w.install, '.git', 'info', 'exclude'), '.env\n');
      writeFileSync(join(w.install, '.env'), 'DOCKER_HOST = unix:///tmp/synthetic-tenant.sock\n');
      if (mac) writeFileSync(join(w.bin, 'uname'), '#!/usr/bin/env bash\necho Darwin\n', { mode: 0o755 });
      const r = up(w);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(log(w), String(mac)).toEqual(mac ? ['image default', 'fetch default'] : ['image unix:///tmp/synthetic-tenant.sock', 'fetch unix:///tmp/synthetic-tenant.sock']);
    }
  });
  it('this shell\'s own Docker settings (a context, TLS, a host, a config folder) are not the service\'s: dropped, and the .env\'s used (HB-1354)', () => {
    const shell = { DOCKER_CONTEXT: 'made-up-remote', DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/made-up/shell-certs', DOCKER_HOST: 'tcp://192.0.2.9:2376', DOCKER_CONFIG: '/made-up/docker-config' };
    const says = 'echo "$1 host=${DOCKER_HOST:-default} context=${DOCKER_CONTEXT:-none} tls=${DOCKER_TLS_VERIFY:-none} certs=${DOCKER_CERT_PATH:-none} config=${DOCKER_CONFIG:-none}"';
    for (const [dotenv, want] of [
      ['HATCHABOT_SECRET_KEY=made-up\n', 'host=default context=none tls=none certs=none config=none'],
      ['DOCKER_HOST=tcp://192.0.2.20:2376\nDOCKER_TLS_VERIFY=1\nDOCKER_CERT_PATH=/made-up/service-certs\nDOCKER_CONFIG=/made-up/service-config\n', 'host=tcp://192.0.2.20:2376 context=none tls=1 certs=/made-up/service-certs config=/made-up/service-config'],
    ] as const) {
      const w = imageWorld();
      writeFileSync(join(w.src, 'scripts', 'build-runtime-image.sh'), `#!/usr/bin/env bash\nset -- fetch\n${says} >> ${JSON.stringify(join(w.root, 'docker.log'))}\n`, { mode: 0o755 });
      w.git(w.src, 'add', '-A'); w.git(w.src, 'commit', '-q', '-m', 'v4'); w.git(w.src, 'tag', '-f', 'v1.2.0');
      w.git(w.src, 'push', '-q', '-f', w.origin, 'main', '--tags');
      writeFileSync(join(w.bin, 'docker'), `#!/usr/bin/env bash\n${says} >> ${JSON.stringify(join(w.root, 'docker.log'))}\ncase "$1" in\n  image) echo 2026.1.1 ;;\nesac\n`, { mode: 0o755 });
      writeFileSync(join(w.install, '.git', 'info', 'exclude'), '.env\n');
      writeFileSync(join(w.install, '.env'), dotenv);
      const r = up(w, shell);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(log(w), dotenv).toEqual([`image ${want}`, `fetch ${want}`]);
    }
  });
  it('a .env that cannot be read as the service reads it (no node, on Linux, and a line bash cannot read as systemd does): said, not passed over, and this shell\'s daemon used (HB-1381)', () => {
    const w = imageWorld();
    writeFileSync(join(w.install, '.git', 'info', 'exclude'), '.env\n');
    writeFileSync(join(w.install, '.env'), 'DOCKER_HOST=unix:///tmp/synthetic-tenant.sock\r\n');
    const r = up(w, { PATH: `${w.bin}:${systemPathWithout(join(w.root, 'system'), ['node', 'nodejs'])}` });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`⚠ Could not read ${w.install}/.env as the service reads it (on Linux, with no node on this PATH, only plain NAME=value lines can be), so the runtime image is checked with this shell's DOCKER_HOST, DOCKER_CONTEXT, DOCKER_TLS_VERIFY, DOCKER_CERT_PATH, DOCKER_CONFIG, HATCHABOT_IMAGE and HATCHABOT_IMAGE_REGISTRY, which may not be the service's.`);
    expect(log(w)).toEqual(['image default', 'fetch default']);
    // With no node, a plain line is read all the same, and nothing said (review of HB-1529).
    const plain = imageWorld();
    writeFileSync(join(plain.install, '.git', 'info', 'exclude'), '.env\n');
    writeFileSync(join(plain.install, '.env'), 'DOCKER_HOST=unix:///tmp/synthetic-tenant.sock\n');
    const p = up(plain, { PATH: `${plain.bin}:${systemPathWithout(join(plain.root, 'system'), ['node', 'nodejs'])}` });
    expect(p.status, p.stdout + p.stderr).toBe(0);
    expect(p.stdout).not.toContain('Could not read');
    // Read through: nothing said.
    const read = imageWorld();
    writeFileSync(join(read.install, '.git', 'info', 'exclude'), '.env\n');
    writeFileSync(join(read.install, '.env'), 'DOCKER_HOST=unix:///tmp/synthetic-tenant.sock\n');
    expect(up(read).stdout).not.toContain('Could not read');
  });
});

describe('the runtime image step uses the image and mirror .env names (HB-0984)', () => {
  // A release that moves OpenClaw to 2026.9.9. docker writes down which image
  // it was asked about, and answers with that image's OpenClaw (VERSIONS:
  // "image=version ..."); the fetch writes down the image and mirror it got.
  function imageWorld() {
    const w = world();
    mkdirSync(join(w.src, 'docker'));
    writeFileSync(join(w.src, 'docker', 'Dockerfile.runtime'), 'ARG OPENCLAW_VERSION=2026.9.9\n');
    writeFileSync(join(w.src, 'scripts', 'build-runtime-image.sh'), `#!/usr/bin/env bash\necho "fetch into \${HATCHABOT_IMAGE:-default} from \${HATCHABOT_IMAGE_REGISTRY:-default}" >> ${JSON.stringify(join(w.root, 'docker.log'))}\n`, { mode: 0o755 });
    w.git(w.src, 'add', '-A'); w.git(w.src, 'commit', '-q', '-m', 'v3'); w.git(w.src, 'tag', 'v1.2.0');
    w.git(w.src, 'push', '-q', w.origin, 'main', '--tags');
    writeFileSync(join(w.bin, 'docker'), `#!/usr/bin/env bash
[ "$1 $2" = "image inspect" ] || exit 0
echo "inspect $3" >> ${JSON.stringify(join(w.root, 'docker.log'))}
for pair in \${VERSIONS:-}; do [ "\${pair%%=*}" = "$3" ] && { echo "\${pair#*=}"; exit 0; }; done
exit 1
`, { mode: 0o755 });
    writeFileSync(join(w.install, '.git', 'info', 'exclude'), '.env\n');
    return w;
  }
  const log = (w: World) => (existsSync(join(w.root, 'docker.log')) ? readFileSync(join(w.root, 'docker.log'), 'utf8').trim().split('\n') : []);
  const up = (w: World, extra: Record<string, string> = {}) => run(w, { HATCHABOT_INSTALL_CMD: 'true', HATCHABOT_UPGRADE_IMAGE: '1', ...extra }, ['v1.2.0']);

  it('the timer, which has no .env: the image .env names is the one looked at, and fetched from the mirror .env names', () => {
    const w = imageWorld();
    writeFileSync(join(w.install, '.env'), 'HATCHABOT_SECRET_KEY=made-up\nHATCHABOT_IMAGE="made-up-runtime:latest"\nHATCHABOT_IMAGE_REGISTRY=registry.example.test/runtime\n');
    const r = up(w, { VERSIONS: 'hatchabot-runtime:latest=2026.9.9 made-up-runtime:latest=2026.7.1' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(log(w)).toEqual(['inspect made-up-runtime:latest', 'fetch into made-up-runtime:latest from registry.example.test/runtime']);
    expect(r.stdout).toContain('carries OpenClaw 2026.7.1; this release\'s default is 2026.9.9');
  });

  it('read as the service reads .env, as setup-host.sh reads it: spaces around the = on Linux, a comment off on a Mac (review of HB-1210)', () => {
    // Linux (systemd): the spaced lines set both. A Mac (bash, sourced): a spaced line is a command and sets nothing; a comment after a value is not part of it.
    for (const [mac, env, want] of [
      [false, 'HATCHABOT_IMAGE = made-up-runtime:latest\nHATCHABOT_IMAGE_REGISTRY = registry.example.test/runtime\n', ['inspect made-up-runtime:latest', 'fetch into made-up-runtime:latest from registry.example.test/runtime']],
      [true, 'HATCHABOT_IMAGE = other-runtime:latest\nHATCHABOT_IMAGE=made-up-runtime:latest # the image\n', ['inspect made-up-runtime:latest', 'fetch into made-up-runtime:latest from default']],
    ] as const) {
      const w = imageWorld();
      writeFileSync(join(w.install, '.env'), `HATCHABOT_SECRET_KEY=made-up\n${env}`);
      if (mac) writeFileSync(join(w.bin, 'uname'), '#!/usr/bin/env bash\necho Darwin\n', { mode: 0o755 });
      const r = up(w, { VERSIONS: 'hatchabot-runtime:latest=2026.9.9 made-up-runtime:latest=2026.7.1' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(log(w), String(mac)).toEqual(want);
    }
  });

  it('an install from before the rename: the image and mirror .env names under their old names are the service\'s, and the ones looked at and fetched (HB-1379)', () => {
    const w = imageWorld();
    writeFileSync(join(w.install, '.env'), 'HATCHABOT_SECRET_KEY=made-up\nAGENTCLAW_IMAGE=made-up-runtime:latest\nAGENTCLAW_IMAGE_REGISTRY=registry.example.test/runtime\n');
    const r = up(w, { VERSIONS: 'hatchabot-runtime:latest=2026.9.9 made-up-runtime:latest=2026.7.1' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(log(w)).toEqual(['inspect made-up-runtime:latest', 'fetch into made-up-runtime:latest from registry.example.test/runtime']);
  });

  it('a newer image promoted in the repository named: kept, though the default repository is older', () => {
    for (const env of ['dotenv', 'shell'] as const) {
      const w = imageWorld();
      writeFileSync(join(w.install, '.env'), `HATCHABOT_SECRET_KEY=made-up\n${env === 'dotenv' ? 'HATCHABOT_IMAGE=made-up-runtime\n' : ''}`);
      const r = up(w, { VERSIONS: 'hatchabot-runtime:latest=2026.1.1 made-up-runtime:latest=2026.12.1', ...(env === 'shell' ? { HATCHABOT_IMAGE: 'made-up-runtime:latest' } : {}) });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(log(w), env).toEqual(['inspect made-up-runtime:latest']);
    }
  });

  it('this shell\'s HATCHABOT_IMAGE_REPO naming another repository than the fleet\'s: said, with how to tag the image in; the fleet\'s own, or a pin: nothing said (HB-1386)', () => {
    const said = '⚠ HATCHABOT_IMAGE_REPO (set in this shell) names made-up-elsewhere, not the fleet\'s repository made-up-runtime (HATCHABOT_IMAGE): the runtime image is looked at and fetched there, where the app and its image list do not look. To use one fetched there, run the upgrade without HATCHABOT_IMAGE_REPO, or tag it in:  docker tag made-up-elsewhere:latest made-up-runtime:latest';
    for (const [dotenv, repo, says] of [
      ['HATCHABOT_IMAGE=made-up-runtime:latest\n', 'made-up-elsewhere', true],
      ['HATCHABOT_IMAGE=made-up-runtime:latest\n', 'made-up-runtime', false],
      ['HATCHABOT_IMAGE=made-up-runtime:2026.7.1\n', 'made-up-elsewhere', false],
    ] as const) {
      const w = imageWorld();
      writeFileSync(join(w.install, '.env'), `HATCHABOT_SECRET_KEY=made-up\n${dotenv}`);
      const r = up(w, { HATCHABOT_IMAGE_REPO: repo, VERSIONS: 'made-up-elsewhere:latest=2026.9.9 made-up-runtime:latest=2026.9.9' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      if (says) expect(r.stdout.split('\n'), repo).toContain(said);
      else expect(r.stdout, `${dotenv} ${repo}`).not.toContain('HATCHABOT_IMAGE_REPO');
    }
  });

  it('an image pinned to another tag in .env: left as it is, nothing fetched', () => {
    const w = imageWorld();
    writeFileSync(join(w.install, '.env'), 'HATCHABOT_SECRET_KEY=made-up\nHATCHABOT_IMAGE=made-up-runtime:2026.7.1\n');
    const r = up(w, { VERSIONS: 'made-up-runtime:2026.7.1=2026.7.1' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(log(w)).toEqual([]);
    expect(r.stdout).toContain('The runtime image is pinned to made-up-runtime:2026.7.1 (HATCHABOT_IMAGE): the upgrade leaves it as it is');
  });

  it('an image with no OpenClaw version label (old or hand-built) is older, as setup-host.sh has it: fetched over (HB-1211)', () => {
    const w = imageWorld();
    writeFileSync(join(w.install, '.env'), 'HATCHABOT_SECRET_KEY=made-up\n');
    // docker as it answers for a label the image does not have.
    writeFileSync(join(w.bin, 'docker'), `#!/usr/bin/env bash
[ "$1 $2" = "image inspect" ] || exit 0
echo "inspect $3" >> ${JSON.stringify(join(w.root, 'docker.log'))}
echo '<no value>'
`, { mode: 0o755 });
    const r = up(w);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(log(w)).toEqual(['inspect hatchabot-runtime:latest', 'fetch into default from default']);
    expect(r.stdout).toContain('carries OpenClaw nothing; this release\'s default is 2026.9.9');
  });

  it('none named: hatchabot-runtime:latest from the default registry, as before', () => {
    const w = imageWorld();
    writeFileSync(join(w.install, '.env'), 'HATCHABOT_SECRET_KEY=made-up\n');
    const r = up(w, { VERSIONS: 'hatchabot-runtime:latest=2026.1.1' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(log(w)).toEqual(['inspect hatchabot-runtime:latest', 'fetch into default from default']);
  });
});

describe('the tenth review: permissions are the machine\'s, things in the way named, the lookup outside the lock', () => {
  const plenty = '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/made-up 100000000 1000000 99000000 1% /"\n';
  const atTag = (w: World) => w.git(w.install, 'describe', '--tags', '--exact-match');

  it('npm ci\'s EACCES, with room to spare, is the machine\'s: 5, the folder named, the old release back', () => {
    const w = world();
    const cache = join(w.home, '.npm', '_cacache');
    writeFileSync(join(w.bin, 'eacces-install'), `#!/bin/sh
echo "npm error code EACCES" >&2
echo "npm error syscall mkdir" >&2
echo "npm error path ${cache}" >&2
echo "npm error Error: EACCES: permission denied, mkdir '${cache}'" >&2
exit 243
`, { mode: 0o755 });
    writeFileSync(join(w.bin, 'df'), plenty, { mode: 0o755 });
    const r = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'eacces-install') }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(5);
    expect(r.stdout).toContain(`This user could not write ${cache} (above: no permission there, or a read-only disk), so v1.1.0 could not be installed. Fix that, then try again.`);
    expect(r.stdout).not.toContain('is full');
    expect(atTag(w)).toBe('v1.0.0');
    expect(readFileSync(join(w.install, 'node_modules', 'marker'), 'utf8')).toBe('deps');
  });

  it('a file where a folder above a record goes is in the way, named (2), not the disk: ~/.config/hatchabot, this install\'s data/', () => {
    const w = world();
    mkdirSync(join(w.home, '.config'));
    const stray = join(w.home, '.config', 'hatchabot');
    writeFileSync(stray, 'not a folder\n');
    // A release from before v2.169.0, pinned by hand, is remembered in the user's file.
    const pin = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['v1.1.0']);
    expect(pin.status, pin.stdout + pin.stderr).toBe(2);
    expect(pin.stdout).toContain(`${stray} is in the way, and no deploy or upgrade made it.`);
    expect(atTag(w)).toBe('v1.0.0');
    rmSync(stray);
    writeFileSync(join(w.install, 'data'), 'not a folder\n');
    const named = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(named.status, named.stdout + named.stderr).toBe(2);
    expect(named.stdout).toContain(`${join(w.install, 'data')} is in the way`);
    expect(atTag(w)).toBe('v1.0.0');
  });

  /** A hand-run upgrade whose release lookup (release-target.sh's git fetch) waits until `go` is there. */
  function slowLookup(w: World, args: string[]) {
    const looking = join(w.root, 'looking'), go = join(w.root, 'go');
    writeFileSync(join(w.bin, 'git'), `#!/usr/bin/env bash
if [ "$1" = fetch ]; then : > ${JSON.stringify(looking)}; i=0; while [ ! -e ${JSON.stringify(go)} ] && [ "$i" -lt 250 ]; do sleep 0.1; i=$((i + 1)); done; fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`, { mode: 0o755 });
    const p = spawn('bash', [join(w.install, 'scripts', 'upgrade.sh'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...w.env, HATCHABOT_RESTART_CMD: join(w.bin, 'fake-restart'), HATCHABOT_UPGRADE_IMAGE: '0', HATCHABOT_INSTALL_CMD: 'true' },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    const done = new Promise<{ status: number | null; out: string }>((res) => p.on('close', (status) => res({ status, out })));
    const started = async () => { for (let i = 0; i < 200 && !existsSync(looking); i++) await new Promise((r) => setTimeout(r, 50)); return existsSync(looking); };
    const release = () => writeFileSync(go, '');
    return { started, release, done };
  }

  it('a lookup that hangs (no network) holds no lock: the channel tick meanwhile upgrades, not "another upgrade" (4)', async () => {
    const w = world();
    const hand = slowLookup(w, []);
    try {
      expect(await hand.started()).toBe(true);
      const tick = run(w, { HATCHABOT_INSTALL_CMD: 'true', HATCHABOT_UPGRADE_BY_TIMER: '1', HATCHABOT_UPGRADE_TARGET: 'v1.1.0' }, ['stable']);
      expect(tick.status, tick.stdout + tick.stderr).toBe(0);
      expect(tick.stdout).not.toContain('Another upgrade');
      expect(atTag(w)).toBe('v1.1.0');
    } finally { hand.release(); }
    const r = await hand.done;
    // It then finds the lock free, and the machine already where it was going.
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('Already on v1.1.0 (stable).');
  });

  it('the channel it looked up by changed meanwhile (another upgrade named another): read again under the lock, nothing done, 4', async () => {
    const w = world();
    const hand = slowLookup(w, []);
    try {
      expect(await hand.started()).toBe(true);
      mkdirSync(join(w.install, 'data'), { recursive: true });
      writeFileSync(join(w.install, 'data', 'channel'), 'v1.0.0\n'); // pinned where it is, by hand, meanwhile
    } finally { hand.release(); }
    const r = await hand.done;
    expect(r.status, r.out).toBe(4);
    expect(r.out).toContain('While this looked for the release stable names, another upgrade set this machine to follow v1.0.0: nothing was changed.');
    expect(atTag(w)).toBe('v1.0.0');
  });
});

describe('the eleventh review: a file it could not run is the release\'s, and only the step\'s last words count', () => {
  const plenty = '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/made-up 100000000 1000000 99000000 1% /"\n';
  const atTag = (w: World) => w.git(w.install, 'describe', '--tags', '--exact-match');

  it('a release whose ensure-deps.sh lost its execute bit fails as its own (3), not the machine\'s: bash\'s 126', () => {
    const w = world();
    writeFileSync(join(w.src, 'scripts', 'ensure-deps.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    writeFileSync(join(w.src, 'package.json'), '{"name":"x","version":"1.2.0"}\n');
    w.git(w.src, 'add', '-A'); w.git(w.src, 'commit', '-q', '-m', 'v3'); w.git(w.src, 'tag', 'v1.2.0');
    w.git(w.src, 'push', '-q', w.origin, 'main', 'v1.2.0');
    w.git(w.install, 'fetch', '-q', '--tags', 'origin');
    writeFileSync(join(w.bin, 'df'), plenty, { mode: 0o755 });
    // The release's own install step, as the timer runs it (no HATCHABOT_INSTALL_CMD).
    const r = run(w, { HATCHABOT_UPGRADE_BY_TIMER: '1', HATCHABOT_UPGRADE_TARGET: 'v1.2.0' }, ['stable']);
    expect(r.stderr).toContain('ensure-deps.sh: Permission denied');
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stdout).not.toContain('could not write');
    expect(atTag(w)).toBe('v1.0.0');
    expect(readFileSync(join(w.install, 'node_modules', 'marker'), 'utf8')).toBe('deps');
  });

  it('npm running a file it could not run (dash\'s "sh: 1: …: Permission denied", npm\'s code 126) is the release\'s too; npm ci\'s EACCES on writing stays 5', () => {
    const w = world();
    writeFileSync(join(w.bin, 'df'), plenty, { mode: 0o755 });
    writeFileSync(join(w.bin, 'exec-install'), '#!/bin/sh\necho "npm error code 126" >&2\necho "npm error path ./node_modules/made-up-module" >&2\necho "npm error command sh -c ./install.sh" >&2\necho "npm error sh: 1: ./install.sh: Permission denied" >&2\nexit 1\n', { mode: 0o755 });
    const own = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'exec-install') }, ['stable']);
    expect(own.status, own.stdout + own.stderr).toBe(3);
    expect(atTag(w)).toBe('v1.0.0');
    const cache = join(w.home, '.npm', '_cacache');
    writeFileSync(join(w.bin, 'write-install'), `#!/bin/sh\necho "npm error code EACCES" >&2\necho "npm error syscall open" >&2\necho "npm error Error: EACCES: permission denied, open '${cache}/index-v5/made-up'" >&2\nexit 1\n`, { mode: 0o755 });
    const machine = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'write-install') }, ['stable']);
    expect(machine.status, machine.stdout + machine.stderr).toBe(5);
    expect(machine.stdout).toContain(`This user could not write ${cache}/index-v5/made-up`);
    expect(atTag(w)).toBe('v1.0.0');
  });

  it('an early warning does not decide: gyp\'s "WARN EACCES" for its dev dir, then a compile error, is the release\'s (3); every line is still shown', () => {
    const w = world();
    writeFileSync(join(w.bin, 'df'), plenty, { mode: 0o755 });
    const devDir = join(w.home, '.cache', 'node-gyp', '22.0.0');
    const errors = Array.from({ length: 30 }, (_, i) => `../src/made_up.cc:${i + 10}:3: error: 'made_up_symbol_${i}' was not declared in this scope`);
    writeFileSync(join(w.bin, 'gyp-install'), [
      '#!/bin/sh',
      `echo 'gyp WARN EACCES current user ("nobody") does not have permission to access the dev dir "${devDir}"' >&2`,
      `echo 'gyp WARN EACCES attempting to reinstall using temporary dev dir "${join(w.root, 'tmp', '.node-gyp')}"' >&2`,
      ...errors.map((e) => `echo "${e}" >&2`),
      'echo "gyp ERR! build error" >&2',
      'echo "npm error code 1" >&2',
      'exit 1', '',
    ].join('\n'), { mode: 0o755 });
    const r = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'gyp-install') }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stdout).not.toContain('could not write');
    expect(r.stderr).toContain('does not have permission to access the dev dir');
    expect(r.stderr).toContain(`${errors[0]}\n${errors[1]}\n`);
    expect(r.stderr).toContain('gyp ERR! build error\nnpm error code 1\n');
    expect(atTag(w)).toBe('v1.0.0');
  });
});

describe('the twelfth review: the timer reads its channel again under the lock; each line judged alone; bash\'s own words by their path', () => {
  const plenty = '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/made-up 100000000 1000000 99000000 1% /"\n';
  const atTag = (w: World) => w.git(w.install, 'describe', '--tags', '--exact-match');
  const REAL_MKDIR = execFileSync('bash', ['-c', 'command -v mkdir'], { encoding: 'utf8' }).trim();
  const REAL_MKTEMP = execFileSync('bash', ['-c', 'command -v mktemp'], { encoding: 'utf8' }).trim();

  it('the owner pins v1.0.0 while the timer\'s run waits for the lock: it upgrades nothing (4, routine), and the machine stays on the pin', () => {
    const w = world();
    const pin = join(w.install, 'data', 'channel');
    mkdirSync(join(w.install, 'data'), { recursive: true });
    writeFileSync(pin, 'stable\n');
    // The owner's pin lands just as the timer's run reaches for the lock.
    writeFileSync(join(w.bin, 'mkdir'), `#!/usr/bin/env bash
case "$1" in *.lock.d) printf 'v1.0.0\\n' > ${JSON.stringify(pin)} ;; esac
exec ${JSON.stringify(REAL_MKDIR)} "$@"
`, { mode: 0o755 });
    // As follow-channel.sh runs it: the channel it read, and the release that channel named.
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true', HATCHABOT_UPGRADE_BY_TIMER: '1', HATCHABOT_UPGRADE_TARGET: 'v1.1.0' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(4);
    expect(r.stdout).toContain('The channel changed while this waited: this machine now follows v1.0.0, not stable, so nothing was changed.');
    expect(atTag(w)).toBe('v1.0.0');
    expect(readFileSync(pin, 'utf8')).toBe('v1.0.0\n');
    expect(restarted(w)).toBe(0);
    // A channel named by hand that is still what the file says goes on as before.
    rmSync(join(w.bin, 'mkdir'));
    const hand = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(hand.status, hand.stdout + hand.stderr).toBe(0);
    expect(atTag(w)).toBe('v1.1.0');
  });

  it('pieces on two lines do not combine: gyp\'s "spawn make", then EACCES on mkdir, is the machine\'s (5)', () => {
    const w = world();
    writeFileSync(join(w.bin, 'df'), plenty, { mode: 0o755 });
    writeFileSync(join(w.bin, 'gyp-install'), [
      '#!/bin/sh',
      'echo "gyp info spawn make" >&2',
      'echo "gyp info spawn args [ \'BUILDTYPE=Release\', \'-C\', \'build\' ]" >&2',
      `echo "gyp ERR! stack Error: EACCES: permission denied, mkdir '${w.home}/.cache/node-gyp'" >&2`,
      'exit 1', '',
    ].join('\n'), { mode: 0o755 });
    const r = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'gyp-install') }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(5);
    expect(r.stdout).toContain(`This user could not write ${w.home}/.cache/node-gyp`);
    expect(atTag(w)).toBe('v1.0.0');
  });

  it('bash\'s own "line N: X: Permission denied" is judged by X: a file outside the release, or one of its own with the execute bit (a noexec mount), is the machine\'s (5)', () => {
    const w = world();
    writeFileSync(join(w.bin, 'df'), plenty, { mode: 0o755 });
    // Running a file outside the release that is not executable: bash's 126.
    const outside = join(w.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'made-up-tool'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    writeFileSync(join(w.bin, 'run-outside'), `#!/usr/bin/env bash\n${JSON.stringify(join(outside, 'made-up-tool'))}\n`, { mode: 0o755 });
    const run1 = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'run-outside') }, ['stable']);
    expect(run1.stderr).toContain('made-up-tool: Permission denied');
    expect(run1.status, run1.stdout + run1.stderr).toBe(5);
    expect(run1.stdout).toContain(`This user could not write ${join(outside, 'made-up-tool')}`);
    expect(atTag(w)).toBe('v1.0.0');
    // The release's own file, executable, that could not be run all the same.
    writeFileSync(join(w.bin, 'noexec'), '#!/usr/bin/env bash\necho "$0: line 2: ./scripts/upgrade.sh: Permission denied" >&2\nexit 126\n', { mode: 0o755 });
    const run2 = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'noexec') }, ['stable']);
    expect(run2.status, run2.stdout + run2.stderr).toBe(5);
    expect(atTag(w)).toBe('v1.0.0');
    // A redirection it could not write, outside the release.
    chmodSync(outside, 0o555);
    try {
      writeFileSync(join(w.bin, 'redirect'), `#!/usr/bin/env bash\necho made-up > ${JSON.stringify(join(outside, 'made-up-state'))}\n`, { mode: 0o755 });
      const run3 = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'redirect') }, ['stable']);
      expect(run3.status, run3.stdout + run3.stderr).toBe(5);
      expect(run3.stdout).toContain(`This user could not write ${join(outside, 'made-up-state')}`);
    } finally { chmodSync(outside, 0o755); }
    expect(atTag(w)).toBe('v1.0.0');
  });

  it('with no step log beside the lock (a folder that takes no new file), the path a permission names is still said', () => {
    const w = world();
    writeFileSync(join(w.bin, 'df'), plenty, { mode: 0o755 });
    writeFileSync(join(w.bin, 'mktemp'), `#!/usr/bin/env bash\ncase "$*" in *.step.*) echo "mktemp: failed to create file via template '$1': Permission denied" >&2; exit 1 ;; esac\nexec ${JSON.stringify(REAL_MKTEMP)} "$@"\n`, { mode: 0o755 });
    const cache = join(w.home, '.npm', '_cacache');
    writeFileSync(join(w.bin, 'write-install'), `#!/bin/sh\necho "npm error code EACCES" >&2\necho "npm error Error: EACCES: permission denied, open '${cache}/index-v5/made-up'" >&2\nexit 1\n`, { mode: 0o755 });
    const r = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'write-install'), TMPDIR: join(w.home, 'tmp') }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(5);
    expect(r.stdout).toContain(`This user could not write ${cache}/index-v5/made-up`);
    expect(atTag(w)).toBe('v1.0.0');
    // And the one it made in TMPDIR instead is gone.
    expect(readdirSync(join(w.home, 'tmp')).filter((f) => f.startsWith('hatchabot-step.'))).toEqual([]);
  });
});

describe('the thirteenth review: the channel that changed while the timer waited is routine to the timer', () => {
  const REAL_MKDIR = execFileSync('bash', ['-c', 'command -v mkdir'], { encoding: 'utf8' }).trim();
  const atTag = (w: World) => w.git(w.install, 'describe', '--tags', '--exact-match');

  it('the timer\'s tick for v1.1.0 (2 tries) finds the owner pinned meanwhile: v1.1.0\'s record and the release set aside are left as they were', () => {
    const w = world();
    // The channel timer beside upgrade.sh, as an install has it (kept out of git status).
    for (const f of ['follow-channel.sh', 'follow-tries.sh', 'systemd-quote.sh']) writeFileSync(join(w.install, 'scripts', f), readFileSync(join('scripts', f)), { mode: 0o755 });
    writeFileSync(join(w.install, '.git', 'info', 'exclude'), 'scripts/follow-channel.sh\nscripts/follow-tries.sh\nscripts/systemd-quote.sh\n');
    const pin = join(w.install, 'data', 'channel');
    mkdirSync(join(w.install, 'data'), { recursive: true });
    writeFileSync(pin, 'stable\n');
    const key = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', w.install], { encoding: 'utf8' }).trim();
    const state = join(w.home, '.local', 'state', 'hatchabot'); mkdirSync(state, { recursive: true });
    const tries = join(state, `follow-channel-tries-${key}`), failed = join(state, `follow-channel-failed-${key}`);
    writeFileSync(tries, 'v1.1.0 2 0\n'); // two failed tries, the wait long over
    writeFileSync(failed, 'v0.9.0\n'); // an earlier release set aside
    // The owner's pin lands just as the timer's run reaches for the lock.
    writeFileSync(join(w.bin, 'mkdir'), `#!/usr/bin/env bash
case "$1" in *.lock.d) printf 'v1.0.0\\n' > ${JSON.stringify(pin)} ;; esac
exec ${JSON.stringify(REAL_MKDIR)} "$@"
`, { mode: 0o755 });
    const r = spawnSync('bash', [join(w.install, 'scripts', 'follow-channel.sh'), 'stable'], {
      encoding: 'utf8', env: { ...w.env, HATCHABOT_RESTART_CMD: join(w.bin, 'fake-restart'), HATCHABOT_UPGRADE_IMAGE: '0', HATCHABOT_INSTALL_CMD: 'true' },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('The channel changed while this waited: this machine now follows v1.0.0, not stable, so nothing was changed.');
    expect(atTag(w)).toBe('v1.0.0');
    expect(readFileSync(pin, 'utf8')).toBe('v1.0.0\n');
    expect(readFileSync(tries, 'utf8')).toBe('v1.1.0 2 0\n');
    expect(readFileSync(failed, 'utf8')).toBe('v0.9.0\n');
    expect(restarted(w)).toBe(0);
  });
});

describe('the fourteenth review: a write refused outside the install is the release\'s; a bare run_step; only the messages in English', () => {
  const plenty = '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/made-up 100000000 1000000 99000000 1% /"\n';
  const atTag = (w: World) => w.git(w.install, 'describe', '--tags', '--exact-match');

  it('a denied write is judged by its path: in this install\'s own places (npm\'s cache in HOME) the machine\'s (5), in /usr/local the release\'s own (3)', () => {
    const w = world();
    writeFileSync(join(w.bin, 'df'), plenty, { mode: 0o755 });
    const denied = (path: string) => `#!/bin/sh\necho "npm error code EACCES" >&2\necho "npm error Error: EACCES: permission denied, mkdir '${path}'" >&2\nexit 1\n`;
    writeFileSync(join(w.bin, 'global-install'), denied('/usr/local/lib/node_modules/made-up-module'), { mode: 0o755 });
    const out = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'global-install') }, ['stable']);
    expect(out.status, out.stdout + out.stderr).toBe(3);
    expect(out.stdout).not.toContain('could not write');
    expect(atTag(w)).toBe('v1.0.0');
    for (const own of [join(w.home, '.npm', '_cacache', 'made-up'), join(w.install, 'node_modules', 'made-up-module'), join(w.home, '.local', 'state', 'hatchabot', 'made-up')]) {
      writeFileSync(join(w.bin, 'own-install'), denied(own), { mode: 0o755 });
      const mine = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'own-install') }, ['stable']);
      expect(mine.status, own + ': ' + mine.stdout + mine.stderr).toBe(5);
      expect(mine.stdout).toContain(`This user could not write ${own}`);
      expect(atTag(w)).toBe('v1.0.0');
    }
  });

  it('a run_step not in a condition, under set -euo pipefail, whose step said something and succeeded, goes on', () => {
    const text = readFileSync('scripts/upgrade-helpers.sh', 'utf8');
    const def = (name: string) => {
      const at = text.indexOf(`${name}() {`); expect(at, name).toBeGreaterThanOrEqual(0);
      const line = text.slice(at, text.indexOf('\n', at));
      return /\}\s*$/.test(line) ? line : text.slice(at, text.indexOf('\n}\n', at) + 2);
    };
    const defs = ['disk_words', 'said_path', 'own_place', 'said_kind', 'step_tee', 'step_tail', 'run_step'].map(def).join('\n');
    const script = `set -euo pipefail\n${defs}\nSTEP_LOG=""; DIR="$PWD"\nrun_step sh -c 'echo "made-up warning" >&2; exit 0'\necho "after: $STEP_SAID"\nrun_step sh -c 'exit 3'\necho "not reached"\n`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', cwd: tmpdir(), env: scriptEnv(tmpdir(), '/usr/bin:/bin') });
    expect(r.stdout).toContain('after: own');
    expect(r.stderr).toContain('made-up warning');
    // A step that failed still ends it, as any command does under set -e.
    expect(r.stdout).not.toContain('not reached');
    expect(r.status).toBe(3);
  });

  it('the install keeps the user\'s locale but its messages are English: LC_ALL cleared, LC_MESSAGES=C, the user\'s LC_ALL as LANG', () => {
    const w = world();
    writeFileSync(join(w.bin, 'df'), plenty, { mode: 0o755 });
    const seen = join(w.root, 'install-locale.txt');
    writeFileSync(join(w.bin, 'locale-install'), `#!/bin/sh\necho "all=[\${LC_ALL-unset}] messages=[\${LC_MESSAGES-unset}] lang=[\${LANG-unset}]" > ${JSON.stringify(seen)}\nexit 0\n`, { mode: 0o755 });
    const r = run(w, { LANG: 'C.UTF-8', LC_ALL: 'de_DE.UTF-8', HATCHABOT_INSTALL_CMD: join(w.bin, 'locale-install') }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(seen, 'utf8').trim()).toBe('all=[] messages=[C] lang=[de_DE.UTF-8]');
    expect(atTag(w)).toBe('v1.1.0');
  });
});

describe('the fifteenth review: a warning decides nothing; a path in double quotes; the step\'s own failure outranks a permission line that names no place', () => {
  const plenty = '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/made-up 100000000 1000000 99000000 1% /"\n';
  const atTag = (w: World) => w.git(w.install, 'describe', '--tags', '--exact-match');
  const install = (w: World, said: string[]) => writeFileSync(join(w.bin, 'said-install'),
    ['#!/bin/sh', ...said.map((l) => `echo ${JSON.stringify(l).replace(/\$/g, '\\$')} >&2`), 'exit 1', ''].join('\n'), { mode: 0o755 });

  it('gyp\'s WARN EACCES for its dev dir, in a failing build\'s last lines, counts against the release (3): the dev dir in double quotes, elsewhere or in this HOME', () => {
    const w = world();
    writeFileSync(join(w.bin, 'df'), plenty, { mode: 0o755 });
    for (const devDir of ['/root/.cache/node-gyp/22.0.0', join(w.home, '.cache', 'node-gyp', '22.0.0')]) {
      install(w, [
        `gyp WARN EACCES current user ("u") does not have permission to access the dev dir "${devDir}"`,
        "../src/made_up.cc:10:3: error: 'made_up_symbol' was not declared in this scope",
        'make: *** [made_up.target.mk:12: Release/obj.target/made_up.o] Error 1',
        'gyp ERR! build error',
        'npm error code 1',
      ]);
      const r = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'said-install') }, ['stable']);
      expect(r.status, devDir + ': ' + r.stdout + r.stderr).toBe(3);
      expect(r.stdout).not.toContain('could not write');
      expect(r.stderr).toContain('does not have permission to access the dev dir');
      expect(atTag(w)).toBe('v1.0.0');
    }
  });

  it('a permission line that names no place: the machine\'s alone (5), the release\'s beside its own words of failure (3)', () => {
    const w = world();
    writeFileSync(join(w.bin, 'df'), plenty, { mode: 0o755 });
    install(w, ['npm error code EACCES', 'npm error errno -13']);
    expect(run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'said-install') }, ['stable']).status).toBe(5);
    install(w, ['made-up-tool: EACCES', 'gyp ERR! build error', 'npm error code 1']);
    const own = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'said-install') }, ['stable']);
    expect(own.status, own.stdout + own.stderr).toBe(3);
    expect(atTag(w)).toBe('v1.0.0');
  });

  it('a path in double quotes is read: in this install\'s own places the machine\'s, named (5); in /usr/local the release\'s (3)', () => {
    const w = world();
    writeFileSync(join(w.bin, 'df'), plenty, { mode: 0o755 });
    const cache = join(w.home, '.npm', '_cacache', 'made-up');
    install(w, [`made-up-tool: EACCES: permission denied, open "${cache}"`]);
    const mine = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'said-install') }, ['stable']);
    expect(mine.status, mine.stdout + mine.stderr).toBe(5);
    expect(mine.stdout).toContain(`This user could not write ${cache}`);
    install(w, ['made-up-tool: EACCES: permission denied, open "/usr/local/lib/made-up"']);
    const out = run(w, { HATCHABOT_INSTALL_CMD: join(w.bin, 'said-install') }, ['stable']);
    expect(out.status, out.stdout + out.stderr).toBe(3);
    expect(atTag(w)).toBe('v1.0.0');
  });
});

describe('scripts/upgrade.sh writes a rollback down beside the database, for the next start (HB-0840)', () => {
  const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/;
  const markOf = (w: World, db = join(w.install, 'data', 'hatchabot.sqlite')) => `${db}.rolled-back`;
  /**
   * A restart that says whether the note was there when it ran, and tells the
   * record what restart.sh tells it once the service manager has restarted the
   * service (`started`, or `back` on a restart back); FAKE_EARLY=1 fails before
   * that, as restart.sh does when ensure-deps fails. FAKE_RESTART_RC is the
   * restart onto the new release's, FAKE_BACK_RC the restart back's. Asked
   * only whether it serves (HATCHABOT_RESTART_PROBE), it restarts nothing,
   * logs `probe`, and serves only with FAKE_PROBE_RC=0.
   */
  const restartSeeing = (w: World, mark: string) => writeFileSync(join(w.bin, 'fake-restart'), [
    '#!/usr/bin/env bash',
    `if [ -n "\${HATCHABOT_RESTART_PROBE:-}" ]; then echo probe >> ${JSON.stringify(w.restarts)}; exit "\${FAKE_PROBE_RC:-1}"; fi`,
    `if [ -e ${JSON.stringify(mark)} ]; then echo "restart marked"; else echo "restart unmarked"; fi >> ${JSON.stringify(w.restarts)}`,
    'if [ -n "${HATCHABOT_RESTART_BACK:-}" ]; then line=back rc="${FAKE_BACK_RC:-0}"; else line=started rc="${FAKE_RESTART_RC:-0}"; [ -z "${FAKE_EARLY:-}" ] || exit 1; fi',
    '[ -z "${HATCHABOT_RESTART_RECORD:-}" ] || [ ! -f "$HATCHABOT_RESTART_RECORD" ] || echo "$line" >> "$HATCHABOT_RESTART_RECORD"',
    'exit "$rc"', ''].join('\n'), { mode: 0o755 });
  const recordOf = (w: World) => lockOf(w).replace(/\.lock\.d$/, '.from');
  const restarts = (w: World) => (existsSync(w.restarts) ? readFileSync(w.restarts, 'utf8').split('\n').filter(Boolean) : []);

  it('a release that does not come up: the time goes beside the database before the old release is restarted', () => {
    const w = world(); mkdirSync(join(w.install, 'data'));
    restartSeeing(w, markOf(w));
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true', FAKE_RESTART_RC: '1' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    expect(restarts(w)).toEqual(['restart unmarked', 'restart marked']);
    expect(readFileSync(markOf(w), 'utf8')).toMatch(TIME);
    expect(Math.abs(Date.parse(readFileSync(markOf(w), 'utf8').trim()) - Date.now())).toBeLessThan(120_000);
  });

  it('an upgrade that comes up writes nothing', () => {
    const w = world(); mkdirSync(join(w.install, 'data'));
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(markOf(w))).toBe(false);
  });

  it('naming an older release is a rollback too: written before the restart onto it', () => {
    const w = world(); mkdirSync(join(w.install, 'data'));
    w.git(w.install, 'checkout', '-q', 'v1.1.0');
    restartSeeing(w, markOf(w));
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true' }, ['v1.0.0']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    expect(restarts(w)).toEqual(['restart marked']);
    expect(readFileSync(markOf(w), 'utf8')).toMatch(TIME);
  });

  it('a database .env puts elsewhere has its note beside it, .env read as systemd reads it: spacing, quotes, a " # ..." kept as part of the value, an escaped space (review of HB-0840)', () => {
    const cases: Array<[string, (root: string) => string, (root: string) => string]> = [
      // systemd keeps what follows the quotes, the comment too: that is the database the service opens.
      ['spaced, quoted, a comment after', (root) => `HATCHABOT_DB = "${join(root, 'elsewhere', 'hb.sqlite')}"  # moved`, (root) => `${join(root, 'elsewhere', 'hb.sqlite')}# moved`],
      ['an escaped space', (root) => `HATCHABOT_DB=${join(root, 'My\\ Data', 'hb.sqlite')}`, (root) => join(root, 'My Data', 'hb.sqlite')],
      ['the name from before the rename', (root) => `AGENTCLAW_DB='${join(root, 'elsewhere', 'ac.sqlite')}'`, (root) => join(root, 'elsewhere', 'ac.sqlite')],
    ];
    for (const [what, line, db] of cases) {
      const w = world();
      symlinkSync(process.execPath, join(w.bin, 'node')); // env_named reads .env with node, as the service's own does
      mkdirSync(join(w.root, 'elsewhere')); mkdirSync(join(w.root, 'My Data'));
      restartSeeing(w, markOf(w, db(w.root)));
      writeFileSync(join(w.install, '.git', 'info', 'exclude'), '.env\n');
      writeFileSync(join(w.install, '.env'), `HATCHABOT_SECRET_KEY=made-up\n${line(w.root)}\n`);
      const r = run(w, { HATCHABOT_INSTALL_CMD: 'true', FAKE_RESTART_RC: '1' }, ['stable']);
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(restarts(w), what).toEqual(['restart unmarked', 'restart marked']);
      expect(readFileSync(markOf(w, db(w.root)), 'utf8'), what).toMatch(TIME);
      expect(existsSync(markOf(w)), what).toBe(false);
    }
  });

  it('the folder of the database .env names is not there: said, not passed over in silence (review of HB-0840)', () => {
    const w = world();
    symlinkSync(process.execPath, join(w.bin, 'node'));
    restartSeeing(w, markOf(w));
    writeFileSync(join(w.install, '.git', 'info', 'exclude'), '.env\n');
    const db = join(w.root, 'gone', 'hb.sqlite');
    writeFileSync(join(w.install, '.env'), `HATCHABOT_SECRET_KEY=made-up\nHATCHABOT_DB=${db}\n`);
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true', FAKE_RESTART_RC: '1' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain(`The folder of the database .env names (${db}) is not there, so this rollback was not written down beside it: the next start may take up what the release left had still to do for its agents.`);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
  });

  it('one cut off once the new release was started: the repair writes it before restarting the release it puts back', () => {
    for (const rec of ['says-started\nrestarted\nstarted\n', 'restarted\n' /* an upgrade.sh of v2.191.0 and older: read as it was */]) {
      const w = world(); mkdirSync(join(w.install, 'data'));
      w.git(w.install, 'checkout', '-q', 'v1.1.0');
      const record = recordOf(w); mkdirSync(dirname(record), { recursive: true });
      writeFileSync(record, `from v1.0.0\nto v1.1.0\npins-recorded\n${rec}`);
      restartSeeing(w, markOf(w));
      const r = run(w, { HATCHABOT_INSTALL_CMD: 'false' }, ['stable']);
      expect(r.stdout).toContain('was cut off part-way — putting v1.0.0 back first');
      expect(restarts(w)[0], rec).toBe('restart marked');
      expect(readFileSync(markOf(w), 'utf8')).toMatch(TIME);
    }
  });

  it('a rollback whose restart back did not answer in time, then the repair: asked first, a release serving since is not restarted, and nothing more is written (review of HB-0840, HB-1456)', () => {
    const w = world(); mkdirSync(join(w.install, 'data'));
    restartSeeing(w, markOf(w));
    const first = run(w, { HATCHABOT_INSTALL_CMD: 'true', FAKE_RESTART_RC: '1', FAKE_BACK_RC: '1' }, ['stable']);
    expect(first.status, first.stdout + first.stderr).toBe(1);
    // Said as the bundle's and the deploy's say it: the record, and that the next run restarts it (no "Then run").
    expect(first.stdout).toContain(`v1.0.0 is back in ${w.install}, but it did not come up (above). ${recordOf(w)} stays: the next upgrade restarts it again if it is still not serving (1 of 3).`);
    expect(first.stdout).not.toContain('Then run');
    expect(restarts(w)).toEqual(['restart unmarked', 'restart marked']);
    expect(readFileSync(recordOf(w), 'utf8')).toMatch(/\nrestarted\nstarted\n(git .*\n)*back\ntries 1\n$/); // the rollback's checkout writes its git between
    // The old release came up after all, took the note at its start, and has
    // kept holds of its own since: the timer's repair asks, and leaves it serving.
    rmSync(markOf(w));
    const repair = run(w, { HATCHABOT_UPGRADE_REPAIR_ONLY: '1', FAKE_PROBE_RC: '0' }, ['stable']);
    expect(repair.status, repair.stdout + repair.stderr).toBe(0);
    expect(repair.stdout).toContain(`v1.0.0 was put back in ${w.install} by an earlier run, whose restart of it did not come up or was cut off.`);
    expect(repair.stdout).toContain(`v1.0.0 is back in ${w.install} and serving now, so ${recordOf(w)} is removed.`);
    expect(restarts(w)).toEqual(['restart unmarked', 'restart marked', 'probe']);
    expect(existsSync(markOf(w))).toBe(false);
    expect(existsSync(recordOf(w))).toBe(false);
  });

  it('a release put back that does not come up stops no upgrade to another: restarted once more, then the upgrade goes on, its record in the place of the kept one (review of HB-1456)', () => {
    const w = world(); mkdirSync(join(w.install, 'data'));
    restartSeeing(w, markOf(w));
    expect(run(w, { HATCHABOT_INSTALL_CMD: 'true', FAKE_RESTART_RC: '1', FAKE_BACK_RC: '1' }, ['stable']).status).toBe(1);
    // v1.1.0 comes up now (a step v1.0.0 cannot run on, say); v1.0.0 still does not.
    const next = run(w, { HATCHABOT_INSTALL_CMD: 'true', FAKE_BACK_RC: '1' }, ['stable']);
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(next.stdout).toContain(`${recordOf(w)} stays: the next upgrade restarts it again if it is still not serving (2 of 3).`);
    expect(next.stdout).toContain(`Going on to v1.1.0, which may come up where v1.0.0 does not: this upgrade's own record has taken the place of ${recordOf(w)}.`);
    expect(next.stdout).toContain('Now on v1.1.0.');
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.1.0');
    expect(restarts(w).slice(2)).toEqual(['probe', 'restart marked', 'restart marked']);
    expect(existsSync(recordOf(w))).toBe(false);
  });

  it('one that goes on and goes back before restarting anything (an install that fails) leaves the kept record as it was (review of HB-1456)', () => {
    const w = world(); mkdirSync(join(w.install, 'data'));
    restartSeeing(w, markOf(w));
    expect(run(w, { HATCHABOT_INSTALL_CMD: 'true', FAKE_RESTART_RC: '1', FAKE_BACK_RC: '1' }, ['stable']).status).toBe(1);
    const next = run(w, { HATCHABOT_INSTALL_CMD: 'false', FAKE_BACK_RC: '1' }, ['stable']);
    expect(next.status, next.stdout + next.stderr).toBe(3);
    expect(next.stdout).toContain(`${recordOf(w)} stays for the next run: v1.0.0 is still not up.`);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    expect(readFileSync(recordOf(w), 'utf8')).toMatch(/\nback\ntries 1\n(git .*\n)*back\ntries 2\n$/);
  });

  it('a restart back that keeps not coming up is given up after three, said with the record and how to clear it, and asked about, not restarted, after (review of HB-1456)', () => {
    const w = world(); mkdirSync(join(w.install, 'data'));
    restartSeeing(w, markOf(w));
    expect(run(w, { HATCHABOT_INSTALL_CMD: 'true', FAKE_RESTART_RC: '1', FAKE_BACK_RC: '1' }, ['stable']).status).toBe(1);
    const repair = (extra: Record<string, string> = {}) => run(w, { HATCHABOT_UPGRADE_REPAIR_ONLY: '1', FAKE_BACK_RC: '1', ...extra }, ['stable']);
    const given = `v1.0.0 is back in ${w.install}, but it has not come up after 3 tries to restart it, so upgrades stop restarting it (a rollback to it from another release still does). Once what stops it is fixed (hatchabot doctor), remove the record and restart it: rm "${recordOf(w)}"; ${w.install}/scripts/restart.sh`;
    const two = repair();
    expect(two.status, two.stdout + two.stderr).toBe(6);
    expect(two.stdout).toContain('(2 of 3)');
    const three = repair();
    expect(three.status, three.stdout + three.stderr).toBe(6);
    expect(three.stdout).toContain(given);
    const before = restarts(w).length;
    const four = repair();
    expect(four.status, four.stdout + four.stderr).toBe(6);
    expect(four.stdout).toContain(given);
    expect(restarts(w).slice(before)).toEqual(['probe']);
    // Up once more (by hand, or on its own): asked, and the record goes.
    const up = repair({ FAKE_PROBE_RC: '0' });
    expect(up.status, up.stdout + up.stderr).toBe(0);
    expect(existsSync(recordOf(w))).toBe(false);
  });

  it('a pin a killed run left stays through a repair whose restart back does not come up, and the release pinned, named again, is gone on to (review of HB-1456)', () => {
    const w = world(); mkdirSync(join(w.install, 'data'));
    // As upgrade.sh reads it: this install's file, else the user's (where a release from before v2.169.0 is pinned).
    const channel = () => [join(w.install, 'data', 'channel'), join(w.home, '.config', 'hatchabot', 'channel')].filter((f) => existsSync(f)).map((f) => readFileSync(f, 'utf8').trim())[0];
    writeFileSync(join(w.install, 'data', 'channel'), 'stable\n');
    // `hatchabot upgrade v1.1.0`, killed at its restart (a power cut).
    writeFileSync(join(w.bin, 'killed-restart'), '#!/usr/bin/env bash\nkill -9 "$PPID"\nexit 1\n', { mode: 0o755 });
    expect(run(w, { HATCHABOT_INSTALL_CMD: 'true', HATCHABOT_RESTART_CMD: join(w.bin, 'killed-restart') }, ['v1.1.0']).signal).toBe('SIGKILL');
    expect(channel()).toBe('v1.1.0');
    restartSeeing(w, markOf(w));
    // The timer's repair, with no network; v1.0.0 put back does not come up.
    const repair = run(w, { HATCHABOT_UPGRADE_REPAIR_ONLY: '1', HATCHABOT_UPGRADE_BY_TIMER: '1', FAKE_BACK_RC: '1' }, ['v1.1.0']);
    expect(repair.status, repair.stdout + repair.stderr).toBe(6);
    expect(repair.stdout).not.toContain('Not pinned');
    expect(channel()).toBe('v1.1.0');
    const named = run(w, { HATCHABOT_INSTALL_CMD: 'true', FAKE_BACK_RC: '1' }, ['v1.1.0']);
    expect(named.status, named.stdout + named.stderr).toBe(0);
    expect(named.stdout).toContain('Now on v1.1.0.');
    expect(named.stdout).not.toContain('Not pinned');
    expect(channel()).toBe('v1.1.0');
  });

  it('the release put back, named by hand while it is not up: pinned, as "Already on" pins it, and 6, so the timer leaves it there (review of HB-1456)', () => {
    const w = world(); mkdirSync(join(w.install, 'data'));
    const channel = () => [join(w.install, 'data', 'channel'), join(w.home, '.config', 'hatchabot', 'channel')].filter((f) => existsSync(f)).map((f) => readFileSync(f, 'utf8').trim())[0];
    restartSeeing(w, markOf(w));
    expect(run(w, { HATCHABOT_INSTALL_CMD: 'true', FAKE_RESTART_RC: '1', FAKE_BACK_RC: '1' }, ['stable']).status).toBe(1);
    expect(channel()).toBe('stable');
    // `hatchabot upgrade v1.0.0`: the release put back, which still does not come up.
    const named = run(w, { HATCHABOT_INSTALL_CMD: 'true', FAKE_BACK_RC: '1' }, ['v1.0.0']);
    expect(named.status, named.stdout + named.stderr).toBe(6);
    expect(named.stdout).toContain('(2 of 3)');
    expect(named.stdout).toContain('Pinned to v1.0.0');
    expect(named.stdout).not.toContain('Going on');
    expect(channel()).toBe('v1.0.0');
    expect(existsSync(lockOf(w).replace(/\.lock\.d$/, '.pin'))).toBe(false); // the pin is complete: no record of what it replaced
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    expect(readFileSync(recordOf(w), 'utf8')).toMatch(/\ntries 2\n(git .*\n)*$/);
  });

  it('a note the rollback of an older release named wrote, once that release had started, is not taken back by the repair after it (review of HB-1456)', () => {
    const KEPT = '2026-11-01T10:00:00Z\n';
    const w = world(); mkdirSync(join(w.install, 'data'));
    w.git(w.install, 'checkout', '-q', 'v1.1.0');
    writeFileSync(markOf(w), KEPT);
    restartSeeing(w, markOf(w));
    // v1.0.0 named: it starts, and does not come up; v1.1.0's restart back does not either.
    const back = run(w, { HATCHABOT_INSTALL_CMD: 'true', FAKE_RESTART_RC: '1', FAKE_BACK_RC: '1' }, ['v1.0.0']);
    expect(back.status, back.stdout + back.stderr).toBe(1);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.1.0');
    const rollback = readFileSync(markOf(w), 'utf8');
    expect(rollback).toMatch(TIME);
    expect(rollback).not.toBe(KEPT);
    expect(existsSync(`${markOf(w)}.prev`)).toBe(false);
    // The timer's repair: v1.1.0 comes up now, and the rollback's note stays.
    const repair = run(w, { HATCHABOT_UPGRADE_REPAIR_ONLY: '1' }, ['stable']);
    expect(repair.status, repair.stdout + repair.stderr).toBe(0);
    expect(readFileSync(markOf(w), 'utf8')).toBe(rollback);
    expect(existsSync(recordOf(w))).toBe(false);
  });

  it('a repair whose restart back does not come up keeps its record and says 6 (nothing more to do), so the next run asks, restarts it again, and writes no note over what the old release kept since (HB-1456)', () => {
    const w = world(); mkdirSync(join(w.install, 'data'));
    w.git(w.install, 'checkout', '-q', 'v1.1.0');
    const record = recordOf(w); mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, 'from v1.0.0\nto v1.1.0\npins-recorded\nsays-started\nrestarted\nstarted\n'); // cut off once v1.1.0 was started
    restartSeeing(w, markOf(w));
    const first = run(w, { HATCHABOT_UPGRADE_REPAIR_ONLY: '1', FAKE_BACK_RC: '1' }, ['stable']);
    expect(first.status, first.stdout + first.stderr).toBe(6);
    expect(first.stdout).toContain('was cut off part-way — putting v1.0.0 back first');
    expect(first.stdout).toContain(`v1.0.0 is back in ${w.install}, but it did not come up (above). ${record} stays: the next upgrade restarts it again if it is still not serving (1 of 3).`);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    expect(restarts(w)).toEqual(['restart marked']);
    expect(readFileSync(record, 'utf8')).toMatch(/\nstarted\n(git .*\n)*back\ntries 1\n$/); // the service manager restarted it back
    // v1.0.0 took the note at its start, and has kept holds of its own since; still not serving, it is restarted again.
    rmSync(markOf(w));
    const again = run(w, { HATCHABOT_UPGRADE_REPAIR_ONLY: '1' }, ['stable']);
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toContain(`v1.0.0 was put back in ${w.install} by an earlier run, whose restart of it did not come up or was cut off.`);
    expect(restarts(w)).toEqual(['restart marked', 'probe', 'restart unmarked']);
    expect(existsSync(markOf(w))).toBe(false);
    expect(existsSync(record)).toBe(false);
  });

  it('a restart that failed before the service manager restarted anything (ensure-deps): the old release never stopped, and nothing is written (review of HB-0840)', () => {
    const w = world(); mkdirSync(join(w.install, 'data'));
    restartSeeing(w, markOf(w));
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true', FAKE_EARLY: '1' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    expect(restarts(w)).toEqual(['restart unmarked', 'restart unmarked']);
    expect(existsSync(markOf(w))).toBe(false);
    // An older release named, whose restart failed the same way: the note
    // written before it goes, as the release gone back to never stopped.
    const v = world(); mkdirSync(join(v.install, 'data'));
    v.git(v.install, 'checkout', '-q', 'v1.1.0');
    restartSeeing(v, markOf(v));
    const back = run(v, { HATCHABOT_INSTALL_CMD: 'true', FAKE_EARLY: '1' }, ['v1.0.0']);
    expect(back.status, back.stdout + back.stderr).toBe(1);
    expect(v.git(v.install, 'describe', '--tags', '--exact-match')).toBe('v1.1.0');
    expect(restarts(v)).toEqual(['restart marked', 'restart unmarked']);
    expect(existsSync(markOf(v))).toBe(false);
  });

  it('an older release named that never starts: the note there before is put back, as it was, not removed; a .prev an earlier run left is never put back (HB-1455)', () => {
    // A note kept for a later release's holds, or after a drop the database refused: an old time, and an old file.
    const KEPT = '2026-11-01T10:00:00Z\n', old = new Date('2026-11-01T10:00:00Z');
    const v = world(); mkdirSync(join(v.install, 'data'));
    v.git(v.install, 'checkout', '-q', 'v1.1.0');
    writeFileSync(markOf(v), KEPT); utimesSync(markOf(v), old, old);
    restartSeeing(v, markOf(v));
    const back = run(v, { HATCHABOT_INSTALL_CMD: 'true', FAKE_EARLY: '1' }, ['v1.0.0']);
    expect(back.status, back.stdout + back.stderr).toBe(1);
    expect(v.git(v.install, 'describe', '--tags', '--exact-match')).toBe('v1.1.0');
    expect(readFileSync(markOf(v), 'utf8')).toBe(KEPT);
    expect(statSync(markOf(v)).mtimeMs).toBe(old.getTime());
    expect(existsSync(`${markOf(v)}.prev`)).toBe(false);
    // One that starts: this run's note stands (its time later), and the earlier one is in it.
    const up = run(v, { HATCHABOT_INSTALL_CMD: 'true' }, ['v1.0.0']);
    expect(up.status, up.stdout + up.stderr).toBe(0);
    expect(readFileSync(markOf(v), 'utf8')).toMatch(TIME);
    expect(readFileSync(markOf(v), 'utf8')).not.toBe(KEPT);
    // A .prev an earlier run left, with no note now: not put back for a run whose release never starts.
    const w = world(); mkdirSync(join(w.install, 'data'));
    w.git(w.install, 'checkout', '-q', 'v1.1.0');
    writeFileSync(`${markOf(w)}.prev`, KEPT);
    restartSeeing(w, markOf(w));
    expect(run(w, { HATCHABOT_INSTALL_CMD: 'true', FAKE_EARLY: '1' }, ['v1.0.0']).status).toBe(1);
    expect(existsSync(markOf(w))).toBe(false);
    expect(existsSync(`${markOf(w)}.prev`)).toBe(false);
  });

  it('cut off after the note for an older release named, before that release started: the repair puts the note there before back, and a repair tried again leaves it (HB-1455)', () => {
    const KEPT = '2026-11-01T10:00:00Z\n';
    for (const before of [KEPT, undefined]) {
      const w = world(); mkdirSync(join(w.install, 'data'));
      w.git(w.install, 'checkout', '-q', 'v1.1.0');
      if (before) writeFileSync(markOf(w), before);
      // The restart onto v1.0.0 is killed with the upgrade before the service manager is asked (a power cut, the unit stopped).
      writeFileSync(join(w.bin, 'killed-restart'), '#!/usr/bin/env bash\nkill -9 "$PPID"\nexit 1\n', { mode: 0o755 });
      const cut = run(w, { HATCHABOT_INSTALL_CMD: 'true', HATCHABOT_RESTART_CMD: join(w.bin, 'killed-restart') }, ['v1.0.0']);
      expect(cut.signal, cut.stdout + cut.stderr).toBe('SIGKILL');
      expect(readFileSync(recordOf(w), 'utf8')).toMatch(/\nrestarted\nnoted \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/);
      expect(readFileSync(markOf(w), 'utf8')).toMatch(TIME); // this run's
      // The timer's repair: v1.1.0 back, its restart not answering in time (the record stays, HB-1456).
      restartSeeing(w, markOf(w));
      const repair = run(w, { HATCHABOT_UPGRADE_REPAIR_ONLY: '1', FAKE_BACK_RC: '1' }, ['stable']);
      expect(repair.status, repair.stdout + repair.stderr).toBe(6);
      expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.1.0');
      const now = () => (existsSync(markOf(w)) ? readFileSync(markOf(w), 'utf8') : undefined);
      expect(now(), String(before)).toBe(before);
      expect(restarts(w)).toEqual([before ? 'restart marked' : 'restart unmarked']);
      // Tried again, it comes up: what was put back stays.
      const again = run(w, { HATCHABOT_UPGRADE_REPAIR_ONLY: '1' }, ['stable']);
      expect(again.status, again.stdout + again.stderr).toBe(0);
      expect(now(), String(before)).toBe(before);
      expect(existsSync(recordOf(w))).toBe(false);
    }
  });

  it('a note it cannot write is said, and never stops the rollback', () => {
    const w = world(); mkdirSync(join(w.install, 'data'));
    restartSeeing(w, markOf(w));
    mkdirSync(`${markOf(w)}.tmp`); // where it is written first: a folder, so nothing can be
    const from = Math.floor(Date.now() / 1000) * 1000;
    const r = run(w, { HATCHABOT_INSTALL_CMD: 'true', FAKE_RESTART_RC: '1' }, ['stable']);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain(`Could not write ${markOf(w)} (a full disk?), so the next start may take up what the release left had still to do for its agents.`);
    // The advice writes the rollback's own time, not the time it is typed (review of HB-0840).
    const advice = r.stdout.match(/Once there is room: printf '%s\\n' (\S+) > "(.+)"\n/);
    expect(advice?.[2], r.stdout).toBe(markOf(w));
    expect(Date.parse(advice![1]!)).toBeGreaterThanOrEqual(from);
    expect(Date.parse(advice![1]!)).toBeLessThanOrEqual(Date.now());
    expect(w.git(w.install, 'describe', '--tags', '--exact-match')).toBe('v1.0.0');
    expect(restarts(w)).toHaveLength(2);
  });
});
