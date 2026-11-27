import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { agentsMissingFromSet, keepDays, listBackups, readSetStatus } from '../src/orchestrator/backups/backupFiles.js';
import { usableFor } from '../src/orchestrator/backups/recoveryReadiness.js';
import { backupFacts, doctorReport, type DoctorFacts } from '../src/doctor.js';
import { FILES_REPLACED_BY } from '../src/orchestrator/lifecycle/operations.js';
import { LocalSecretStore } from '../src/secrets/localSecretStore.js';
import { pinDay, systemPathWithout } from './helpers/scriptEnv.js';

// Most of this file runs real scripts in a sandbox (shell, git, SQLite,
// archives): on a busy CI runner process startup alone can pass the five-second
// unit default, as two unrelated cases did on one run (HB-0801). Longer
// allowances given to single tests still apply.
vi.setConfig({ testTimeout: 30_000 });

// Review, 2026-09-29: a partial nightly set showed healthy (only the dated
// directory was judged), an agent on a runner was never in any set and
// nothing said so, and a pre-rename orphan volume rode along every night.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

describe('a set is judged by its run\'s record', () => {
  it('complete, incomplete, still running, killed long ago, and no record at all', () => {
    const base = tmp('hb-bkstat-');
    const set = (date: string, status?: object) => {
      mkdirSync(join(base, date));
      writeFileSync(join(base, date, 'hatchabot.sqlite'), 'db');
      if (status) writeFileSync(join(base, date, 'backup-status.json'), JSON.stringify(status));
    };
    const now = new Date().toISOString();
    set('2026-09-20', { state: 'complete', startedAt: now, volumes: 3, failed: 0, failedVolumes: [], orphans: ['agentclaw-old'] });
    set('2026-09-21', { state: 'incomplete', startedAt: now, failedVolumes: ['hatchabot-kitchen-1-vol'], orphans: [] });
    set('2026-09-22', { state: 'running', startedAt: now });
    set('2026-09-23', { state: 'running', startedAt: '2026-09-23T03:30:00Z' });
    set('2026-09-24');
    const by = Object.fromEntries(listBackups(base).map((s) => [s.date, s]));
    expect(by['2026-09-20']).toMatchObject({ complete: true, orphans: ['agentclaw-old'] });
    expect(by['2026-09-21']).toMatchObject({ complete: false, failedVolumes: ['hatchabot-kitchen-1-vol'] });
    expect(by['2026-09-22']).toMatchObject({ running: true });
    expect(by['2026-09-22']!.complete).toBeUndefined();
    expect(by['2026-09-23']!.complete).toBe(false); // killed: no trap ran, hours old
    expect(by['2026-09-24']!.complete).toBeUndefined(); // before the record existed: not flagged
    writeFileSync(join(base, '2026-09-24', 'backup-status.json'), 'not json');
    expect(readSetStatus(join(base, '2026-09-24'))).toEqual({});
  });

  it('a set of more than 500 volumes keeps every one it captured, so the 501st is usable (HB-0945)', () => {
    const base = tmp('hb-bk501-');
    const date = '2026-09-25';
    mkdirSync(join(base, date));
    const vols = Array.from({ length: 501 }, (_, i) => `hatchabot-agent-${i}-vol`);
    for (const v of vols) writeFileSync(join(base, date, `${v}.tgz`), 'x');
    writeFileSync(join(base, date, 'backup-status.json'), JSON.stringify({
      state: 'incomplete', startedAt: new Date().toISOString(), failedVolumes: ['hatchabot-other-vol'], orphans: [], captured: vols,
    }));
    expect(readSetStatus(join(base, date)).captured).toHaveLength(501);
    const set = listBackups(base).find((s) => s.date === date)!;
    expect(usableFor(set, vols[500]!)).toBe(true);
  });

  it('doctor warns about an incomplete newest set', () => {
    const facts = {
      nodeVersion: 'v22.22.2', dockerCli: true, dockerDaemon: { ok: true, arch: 'arm64', version: '27.1' },
      envFile: { present: true, secretKey: true, password: true, authMode: 'password', publicUrl: 'https://box.example.com' },
      db: { path: '/x/hatchabot.sqlite', present: true }, service: { manager: 'systemd', active: true, enabled: true },
      controlPlane: { url: 'http://localhost:8080', ok: true }, backups: { dir: '/b', lastSet: '2026-09-28', ageDays: 0, complete: false, failed: 2 },
    } as unknown as DoctorFacts;
    expect(doctorReport(facts).find((l) => /incomplete/.test(l.text))).toMatchObject({ level: 'warn', text: expect.stringMatching(/2 volumes failed/) });
    const ok = doctorReport({ ...facts, backups: { dir: '/b', lastSet: '2026-09-28', ageDays: 0, complete: true } });
    expect(ok.find((l) => /Backups: last set 2026-09-28/.test(l.text))?.level).toBe('ok');
  });

  it('doctor counts a volume left out while its files were replaced apart from the failed ones, as the app does (review of HB-1205)', () => {
    const base = tmp('hb-bkrep-');
    const set = (date: string, rec: object) => {
      mkdirSync(join(base, date));
      writeFileSync(join(base, date, 'hatchabot.sqlite'), 'x');
      writeFileSync(join(base, date, 'backup-status.json'), JSON.stringify({ state: 'incomplete', startedAt: `${date}T03:30:00Z`, orphans: [], captured: [], ...rec }));
    };
    // As backup-volumes.sh records one: among the failed volumes too, for an older reader.
    set('2026-09-27', { failedVolumes: ['hatchabot-k0-vol', 'hatchabot-k1-vol', 'hatchabot-k2-vol'], replacing: ['hatchabot-k0-vol'] });
    const now = Date.parse('2026-09-27T12:00:00Z');
    expect(backupFacts(base, now, undefined)).toMatchObject({ lastSet: '2026-09-27', complete: false, failed: 2, replacing: 1 });
    set('2026-09-28', { failedVolumes: ['hatchabot-k0-vol'], replacing: ['hatchabot-k0-vol'] });
    const only = backupFacts(base, now + 86_400_000, undefined);
    expect(only).toMatchObject({ lastSet: '2026-09-28', complete: false, replacing: 1 });
    expect(only.failed).toBeUndefined();
    const facts = {
      nodeVersion: 'v22.22.2', dockerCli: true, dockerDaemon: { ok: true, arch: 'arm64', version: '27.1' },
      envFile: { present: true, secretKey: true, password: true, authMode: 'password', publicUrl: 'https://box.example.com' },
      db: { path: '/x/hatchabot.sqlite', present: true }, service: { manager: 'systemd', active: true, enabled: true },
      controlPlane: { url: 'http://localhost:8080', ok: true }, backups: { dir: base, lastSet: '2026-09-28', ageDays: 0, complete: false, failed: 2, replacing: 1 },
    } as unknown as DoctorFacts;
    expect(doctorReport(facts).find((l) => /incomplete/.test(l.text))).toEqual({
      level: 'warn', text: 'Last backup set 2026-09-28 is incomplete (2 volumes failed, 1 left out while their files were replaced)', fix: 'journalctl --user -u hatchabot-backup -n 30',
    });
    expect(doctorReport({ ...facts, backups: { ...facts.backups, failed: undefined, replacing: 2 } }).find((l) => /incomplete/.test(l.text))).toEqual({
      level: 'warn', text: 'Last backup set 2026-09-28 is incomplete (2 left out while their files were replaced)', fix: 'Nothing to repair: the next backup takes it (journalctl --user -u hatchabot-backup -n 30 names the agent)',
    });
    // A set an older backup wrote names none apart: every one is failed, as before.
    expect(doctorReport({ ...facts, backups: { ...facts.backups, failed: 1, replacing: undefined } }).find((l) => /incomplete/.test(l.text))?.text).toBe('Last backup set 2026-09-28 is incomplete (1 volume failed)');
  });
});

describe('agents a set does not cover', () => {
  it('names an agent on a runner; an agent made after the run is not missing', () => {
    const set = { date: '2026-09-28', startedAt: '2026-09-28T03:30:00Z', volumes: [{ name: 'kitchen-1-vol', file: 'hatchabot-kitchen-1-vol.tgz', sizeBytes: 1 }] };
    const agents = [
      { id: 'a1', name: 'Kitchen', runtimeRef: 'docker://hatchabot-kitchen-1', createdAt: '2026-09-01T00:00:00Z', hostId: 'local' },
      { id: 'a2', name: 'Reading List', runtimeRef: 'docker://hatchabot-book-2', createdAt: '2026-09-05T00:00:00Z', hostId: 'runner' },
      { id: 'a3', name: 'Photo Album', runtimeRef: 'docker://hatchabot-pic-3', createdAt: '2026-09-28T09:00:00Z', hostId: 'local' },
      { id: 'a4', name: 'Unprovisioned', createdAt: '2026-09-01T00:00:00Z', hostId: 'local' },
    ];
    const missing = agentsMissingFromSet(set, agents, (h) => (h === 'runner' ? 'Laptop runner' : undefined));
    expect(missing).toEqual([{ agentId: 'a2', name: 'Reading List', host: 'Laptop runner' }]);
  });
});

/**
 * scripts/backup-volumes.sh in a sandbox: docker is a shim on a confined PATH
 * (it only lists volumes and writes a fake tarball; a volume named *broken*
 * fails), HOME and the backup dir are temp dirs, the install is a temp dir
 * with an .env and a real SQLite registry.
 */
function scriptWorld(volumes: string[], agentRefs: string[], day?: string) {
  const root = tmp('hb-bkscript-');
  const home = join(root, 'home'); mkdirSync(home);
  const repo = join(root, 'install'); mkdirSync(join(repo, 'scripts'), { recursive: true }); mkdirSync(join(repo, 'data'));
  for (const f of ['backup-volumes.sh', 'backup-owner.sh']) writeFileSync(join(repo, 'scripts', f), readFileSync(join('scripts', f)), { mode: 0o755 });
  writeFileSync(join(repo, '.env'), 'HATCHABOT_SECRET_KEY=not-a-real-key\n');
  const db = new Database(join(repo, 'data', 'hatchabot.sqlite'));
  db.exec(`CREATE TABLE agents (id TEXT, state TEXT, runtime_ref TEXT)`);
  agentRefs.forEach((r, i) => db.prepare(`INSERT INTO agents VALUES (?, 'RUNNING', ?)`).run(`a${i}`, r));
  db.close();
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash
# A runner: \`docker -H <host> …\`. A host with "asleep" in its name does not
# answer. Anything on stdin is logged: over ssh it would be the script's list.
if [ "$1" = -H ]; then
  host="$2"; shift 2
  if read -r -t 0.2 leak; then echo "STDIN: $leak" >> "${root}/remote.log"; fi
  case "$host" in *asleep*) exit 255;; esac
  echo "$host $*" >> "${root}/remote.log"
  # A tcp:// runner is spoken to over TLS: the flag comes first.
  if [ "$1" = --tlsverify ]; then shift; fi
  case "$1" in
    version) exit 0 ;;
    # A volume named *gone* is not on the runner (as docker says it).
    volume) case "$*" in *gone*) echo "Error response from daemon: get \${@: -1}: no such volume" >&2; exit 1;; esac; echo "\${@: -1}" ;;
    run) case "$*" in *broken*) exit 1;; *torn*) printf 'not gzip';; *) printf 'runner data' | gzip ;; esac ;;
  esac
  exit 0
fi
echo "$*" >> "${root}/local.log"
case "$1 $2" in
  # The kept-logins label's listing: every volume, as if each were labelled so. The script
  # leaves out only those whose name says so too: an agent's own volume is never skipped.
  "volume ls") printf '%s\\n' ${volumes.map((v) => `'${v}'`).join(' ')} ;;
  "image inspect") exit 0 ;;
  "info --format") if [ -f "${root}/rootless" ]; then echo '[name=seccomp name=rootless name=cgroupns]'; else echo '[name=seccomp name=cgroupns]'; fi ;;
  run*)
    # The client passes a TERM on to the container (where the archive's shell,
    # PID 1, ignores it) and waits, as docker run does unless --sig-proxy=false.
    case "$*" in *--sig-proxy=false*) ;; *) trap '' TERM ;; esac
    # A slow volume: the run holds its lock long enough for another to look.
    if [ -f "${root}/slow" ]; then sleep 1; fi
    # A held volume: the run waits here, its lock held, until the test removes the file (at most a minute).
    n=0; while [ -f "${root}/hold" ] && [ $n -lt 600 ]; do sleep 0.1; n=$((n + 1)); done
    vol=""; out=""
    for a in "$@"; do case "$a" in *:/data:ro) vol="\${a%%:/data:ro}";; *:/out) out="\${a%%:/out}";; esac; done
    # The file the script's own command writes, under /out.
    f="$(grep -o "/out/[^' ]*" <<<"\${@: -1}" | head -1)"; f="\${f#/out/}"
    # A volume named *broken* fails half-way: a torn file, then tar's error.
    case "$vol" in *broken*) echo torn > "$out/$f"; exit 2;; esac
    # A client killed (137) while its container goes on writing.
    case "$vol" in *killed*) echo part > "$out/$f"; exit 137;; esac
    # What a rootless daemon made of the chown: this user may rename it, not read it.
    if [ -f "${root}/unreadable" ] && grep -q chown <<<"\${@: -1}"; then echo x > "$out/$f"; chmod 000 "$out/$f"; exit 0; fi
    if [ -f "${root}/killing-at" ] && [ "$vol" = "$(cat "${root}/killing-at")" ]; then exit 2; fi
    # A volume with a fixture tree runs the script's own tar command for
    # real, /data and /out pointed at temp dirs (review, 2026-09-29).
    if [ -d "${root}/vols/$vol" ]; then
      o='/out/'; d='-C /data '
      cmd="\${@: -1}"; cmd="\${cmd//"$o"/$out/}"; cmd="\${cmd//"$d"/-C ${root}/vols/$vol }"
      exec bash -c "$cmd"
    fi
    echo fake > "$out/$f" ;;
esac
`, { mode: 0o755 });
  // Every run of this world on one day, the one it was made on unless given: two
  // runs either side of midnight wrote two sets (HB-1334).
  const setDay = pinDay(bin, day);
  const backups = join(root, 'backups');
  const env = (extraEnv: Record<string, string>) => ({
    HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HATCHABOT_BACKUP_DIR: backups, HATCHABOT_PREFIX: 'hatchabot',
    NODE_PATH: join(dirname(createRequire(import.meta.url).resolve('better-sqlite3/package.json')), '..'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
    ...extraEnv,
  });
  const run = (extraEnv: Record<string, string> = {}) => spawnSync('bash', [join(repo, 'scripts', 'backup-volumes.sh')], { encoding: 'utf8', env: env(extraEnv) });
  /** The same run in a process group of its own, as the app starts it (startBackup): the child, not waited for. */
  const spawnRun = (extraEnv: Record<string, string> = {}) => spawn('bash', [join(repo, 'scripts', 'backup-volumes.sh')], { env: env(extraEnv), stdio: 'ignore', detached: true });
  /** The same run, not waited for: two at once. */
  const start = (extraEnv: Record<string, string> = {}) => new Promise<{ status: number | null; out: string }>((resolve) => {
    const c = spawn('bash', [join(repo, 'scripts', 'backup-volumes.sh')], { env: env(extraEnv) });
    let out = '';
    c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
    c.on('close', (status) => resolve({ status, out }));
  });
  // This run's set: the newest dated directory (an older one may sit beside it).
  const setDir = () => join(backups, readdirSync(backups).filter((d) => /^20\d\d-/.test(d)).sort().pop()!);
  /** Give a volume real files, so its tarball is made by the script's own tar. */
  const fillVolume = (vol: string, files: string[]) => {
    for (const f of files) { mkdirSync(dirname(join(root, 'vols', vol, f)), { recursive: true }); writeFileSync(join(root, 'vols', vol, f), 'x'); }
  };
  /** Put agents on runners: [dockerHost, runtime ref] pairs, each runner a host row. */
  const onRunners = (pairs: Array<[string, string]>) => {
    const db = new Database(join(repo, 'data', 'hatchabot.sqlite'));
    db.exec(`ALTER TABLE agents ADD COLUMN host_id TEXT DEFAULT 'host-local-default'; CREATE TABLE hosts (id TEXT, kind TEXT, settings TEXT)`);
    db.prepare(`INSERT INTO hosts VALUES ('host-local-default', 'local', '{}')`).run();
    pairs.forEach(([host, ref], i) => {
      db.prepare(`INSERT OR IGNORE INTO hosts SELECT ?, 'cloud', ? WHERE NOT EXISTS (SELECT 1 FROM hosts WHERE id = ?)`).run(host, JSON.stringify({ dockerHost: host }), host);
      db.prepare(`INSERT INTO agents (id, state, runtime_ref, host_id) VALUES (?, 'RUNNING', ?, ?)`).run(`r${i}`, ref, host);
    });
    db.close();
  };
  const localLog = () => (existsSync(join(root, 'local.log')) ? readFileSync(join(root, 'local.log'), 'utf8') : '');
  const remoteLog = () => (existsSync(join(root, 'remote.log')) ? readFileSync(join(root, 'remote.log'), 'utf8') : '');
  /** A set from a month ago, old enough for the 14-day pruning to remove. */
  const oldSet = (files: string[], date = '2026-01-02', daysAgo = 30) => {
    const d = join(backups, date); mkdirSync(d, { recursive: true });
    for (const f of files) writeFileSync(join(d, f), 'old');
    const then = new Date(Date.now() - daysAgo * 86_400_000);
    utimesSync(d, then, then);
    return d;
  };
  /** The run's own record, as written (every field, not only what the app reads). */
  const record = () => JSON.parse(readFileSync(join(setDir(), 'backup-status.json'), 'utf8'));
  const setState = (ref: string, state: string) => {
    const db = new Database(join(repo, 'data', 'hatchabot.sqlite'));
    db.prepare(`UPDATE agents SET state = ? WHERE runtime_ref = ?`).run(state, ref);
    db.close();
  };
  /** Today's set directory, as the script names it (before any run made it): the world's day. */
  const today = () => join(backups, setDay);
  return { run, start, spawnRun, bin, root, setDir, fillVolume, repo, onRunners, localLog, remoteLog, oldSet, record, setState, backups, today };
}

// Complete sandboxed shell/SQLite/archive workflows, not unit-speed work:
// process startup on a busy CI runner can exceed five seconds (HB-0800).
describe('scripts/backup-volumes.sh records how the run ended', { timeout: 30_000 }, () => {
  it('a run stopped by a signal (the service restarting, a shutdown) is incomplete, never complete (HB-0368)', async () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol', 'hatchabot-notes-2-vol'], ['docker://hatchabot-kitchen-1', 'docker://hatchabot-notes-2']);
    // Held inside its first volume until the signal is sent: no timed sleep to race (HB-0622).
    const hold = join(w.root, 'hold');
    writeFileSync(hold, '');
    const c = spawn('bash', [join(w.repo, 'scripts', 'backup-volumes.sh')], {
      env: { HOME: join(w.root, 'home'), PATH: `${w.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HATCHABOT_BACKUP_DIR: w.backups, HATCHABOT_PREFIX: 'hatchabot', NODE_PATH: join(dirname(createRequire(import.meta.url).resolve('better-sqlite3/package.json')), '..') },
      stdio: 'ignore',
    });
    try {
      const t0 = Date.now();
      while (!/^run /m.test(w.localLog()) && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 20));
      c.kill('SIGTERM');
    } finally {
      rmSync(hold, { force: true }); // bash runs its trap once the step it waits on ends; never left held
    }
    const code = await new Promise<number | null>((r) => c.on('exit', (n) => r(n)));
    expect(code).toBe(143);
    expect(readSetStatus(w.setDir())).toMatchObject({ complete: false });
  }, 30_000);

  it('a run that refuses before it starts leaves the day\'s earlier record alone (2026-10-03)', () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
    expect(w.run().status).toBe(0);
    expect(readSetStatus(w.setDir())).toMatchObject({ complete: true });
    rmSync(join(w.repo, 'data', 'hatchabot.sqlite'));
    const again = w.run();
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/No database/);
    expect(readSetStatus(w.setDir())).toMatchObject({ complete: true });
  });

  it('a clean run says complete; a volume no agent uses is left out and named', () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol', 'agentclaw-old-garden'], ['docker://hatchabot-kitchen-1']);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/agentclaw-old-garden: no agent uses it — not backed up/);
    expect(existsSync(join(w.setDir(), 'agentclaw-old-garden.tgz'))).toBe(false);
    expect(existsSync(join(w.setDir(), 'hatchabot-kitchen-1-vol.tgz'))).toBe(true);
    expect(readSetStatus(w.setDir())).toMatchObject({ complete: true, orphans: ['agentclaw-old-garden'], failedVolumes: [] });
  });

  it("an agent's kept browser logins are never in a set, and not called a volume no agent uses (HB-0680)", () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol', 'hatchabot-kitchen-1-browser-logins-0a1b2c3d4e5f'], ['docker://hatchabot-kitchen-1']);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/browser-logins/);
    expect(existsSync(join(w.setDir(), 'hatchabot-kitchen-1-browser-logins-0a1b2c3d4e5f.tgz'))).toBe(false);
    expect(existsSync(join(w.setDir(), 'hatchabot-kitchen-1-vol.tgz'))).toBe(true);
    expect(readSetStatus(w.setDir())).toMatchObject({ complete: true, orphans: [], failedVolumes: [] });
  });

  it('a local archive whose client was killed: its container, with no network, is removed by name, the set incomplete (HB-0348)', () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol', 'hatchabot-killed-2-vol'], ['docker://hatchabot-kitchen-1', 'docker://hatchabot-killed-2']);
    const r = w.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/hatchabot-killed-2-vol failed \(exit 137\)/);
    const runs = w.localLog().split('\n').filter((l) => l.startsWith('run '));
    expect(runs).toHaveLength(2);
    for (const l of runs) expect(l).toMatch(/^run --rm --name hatchabot-bk-\d+-\d+ --label hatchabot\.oneshot=hatchabot --sig-proxy=false --network none --user root -v /);
    const killed = runs.find((l) => l.includes('killed-2-vol:/data'))!.split(' ')[3];
    const kept = runs.find((l) => l.includes('kitchen-1-vol:/data'))!.split(' ')[3];
    expect(w.localLog()).toContain(`rm -f ${killed}\n`);
    expect(w.localLog()).not.toContain(`rm -f ${kept}`);
    expect(existsSync(join(w.setDir(), 'hatchabot-killed-2-vol.tgz.part'))).toBe(false);
    expect(w.record()).toMatchObject({ state: 'incomplete', failedVolumes: ['hatchabot-killed-2-vol'], captured: ['hatchabot-kitchen-1-vol'] });
  });

  it('a failed volume leaves the set marked incomplete, naming it', () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol', 'hatchabot-broken-2-vol'], ['docker://hatchabot-kitchen-1', 'docker://hatchabot-broken-2']);
    const r = w.run();
    expect(r.status).toBe(1);
    expect(readSetStatus(w.setDir())).toMatchObject({ complete: false, failedVolumes: ['hatchabot-broken-2-vol'] });
    expect(listBackups(dirname(w.setDir()))[0]!.complete).toBe(false);
  });

  it('agents on a runner are archived over its connection; a runner asleep is skipped, not failed (2026-10-06)', () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
    w.onRunners([
      ['ssh://laptop.test', 'docker://agentclaw-book-2'],
      ['ssh://laptop.test', 'docker://hatchabot-notes-3'],
      ['ssh://asleep.test', 'docker://hatchabot-garden-4'],
    ]);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    for (const v of ['agentclaw-book-2-vol', 'hatchabot-notes-3-vol']) {
      expect(spawnSync('gzip', ['-dc', join(w.setDir(), `${v}.tgz`)], { encoding: 'utf8' }).stdout).toBe('runner data');
    }
    expect(existsSync(join(w.setDir(), 'hatchabot-garden-4-vol.tgz'))).toBe(false);
    expect(r.stderr).toMatch(/asleep\.test: not answering/);
    // Read-only, no network, the root caches left out, and nothing read from stdin.
    expect(w.remoteLog()).toMatch(/ssh:\/\/laptop.test run --rm --name hatchabot-bk-\S+ --label hatchabot.oneshot=hatchabot --sig-proxy=false --network none -v agentclaw-book-2-vol:\/vol:ro alpine tar cz --exclude=.\/.openclaw\/cache\/control-ui-assets/);
    expect(w.remoteLog()).not.toContain('STDIN');
    expect(w.remoteLog()).not.toContain('--anchored');
    // A sleeping laptop must not stop the pruning of this machine's sets: complete, with it named.
    expect(readSetStatus(w.setDir())).toMatchObject({ complete: true, failedVolumes: [] });
    expect(JSON.parse(readFileSync(join(w.setDir(), 'backup-status.json'), 'utf8')).skipped).toEqual(['hatchabot-garden-4-vol']);
    // …and the app still counts that one as not covered, and only that one.
    const set = listBackups(dirname(w.setDir()))[0]!;
    const agents = [['r0', 'docker://agentclaw-book-2'], ['r1', 'docker://hatchabot-notes-3'], ['r2', 'docker://hatchabot-garden-4']]
      .map(([id, ref]) => ({ id: id!, name: id!, runtimeRef: ref, createdAt: '2026-09-01T00:00:00Z', hostId: 'runner' }));
    expect(agentsMissingFromSet(set, agents, () => 'Laptop').map((m) => m.agentId)).toEqual(['r2']);
  });

  it('a tcp:// runner is read over verified TLS, every call; an ssh:// one as before (HB-0277)', () => {
    const w = scriptWorld([], []);
    w.onRunners([
      ['tcp://laptop.test:2376', 'docker://hatchabot-notes-3'],
      ['tcp://laptop.test:2376', 'docker://hatchabot-broken-5'],
      ['ssh://tablet.test', 'docker://hatchabot-garden-4'],
    ]);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1); // the broken one
    expect(spawnSync('gzip', ['-dc', join(w.setDir(), 'hatchabot-notes-3-vol.tgz')], { encoding: 'utf8' }).stdout).toBe('runner data');
    const lines = w.remoteLog().split('\n').filter(Boolean);
    const tcp = lines.filter((l) => l.startsWith('tcp://'));
    // For each volume: is it awake, inspect, run; the failed one's container removed.
    expect(tcp.map((l) => l.split(' ')[2])).toEqual(['version', 'volume', 'run', 'version', 'volume', 'run', 'rm']);
    for (const l of tcp) expect(l.split(' ')[1], l).toBe('--tlsverify');
    expect(lines.filter((l) => l.startsWith('ssh://')).every((l) => !l.includes('--tlsverify'))).toBe(true);
    expect(w.record()).toMatchObject({ captured: ['hatchabot-notes-3-vol', 'hatchabot-garden-4-vol'], failedVolumes: ['hatchabot-broken-5-vol'] });
  });

  it('with no registry agents to match (unreadable or empty), every volume is taken', () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol', 'agentclaw-old-garden'], []);
    // No active agents but volumes exist: the old trust-the-disk rule holds.
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(w.setDir(), 'agentclaw-old-garden.tgz'))).toBe(true);
  });
});

describe('scripts/backup-volumes.sh under a rootless or remapped daemon (HB-0406)', () => {
  const VOLS = ['hatchabot-kitchen-1-vol', 'hatchabot-notes-2-vol'], REFS = ['docker://hatchabot-kitchen-1', 'docker://hatchabot-notes-2'];
  it('an archive this user cannot read back fails the set: named, nothing pruned, no unreadable file left', () => {
    const w = scriptWorld(VOLS, REFS);
    const old = w.oldSet(['hatchabot-kitchen-1-vol.tgz']);
    writeFileSync(join(w.root, 'unreadable'), '');
    const r = w.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/hatchabot-kitchen-1-vol: docker wrote the archive as uid \d+, and \S+ cannot read it/);
    expect(w.record()).toMatchObject({ state: 'incomplete', failed: 2, captured: [] });
    expect(readSetStatus(w.setDir()).failedVolumes).toEqual(VOLS);
    expect(readdirSync(w.setDir()).filter((f) => f.includes('.tgz'))).toEqual([]);
    expect(existsSync(old)).toBe(true);
  });
  it('an unreadable archive does not replace a whole one from earlier the same day', () => {
    const w = scriptWorld(VOLS, REFS);
    expect(w.run().status).toBe(0);
    writeFileSync(join(w.root, 'unreadable'), '');
    expect(w.run().status).toBe(1);
    expect(readFileSync(join(w.setDir(), 'hatchabot-kitchen-1-vol.tgz'), 'utf8')).toBe('fake\n');
  });
  it('rootless: no chown in the container, whose root already is this user, and the set is complete', () => {
    const w = scriptWorld(VOLS, REFS);
    writeFileSync(join(w.root, 'rootless'), '');
    writeFileSync(join(w.root, 'unreadable'), ''); // the chown, were there one, would spoil it
    const r = w.run();
    expect(r.status, r.stderr).toBe(0);
    expect(w.localLog()).not.toMatch(/^run .*chown/m);
    expect(w.record()).toMatchObject({ state: 'complete', failed: 0, captured: VOLS });
  });
  it('a normal daemon still hands the archive to this user', () => {
    const w = scriptWorld(VOLS, REFS);
    expect(w.run().status).toBe(0);
    expect(w.localLog()).toMatch(/^run .*chown \d+:\d+ '\/out\/hatchabot-kitchen-1-vol\.tgz\.part'/m);
  });
});

describe('scripts/backup-volumes.sh: a second run of the same day (HB-0433)', () => {
  const VOLS = ['hatchabot-kitchen-1-vol', 'hatchabot-notes-2-vol'], REFS = ['docker://hatchabot-kitchen-1', 'docker://hatchabot-notes-2'];
  const failing = (w: ReturnType<typeof scriptWorld>, vol: string) => writeFileSync(join(w.root, "killing-at"), vol);
  it('cut short, it keeps what the morning wrote whole counted, for a restore to use', async () => {
    const w = scriptWorld(VOLS, REFS);
    expect(w.run().status).toBe(0);
    expect(w.record().captured).toEqual(VOLS);
    // The noon run, stopped by a restart while it writes the first volume: held there until
    // the signal is sent (HB-0622).
    const hold = join(w.root, 'hold');
    writeFileSync(hold, '');
    const c = spawn('bash', [join(w.repo, 'scripts', 'backup-volumes.sh')], {
      env: { HOME: join(w.root, 'home'), PATH: `${w.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HATCHABOT_BACKUP_DIR: w.backups, HATCHABOT_PREFIX: 'hatchabot', NODE_PATH: join(dirname(createRequire(import.meta.url).resolve('better-sqlite3/package.json')), '..') },
      stdio: 'ignore',
    });
    try {
      const before = (w.localLog().match(/^run /gm) ?? []).length;
      const t0 = Date.now();
      while ((w.localLog().match(/^run /gm) ?? []).length === before && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 20));
      c.kill('SIGTERM');
    } finally {
      rmSync(hold, { force: true }); // never left held past the test
    }
    await new Promise((r) => c.on('exit', r));
    const st = readSetStatus(w.setDir());
    expect(st.complete).toBe(false);
    expect(st.captured).toEqual(VOLS); // both whole, though the second run reached neither
  }, 30_000);
  it('the two runs of a test share the world\'s day, whatever the clock says between them (HB-1334)', () => {
    // A day that is not today, as a run past midnight would see the other run's.
    const y = new Date(Date.now() - 86_400_000);
    const day = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
    const w = scriptWorld(VOLS, REFS, day);
    expect(w.run().status).toBe(0);
    failing(w, 'hatchabot-notes-2-vol');
    expect(w.run().status).toBe(1);
    expect(readdirSync(w.backups).filter((d) => /^20\d\d-/.test(d))).toEqual([day]);
    expect(w.setDir()).toBe(w.today());
    expect(readSetStatus(w.setDir()).failedVolumes).toEqual(['hatchabot-notes-2-vol']);
    expect(readFileSync(join(w.setDir(), 'hatchabot-notes-2-vol.tgz'), 'utf8')).toBe('fake\n');
  });
  it('a volume that fails in the second run is failed; the other stays captured once, not twice', () => {
    const w = scriptWorld(VOLS, REFS);
    expect(w.run().status).toBe(0);
    failing(w, 'hatchabot-notes-2-vol');
    expect(w.run().status).toBe(1);
    const st = readSetStatus(w.setDir());
    expect(st.failedVolumes).toEqual(['hatchabot-notes-2-vol']);
    expect(st.captured!.filter((v) => v === 'hatchabot-kitchen-1-vol')).toHaveLength(1);
    expect(readFileSync(join(w.setDir(), 'hatchabot-notes-2-vol.tgz'), 'utf8')).toBe('fake\n'); // the morning's is still there
  });
  it('an earlier record names only what is really there; a record from before "captured" counts the archives it has', () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
    mkdirSync(w.today(), { recursive: true });
    writeFileSync(join(w.today(), 'backup-status.json'), JSON.stringify({ state: 'complete', captured: ['hatchabot-gone-9-vol', 'x; touch /tmp/no'] }));
    expect(w.run().status).toBe(0);
    expect(w.record().captured).toEqual(['hatchabot-kitchen-1-vol']);
    const v = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
    mkdirSync(v.today(), { recursive: true });
    writeFileSync(join(v.today(), 'hatchabot-old-3-vol.tgz'), 'whole');
    writeFileSync(join(v.today(), 'backup-status.json'), JSON.stringify({ state: 'complete' }));
    expect(v.run().status).toBe(0);
    expect(v.record().captured.sort()).toEqual(['hatchabot-kitchen-1-vol', 'hatchabot-old-3-vol']);
  });
  it('a volume docker no longer has is missing, however whole its morning archive', () => {
    const w = scriptWorld(VOLS, REFS);
    expect(w.run().status).toBe(0);
    const v = scriptWorld(['hatchabot-kitchen-1-vol'], REFS);
    mkdirSync(v.today(), { recursive: true });
    writeFileSync(join(v.today(), 'hatchabot-notes-2-vol.tgz'), 'whole');
    writeFileSync(join(v.today(), 'backup-status.json'), JSON.stringify({ state: 'complete', captured: ['hatchabot-notes-2-vol'] }));
    expect(v.run().status).toBe(1);
    expect(v.record()).toMatchObject({ state: 'incomplete', missing: ['hatchabot-notes-2-vol'] });
  });
});

describe('HATCHABOT_BACKUP_KEEP_DAYS has one reading (HB-0432)', () => {
  const VOLS = ['hatchabot-kitchen-1-vol'], REFS = ['docker://hatchabot-kitchen-1'];
  const was = process.env.HATCHABOT_BACKUP_KEEP_DAYS;
  afterEach(() => { if (was === undefined) delete process.env.HATCHABOT_BACKUP_KEEP_DAYS; else process.env.HATCHABOT_BACKUP_KEEP_DAYS = was; });
  it.each(['14d', '0', '-3', '3.5', 'abc', '0x10', '', '99999999999999999999'])('%j: a whole run, the panel and the script both at 14 days, and said', (value) => {
    process.env.HATCHABOT_BACKUP_KEEP_DAYS = value;
    expect(keepDays()).toBe(14);
    const w = scriptWorld(VOLS, REFS);
    // Both hold older copies of the kitchen's volume (today's set holds its
    // newest), so the age alone keeps one and prunes the other: a volume no
    // agent here ever had is kept however old (HB-1380), and the young set
    // went under -mtime +0 only by its age (review of HB-1380).
    const young = w.oldSet(['hatchabot-kitchen-1-vol.tgz'], '2026-01-03', 5);
    const old = w.oldSet(['hatchabot-kitchen-1-vol.tgz'], '2026-01-02', 30);
    const r = w.run({ HATCHABOT_BACKUP_KEEP_DAYS: value });
    expect(r.status, r.stderr).toBe(0);
    if (value) expect(r.stderr).toContain('is not a whole number of days above 0: keeping 14 days');
    expect(r.stdout).toContain('keeping 14 days');
    expect(w.record().state).toBe('complete');
    expect(existsSync(young)).toBe(true);
    expect(existsSync(old)).toBe(false);
  });
  it.each([['7', 7], ['007', 7], [' 30 ', 30]])('%j reads the same in both', (value, days) => {
    process.env.HATCHABOT_BACKUP_KEEP_DAYS = String(value);
    expect(keepDays()).toBe(days);
    const r = scriptWorld(VOLS, REFS).run({ HATCHABOT_BACKUP_KEEP_DAYS: String(value) });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`keeping ${days} days`);
    expect(r.stderr).not.toContain('keeping 14 days');
  });
});

describe('scripts/backup-volumes.sh: two installs sharing a backups folder (HB-0280)', () => {
  it('a legacy set from earlier today is identified by its saved key before another install can overwrite it', () => {
    const a = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
    const b = scriptWorld(['other-garden-2-vol'], ['docker://other-garden-2']);
    writeFileSync(join(b.repo, '.env'), 'HATCHABOT_SECRET_KEY=another-made-up-key\n');
    expect(a.run().status).toBe(0);
    const set = a.setDir();
    rmSync(join(set, '.backup-owner'));
    const before = Object.fromEntries(readdirSync(set).map((f) => [f, readFileSync(join(set, f))]));
    const r = b.run({ HATCHABOT_BACKUP_DIR: a.backups, HATCHABOT_PREFIX: 'other' });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain("is another Hatchabot install's backup set");
    expect(readdirSync(set).sort()).toEqual(Object.keys(before).sort());
    for (const [file, bytes] of Object.entries(before)) expect(readFileSync(join(set, file)), file).toEqual(bytes);
    // Its own install can still update a legacy set and add the owner mark.
    expect(a.run().status).toBe(0);
    expect(existsSync(join(set, '.backup-owner'))).toBe(true);
  }, 30_000);

  it.each([true, false])('a run without its own key preserves an existing set before writing its database (owner mark: %s)', (marked) => {
    const a = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
    const b = scriptWorld(['other-garden-2-vol'], ['docker://other-garden-2']);
    rmSync(join(b.repo, '.env'));
    expect(a.run().status).toBe(0);
    const set = a.setDir();
    if (!marked) rmSync(join(set, '.backup-owner'));
    const before = Object.fromEntries(readdirSync(set).map((f) => [f, readFileSync(join(set, f))]));
    const r = b.run({ HATCHABOT_BACKUP_DIR: a.backups, HATCHABOT_PREFIX: 'other' });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain('cannot identify this install');
    expect(readdirSync(set).sort()).toEqual(Object.keys(before).sort());
    for (const [file, bytes] of Object.entries(before)) expect(readFileSync(join(set, file)), file).toEqual(bytes);
  }, 30_000);

  it('a day\'s set stays the install\'s that made it: the other one stops before writing, and does not prune it', () => {
    const a = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
    const b = scriptWorld(['other-garden-2-vol'], ['docker://other-garden-2']);
    writeFileSync(join(b.repo, '.env'), 'HATCHABOT_SECRET_KEY=another-made-up-key\n');
    const shared = { HATCHABOT_BACKUP_DIR: a.backups };
    const aOld = a.oldSet(['hatchabot.sqlite', 'hatchabot-kitchen-1-vol.tgz'], '2026-01-02');
    expect(a.run().status).toBe(0);
    expect(existsSync(aOld)).toBe(false); // its own old set is pruned as before
    const set = a.setDir();
    const owner = readFileSync(join(set, '.backup-owner'), 'utf8');
    expect(owner).toMatch(/^[0-9a-f]{16}\n$/);
    expect(owner).not.toContain('not-a-real-key');
    const r = b.run({ ...shared, HATCHABOT_PREFIX: 'other' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/is another Hatchabot install's backup set .* Give each install a HATCHABOT_BACKUP_DIR of its own/);
    // A's set is whole and A's: its registry, its key, its record, nothing of B's.
    const db = new Database(join(set, 'hatchabot.sqlite'), { readonly: true });
    expect(db.prepare('SELECT runtime_ref FROM agents').all()).toEqual([{ runtime_ref: 'docker://hatchabot-kitchen-1' }]);
    db.close();
    expect(readFileSync(join(set, 'secret-key.env'), 'utf8')).toContain('not-a-real-key');
    expect(existsSync(join(set, 'other-garden-2-vol.tgz'))).toBe(false);
    expect(readSetStatus(set)).toMatchObject({ complete: true });
    expect(existsSync(join(set, '.backup-lock'))).toBe(false);
    // A again the same day: its own set, written over as before.
    expect(a.run().status).toBe(0);
    // An old set of B's is not A's to prune; an old one from before the owner file is.
    const bOld = a.oldSet(['hatchabot.sqlite', 'other-garden-2-vol.tgz'], '2026-01-03');
    writeFileSync(join(bOld, '.backup-owner'), '0123456789abcdef\n');
    const legacy = a.oldSet(['hatchabot.sqlite'], '2026-01-04');
    expect(a.run().status).toBe(0);
    expect(existsSync(bOld)).toBe(true);
    expect(existsSync(legacy)).toBe(false);
  });

  it('an old set from before the owner file is the install\'s whose key it saved: the other one does not prune it (HB-0280)', () => {
    const a = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
    // Before the owner file, B ran after A each day: its key is in every set,
    // beside both installs' archives. B's runs now stop at A's sets, so these
    // are B's only backups.
    const bLegacy = a.oldSet(['hatchabot.sqlite', 'hatchabot-kitchen-1-vol.tgz', 'other-garden-2-vol.tgz'], '2026-01-03');
    writeFileSync(join(bLegacy, 'secret-key.env'), 'HATCHABOT_SECRET_KEY="another-made-up-key"\n');
    const aLegacy = a.oldSet(['hatchabot.sqlite', 'hatchabot-kitchen-1-vol.tgz'], '2026-01-04');
    writeFileSync(join(aLegacy, 'secret-key.env'), 'HATCHABOT_SECRET_KEY="not-a-real-key"\n');
    const then = new Date(Date.now() - 30 * 86_400_000);
    for (const d of [bLegacy, aLegacy]) utimesSync(d, then, then);
    const r = a.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(bLegacy)).toBe(true);
    expect(existsSync(aLegacy)).toBe(false);
  });
});

describe('scripts/backup-volumes.sh without its owner helper (fifteenth review)', () => {
  it('a missing or empty scripts/backup-owner.sh stops the run before it makes the day\'s folder: no empty set that reads as today\'s', () => {
    for (const helper of ['missing', 'empty'] as const) {
      const w = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
      const file = join(w.repo, 'scripts', 'backup-owner.sh');
      if (helper === 'missing') rmSync(file); else writeFileSync(file, '');
      const r = w.run();
      expect(r.status, `${helper}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stderr, helper).toContain(`Could not read ${w.repo}/scripts/backup-owner.sh: without it this run cannot tell whose the sets in ${w.backups} are, so it stops before writing anything.`);
      expect(existsSync(w.today()), helper).toBe(false);
      expect(w.localLog(), helper).toBe('');
    }
  });
});

describe('scripts/backup-volumes.sh: every agent on this machine is in the set, or it is incomplete (issue #2)', () => {
  it('a missing volume among present ones marks the set incomplete, names it, and prunes nothing', () => {
    const w = scriptWorld(
      ['hatchabot-present-1-vol', 'hatchabot-present-2-vol'],
      ['docker://hatchabot-present-1', 'docker://hatchabot-missing-3', 'docker://hatchabot-present-2'],
    );
    const old = w.oldSet(['hatchabot.sqlite', 'hatchabot-missing-3-vol.tgz']);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    for (const v of ['hatchabot-present-1-vol', 'hatchabot-present-2-vol']) expect(existsSync(join(w.setDir(), `${v}.tgz`)), v).toBe(true);
    expect(r.stderr).toMatch(/hatchabot-missing-3-vol: an agent on this machine uses it, but docker has no hatchabot-\* volume/);
    expect(r.stderr).toMatch(/nothing pruned/);
    expect(w.record()).toMatchObject({ state: 'incomplete', volumes: 2, failed: 1, failedVolumes: ['hatchabot-missing-3-vol'], missing: ['hatchabot-missing-3-vol'] });
    expect(readSetStatus(w.setDir())).toMatchObject({ complete: false, failedVolumes: ['hatchabot-missing-3-vol'] });
    // Nothing pruned, so nothing said about what the retention keeps: doctor reads an earlier run's (review of HB-1380).
    expect(w.record()).not.toHaveProperty('keptUnlisted');
    // The missing agent's last good copy survives.
    expect(existsSync(join(old, 'hatchabot-missing-3-vol.tgz'))).toBe(true);
  });

  it('with every volume there, the same old set is pruned (the check above is what held it)', () => {
    const w = scriptWorld(['hatchabot-present-1-vol', 'hatchabot-present-2-vol'], ['docker://hatchabot-present-1', 'docker://hatchabot-present-2']);
    const old = w.oldSet(['hatchabot.sqlite']);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.record()).toMatchObject({ state: 'complete', failedVolumes: [], missing: [] });
    expect(existsSync(old)).toBe(false);
  });

  it('an agent whose first start failed (no volume) does not hold every set back', () => {
    const w = scriptWorld(['hatchabot-present-1-vol'], ['docker://hatchabot-present-1', 'docker://hatchabot-never-2']);
    w.setState('docker://hatchabot-never-2', 'FAILED');
    const old = w.oldSet(['hatchabot.sqlite']);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/hatchabot-never-2-vol: its agent failed to start and has no volume/);
    expect(w.record()).toMatchObject({ state: 'complete', missing: [] });
    expect(existsSync(old)).toBe(false);
  });

  it('a local agent without its volume, the rest on runners: the runner is still archived, the set is incomplete', () => {
    const w = scriptWorld([], ['docker://hatchabot-kitchen-1']);
    w.onRunners([['ssh://laptop.test', 'docker://hatchabot-notes-3']]);
    const old = w.oldSet(['hatchabot.sqlite']);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(existsSync(join(w.setDir(), 'hatchabot-notes-3-vol.tgz'))).toBe(true);
    expect(w.record()).toMatchObject({ state: 'incomplete', volumes: 1, missing: ['hatchabot-kitchen-1-vol'] });
    expect(existsSync(old)).toBe(true);
  });
});

describe('scripts/backup-volumes.sh: a fleet that lives on runners only (issue #3)', () => {
  it('no local volumes: the runners\' agents are archived; one asleep is skipped, not failed', () => {
    const w = scriptWorld([], []);
    w.onRunners([
      ['ssh://laptop.test', 'docker://hatchabot-notes-3'],
      ['ssh://asleep.test', 'docker://hatchabot-garden-4'],
    ]);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/HATCHABOT_PREFIX mismatch|refusing/);
    expect(spawnSync('gzip', ['-dc', join(w.setDir(), 'hatchabot-notes-3-vol.tgz')], { encoding: 'utf8' }).stdout).toBe('runner data');
    expect(existsSync(join(w.setDir(), 'hatchabot-garden-4-vol.tgz'))).toBe(false);
    expect(r.stderr).toMatch(/asleep\.test: not answering/);
    expect(w.record()).toMatchObject({ state: 'complete', volumes: 1, failedVolumes: [], missing: [], skipped: ['hatchabot-garden-4-vol'] });
  });

  it('no local volumes and every runner asleep: nothing captured, incomplete, nothing pruned', () => {
    const w = scriptWorld([], []);
    w.onRunners([['ssh://asleep.test', 'docker://hatchabot-garden-4']]);
    const old = w.oldSet(['hatchabot.sqlite', 'hatchabot-garden-4-vol.tgz']);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toMatch(/No volume captured: every runner was asleep/);
    expect(w.record()).toMatchObject({ state: 'incomplete', volumes: 0, failedVolumes: [], skipped: ['hatchabot-garden-4-vol'] });
    expect(existsSync(join(old, 'hatchabot-garden-4-vol.tgz'))).toBe(true);
  });

  it('a genuinely empty install still backs up the database and says so', () => {
    const w = scriptWorld([], []);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/No agents yet — database backed up/);
    expect(existsSync(join(w.setDir(), 'hatchabot.sqlite'))).toBe(true);
    expect(w.record()).toMatchObject({ state: 'complete', volumes: 0 });
  });

  it('with its last agent deleted, the database-only set is complete and older sets past the retention are still pruned; another install\'s stay (HB-1110)', () => {
    const w = scriptWorld([], ['docker://hatchabot-gone-1']);
    w.setState('docker://hatchabot-gone-1', 'DELETED');
    const old = w.oldSet(['hatchabot.sqlite', 'secret-key.env', 'hatchabot-gone-1-vol.tgz']);
    const theirs = w.oldSet(['hatchabot.sqlite', '.backup-owner'], '2026-01-03');
    writeFileSync(join(theirs, '.backup-owner'), '0123456789abcdef\n'); // another install's mark, written over: the folder keeps its age
    const recent = w.oldSet(['hatchabot.sqlite'], '2026-01-04', 3);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/No agents yet — database backed up/);
    expect(w.record()).toMatchObject({ state: 'complete', volumes: 0 });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(theirs)).toBe(true);
    expect(existsSync(recent)).toBe(true);
  });

  it('a new machine set up with the old one\'s key and backups folder, its database not restored yet: no agent known, so each volume\'s newest copy is kept (review of HB-1110)', () => {
    const w = scriptWorld([], []);
    const mark = spawnSync('bash', ['-c', '. scripts/backup-owner.sh; HATCHABOT_SECRET_KEY=not-a-real-key key_owner'], { encoding: 'utf8' }).stdout.trim();
    expect(mark).toMatch(/^[0-9a-f]{8,}$/);
    // The old machine's sets, this key's own: marked with it (overwritten, so each folder keeps its age).
    const set = (files: string[], date: string, daysAgo: number) => {
      const d = w.oldSet(['hatchabot.sqlite', '.backup-owner', ...files], date, daysAgo);
      writeFileSync(join(d, '.backup-owner'), `${mark}\n`);
      return d;
    };
    const oldest = set(['hatchabot-kitchen-1-vol.tgz'], '2026-01-01', 40);
    const garden = set(['hatchabot-kitchen-1-vol.tgz', 'hatchabot-garden-2-vol.tgz'], '2026-01-02', 30);
    const last = set(['hatchabot-kitchen-1-vol.tgz'], '2026-01-03', 20);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.record()).toMatchObject({ state: 'complete', volumes: 0 });
    expect(existsSync(last)).toBe(true); // the newest copy of the kitchen's volume
    expect(existsSync(garden)).toBe(true); // the newest copy of the garden's
    expect(r.stdout).toContain('kept 2026-01-02 past 14 days: the newest copy of hatchabot-garden-2-vol');
    expect(existsSync(oldest)).toBe(false); // an older copy, as ever
  });

  it('the same new machine once it knows one agent (made there before the restore): the old machine\'s newest copies are still kept; a deleted agent\'s and older copies go (HB-1380)', () => {
    const w = scriptWorld(['hatchabot-notes-5-vol'], ['docker://hatchabot-notes-5', 'docker://hatchabot-gone-9']);
    w.setState('docker://hatchabot-gone-9', 'DELETED');
    const mark = spawnSync('bash', ['-c', '. scripts/backup-owner.sh; HATCHABOT_SECRET_KEY=not-a-real-key key_owner'], { encoding: 'utf8' }).stdout.trim();
    const set = (files: string[], date: string, daysAgo: number) => {
      const d = w.oldSet(['hatchabot.sqlite', '.backup-owner', ...files], date, daysAgo);
      writeFileSync(join(d, '.backup-owner'), `${mark}\n`);
      return d;
    };
    // The old machine's sets: its kitchen and garden agents, which this registry never listed.
    const oldest = set(['hatchabot-kitchen-1-vol.tgz'], '2026-01-01', 40);
    const garden = set(['hatchabot-kitchen-1-vol.tgz', 'hatchabot-garden-2-vol.tgz'], '2026-01-02', 30);
    const last = set(['hatchabot-kitchen-1-vol.tgz'], '2026-01-03', 20);
    // A set of this machine's with only an agent it deleted since.
    const gone = set(['hatchabot-gone-9-vol.tgz'], '2026-01-04', 18);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.record()).toMatchObject({ state: 'complete', volumes: 1 });
    expect(existsSync(last)).toBe(true); // the newest copy of the kitchen's volume
    expect(existsSync(garden)).toBe(true); // the newest copy of the garden's
    expect(r.stdout).toContain('kept 2026-01-02 past 14 days: the newest copy of hatchabot-garden-2-vol\n    (no agent here has had hatchabot-garden-2-vol: another machine\'s, or a database not restored yet; kept until a restored database names it, or you delete the set)');
    expect(existsSync(oldest)).toBe(false); // an older copy, as ever
    expect(existsSync(gone)).toBe(false); // the registry says that agent was deleted
    // The sets kept for those alone are in the run's record, for hatchabot doctor (review of HB-1380).
    expect(w.record().keptUnlisted).toEqual({ '2026-01-03': ['hatchabot-kitchen-1-vol'], '2026-01-02': ['hatchabot-garden-2-vol'] });
    // A folder the find takes for a set, named with a quote and a brace: kept
    // as before, but no part of the record, which stays JSON (review of HB-1380).
    const odd = set(['hatchabot-notes-6-vol.tgz'], '20"}-01-02', 25);
    const third = w.run();
    expect(third.status, third.stdout + third.stderr).toBe(0);
    expect(existsSync(odd)).toBe(true);
    expect(w.record().keptUnlisted).toEqual({ '2026-01-03': ['hatchabot-kitchen-1-vol'], '2026-01-02': ['hatchabot-garden-2-vol'] });
    rmSync(odd, { recursive: true });
    // Once a restored database names the garden's agent, deleted, its copy goes by age.
    const db = new Database(join(w.repo, 'data', 'hatchabot.sqlite'));
    db.prepare(`INSERT INTO agents (id, state, runtime_ref) VALUES ('a-garden', 'DELETED', 'docker://hatchabot-garden-2')`).run();
    db.close();
    const again = w.run();
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(existsSync(garden)).toBe(false);
    expect(existsSync(last)).toBe(true);
    expect(w.record().keptUnlisted).toEqual({ '2026-01-03': ['hatchabot-kitchen-1-vol'] });
  });

  it('only an agent whose failed first start left no volume: the set is complete, older sets are pruned, that agent\'s newest copy kept (review of HB-1110)', () => {
    const w = scriptWorld([], ['docker://hatchabot-broke-1', 'docker://hatchabot-gone-9']);
    w.setState('docker://hatchabot-broke-1', 'FAILED');
    w.setState('docker://hatchabot-gone-9', 'DELETED');
    const broke = w.oldSet(['hatchabot.sqlite', 'secret-key.env', 'hatchabot-broke-1-vol.tgz'], '2026-01-02');
    const gone = w.oldSet(['hatchabot.sqlite', 'secret-key.env', 'hatchabot-gone-9-vol.tgz'], '2026-01-03');
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('hatchabot-broke-1-vol: its agent failed to start and has no volume — nothing to back up');
    expect(w.record()).toMatchObject({ state: 'complete', volumes: 0 });
    expect(existsSync(broke)).toBe(true);
    expect(existsSync(gone)).toBe(false);
  });

  it('no volumes and a registry that cannot be read: refused, nothing pruned', () => {
    const w = scriptWorld([], []);
    // A database that copies fine but has no agents table to read.
    const db = new Database(join(w.repo, 'data', 'hatchabot.sqlite'));
    db.exec('DROP TABLE agents; CREATE TABLE other (x TEXT)');
    db.close();
    const old = w.oldSet(['hatchabot.sqlite']);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toMatch(/database copy could not be read — refusing to prune/);
    expect(w.record()).toMatchObject({ state: 'incomplete' });
    expect(existsSync(old)).toBe(true);
  });
});

describe('scripts/backup-volumes.sh: review of 2026-10-09', () => {
  it('a runner that answers but whose archive fails is FAILED, not skipped: incomplete, nothing pruned', () => {
    for (const bad of ['hatchabot-broken-5', 'hatchabot-torn-6']) {
      const w = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
      w.onRunners([['ssh://laptop.test', 'docker://hatchabot-notes-3'], ['ssh://laptop.test', `docker://${bad}`]]);
      const old = w.oldSet(['hatchabot.sqlite', `${bad}-vol.tgz`]);
      const r = w.run();
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(w.record()).toMatchObject({ state: 'incomplete', volumes: 2, failedVolumes: [`${bad}-vol`], skipped: [] });
      expect(existsSync(join(w.setDir(), `${bad}-vol.tgz`))).toBe(false);
      expect(existsSync(join(w.setDir(), `${bad}-vol.tgz.part`))).toBe(false);
      expect(existsSync(join(old, `${bad}-vol.tgz`)), bad).toBe(true);
    }
  }, 30_000);

  it('a runner archive that times out: its named container is removed before the run goes on (#216)', () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
    w.onRunners([['ssh://laptop.test', 'docker://hatchabot-notes-3'], ['ssh://laptop.test', 'docker://hatchabot-recipes-4']]);
    // A `timeout` whose archive deadline passes for the notes volume: the
    // docker client starts, then is killed (exit 124), as a stalled runner's would be.
    writeFileSync(join(w.bin, 'timeout'), `#!/usr/bin/env bash
while :; do case "$1" in --foreground) shift ;; -k) shift 2 ;; *) break ;; esac; done
d="$1"; shift
if [ "$d" = 3600 ] && [[ "$*" == *hatchabot-notes-3-vol* ]]; then "$@" > /dev/null; exit 124; fi
exec "$@"
`, { mode: 0o755 });
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(w.record()).toMatchObject({ state: 'incomplete', failedVolumes: ['hatchabot-notes-3-vol'] });
    const log = w.remoteLog().split('\n');
    const runAt = log.findIndex((l) => l.includes(' run ') && l.includes('hatchabot-notes-3-vol'));
    const name = /--name (\S+)/.exec(log[runAt]!)![1]!;
    expect(name).toMatch(/^hatchabot-bk-/);
    expect(log[runAt]).toContain('--label hatchabot.oneshot=hatchabot');
    expect(log[runAt]).toContain('--sig-proxy=false'); // a TERM ends the client
    const rmAt = log.indexOf(`ssh://laptop.test rm -f ${name}`);
    expect(rmAt, log.join('\n')).toBeGreaterThan(runAt);
    // Removed before the next volume was read.
    expect(rmAt).toBeLessThan(log.findIndex((l) => l.includes(' run ') && l.includes('hatchabot-recipes-4-vol')));
    // An archive that worked leaves nothing to remove.
    expect(log.filter((l) => l.includes(' rm -f '))).toHaveLength(1);
  });

  it('a runner asleep past the retention: the set with its agent\'s newest copy is kept, the rest are pruned', () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1', 'docker://hatchabot-gone-9']);
    w.setState('docker://hatchabot-gone-9', 'DELETED');
    w.onRunners([['ssh://asleep.test', 'docker://hatchabot-garden-4']]);
    // Oldest to newest: a copy of the garden agent, a newer one, then sets without it.
    const first = w.oldSet(['hatchabot.sqlite', 'hatchabot-garden-4-vol.tgz', 'hatchabot-kitchen-1-vol.tgz'], '2026-01-01', 40);
    const newest = w.oldSet(['hatchabot.sqlite', 'hatchabot-garden-4-vol.tgz', 'hatchabot-kitchen-1-vol.tgz'], '2026-01-05', 36);
    const later = w.oldSet(['hatchabot.sqlite', 'hatchabot-kitchen-1-vol.tgz', 'hatchabot-gone-9-vol.tgz'], '2026-01-09', 32);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.record()).toMatchObject({ state: 'complete', skipped: ['hatchabot-garden-4-vol'] });
    expect(existsSync(newest), 'the newest copy of the sleeping runner\'s agent').toBe(true);
    expect(r.stdout).toMatch(/kept 2026-01-05 past 14 days: the newest copy of hatchabot-garden-4-vol/);
    expect(existsSync(first), 'an older copy of it').toBe(false);
    // Tonight's set holds the kitchen agent; a deleted agent's last copy is not held.
    expect(existsSync(later)).toBe(false);
  });

  it('a runner volume that is not there is missing, and is never mounted (which would make an empty one)', () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
    w.onRunners([['ssh://laptop.test', 'docker://hatchabot-notes-3'], ['ssh://laptop.test', 'docker://hatchabot-gone-7']]);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toMatch(/hatchabot-gone-7-vol: an agent on laptop\.test uses it, but that runner has no volume by that name/);
    expect(w.record()).toMatchObject({ state: 'incomplete', volumes: 2, failedVolumes: ['hatchabot-gone-7-vol'], missing: ['hatchabot-gone-7-vol'] });
    expect(w.remoteLog()).toContain('ssh://laptop.test volume inspect --format {{.Name}} hatchabot-gone-7-vol');
    expect(w.remoteLog()).not.toMatch(/run .*-v hatchabot-gone-7-vol:/);
    expect(existsSync(join(w.setDir(), 'hatchabot-gone-7-vol.tgz'))).toBe(false);
  });

  it('a runner agent whose first start failed has no volume: noted, not failed', () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
    w.onRunners([['ssh://laptop.test', 'docker://hatchabot-gone-7']]);
    w.setState('docker://hatchabot-gone-7', 'FAILED');
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/hatchabot-gone-7-vol: its agent failed to start and has no volume/);
    expect(w.record()).toMatchObject({ state: 'complete', missing: [] });
  });

  it('the copy a move left on this machine is not taken under the agent\'s name', () => {
    // The agent lives on the runner (asleep tonight); its old volume is still here.
    const w = scriptWorld(['hatchabot-kitchen-1-vol', 'hatchabot-notes-3-vol'], ['docker://hatchabot-kitchen-1']);
    w.onRunners([['ssh://asleep.test', 'docker://hatchabot-notes-3']]);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/hatchabot-notes-3-vol: its agent lives on another machine now — this machine's copy is left from before the move/);
    expect(existsSync(join(w.setDir(), 'hatchabot-notes-3-vol.tgz'))).toBe(false);
    expect(w.record()).toMatchObject({ orphans: ['hatchabot-notes-3-vol'], skipped: ['hatchabot-notes-3-vol'] });
  });

  it('a local volume that fails leaves no torn archive under its real name', () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol', 'hatchabot-broken-2-vol'], ['docker://hatchabot-kitchen-1', 'docker://hatchabot-broken-2']);
    expect(w.run().status).toBe(1);
    expect(readdirSync(w.setDir()).filter((f) => /broken/.test(f))).toEqual([]);
  });

  it('one run per set: a second run while one is writing stops before it writes; a dead run\'s lock is taken over', () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
    const lock = join(w.today(), '.backup-lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), String(process.pid)); // alive: this test
    const r = w.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Another backup run \(pid \d+\) is writing/);
    expect(existsSync(join(w.today(), 'backup-status.json'))).toBe(false);
    expect(existsSync(join(w.today(), 'hatchabot.sqlite'))).toBe(false);
    expect(existsSync(lock), 'the other run\'s lock stays').toBe(true);
    // The holder is gone (killed): the next run takes over, and leaves no lock.
    const dead = spawnSync('bash', ['-c', 'echo $$']).stdout.toString().trim();
    writeFileSync(join(lock, 'pid'), dead);
    const again = w.run();
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(w.record()).toMatchObject({ state: 'complete' });
    expect(existsSync(lock)).toBe(false);
  });

  // Pid 1 is another user's (root's) process whenever the tests run as anyone else.
  it.skipIf(process.getuid?.() === 0)('a lock held by another user\'s run (two installs sharing a base) is not taken for a dead one (HB-0071)', () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
    const lock = join(w.today(), '.backup-lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), '1');
    const r = w.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Another backup run \(pid 1\) is writing/);
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe('1');
    expect(existsSync(join(w.today(), 'hatchabot.sqlite'))).toBe(false);
  });

  it('two runs that both find a dead run\'s lock: only one takes it over, and neither removes the other\'s lock (#215)', async () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
    const lock = join(w.today(), '.backup-lock');
    mkdirSync(lock, { recursive: true });
    const dead = spawnSync('bash', ['-c', 'echo $$']).stdout.toString().trim();
    writeFileSync(join(lock, 'pid'), dead);
    writeFileSync(join(w.root, 'slow'), '');
    // A `cat` that reads the lock's pid, then holds the answer until both runs
    // have read it: the two have seen the same dead holder before either
    // writes its own pid. Every other read is the real cat.
    const reads = join(w.root, 'reads'); mkdirSync(reads);
    writeFileSync(join(w.bin, 'cat'), `#!/usr/bin/env bash
case "$*" in
  *.backup-lock/pid) seen="$(/bin/cat "$@" 2>/dev/null)"; rc=$?
    mktemp "${reads}/r.XXXXXX" > /dev/null
    for _ in $(seq 50); do [ "$(ls "${reads}" | wc -l)" -ge 2 ] && break; sleep 0.1; done
    printf '%s\\n' "$seen"; exit $rc ;;
esac
exec /bin/cat "$@"
`, { mode: 0o755 });
    const [a, b] = await Promise.all([w.start(), w.start()]);
    const ran = [a, b].filter((r) => r.status === 0);
    const stopped = [a, b].filter((r) => r.status === 1);
    expect(ran, a.out + b.out).toHaveLength(1);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.out).toMatch(/Another backup run/);
    expect(w.record()).toMatchObject({ state: 'complete' });
    expect(existsSync(lock), 'the run that took it over removed its own lock').toBe(false);
  });

  it('a run releases only its own lock: one that now names another run is left to it (#215)', async () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
    const lock = join(w.today(), '.backup-lock');
    // The run waits inside its backup, lock held, until the test lets it go: no timed sleep to
    // race on a loaded machine (HB-0622).
    const hold = join(w.root, 'hold');
    writeFileSync(hold, '');
    const running = w.start();
    let ended = false;
    const end = running.then((r) => { ended = true; return r; });
    // While it backs up, the lock comes to name another (live) run.
    // A whole pid, not just the file: `echo $$ > pid` creates it empty before it writes.
    const holds = () => { try { return /^\d+\s*$/.test(readFileSync(join(lock, 'pid'), 'utf8')); } catch { return false; } };
    try {
      const until = Date.now() + 30_000;
      while (!holds() && !ended && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      expect(ended, 'the run ended before its lock was seen').toBe(false);
      expect(holds(), 'the run never wrote its lock').toBe(true);
      writeFileSync(join(lock, 'pid'), String(process.pid));
    } finally {
      rmSync(hold, { force: true }); // never leave the run held past the test
    }
    expect((await end).status).toBe(0);
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(String(process.pid));
  }, 60_000);

  it('a base directory that is already there keeps its mode; a new one is 0700; the set is 0700', () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
    mkdirSync(w.backups); chmodSync(w.backups, 0o755);
    expect(w.run().status).toBe(0);
    expect(statSync(w.backups).mode & 0o777).toBe(0o755);
    expect(statSync(w.setDir()).mode & 0o777).toBe(0o700);
    const fresh = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
    expect(fresh.run().status).toBe(0);
    expect(statSync(fresh.backups).mode & 0o777).toBe(0o700);
  });
});

describe('scripts/backup-volumes.sh run by hand reads the install\'s .env, as the service does (audit #023)', () => {
  /** A registry somewhere else, naming one agent, as a moved HATCHABOT_DB would. */
  const movedRegistry = (root: string, ref: string) => {
    const path = join(root, 'moved', 'registry.sqlite'); mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.exec(`CREATE TABLE agents (id TEXT, state TEXT, runtime_ref TEXT)`);
    db.prepare(`INSERT INTO agents VALUES ('a-moved', 'RUNNING', ?)`).run(ref);
    db.close();
    return path;
  };

  it('backs up the registry .env names, not a stale default one beside it; the environment still wins over .env', () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol', 'hatchabot-garden-2-vol'], ['docker://hatchabot-kitchen-1']);
    const moved = movedRegistry(w.root, 'docker://hatchabot-garden-2');
    const elsewhere = join(w.root, 'not-these-backups');
    writeFileSync(join(w.repo, '.env'), `HATCHABOT_SECRET_KEY=not-a-real-key\nHATCHABOT_DB=${moved}\nHATCHABOT_BACKUP_DIR=${elsewhere}\n`);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const copy = new Database(join(w.setDir(), 'hatchabot.sqlite'), { readonly: true });
    expect(copy.prepare('SELECT id FROM agents').all()).toEqual([{ id: 'a-moved' }]);
    copy.close();
    expect(existsSync(join(w.setDir(), 'hatchabot-garden-2-vol.tgz'))).toBe(true);
    expect(w.record()).toMatchObject({ state: 'complete', orphans: ['hatchabot-kitchen-1-vol'] });
    expect(existsSync(elsewhere)).toBe(false); // HATCHABOT_BACKUP_DIR from the command line beat the .env's
  });

  it('a pre-rename AGENTCLAW_DB in .env is the registry when the default one is not there', () => {
    const w = scriptWorld(['hatchabot-garden-2-vol'], []);
    rmSync(join(w.repo, 'data', 'hatchabot.sqlite'));
    const moved = movedRegistry(w.root, 'docker://hatchabot-garden-2');
    writeFileSync(join(w.repo, '.env'), `AGENTCLAW_SECRET_KEY=not-a-real-key\nAGENTCLAW_DB=${moved}\n`);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(w.setDir(), 'hatchabot-garden-2-vol.tgz'))).toBe(true);
    expect(w.record()).toMatchObject({ state: 'complete', captured: ['hatchabot-garden-2-vol'] });
  });
});

describe('scripts/restore-drill.sh picks a set worth drilling (2026-10-09)', () => {
  /** The drill in a sandbox: it stops at the database check (no hatchabot.sqlite), before any docker. */
  function drill(base: string, args: string[] = []) {
    const root = tmp('hb-drill-');
    mkdirSync(join(root, 'install', 'scripts'), { recursive: true });
    for (const f of ['restore-drill.sh', 'backup-owner.sh']) writeFileSync(join(root, 'install', 'scripts', f), readFileSync(join('scripts', f)), { mode: 0o755 });
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', 'docker'), '#!/bin/sh\necho "docker must not run here" >&2; exit 99\n', { mode: 0o755 });
    return spawnSync('bash', [join(root, 'install', 'scripts', 'restore-drill.sh'), ...args], {
      encoding: 'utf8',
      env: { HOME: join(root, 'install'), PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HATCHABOT_BACKUP_DIR: base },
    });
  }
  it('no backups directory: says so', () => {
    const r = drill(join(tmp('hb-drill-base-'), 'nothing-here'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/No backups directory at .*nothing-here/);
  });
  it('the newest complete set, passing over a newer incomplete one; a set from before the record counts', () => {
    const base = tmp('hb-drill-base-');
    const set = (date: string, state?: string) => {
      mkdirSync(join(base, date));
      if (state) writeFileSync(join(base, date, 'backup-status.json'), JSON.stringify({ state, startedAt: '2026-10-01T03:30:00Z' }));
    };
    set('2026-10-01'); set('2026-10-02', 'complete'); set('2026-10-03', 'incomplete'); set('2026-10-04', 'running');
    const r = drill(base);
    expect(r.stdout).toMatch(/Drilling restore from: .*2026-10-02$/m);
    expect(r.stderr).toMatch(/2026-10-04 is not a complete set \(its run says "running"\)/);
    expect(r.stderr).toMatch(/2026-10-03 is not a complete set \(its run says "incomplete"\)/);
    expect(r.stderr).not.toMatch(/docker must not run/);
    rmSync(join(base, '2026-10-02'), { recursive: true });
    expect(drill(base).stdout).toMatch(/Drilling restore from: .*2026-10-01$/m);
    rmSync(join(base, '2026-10-01'), { recursive: true });
    const none = drill(base);
    expect(none.status).toBe(1);
    expect(none.stderr).toMatch(/No complete backup set under/);
    // Named on the command line: drilled, with a warning.
    expect(drill(base, [join(base, '2026-10-03')]).stderr).toMatch(/2026-10-03 is not a complete set .* drilling it anyway/);
  });
});

describe('scripts/backup-volumes.sh leaves out what an agent rebuilds (review, 2026-09-29)', () => {
  it('skips the regenerable caches at the volume root and keeps plugins, installs and workspace look-alikes', () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
    const skipped = [
      '.openclaw/cache/control-ui-assets/0123abcd/index.html',
      '.openclaw/tmp/plugin-captures/one/owner.sqlite',
      '.openclaw/tmp/openclaw-1000/gateway.state.lock',
      '.npm/_cacache/index-v5/aa/bb',
      '.cache/pip/http-v2/a/b',
    ];
    const kept = [
      '.openclaw/openclaw.json',
      '.openclaw/agents/main/agent/auth-profiles.json',
      '.openclaw/npm/projects/openclaw-discord/node_modules/x/package.json', // plugin installs
      '.openclaw/cache/other/keep.json', // only control-ui-assets is known to be rebuilt
      '.openclaw/tmpfoo/keep', // a prefix, not the tmp directory
      '.npm-global/lib/node_modules/some-cli/package.json', // npm install -g
      '.cache/puppeteer/chrome/keep', // not proven regenerable
      '.cache/claude-cli-nodejs/keep',
      '.openclaw/workspace/proj/.npm/keep', // anchored: only the volume root's
      '.openclaw/workspace/proj/.cache/pip/keep',
      '.openclaw/workspace/.openclaw/tmp/keep',
    ];
    w.fillVolume('hatchabot-kitchen-1-vol', [...skipped, ...kept]);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const listing = spawnSync('tar', ['tzf', join(w.setDir(), 'hatchabot-kitchen-1-vol.tgz')], { encoding: 'utf8' });
    expect(listing.status, listing.stderr).toBe(0);
    const names = new Set(listing.stdout.split('\n').filter(Boolean));
    for (const f of kept) expect(names.has(`./${f}`), f).toBe(true);
    for (const f of skipped) expect(names.has(`./${f}`), f).toBe(false);
    // The directories themselves are gone too, not only their files.
    for (const d of ['./.npm/', './.openclaw/tmp/', './.openclaw/cache/control-ui-assets/', './.cache/pip/']) expect(names.has(d), d).toBe(false);
    expect(names.has('./.openclaw/cache/')).toBe(true);
  });
});

/** Whether process `pid` is gone (a zombie its new parent has not reaped yet counts as gone once it cannot be signalled). */
const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };

describe('"Back up now" has a time limit, and what it started stops with it (HB-0923)', () => {
  it('a run held by a Docker that never answers ends failed and says so; its trap\'s own stuck call is killed too', async () => {
    const { startBackup, backupRunState } = await import('../src/orchestrator/backups/backupFiles.js');
    const dir = tmp('hb-bk-hung-');
    const pids = join(dir, 'pids');
    // Like the real script: a TERM trap, a step that never ends, and an EXIT
    // trap that makes a docker call of its own (reap_oneshot) after the TERM.
    const script = join(dir, 'backup.sh');
    writeFileSync(script, `#!/bin/bash\ntrap 'exit 143' TERM\ntrap 'sleep 30 & echo $! >> "${pids}"; wait $!' EXIT\necho "  ✓ made-up volume one"\nsleep 30\n`, { mode: 0o700 });
    const saved = process.env.HATCHABOT_BACKUP_SCRIPT;
    process.env.HATCHABOT_BACKUP_SCRIPT = script;
    try {
      let done: { status: string; summary?: string } | undefined;
      const t0 = Date.now();
      expect(startBackup(t0, (st) => { done = st; }, { killAfterMs: 300, graceMs: 500 }).status).toBe('running');
      await vi.waitFor(() => expect(done).toBeTruthy(), { timeout: 10_000, interval: 50 });
      expect(Date.now() - t0).toBeLessThan(8_000);
      expect(done).toMatchObject({ status: 'error', summary: expect.stringMatching(/made-up volume one[\s\S]*took longer than its time limit and was stopped: Docker may not be answering/) });
      expect(backupRunState().status).toBe('error');
      const left = readFileSync(pids, 'utf8').trim().split('\n').map(Number);
      await vi.waitFor(() => expect(left.every(gone)).toBe(true), { timeout: 5_000, interval: 50 });
    } finally { if (saved !== undefined) process.env.HATCHABOT_BACKUP_SCRIPT = saved; else delete process.env.HATCHABOT_BACKUP_SCRIPT; }
  }, 20_000);

  const realTimeout = spawnSync('bash', ['-c', 'command -v timeout'], { encoding: 'utf8' }).stdout.trim();
  it.skipIf(!realTimeout)('a step that outlives the time limit (GNU timeout leaves the group) never settles the next run: each run ends once, as itself', async () => {
    const { startBackup, backupRunState } = await import('../src/orchestrator/backups/backupFiles.js');
    const dir = tmp('hb-bk-late-');
    // Run one: a step under a plain `timeout`, which makes its own process group,
    // so the time limit's TERM and KILL never reach it and it holds the output open.
    const one = join(dir, 'one.sh');
    writeFileSync(one, `#!/bin/bash\ntrap 'exit 143' TERM\necho "run one"\n"${realTimeout}" 2 sleep 2\n`, { mode: 0o700 });
    const two = join(dir, 'two.sh');
    writeFileSync(two, '#!/bin/bash\nsleep 3\necho "run two done"\n', { mode: 0o700 });
    const saved = process.env.HATCHABOT_BACKUP_SCRIPT;
    try {
      const first: Array<{ status: string }> = [], second: Array<{ status: string; summary?: string }> = [];
      process.env.HATCHABOT_BACKUP_SCRIPT = one;
      startBackup(Date.now(), (st) => { first.push(st); }, { killAfterMs: 100, graceMs: 200 });
      await vi.waitFor(() => expect(first).toHaveLength(1), { timeout: 5_000, interval: 20 });
      expect(first[0]).toMatchObject({ status: 'error' });
      process.env.HATCHABOT_BACKUP_SCRIPT = two;
      expect(startBackup(Date.now(), (st) => { second.push(st); }).status).toBe('running');
      // Run one's step ends at two seconds, its output with it: run two is still running.
      await new Promise((r) => setTimeout(r, 2_300));
      expect(backupRunState().status).toBe('running');
      expect(second).toEqual([]);
      await vi.waitFor(() => expect(second).toHaveLength(1), { timeout: 5_000, interval: 20 });
      expect(second[0]).toMatchObject({ status: 'ok', summary: 'run two done' });
      expect(backupRunState()).toMatchObject({ status: 'ok', summary: 'run two done' });
      expect(first).toHaveLength(1);
    } finally { if (saved !== undefined) process.env.HATCHABOT_BACKUP_SCRIPT = saved; else delete process.env.HATCHABOT_BACKUP_SCRIPT; }
  }, 20_000);

  it.skipIf(!realTimeout)('stopped at its time limit in an archive under the real timeout: the TERM reaches the docker client, and the trap writes the record, removes its one-shot and frees the lock', async () => {
    const { scriptDeadline } = await import('../src/orchestrator/backups/backupFiles.js');
    const w = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
    writeFileSync(join(w.root, 'hold'), ''); // the archive's docker run never answers
    const c = w.spawnRun();
    const t0 = Date.now();
    while (!/^run /m.test(w.localLog()) && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 20));
    expect(w.localLog()).toMatch(/^run /m);
    // The app's time limit, now: the TERM to the run's group, its KILL long after.
    let stopped = false;
    const closed = new Promise<number | null>((r) => c.on('close', (code) => r(code)));
    const callOff = scriptDeadline(c, 0, 25_000, { term: () => {}, stopped: () => { stopped = true; } });
    const code = await closed;
    callOff();
    expect(stopped).toBe(false); // it ended by itself, its trap run, before anything was killed
    expect(code).toBe(143);
    expect(w.record()).toMatchObject({ state: 'incomplete' });
    expect(existsSync(join(w.setDir(), '.backup-lock'))).toBe(false);
    expect(w.localLog()).toMatch(/^rm -f hatchabot-bk-/m);
  }, 40_000);

  it.skipIf(!realTimeout)('every docker call on this machine is bounded: an archive that hangs fails its volume, and the run goes on to its record', () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
    // timeout as a shim: what it was asked, then the real one with a second's limit.
    writeFileSync(join(w.bin, 'timeout'), `#!/usr/bin/env bash
echo "$*" >> "${w.root}/timeout.log"
o=(); while :; do case "$1" in --foreground) o+=(--foreground); shift ;; -k) o+=(-k 1); shift 2 ;; *) break ;; esac; done
shift
exec "${realTimeout}" "\${o[@]}" 1 "$@"
`, { mode: 0o755 });
    writeFileSync(join(w.root, 'hold'), ''); // the archive's docker run never answers (its shim waits up to a minute)
    const t0 = Date.now();
    const r = w.run();
    expect(Date.now() - t0).toBeLessThan(25_000);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toMatch(/hatchabot-kitchen-1-vol: archiving it was still going at this run's six-hour limit — stopped/);
    expect(w.record()).toMatchObject({ state: 'incomplete', failedVolumes: ['hatchabot-kitchen-1-vol'] });
    expect(existsSync(join(w.setDir(), 'hatchabot-kitchen-1-vol.tgz'))).toBe(false);
    const asked = readFileSync(join(w.root, 'timeout.log'), 'utf8');
    for (const call of [/^--foreground -k 10 60 docker image inspect /m, /^--foreground -k 10 60 docker info /m, /^--foreground -k 10 120 docker volume ls -q$/m, /^--foreground -k 10 120 docker volume ls -q --filter label=hatchabot\.role=browser-logins$/m, /^--foreground 120 docker rm -f hatchabot-bk-/m]) {
      expect(asked).toMatch(call);
    }
    // An archive has what is left of the run's six hours, not an hour: a big
    // volume on a slow disk is no hung Docker (review of HB-0923).
    const archive = Number(/^--foreground -k 10 (\d+) docker run --rm --name hatchabot-bk-/m.exec(asked)?.[1]);
    expect(archive).toBeGreaterThan(6 * 3600 - 60);
    expect(archive).toBeLessThanOrEqual(6 * 3600);
  }, 30_000);

  it.skipIf(!realTimeout)('a Mac with Homebrew\'s coreutils but not its gnubin (gtimeout, no timeout): every docker call is still bounded (HB-1208)', () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol'], ['docker://hatchabot-kitchen-1']);
    // gtimeout as a shim: what it was asked, then the real one with a second's limit.
    writeFileSync(join(w.bin, 'gtimeout'), `#!/usr/bin/env bash
echo "$*" >> "${w.root}/gtimeout.log"
o=(); while :; do case "$1" in --foreground) o+=(--foreground); shift ;; -k) o+=(-k 1); shift 2 ;; *) break ;; esac; done
shift
exec "${realTimeout}" "\${o[@]}" 1 "$@"
`, { mode: 0o755 });
    symlinkSync(process.execPath, join(w.bin, 'node'));
    writeFileSync(join(w.root, 'hold'), ''); // the archive's docker run never answers (its shim waits up to a minute)
    const t0 = Date.now();
    const r = w.run({ PATH: `${w.bin}:${systemPathWithout(join(w.root, 'system'), ['timeout', 'gtimeout'])}` });
    expect(Date.now() - t0).toBeLessThan(25_000);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toMatch(/hatchabot-kitchen-1-vol: archiving it was still going at this run's six-hour limit — stopped/);
    expect(w.record()).toMatchObject({ state: 'incomplete', failedVolumes: ['hatchabot-kitchen-1-vol'] });
    const asked = readFileSync(join(w.root, 'gtimeout.log'), 'utf8');
    for (const call of [/^--foreground -k 10 60 docker image inspect /m, /^--foreground -k 10 120 docker volume ls -q$/m, /^--foreground -k 10 \d+ docker run --rm --name hatchabot-bk-/m, /^--foreground 120 docker rm -f hatchabot-bk-/m]) {
      expect(asked).toMatch(call);
    }
  }, 30_000);

  it('the script\'s own time limit is the app\'s', async () => {
    const { BACKUP_KILL_MS } = await import('../src/orchestrator/backups/backupFiles.js');
    expect(Number(/^RUN_LIMIT_SEC=(\d+)$/m.exec(readFileSync('scripts/backup-volumes.sh', 'utf8'))?.[1]) * 1000).toBe(BACKUP_KILL_MS);
  });
});

describe('scripts/backup-volumes.sh takes no volume whose files are being replaced (HB-0922)', () => {
  /** The registry's operations, as the store keeps them (the columns the script reads); changed when asked for, unless said. */
  const ops = (repo: string, rows: Array<[agent: string, kind: string, status: string, requestedAt: string, updatedAt?: string]>) => {
    const db = new Database(join(repo, 'data', 'hatchabot.sqlite'));
    db.exec(`CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, agent_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, requested_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    rows.forEach(([agent, kind, status, at, upd], i) => db.prepare(`INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?)`).run(`op-${agent}-${i}`, agent, kind, status, at, upd ?? at));
    db.close();
  };

  /** Held for the owner's choice, only these leave the files half-replaced (scripts/backup-volumes.sh, replacing). */
  const HELD_HALF = ['restore-backup', 'restore-snapshot', 'import', 'adopt-workspace'];

  it('an agent in the middle of a restore, an import, a move or any change that replaces its files is left out, and the set is incomplete; a change that ended, or one that does not replace them, is no bar', () => {
    const kinds = [...FILES_REPLACED_BY];
    expect(kinds.filter((k) => HELD_HALF.includes(k)).sort()).toEqual([...HELD_HALF].sort());
    // Each kind running, then each kind held for its owner, then the rest.
    const rows: Array<[kind: string, status: string]> = [
      ...kinds.map((k): [string, string] => [k, 'running']),
      ...kinds.map((k): [string, string] => [k, 'held']),
      ['move-host', 'interrupted'], // cut off by a restart, not settled yet
      ['restore-backup', 'succeeded'], // over before the run began
      ['app-install', 'running'], // adds an app: the agent's files are not replaced
    ];
    const refs = rows.map((_, i) => `docker://hatchabot-k${i}`);
    const w = scriptWorld(refs.map((r) => `${r.slice('docker://'.length)}-vol`), refs);
    w.onRunners([['ssh://laptop.test', 'docker://hatchabot-notes-3']]);
    const now = new Date().toISOString(), before = new Date(Date.now() - 3600_000).toISOString();
    ops(w.repo, [
      ...rows.map(([k, s], i): [string, string, string, string] => [`a${i}`, k, s, k === 'app-install' ? now : before]),
      ['r0', 'restore-backup', 'held', before], // on a runner: asked before it is read there
    ]);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    const out = (k: string, s: string) => FILES_REPLACED_BY.has(k) && (s === 'running' || s === 'interrupted' || (s === 'held' && HELD_HALF.includes(k)));
    const left = [...rows.flatMap(([k, s], i) => (out(k, s) ? [`hatchabot-k${i}-vol`] : [])), 'hatchabot-notes-3-vol'];
    const taken = rows.flatMap(([k, s], i) => (out(k, s) ? [] : [`hatchabot-k${i}-vol`]));
    expect(left).toHaveLength(kinds.length + HELD_HALF.length + 2);
    const rec = w.record();
    expect([...rec.failedVolumes].sort()).toEqual([...left].sort());
    // Named apart too, as left out on purpose (HB-1205); still in failedVolumes for a reader from before.
    expect([...rec.replacing].sort()).toEqual([...left].sort());
    expect(rec.state).toBe('incomplete');
    expect([...rec.captured].sort()).toEqual([...taken].sort());
    for (const v of left) expect(existsSync(join(w.setDir(), `${v}.tgz`)), v).toBe(false);
    for (const v of taken) expect(existsSync(join(w.setDir(), `${v}.tgz`)), v).toBe(true);
    expect(r.stderr).toContain(`hatchabot-k${kinds.indexOf('restore-backup')}-vol: its agent is in the middle of a restore from a backup, which replaces its files — not in this set (the next backup takes it)`);
    expect(r.stderr).toContain(`hatchabot-k${kinds.length + kinds.indexOf('import')}-vol: its agent is in the middle of an import`);
    // An adopt held with its copy torn part way (HB-0980).
    expect(r.stderr).toContain(`hatchabot-k${kinds.length + kinds.indexOf('adopt-workspace')}-vol: its agent is in the middle of adopting a workspace`);
    // A move held for its owner (its copy whole on the machine the record names), an
    // app update held (the agent runs on and changes): taken, not left out night after night.
    expect(r.stderr).not.toContain(`hatchabot-k${kinds.length + kinds.indexOf('move-host')}-vol:`);
    expect(r.stderr).not.toContain(`hatchabot-k${kinds.length + kinds.indexOf('app-update')}-vol:`);
    expect(r.stderr).toContain('hatchabot-notes-3-vol on laptop.test: its agent is in the middle of a restore from a backup');
    // Not read at all: no archive was started for any of them.
    for (const v of left) expect(w.localLog() + w.remoteLog(), v).not.toMatch(new RegExp(`run .*${v}:`));
  }, 60_000);

  it('a volume left out while its files are replaced does not stop the pruning: its own newest copy is kept however old, the others go as usual; a real failure still prunes nothing (review of HB-0922)', () => {
    const w = scriptWorld(['hatchabot-k0-vol', 'hatchabot-k1-vol'], ['docker://hatchabot-k0', 'docker://hatchabot-k1']);
    ops(w.repo, [['a0', 'restore-backup', 'held', new Date(Date.now() - 3 * 86_400_000).toISOString()]]);
    const onlyK0 = w.oldSet(['hatchabot.sqlite', 'hatchabot-k0-vol.tgz'], '2026-01-02', 30);
    const k1Old = w.oldSet(['hatchabot.sqlite', 'hatchabot-k1-vol.tgz'], '2026-01-03', 29);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(w.record()).toMatchObject({ state: 'incomplete', failedVolumes: ['hatchabot-k0-vol'], replacing: ['hatchabot-k0-vol'], captured: ['hatchabot-k1-vol'] });
    expect(existsSync(onlyK0), 'the replaced volume\'s last whole copy').toBe(true);
    expect(existsSync(k1Old), 'an old set whose volume has a copy today').toBe(false);
    expect(r.stdout).toContain('kept 2026-01-02 past 14 days: the newest copy of hatchabot-k0-vol');
    expect(r.stderr).toContain('✗ 1 volume(s) left out while their files were being replaced, 1 succeeded — incomplete backup; older sets pruned as usual, each agent\'s newest copy kept.');
    expect(r.stderr).not.toContain('nothing pruned');

    // Beside a volume whose archive failed: nothing is pruned, as before.
    const b = scriptWorld(['hatchabot-k0-vol', 'hatchabot-broken-1-vol', 'hatchabot-k2-vol'], ['docker://hatchabot-k0', 'docker://hatchabot-broken-1', 'docker://hatchabot-k2']);
    ops(b.repo, [['a0', 'restore-backup', 'running', new Date().toISOString()]]);
    const k2Old = b.oldSet(['hatchabot.sqlite', 'hatchabot-k2-vol.tgz'], '2026-01-03', 29);
    const rb = b.run();
    expect(rb.status, rb.stdout + rb.stderr).toBe(1);
    expect(rb.stderr).toContain('✗ 2 volume(s) failed or missing, 1 succeeded — incomplete backup, nothing pruned.');
    // The failed one is no volume whose files were being replaced (HB-1205).
    expect(b.record()).toMatchObject({ replacing: ['hatchabot-k0-vol'] });
    expect([...b.record().failedVolumes].sort()).toEqual(['hatchabot-broken-1-vol', 'hatchabot-k0-vol']);
    expect(existsSync(k2Old)).toBe(true);
  }, 60_000);

  it('a restore that begins while a volume is being copied: that copy is not kept, and the whole one from earlier today stays', () => {
    const w = scriptWorld(['hatchabot-k0-vol', 'hatchabot-k1-vol'], ['docker://hatchabot-k0', 'docker://hatchabot-k1']);
    w.onRunners([['ssh://laptop.test', 'docker://hatchabot-notes-3']]);
    ops(w.repo, []);
    // A whole archive of k1 from this morning's run, which this run's record carries over (HB-0433).
    mkdirSync(w.today(), { recursive: true });
    writeFileSync(join(w.today(), 'hatchabot-k1-vol.tgz'), 'morning');
    writeFileSync(join(w.today(), 'backup-status.json'), JSON.stringify({ state: 'complete', startedAt: new Date().toISOString(), captured: ['hatchabot-k1-vol'] }));
    // docker as before, but reading k1 here, a restore from a snapshot begins and ends on its agent;
    // reading notes-3 on the runner, a restore from a backup begins there.
    const real = join(w.bin, 'docker.real');
    writeFileSync(real, readFileSync(join(w.bin, 'docker')), { mode: 0o755 });
    writeFileSync(join(w.bin, 'docker'), `#!/usr/bin/env bash
op=""
for a in "$@"; do case "$a" in hatchabot-k1-vol:/data:ro) op="a1 restore-snapshot succeeded" ;; hatchabot-notes-3-vol:/vol:ro) op="r0 restore-backup running" ;; esac; done
if [ -n "$op" ]; then
  node -e 'const D = require("better-sqlite3"); const db = new D(process.argv[1]); const [a, k, s] = process.argv[2].split(" ");
    const t = new Date().toISOString(); db.prepare("INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?)").run("op-" + a, a, k, s, t, t);' "${join(w.repo, 'data', 'hatchabot.sqlite')}" "$op"
fi
exec "${real}" "$@"
`, { mode: 0o755 });
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(w.record()).toMatchObject({ state: 'incomplete' });
    expect([...w.record().failedVolumes].sort()).toEqual(['hatchabot-k1-vol', 'hatchabot-notes-3-vol']);
    expect([...w.record().replacing].sort()).toEqual(['hatchabot-k1-vol', 'hatchabot-notes-3-vol']);
    expect(r.stderr).toContain('hatchabot-k1-vol: while it was being copied, a restore from a snapshot began on its agent, so this copy may be half replaced — not kept (the next backup takes it)');
    expect(r.stderr).toContain('hatchabot-notes-3-vol on laptop.test: while it was being copied, a restore from a backup began on its agent');
    expect(readFileSync(join(w.setDir(), 'hatchabot-k1-vol.tgz'), 'utf8')).toBe('morning');
    expect(existsSync(join(w.setDir(), 'hatchabot-notes-3-vol.tgz'))).toBe(false);
    expect(existsSync(join(w.setDir(), 'hatchabot-notes-3-vol.tgz.part'))).toBe(false);
    expect(existsSync(join(w.setDir(), 'hatchabot-k0-vol.tgz'))).toBe(true);
  }, 60_000);

  it('a rebuild queued before a volume was copied, that started and ended while it was: that copy is not kept; a held move whose question was asked again meanwhile is no bar (review of HB-0922)', () => {
    const w = scriptWorld(['hatchabot-k0-vol', 'hatchabot-k1-vol', 'hatchabot-k2-vol'], ['docker://hatchabot-k0', 'docker://hatchabot-k1', 'docker://hatchabot-k2']);
    const anHourAgo = new Date(Date.now() - 3600_000).toISOString();
    // a1's rebuild waits its turn in the queue; a2's move to another Hatchabot is held for an answer.
    ops(w.repo, [['a1', 'rebuild', 'queued', anHourAgo], ['a2', 'migrate', 'held', anHourAgo]]);
    // Reading k1, the rebuild starts and ends; reading k2, the held move is asked again (its row written, held still).
    const real = join(w.bin, 'docker.real');
    writeFileSync(real, readFileSync(join(w.bin, 'docker')), { mode: 0o755 });
    writeFileSync(join(w.bin, 'docker'), `#!/usr/bin/env bash
op=""
for a in "$@"; do case "$a" in hatchabot-k1-vol:/data:ro) op="a1 succeeded" ;; hatchabot-k2-vol:/data:ro) op="a2 held" ;; esac; done
if [ -n "$op" ]; then
  node -e 'const D = require("better-sqlite3"); const db = new D(process.argv[1]); const [a, s] = process.argv[2].split(" ");
    db.prepare("UPDATE operations SET status = ?, updated_at = ? WHERE agent_id = ?").run(s, new Date().toISOString(), a);' "${join(w.repo, 'data', 'hatchabot.sqlite')}" "$op"
fi
exec "${real}" "$@"
`, { mode: 0o755 });
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(w.record()).toMatchObject({ state: 'incomplete', failedVolumes: ['hatchabot-k1-vol'] });
    expect([...w.record().captured].sort()).toEqual(['hatchabot-k0-vol', 'hatchabot-k2-vol']);
    expect(r.stderr).toContain('hatchabot-k1-vol: while it was being copied, a rebuild began on its agent, so this copy may be half replaced — not kept (the next backup takes it)');
    expect(existsSync(join(w.setDir(), 'hatchabot-k1-vol.tgz'))).toBe(false);
    expect(existsSync(join(w.setDir(), 'hatchabot-k2-vol.tgz'))).toBe(true);
  }, 60_000);

  it('a rebuild queued before a volume was copied, that started while it was and was left held by an app restart: that copy is not kept; a hold of before, untouched, is still no bar (HB-1206)', () => {
    const w = scriptWorld(['hatchabot-k0-vol', 'hatchabot-k1-vol', 'hatchabot-k2-vol'], ['docker://hatchabot-k0', 'docker://hatchabot-k1', 'docker://hatchabot-k2']);
    const anHourAgo = new Date(Date.now() - 3600_000).toISOString();
    // a1's rebuild waits its turn; a2's app update has been held for its owner since an hour ago.
    ops(w.repo, [['a1', 'rebuild', 'queued', anHourAgo], ['a2', 'app-update', 'held', anHourAgo]]);
    // Reading k1, the rebuild starts, the app restarts, and the boot pass leaves it held.
    const real = join(w.bin, 'docker.real');
    writeFileSync(real, readFileSync(join(w.bin, 'docker')), { mode: 0o755 });
    writeFileSync(join(w.bin, 'docker'), `#!/usr/bin/env bash
for a in "$@"; do case "$a" in hatchabot-k1-vol:/data:ro)
  node -e 'const D = require("better-sqlite3"); const db = new D(process.argv[1]);
    db.prepare("UPDATE operations SET status = ?, updated_at = ? WHERE agent_id = ?").run("held", new Date().toISOString(), "a1");' "${join(w.repo, 'data', 'hatchabot.sqlite')}" ;;
esac; done
exec "${real}" "$@"
`, { mode: 0o755 });
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(w.record()).toMatchObject({ state: 'incomplete', failedVolumes: ['hatchabot-k1-vol'] });
    expect([...w.record().captured].sort()).toEqual(['hatchabot-k0-vol', 'hatchabot-k2-vol']);
    expect(r.stderr).toContain('hatchabot-k1-vol: while it was being copied, a rebuild began on its agent, so this copy may be half replaced — not kept (the next backup takes it)');
    expect(existsSync(join(w.setDir(), 'hatchabot-k1-vol.tgz'))).toBe(false);
    expect(existsSync(join(w.setDir(), 'hatchabot-k2-vol.tgz'))).toBe(true);
  }, 60_000);
});

describe('the app never runs the real backup script under a test runner (2026-10-03)', () => {
  it('"Back up now" in a test refuses unless the test names its own script', async () => {
    const { startBackup, backupRunState } = await import('../src/orchestrator/backups/backupFiles.js');
    const saved = process.env.HATCHABOT_BACKUP_SCRIPT;
    delete process.env.HATCHABOT_BACKUP_SCRIPT;
    try {
      const r = startBackup(Date.now());
      expect(r.status).toBe('error');
      expect(r.summary).toMatch(/not run under a test runner/);
      expect(backupRunState().status).toBe('error');
    } finally { if (saved !== undefined) process.env.HATCHABOT_BACKUP_SCRIPT = saved; }
  });
});

it.each(['missing-file','missing-setting','empty-value'])('missing backup encryption key makes the set incomplete and preserves older sets: %s', mode=>{
 const w=scriptWorld(['hatchabot-fixture-1-vol'],['docker://hatchabot-fixture-1']);
 const old=w.oldSet(['hatchabot.sqlite','secret-key.env','hatchabot-fixture-1-vol.tgz']);
 if(mode==='missing-file')rmSync(join(w.repo,'.env'));
 else writeFileSync(join(w.repo,'.env'),mode==='empty-value' ? 'HATCHABOT_SECRET_KEY=""\n' : 'HATCHABOT_AUTH=accounts\n');
 const r=w.run();
 expect(r.status,r.stdout+r.stderr).toBe(1);
 expect(w.record().state).toBe('incomplete');
 expect(existsSync(join(w.setDir(),'secret-key.env'))).toBe(false);
 expect(existsSync(old)).toBe(true);
});

it('backs up an environment-only key without logging it', () => {
  const w = scriptWorld([], []);
  rmSync(join(w.repo, '.env'));
  const key = 'fixture passphrase with spaces';
  const r = w.run({ HATCHABOT_SECRET_KEY: key });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(w.record().state).toBe('complete');
  expect(readFileSync(join(w.setDir(), 'secret-key.env'), 'utf8')).toBe(`HATCHABOT_SECRET_KEY="${key}"\n`);
  expect(r.stdout + r.stderr).not.toContain(key);
});

it('a missing key does not change an earlier complete run of the same dated set', () => {
  const w = scriptWorld([], []);
  expect(w.run().status).toBe(0);
  const keyFile = join(w.setDir(), 'secret-key.env');
  const saved = readFileSync(keyFile, 'utf8');
  rmSync(join(w.repo, '.env'));
  expect(w.run().status).toBe(1);
  expect(w.record().state).toBe('complete');
  expect(readFileSync(keyFile, 'utf8')).toBe(saved);
});

describe("the saved key is tried on the set's own secrets (HB-1228)", () => {
  /** Secrets in the install's database, each stored with the key given, as the service stores them. */
  const store = async (w: ReturnType<typeof scriptWorld>, keys: string[]) => {
    const db = new Database(join(w.repo, 'data', 'hatchabot.sqlite'));
    for (const [i, k] of keys.entries()) {
      await new LocalSecretStore(db, LocalSecretStore.keyFromEnv({ HATCHABOT_SECRET_KEY: k })).put(`channel/made-up-${i}/bot-token`, 'made-up-secret-value');
    }
    db.close();
  };

  it('a key that reads none of them: the volumes are taken, the set says incomplete, and older sets are kept', async () => {
    const w = scriptWorld(['hatchabot-fixture-1-vol'], ['docker://hatchabot-fixture-1']);
    const old = w.oldSet(['hatchabot.sqlite', 'secret-key.env', 'hatchabot-fixture-1-vol.tgz']);
    await store(w, ['another-made-up-key', 'another-made-up-key']);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain("✗ The saved HATCHABOT_SECRET_KEY decrypts none of the 2 secrets in the backed-up database: it is not the key they were stored with, so neither this set nor the running service can read them (bot tokens, AI keys). The volumes are still taken; the set will say incomplete, and older backups are kept. Put back the key they were stored with (an older set's secret-key.env may have it), or give the app its tokens and keys again, then back up again.");
    expect(r.stderr).toContain('✗ 1 volume(s) captured, but the saved key decrypts none of the backed-up secrets — incomplete backup, nothing pruned.');
    expect(w.record()).toMatchObject({ state: 'incomplete', captured: ['hatchabot-fixture-1-vol'] });
    expect(existsSync(join(w.setDir(), 'hatchabot-fixture-1-vol.tgz'))).toBe(true);
    expect(existsSync(old)).toBe(true);
    expect(r.stdout + r.stderr).not.toContain('not-a-real-key');
  });

  it('any one it reads will do, beside one from an older key; and no secrets at all is fine', async () => {
    const mixed = scriptWorld([], []);
    await store(mixed, ['another-made-up-key', 'not-a-real-key']);
    const r = mixed.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('✓ saved key reads the backed-up secrets');
    expect(mixed.record().state).toBe('complete');
    const none = scriptWorld([], []);
    await store(none, []);
    const n = none.run();
    expect(n.status, n.stdout + n.stderr).toBe(0);
    expect(none.record().state).toBe('complete');
    // Said as it is: none to try the key on, not that it read them (HB-1228 review).
    expect(n.stdout).toContain('✓ the backed-up database holds no secrets: the saved key had none to be tried on');
    expect(n.stdout).not.toContain('saved key reads');
  });

  it('a key of 64 hex characters is the raw key, as the service reads it', async () => {
    const w = scriptWorld([], []);
    const hex = 'ab'.repeat(32);
    writeFileSync(join(w.repo, '.env'), `HATCHABOT_SECRET_KEY=${hex}\n`);
    await store(w, [hex]);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.record().state).toBe('complete');
  });
});

// The README's restore steps, run as written, after an unclean stop: copying only the
// main file left -wal beside it, and the next open replayed it onto the backup (HB-0407).
describe("README's restore of the database (HB-0407)", () => {
  const nodePath = join(dirname(createRequire(import.meta.url).resolve('better-sqlite3/package.json')), '..');
  const killed = (root: string) => {
    // A server's life: a backup taken, more written, then killed, so -wal and -shm stay.
    const r = spawnSync(process.execPath, ['-e', `
      const D = require("better-sqlite3");
      const db = new D("data/hatchabot.sqlite");
      db.pragma("journal_mode = WAL"); db.pragma("wal_autocheckpoint = 0");
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      const add = db.prepare("INSERT INTO t (v) VALUES (?)");
      for (let i = 0; i < 50; i++) add.run("old" + i);
      db.backup("set/hatchabot.sqlite").then(() => {
        for (let i = 0; i < 500; i++) add.run("new" + i);
        db.prepare("UPDATE t SET v = ? WHERE id = 1").run("changed-after-backup");
        process.kill(process.pid, "SIGKILL");
      });`], { cwd: root, env: { HOME: root, PATH: '/usr/bin:/bin', NODE_PATH: nodePath }, encoding: 'utf8' });
    expect(r.signal, r.stderr).toBe('SIGKILL');
    expect(existsSync(join(root, 'data', 'hatchabot.sqlite-wal'))).toBe(true);
  };
  const read = (root: string) => {
    const db = new Database(join(root, 'data', 'hatchabot.sqlite'));
    try { return { n: (db.prepare('SELECT count(*) n FROM t').get() as { n: number }).n, first: (db.prepare('SELECT v FROM t WHERE id = 1').get() as { v: string }).v }; } finally { db.close(); }
  };
  const world = () => { const root = tmp('hb-restore-'); mkdirSync(join(root, 'data')); mkdirSync(join(root, 'set')); killed(root); return root; };
  const sh = (root: string, cmd: string) => { const r = spawnSync('sh', ['-c', cmd], { cwd: root, env: { HOME: root, PATH: '/usr/bin:/bin' }, encoding: 'utf8' }); expect(r.status, r.stderr).toBe(0); };

  it('the steps as the README gives them bring back exactly what the backup holds', () => {
    const block = /Put `hatchabot\.sqlite` in place[\s\S]*?```sh\n([\s\S]*?)```/.exec(readFileSync('README.md', 'utf8'))?.[1];
    expect(block).toContain('rm -f data/hatchabot.sqlite-wal');
    const root = world();
    sh(root, block!.replace(/<backup-dir>/g, 'set'));
    expect(read(root)).toEqual({ n: 50, first: 'old0' });
  });
  it('the main file alone is what went wrong', () => {
    const root = world();
    sh(root, 'cp set/hatchabot.sqlite data/hatchabot.sqlite');
    expect(read(root)).toEqual({ n: 550, first: 'changed-after-backup' });
  });
});
