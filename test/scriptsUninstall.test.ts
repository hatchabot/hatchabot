import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  writeFileSync(join(repo, 'scripts', 'uninstall.sh'), readFileSync('scripts/uninstall.sh'), { mode: 0o755 });
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
const run = (w: ReturnType<typeof world>, args: string[]) =>
  spawnSync('bash', [join(w.repo, 'scripts', 'uninstall.sh'), ...args], {
    // A minimal PATH: the script removes the `hbt` shim it finds on PATH, and with the
    // user's PATH it removed the machine's real one (2026-09-27). Only the shims and the system dirs.
    // Built from scratch, never from process.env: a HATCHABOT_DB exported in the
    // shell running the tests reached the script, and --purge removed THAT
    // data directory (review, 2026-10-09).
    encoding: 'utf8', env: scriptEnv(w.home, `${w.bin}:/usr/bin:/bin`),
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

  it('a folder named hatchabot-data is Hatchabot\'s own, and goes whole', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-uninstall-own-')); dirs.push(root);
    const own = join(root, 'hatchabot-data');
    const { r } = movedTo(own);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(own)).toBe(false);
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
