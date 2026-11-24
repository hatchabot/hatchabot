import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

// Every test here runs real shell scripts (git, bash, a fake gh) in a sandbox. On the
// self-hosted runner CI shares the machine with other work, and vitest's 5 s was not
// enough under load (land, promote, release, first-run-link; 2026-10-23).
vi.setConfig({ testTimeout: 30_000 });

/**
 * The smaller script findings of the 2026-10-09 review, each in a sandbox: a
 * temp HOME, a PATH of shims and the system dirs, an environment built from
 * scratch. Nothing here reaches Docker, systemd or the network.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const shim = (bin: string, name: string, body: string) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });

describe('scripts/sqlite-driver.sh', () => {
  it('writes its build log to a file of its own, never through a name someone made first in /tmp', () => {
    const root = temp('hb-sqlite-');
    const home = join(root, 'home'), bin = join(root, 'bin'), tmp = join(root, 'tmp'), app = join(root, 'app');
    for (const d of [home, bin, tmp, join(app, 'scripts'), join(app, 'node_modules', 'better-sqlite3')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(app, 'scripts', 'sqlite-driver.sh'), readFileSync('scripts/sqlite-driver.sh'), { mode: 0o755 });
    const npmRoot = join(root, 'npm-global');
    mkdirSync(join(npmRoot, 'npm', 'node_modules', 'node-gyp', 'bin'), { recursive: true });
    writeFileSync(join(npmRoot, 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'), '');
    shim(bin, 'npm', `[ "$1 $2" = "root -g" ] && echo ${JSON.stringify(npmRoot)}`);
    shim(bin, 'node', 'echo "gyp ERR! simulated compile failure" >&2; exit 1');
    // What another user on a shared host could have left at the old fixed name.
    const victim = join(root, 'victim.txt'); writeFileSync(victim, 'mine');
    symlinkSync(victim, join(tmp, 'hatchabot-sqlite-build.log'));
    const r = spawnSync('bash', [join(app, 'scripts', 'sqlite-driver.sh'), '--compile'], { encoding: 'utf8', env: scriptEnv(home, `${bin}:/usr/bin:/bin`, { TMPDIR: tmp }) });
    expect(r.status).toBe(1);
    expect(readFileSync(victim, 'utf8')).toBe('mine');
    const log = /see (\S+) \(make/.exec(r.stderr)?.[1];
    expect(log, r.stderr).toBeTruthy();
    expect(log).not.toBe(join(tmp, 'hatchabot-sqlite-build.log'));
    expect(readFileSync(log!, 'utf8')).toContain('simulated compile failure');
  });
});

describe('scripts/build-runtime-image.sh', () => {
  it('a rebuild under an existing tag that fails its version check gives the tag back to the previous image', () => {
    const root = temp('hb-image-');
    const home = join(root, 'home'), bin = join(root, 'bin'), app = join(root, 'app');
    for (const d of [home, bin, join(app, 'scripts'), join(app, 'docker')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(app, 'scripts', 'build-runtime-image.sh'), readFileSync('scripts/build-runtime-image.sh'), { mode: 0o755 });
    writeFileSync(join(app, 'scripts', 'runtime-pins.mjs'), readFileSync('scripts/runtime-pins.mjs'));
    writeFileSync(join(app, 'docker', 'Dockerfile.runtime'), readFileSync('docker/Dockerfile.runtime'));
    symlinkSync(process.execPath, join(bin, 'node'));
    const log = join(root, 'docker.log'), built = join(root, 'built');
    // The tag names sha256:0ld until the build moves it to sha256:new; the new image runs the wrong OpenClaw.
    shim(bin, 'docker', `echo "docker $*" >> ${JSON.stringify(log)}
case "$1 $2" in
  "image inspect") [ -f ${JSON.stringify(built)} ] && echo sha256:new || echo sha256:0ld ;;
  "build "*|build*) touch ${JSON.stringify(built)} ;;
  "run --rm") echo "OpenClaw 1999.1.1" ;;
esac
exit 0`);
    const r = spawnSync('bash', [join(app, 'scripts', 'build-runtime-image.sh')], {
      encoding: 'utf8', env: scriptEnv(home, `${bin}:/usr/bin:/bin`, { BUILD_LOCAL: '1', NO_LATEST: '1', IMAGE_TAG: 'test-tag' }),
    });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('docker rmi hatchabot-runtime:test-tag');
    expect(calls).toContain('docker tag sha256:0ld hatchabot-runtime:test-tag');
    expect(calls.indexOf('docker rmi')).toBeLessThan(calls.indexOf('docker tag sha256:0ld'));
  });
});

describe('scripts/migrate-rename-host.sh', () => {
  it.each([false, true])('writes env files privately and bounds health requests (timeout=%s, HB-0623)', (timeout) => {
    const root = temp('hb-migrate-');
    const home = join(root, 'home'), bin = join(root, 'bin');
    for (const d of [home, bin]) mkdirSync(d, { recursive: true });
    const env = scriptEnv(home, `${bin}:/usr/bin:/bin`);
    // The new release, at a tag, in a local origin.
    const src = join(root, 'src'); mkdirSync(join(src, 'deploy'), { recursive: true });
    writeFileSync(join(src, 'package.json'), '{"name":"x","version":"1.1.0"}\n');
    writeFileSync(join(src, 'deploy', 'hatchabot.service'), '[Service]\nWorkingDirectory=__HATCHABOT_DIR__\n');
    const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    git(src, 'init', '-q', '-b', 'main'); git(src, 'add', '-A'); git(src, 'commit', '-q', '-m', 'v1'); git(src, 'tag', 'v1.1.0');
    // The old AgentClaw install.
    const old = join(home, 'agentclaw'); mkdirSync(join(old, 'data'), { recursive: true });
    writeFileSync(join(old, '.env'), 'AGENTCLAW_SECRET_KEY=made-up-key\nPORT=8080\n');
    writeFileSync(join(old, 'data', 'agentclaw.sqlite'), 'db');
    mkdirSync(join(home, '.config', 'agentclaw'), { recursive: true });
    writeFileSync(join(home, '.config', 'agentclaw', 'env'), 'AGENTCLAW_URL=http://127.0.0.1:8080\n');
    const modes = join(root, 'modes.log');
    for (const t of ['docker', 'npm']) shim(bin, t, 'exit 0');
    // As systemd answers: "inactive" for a unit it does not have.
    shim(bin, 'systemctl', 'case "$*" in *"show -p ActiveState"*) echo inactive ;; esac\nexit 0');
    shim(bin, 'uname', 'echo Linux');
    shim(bin, 'curl', `case " $* " in *" --connect-timeout 3 --max-time 5 "*) ;; *) exit 99 ;; esac\necho 'HATCHABOT_VERSION="1.1.0"'\nexit ${timeout ? 28 : 0}`);
    shim(bin, 'sleep', 'exit 0');
    symlinkSync(process.execPath, join(bin, 'node'));
    // chmod notes each file's mode as it was BEFORE the chmod.
    shim(bin, 'chmod', `for a in "$@"; do [ -f "$a" ] && echo "$a $(stat -c %a "$a")" >> ${JSON.stringify(modes)}; done\nexec /bin/chmod "$@"`);
    const r = spawnSync('bash', ['-c', 'umask 022; exec bash "$@"', '_', 'scripts/migrate-rename-host.sh', 'v1.1.0', '--yes', '--old', old], {
      encoding: 'utf8', timeout: 60_000, env: { ...env, HATCHABOT_REPO: src },
    });
    expect(r.status, r.stdout + r.stderr).toBe(timeout ? 1 : 0);
    if (timeout) {
      expect(r.stdout).toMatch(/health checks.*timed out \(5 seconds per request\)/);
      expect(r.stdout).not.toContain('serving Hatchabot 1.1.0');
    }
    const seen = readFileSync(modes, 'utf8').split('\n').filter((l) => /\/(\.env|env)\s/.test(l));
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const l of seen) expect(l, l).toMatch(/ 600$/);
    expect(existsSync(join(home, 'hatchabot-prod', '.env'))).toBe(true);
    expect(readdirSync(join(home, 'hatchabot-data'))).toContain('hatchabot.sqlite');
  });

  /**
   * An old AgentClaw install and a local origin at v1.1.0, in a sandbox: a
   * temp HOME, shims for systemctl, docker, npm, curl and sleep (systemctl's
   * calls noted in `calls`; by default it answers as systemd does for units
   * it does not have, "inactive"), git with no hooks.
   */
  function legacy(systemctl = 'case "$*" in *"show -p ActiveState"*) echo inactive ;; esac\nexit 0', oldEnv = 'AGENTCLAW_SECRET_KEY=made-up-old-key\nPORT=8080\n') {
    const root = temp('hb-migrate-');
    const home = join(root, 'home'), bin = join(root, 'bin');
    for (const d of [home, bin]) mkdirSync(d, { recursive: true });
    const env = scriptEnv(home, `${bin}:/usr/bin:/bin`);
    const src = join(root, 'src'); mkdirSync(join(src, 'deploy'), { recursive: true });
    writeFileSync(join(src, 'package.json'), '{"name":"x","version":"1.1.0"}\n');
    writeFileSync(join(src, 'deploy', 'hatchabot.service'), '[Service]\nWorkingDirectory=__HATCHABOT_DIR__\n');
    const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    git(src, 'init', '-q', '-b', 'main'); git(src, 'add', '-A'); git(src, 'commit', '-q', '-m', 'v1'); git(src, 'tag', 'v1.1.0');
    const old = join(home, 'agentclaw'); mkdirSync(join(old, 'data'), { recursive: true });
    writeFileSync(join(old, '.env'), oldEnv);
    writeFileSync(join(old, 'data', 'agentclaw.sqlite'), 'old-db');
    writeFileSync(join(old, 'data', 'agentclaw.sqlite-wal'), 'old-wal');
    const calls = join(root, 'calls.log');
    shim(bin, 'systemctl', `echo "systemctl $*" >> ${JSON.stringify(calls)}\n${systemctl}`);
    for (const t of ['docker', 'npm']) shim(bin, t, `echo "${t} $*" >> ${JSON.stringify(calls)}`);
    shim(bin, 'uname', 'echo Linux');
    // The new service answers unless `down` is there (a connection refused).
    const down = join(root, 'down');
    shim(bin, 'curl', `[ -e ${JSON.stringify(down)} ] && exit 7\necho 'HATCHABOT_VERSION="1.1.0"'`);
    shim(bin, 'sleep', 'exit 0');
    symlinkSync(process.execPath, join(bin, 'node'));
    const serving = (yes: boolean) => (yes ? rmSync(down, { force: true }) : writeFileSync(down, ''));
    const run = () => spawnSync('bash', ['scripts/migrate-rename-host.sh', 'v1.1.0', '--yes', '--old', old], { encoding: 'utf8', timeout: 60_000, env: { ...env, HATCHABOT_REPO: src } });
    const called = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '');
    return { home, old, src, run, called, git, serving };
  }

  it('a control plane still running after the stop: nothing is moved and the new service is not started (HB-1072)', () => {
    // The stop fails, and the old service is still up.
    const t = legacy(`case "$*" in
  *"show -p ActiveState --value agentclaw.service"*) echo active ;;
  *"show -p ActiveState"*) echo inactive ;;
  *" stop "*) exit 1 ;;
esac
exit 0`);
    const r = t.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/agentclaw\.service is still active after the stop — nothing was moved and the new service was not started/);
    // Its database, WAL and all, is where it was, a file and not a link.
    expect(readFileSync(join(t.old, 'data', 'agentclaw.sqlite'), 'utf8')).toBe('old-db');
    expect(readFileSync(join(t.old, 'data', 'agentclaw.sqlite-wal'), 'utf8')).toBe('old-wal');
    expect(existsSync(join(t.home, 'hatchabot-data', 'hatchabot.sqlite'))).toBe(false);
    expect(t.called()).not.toMatch(/enable --now hatchabot/);
    // It stopped before writing an env file of this install's at the destination (HB-1072 review).
    expect(existsSync(join(t.home, 'hatchabot-prod', '.env'))).toBe(false);
    // And says how to start what its stop did stop (review of HB-1072).
    expect(r.stdout).toContain('This run stopped what it could of AgentClaw (step 3) and does not start it again. To run AgentClaw until this is sorted out: systemctl --user start agentclaw.service agentclaw-backup.timer');
  });

  it('a systemd that cannot be asked (su or sudo -u: no session bus) is refused before anything changes (HB-1072 review)', () => {
    // Every call fails, as systemctl --user does with no session to reach.
    const t = legacy('echo "Failed to connect to bus: No medium found" >&2\nexit 1');
    const r = t.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('systemd could not be asked whether agentclaw.service is running (systemctl --user show failed or said nothing) — nothing was changed.');
    expect(r.stdout).toContain("Run this as the user the AgentClaw service runs as, in that user's own login session, not through su or sudo -u");
    expect(readFileSync(join(t.old, 'data', 'agentclaw.sqlite'), 'utf8')).toBe('old-db');
    expect(existsSync(join(t.home, 'hatchabot-data'))).toBe(false);
    expect(existsSync(join(t.home, 'hatchabot-prod'))).toBe(false);
    // Asked, and nothing else: no tag, no package, no stop.
    expect(t.called().split('\n').filter(Boolean).every((l) => l.startsWith('systemctl --user show -p ActiveState'))).toBe(true);
    expect(r.stdout).not.toContain('systemctl --user start'); // nothing was stopped, so nothing to start again
  });

  it('a backup of AgentClaw running is refused before anything is stopped (review of HB-1072)', () => {
    const t = legacy(`case "$*" in
  *"show -p ActiveState --value agentclaw-backup.service"*) echo activating ;;
  *"show -p ActiveState"*) echo inactive ;;
esac
exit 0`);
    const r = t.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('   A backup of AgentClaw is running (agentclaw-backup.service is activating) — nothing was changed: it reads the database this would move.');
    expect(r.stdout).toContain('   Let it finish (systemctl --user status agentclaw-backup.service says when it has), then run this again.');
    expect(t.called().split('\n').filter(Boolean).every((l) => l.startsWith('systemctl --user show -p ActiveState'))).toBe(true);
    expect(readFileSync(join(t.old, 'data', 'agentclaw.sqlite'), 'utf8')).toBe('old-db');
    expect(existsSync(join(t.home, 'hatchabot-prod'))).toBe(false);
  });

  it.each([
    ['empty', () => ''],
    ['naming only the database', (old: string) => `AGENTCLAW_DB=${join(old, 'data', 'agentclaw.sqlite')}\n`],
  ])('an old .env %s migrates whole: the env file is written and the database moves (review of HB-1072)', (_what, oldEnv) => {
    const t = legacy();
    writeFileSync(join(t.old, '.env'), oldEnv(t.old));
    const r = t.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(join(t.home, 'hatchabot-prod', '.env'), 'utf8')).toBe(`HATCHABOT_DB=${join(t.home, 'hatchabot-data', 'hatchabot.sqlite')}\n`);
    expect(readFileSync(join(t.home, 'hatchabot-data', 'hatchabot.sqlite'), 'utf8')).toBe('old-db');
    expect(t.called()).toMatch(/enable --now hatchabot\.service/);
  });

  it('a run that fails after the stop says how to start AgentClaw again, and leaves no part-written .env (review of HB-1072)', () => {
    const t = legacy();
    const units = join(t.home, '.config', 'systemd', 'user'); mkdirSync(units, { recursive: true });
    writeFileSync(join(units, 'agentclaw-mgmt-bot.service'), '[Service]\n');
    // The rename of the finished .env fails, as on a disk that just filled.
    const bin = join(t.home, '..', 'bin');
    shim(bin, 'mv', 'case "$*" in */hatchabot-prod/.env) echo "mv: cannot move: No space left on device" >&2; exit 1 ;; esac\nexec /bin/mv "$@"');
    const r = t.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('   This run stopped what it could of AgentClaw (step 3) and does not start it again. To run AgentClaw until this is sorted out: systemctl --user start agentclaw.service agentclaw-backup.timer agentclaw-mgmt-bot.service');
    const prod = join(t.home, 'hatchabot-prod');
    expect(readdirSync(prod).filter((f) => f.startsWith('.env'))).toEqual([]); // neither .env nor its temp
    expect(readFileSync(join(t.old, 'data', 'agentclaw.sqlite'), 'utf8')).toBe('old-db');
    expect(t.called()).toMatch(/systemctl --user stop/);
    expect(t.called()).not.toMatch(/enable --now hatchabot/);
    // Once the disk has room again, the same command finishes the move.
    rmSync(join(bin, 'mv'));
    const again = t.run();
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).not.toContain('systemctl --user start');
  });

  it.each([
    ['running', 'active', 'Do not start AgentClaw again: hatchabot.service is active, on the moved database, and the two would run the same agents.'],
    ['starting again', 'activating', 'Do not start AgentClaw again yet: hatchabot.service is activating and may be starting on the moved database, and the two would run the same agents.'],
    ['stopped after a failed start', 'failed', undefined],
  ])('a start of the new units that fails part way, the new service %s: it says to start AgentClaw again only when that is safe (HB-1237)', (_what, state, dont) => {
    // The service starts, its backup timer does not.
    const t = legacy(`case "$*" in
  *"show -p ActiveState --value hatchabot.service"*) echo ${state} ;;
  *"show -p ActiveState"*) echo inactive ;;
  *"enable --now hatchabot.service hatchabot-backup.timer"*) echo "Failed to start hatchabot-backup.timer" >&2; exit 1 ;;
esac
exit 0`);
    const r = t.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(readFileSync(join(t.home, 'hatchabot-data', 'hatchabot.sqlite'), 'utf8')).toBe('old-db');
    const start = 'To run AgentClaw until this is sorted out: systemctl --user start agentclaw.service agentclaw-backup.timer';
    if (!dont) {
      expect(r.stdout).toContain(start);
      expect(r.stdout).not.toContain('Do not start AgentClaw');
    } else {
      expect(r.stdout).not.toContain(start);
      expect(r.stdout).toContain(`   ${dont}`);
      // Never "serves": one that cannot boot reads active or activating between its tries (review of HB-1237).
      expect(r.stdout).not.toContain('serves the moved database');
      expect(r.stdout).toContain('   To go back to AgentClaw instead: systemctl --user disable --now hatchabot.service hatchabot-backup.timer, then systemctl --user start agentclaw.service agentclaw-backup.timer');
    }
  });

  it.each([
    // systemd answers before the stop, not after it: the run stops before it moves anything.
    ['systemd stops answering after the stop', `case "$*" in
  *" stop "*) touch "$HOME/stopped" ;;
  *"show -p ActiveState"*) [ -e "$HOME/stopped" ] && exit 1; echo inactive ;;
esac
exit 0`, () => {}],
    // A hatchabot.service of another install's runs; this run fails writing its .env, before any move.
    ['a hatchabot.service runs that this run did not start', `case "$*" in
  *"show -p ActiveState --value hatchabot.service"*) echo active ;;
  *"show -p ActiveState"*) echo inactive ;;
esac
exit 0`, (bin: string) => shim(bin, 'mv', 'case "$*" in */hatchabot-prod/.env) echo "mv: cannot move: No space left on device" >&2; exit 1 ;; esac\nexec /bin/mv "$@"')],
  ])('a run that ends before it moved the database or started anything, %s: AgentClaw may start again (review of HB-1237)', (_what, systemctl, prepare) => {
    const t = legacy(systemctl);
    prepare(join(t.home, '..', 'bin'));
    const r = t.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(readFileSync(join(t.old, 'data', 'agentclaw.sqlite'), 'utf8')).toBe('old-db');
    expect(existsSync(join(t.home, 'hatchabot-data', 'hatchabot.sqlite'))).toBe(false);
    expect(r.stdout).toContain('To run AgentClaw until this is sorted out: systemctl --user start agentclaw.service agentclaw-backup.timer');
    expect(r.stdout).not.toContain('Do not start AgentClaw');
  });

  it('a run that ends between moving the database and linking its old path says to link it before AgentClaw starts (review of HB-1237)', () => {
    const t = legacy(`case "$*" in
  *"show -p ActiveState"*) echo inactive ;;
esac
exit 0`);
    shim(join(t.home, '..', 'bin'), 'ln', 'case "$*" in *agentclaw.sqlite) echo "ln: failed to create symbolic link: Input/output error" >&2; exit 1 ;; esac\nexec /bin/ln "$@"');
    const r = t.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    const moved = join(t.home, 'hatchabot-data', 'hatchabot.sqlite'), old = join(t.old, 'data', 'agentclaw.sqlite');
    expect(readFileSync(moved, 'utf8')).toBe('old-db');
    expect(existsSync(old)).toBe(false);
    expect(r.stdout).toContain(`   AgentClaw's database is at ${moved} now, and its old path does not lead there yet. Before starting AgentClaw, or running this again: ln -s "${moved}" "${old}"`);
    expect(r.stdout.indexOf('its old path does not lead there')).toBeLessThan(r.stdout.indexOf('systemctl --user start agentclaw.service'));
    // Linked as it says, a run again passes its checks and goes on.
    symlinkSync(moved, old);
    rmSync(join(t.home, '..', 'bin', 'ln'));
    const again = t.run();
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(readFileSync(moved, 'utf8')).toBe('old-db');
  });

  it('a show that answers nothing is not taken for "not there" either (HB-1072 review)', () => {
    const t = legacy('exit 0');
    const r = t.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/systemd could not be asked whether agentclaw\.service is running/);
    expect(readFileSync(join(t.old, 'data', 'agentclaw.sqlite'), 'utf8')).toBe('old-db');
  });

  it('old units that are stopped, or not there, are no reason to stop: the database moves (HB-1072)', () => {
    // stop fails for units that are not loaded (exit 5); their state reads inactive.
    const t = legacy(`case "$*" in
  *"show -p ActiveState"*) echo inactive ;;
  *" stop "*) exit 5 ;;
esac
exit 0`);
    const r = t.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(join(t.home, 'hatchabot-data', 'hatchabot.sqlite'), 'utf8')).toBe('old-db');
    expect(readFileSync(join(t.home, 'hatchabot-data', 'hatchabot.sqlite-wal'), 'utf8')).toBe('old-wal');
    expect(t.called()).toMatch(/enable --now hatchabot\.service/);
  });

  it('another Hatchabot install where it would go: refused before anything changes, its key and database kept (HB-1073)', () => {
    const t = legacy();
    const prod = join(t.home, 'hatchabot-prod'), data = join(t.home, 'hatchabot-data');
    // A working checkout of its own, as an install there has.
    t.git(t.home, 'clone', '-q', t.src, prod); mkdirSync(data, { recursive: true });
    const theirs = 'HATCHABOT_SECRET_KEY=made-up-other-key\nHATCHABOT_DB=' + join(data, 'hatchabot.sqlite') + '\n';
    writeFileSync(join(prod, '.env'), theirs);
    writeFileSync(join(data, 'hatchabot.sqlite'), 'other-db');
    const r = t.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/hatchabot-prod\/\.env belongs to another Hatchabot install: its HATCHABOT_SECRET_KEY is not this AgentClaw install's — nothing was changed/);
    expect(readFileSync(join(prod, '.env'), 'utf8')).toBe(theirs);
    expect(readFileSync(join(data, 'hatchabot.sqlite'), 'utf8')).toBe('other-db');
    expect(readFileSync(join(t.old, 'data', 'agentclaw.sqlite'), 'utf8')).toBe('old-db');
    // Not a tag, a package, or a unit touched.
    expect(t.called()).toBe('');
  });

  it('another install\'s database where its database would go, with no checkout: refused too (HB-1073)', () => {
    const t = legacy();
    mkdirSync(join(t.home, 'hatchabot-data'), { recursive: true });
    writeFileSync(join(t.home, 'hatchabot-data', 'hatchabot.sqlite'), 'other-db');
    const r = t.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/hatchabot\.sqlite is another install's database, not .*agentclaw\.sqlite moved there by an earlier run — nothing was changed/);
    expect(existsSync(join(t.home, 'hatchabot-prod'))).toBe(false);
    expect(readFileSync(join(t.home, 'hatchabot-data', 'hatchabot.sqlite'), 'utf8')).toBe('other-db');
    expect(t.called()).toBe('');
  });

  it('a backups folder of another install where its backups would go: refused, neither moved (HB-1073)', () => {
    const t = legacy();
    mkdirSync(join(t.home, 'agentclaw-backups', '2026-10-01'), { recursive: true });
    mkdirSync(join(t.home, 'hatchabot-backups', '2026-11-01'), { recursive: true });
    const r = t.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/hatchabot-backups is there already/);
    expect(readdirSync(join(t.home, 'hatchabot-backups'))).toEqual(['2026-11-01']);
    expect(t.called()).toBe('');
  });

  it('a link where its backups would go that leads nowhere: refused before anything changes (review of HB-1116)', () => {
    const t = legacy();
    mkdirSync(join(t.home, 'agentclaw-backups', '2026-10-01'), { recursive: true });
    symlinkSync(join(t.home, 'gone-backups'), join(t.home, 'hatchabot-backups'));
    const r = t.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/hatchabot-backups is there already/);
    expect(readlinkSync(join(t.home, 'hatchabot-backups'))).toBe(join(t.home, 'gone-backups'));
    expect(readdirSync(join(t.home, 'agentclaw-backups'))).toEqual(['2026-10-01']);
    expect(readFileSync(join(t.old, 'data', 'agentclaw.sqlite'), 'utf8')).toBe('old-db');
    expect(existsSync(join(t.home, 'hatchabot-data'))).toBe(false);
    expect(t.called()).toBe('');
  });

  it.each([
    ['no key line (the key set in the old unit)', 'PORT=8080\n'],
    ['the key written as export', 'export AGENTCLAW_SECRET_KEY=made-up-old-key\nPORT=8080\n'],
  ])('a re-run after a run that stopped past the env files is its own, with %s (HB-1073 review)', (_what, oldEnv) => {
    const t = legacy(undefined, oldEnv);
    t.serving(false);
    const first = t.run();
    expect(first.status, first.stdout + first.stderr).toBe(1);
    expect(first.stdout).toContain('not serving 1.1.0 yet');
    expect(existsSync(join(t.home, 'hatchabot-prod', '.env'))).toBe(true);
    t.serving(true);
    const again = t.run();
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toContain('serving Hatchabot 1.1.0');
  });

  it('a .env there that is not what it writes, with no key in the old .env to tell by: its own message, nothing changed (HB-1073 review)', () => {
    const t = legacy(undefined, 'PORT=8080\n');
    const prod = join(t.home, 'hatchabot-prod');
    t.git(t.home, 'clone', '-q', t.src, prod);
    writeFileSync(join(prod, '.env'), 'HATCHABOT_SECRET_KEY=made-up-other-key\nPORT=9090\n');
    const r = t.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain(`${prod}/.env is there and is not what this migration writes from ${t.old}/.env, which has no AGENTCLAW_SECRET_KEY= line to tell by whose it is — nothing was changed.`);
    expect(r.stdout).toContain(`If it is this install's, from an earlier run, move it aside (mv ${prod}/.env ${prod}/.env.before) and run this again.`);
    expect(readFileSync(join(prod, '.env'), 'utf8')).toBe('HATCHABOT_SECRET_KEY=made-up-other-key\nPORT=9090\n');
    expect(t.called()).toBe('');
  });

  it('running it again after it finished is still fine: what is there is its own (HB-1073)', () => {
    const t = legacy();
    const first = t.run();
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const again = t.run();
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(readFileSync(join(t.home, 'hatchabot-data', 'hatchabot.sqlite'), 'utf8')).toBe('old-db');
    expect(readFileSync(join(t.home, 'hatchabot-prod', '.env'), 'utf8')).toMatch(/^HATCHABOT_SECRET_KEY=made-up-old-key$/m);
  });
});
