/**
 * scripts/restore-drill.sh in a sandbox (docs/recovery-readiness-design.md):
 * a temp HOME and backups directory, a PATH of shims (docker is a shim that
 * logs its arguments and "restores" by extracting into a temp dir), an
 * install folder that links this checkout's node_modules and src (the key
 * check imports the secret store), git hooks off, an env built from scratch.
 * It checks the drill's record, and that each restore is isolated: no
 * network, limits, nothing of the set mounted but that one archive.
 */
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { listDrills } from '../src/orchestrator/backups/drills.js';
import { LocalSecretStore } from '../src/secrets/localSecretStore.js';
import { systemPathWithout } from './helpers/scriptEnv.js';

// These run the restore drill on real sets: 1-2 s alone, past vitest's 5 s
// when the self-hosted runner shares the machine (PR #76, 2026-11-05).
vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const repo = resolve(import.meta.dirname, '..');

function drillWorld() {
  const root = tmp('hb-drillrec-');
  const install = join(root, 'install');
  mkdirSync(join(install, 'scripts'), { recursive: true });
  for (const f of ['restore-drill.sh', 'backup-owner.sh']) writeFileSync(join(install, 'scripts', f), readFileSync(join(repo, 'scripts', f)), { mode: 0o755 });
  symlinkSync(join(repo, 'node_modules'), join(install, 'node_modules'));
  symlinkSync(join(repo, 'src'), join(install, 'src'));
  const home = join(root, 'home'); mkdirSync(home);
  const backups = join(root, 'backups'); mkdirSync(backups);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const log = join(root, 'docker.log');
  // docker: logs every call; `run` extracts the one archive it was given into
  // a temp dir and counts the files under agents/, as the real command does.
  // A volume named *broken* fails to extract. DRILL_CTS and DRILL_VOLS are
// drills' containers and volumes already there, "<name>|<label value>" each;
// a label filter lists those it matches, by key alone or key=value. Once the
// file DRILL_RM_HANG names is there, removing a container or a volume never
// answers (30 s).
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash
echo "$*" >> "${log}"
labelled() {
  local f="" a e
  for a in "$@"; do case "$a" in label=*) f="\${a#label=}";; esac; done
  for e in $LIST; do
    case "$f" in hatchabot.restore-drill|"hatchabot.restore-drill=\${e#*|}") echo "\${e%%|*}" ;; esac
  done
}
case "$1" in
  version|image) exit 0 ;;
  ps) LIST="\${DRILL_CTS:-}" labelled "$@"; exit 0 ;;
  volume)
    case "$2" in
      ls) case "$*" in *label=*) LIST="\${DRILL_VOLS:-}" labelled "$@" ;; *) echo "hatchabot-kitchen-1-vol"; echo "acl-restore-drill-123" ;; esac ;;
      rm) [ ! -e "\${DRILL_RM_HANG:-/nonexistent}" ] || sleep 30 ;;
    esac
    exit 0 ;;
  rm) [ ! -e "\${DRILL_RM_HANG:-/nonexistent}" ] || sleep 30; exit 0 ;;
  run)
    # Once the file DRILL_RUN_HANG names is made, the restore never answers. Its
    # client passes a TERM on to the container (where the restore's shell, PID 1,
    # ignores it) and waits, as docker run does unless --sig-proxy=false.
    if [ -n "\${DRILL_RUN_HANG:-}" ]; then
      case "$*" in *--sig-proxy=false*) ;; *) trap '' TERM ;; esac
      touch "\$DRILL_RUN_HANG"; n=0
      while [ $n -lt 600 ] && [ -d "${root}" ]; do sleep 0.1; n=$((n + 1)); done
      exit 0
    fi
    [ -z "\${DRILL_SLOW:-}" ] || { touch "\$DRILL_SLOW"; sleep 2; }
    tgz=""
    for a in "$@"; do case "$a" in *:/in/vol.tgz:ro) tgz="\${a%%:/in/vol.tgz:ro}";; esac; done
    case "$tgz" in *broken*) exit 2;; esac
    out="$(mktemp -d)"; tar xzf "$tgz" -C "$out" || exit 2
    find "$out/.openclaw/agents" "$out/agents" -type f 2>/dev/null | wc -l
    rm -rf "$out"; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
  /** A set: its database (with the tables the drill counts), its key, its archives. */
  const set = (date: string, vols: Record<string, string[] | 'torn'>, opts: { state?: string; key?: boolean; db?: boolean; captured?: string[] } = {}) => {
    const d = join(backups, date); mkdirSync(d, { recursive: true });
    if (opts.db !== false) {
      const db = new Database(join(d, 'hatchabot.sqlite'));
      db.exec(`CREATE TABLE agents (state TEXT); CREATE TABLE ai_profiles (id TEXT); CREATE TABLE channels (id TEXT); CREATE TABLE secrets (ref TEXT, value TEXT)`);
      db.close();
    }
    if (opts.key !== false) writeFileSync(join(d, 'secret-key.env'), 'HATCHABOT_SECRET_KEY=not-a-real-key-for-tests\n');
    if (opts.state) writeFileSync(join(d, 'backup-status.json'), JSON.stringify({ state: opts.state, startedAt: `${date}T03:30:00Z`, ...(opts.captured ? { captured: opts.captured } : {}) }));
    for (const [vol, files] of Object.entries(vols)) {
      if (files === 'torn') { writeFileSync(join(d, `${vol}.tgz`), 'not gzip'); continue; }
      const tree = join(root, 'trees', vol);
      for (const f of files) { mkdirSync(dirname(join(tree, f)), { recursive: true }); writeFileSync(join(tree, f), 'x'); }
      mkdirSync(tree, { recursive: true });
      const r = spawnSync('tar', ['czf', join(d, `${vol}.tgz`), '-C', tree, '.']);
      expect(r.status).toBe(0);
    }
    return d;
  };
  const run = (env: Record<string, string> = {}, args: string[] = []) => spawnSync('bash', [join(install, 'scripts', 'restore-drill.sh'), ...args], {
    encoding: 'utf8',
    env: {
      HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HATCHABOT_BACKUP_DIR: backups,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
      ...env,
    },
  });
  const dockerLog = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  const records = () => (existsSync(join(backups, 'drills')) ? readdirSync(join(backups, 'drills')).filter((f) => f.endsWith('.json')).sort() : []);
  const lastRecord = () => JSON.parse(readFileSync(join(backups, 'drills', records().pop()!), 'utf8'));
  /** The label value of this backups folder's drills: a checksum of its drills folder's path, as the script makes it. */
  const owner = () => spawnSync('bash', ['-c', 'printf "%s\\n" "$0" | cksum | cut -d" " -f1', join(realpathSync(backups), 'drills')], { encoding: 'utf8' }).stdout.trim();
  return { root, install, backups, set, run, dockerLog, records, lastRecord, owner };
}

const LAYOUT = ['.openclaw/agents/main/agent/auth-profiles.json', '.openclaw/openclaw.json'];

describe('the drill writes a record of every run', () => {
  it('it says whose it is, by the mark a backup set carries, so an uninstall can tell it from another install\'s (HB-0440)', () => {
    const w = drillWorld();
    w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    expect(w.run({ HATCHABOT_SECRET_KEY: 'not-a-real-key-for-tests' }).status).toBe(0);
    expect(w.lastRecord().owner).toBe(createHash('sha256').update('hatchabot-backup-owner\0not-a-real-key-for-tests').digest('hex').slice(0, 16));
    const none = drillWorld();
    none.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    expect(none.run({}).status).toBe(0);
    // No key here: the drilled set's own mark, from the key it saved (review of HB-0540; was '').
    expect(none.lastRecord().owner).toBe(createHash('sha256').update('hatchabot-backup-owner\0not-a-real-key-for-tests').digest('hex').slice(0, 16));
    const unmarked = drillWorld();
    unmarked.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete', key: false });
    unmarked.run({}); // fails its key check (no key saved): the record is what is read here
    expect(unmarked.lastRecord()).toMatchObject({ set: '2026-10-08', owner: '' }); // nothing says whose
  });
  it('with scripts/backup-owner.sh missing it says so and still drills, and writes its record, naming no install (thirteenth review)', () => {
    const w = drillWorld();
    w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    rmSync(join(w.install, 'scripts', 'backup-owner.sh'));
    const r = w.run({ HATCHABOT_SECRET_KEY: 'not-a-real-key-for-tests' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toContain(`Could not read ${w.install}/scripts/backup-owner.sh: this drill cannot tell whose sets are whose`);
    expect(w.lastRecord()).toMatchObject({ set: '2026-10-08', result: 'passed', owner: '' });
  });
  it('a passing set: each archive read, its layout found, restored in isolation; the record says so', () => {
    const w = drillWorld();
    const d = w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT, 'hatchabot-notes-2-vol': [...LAYOUT, '.openclaw/workspace/notes.md'] }, { state: 'complete' });
    const r = w.run({ HATCHABOT_DRILL_TRIGGER: 'scheduled' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Restore drill passed/);
    const rec = w.lastRecord();
    expect(rec).toMatchObject({
      version: 1, set: '2026-10-08', setState: 'complete', trigger: 'scheduled', result: 'passed', database: 'ok', key: 'ok',
      isolation: { network: 'none', memory: '1g', cpus: '1' },
    });
    expect(rec.volumes).toEqual([
      { volume: 'hatchabot-kitchen-1-vol', readable: true, layout: true, restored: true, note: '', result: 'passed' },
      { volume: 'hatchabot-notes-2-vol', readable: true, layout: true, restored: true, note: '', result: 'passed' },
    ]);
    expect(typeof rec.durationSec).toBe('number');
    // Owner-only: the folder 0700, the record 0600.
    expect(statSync(join(w.backups, 'drills')).mode & 0o777).toBe(0o700);
    expect(statSync(join(w.backups, 'drills', w.records()[0]!)).mode & 0o777).toBe(0o600);
    // The app reads it back.
    expect(listDrills(w.backups)[0]).toMatchObject({ set: '2026-10-08', passed: true, trigger: 'scheduled' });

    // Every restore isolated: no network, limits, bash as the entrypoint, only
    // its one archive mounted read-only (never the set: its database and key).
    const runs = w.dockerLog().split('\n').filter((l) => l.startsWith('run '));
    expect(runs).toHaveLength(2);
    for (const l of runs) {
      for (const flag of ['--network none', '--memory 1g', '--memory-swap 1g', '--cpus 1', '--pids-limit 256', '--security-opt no-new-privileges', '--entrypoint bash', `--label hatchabot.restore-drill=${w.owner()}`]) expect(l, flag).toContain(flag);
      const mounts = [...l.matchAll(/-v (\S+)/g)].map((m) => m[1]!);
      expect(mounts).toHaveLength(2);
      expect(mounts[0]).toMatch(/^hatchabot-restore-drill-\d+-\d+:\/data$/);
      expect(mounts[1]).toMatch(new RegExp(`^${d}/hatchabot-(kitchen-1|notes-2)-vol\\.tgz:/in/vol\\.tgz:ro$`));
      expect(l).not.toContain(`${d}:`);
    }
    // The larger archive first (the old drill's one restore).
    expect(runs[0]).toContain('notes-2-vol.tgz');
    // Each throwaway volume is made labelled, and removed.
    const made = [...w.dockerLog().matchAll(new RegExp(`volume create --label hatchabot.restore-drill=${w.owner()} (\\S+)`, 'g'))].map((m) => m[1]);
    expect(made).toHaveLength(2);
    for (const v of made) expect(w.dockerLog()).toContain(`volume rm -f ${v}`);
  });

  it('a drill stopped by a signal (the app\'s time limit, a restart) is recorded failed, not passed (HB-0368)', async () => {
    const w = drillWorld();
    w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT, 'hatchabot-notes-2-vol': LAYOUT }, { state: 'complete' });
    const started = join(w.root, 'restoring');
    const c = spawn('bash', [join(w.install, 'scripts', 'restore-drill.sh')], {
      env: { HOME: join(w.root, 'home'), PATH: `${join(w.root, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`, HATCHABOT_BACKUP_DIR: w.backups, DRILL_SLOW: started },
      stdio: 'ignore',
    });
    const t0 = Date.now();
    while (!existsSync(started) && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(started)).toBe(true);
    c.kill('SIGTERM');
    const code = await new Promise<number | null>((r) => c.on('exit', (n) => r(n)));
    expect(code).toBe(143);
    expect(w.lastRecord().result).toBe('failed');
  }, 30_000);

  const realTimeout = spawnSync('bash', ['-c', 'command -v timeout'], { encoding: 'utf8' }).stdout.trim();
  it.skipIf(!realTimeout)('a drill stopped while Docker does not answer: its clean-up is bounded, and it still ends with its record (HB-0924)', async () => {
    const w = drillWorld();
    w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    // timeout as a shim: the clean-up's 45 seconds made one, the rest as asked.
    writeFileSync(join(w.root, 'bin', 'timeout'), `#!/usr/bin/env bash
o=(); k=(); while :; do case "$1" in --foreground) o=(--foreground); shift ;; -k) k=(-k "$2"); shift 2 ;; *) break ;; esac; done
d="$1"; shift
if [ "$d" = 45 ]; then echo "$*" >> "${w.root}/bounded.log"; k=(-k 1); d=1; fi
exec "${realTimeout}" "\${o[@]}" "\${k[@]}" "$d" "$@"
`, { mode: 0o755 });
    const started = join(w.root, 'restoring');
    const c = spawn('bash', [join(w.install, 'scripts', 'restore-drill.sh')], {
      env: { HOME: join(w.root, 'home'), PATH: `${join(w.root, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`, HATCHABOT_BACKUP_DIR: w.backups, DRILL_SLOW: started, DRILL_RM_HANG: started },
      stdio: 'ignore',
    });
    const t0 = Date.now();
    while (!existsSync(started) && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(started)).toBe(true);
    c.kill('SIGTERM');
    const code = await new Promise<number | null>((r) => c.on('exit', (n) => r(n)));
    expect(code).toBe(143);
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(w.lastRecord().result).toBe('failed');
    expect(readFileSync(join(w.root, 'bounded.log'), 'utf8')).toMatch(/^docker rm -f hatchabot-restore-drill-\d+-1\ndocker volume rm -f hatchabot-restore-drill-\d+-1\n$/);
  }, 60_000);

  it.skipIf(!realTimeout)('stopped at its time limit in a restore under the real timeout: the TERM reaches the docker client, and the trap writes its record and removes its container and volume (review of HB-0924)', async () => {
    const { scriptDeadline } = await import('../src/orchestrator/backups/backupFiles.js');
    const w = drillWorld();
    w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    const started = join(w.root, 'restoring');
    // In a process group of its own, as the app starts it (startDrill).
    const c = spawn('bash', [join(w.install, 'scripts', 'restore-drill.sh')], {
      env: { HOME: join(w.root, 'home'), PATH: `${join(w.root, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`, HATCHABOT_BACKUP_DIR: w.backups, DRILL_RUN_HANG: started },
      stdio: 'ignore', detached: true,
    });
    const t0 = Date.now();
    while (!existsSync(started) && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(started)).toBe(true);
    let stopped = false;
    const closed = new Promise<number | null>((r) => c.on('close', (code) => r(code)));
    const callOff = scriptDeadline(c, 0, 25_000, { term: () => {}, stopped: () => { stopped = true; } });
    const code = await closed;
    callOff();
    expect(stopped).toBe(false); // it ended by itself, its trap run, before anything was killed
    expect(code).toBe(143);
    expect(w.lastRecord().result).toBe('failed');
    const log = w.dockerLog();
    expect(log).toMatch(/^rm -f hatchabot-restore-drill-\d+-1$/m);
    expect(log).toMatch(/^volume rm -f hatchabot-restore-drill-\d+-1$/m);
  }, 40_000);

  it.skipIf(!realTimeout)('a restore that takes longer than its 15 minutes says so, and its container is removed (review of HB-0924)', async () => {
    const w = drillWorld();
    w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    // timeout as a shim: the restore's 15 minutes made one second, the rest as asked.
    writeFileSync(join(w.root, 'bin', 'timeout'), `#!/usr/bin/env bash
o=(); k=(); while :; do case "$1" in --foreground) o=(--foreground); shift ;; -k) k=(-k 1); shift 2 ;; *) break ;; esac; done
d="$1"; shift; [ "$d" != 900 ] || d=1
exec "${realTimeout}" "\${o[@]}" "\${k[@]}" "$d" "$@"
`, { mode: 0o755 });
    const r = w.run({ DRILL_RUN_HANG: join(w.root, 'restoring') });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('restoring it took longer than 15 minutes — stopped');
    expect(r.stderr).not.toMatch(/failed to extract/);
    expect(w.lastRecord().result).toBe('failed');
    expect(w.dockerLog()).toMatch(/^rm -f hatchabot-restore-drill-\d+-1$/m);
  }, 30_000);

  it.skipIf(!realTimeout)('a Mac with Homebrew\'s coreutils but not its gnubin (gtimeout, no timeout): a restore that hangs is still stopped (HB-1208)', async () => {
    const w = drillWorld();
    w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    const bin = join(w.root, 'bin');
    // gtimeout as a shim: the restore's 15 minutes made one second, the rest as asked.
    writeFileSync(join(bin, 'gtimeout'), `#!/usr/bin/env bash
echo "$*" >> "${w.root}/gtimeout.log"
o=(); k=(); while :; do case "$1" in --foreground) o=(--foreground); shift ;; -k) k=(-k 1); shift 2 ;; *) break ;; esac; done
d="$1"; shift; [ "$d" != 900 ] || d=1
exec "${realTimeout}" "\${o[@]}" "\${k[@]}" "$d" "$@"
`, { mode: 0o755 });
    symlinkSync(process.execPath, join(bin, 'node'));
    const r = w.run({ DRILL_RUN_HANG: join(w.root, 'restoring'), PATH: `${bin}:${systemPathWithout(join(w.root, 'system'), ['timeout', 'gtimeout'])}` });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain('restoring it took longer than 15 minutes — stopped');
    expect(w.lastRecord().result).toBe('failed');
    expect(readFileSync(join(w.root, 'gtimeout.log'), 'utf8')).toMatch(/^--foreground -k 10 900 docker run --rm --name hatchabot-restore-drill-/m);
  }, 30_000);

  it('what a killed drill left behind is removed first; another install\'s running drill and a live volume are never touched (HB-0327)', () => {
    const w = drillWorld();
    w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    const dead = spawnSync('bash', ['-c', 'echo $$']).stdout.toString().trim();
    const live = String(process.pid);
    const left = [
      `hatchabot-restore-drill-${live}-1|${w.owner()}`, // this folder's: its lock is free, so no drill uses it (a pid since reused)
      `hatchabot-restore-drill-${dead}-2|4242`, // another folder's drill, killed
      `hatchabot-restore-drill-${live}-3|4242`, // another folder's drill, running
      `hatchabot-restore-drill-${dead}-4|1`, // from before the folder label, killed
      `hatchabot-restore-drill-${live}-5|1`, // from before the folder label, running
    ].join(' ');
    const r = w.run({ DRILL_CTS: left, DRILL_VOLS: left });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    for (const n of [1, 2, 4]) {
      const name = `hatchabot-restore-drill-${n === 1 ? live : dead}-${n}`;
      expect(w.dockerLog().split('\n'), name).toContain(`rm -f ${name}`);
      expect(w.dockerLog().split('\n'), name).toContain(`volume rm -f ${name}`);
    }
    for (const n of [3, 5]) expect(w.dockerLog()).not.toContain(`hatchabot-restore-drill-${live}-${n}\n`);
    expect(w.dockerLog()).toContain('volume rm -f acl-restore-drill-123'); // the old drill's name
    expect(w.dockerLog()).not.toContain('volume rm -f hatchabot-kitchen-1-vol');
  });

  it('a torn archive, one with no OpenClaw files, one that will not extract: each named, the drill fails, the record says which', () => {
    const w = drillWorld();
    w.set('2026-10-08', {
      'hatchabot-kitchen-1-vol': LAYOUT,
      'hatchabot-torn-2-vol': 'torn',
      'hatchabot-empty-3-vol': ['.openclaw/notagents/README'],
      'hatchabot-broken-4-vol': LAYOUT,
    }, { state: 'complete' });
    const r = w.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/hatchabot-torn-2-vol: unreadable archive/);
    expect(r.stderr).toMatch(/hatchabot-empty-3-vol: archive reads, but holds no files under agents\//);
    expect(r.stderr).toMatch(/hatchabot-broken-4-vol: failed to extract into a fresh volume/);
    const rec = w.lastRecord();
    expect(rec.result).toBe('failed');
    const by = Object.fromEntries(rec.volumes.map((v: { volume: string }) => [v.volume, v]));
    expect(by['hatchabot-kitchen-1-vol']).toMatchObject({ result: 'passed', restored: true });
    expect(by['hatchabot-torn-2-vol']).toMatchObject({ readable: false, restored: null, note: 'unreadable', result: 'failed' });
    expect(by['hatchabot-empty-3-vol']).toMatchObject({ readable: true, layout: false, restored: null, note: 'layout', result: 'failed' });
    expect(by['hatchabot-broken-4-vol']).toMatchObject({ readable: true, layout: true, restored: false, note: 'extract', result: 'failed' });
    // Only archives that read whole with the layout are restored.
    expect(w.dockerLog()).not.toMatch(/torn-2-vol\.tgz:\/in|empty-3-vol\.tgz:\/in/);
  });

  it('an archive the set\'s record says was captured, gone from the set: named missing, the drill fails (HB-0276)', () => {
    const w = drillWorld();
    w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete', captured: ['hatchabot-kitchen-1-vol', 'hatchabot-notes-2-vol'] });
    const r = w.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/hatchabot-notes-2-vol: the set's record says it was captured, but its archive is not in the set/);
    expect(r.stdout).not.toMatch(/would bring the system back/);
    const rec = w.lastRecord();
    expect(rec.result).toBe('failed');
    expect(rec.volumes).toEqual([
      { volume: 'hatchabot-kitchen-1-vol', readable: true, layout: true, restored: true, note: '', result: 'passed' },
      { volume: 'hatchabot-notes-2-vol', readable: null, layout: null, restored: null, note: 'missing', result: 'failed' },
    ]);
    expect(listDrills(w.backups)[0]!.volumes[1]).toMatchObject({ volume: 'hatchabot-notes-2-vol', passed: false, note: 'missing' });
    // Never restored: there is nothing to mount.
    expect(w.dockerLog()).not.toContain('notes-2-vol');
    // Every archive the record names there: it passes as before.
    w.set('2026-10-09', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete', captured: ['hatchabot-kitchen-1-vol'] });
    expect(w.run().status).toBe(0);
  });

  it("the saved key passes when it reads any of the set's secrets, beside one from an older key, as the backup's own check does; none read, it fails (HB-1228 review)", async () => {
    /** A set whose database holds secrets stored with these keys, in this order, as the service stores them. */
    const withSecrets = async (w: ReturnType<typeof drillWorld>, keys: string[]) => {
      const d = w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete', db: false });
      const db = new Database(join(d, 'hatchabot.sqlite'));
      db.exec('CREATE TABLE agents (state TEXT); CREATE TABLE ai_profiles (id TEXT); CREATE TABLE channels (id TEXT)');
      for (const [i, k] of keys.entries()) {
        await new LocalSecretStore(db, LocalSecretStore.keyFromEnv({ HATCHABOT_SECRET_KEY: k })).put(`channel/made-up-${i}/bot-token`, 'made-up-secret-value');
      }
      db.close();
    };
    const mixed = drillWorld();
    await withSecrets(mixed, ['another-made-up-key', 'not-a-real-key-for-tests']);
    const r = mixed.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('✓ backed-up key decrypts channel/made-up-1/bot-token (20 chars — not shown)');
    expect(mixed.lastRecord()).toMatchObject({ result: 'passed', key: 'ok' });
    const wrong = drillWorld();
    await withSecrets(wrong, ['another-made-up-key', 'another-made-up-key']);
    const f = wrong.run();
    expect(f.status).toBe(1);
    expect(f.stderr).toContain('the backed-up key decrypts none of the 2 secrets');
    expect(f.stderr).toContain('✗ The backed-up key could NOT decrypt the backed-up secrets');
    expect(wrong.lastRecord()).toMatchObject({ result: 'failed', key: 'failed' });
  });

  it('no database copy: the archives are still checked and recorded, the drill fails', () => {
    const w = drillWorld();
    w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete', db: false });
    const r = w.run();
    expect(r.status).toBe(1);
    expect(w.lastRecord()).toMatchObject({ result: 'failed', database: 'missing', key: 'failed', volumes: [{ volume: 'hatchabot-kitchen-1-vol', result: 'passed' }] });
  });

  it('no complete set: recorded with the reason, nothing drilled, docker never called', () => {
    const w = drillWorld();
    w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'incomplete' });
    const r = w.run();
    expect(r.status).toBe(1);
    expect(w.lastRecord()).toMatchObject({ set: '', result: 'failed', reason: 'no-complete-set', volumes: [] });
    expect(w.dockerLog()).toBe('');
  });

  it('another install\'s newer set in a shared folder is passed over: the drill proves this install\'s own (HB-0540)', () => {
    const w = drillWorld();
    const KEY = 'not-a-real-key-for-tests';
    const markOf = (k: string) => createHash('sha256').update(`hatchabot-backup-owner\0${k}`).digest('hex').slice(0, 16);
    w.set('2026-10-07', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' }); // from before the mark: its saved key says whose
    const marked = w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    writeFileSync(join(marked, '.backup-owner'), `${markOf('another-made-up-key')}\n`);
    const r = w.run({ HATCHABOT_SECRET_KEY: KEY });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toContain("2026-10-08 is another Hatchabot install's set — passing over it");
    expect(w.lastRecord()).toMatchObject({ set: '2026-10-07', result: 'passed', owner: markOf(KEY) });
    // Only another install's: none of this install's to prove.
    const only = drillWorld();
    const theirs = only.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    writeFileSync(join(theirs, '.backup-owner'), `${markOf('another-made-up-key')}\n`);
    expect(only.run({ HATCHABOT_SECRET_KEY: KEY }).status).toBe(1);
    expect(only.lastRecord()).toMatchObject({ set: '', reason: 'no-complete-set' });
    expect(only.dockerLog()).toBe('');
  });

  it('with no key of its own it passes over no set, as the app does, and its record names the drilled set\'s install (review of HB-0540)', () => {
    const markOf = (k: string) => createHash('sha256').update(`hatchabot-backup-owner\0${k}`).digest('hex').slice(0, 16);
    const w = drillWorld();
    const marked = w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    writeFileSync(join(marked, '.backup-owner'), `${markOf('another-made-up-key')}\n`);
    const r = w.run(); // no HATCHABOT_SECRET_KEY, and no .env beside the script
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).not.toContain('passing over it');
    expect(w.lastRecord()).toMatchObject({ set: '2026-10-08', result: 'passed', owner: markOf('another-made-up-key') });
    // A set from before the mark: the key it saved says whose.
    const old = drillWorld();
    old.set('2026-10-07', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    expect(old.run().status).toBe(0);
    expect(old.lastRecord()).toMatchObject({ set: '2026-10-07', owner: markOf('not-a-real-key-for-tests') });
  });

  it('another install\'s set drilled by hand is recorded as that install\'s, not this one\'s (second review of HB-0540)', () => {
    const markOf = (k: string) => createHash('sha256').update(`hatchabot-backup-owner\0${k}`).digest('hex').slice(0, 16);
    const w = drillWorld();
    const theirs = w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    writeFileSync(join(theirs, '.backup-owner'), `${markOf('another-made-up-key')}\n`);
    const r = w.run({ HATCHABOT_SECRET_KEY: 'not-a-real-key-for-tests' }, [theirs]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toContain("another Hatchabot install's set");
    expect(w.lastRecord()).toMatchObject({ set: '2026-10-08', result: 'passed', owner: markOf('another-made-up-key') });
    // So this install's readiness has no drill of its own; the other's sees it.
    expect(listDrills(w.backups, markOf('not-a-real-key-for-tests'))).toEqual([]);
    expect(listDrills(w.backups, markOf('another-made-up-key'))).toHaveLength(1);
  });

  it('another install\'s set drilled from here leaves that install\'s records alone: this one prunes only its own (ninth review)', () => {
    const markOf = (k: string) => createHash('sha256').update(`hatchabot-backup-owner\0${k}`).digest('hex').slice(0, 16);
    const w = drillWorld();
    const theirs = w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    writeFileSync(join(theirs, '.backup-owner'), `${markOf('another-made-up-key')}\n`);
    const drills = join(w.backups, 'drills'); mkdirSync(drills, { recursive: true });
    for (let i = 0; i < 40; i++) writeFileSync(join(drills, `2026-02-01T00-00-${String(i).padStart(2, '0')}Z.json`), JSON.stringify({ version: 1, set: '2026-10-01', result: 'passed', owner: markOf('another-made-up-key') }) + '\n');
    const r = w.run({ HATCHABOT_SECRET_KEY: 'not-a-real-key-for-tests' }, [theirs]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.lastRecord()).toMatchObject({ set: '2026-10-08', owner: markOf('another-made-up-key') });
    // Its 40 and the one written for it here: none pruned by this install.
    expect(w.records().filter((f) => JSON.parse(readFileSync(join(drills, f), 'utf8')).owner === markOf('another-made-up-key'))).toHaveLength(41);
  });

  it('a set\'s owner is read once, and only for a set the drill would take (second review of HB-0540)', () => {
    const w = drillWorld();
    // Sets from before the owner file: each one's owner is a node run on the key it saved.
    w.set('2026-10-06', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    w.set('2026-10-07', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'running' });
    const nodeLog = join(w.root, 'node.log');
    writeFileSync(join(w.root, 'bin', 'node'), `#!/bin/sh\nfor a in "$@"; do case "$a" in */secret-key.env) echo "$a" >> "${nodeLog}" ;; esac; done\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
    const r = w.run({ HATCHABOT_SECRET_KEY: 'not-a-real-key-for-tests' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.lastRecord()).toMatchObject({ set: '2026-10-07', result: 'passed' });
    // The running set is passed over by its record alone; the one taken, read once; the older one, not at all.
    expect(readFileSync(nodeLog, 'utf8').trim().split('\n').map((l) => l.split('/').slice(-2, -1)[0])).toEqual(['2026-10-07']);
  });

  it('the newest 30 drill records of each install are kept: another\'s drills do not push this one\'s out (second review of HB-0540)', () => {
    const markOf = (k: string) => createHash('sha256').update(`hatchabot-backup-owner\0${k}`).digest('hex').slice(0, 16);
    const w = drillWorld();
    w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    const drills = join(w.backups, 'drills'); mkdirSync(drills, { recursive: true });
    const rec = (stamp: string, owner: string) => writeFileSync(join(drills, `${stamp}.json`), JSON.stringify({ version: 1, set: '2026-10-01', result: 'passed', owner }) + '\n');
    for (let i = 0; i < 31; i++) rec(`2026-01-01T00-00-${String(i).padStart(2, '0')}Z`, markOf('not-a-real-key-for-tests'));
    for (let i = 0; i < 40; i++) rec(`2026-02-01T00-00-${String(i).padStart(2, '0')}Z`, markOf('another-made-up-key'));
    // What reads the records: logged, then the real tool (third review: one pass, not a fork per record).
    const reads = join(w.root, 'record-reads.log');
    for (const tool of ['sed', 'awk']) {
      const real = spawnSync('sh', ['-c', `PATH=/usr/bin:/bin command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      writeFileSync(join(w.root, 'bin', tool), `#!/bin/sh\ncase "$*" in *drills/20*) echo ${tool} >> ${JSON.stringify(reads)} ;; esac\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
    }
    const r = w.run({ HATCHABOT_SECRET_KEY: 'not-a-real-key-for-tests' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(reads, 'utf8').trim().split('\n')).toEqual(['awk']);
    const by = (k: string) => w.records().filter((f) => JSON.parse(readFileSync(join(drills, f), 'utf8')).owner === markOf(k));
    const mine = by('not-a-real-key-for-tests');
    expect(mine).toHaveLength(30); // this run's and the newest 29 before it: the two oldest went
    expect(mine).not.toContain('2026-01-01T00-00-00Z.json');
    expect(mine).not.toContain('2026-01-01T00-00-01Z.json');
    expect(by('another-made-up-key')).toHaveLength(40); // left to that install's own drills
    // And the app finds this install's, under the other's newer ones.
    const seen = listDrills(w.backups, markOf('not-a-real-key-for-tests'));
    expect(seen).toHaveLength(30);
    expect(seen[0]).toMatchObject({ set: '2026-10-08', passed: true });
  });

  it.skipIf(process.getuid?.() === 0)('a record it cannot read (another user\'s) never stops the trap: the drill still cleans up and lets go of its lock (fourth review of HB-0540)', () => {
    const w = drillWorld();
    w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    const drills = join(w.backups, 'drills'); mkdirSync(drills, { recursive: true });
    const theirs = join(drills, '2026-01-01T00-00-00Z.json');
    writeFileSync(theirs, JSON.stringify({ version: 1, set: '2026-10-01', result: 'passed', owner: '0'.repeat(16) }) + '\n', { mode: 0o000 });
    const tmp = join(w.root, 'drill-tmp'); mkdirSync(tmp);
    try {
      const r = w.run({ TMPDIR: tmp });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toMatch(/Restore drill passed/);
      expect(existsSync(join(drills, '.lock')), 'the lock').toBe(false);
      expect(readdirSync(tmp).filter((n) => !n.startsWith('tsx-')), 'its scratch folder').toEqual([]); // tsx's own cache aside
      expect(w.records().filter((f) => f !== '2026-01-01T00-00-00Z.json')).toHaveLength(1); // this run's
      expect(existsSync(theirs)).toBe(true); // not this install's to prune
    } finally { rmSync(theirs, { force: true }); }
  });

  it('one drill at a time; a dead drill\'s lock is taken over; the newest 30 records are kept', () => {
    const w = drillWorld();
    w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    const lock = join(w.backups, 'drills', '.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), String(process.pid)); // alive: this test
    const busy = w.run();
    expect(busy.status).toBe(1);
    expect(busy.stderr).toMatch(/Another restore drill \(pid \d+\) is running/);
    expect(w.records()).toEqual([]);
    expect(existsSync(lock)).toBe(true);
    const dead = spawnSync('bash', ['-c', 'echo $$']).stdout.toString().trim();
    writeFileSync(join(lock, 'pid'), dead);
    for (let i = 0; i < 32; i++) writeFileSync(join(w.backups, 'drills', `2026-01-01T00-00-${String(i).padStart(2, '0')}Z.json`), '{}');
    const again = w.run();
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(existsSync(lock)).toBe(false);
    expect(w.records()).toHaveLength(30);
    expect(w.lastRecord()).toMatchObject({ result: 'passed' }); // the newest is this run's
  });

  it('run by hand, it finds the backups folder the install\'s .env names; the environment still wins (HB-0324)', () => {
    const w = drillWorld();
    w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    writeFileSync(join(w.install, '.env'), `HATCHABOT_BACKUP_DIR=${w.backups}\n`);
    const r = w.run({ HATCHABOT_BACKUP_DIR: undefined as unknown as string });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`Drilling restore from: ${join(w.backups, '2026-10-08')}`);
    expect(w.lastRecord()).toMatchObject({ set: '2026-10-08', result: 'passed' });
    const elsewhere = join(w.root, 'elsewhere'); mkdirSync(elsewhere);
    const env = w.run({ HATCHABOT_BACKUP_DIR: elsewhere });
    expect(env.status).toBe(1);
    expect(env.stderr).toContain(`No complete backup set under ${elsewhere}`);
  });

  it('run by hand, it reads .env as the service and the backup do: a # in a value on Linux, a $VAR on a Mac (HB-1231)', () => {
    for (const mac of [false, true]) {
      const w = drillWorld();
      w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
      const nightly = join(w.root, mac ? 'nightly' : 'nightly#1');
      renameSync(w.backups, nightly);
      if (mac) {
        writeFileSync(join(w.root, 'bin', 'uname'), '#!/usr/bin/env bash\necho Darwin\n', { mode: 0o755 });
        writeFileSync(join(w.install, '.env'), `FIXTURE_ROOT=${w.root}\nHATCHABOT_BACKUP_DIR="$FIXTURE_ROOT/nightly"\n`);
      } else {
        writeFileSync(join(w.install, '.env'), `HATCHABOT_BACKUP_DIR=${nightly}\n`);
      }
      const r = w.run({ HATCHABOT_BACKUP_DIR: undefined as unknown as string });
      expect(r.status, `${mac ? 'Mac' : 'Linux'}: ${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout).toContain(`Drilling restore from: ${join(nightly, '2026-10-08')}`);
    }
  });

  it('docker not answering: the archives are read and recorded, nothing restored, the drill fails', () => {
    const w = drillWorld();
    w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    writeFileSync(join(w.root, 'bin', 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const r = w.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/docker is not answering/);
    expect(w.lastRecord().volumes).toEqual([{ volume: 'hatchabot-kitchen-1-vol', readable: true, layout: true, restored: null, note: 'nodocker', result: 'passed' }]);
  });
});

describe('the drill lock', () => {
  it('two drills that find the same dead drill\'s lock: exactly one takes it over (HB-0347)', async () => {
    const root = tmp('hb-drilllock-');
    const dir = join(root, 'drills'); const gate = join(root, 'gate'); const bin = join(root, 'bin');
    mkdirSync(join(dir, '.lock'), { recursive: true }); mkdirSync(gate); mkdirSync(bin);
    const dead = spawnSync('bash', ['-c', 'echo $$']).stdout.toString().trim();
    writeFileSync(join(dir, '.lock', 'pid'), dead);
    // cat holds each drill, the dead pid read, until the other has read it
    // too: the race, every time.
    writeFileSync(join(bin, 'cat'), `#!/usr/bin/env bash
text="$(/bin/cat "$@")" || exit
case "$1" in */.lock/pid) [ -e "${gate}/$DRILL" ] || { : > "${gate}/$DRILL"; for _ in $(seq 1 400); do [ "$(ls "${gate}" | wc -l)" -ge 2 ] && break; sleep 0.01; done; } ;; esac
printf '%s\\n' "$text"
`, { mode: 0o755 });
    const source = readFileSync(join(repo, 'scripts', 'restore-drill.sh'), 'utf8');
    const funcs = source.slice(source.indexOf('take_lock() {'), source.indexOf('\ntrap finish EXIT'));
    const start = (n: number) => new Promise<{ code: number | null; out: string }>((done) => {
      const c = spawn('bash', ['-c', `set -euo pipefail\nLOCK=""\n${funcs}\ntake_lock\necho entered\nsleep 0.3`], {
        env: { PATH: `${bin}:/usr/bin:/bin`, RECORD_DIR: dir, HOME: root, DRILL: String(n) },
      });
      let out = '';
      c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
      c.on('close', (code) => done({ code, out }));
    });
    const both = await Promise.all([start(1), start(2)]);
    expect(readdirSync(gate)).toHaveLength(2);
    expect(both.map((r) => r.code).sort()).toEqual([0, 1]);
    expect(both.filter((r) => r.out.includes('entered'))).toHaveLength(1);
    expect(both.find((r) => r.code === 1)!.out).toMatch(/Another restore drill/);
    expect(existsSync(join(dir, '.lock.takeover'))).toBe(false);
  });

  it('a killed drill\'s pid that a process of this same user has since: taken over once older than a drill runs, its start differing or none recorded; one whose start matches is held however old (HB-1033, and its review: a clock step)', () => {
    const root = tmp('hb-drilllock-');
    const dir = join(root, 'drills');
    const lock = join(dir, '.lock');
    const source = readFileSync(join(repo, 'scripts', 'restore-drill.sh'), 'utf8');
    const funcs = source.slice(source.indexOf('take_lock() {'), source.indexOf('\ntrap finish EXIT'));
    const take = () => spawnSync('bash', ['-c', `set -euo pipefail\nLOCK=""\n${funcs}\ntake_lock\necho entered`], {
      env: { PATH: '/usr/bin:/bin', RECORD_DIR: dir, HOME: root }, encoding: 'utf8',
    });
    const startOf = (pid: number) => spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' } }).stdout.trim().replace(/\s+/g, ' ');
    const busy = new RegExp(`Another restore drill \\(pid ${process.pid}\\) is running`);
    // This test's own process stands for the long-lived one the pid went to.
    const fresh = (started?: string) => {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, 'pid'), String(process.pid));
      if (started !== undefined) writeFileSync(join(lock, 'started'), `${started}\n`);
    };
    const age = () => { const then = new Date(Date.now() - 4 * 3600_000); utimesSync(lock, then, then); };
    // A start that differs: the pid another's now, or the drill's own after a
    // step of the clock moved what ps says. Held while a drill could run...
    fresh('Thu Jan  1 00:00:00 1970');
    const stepped = take();
    expect(stepped.status).toBe(1);
    expect(stepped.stderr).toMatch(busy);
    // ...and taken once older than one runs.
    age();
    const reused = take();
    expect(reused.status, reused.stderr).toBe(0);
    expect(reused.stdout).toContain('entered');
    expect(readFileSync(join(lock, 'pid'), 'utf8').trim()).not.toBe(String(process.pid));
    expect(readFileSync(join(lock, 'started'), 'utf8').trim()).toMatch(/\d\d:\d\d:\d\d/); // the new holder's own
    // The holder it names, started when it says: held, however old.
    fresh(startOf(process.pid));
    age();
    expect(take().stderr).toMatch(busy);
    // No start recorded (a lock an older drill made): held while a drill could run, taken once older.
    fresh();
    expect(take().status).toBe(1);
    age();
    const old = take();
    expect(old.status, old.stderr).toBe(0);
    expect(old.stdout).toContain('entered');
  });

  // pid 1 is another user's process here (kill -0 says "not permitted"),
  // unless the tests run as root or in a namespace of their own.
  const foreign = /not permitted/.test(spawnSync('bash', ['-c', 'LC_ALL=C kill -0 1'], { encoding: 'utf8' }).stderr);
  it.skipIf(!foreign)('a lock whose pid is another user\'s process: held while a drill could run, taken over once it is older (HB-0347)', () => {
    const root = tmp('hb-drilllock-');
    const dir = join(root, 'drills');
    const lock = join(dir, '.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), '1');
    const source = readFileSync(join(repo, 'scripts', 'restore-drill.sh'), 'utf8');
    const funcs = source.slice(source.indexOf('take_lock() {'), source.indexOf('\ntrap finish EXIT'));
    const take = () => spawnSync('bash', ['-c', `set -euo pipefail\nLOCK=""\n${funcs}\ntake_lock\necho entered`], {
      env: { PATH: '/usr/bin:/bin', RECORD_DIR: dir, HOME: root }, encoding: 'utf8',
    });
    const fresh = take();
    expect(fresh.status).toBe(1);
    expect(fresh.stderr).toMatch(/Another restore drill \(pid 1\) is running/);
    const then = new Date(Date.now() - 4 * 3600_000);
    utimesSync(lock, then, then);
    const stale = take();
    expect(stale.status, stale.stderr).toBe(0);
    expect(stale.stdout).toContain('entered');
    expect(readFileSync(join(lock, 'pid'), 'utf8').trim()).not.toBe('1');
  });
});

describe('every docker call the drill makes has a time limit (HB-1374)', () => {
  const realTimeout = spawnSync('bash', ['-c', 'command -v timeout'], { encoding: 'utf8' }).stdout.trim();
  /**
   * timeout as a shim, logging each call ("<seconds> <command>"): the short
   * calls' minute, and a volume list's two, made one second. docker as a
   * shim in front of the world's, that never answers (30 s) to the call
   * DRILL_HANG names; with DRILL_STUBBORN, deaf to the TERM too, so the
   * time limit has to kill it (137).
   */
  function bounded() {
    const w = drillWorld();
    w.set('2026-10-08', { 'hatchabot-kitchen-1-vol': LAYOUT }, { state: 'complete' });
    const front = join(w.root, 'front'); mkdirSync(front);
    writeFileSync(join(front, 'timeout'), `#!/usr/bin/env bash
o=(); k=(); while :; do case "$1" in --foreground) o=(--foreground); shift ;; -k) k=(-k 1); shift 2 ;; *) break ;; esac; done
d="$1"; shift; echo "$d $*" >> "${w.root}/timeout.log"; case "$d" in 60|120) d=1 ;; esac
exec "${realTimeout}" "\${o[@]}" "\${k[@]}" "$d" "$@"
`, { mode: 0o755 });
    writeFileSync(join(front, 'docker'), `#!/usr/bin/env bash
case " $* " in *" \${DRILL_HANG:-no call} "*) [ -z "\${DRILL_STUBBORN:-}" ] || trap '' TERM; exec sleep 30 ;; esac
exec "${join(w.root, 'bin', 'docker')}" "$@"
`, { mode: 0o755 });
    const run = (hang?: string, stubborn = false) => {
      const t0 = Date.now();
      const r = spawnSync('bash', [join(w.install, 'scripts', 'restore-drill.sh')], {
        encoding: 'utf8', timeout: 25_000,
        env: {
          HOME: join(w.root, 'home'), PATH: `${front}:${join(w.root, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`, HATCHABOT_BACKUP_DIR: w.backups,
          GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
          ...(hang ? { DRILL_HANG: hang } : {}), ...(stubborn ? { DRILL_STUBBORN: '1' } : {}),
        },
      });
      return { ...r, took: Date.now() - t0 };
    };
    // Its docker calls (the first, "5 true", asks whether it takes --foreground).
    const limited = () => (existsSync(join(w.root, 'timeout.log')) ? readFileSync(join(w.root, 'timeout.log'), 'utf8').split('\n').filter((l) => / docker /.test(l)) : []);
    return { w, run, limited };
  }

  it.skipIf(!realTimeout)('each call goes through the time limit: the short ones a minute, a volume list two, the restore its 15', () => {
    const { w, run, limited } = bounded();
    const r = run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const calls = w.dockerLog().split('\n').filter(Boolean);
    expect(calls.length).toBeGreaterThanOrEqual(8);
    const viaLimit = limited().map((l) => l.replace(/^\d+ docker /, ''));
    expect(viaLimit).toEqual(calls);
    for (const l of limited()) expect(l, l).toMatch(/^(60 docker (?!run |volume ls)|120 docker volume ls|900 docker run )/);
    for (const call of ['version', 'image inspect', 'ps -a', 'volume create', 'rm -f', 'volume rm -f']) expect(limited().some((l) => l.startsWith(`60 docker ${call} `) || l === `60 docker ${call}`), call).toBe(true);
    expect(limited().filter((l) => l.startsWith('120 docker volume ls'))).toHaveLength(3);
  });

  it.skipIf(!realTimeout)('a daemon that never answers one of them no longer holds the drill: it ends, with its record', () => {
    for (const hang of ['version', 'inspect', 'ps', 'ls', 'create', 'rm']) {
      const { w, run } = bounded();
      const r = run(hang);
      expect(r.status, `${hang}: ${r.stdout}${r.stderr}`).not.toBeNull();
      expect(r.took, hang).toBeLessThan(20_000);
      const rec = w.lastRecord();
      if (hang === 'version') {
        expect(r.stderr).toContain('docker is not answering');
        expect(rec).toMatchObject({ result: 'failed', volumes: [{ restored: null, note: 'nodocker' }] });
      } else if (hang === 'create') {
        expect(r.stderr).toContain('hatchabot-kitchen-1-vol: docker did not answer within 60 seconds when asked for a throwaway volume — not restored');
        expect(r.stderr).not.toContain('took longer than 15 minutes');
        expect(rec.volumes[0]).toMatchObject({ restored: false, note: 'nodocker', result: 'failed' });
      } else if (hang === 'inspect') {
        // Not answered about, the image is not swapped for one that may need a pull from that daemon (review of HB-1374).
        expect(r.stderr).toContain('docker did not answer within 60 seconds when asked about the image');
        expect(w.dockerLog()).not.toMatch(/debian:stable-slim/);
        expect(rec).toMatchObject({ result: 'failed', volumes: [{ restored: null, note: 'nodocker' }] });
      } else {
        // The rest only find or remove what a drill left: it still restores.
        expect(rec.result, `${hang}: ${r.stdout}${r.stderr}`).toBe('passed');
      }
    }
  }, 120_000);

  it.skipIf(!realTimeout)('a client deaf to the TERM, killed by the time limit (137), is docker not answering too, never an archive that failed to extract (review of HB-1374)', () => {
    for (const hang of ['create', 'inspect']) {
      const { w, run } = bounded();
      const r = run(hang, true);
      expect(r.took, hang).toBeLessThan(20_000);
      expect(r.stderr, `${hang}: ${r.stdout}${r.stderr}`).not.toContain('failed to extract');
      const rec = w.lastRecord();
      if (hang === 'create') {
        expect(r.stderr).toContain('hatchabot-kitchen-1-vol: docker did not answer within 60 seconds when asked for a throwaway volume — not restored');
        expect(rec.volumes[0]).toMatchObject({ restored: false, note: 'nodocker', result: 'failed' });
      } else {
        expect(r.stderr).toContain('docker did not answer within 60 seconds when asked about the image');
        expect(rec).toMatchObject({ result: 'failed', volumes: [{ restored: null, note: 'nodocker' }] });
      }
    }
  }, 120_000);
});
