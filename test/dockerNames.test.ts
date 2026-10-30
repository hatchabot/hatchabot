/**
 * One naming rule for an agent's docker volume (deep audit of v2.166.2,
 * #021): the provider maps a legacy pre-slug ref (docker://<short id>) to
 * agentclaw-vol-<short>, while the nightly backup and agentArchiveName each
 * derived <short>-vol — the real volume was an "orphan", every set was
 * incomplete, and no restore found its archive. The backup script carries a
 * copy of the rule; this holds it to src/providers/dockerNames.ts. The script
 * runs in a sandbox: a temp HOME and install, a PATH whose docker is a shim,
 * git hooks off.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { dockerNames } from '../src/providers/dockerNames.js';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';
import { agentArchiveName } from '../src/orchestrator/backups.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const LEGACY = 'docker://123456abcdef';
const MODERN = 'docker://hatchabot-meal-planner-9221b8b8';
const RENAMED = 'docker://agentclaw-garden-notes-5a7fd6e1';

describe('dockerNames', () => {
  it('names the volume as the provider always has: slugged refs as they are, legacy ones under the old scheme', () => {
    expect(dockerNames(MODERN).volume).toBe('hatchabot-meal-planner-9221b8b8-vol');
    expect(dockerNames(RENAMED).volume).toBe('agentclaw-garden-notes-5a7fd6e1-vol');
    expect(dockerNames(LEGACY)).toEqual({ container: 'agentclaw-123456abcdef', volume: 'agentclaw-vol-123456abcdef' });
    expect(dockerNames(LEGACY, 'second')).toEqual({ container: 'second-123456abcdef', volume: 'second-vol-123456abcdef' });
    expect(dockerNames('docker://second-kitchen-1', 'second').volume).toBe('second-kitchen-1-vol');
  });

  it('agentArchiveName is the volume\'s, legacy refs included; another kind of ref keeps <name>-vol', () => {
    expect(agentArchiveName(LEGACY, 'hatchabot')).toBe('agentclaw-vol-123456abcdef.tgz');
    expect(agentArchiveName(MODERN, 'hatchabot')).toBe('hatchabot-meal-planner-9221b8b8-vol.tgz');
    expect(agentArchiveName(LEGACY, 'second')).toBe('second-vol-123456abcdef.tgz');
    expect(agentArchiveName('mock://a1')).toBe('a1-vol.tgz');
  });

  it('the provider reads the volume the rule names', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-dnames-')); dirs.push(root);
    const docker = join(root, 'docker');
    writeFileSync(docker, `#!/usr/bin/env bash\necho "$*" >> '${root}/docker.log'\ncase "$1 $2" in 'volume inspect') echo "\${@: -1}";; 'run --rm') printf 'x' | gzip;; esac\nexit 0\n`, { mode: 0o755 });
    await new LocalDockerProvider({ docker }).exportState(LEGACY).catch(() => undefined);
    expect(readFileSync(join(root, 'docker.log'), 'utf8')).toContain(dockerNames(LEGACY).volume);
  });
});

/** scripts/backup-volumes.sh with a registry of `refs`, and docker holding `volumes`. */
function backupRun(refs: string[], volumes: string[], prefix = 'hatchabot') {
  const root = mkdtempSync(join(tmpdir(), 'hb-dnames-bk-')); dirs.push(root);
  const install = join(root, 'install'); const bin = join(root, 'bin'); const home = join(root, 'home'); const backups = join(root, 'backups');
  for (const d of [join(install, 'scripts'), join(install, 'data'), bin, home]) mkdirSync(d, { recursive: true });
  writeFileSync(join(install, 'scripts', 'backup-volumes.sh'), readFileSync('scripts/backup-volumes.sh'), { mode: 0o755 });
  writeFileSync(join(install, '.env'), 'HATCHABOT_SECRET_KEY=not-a-real-key\n');
  const db = new Database(join(install, 'data', 'hatchabot.sqlite'));
  db.exec('CREATE TABLE agents (id TEXT, state TEXT, runtime_ref TEXT)');
  refs.forEach((r, i) => db.prepare('INSERT INTO agents VALUES (?, ?, ?)').run(`a${i}`, 'RUNNING', r));
  db.close();
  // docker: lists the volumes, and "archives" one by writing the file the script names under /out.
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash
case "$1 $2" in
  "volume ls") printf '%s\\n' ${volumes.map((v) => `'${v}'`).join(' ')} ;;
  "image inspect") exit 0 ;;
  run*)
    out=""; for a in "$@"; do case "$a" in *:/out) out="\${a%%:/out}";; esac; done
    f="$(grep -o "/out/[^' ]*" <<<"\${@: -1}" | head -1)"; echo fake > "$out/\${f#/out/}" ;;
esac
exit 0
`, { mode: 0o755 });
  const r = spawnSync('bash', [join(install, 'scripts', 'backup-volumes.sh')], { encoding: 'utf8', env: {
    HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HATCHABOT_BACKUP_DIR: backups, HATCHABOT_PREFIX: prefix,
    NODE_PATH: join(dirname(createRequire(import.meta.url).resolve('better-sqlite3/package.json')), '..'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
  } });
  const set = join(backups, readdirSync(backups).find((n) => /^20\d\d-/.test(n))!);
  return { r, set, record: JSON.parse(readFileSync(join(set, 'backup-status.json'), 'utf8')) };
}

describe('scripts/backup-volumes.sh names volumes by the same rule', () => {
  it('a legacy agent\'s volume is backed up under the archive name a restore looks for: complete, no orphan, nothing missing', () => {
    const refs = [LEGACY, MODERN, RENAMED];
    const { r, set, record } = backupRun(refs, refs.map((ref) => dockerNames(ref).volume));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(record).toMatchObject({ state: 'complete', volumes: 3, missing: [], orphans: [] });
    for (const ref of refs) expect(existsSync(join(set, agentArchiveName(ref, 'hatchabot'))), ref).toBe(true);
  });

  it('under another prefix too', () => {
    const { r, set, record } = backupRun([LEGACY], [dockerNames(LEGACY, 'second').volume], 'second');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(record).toMatchObject({ state: 'complete', volumes: 1, missing: [], orphans: [] });
    expect(existsSync(join(set, agentArchiveName(LEGACY, 'second')))).toBe(true);
  });
});

/** scripts/uninstall.sh (service only) with a registry of `refs`: the docker lookups it makes. */
function uninstallLookups(refs: string[], prefix = 'hatchabot') {
  const root = mkdtempSync(join(tmpdir(), 'hb-dnames-un-')); dirs.push(root);
  const install = join(root, 'install'); const bin = join(root, 'bin'); const home = join(root, 'home');
  for (const d of [join(install, 'scripts'), join(install, 'data'), bin, home]) mkdirSync(d, { recursive: true });
  writeFileSync(join(install, 'scripts', 'uninstall.sh'), readFileSync('scripts/uninstall.sh'), { mode: 0o755 });
  writeFileSync(join(install, '.env'), `HATCHABOT_SECRET_KEY=not-a-real-key\nHATCHABOT_PREFIX=${prefix}\n`);
  const db = new Database(join(install, 'data', 'hatchabot.sqlite'));
  db.exec('CREATE TABLE agents (id TEXT, state TEXT, runtime_ref TEXT, image TEXT)');
  refs.forEach((r, i) => db.prepare('INSERT INTO agents VALUES (?, ?, ?, NULL)').run(`a${i}`, 'RUNNING', r));
  db.close();
  symlinkSync(join(dirname(createRequire(import.meta.url).resolve('better-sqlite3/package.json')), '..'), join(install, 'node_modules'));
  const log = join(root, 'calls.log');
  for (const tool of ['docker', 'systemctl', 'npm']) writeFileSync(join(bin, tool), `#!/usr/bin/env bash\necho "${tool} $*" >> ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
  symlinkSync(process.execPath, join(bin, 'node'));
  const r = spawnSync('bash', [join(install, 'scripts', 'uninstall.sh'), '--yes'], { encoding: 'utf8', env: {
    HOME: home, PATH: `${bin}:/usr/bin:/bin`, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
  } });
  return { r, calls: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

describe('scripts/uninstall.sh names containers and volumes by the same rule (HB-0282)', () => {
  for (const prefix of ['hatchabot', 'second']) {
    it(`under the ${prefix} prefix: a legacy agent's container and volume are looked up as the provider names them`, () => {
      const refs = [LEGACY, MODERN, RENAMED];
      const { r, calls } = uninstallLookups(refs, prefix);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      for (const ref of refs) {
        const { container, volume } = dockerNames(ref, prefix);
        expect(calls, ref).toContain(`docker ps -aq --filter name=^/${container}$`);
        expect(calls, ref).toContain(`docker volume ls -q --filter name=^${volume}$`);
      }
      expect(calls).not.toContain('name=^/123456abcdef$');
    });
  }
});
