import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { scriptEnv } from './helpers/scriptEnv.js';

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
