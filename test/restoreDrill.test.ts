/**
 * scripts/restore-drill.sh in a sandbox (docs/recovery-readiness-design.md):
 * a temp HOME and backups directory, a PATH of shims (docker is a shim that
 * logs its arguments and "restores" by extracting into a temp dir), an
 * install folder that links this checkout's node_modules and src (the key
 * check imports the secret store), git hooks off, an env built from scratch.
 * It checks the drill's record, and that each restore is isolated: no
 * network, limits, nothing of the set mounted but that one archive.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { listDrills } from '../src/orchestrator/drills.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const repo = resolve(import.meta.dirname, '..');

function drillWorld() {
  const root = tmp('hb-drillrec-');
  const install = join(root, 'install');
  mkdirSync(join(install, 'scripts'), { recursive: true });
  writeFileSync(join(install, 'scripts', 'restore-drill.sh'), readFileSync(join(repo, 'scripts', 'restore-drill.sh')), { mode: 0o755 });
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
// a label filter lists those it matches, by key alone or key=value.
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
    esac
    exit 0 ;;
  rm) exit 0 ;;
  run)
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
