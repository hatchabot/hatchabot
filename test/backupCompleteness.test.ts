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
  return { run, setDir, fillVolume };
}

describe('scripts/backup-volumes.sh records how the run ended', () => {
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
