import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { scriptEnv } from './helpers/scriptEnv.js';

// Every test here runs real shell scripts (git, bash, a fake gh) in a sandbox. On the
// self-hosted runner CI shares the machine with other work, and vitest's 5 s was not
// enough under load (land, promote, release, first-run-link; 2026-10-23).
vi.setConfig({ testTimeout: 30_000 });

/**
 * scripts/uninstall.sh in a sandbox: systemctl, docker, npm and launchctl are
 * shims on PATH that only record what they were asked, HOME is a temp dir with
 * the CLI's env and channel pin, the "install" is a temp dir with an .env and
 * a database. What the 30th audit asked for: --purge refuses when the database
 * is there but cannot be read (it would orphan every volume), and the user's
 * CLI token and channel pin survive a plain uninstall.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function world() {
  const root = mkdtempSync(join(tmpdir(), 'hb-uninstall-')); dirs.push(root);
  const home = join(root, 'home'); mkdirSync(join(home, '.config', 'hatchabot'), { recursive: true });
  writeFileSync(join(home, '.config', 'hatchabot', 'env'), 'HATCHABOT_URL=http://127.0.0.1:8080\nHATCHABOT_TOKEN=fake-cli-token\n');
  writeFileSync(join(home, '.config', 'hatchabot', 'channel'), 'stable\n');
  const repo = join(root, 'install'); mkdirSync(join(repo, 'scripts'), { recursive: true }); mkdirSync(join(repo, 'data'));
  for (const f of ['uninstall.sh', 'backup-owner.sh']) writeFileSync(join(repo, 'scripts', f), readFileSync(join('scripts', f)), { mode: 0o755 });
  writeFileSync(join(repo, '.env'), 'HATCHABOT_SECRET_KEY=x\n');
  writeFileSync(join(repo, 'data', 'hatchabot.sqlite'), 'not really a database');
  const bin = join(root, 'bin'); mkdirSync(bin);
  const log = join(root, 'calls.log');
  for (const tool of ['systemctl', 'docker', 'npm', 'launchctl']) {
    writeFileSync(join(bin, tool), `#!/usr/bin/env bash\necho "${tool} $*" >> ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
  }
  // The script reads the database with node. Only node itself joins the shims —
  // not its directory, which can hold a real `hbt` (see the PATH note below);
  // on GitHub's runner node is not in /usr/bin at all.
  symlinkSync(process.execPath, join(bin, 'node'));
  return { home, repo, bin, log };
}
const run = (w: ReturnType<typeof world>, args: string[], extra: Record<string, string> = {}) =>
  spawnSync('bash', [join(w.repo, 'scripts', 'uninstall.sh'), ...args], {
    // A minimal PATH: the script removes the `hbt` shim it finds on PATH, and with the
    // user's PATH it removed the machine's real one (2026-09-27). Only the shims and the system dirs.
    // Built from scratch, never from process.env: a HATCHABOT_DB exported in the
    // shell running the tests reached the script, and --purge removed THAT
    // data directory (review, 2026-10-09).
    encoding: 'utf8', env: scriptEnv(w.home, `${w.bin}:/usr/bin:/bin`, extra),
  });

/** A purge-able install: a real database naming two agents, and the module to read it. */
function purgeWorld() {
  const w = world();
  rmSync(join(w.repo, 'data', 'hatchabot.sqlite'));
  const db = new Database(join(w.repo, 'data', 'hatchabot.sqlite'));
  db.exec('CREATE TABLE agents (id TEXT, runtime_ref TEXT, image TEXT)');
  db.prepare('INSERT INTO agents VALUES (?, ?, NULL)').run('11111111-aaaa', 'docker://hatchabot-leaky-11111111');
  db.prepare('INSERT INTO agents VALUES (?, ?, NULL)').run('22222222-bbbb', 'docker://hatchabot-stuck-22222222');
  db.close();
  const modules = dirname(dirname(createRequire(import.meta.url).resolve('better-sqlite3/package.json')));
  symlinkSync(modules, join(w.repo, 'node_modules'));
  // docker: each agent's volume exists; the leaky one is held by a never-
  // started one-shot (removable), the stuck one's rm is refused regardless.
  writeFileSync(join(w.bin, 'docker'), `#!/usr/bin/env bash
echo "docker $*" >> ${JSON.stringify(w.log)}
case "$1 $2" in
  "volume ls") for a in "$@"; do case "$a" in name=*) n="\${a#name=^}"; echo "\${n%\$}" ;; esac; done ;;
  "volume rm") if [ "$3" = hatchabot-stuck-22222222-vol ]; then echo "Error response from daemon: remove $3: volume is in use - [feedc0de]" >&2; exit 1; fi ;;
  "ps -aq") case "$*" in *volume=hatchabot-leaky-11111111-vol*status=created*) echo leak111 ;; esac ;;
esac
exit 0
`, { mode: 0o755 });
  return w;
}

describe('scripts/uninstall.sh', () => {
  it('--purge removes a leaked one-shot holding a volume, and names a volume it could not remove (review, 2026-09-29)', () => {
    const w = purgeWorld();
    const r = run(w, ['--purge', '--yes']);
    const calls = readFileSync(w.log, 'utf8');
    expect(calls).toContain('docker rm -f leak111');
    expect(calls).toContain('docker volume rm hatchabot-leaky-11111111-vol');
    expect(calls.indexOf('docker rm -f leak111')).toBeLessThan(calls.indexOf('docker volume rm hatchabot-leaky-11111111-vol'));
    expect(r.stdout).toContain('could NOT remove volume hatchabot-stuck-22222222-vol: Error response from daemon');
    expect(r.stdout).toContain('removed 1 volumes');
    expect(r.stdout).toMatch(/these agent volumes are NOT[\s\S]*hatchabot-stuck-22222222-vol/);
    expect(r.stdout).not.toContain('Its agents, volumes and database are gone.');
    expect(r.status, r.stdout + r.stderr).toBe(1);
  });


  it('--purge refuses when the database is there but its reader is not installed', () => {
    const w = world();
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stdout).toMatch(/Cannot read the database/);
    expect(existsSync(join(w.repo, 'data', 'hatchabot.sqlite'))).toBe(true);
    expect(existsSync(w.log)).toBe(false); // nothing was stopped or removed
  });

  it('without --purge the user\'s CLI token and channel pin stay; the service is stopped, not the data', () => {
    const w = world();
    const r = run(w, ['--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(w.home, '.config', 'hatchabot', 'env'))).toBe(true);
    expect(existsSync(join(w.home, '.config', 'hatchabot', 'channel'))).toBe(true);
    expect(existsSync(join(w.repo, 'data', 'hatchabot.sqlite'))).toBe(true);
    const calls = readFileSync(w.log, 'utf8');
    expect(calls).not.toMatch(/docker (rm|volume rm|rmi)/);
  });
});

describe('scripts/uninstall.sh when Docker does not answer (audit #024)', () => {
  /** A docker whose every call fails as a stopped daemon's does — or only the calls `failing` matches. */
  const dockerDown = (w: ReturnType<typeof world>, failing = '*') => writeFileSync(join(w.bin, 'docker'), `#!/usr/bin/env bash
echo "docker $*" >> ${JSON.stringify(w.log)}
case "$*" in ${failing}) echo "Cannot connect to the Docker daemon. Is the docker daemon running?" >&2; exit 1 ;; esac
exit 0
`, { mode: 0o755 });

  it('--purge refuses before it does anything: the database and .env are the only map to the agents', () => {
    const w = purgeWorld();
    dockerDown(w);
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stdout).toContain('Docker is not answering');
    expect(r.stdout).not.toContain('Its agents, volumes and database are gone');
    expect(existsSync(join(w.repo, 'data', 'hatchabot.sqlite'))).toBe(true);
    expect(existsSync(join(w.repo, '.env'))).toBe(true);
    expect(readFileSync(w.log, 'utf8').trim().split('\n')).toEqual(['docker info']); // no service, CLI or agent was touched
  });

  it('a daemon that stops answering part-way: the database and .env are kept, and it says so, exit 1', () => {
    const w = purgeWorld();
    dockerDown(w, '"volume ls"*');
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('Docker stopped answering part-way');
    expect(existsSync(join(w.repo, 'data', 'hatchabot.sqlite'))).toBe(true);
    expect(existsSync(join(w.repo, '.env'))).toBe(true);
  });

  it('without --purge nothing is deleted anyway, but it says the agents were not stopped, exit 1', () => {
    const w = purgeWorld();
    dockerDown(w);
    const r = run(w, ['--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('could NOT ask Docker for this install\'s agents');
    expect(r.stdout).not.toContain('none running');
    expect(existsSync(join(w.repo, 'data', 'hatchabot.sqlite'))).toBe(true);
  });
});

describe('scripts/uninstall.sh removes nothing while the service may still run (audit #027)', () => {
  /** This install's service unit, and a systemctl whose stop fails; is-active answers `state`. */
  function failingStop(state: string) {
    const w = purgeWorld();
    dockerShim(w, VOLS);
    const units = join(w.home, '.config', 'systemd', 'user'); mkdirSync(units, { recursive: true });
    const unit = join(units, 'hatchabot.service'); writeFileSync(unit, `[Service]\nWorkingDirectory=${w.repo}\n`);
    writeFileSync(join(w.bin, 'systemctl'), `#!/usr/bin/env bash
echo "systemctl $*" >> ${JSON.stringify(w.log)}
case "$*" in
  *"disable --now hatchabot.service") echo "Failed to stop hatchabot.service: Transport endpoint is not connected" >&2; exit 1 ;;
  *"is-active hatchabot.service") echo ${JSON.stringify(state)}; [ ${JSON.stringify(state)} = active ] && exit 0; exit 3 ;;
esac
exit 0
`, { mode: 0o755 });
    return { w, unit, r: run(w, ['--purge', '--yes']) };
  }

  it('a service that did not stop keeps its unit, and the CLI, agents, database and .env are left alone, exit 1', () => {
    const { w, unit, r } = failingStop('active');
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('could NOT stop hatchabot.service');
    expect(r.stdout).not.toContain('no longer running');
    expect(existsSync(unit)).toBe(true);
    expect(existsSync(join(w.repo, 'data', 'hatchabot.sqlite'))).toBe(true);
    expect(existsSync(join(w.repo, '.env'))).toBe(true);
    expect(existsSync(join(w.home, '.config', 'hatchabot', 'env'))).toBe(true);
    expect(readFileSync(w.log, 'utf8')).not.toMatch(/docker (stop|rm|volume rm)|npm unlink/);
  });

  it('a failed disable whose service is stopped all the same goes on as usual', () => {
    const { w, unit, r } = failingStop('inactive');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(unit)).toBe(false);
    expect(existsSync(join(w.repo, 'data', 'hatchabot.sqlite'))).toBe(false);
  });

  it('on a Mac, a launchd job still listed after the unload is kept, and nothing else is touched', () => {
    const w = purgeWorld();
    dockerShim(w, VOLS);
    writeFileSync(join(w.bin, 'uname'), '#!/usr/bin/env bash\necho Darwin\n', { mode: 0o755 });
    writeFileSync(join(w.bin, 'launchctl'), `#!/usr/bin/env bash\necho "launchctl $*" >> ${JSON.stringify(w.log)}\n[ "$1" = unload ] && exit 5\nexit 0\n`, { mode: 0o755 });
    const agents = join(w.home, 'Library', 'LaunchAgents'); mkdirSync(agents, { recursive: true });
    const plist = join(agents, 'com.hatchabot.control-plane.plist');
    writeFileSync(plist, `<array><string>hatchabot</string><string>${w.repo}</string></array>\n`);
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('could NOT stop com.hatchabot.control-plane');
    expect(existsSync(plist)).toBe(true);
    expect(existsSync(join(w.repo, 'data', 'hatchabot.sqlite'))).toBe(true);
    expect(existsSync(join(w.repo, '.env'))).toBe(true);
  });
});

describe('scripts/uninstall.sh and agents on a runner (audit #037)', () => {
  /** This machine's agent, and one on a runner: a host with its own Docker endpoint. */
  function runnerWorld() {
    const w = world();
    rmSync(join(w.repo, 'data', 'hatchabot.sqlite'));
    const db = new Database(join(w.repo, 'data', 'hatchabot.sqlite'));
    db.exec('CREATE TABLE hosts (id TEXT, kind TEXT, name TEXT, settings TEXT); CREATE TABLE agents (id TEXT, name TEXT, host_id TEXT, runtime_ref TEXT, image TEXT)');
    db.prepare('INSERT INTO hosts VALUES (?, ?, ?, ?)').run('h-local', 'local', 'This machine', '{}');
    db.prepare('INSERT INTO hosts VALUES (?, ?, ?, ?)').run('h-runner', 'cloud', 'Garage box', JSON.stringify({ dockerHost: 'ssh://garage-box.example.test' }));
    db.prepare('INSERT INTO agents VALUES (?, ?, ?, ?, NULL)').run('11111111-aaaa', 'Meal Planner', 'h-local', 'docker://hatchabot-meal-planner-11111111');
    db.prepare('INSERT INTO agents VALUES (?, ?, ?, ?, NULL)').run('22222222-bbbb', 'Garden Notes', 'h-runner', 'docker://hatchabot-garden-notes-22222222');
    db.close();
    symlinkSync(dirname(dirname(createRequire(import.meta.url).resolve('better-sqlite3/package.json'))), join(w.repo, 'node_modules'));
    return w;
  }

  it('--purge refuses, naming the agent on the runner, and changes nothing', () => {
    const w = runnerWorld();
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stdout).toContain('These agents run on another machine (a runner)');
    expect(r.stdout).toContain('Garden Notes (on Garage box: ssh://garage-box.example.test)');
    expect(r.stdout).not.toContain('Meal Planner (on');
    expect(r.stdout).toContain('--forget-runners');
    expect(existsSync(join(w.repo, 'data', 'hatchabot.sqlite'))).toBe(true);
    expect(existsSync(join(w.repo, '.env'))).toBe(true);
    expect(existsSync(w.log)).toBe(false); // nothing was stopped or removed
  });

  it('--purge --forget-runners goes on, and says the runner\'s agent still runs there', () => {
    const w = runnerWorld();
    const r = run(w, ['--purge', '--forget-runners', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(w.repo, 'data', 'hatchabot.sqlite'))).toBe(false);
    expect(r.stdout).not.toContain('Its agents, volumes and database are gone.');
    expect(r.stdout).toMatch(/still run on their runners[\s\S]*Garden Notes \(on Garage box/);
  });

  it('without --purge: uninstalls, and says the runner\'s agent was not stopped', () => {
    const w = runnerWorld();
    const r = run(w, ['--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('runners:   1 agents on other machines');
    expect(r.stdout).toMatch(/NOT STOPPED[\s\S]*Garden Notes \(on Garage box/);
    expect(existsSync(join(w.repo, 'data', 'hatchabot.sqlite'))).toBe(true);
  });

  it('a database from before runners (no hosts table) purges as before', () => {
    const w = purgeWorld();
    const r = run(w, ['--purge', '--yes']);
    expect(r.stdout).not.toContain('another machine');
    expect(existsSync(join(w.repo, 'data', 'hatchabot.sqlite'))).toBe(false);
  });
});

/** A docker that logs every call and answers from `body` (a bash `case "$*"` body). */
function dockerShim(w: ReturnType<typeof world>, body: string) {
  writeFileSync(join(w.bin, 'docker'), `#!/usr/bin/env bash
echo "docker $*" >> ${JSON.stringify(w.log)}
case "$*" in
${body}
esac
exit 0
`, { mode: 0o755 });
}
/** Each agent's volume exists. */
const VOLS = '"volume ls"*) for a in "$@"; do case "$a" in name=*) n="${a#name=^}"; echo "${n%$}" ;; esac; done ;;';

describe('scripts/uninstall.sh acts on its own install (review, 2026-10-09)', () => {
  /** The service's install somewhere else, as the unit names it: its own data and .env. */
  function withProduction(w: ReturnType<typeof world>) {
    const prod = join(dirname(w.repo), 'prod'); mkdirSync(join(prod, 'data'), { recursive: true });
    writeFileSync(join(prod, '.env'), 'HATCHABOT_SECRET_KEY=y\n');
    writeFileSync(join(prod, 'data', 'hatchabot.sqlite'), 'production');
    mkdirSync(join(w.home, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(join(w.home, '.config', 'systemd', 'user', 'hatchabot.service'), `[Service]\nWorkingDirectory=${prod}\n`);
    return prod;
  }

  it('a service whose folder has a % in its name (the unit doubles it) is still found, and still refused from a clone (audit, 2026-10-29)', () => {
    const w = purgeWorld();
    const prod = join(dirname(w.repo), 'prod-%q'); mkdirSync(join(prod, 'data'), { recursive: true });
    writeFileSync(join(prod, 'data', 'hatchabot.sqlite'), 'production');
    mkdirSync(join(w.home, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(join(w.home, '.config', 'systemd', 'user', 'hatchabot.service'), `[Service]\nWorkingDirectory=${prod.replace(/%/g, '%%')}\n`);
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stdout).toContain(`The service runs from ${prod}, but this script is in ${w.repo}.`);
    expect(existsSync(join(prod, 'data', 'hatchabot.sqlite'))).toBe(true);
  });

  it('run from a clone the service does not run, it refuses and names both — production is untouched', () => {
    const w = purgeWorld();
    const prod = withProduction(w);
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stdout).toContain(`The service runs from ${prod}, but this script is in ${w.repo}.`);
    expect(r.stdout).toContain('--installed');
    expect(existsSync(join(prod, 'data', 'hatchabot.sqlite'))).toBe(true);
    expect(existsSync(join(prod, '.env'))).toBe(true);
    expect(existsSync(join(w.repo, 'data', 'hatchabot.sqlite'))).toBe(true);
    expect(existsSync(w.log)).toBe(false); // no service, container or volume was touched
  });

  it('--installed acts on the service\'s install, and only on it', () => {
    const w = world();
    const prod = withProduction(w);
    rmSync(join(prod, 'data', 'hatchabot.sqlite')); // no database: nothing to read, nothing to scope docker by
    const r = run(w, ['--purge', '--installed', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`acting on the install the service runs from, ${prod}`);
    expect(existsSync(join(prod, '.env'))).toBe(false);
    expect(existsSync(join(prod, 'data'))).toBe(false);
    expect(existsSync(join(w.repo, '.env'))).toBe(true); // the clone it ran from keeps its own
  });

  it('--installed --backups: a relative HATCHABOT_BACKUP_DIR is the service install\'s folder, not the clone\'s it ran from (audit #028)', () => {
    const w = world();
    const prod = withProduction(w);
    rmSync(join(prod, 'data', 'hatchabot.sqlite'));
    writeFileSync(join(prod, '.env'), 'HATCHABOT_SECRET_KEY=y\nHATCHABOT_BACKUP_DIR=backups\n');
    for (const dir of [prod, w.repo]) {
      const set = join(dir, 'backups', '2026-10-01'); mkdirSync(set, { recursive: true });
      writeFileSync(join(set, 'backup-status.json'), '{"state":"complete"}');
    }
    const r = run(w, ['--purge', '--installed', '--backups', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`removed 1 backup sets from ${join(prod, 'backups')}`);
    expect(existsSync(join(prod, 'backups', '2026-10-01'))).toBe(false);
    expect(existsSync(join(w.repo, 'backups', '2026-10-01', 'backup-status.json'))).toBe(true);
  });
});

describe('scripts/uninstall.sh on a pre-rename install (audit #026)', () => {
  /** This install's agent has a container; its volume exists (VOLS). */
  const leakyContainer = `${VOLS}
  "ps -aq --filter name=^/hatchabot-leaky-11111111$") echo c0ffee000011 ;;`;

  it('an AGENTCLAW_DB in .env is the database: its agents are removed, and the database with them', () => {
    const w = purgeWorld();
    dockerShim(w, leakyContainer);
    const legacy = join(dirname(w.repo), 'legacy-state', 'agentclaw.sqlite'); mkdirSync(dirname(legacy));
    renameSync(join(w.repo, 'data', 'hatchabot.sqlite'), legacy);
    writeFileSync(join(w.repo, '.env'), `AGENTCLAW_SECRET_KEY=x\nAGENTCLAW_DB=${legacy}\n`);
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const calls = readFileSync(w.log, 'utf8');
    expect(calls).toContain('docker rm -f c0ffee000011');
    expect(calls).toContain('docker volume rm hatchabot-leaky-11111111-vol');
    expect(existsSync(legacy)).toBe(false);
  });

  it('with no setting, data/agentclaw.sqlite is the database when data/hatchabot.sqlite is not there', () => {
    const w = purgeWorld();
    dockerShim(w, leakyContainer);
    renameSync(join(w.repo, 'data', 'hatchabot.sqlite'), join(w.repo, 'data', 'agentclaw.sqlite'));
    const r = run(w, ['--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(w.log, 'utf8')).toContain('docker stop c0ffee000011');
    expect(r.stdout).toContain(`the database at ${join(w.repo, 'data', 'agentclaw.sqlite')}`);
  });
});

describe('scripts/uninstall.sh and the backups (review, 2026-10-09)', () => {
  it('--backups removes only Hatchabot\'s dated sets; a shared folder and what else is in it stay', () => {
    const w = purgeWorld();
    dockerShim(w, VOLS);
    const backups = join(dirname(w.repo), 'nas');
    for (const [d, f] of [['2026-10-01', 'backup-status.json'], ['2026-10-02', 'hatchabot.sqlite']]) { mkdirSync(join(backups, d!), { recursive: true }); writeFileSync(join(backups, d!, f!), 'x'); }
    mkdirSync(join(backups, '2026-10-03')); writeFileSync(join(backups, '2026-10-03', 'photo.jpg'), 'not ours'); // dated, but not a set
    mkdirSync(join(backups, 'other-machine')); writeFileSync(join(backups, 'other-machine', 'db.sqlite'), 'not ours');
    writeFileSync(join(w.repo, '.env'), `HATCHABOT_SECRET_KEY=x\nHATCHABOT_BACKUP_DIR=${backups}\n`);
    const r = run(w, ['--purge', '--backups', '--yes']);
    expect(r.stdout, r.stderr).toContain('removed 2 backup sets');
    expect(existsSync(join(backups, '2026-10-01'))).toBe(false);
    expect(existsSync(join(backups, '2026-10-02'))).toBe(false);
    expect(existsSync(join(backups, '2026-10-03', 'photo.jpg'))).toBe(true);
    expect(existsSync(join(backups, 'other-machine', 'db.sqlite'))).toBe(true);
  });

  describe('restore drills, and what counts as a set (HB-0440)', () => {
    const mark = (key: string) => createHash('sha256').update(`hatchabot-backup-owner\0${key}`).digest('hex').slice(0, 16);
    const MINE = mark('x'), THEIRS = 'feedfacefeedface', REC = '2026-10-02T03-00-00Z.json';
    /** A record as restore-drill.sh writes it: one line, its set, and (from v2.173.0) who ran it. */
    const record = (fields: { set?: string; owner?: string }) => `${JSON.stringify({ version: 1, set: fields.set ?? '2026-10-01', setState: 'complete', startedAt: '2026-10-02T03:00:00Z', finishedAt: '2026-10-02T03:10:00Z', durationSec: 600, trigger: 'scheduled', result: 'passed', reason: '', database: 'ok', key: 'ok', ...(fields.owner ? { owner: fields.owner } : {}), volumes: [{ volume: 'hatchabot-recipe-box', readable: true, layout: true, restored: true, note: '', result: 'passed' }], isolation: { network: 'none', memory: '1g', cpus: '1' } })}\n`;
    const backupsWith = (w: ReturnType<typeof purgeWorld>, marks: string[], rec: string | null = record({ owner: MINE }), key = 'HATCHABOT_SECRET_KEY=x\n') => {
      const backups = join(dirname(w.repo), 'nas');
      marks.forEach((m, i) => {
        const d = join(backups, `2026-10-0${i + 1}`); mkdirSync(d, { recursive: true });
        writeFileSync(join(d, 'backup-status.json'), '{}');
        if (m) writeFileSync(join(d, '.backup-owner'), `${m}\n`);
      });
      mkdirSync(join(backups, 'drills', '.lock'), { recursive: true });
      if (rec) writeFileSync(join(backups, 'drills', REC), rec);
      writeFileSync(join(w.repo, '.env'), `${key}HATCHABOT_BACKUP_DIR=${backups}\n`);
      return backups;
    };
    const purge = (w: ReturnType<typeof purgeWorld>) => run(w, ['--purge', '--backups', '--yes']);
    it('--backups takes this install\'s drill records, and the folder goes with them', () => {
      const w = purgeWorld();
      dockerShim(w, VOLS);
      const backups = backupsWith(w, ['']);
      const r = purge(w);
      expect(r.stdout, r.stderr).toContain('removed 1 backup sets');
      expect(r.stdout).toContain(`removed the restore drill records in ${backups}`);
      expect(r.stdout).toContain(`removed ${backups} (empty now)`);
      expect(r.stdout).not.toContain('holds more than');
      expect(existsSync(backups)).toBe(false);
    });
    it('a record from before the mark is this install\'s when the set it names says so, by its mark or its key', () => {
      const w = purgeWorld();
      dockerShim(w, VOLS);
      const backups = backupsWith(w, [MINE], record({}));
      const r = purge(w);
      expect(r.stdout, r.stderr).toContain(`removed the restore drill records in ${backups}`);
      expect(existsSync(backups)).toBe(false);
      const w2 = purgeWorld();
      dockerShim(w2, VOLS);
      const b2 = backupsWith(w2, [''], record({}));
      writeFileSync(join(b2, '2026-10-01', 'secret-key.env'), 'HATCHABOT_SECRET_KEY=x\n');
      expect(purge(w2).status).toBe(0);
      expect(existsSync(b2)).toBe(false);
    });
    it('in a folder another install also uses, its record stays and this one\'s goes', () => {
      const w = purgeWorld();
      dockerShim(w, VOLS);
      const backups = backupsWith(w, ['', THEIRS], record({ owner: THEIRS, set: '2026-10-02' }));
      writeFileSync(join(backups, 'drills', '2026-10-03T03-00-00Z.json'), record({ owner: MINE }));
      const r = purge(w);
      expect(r.stdout, r.stderr).toContain('kept 1 sets another Hatchabot install made there');
      expect(existsSync(join(backups, 'drills', REC))).toBe(true);
      expect(existsSync(join(backups, 'drills', '2026-10-03T03-00-00Z.json'))).toBe(false);
      expect(r.stdout).toContain(`kept what is left in ${backups}/drills`);
      expect(r.stdout).toContain(`kept ${backups} itself: it still holds 2026-10-02 drills`);
    });
    it('a record that names another install\'s set, or a set that is gone, cannot be told: it stays, and that is said', () => {
      for (const [rec, marks] of [[record({ set: '2026-10-01' }), [THEIRS]], [record({ set: '2026-09-01' }), ['']], [record({ set: '../../x' }), ['']], [record({ set: '2026-10-01' }), ['']]] as const) {
        const w = purgeWorld();
        dockerShim(w, VOLS);
        const backups = backupsWith(w, [...marks], rec);
        const r = purge(w);
        expect(r.status, r.stderr).toBe(0);
        expect(readFileSync(join(backups, 'drills', REC), 'utf8')).toBe(rec);
        expect(r.stdout).toContain(`kept what is left in ${backups}/drills: this install cannot tell it is its own`);
        expect(r.stdout).not.toContain('removed the restore drill records');
      }
    });
    it('a drills folder that is not this script\'s to judge stays whole, whatever is in it', () => {
      const w = purgeWorld();
      dockerShim(w, VOLS);
      const backups = backupsWith(w, [''], null);
      writeFileSync(join(backups, 'drills', 'fire-drill-2026.pdf'), 'someone else\'s');
      writeFileSync(join(backups, 'drills', 'notes.json'), record({ owner: MINE })); // not a record's name
      writeFileSync(join(backups, 'drills', '2026-10-05T03-00-00Z.json'), `{"owner":"${MINE}"}\n`); // a record's name, not one
      mkdirSync(join(backups, 'drills', 'photos'));
      const r = purge(w);
      expect(r.stdout, r.stderr).toContain(`kept what is left in ${backups}/drills`);
      for (const f of ['fire-drill-2026.pdf', 'notes.json', '2026-10-05T03-00-00Z.json', 'photos']) expect(existsSync(join(backups, 'drills', f)), f).toBe(true);
    });
    it('with no key to tell by, nothing there is taken for this install\'s', () => {
      const w = purgeWorld();
      dockerShim(w, VOLS);
      const backups = backupsWith(w, [''], record({ owner: MINE }), '');
      const r = purge(w);
      expect(r.stdout + r.stderr).toContain(`kept what is left in ${backups}/drills`);
      expect(existsSync(join(backups, 'drills', REC))).toBe(true);
    });
    it('a folder that is a link to somewhere else is not followed', () => {
      const w = purgeWorld();
      dockerShim(w, VOLS);
      const backups = backupsWith(w, ['']);
      const elsewhere = join(dirname(w.repo), 'elsewhere');
      renameSync(join(backups, 'drills'), elsewhere);
      symlinkSync(elsewhere, join(backups, 'drills'));
      const r = purge(w);
      expect(r.stdout, r.stderr).toContain(`kept ${backups}/drills: it is a link`);
      expect(existsSync(join(elsewhere, REC))).toBe(true);
    });
    it('the lock of a drill that is still running stays; a dead one goes with the records', () => {
      const w = purgeWorld();
      dockerShim(w, VOLS);
      const backups = backupsWith(w, ['']);
      writeFileSync(join(backups, 'drills', '.lock', 'pid'), String(process.pid));
      const r = purge(w);
      expect(r.stdout, r.stderr).toContain(`kept what is left in ${backups}/drills`);
      expect(existsSync(join(backups, 'drills', '.lock', 'pid'))).toBe(true);
      expect(existsSync(join(backups, 'drills', REC))).toBe(false);
      const w2 = purgeWorld();
      dockerShim(w2, VOLS);
      const b2 = backupsWith(w2, ['']);
      writeFileSync(join(b2, 'drills', '.lock', 'pid'), '4194999');
      expect(purge(w2).status).toBe(0);
      expect(existsSync(b2)).toBe(false);
    });
    it('what else is left in the folder is named, not blamed on Hatchabot\'s sets', () => {
      const w = purgeWorld();
      dockerShim(w, VOLS);
      const backups = backupsWith(w, ['']);
      mkdirSync(join(backups, 'other-machine'));
      const r = run(w, ['--purge', '--backups', '--yes']);
      expect(r.stdout, r.stderr).toContain(`kept ${backups} itself: it still holds other-machine`);
      expect(existsSync(join(backups, 'drills'))).toBe(false);
    });
    it('the plan and the note on what is kept count dated sets only', () => {
      for (const args of [['--purge', '--backups', '--yes'], ['--yes']]) {
        const w = purgeWorld();
        dockerShim(w, VOLS);
        const backups = backupsWith(w, ['', '']);
        mkdirSync(join(backups, 'restore-safety-feedface'));
        mkdirSync(join(backups, '2026-10-05')); writeFileSync(join(backups, '2026-10-05', 'photo.jpg'), 'not ours'); // dated, but not a set
        const r = run(w, args);
        expect(r.stdout, r.stderr).toContain(`backups:   ${backups} (2 sets)`);
        if (args.length === 1) expect(r.stdout).toContain(`2 backup sets in ${backups}`);
      }
    });
    it('without --backups a purge leaves the drill records with the sets', () => {
      const w = purgeWorld();
      dockerShim(w, VOLS);
      const backups = backupsWith(w, ['']);
      expect(run(w, ['--purge', '--yes']).status).toBe(0);
      expect(existsSync(join(backups, 'drills', '2026-10-02T03-00-00Z.json'))).toBe(true);
    });
  });

  it('--backups leaves the sets another install made in a shared folder (HB-0280)', () => {
    const w = purgeWorld();
    dockerShim(w, VOLS);
    const backups = join(dirname(w.repo), 'shared');
    const set = (d: string, files: Record<string, string>) => { mkdirSync(join(backups, d), { recursive: true }); for (const [f, t] of Object.entries(files)) writeFileSync(join(backups, d, f), t); };
    set('2026-10-01', { 'backup-status.json': '{}', '.backup-owner': 'feedfacefeedface\n' }); // the other install's
    set('2026-10-02', { 'backup-status.json': '{}', 'secret-key.env': 'HATCHABOT_SECRET_KEY=another-made-up-key\n' }); // the other's, from before owner files
    set('2026-10-03', { 'backup-status.json': '{}', 'secret-key.env': 'HATCHABOT_SECRET_KEY=x\n' }); // this install's, from before owner files
    set('2026-10-04', { 'hatchabot.sqlite': 'x' }); // no owner, no key: as before, removed
    writeFileSync(join(w.repo, '.env'), `HATCHABOT_SECRET_KEY=x\nHATCHABOT_BACKUP_DIR=${backups}\n`);
    const r = run(w, ['--purge', '--backups', '--yes']);
    expect(r.stdout, r.stderr).toContain('removed 2 backup sets');
    expect(r.stdout).toContain('kept 2 sets another Hatchabot install made there');
    expect(existsSync(join(backups, '2026-10-01'))).toBe(true);
    expect(existsSync(join(backups, '2026-10-02'))).toBe(true);
    expect(existsSync(join(backups, '2026-10-03'))).toBe(false);
    expect(existsSync(join(backups, '2026-10-04'))).toBe(false);
  });

  it('--backups with no key here keeps every set that says which install made it, and still takes one that says nothing (HB-1066)', () => {
    for (const env of ['', 'HATCHABOT_SECRET_KEY=\n']) {
      const w = purgeWorld();
      dockerShim(w, VOLS);
      const backups = join(dirname(w.repo), 'shared');
      const set = (d: string, files: Record<string, string>) => { mkdirSync(join(backups, d), { recursive: true }); for (const [f, t] of Object.entries(files)) writeFileSync(join(backups, d, f), t); };
      set('2026-10-01', { 'backup-status.json': '{}', '.backup-owner': 'feedfacefeedface\n' }); // another install's mark
      set('2026-10-02', { 'backup-status.json': '{}', 'secret-key.env': 'HATCHABOT_SECRET_KEY=another-made-up-key\n' }); // another's, from before marks
      set('2026-10-03', { 'hatchabot.sqlite': 'x' }); // says nothing: as before, removed
      writeFileSync(join(w.repo, '.env'), `${env}HATCHABOT_BACKUP_DIR=${backups}\n`);
      const r = run(w, ['--purge', '--backups', '--yes']);
      expect(r.stdout, env + r.stdout + r.stderr).toContain('removed 1 backup sets');
      expect(r.stdout).toMatch(/kept 2 sets that say which install made them: with no HATCHABOT_SECRET_KEY in .*\.env, this one cannot tell whether that is itself/);
      expect(r.stdout).not.toContain('another Hatchabot install made there');
      expect(existsSync(join(backups, '2026-10-01', '.backup-owner')), env).toBe(true);
      expect(existsSync(join(backups, '2026-10-02', 'secret-key.env')), env).toBe(true);
      expect(existsSync(join(backups, '2026-10-03')), env).toBe(false);
      expect(existsSync(backups)).toBe(true);
    }
  });

  it('--backups never takes a key from the shell that runs it: with none in .env, another install\'s exported there marks nothing as this one\'s (HB-1066 review)', () => {
    const other = 'fixture-other-install-key';
    const theirs = createHash('sha256').update(`hatchabot-backup-owner\0${other}`).digest('hex').slice(0, 16);
    for (const [name, mac] of [['HATCHABOT_SECRET_KEY', false], ['AGENTCLAW_SECRET_KEY', false], ['HATCHABOT_SECRET_KEY', true]] as const) {
      const w = purgeWorld();
      dockerShim(w, VOLS);
      if (mac) writeFileSync(join(w.bin, 'uname'), '#!/usr/bin/env bash\necho Darwin\n', { mode: 0o755 });
      const backups = join(dirname(w.repo), 'shared');
      const set = (d: string, files: Record<string, string>) => { mkdirSync(join(backups, d), { recursive: true }); for (const [f, t] of Object.entries(files)) writeFileSync(join(backups, d, f), t); };
      set('2026-10-01', { 'backup-status.json': '{}', '.backup-owner': `${theirs}\n` }); // the other install's mark
      set('2026-10-02', { 'backup-status.json': '{}', 'secret-key.env': `HATCHABOT_SECRET_KEY=${other}\n` }); // the other's, from before marks
      mkdirSync(join(backups, `restore-safety-${theirs}`));
      writeFileSync(join(w.repo, '.env'), `HATCHABOT_BACKUP_DIR=${backups}\n`);
      const r = run(w, ['--purge', '--backups', '--yes'], { [name]: other });
      const label = `${name}${mac ? ' (Mac)' : ''}`;
      expect(r.status, label + r.stdout + r.stderr).toBe(0);
      expect(r.stdout, label).toContain('removed 0 backup sets');
      expect(r.stdout, label).toMatch(/kept 2 sets that say which install made them: with no HATCHABOT_SECRET_KEY in .*\.env/);
      expect(existsSync(join(backups, '2026-10-01', '.backup-owner')), label).toBe(true);
      expect(existsSync(join(backups, '2026-10-02', 'secret-key.env')), label).toBe(true);
      expect(existsSync(join(backups, `restore-safety-${theirs}`)), label).toBe(true);
    }
  });

  it('--purge --backups goes by .env and its defaults alone: another install\'s database, backups and network exported in the shell are left alone (HB-1066 review)', () => {
    for (const [p, mac] of [['HATCHABOT_', false], ['AGENTCLAW_', false], ['HATCHABOT_', true]] as const) {
      const w = purgeWorld();
      dockerShim(w, VOLS);
      if (mac) writeFileSync(join(w.bin, 'uname'), '#!/usr/bin/env bash\necho Darwin\n', { mode: 0o755 });
      // Another install beside this one: its registry names an agent of its own, and its backups are sets that say nothing.
      const other = join(dirname(w.repo), 'other-install');
      mkdirSync(join(other, 'data'), { recursive: true });
      const otherDb = join(other, 'data', 'hatchabot.sqlite');
      const db = new Database(otherDb);
      db.exec('CREATE TABLE agents (id TEXT, runtime_ref TEXT, image TEXT)');
      db.prepare('INSERT INTO agents VALUES (?, ?, NULL)').run('33333333-cccc', 'docker://hatchabot-garden-33333333');
      db.close();
      const otherBackups = join(other, 'backups');
      for (const d of ['2026-10-01', '2026-10-02']) { mkdirSync(join(otherBackups, d), { recursive: true }); writeFileSync(join(otherBackups, d, 'backup-status.json'), '{}'); }
      // This install's own backups, in the default folder: .env names none.
      const mine = join(w.home, 'hatchabot-backups', '2026-10-05'); mkdirSync(mine, { recursive: true }); writeFileSync(join(mine, 'backup-status.json'), '{}');
      writeFileSync(join(w.repo, '.env'), 'HATCHABOT_SECRET_KEY=x\n');
      const label = `${p}${mac ? ' (Mac)' : ''}`;
      const r = run(w, ['--purge', '--backups', '--yes'], { [`${p}DB`]: otherDb, [`${p}BACKUP_DIR`]: otherBackups, [`${p}AGENT_NETWORK`]: 'fixture-other-net' });
      expect(existsSync(otherDb), label).toBe(true);
      for (const d of ['2026-10-01', '2026-10-02']) expect(existsSync(join(otherBackups, d, 'backup-status.json')), `${label} ${d}`).toBe(true);
      const calls = readFileSync(w.log, 'utf8');
      expect(calls, label).not.toMatch(/garden-33333333|fixture-other-net/);
      // What is this install's went: its database, its agent's volume, its backup set and network.
      expect(existsSync(join(w.repo, 'data', 'hatchabot.sqlite')), label).toBe(false);
      expect(calls, label).toContain('docker volume rm hatchabot-leaky-11111111-vol');
      expect(calls, label).toContain('docker network rm hatchabot-agents');
      expect(existsSync(mine), label).toBe(false);
      expect(r.stdout, label).toContain(`Note: not using ${p}AGENT_NETWORK ${p}BACKUP_DIR ${p}DB from this shell — ${w.repo}/.env and its defaults decide, as they do for the service.`);
      expect(r.status, label + r.stdout + r.stderr).toBe(0);
    }
  });

  it('--purge of an install started with its database named only in the shell: refused while .env finds none, so its key is not deleted from under it (HB-1236)', () => {
    for (const p of ['HATCHABOT_', 'AGENTCLAW_']) {
      const w = purgeWorld();
      dockerShim(w, VOLS);
      const elsewhere = join(dirname(w.repo), 'by-hand'); mkdirSync(elsewhere);
      const db = join(elsewhere, 'hb.sqlite');
      renameSync(join(w.repo, 'data', 'hatchabot.sqlite'), db);
      writeFileSync(join(w.repo, '.env'), 'HATCHABOT_SECRET_KEY=x\n');
      const r = run(w, ['--purge', '--yes'], { [`${p}DB`]: db });
      expect(r.status, p + r.stdout + r.stderr).toBe(2);
      expect(r.stdout).toContain(`This shell sets ${p}DB=${db}, a database that is there, but ${w.repo}/.env names none`);
      expect(r.stdout).toContain(`add the line HATCHABOT_DB=${db} to ${w.repo}/.env`);
      expect(existsSync(join(w.repo, '.env')), p).toBe(true);
      expect(existsSync(db), p).toBe(true);
      expect(existsSync(w.log) ? readFileSync(w.log, 'utf8') : '', p).not.toMatch(/docker (rm|volume rm|rmi|stop)|systemctl/); // nothing stopped or removed
      // No .env at all: its key was the shell's too, and that is said, not a file's.
      renameSync(join(w.repo, '.env'), join(dirname(w.repo), 'env.kept'));
      const bare = run(w, ['--purge', '--yes'], { [`${p}DB`]: db });
      expect(bare.status, p + bare.stdout + bare.stderr).toBe(2);
      expect(bare.stdout).toContain(`but there is no ${w.repo}/.env and no database at`);
      expect(bare.stdout).toContain(`put the line HATCHABOT_DB=${db} in ${w.repo}/.env, with the key it was started with (HATCHABOT_SECRET_KEY)`);
      expect(bare.stdout).not.toContain('holds its key');
      // What a purge would do then, truly: no agent removed (it reads no database), not "remove its agents" (review of HB-1236).
      expect(bare.stdout).toContain('--purge would not read it: it would remove the service but none of its agents. Their containers and volumes would stay');
      expect(bare.stdout).not.toContain('would remove its agents');
      // And what it would remove all the same: the data folder at its default path, the command's sign-in, the channel pin (HB-1383).
      expect(bare.stdout).toContain(`  It would still remove ${w.repo}/data (unless a database is in it), ~/.config/hatchabot/env (the hatchabot command's sign-in), the channel pin.`);
      expect(existsSync(db), p).toBe(true);
      // The shell's database in that folder keeps it (other_databases): the folder is not said to go (review of HB-1383).
      const inData = join(w.repo, 'data', 'by-hand.sqlite');
      renameSync(db, inData);
      const kept = run(w, ['--purge', '--yes'], { [`${p}DB`]: inData });
      expect(kept.status, p + kept.stdout + kept.stderr).toBe(2);
      expect(kept.stdout).toContain("  It would still remove ~/.config/hatchabot/env (the hatchabot command's sign-in), the channel pin.");
      renameSync(inData, db);
      renameSync(join(dirname(w.repo), 'env.kept'), join(w.repo, '.env'));
      // A shell naming no database that is there: the purge goes on as before.
      const gone = run(w, ['--purge', '--yes'], { [`${p}DB`]: join(elsewhere, 'not-there.sqlite') });
      expect(gone.status, p + gone.stdout + gone.stderr).toBe(0);
      expect(existsSync(join(w.repo, '.env')), p).toBe(false);
    }
  });

  it('a purge with no database finds no agent and removes none, and says so, never that they are gone; their containers keep the network and images (review of HB-1236)', () => {
    const w = purgeWorld();
    rmSync(join(w.repo, 'data', 'hatchabot.sqlite'));
    // The agents' containers still here (made by Hatchabot: its label), their volumes too.
    dockerShim(w, `${VOLS}
  "ps -aq --filter label=hatchabot.gen") echo beef00000003 ;;
  "image inspect --format {{.Id}} hatchabot-runtime:latest") echo sha256:dddd ;;`);
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`There was no database at ${w.repo}/data/hatchabot.sqlite, so none of this install's agents were found, and none were removed.`);
    expect(r.stdout).not.toContain('Its agents, volumes and database are gone');
    // Nor did it say first that their volumes and the database would be deleted (HB-1383).
    // Nor that the images and the network go, which their containers keep (review of HB-1383).
    expect(r.stdout).toContain(`  MODE: --purge — there is no database at ${w.repo}/data/hatchabot.sqlite, so no agent of this install's is known, and\n        none of their volumes will be removed.\n        The runtime images and the docker network are KEPT: 1 container of another Hatchabot install on this machine may use them (with no database, this install's own agents count as another's).`);
    expect(r.stdout).not.toContain('will be DELETED');
    expect(r.stdout).not.toContain('agent volumes, the database');
    const calls = readFileSync(w.log, 'utf8');
    expect(calls).not.toMatch(/docker (rm|volume rm|rmi) /);
    expect(calls).not.toMatch(/docker network rm hatchabot-agents/);
    expect(r.stdout).toContain('kept the hatchabot-agents network');
    // No database and no container here: the images and the network do go, and it says so.
    const bare = purgeWorld();
    rmSync(join(bare.repo, 'data', 'hatchabot.sqlite'));
    dockerShim(bare, `${VOLS}
  "image inspect --format {{.Id}} hatchabot-runtime:latest") echo sha256:dddd ;;`);
    const gone = run(bare, ['--purge', '--yes']);
    expect(gone.status, gone.stdout + gone.stderr).toBe(0);
    expect(gone.stdout).toContain(`  MODE: --purge — there is no database at ${bare.repo}/data/hatchabot.sqlite, so no agent of this install's is known, and\n        none of their volumes will be removed. The runtime images and the docker network will be DELETED.`);
    expect(readFileSync(bare.log, 'utf8')).toMatch(/docker rmi -f hatchabot-runtime:latest/);
    expect(readFileSync(bare.log, 'utf8')).toMatch(/docker network rm hatchabot-agents/);
    // With a database that names them, the purge's own words, as before.
    const named = purgeWorld();
    dockerShim(named, VOLS);
    const ok = run(named, ['--purge', '--yes']);
    expect(ok.stdout).not.toContain('There was no database');
    expect(ok.stdout).toContain('  MODE: --purge — agent volumes, the database, the runtime images\n        and the docker network will be DELETED. Agents cannot be recovered.');
    // And with another install's container here too: the images and the network are said to stay, as they do.
    const shared = purgeWorld();
    dockerShim(shared, `${VOLS}
  "ps -aq --filter label=hatchabot.gen") echo beef00000009 ;;
  "image inspect --format {{.Id}} hatchabot-runtime:latest") echo sha256:dddd ;;`);
    const both = run(shared, ['--purge', '--yes']);
    expect(both.status, both.stdout + both.stderr).toBe(0);
    expect(both.stdout).toContain('  MODE: --purge — agent volumes and the database will be DELETED. Agents cannot be recovered.\n        The runtime images and the docker network are KEPT: 1 container of another Hatchabot install on this machine may use them.');
    expect(readFileSync(shared.log, 'utf8')).not.toMatch(/docker (rmi|network rm hatchabot-agents)/);
  });

  it('--backups reads the key as the backup does, not as shell: a passphrase with a $ or a quote still knows its own sets, and .env runs nothing (HB-0376)', () => {
    const owner = (key: string) => createHash('sha256').update(`hatchabot-backup-owner\0${key}`).digest('hex').slice(0, 16);
    for (const [line, key] of [
      ['made-up$key-phrase', 'made-up$key-phrase'],     // sourced: $key expanded to nothing
      ['"made-up${HOME}phrase"', 'made-up${HOME}phrase'], // sourced: the temp HOME in it
      ["it's-made-up", "it's-made-up"],                  // sourced: an unclosed quote, and the whole line unread
    ] as const) {
      const w = purgeWorld();
      dockerShim(w, VOLS);
      const backups = join(dirname(w.repo), 'shared');
      mkdirSync(join(backups, '2026-10-01'), { recursive: true });
      writeFileSync(join(backups, '2026-10-01', 'backup-status.json'), '{}');
      writeFileSync(join(backups, '2026-10-01', '.backup-owner'), `${owner(key)}\n`); // what backup-volumes.sh wrote
      mkdirSync(join(backups, '2026-10-02'));
      writeFileSync(join(backups, '2026-10-02', 'backup-status.json'), '{}');
      writeFileSync(join(backups, '2026-10-02', '.backup-owner'), 'feedfacefeedface\n'); // the other install's
      writeFileSync(join(w.repo, '.env'), `HATCHABOT_SECRET_KEY=${line}\nHATCHABOT_BACKUP_DIR=${backups}\n`);
      const r = run(w, ['--purge', '--backups', '--yes']);
      expect(r.stdout, line + r.stdout + r.stderr).toContain('removed 1 backup sets');
      expect(existsSync(join(backups, '2026-10-01')), line).toBe(false);
      expect(existsSync(join(backups, '2026-10-02')), line).toBe(true);
    }
    const w = purgeWorld();
    dockerShim(w, VOLS);
    const ran = join(dirname(w.repo), 'ran');
    writeFileSync(join(w.repo, '.env'), `HATCHABOT_SECRET_KEY=x$(touch ${ran})y\n`);
    expect(run(w, ['--purge', '--yes']).status).toBe(0);
    expect(existsSync(ran)).toBe(false);
  });

  it('--backups reads a key ending in an escaped space as systemd does, the space kept; an escaped backslash before a space loses the space (review of HB-1065)', () => {
    const owner = (key: string) => createHash('sha256').update(`hatchabot-backup-owner\0${key}`).digest('hex').slice(0, 16);
    for (const [line, key, near] of [
      ['made-up-key\\ ', 'made-up-key ', 'made-up-key'],       // systemd keeps the escaped space
      ['made-up-key\\\\ ', 'made-up-key\\', 'made-up-key\\ '], // an escaped backslash, then a space systemd trims
    ] as const) {
      const w = purgeWorld();
      dockerShim(w, VOLS);
      const backups = join(dirname(w.repo), 'shared');
      for (const [d, mark] of [['2026-10-01', owner(key)], ['2026-10-02', owner(near)]] as const) {
        mkdirSync(join(backups, d), { recursive: true });
        writeFileSync(join(backups, d, 'backup-status.json'), '{}');
        writeFileSync(join(backups, d, '.backup-owner'), `${mark}\n`);
      }
      writeFileSync(join(w.repo, '.env'), `HATCHABOT_SECRET_KEY=${line}\nHATCHABOT_BACKUP_DIR=${backups}\n`);
      const r = run(w, ['--purge', '--backups', '--yes']);
      expect(r.stdout, line + r.stdout + r.stderr).toContain('removed 1 backup sets');
      expect(existsSync(join(backups, '2026-10-01')), line).toBe(false); // what the backup marked, with the key the service has
      expect(existsSync(join(backups, '2026-10-02')), line).toBe(true);  // a key one space away is another's
    }
  });

  const owner = (key: string) => createHash('sha256').update(`hatchabot-backup-owner\0${key}`).digest('hex').slice(0, 16);
  /** A backup folder beside the install: a dated set per mark, each named by its .backup-owner. */
  const sets = (w: ReturnType<typeof world>, marks: string[]) => {
    const backups = join(dirname(w.repo), 'shared');
    marks.forEach((mark, i) => {
      const d = join(backups, `2026-10-0${i + 1}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'backup-status.json'), '{}');
      writeFileSync(join(d, '.backup-owner'), `${mark}\n`);
    });
    return backups;
  };
  const onMac = (w: ReturnType<typeof world>) => writeFileSync(join(w.bin, 'uname'), '#!/usr/bin/env bash\necho Darwin\n', { mode: 0o755 });

  it('--backups on Linux reads a # in the key as systemd does; a set made by hand with the cut reading is its own too', () => {
    const w = purgeWorld();
    dockerShim(w, VOLS);
    const backups = sets(w, [owner('pass#word'), owner('pass'), 'feedfacefeedface']);
    writeFileSync(join(w.repo, '.env'), `HATCHABOT_SECRET_KEY=pass#word\nHATCHABOT_BACKUP_DIR=${backups}\n`);
    const r = run(w, ['--purge', '--backups', '--yes']);
    expect(r.stdout, r.stdout + r.stderr).toContain('removed 2 backup sets');
    expect(existsSync(join(backups, '2026-10-03'))).toBe(true);
  });

  it('a database in a folder with a # in its name is found on Linux, not left behind with its agents', () => {
    const w = purgeWorld();
    dockerShim(w, VOLS);
    const data = join(dirname(w.repo), 'da#ta'); mkdirSync(data);
    renameSync(join(w.repo, 'data', 'hatchabot.sqlite'), join(data, 'hb.sqlite'));
    writeFileSync(join(w.repo, '.env'), `HATCHABOT_SECRET_KEY=x\nHATCHABOT_DB=${join(data, 'hb.sqlite')}\n`);
    const r = run(w, ['--purge', '--yes']);
    expect(readFileSync(w.log, 'utf8')).toContain('docker volume rm hatchabot-leaky-11111111-vol');
    expect(existsSync(join(data, 'hb.sqlite')), r.stdout + r.stderr).toBe(false);
  });

  it('a database named after a comment that ends in a backslash is the one this machine\'s systemd gives the service (HB-1457)', () => {
    for (const [says, named] of [['systemd 255 (255.4-1ubuntu8.4)', true], ['systemd 252 (252.30-1~deb12u2)', false]] as const) {
      const w = purgeWorld();
      dockerShim(w, VOLS);
      writeFileSync(join(w.bin, 'systemctl'), `#!/usr/bin/env bash\necho "systemctl $*" >> ${JSON.stringify(w.log)}\n[ "$1" != --version ] || echo '${says}'\nexit 0\n`, { mode: 0o755 });
      const data = join(dirname(w.repo), 'elsewhere'); mkdirSync(data);
      copyFileSync(join(w.repo, 'data', 'hatchabot.sqlite'), join(data, 'hb.sqlite'));
      writeFileSync(join(w.repo, '.env'), `HATCHABOT_SECRET_KEY=x\n# it was on E:\\old\\\nHATCHABOT_DB=${join(data, 'hb.sqlite')}\n`);
      const r = run(w, ['--purge', '--yes']);
      const label = `${says}: ${r.stdout}${r.stderr}`;
      expect(readFileSync(w.log, 'utf8'), label).toContain('systemctl --version');
      // The one the service opens goes; the other stays.
      expect(existsSync(join(data, 'hb.sqlite')), label).toBe(!named);
      expect(existsSync(join(w.repo, 'data', 'hatchabot.sqlite')), label).toBe(named);
    }
  });

  it('a database only Node\'s reading finds (a server started by hand) is still found', () => {
    const w = purgeWorld();
    dockerShim(w, VOLS);
    const data = join(dirname(w.repo), 'elsewhere'); mkdirSync(data);
    renameSync(join(w.repo, 'data', 'hatchabot.sqlite'), join(data, 'hb.sqlite'));
    writeFileSync(join(w.repo, '.env'), `HATCHABOT_SECRET_KEY=x\nHATCHABOT_DB=${join(data, 'hb.sqlite')} # moved here\n`);
    run(w, ['--purge', '--yes']);
    expect(readFileSync(w.log, 'utf8')).toContain('docker volume rm hatchabot-leaky-11111111-vol');
    expect(existsSync(join(data, 'hb.sqlite'))).toBe(false);
  });

  it('on a Mac it reads .env as the launchd job does: its nightly sets are its own (HB-0376)', () => {
    const w = purgeWorld();
    onMac(w);
    dockerShim(w, VOLS);
    const backups = sets(w, [owner('made-up-phrase'), owner('made-up$key-phrase'), 'feedfacefeedface']);
    writeFileSync(join(w.repo, '.env'), `HATCHABOT_SECRET_KEY=made-up$key-phrase\nHATCHABOT_BACKUP_DIR=${backups}\n`);
    const r = run(w, ['--purge', '--backups', '--yes']);
    expect(r.stdout, r.stdout + r.stderr).toContain('removed 2 backup sets');
    expect(existsSync(join(backups, '2026-10-01'))).toBe(false);
    expect(existsSync(join(backups, '2026-10-03'))).toBe(true);
  });

  it('on a Mac a $HOME database and backup folder are the real ones, so a purge finds the agents and refuses with no Docker (audit #026)', () => {
    const w = purgeWorld();
    onMac(w);
    mkdirSync(join(w.home, 'hbdata'));
    renameSync(join(w.repo, 'data', 'hatchabot.sqlite'), join(w.home, 'hbdata', 'hb.sqlite'));
    writeFileSync(join(w.repo, '.env'), 'HATCHABOT_SECRET_KEY=x\nHATCHABOT_DB=$HOME/hbdata/hb.sqlite\nHATCHABOT_BACKUP_DIR=$HOME/hbbackups\n');
    writeFileSync(join(w.bin, 'docker'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
    const refused = run(w, ['--purge', '--yes']);
    expect(refused.status, refused.stdout + refused.stderr).toBe(2);
    expect(refused.stdout).toMatch(/Docker is not answering/);
    expect(existsSync(join(w.repo, '.env'))).toBe(true);
    dockerShim(w, VOLS);
    mkdirSync(join(w.home, 'hbbackups', '2026-10-01'), { recursive: true });
    writeFileSync(join(w.home, 'hbbackups', '2026-10-01', 'backup-status.json'), '{}');
    const r = run(w, ['--purge', '--backups', '--yes']);
    expect(readFileSync(w.log, 'utf8')).toContain('docker volume rm hatchabot-leaky-11111111-vol');
    expect(existsSync(join(w.home, 'hbdata', 'hb.sqlite')), r.stdout + r.stderr).toBe(false);
    expect(existsSync(join(w.home, 'hbbackups', '2026-10-01'))).toBe(false);
  });

  it('--purge takes the copy a killed move left, with or without --backups, even when the data folder stays (HB-0388)', () => {
    for (const args of [['--purge', '--yes'], ['--purge', '--backups', '--yes']]) {
      const w = purgeWorld();
      dockerShim(w, VOLS);
      const shared = join(w.home, 'shared');   // not named as Hatchabot's own, so the folder stays
      const copies = join(shared, 'move-copies-' + createHash('sha256').update('hb.sqlite').digest('hex').slice(0, 16));
      mkdirSync(copies, { recursive: true }); writeFileSync(join(copies, 'copy.tgz.part'), 'made-up volume');
      const otherCopies = join(shared, 'move-copies-' + createHash('sha256').update('another.sqlite').digest('hex').slice(0, 16));
      mkdirSync(otherCopies); writeFileSync(join(otherCopies, 'copy.tgz'), 'another install is moving');
      const legacy = join(shared, 'move-copies'); mkdirSync(legacy); writeFileSync(join(legacy, 'copy.tgz'), 'unmarked older copy');
      copyFileSync(join(w.repo, 'data', 'hatchabot.sqlite'), join(shared, 'hb.sqlite'));
      writeFileSync(join(shared, 'other.txt'), 'not hatchabot');
      writeFileSync(join(w.repo, '.env'), `HATCHABOT_SECRET_KEY=x\nHATCHABOT_DB=${join(shared, 'hb.sqlite')}\n`);
      const r = run(w, args);
      expect(existsSync(copies), r.stdout + r.stderr).toBe(false);
      expect(readFileSync(join(otherCopies, 'copy.tgz'), 'utf8')).toBe('another install is moving');
      expect(readFileSync(join(legacy, 'copy.tgz'), 'utf8')).toBe('unmarked older copy');
      expect(existsSync(join(shared, 'other.txt'))).toBe(true);
      expect(r.stdout).toContain('removed the copy a move that was cut off left');
    }
  });

  it('--purge preserves unmarked move copies even inside the usual data folder', () => {
    const w = purgeWorld(); dockerShim(w, VOLS);
    const legacy = join(w.repo, 'data', 'move-copies'); mkdirSync(legacy);
    writeFileSync(join(legacy, 'copy.tgz'), 'unmarked older copy');
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(w.repo, 'data', 'hatchabot.sqlite'))).toBe(false);
    expect(readFileSync(join(legacy, 'copy.tgz'), 'utf8')).toBe('unmarked older copy');
    expect(r.stdout).toMatch(/move copies cannot be attributed/);
  });

  it('a killed restore\'s copy goes only with --backups, and never another install\'s or an unmarked folder', () => {
    for (const [args, gone] of [[['--purge', '--yes'], false], [['--purge', '--backups', '--yes'], true]] as const) {
      const w = purgeWorld();
      dockerShim(w, VOLS);
      const backups = join(dirname(w.repo), 'shared');
      const mine = join(backups, `restore-safety-${owner('x')}`), theirs = join(backups, 'restore-safety-feedfacefeedface'), old = join(backups, 'restore-safety');
      for (const d of [mine, theirs, old]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'copy.tgz'), 'made-up volume'); }
      writeFileSync(join(w.repo, '.env'), `HATCHABOT_SECRET_KEY=x\nHATCHABOT_BACKUP_DIR=${backups}\n`);
      const r = run(w, [...args]);
      expect(existsSync(mine), r.stdout + r.stderr).toBe(!gone);
      expect(existsSync(join(theirs, 'copy.tgz'))).toBe(true);
      expect(existsSync(join(old, 'copy.tgz'))).toBe(true);
      expect(r.stdout).toContain(`kept ${old}:`);
      expect(r.stdout).toContain(`kept ${theirs}:`);
      expect(r.stdout.includes(`kept ${mine}:`)).toBe(!gone);
    }
  });

  it('--purge --backups leaves no folder behind for a copy that was the only thing left in it', () => {
    const w = purgeWorld();
    dockerShim(w, VOLS);
    const backups = join(dirname(w.repo), 'mine');
    const mine = join(backups, `restore-safety-${owner('x')}`);
    mkdirSync(mine, { recursive: true }); writeFileSync(join(mine, 'copy.tgz'), 'made-up volume');
    writeFileSync(join(w.repo, '.env'), `HATCHABOT_SECRET_KEY=x\nHATCHABOT_BACKUP_DIR=${backups}\n`);
    const r = run(w, ['--purge', '--backups', '--yes']);
    expect(existsSync(backups), r.stdout + r.stderr).toBe(false);
  });

  it('--purge without --backups keeps a backup folder that sits inside the data folder', () => {
    const w = purgeWorld();
    dockerShim(w, VOLS);
    const set = join(w.repo, 'data', 'backups', '2026-10-01');
    mkdirSync(set, { recursive: true }); writeFileSync(join(set, 'backup-status.json'), '{}');
    writeFileSync(join(w.repo, 'data', 'server.log'), 'log');
    writeFileSync(join(w.repo, '.env'), `HATCHABOT_SECRET_KEY=x\nHATCHABOT_BACKUP_DIR=${join(w.repo, 'data', 'backups')}\n`);
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(set, 'backup-status.json'))).toBe(true);
    expect(existsSync(join(w.repo, 'data', 'hatchabot.sqlite'))).toBe(false);
    expect(existsSync(join(w.repo, 'data', 'server.log'))).toBe(false);
    expect(r.stdout).toContain('except backups/');
  });
});

describe('scripts/uninstall.sh --purge takes a whole data folder only when it is Hatchabot\'s own (audit #025)', () => {
  /** The database moved into `dir` by .env; something of the household's beside it. */
  function movedTo(dir: string) {
    const w = purgeWorld();
    dockerShim(w, VOLS);
    mkdirSync(dir, { recursive: true });
    const db = join(dir, 'registry.sqlite');
    renameSync(join(w.repo, 'data', 'hatchabot.sqlite'), db);
    writeFileSync(join(dir, 'household-ledger.txt'), 'made-up household notes');
    writeFileSync(join(w.repo, '.env'), `HATCHABOT_SECRET_KEY=x\nHATCHABOT_DB=${db}\n`);
    return { w, db, r: run(w, ['--purge', '--yes']) };
  }

  it('a folder whose path only passes through a hatchabot-data* folder loses the database, not what is beside it', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-uninstall-shared-')); dirs.push(root);
    const shared = join(root, 'hatchabot-data-experiments', 'shared-files');
    const { db, r } = movedTo(shared);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(db)).toBe(false);
    expect(readFileSync(join(shared, 'household-ledger.txt'), 'utf8')).toBe('made-up household notes');
    expect(r.stdout).toContain('the folder is not Hatchabot\'s own, so it stays');
  });

  it('in a folder that is not Hatchabot\'s, what the app keeps beside its database stays and is named, its keys said (HB-1152)', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-uninstall-home-')); dirs.push(root);
    const home = join(root, 'household-files');
    mkdirSync(join(home, 'embed'), { recursive: true }); writeFileSync(join(home, 'embed', 'server-key'), 'made-up-embed-key');
    mkdirSync(join(home, 'models')); writeFileSync(join(home, 'models', 'made-up.gguf'), 'made-up model');
    const { db, r } = movedTo(home);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(db)).toBe(false);
    expect(readFileSync(join(home, 'embed', 'server-key'), 'utf8')).toBe('made-up-embed-key');
    expect(existsSync(join(home, 'models', 'made-up.gguf'))).toBe(true);
    expect(r.stdout).toContain(`kept embed/ models/ in ${home}: the app keeps them beside its database, and the folder is not Hatchabot's own, so they may be yours too.`);
    expect(r.stdout).toContain('embed/ holds the memory search service\'s keys');
    // A folder with nothing of the app's beside the database: nothing more to say.
    const bare = join(root, 'bare-folder');
    expect(movedTo(bare).r.stdout).not.toContain(`in ${bare}: the app keeps them`);
  });

  it('a folder named hatchabot-data is Hatchabot\'s own, and goes whole', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-uninstall-own-')); dirs.push(root);
    const own = join(root, 'hatchabot-data');
    const { r } = movedTo(own);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(own)).toBe(false);
  });
});

describe('scripts/uninstall.sh --purge and a data folder another database shares (HB-1052)', () => {
  /** A real SQLite database with a made-up row in it: another install's. */
  const otherDb = (file: string) => {
    mkdirSync(dirname(file), { recursive: true });
    const db = new Database(file);
    db.exec("CREATE TABLE settings (k TEXT, v TEXT); INSERT INTO settings VALUES ('household', 'the other made-up one')");
    db.close();
  };
  const rowOf = (file: string) => {
    expect(existsSync(file), `${file} is gone`).toBe(true);
    const db = new Database(file, { readonly: true });
    try { return db.prepare('SELECT v FROM settings').get(); } finally { db.close(); }
  };
  const folder = (name: string) => { const root = mkdtempSync(join(tmpdir(), 'hb-uninstall-shared-db-')); dirs.push(root); return join(root, name); };
  const moveCopies = (dbName: string) => `move-copies-${createHash('sha256').update(dbName).digest('hex').slice(0, 16)}`;

  /** This install's database moved into `dir` as `name`, with its -wal and -shm, and what the app keeps beside a database. */
  function sharedWith(dir: string, name = 'one.sqlite') {
    const w = purgeWorld();
    dockerShim(w, VOLS);
    mkdirSync(dir, { recursive: true });
    const db = join(dir, name);
    renameSync(join(w.repo, 'data', 'hatchabot.sqlite'), db);
    writeFileSync(`${db}-wal`, 'made-up wal'); writeFileSync(`${db}-shm`, 'made-up shm');
    writeFileSync(`${db}.lock`, ''); // the server's lock (HB-1436): empty
    writeFileSync(`${db}.rolled-back`, '2026-11-01T10:00:00Z\n'); // a rollback's note (HB-0840)
    writeFileSync(`${db}.rolled-back.prev`, '2026-10-30T10:00:00Z\n'); // and the one it stood in for (HB-1455)
    writeFileSync(`${db}.rolled-back.tmp`, '2026-11-0'); // and one cut off as it was written
    writeFileSync(`${db}.uses-this-folder`, `{"database":${JSON.stringify(db)}}\n`); // the mark its start leaves on the folder (HB-1151)
    writeFileSync(`${db}.uses-this-folder.4242.tmp`, '{"database":'); // the mark's, of a start that ended before its rename
    mkdirSync(join(dir, 'embed')); writeFileSync(join(dir, 'embed', 'server-key'), 'made-up-embed-key');
    mkdirSync(join(dir, 'derived-builds')); writeFileSync(join(dir, 'derived-builds', 'notes.log'), 'made-up build log');
    writeFileSync(join(w.repo, '.env'), `HATCHABOT_SECRET_KEY=x\nHATCHABOT_DB=${db}\n`);
    return { w, db };
  }

  it('purging one of two databases in a shared hatchabot-data or agentclaw-data leaves the other, its -wal and the folder', () => {
    for (const name of ['hatchabot-data', 'agentclaw-data']) {
      const shared = folder(name);
      const { w, db } = sharedWith(shared);
      const two = join(shared, 'two.sqlite');
      otherDb(two);
      writeFileSync(`${two}-wal`, 'the other install\'s made-up wal'); writeFileSync(`${two}-shm`, 'made-up shm');
      writeFileSync(`${two}.uses-this-folder`, `{"database":${JSON.stringify(two)}}\n`);
      writeFileSync(`${two}.uses-this-folder.4343.tmp`, '{"database":');
      writeFileSync(`${db}.uses-this-folder.notes.tmp`, 'not a temporary file of the mark');
      const r = run(w, ['--purge', '--yes']);
      expect(r.status, name + r.stdout + r.stderr).toBe(0);
      for (const f of [db, `${db}-wal`, `${db}-shm`, `${db}.lock`, `${db}.uses-this-folder`, `${db}.uses-this-folder.4242.tmp`]) expect(existsSync(f), f).toBe(false);
      // The other install's mark is its own, and no database (HB-1151), and
      // so are its temporary files, and a file named otherwise.
      expect(existsSync(`${two}.uses-this-folder`)).toBe(true);
      expect(existsSync(`${two}.uses-this-folder.4343.tmp`)).toBe(true);
      expect(existsSync(`${db}.uses-this-folder.notes.tmp`)).toBe(true);
      expect(r.stdout).not.toContain('uses-this-folder');
      expect(rowOf(two), name).toEqual({ v: 'the other made-up one' });
      expect(readFileSync(`${two}-wal`, 'utf8')).toBe('the other install\'s made-up wal');
      expect(existsSync(`${two}-shm`)).toBe(true);
      expect(r.stdout).toContain(`kept ${two}: another database`);
      expect(r.stdout).not.toContain(`kept ${two}-`); // its -wal and -shm are not more databases
      expect(r.stdout).toContain(`removed the database in ${shared} (another database shares the folder, so the folder stays)`);
      expect(r.stdout).not.toContain(`removed ${shared}`);
      // What the app keeps beside a database says nothing of whose it is: it stays, named, and its keys are said.
      expect(readFileSync(join(shared, 'embed', 'server-key'), 'utf8')).toBe('made-up-embed-key');
      expect(existsSync(join(shared, 'derived-builds', 'notes.log'))).toBe(true);
      expect(r.stdout).toContain(`kept derived-builds/ embed/ in ${shared}:`);
      expect(r.stdout).toContain('embed/ holds the memory search service\'s keys');
    }
  });

  it('another database by any name, in a folder below, or only what SQLite keeps beside one, keeps the folder too', () => {
    const cases: Array<[string, (dir: string) => string]> = [
      ['an SQLite file with no extension', (d) => { const f = join(d, 'registry'); otherDb(f); return f; }],
      ['an empty .db', (d) => { const f = join(d, 'household.db'); writeFileSync(f, ''); return f; }],
      ['a database in a folder below', (d) => { const f = join(d, 'test-install', 'hatchabot.sqlite'); otherDb(f); return f; }],
      ['only its -wal', (d) => { const f = join(d, 'three.sqlite-wal'); writeFileSync(f, 'made-up wal'); return f; }],
    ];
    for (const [what, make] of cases) {
      const shared = folder('hatchabot-data');
      const { w, db } = sharedWith(shared);
      const other = make(shared);
      const r = run(w, ['--purge', '--yes']);
      expect(r.status, what + r.stdout + r.stderr).toBe(0);
      expect(existsSync(db), what).toBe(false);
      expect(existsSync(other), what).toBe(true);
      expect(r.stdout, what).toContain(`kept ${other}: another database`);
    }
  });

  it('a database\'s -wal and -shm are named with it, not as more databases; past six, the rest are counted', () => {
    const shared = folder('hatchabot-data');
    const { w } = sharedWith(shared);
    const others = 'abcdefgh'.split('').map((c) => join(shared, `${c}.sqlite`));
    for (const f of others) { otherDb(f); writeFileSync(`${f}-wal`, 'made-up wal'); writeFileSync(`${f}-shm`, 'made-up shm'); }
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const named = r.stdout.split('\n').filter((l) => l.includes(': another database'));
    expect(named, r.stdout).toEqual(others.slice(0, 6).map((f) => `  kept ${f}: another database, not this install's (another install's, or a copy of one)`));
    expect(r.stdout).toContain(`  …and 2 more in ${shared}\n`);
    expect(r.stdout).not.toMatch(/-(wal|shm): /);
    for (const f of others) for (const g of [f, `${f}-wal`, `${f}-shm`]) expect(existsSync(g), g).toBe(true);
  });

  it('a file that cannot be read keeps the folder, and is said to be that, not a database', () => {
    if (process.getuid?.() === 0) return; // root reads everything
    const own = folder('hatchabot-data');
    const { w, db } = sharedWith(own, 'hatchabot.sqlite');
    const notes = join(own, 'notes.txt'); writeFileSync(notes, 'made-up notes', { mode: 0o000 });
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(db)).toBe(false);
    expect(existsSync(notes)).toBe(true);
    expect(r.stdout).toContain(`kept ${notes}: it cannot be read, so it may be another database`);
    expect(r.stdout).toContain(`removed the database in ${own} (part of it cannot be read, and may be another install's, so the folder stays)`);
    expect(r.stdout).not.toContain('another database, not this install\'s');
  });

  it('a folder in it that cannot be read, at the top or below, keeps the folder and what the app keeps there, and says so', () => {
    if (process.getuid?.() === 0) return; // root reads everything
    for (const where of ['locked', join('imports', 'locked')]) {
      const shared = folder('hatchabot-data');
      const { w, db } = sharedWith(shared);
      const locked = join(shared, where);
      otherDb(join(locked, 'two'));
      chmodSync(locked, 0o000);
      try {
        const r = run(w, ['--purge', '--yes']);
        expect(r.status, where + r.stdout + r.stderr).toBe(0);
        expect(r.stderr, where).not.toContain('Permission denied');
        expect(existsSync(db), where).toBe(false);
        expect(r.stdout, where).toContain(`kept ${locked}: it cannot be read, so it may hold another database`);
        expect(r.stdout, where).toContain(`removed the database in ${shared} (part of it cannot be read, and may be another install's, so the folder stays)`);
        expect(readFileSync(join(shared, 'embed', 'server-key'), 'utf8'), where).toBe('made-up-embed-key');
        expect(r.stdout, where).toContain('embed/ holds the memory search service\'s keys');
      } finally { chmodSync(locked, 0o755); }
      expect(rowOf(join(locked, 'two')), where).toEqual({ v: 'the other made-up one' });
    }
  });

  it('a binary file that is not a database is read without a warning, and the lone folder goes whole', () => {
    const own = folder('hatchabot-data');
    const { w } = sharedWith(own, 'hatchabot.sqlite');
    const binary = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    writeFileSync(join(own, 'photo.bin'), binary);
    mkdirSync(join(own, 'imports')); writeFileSync(join(own, 'imports', 'copy.tgz'), binary);
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/null byte/);
    expect(existsSync(own), r.stdout).toBe(false);
  });

  it('a big tree of other files is read for an SQLite header without a process per file, and one header in it still keeps the folder (HB-1153)', () => {
    const own = folder('hatchabot-data');
    const { w } = sharedWith(own, 'hatchabot.sqlite');
    const tree = join(own, 'imports', 'photos');
    mkdirSync(tree, { recursive: true });
    for (let i = 0; i < 40; i++) writeFileSync(join(tree, `p${i}.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, i, 0xc3, 0xa9, 0x00, 0x01]));
    writeFileSync(join(tree, 'notes.txt'), 'made-up notes, é and all\n');
    // head and tr as the system has them, each call noted.
    const calls = join(w.bin, '..', 'readers.log');
    for (const t of ['head', 'tr']) writeFileSync(join(w.bin, t), `#!/usr/bin/env bash\necho "${t} $*" >> ${JSON.stringify(calls)}\nfor d in /usr/bin /bin; do [ -x "$d/${t}" ] && exec "$d/${t}" "$@"; done\nexit 127\n`, { mode: 0o755 });
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(own), r.stdout).toBe(false); // none of them a database: the folder goes whole, as before
    const read = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter((l) => /^head -c|^tr -d .?\\000/.test(l)) : [];
    expect(read, read.join('\n')).toEqual([]);
    // A file under any name that begins as an SQLite file does is still found.
    const again = folder('hatchabot-data');
    const two = sharedWith(again, 'hatchabot.sqlite');
    mkdirSync(join(again, 'imports'), { recursive: true });
    otherDb(join(again, 'imports', 'registry'));
    const r2 = run(two.w, ['--purge', '--yes']);
    expect(r2.status, r2.stdout + r2.stderr).toBe(0);
    expect(r2.stdout).toContain(`kept ${join(again, 'imports', 'registry')}: another database`);
    expect(rowOf(join(again, 'imports', 'registry'))).toEqual({ v: 'the other made-up one' });
  });

  it('with this install\'s database already gone, the other one is still not taken with the folder', () => {
    const shared = folder('hatchabot-data');
    const { w, db } = sharedWith(shared);
    for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f);
    const two = join(shared, 'two.sqlite'); otherDb(two);
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(rowOf(two)).toEqual({ v: 'the other made-up one' });
    expect(r.stdout).not.toContain('removed the database');
    expect(r.stdout).toContain(`no database of this install's was left in ${shared}`);
    // The server's lock, left by the last one that ran, is no database: it goes, unsaid (HB-1436).
    expect(existsSync(`${db}.lock`)).toBe(false);
    expect(existsSync(`${db}.rolled-back`)).toBe(false); // nor is a rollback's note (HB-0840)
    expect(existsSync(`${db}.rolled-back.prev`)).toBe(false); // nor the one it stood in for (HB-1455)
    expect(existsSync(`${db}.rolled-back.tmp`)).toBe(false); // nor one cut off as it was written
    expect(existsSync(`${db}.uses-this-folder`)).toBe(false); // nor the mark its start left on the folder (HB-1151)
    expect(existsSync(`${db}.uses-this-folder.4242.tmp`)).toBe(false); // nor its temporary file a start left
  });

  it('alone in its hatchabot-data, agentclaw-data or the install\'s data/, the folder still goes whole, with what the app keeps there', () => {
    for (const name of ['hatchabot-data', 'agentclaw-data']) {
      const own = folder(name);
      const { w } = sharedWith(own, 'hatchabot.sqlite');
      mkdirSync(join(own, 'models')); writeFileSync(join(own, 'models', 'made-up.gguf'), 'made-up model');
      // The app's own folders are not searched for databases: what a CLI keeps in its scratch home is the app's.
      mkdirSync(join(own, 'mgmt-cli-home', '.cache'), { recursive: true }); writeFileSync(join(own, 'mgmt-cli-home', '.cache', 'state.db'), 'made-up');
      writeFileSync(join(own, 'limits-check.json'), '{}');
      const r = run(w, ['--purge', '--yes']);
      expect(r.status, name + r.stdout + r.stderr).toBe(0);
      expect(existsSync(own), name + r.stdout).toBe(false);
      expect(r.stdout).toContain(`removed ${own}`);
      expect(r.stdout).not.toContain('another database');
    }
    const w = purgeWorld();
    dockerShim(w, VOLS);
    const data = join(w.repo, 'data');
    writeFileSync(join(data, 'hatchabot.sqlite-wal'), 'made-up wal');
    mkdirSync(join(data, 'embed')); writeFileSync(join(data, 'embed', 'server-key'), 'made-up-embed-key');
    mkdirSync(join(data, 'release-manifests')); writeFileSync(join(data, 'release-manifests', 'v1.0.0.json'), '{}');
    writeFileSync(join(data, 'server.log'), 'made-up log');
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(data), r.stdout).toBe(false);
    expect(r.stdout).toContain(`removed ${data}`);
  });

  it('backups inside the data folder, whose sets hold copies of the database, are kept and not taken for another database', () => {
    const w = purgeWorld();
    dockerShim(w, VOLS);
    const data = join(w.repo, 'data');
    const set = join(data, 'backups', '2026-10-01'); mkdirSync(set, { recursive: true });
    copyFileSync(join(data, 'hatchabot.sqlite'), join(set, 'hatchabot.sqlite'));
    writeFileSync(join(set, 'backup-status.json'), '{}');
    writeFileSync(join(data, 'server.log'), 'made-up log');
    writeFileSync(join(w.repo, '.env'), `HATCHABOT_SECRET_KEY=x\nHATCHABOT_BACKUP_DIR=${join(data, 'backups')}\n`);
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(set, 'hatchabot.sqlite'))).toBe(true);
    expect(existsSync(join(data, 'hatchabot.sqlite'))).toBe(false);
    expect(existsSync(join(data, 'server.log'))).toBe(false);
    expect(r.stdout).toContain('except backups/');
    expect(r.stdout).not.toContain('another database');

    // With another database there as well, the backups and that database both stay.
    const w2 = purgeWorld();
    dockerShim(w2, VOLS);
    const data2 = join(w2.repo, 'data');
    const set2 = join(data2, 'backups', '2026-10-01'); mkdirSync(set2, { recursive: true });
    writeFileSync(join(set2, 'backup-status.json'), '{}');
    const two = join(data2, 'two.sqlite'); otherDb(two);
    writeFileSync(join(w2.repo, '.env'), `HATCHABOT_SECRET_KEY=x\nHATCHABOT_BACKUP_DIR=${join(data2, 'backups')}\n`);
    const r2 = run(w2, ['--purge', '--yes']);
    expect(r2.status, r2.stdout + r2.stderr).toBe(0);
    expect(existsSync(join(data2, 'hatchabot.sqlite'))).toBe(false);
    expect(rowOf(two)).toEqual({ v: 'the other made-up one' });
    expect(existsSync(join(set2, 'backup-status.json'))).toBe(true);
    expect(r2.stdout).toContain(`kept ${two}: another database`);
  });

  it('a hatchabot-data holding another database\'s move copies is kept, even with that database not there', () => {
    const shared = folder('hatchabot-data');
    const { w, db } = sharedWith(shared);
    const mine = join(shared, moveCopies('one.sqlite')), theirs = join(shared, moveCopies('two.sqlite'));
    for (const d of [mine, theirs]) { mkdirSync(d); writeFileSync(join(d, 'copy.tgz'), 'made-up volume'); }
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(db)).toBe(false);
    expect(existsSync(mine)).toBe(false);
    expect(readFileSync(join(theirs, 'copy.tgz'), 'utf8')).toBe('made-up volume');
    expect(r.stdout).toMatch(/move copies cannot be attributed/);
    expect(r.stdout).not.toContain(`removed ${shared}`);
  });
});

describe('scripts/uninstall.sh --purge and what other installs on the daemon use (review, 2026-10-09)', () => {
  it('an image another container uses is kept even when that container shows an ID, not the tag', () => {
    const w = purgeWorld();
    // Another container on the daemon, made from the image :latest names (docker ps shows it by ID).
    dockerShim(w, `${VOLS}
  "ps -aq") echo c0ffee000001 ;;
  "inspect --format {{.Image}} c0ffee000001") echo sha256:aaaa ;;
  "image inspect --format {{.Id}} hatchabot-runtime:latest") echo sha256:aaaa ;;`);
    const r = run(w, ['--purge', '--yes']);
    expect(r.stderr).toContain('keeping hatchabot-runtime:latest');
    expect(readFileSync(w.log, 'utf8')).not.toMatch(/docker rmi/);
  });

  it('while another Hatchabot install has containers here, the images and the network stay', () => {
    const w = purgeWorld();
    dockerShim(w, `${VOLS}
  "ps -aq --filter label=hatchabot.gen") echo beef00000002 ;;
  "image inspect --format {{.Id}} hatchabot-runtime:latest") echo sha256:bbbb ;;`);
    const r = run(w, ['--purge', '--yes']);
    expect(r.stderr).toContain('another Hatchabot install');
    const calls = readFileSync(w.log, 'utf8');
    expect(calls).not.toMatch(/docker rmi/);
    expect(calls).not.toMatch(/docker network rm hatchabot-agents/);
    expect(r.stdout).toContain('kept the hatchabot-agents network');
  });

  it('alone on the daemon: the unused image goes, and the network by the name its .env gives', () => {
    const w = purgeWorld();
    dockerShim(w, `${VOLS}
  "image inspect --format {{.Id}} hatchabot-runtime:latest") echo sha256:cccc ;;`);
    writeFileSync(join(w.repo, '.env'), 'HATCHABOT_SECRET_KEY=x\nHATCHABOT_AGENT_NETWORK=test-agents-net\n');
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const calls = readFileSync(w.log, 'utf8');
    expect(calls).toContain('docker rmi -f hatchabot-runtime:latest');
    expect(calls).toContain('docker network rm test-agents-net');
    expect(calls).not.toContain('docker network rm hatchabot-agents');
  });
});

describe('scripts/uninstall.sh --purge deletes only the runtime images this install names (HB-0043)', () => {
  it('the tags its agents and classes name and the default tag go; an image of another name stays, and so does one not on the machine', () => {
    const w = purgeWorld();
    const db = new Database(join(w.repo, 'data', 'hatchabot.sqlite'));
    db.prepare("UPDATE agents SET image = 'hatchabot-runtime:derived-notes' WHERE id = '11111111-aaaa'").run();
    db.prepare("UPDATE agents SET image = 'example.org/someone-else:1' WHERE id = '22222222-bbbb'").run();
    db.exec("CREATE TABLE agent_classes (id TEXT, image TEXT); INSERT INTO agent_classes VALUES ('c1', 'hatchabot-runtime:class-gone'), ('c2', 'hatchabot-runtime:derived-notes')");
    db.close();
    dockerShim(w, `${VOLS}
  "image inspect --format {{.Id}} hatchabot-runtime:latest") echo sha256:dddd ;;
  "image inspect --format {{.Id}} hatchabot-runtime:derived-notes") echo sha256:eeee ;;
  "image inspect --format {{.Id}} example.org/someone-else:1") echo sha256:ffff ;;
  "image inspect --format {{.Id}} hatchabot-runtime:class-gone") exit 1 ;;`);
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const rmi = readFileSync(w.log, 'utf8').split('\n').filter((l) => l.startsWith('docker rmi'));
    expect(rmi).toEqual(['docker rmi -f hatchabot-runtime:derived-notes hatchabot-runtime:latest']);
    expect(r.stdout).toContain('removed 2 images');
  });
});

describe('scripts/uninstall.sh on a bundle install (review, 2026-10-09)', () => {
  it('removes the ~/.local/bin launchers that run this install, and leaves anyone else\'s', () => {
    const w = world();
    rmSync(join(w.repo, 'data', 'hatchabot.sqlite'));
    const bin = join(w.home, '.local', 'bin'); mkdirSync(bin, { recursive: true });
    const launcher = (dir: string) => `#!/usr/bin/env bash\n# Hatchabot (hatchabot) — written by scripts/link-cli.sh\nexec "${dir}/.node/bin/node" "${dir}/bin/hatchabot.mjs" "$@"\n`;
    writeFileSync(join(bin, 'hatchabot'), launcher(w.repo), { mode: 0o755 });
    writeFileSync(join(bin, 'hbt'), launcher('/srv/another-install'), { mode: 0o755 });
    const r = run(w, ['--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(bin, 'hatchabot'))).toBe(false);
    expect(existsSync(join(bin, 'hbt'))).toBe(true);
  });
});

describe('scripts/uninstall.sh unlinks only its own CLI (audit #029)', () => {
  /** A CLI in this install and in another; npm's global folder in the sandbox, linking `hatchabot` to `globalTo`. */
  function linked(w: ReturnType<typeof world>, globalTo: 'mine' | 'other') {
    rmSync(join(w.repo, 'data', 'hatchabot.sqlite'));
    const other = join(dirname(w.repo), 'other-install');
    for (const dir of [w.repo, other]) { mkdirSync(join(dir, 'bin'), { recursive: true }); writeFileSync(join(dir, 'bin', 'hatchabot.mjs'), '// made-up CLI\n'); }
    const global = join(dirname(w.repo), 'npm-global', 'lib', 'node_modules'); mkdirSync(global, { recursive: true });
    symlinkSync(globalTo === 'mine' ? w.repo : other, join(global, 'hatchabot'));
    writeFileSync(join(w.bin, 'npm'), `#!/usr/bin/env bash\necho "npm $*" >> ${JSON.stringify(w.log)}\n[ "$*" = "root -g" ] && echo ${JSON.stringify(global)}\nexit 0\n`, { mode: 0o755 });
    return { other, global };
  }

  it('an hbt that runs another install\'s CLI stays, and so does a global npm link to it', () => {
    const w = world();
    const { other } = linked(w, 'other');
    symlinkSync(join(other, 'bin', 'hatchabot.mjs'), join(w.bin, 'hbt'));
    const r = run(w, ['--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(w.bin, 'hbt'))).toBe(true);
    expect(r.stdout).toContain('kept the global hatchabot command: it runs another install');
    expect(readFileSync(w.log, 'utf8')).not.toContain('npm unlink');
  });

  it('this install\'s hbt (through npm link\'s chain) and its global link go', () => {
    const w = world();
    const { global } = linked(w, 'mine');
    symlinkSync(join(global, 'hatchabot', 'bin', 'hatchabot.mjs'), join(w.bin, 'hatchabot'));
    symlinkSync(join(w.bin, 'hatchabot'), join(w.bin, 'hbt'));
    const r = run(w, ['--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('removed hbt');
    expect(existsSync(join(w.bin, 'hbt'))).toBe(false);
    expect(readFileSync(w.log, 'utf8')).toContain('npm unlink -g hatchabot');
  });
});

describe('scripts/uninstall.sh finds, stops and reports every runtime of its agents (HB-0282, HB-0343, HB-0344, HB-0345)', () => {
  type Row = { id: string; name: string; ref: string; state: string; host?: string };
  /** A database as the app writes it (agents with a state, hosts), and the module to read it. */
  function stateWorld(rows: Row[]) {
    const w = world();
    rmSync(join(w.repo, 'data', 'hatchabot.sqlite'));
    const db = new Database(join(w.repo, 'data', 'hatchabot.sqlite'));
    db.exec('CREATE TABLE hosts (id TEXT, kind TEXT, name TEXT, settings TEXT); CREATE TABLE agents (id TEXT, name TEXT, state TEXT, host_id TEXT, runtime_ref TEXT, image TEXT)');
    db.prepare('INSERT INTO hosts VALUES (?, ?, ?, ?)').run('h-local', 'local', 'This machine', '{}');
    db.prepare('INSERT INTO hosts VALUES (?, ?, ?, ?)').run('h-runner', 'cloud', 'Garage box', JSON.stringify({ dockerHost: 'ssh://garage-box.example.test' }));
    for (const r of rows) db.prepare('INSERT INTO agents VALUES (?, ?, ?, ?, ?, NULL)').run(r.id, r.name, r.state, r.host ?? 'h-local', r.ref);
    db.close();
    symlinkSync(dirname(dirname(createRequire(import.meta.url).resolve('better-sqlite3/package.json'))), join(w.repo, 'node_modules'));
    return w;
  }
  const calls = (w: ReturnType<typeof world>) => (existsSync(w.log) ? readFileSync(w.log, 'utf8').split('\n').filter(Boolean) : []);
  const LEGACY = { id: '123456ab-cdef-4000-8000-000000000001', name: 'Meal Planner', ref: 'docker://123456abcdef', state: 'RUNNING' };
  const MODERN = { id: '22222222-bbbb', name: 'Garden Notes', ref: 'docker://hatchabot-garden-notes-22222222', state: 'RUNNING' };

  it('an agent from before slugs (docker://<short id>) is stopped under the name the provider gives it, agentclaw-<short>', () => {
    const w = stateWorld([LEGACY]);
    dockerShim(w, `*"ps -aq --filter name=^/agentclaw-123456abcdef$"*) echo legacy1 ;;`);
    const r = run(w, ['--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(calls(w)).toContain('docker stop legacy1');
    expect(r.stdout).toContain('stopped 1 containers');
    expect(calls(w).join('\n')).not.toContain('name=^/123456abcdef$');
  });

  it('--purge removes a legacy agent\'s container and its agentclaw-vol-<short> volume', () => {
    const w = stateWorld([LEGACY]);
    dockerShim(w, `*"ps -aq --filter name=^/agentclaw-123456abcdef$"*) echo legacy1 ;;\n  ${VOLS}`);
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(calls(w)).toContain('docker rm -f legacy1');
    expect(calls(w)).toContain('docker volume rm agentclaw-vol-123456abcdef');
    expect(r.stdout).toContain('removed 1 volumes');
  });

  it('a stop Docker refuses: names the agent still running, never says Hatchabot is no longer running, and exits 1', () => {
    const w = stateWorld([MODERN]);
    dockerShim(w, `"ps -aq --filter name=^/hatchabot-garden-notes-22222222$") echo garden1 ;;
  "ps -q --filter name=^/hatchabot-garden-notes-22222222$") echo garden1 ;;
  "stop garden1") echo "Error response from daemon: cannot stop container: garden1: permission denied" >&2; exit 1 ;;`);
    const r = run(w, ['--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('could NOT stop 1 of 1 containers: Error response from daemon: cannot stop container');
    expect(r.stdout).not.toContain('stopped 1 containers');
    expect(r.stdout).not.toContain('Hatchabot is no longer running');
    expect(r.stdout).toMatch(/still running \(Docker would not stop them\):\n {2}· hatchabot-garden-notes-22222222/);
  });

  it('a stop that failed for an agent no longer running (gone meanwhile) is a stop', () => {
    const w = stateWorld([MODERN]);
    dockerShim(w, `"ps -aq --filter name=^/hatchabot-garden-notes-22222222$") echo garden1 ;;
  "stop garden1") echo "Error response from daemon: No such container: garden1" >&2; exit 1 ;;`);
    const r = run(w, ['--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('stopped 1 containers');
    expect(r.stdout).toContain('Hatchabot is no longer running');
  });

  it('a --purge whose stop was refused but whose removal worked ends clean', () => {
    const w = stateWorld([MODERN]);
    dockerShim(w, `"ps -aq --filter name=^/hatchabot-garden-notes-22222222$") echo garden1 ;;
  "ps -q --filter name=^/hatchabot-garden-notes-22222222$") echo garden1 ;;
  "stop garden1") exit 1 ;;
  ${VOLS}`);
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(calls(w)).toContain('docker rm -f garden1');
    expect(r.stdout).toContain('Hatchabot is no longer running');
  });

  it('a --purge whose agent Docker will neither stop nor remove keeps the database and .env, and exits 1', () => {
    const w = stateWorld([MODERN]);
    dockerShim(w, `"ps -aq --filter name=^/hatchabot-garden-notes-22222222$") echo garden1 ;;
  "ps -q --filter name=^/hatchabot-garden-notes-22222222$") echo garden1 ;;
  "stop garden1"|"rm -f garden1") exit 1 ;;
  ${VOLS}`);
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/still running \(Docker would not remove them\):\n {2}· hatchabot-garden-notes-22222222/);
    expect(existsSync(join(w.repo, 'data', 'hatchabot.sqlite'))).toBe(true);
    expect(existsSync(join(w.repo, '.env'))).toBe(true);
  });

  it('each agent\'s browser is removed, before the agent it shares a network with is stopped', () => {
    const w = stateWorld([MODERN]);
    dockerShim(w, `"ps -aq --filter name=^/hatchabot-garden-notes-22222222$") echo garden1 ;;
  "ps -aq --filter label=hatchabot.role=browser --filter label=hatchabot.browser-of=hatchabot-garden-notes-22222222") echo browser1 ;;`);
    const r = run(w, ['--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const c = calls(w);
    expect(c).toContain('docker rm -f browser1');
    expect(c.indexOf('docker rm -f browser1')).toBeLessThan(c.indexOf('docker stop garden1'));
    expect(r.stdout).toContain('removed 1 service containers (doormen, browsers, memory search)');
  });

  it('--purge removes the logins each agent\'s browser kept, by the agent they belong to; without it they stay (HB-0680)', () => {
    const KEPT = `"volume ls -q --filter label=hatchabot.role=browser-logins --filter label=hatchabot.browser-of=hatchabot-garden-notes-22222222") echo hatchabot-garden-notes-22222222-browser-logins-0a1b2c3d4e5f ;;
  ${VOLS}`;
    const w = stateWorld([MODERN]);
    dockerShim(w, KEPT);
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(calls(w)).toContain('docker volume rm hatchabot-garden-notes-22222222-browser-logins-0a1b2c3d4e5f');
    expect(calls(w)).toContain('docker volume rm hatchabot-garden-notes-22222222-vol');

    const kept = stateWorld([MODERN]);
    dockerShim(kept, KEPT);
    const k = run(kept, ['--yes']);
    expect(k.status, k.stdout + k.stderr).toBe(0);
    expect(calls(kept).filter((c) => c.startsWith('docker volume rm'))).toEqual([]);
  });

  it('--purge is not held back by agents on a runner that were deleted in the app; one that is not deleted still holds it', () => {
    const gone = { id: '33333333-cccc', name: 'Chore Chart', ref: 'docker://hatchabot-chore-chart-33333333', state: 'DELETED', host: 'h-runner' };
    const w = stateWorld([MODERN, gone]);
    dockerShim(w, VOLS);
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain('another machine');
    expect(existsSync(join(w.repo, 'data', 'hatchabot.sqlite'))).toBe(false);

    const held = stateWorld([MODERN, { ...gone, state: 'ARCHIVED' }]);
    const h = run(held, ['--purge', '--yes']);
    expect(h.status, h.stdout + h.stderr).toBe(2);
    expect(h.stdout).toContain('Chore Chart (on Garage box: ssh://garage-box.example.test)');
    expect(existsSync(join(held.repo, 'data', 'hatchabot.sqlite'))).toBe(true);
  });
});

describe('scripts/uninstall.sh --purge and a database reached through a link (HB-1443)', () => {
  /**
   * This install's HATCHABOT_DB a link, in `linkDir`, to its real database in
   * a folder of its own; every command it may reach a shim. `stuck`: the
   * stuck agent's volume cannot be removed (purgeWorld's docker). `runner`:
   * one of its agents runs on a runner.
   */
  function linkedWorld(linkDir: (w: ReturnType<typeof world>) => string, opts: { stuck?: boolean; runner?: boolean } = {}) {
    const w = purgeWorld();
    if (!opts.stuck) dockerShim(w, VOLS);
    if (opts.runner) {
      const d = new Database(join(w.repo, 'data', 'hatchabot.sqlite'));
      d.exec('DROP TABLE agents; CREATE TABLE hosts (id TEXT, kind TEXT, name TEXT, settings TEXT); CREATE TABLE agents (id TEXT, name TEXT, host_id TEXT, runtime_ref TEXT, image TEXT)');
      d.prepare('INSERT INTO hosts VALUES (?, ?, ?, ?)').run('h-local', 'local', 'This machine', '{}');
      d.prepare('INSERT INTO hosts VALUES (?, ?, ?, ?)').run('h-runner', 'cloud', 'Garage box', JSON.stringify({ dockerHost: 'ssh://garage-box.example.test' }));
      d.prepare('INSERT INTO agents VALUES (?, ?, ?, ?, NULL)').run('11111111-aaaa', 'Meal Planner', 'h-local', 'docker://hatchabot-meal-planner-11111111');
      d.prepare('INSERT INTO agents VALUES (?, ?, ?, ?, NULL)').run('22222222-bbbb', 'Garden Notes', 'h-runner', 'docker://hatchabot-garden-notes-22222222');
      d.close();
    }
    for (const tool of ['podman', 'ssh', 'openclaw']) {
      writeFileSync(join(w.bin, tool), `#!/usr/bin/env bash\necho "${tool} $*" >> ${JSON.stringify(w.log)}\nexit 0\n`, { mode: 0o755 });
    }
    const real = join(dirname(w.repo), 'moved-data');
    mkdirSync(real);
    const db = join(real, 'hatchabot.sqlite');
    renameSync(join(w.repo, 'data', 'hatchabot.sqlite'), db);
    // What SQLite and the server keep beside the file the link leads to.
    writeFileSync(`${db}-wal`, 'made-up wal'); writeFileSync(`${db}-shm`, 'made-up shm'); writeFileSync(`${db}.lock`, '');
    const dir = linkDir(w);
    mkdirSync(dir, { recursive: true });
    const link = join(dir, 'hatchabot.sqlite');
    symlinkSync(db, link);
    writeFileSync(join(w.repo, '.env'), `HATCHABOT_SECRET_KEY=x\nHATCHABOT_DB=${link}\n`);
    return { w, db: join(realpathSync(real), 'hatchabot.sqlite'), link };
  }

  it('the link goes and the database it leads to is named as kept, never said to be removed, in a folder of Hatchabot\'s or not', () => {
    for (const [where, linkDir] of [
      ['the install\'s data/', (w: ReturnType<typeof world>) => join(w.repo, 'data')],
      ['a folder not Hatchabot\'s', (w: ReturnType<typeof world>) => join(dirname(w.repo), 'household-files')],
    ] as const) {
      const { w, db, link } = linkedWorld(linkDir);
      const r = run(w, ['--purge', '--yes']);
      expect(r.status, where + r.stdout + r.stderr).toBe(0);
      expect((() => { try { lstatSync(link); return true; } catch { return false; } })(), `${where}: the link`).toBe(false);
      for (const f of [db, `${db}-wal`, `${db}-shm`, `${db}.lock`]) expect(existsSync(f), `${where}: ${f}`).toBe(true);
      expect(r.stdout, where).toContain(`kept ${db}, the database ${link} was a link to, and whichever of its -wal, -shm and .lock are beside it: only the link was removed.`);
      expect(r.stdout, where).not.toContain('removed the database');
      expect(r.stdout, where).not.toContain('database are gone');
      expect(r.stdout, where).toContain(`the database it led to is kept, at ${db}.`);
      expect(readFileSync(w.log, 'utf8'), where).not.toMatch(/^(podman|ssh|openclaw) /m);
    }
  });

  it('with a volume left, or an agent left on a runner, the summary still says the database is kept, not gone (review)', () => {
    for (const [what, opts, args, status, says] of [
      ['a volume left', { stuck: true }, ['--purge', '--yes'], 1, 'Its agents and the link to its database are gone (the database it led to is kept, at DB), but these agent volumes are NOT'],
      ['a runner', { runner: true }, ['--purge', '--forget-runners', '--yes'], 0, 'Its agents on this machine, their volumes and the link to its database are gone (the database it led to is kept, at DB). These still run on their runners'],
    ] as const) {
      const { w, db } = linkedWorld((x) => join(x.repo, 'data'), opts);
      const r = run(w, [...args]);
      expect(r.status, what + r.stdout + r.stderr).toBe(status);
      for (const f of [db, `${db}-wal`, `${db}-shm`, `${db}.lock`]) expect(existsSync(f), `${what}: ${f}`).toBe(true);
      expect(r.stdout, what).toContain(says.replace('DB', db));
      expect(r.stdout, what).not.toMatch(/and (the )?database are gone/);
      expect(readFileSync(w.log, 'utf8'), what).not.toMatch(/^(podman|ssh|openclaw) /m);
    }
  });
});
