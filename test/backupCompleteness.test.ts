import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
      { id: 'a2', name: 'Book Advisor', runtimeRef: 'docker://hatchabot-book-2', createdAt: '2026-09-05T00:00:00Z', hostId: 'runner' },
      { id: 'a3', name: 'Picture Mash', runtimeRef: 'docker://hatchabot-pic-3', createdAt: '2026-09-28T09:00:00Z', hostId: 'local' },
      { id: 'a4', name: 'Unprovisioned', createdAt: '2026-09-01T00:00:00Z', hostId: 'local' },
    ];
    const missing = agentsMissingFromSet(set, agents, (h) => (h === 'runner' ? 'Laptop runner' : undefined));
    expect(missing).toEqual([{ agentId: 'a2', name: 'Book Advisor', host: 'Laptop runner' }]);
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
    run) case "$*" in *broken*) exit 1;; esac; printf 'runner data' | gzip ;;
  esac
  exit 0
fi
case "$1 $2" in
  "volume ls") printf '%s\\n' ${volumes.map((v) => `'${v}'`).join(' ')} ;;
  "image inspect") exit 0 ;;
  run*)
    vol=""; out=""
    for a in "$@"; do case "$a" in *:/data:ro) vol="\${a%%:/data:ro}";; *:/out) out="\${a%%:/out}";; esac; done
    case "$vol" in *broken*) exit 2;; esac
    # A volume with a fixture tree runs the script's own tar command for
    # real, /data and /out pointed at temp dirs (review, 2026-09-29).
    if [ -d "${root}/vols/$vol" ]; then
      o='/out/'; d='-C /data '
      cmd="\${@: -1}"; cmd="\${cmd//"$o"/$out/}"; cmd="\${cmd//"$d"/-C ${root}/vols/$vol }"
      exec bash -c "$cmd"
    fi
    echo fake > "$out/$vol.tgz" ;;
esac
`, { mode: 0o755 });
  const backups = join(root, 'backups');
  const run = () => spawnSync('bash', [join(repo, 'scripts', 'backup-volumes.sh')], {
    encoding: 'utf8',
    env: {
      HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HATCHABOT_BACKUP_DIR: backups, HATCHABOT_PREFIX: 'hatchabot',
      NODE_PATH: join(dirname(createRequire(import.meta.url).resolve('better-sqlite3/package.json')), '..'),
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
    },
  });
  const setDir = () => join(backups, readdirSync(backups).find((d) => /^20\d\d-/.test(d))!);
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
  return { run, setDir, fillVolume, repo, onRunners, remoteLog };
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
    const w = scriptWorld(['hatchabot-kitchen-1-vol', 'agentclaw-old-sophie'], ['docker://hatchabot-kitchen-1']);
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/agentclaw-old-sophie: no agent uses it — not backed up/);
    expect(existsSync(join(w.setDir(), 'agentclaw-old-sophie.tgz'))).toBe(false);
    expect(existsSync(join(w.setDir(), 'hatchabot-kitchen-1-vol.tgz'))).toBe(true);
    expect(readSetStatus(w.setDir())).toMatchObject({ complete: true, orphans: ['agentclaw-old-sophie'], failedVolumes: [] });
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
    const w = scriptWorld(['hatchabot-kitchen-1-vol', 'agentclaw-old-sophie'], []);
    // No active agents but volumes exist: the old trust-the-disk rule holds.
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(w.setDir(), 'agentclaw-old-sophie.tgz'))).toBe(true);
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
