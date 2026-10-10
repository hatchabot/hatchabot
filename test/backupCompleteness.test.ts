import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { agentsMissingFromSet, listBackups, readSetStatus } from '../src/orchestrator/backups.js';
import { doctorReport, type DoctorFacts } from '../src/doctor.js';

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
function scriptWorld(volumes: string[], agentRefs: string[]) {
  const root = tmp('hb-bkscript-');
  const home = join(root, 'home'); mkdirSync(home);
  const repo = join(root, 'install'); mkdirSync(join(repo, 'scripts'), { recursive: true }); mkdirSync(join(repo, 'data'));
  writeFileSync(join(repo, 'scripts', 'backup-volumes.sh'), readFileSync('scripts/backup-volumes.sh'), { mode: 0o755 });
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
  case "$1" in
    version) exit 0 ;;
    # A volume named *gone* is not on the runner (as docker says it).
    volume) case "$*" in *gone*) echo "Error response from daemon: get \${@: -1}: no such volume" >&2; exit 1;; esac; echo "\${@: -1}" ;;
    run) case "$*" in *broken*) exit 1;; *torn*) printf 'not gzip';; *) printf 'runner data' | gzip ;; esac ;;
  esac
  exit 0
fi
case "$1 $2" in
  "volume ls") printf '%s\\n' ${volumes.map((v) => `'${v}'`).join(' ')} ;;
  "image inspect") exit 0 ;;
  run*)
    vol=""; out=""
    for a in "$@"; do case "$a" in *:/data:ro) vol="\${a%%:/data:ro}";; *:/out) out="\${a%%:/out}";; esac; done
    # The file the script's own command writes, under /out.
    f="$(grep -o "/out/[^' ]*" <<<"\${@: -1}" | head -1)"; f="\${f#/out/}"
    # A volume named *broken* fails half-way: a torn file, then tar's error.
    case "$vol" in *broken*) echo torn > "$out/$f"; exit 2;; esac
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
  const backups = join(root, 'backups');
  const run = (extraEnv: Record<string, string> = {}) => spawnSync('bash', [join(repo, 'scripts', 'backup-volumes.sh')], {
    encoding: 'utf8',
    env: {
      HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HATCHABOT_BACKUP_DIR: backups, HATCHABOT_PREFIX: 'hatchabot',
      NODE_PATH: join(dirname(createRequire(import.meta.url).resolve('better-sqlite3/package.json')), '..'),
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
      ...extraEnv,
    },
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
  /** Today's set directory, as the script names it (before any run made it). */
  const today = () => join(backups, spawnSync('date', ['+%F'], { encoding: 'utf8' }).stdout.trim());
  return { run, setDir, fillVolume, repo, onRunners, remoteLog, oldSet, record, setState, backups, today };
}

describe('scripts/backup-volumes.sh records how the run ended', () => {
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
    expect(w.remoteLog()).toContain('ssh://laptop.test run --rm --network none -v agentclaw-book-2-vol:/vol:ro alpine tar cz --exclude=./.openclaw/cache/control-ui-assets');
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

  it('with no registry agents to match (unreadable or empty), every volume is taken', () => {
    const w = scriptWorld(['hatchabot-kitchen-1-vol', 'agentclaw-old-garden'], []);
    // No active agents but volumes exist: the old trust-the-disk rule holds.
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(w.setDir(), 'agentclaw-old-garden.tgz'))).toBe(true);
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

describe('scripts/restore-drill.sh picks a set worth drilling (2026-10-09)', () => {
  /** The drill in a sandbox: it stops at the database check (no hatchabot.sqlite), before any docker. */
  function drill(base: string, args: string[] = []) {
    const root = tmp('hb-drill-');
    mkdirSync(join(root, 'install', 'scripts'), { recursive: true });
    writeFileSync(join(root, 'install', 'scripts', 'restore-drill.sh'), readFileSync('scripts/restore-drill.sh'), { mode: 0o755 });
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

describe('the app never runs the real backup script under a test runner (2026-10-03)', () => {
  it('"Back up now" in a test refuses unless the test names its own script', async () => {
    const { startBackup, backupRunState } = await import('../src/orchestrator/backups.js');
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
