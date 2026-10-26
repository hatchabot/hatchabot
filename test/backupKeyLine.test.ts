/**
 * The secret-key.env a backup set keeps is a line to copy into a recovered
 * .env (README): it must read back as the same key, as a .env is read (deep
 * audit of v2.166.2, #022). A passphrase holding a " was written bare in
 * double quotes and came back cut short, the set still "complete", and the
 * restore drill stripped the quotes by hand, so it passed the broken copy.
 * Both scripts run in a sandbox: a temp HOME, install and backups folder, a
 * PATH whose docker is a shim, git hooks off. Every key is made up.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import Database from 'better-sqlite3';
import { LocalSecretStore } from '../src/secrets/localSecretStore.js';
import { Store } from '../src/store/store.js';

const repo = resolve(import.meta.dirname, '..');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'hb-keyline-')); dirs.push(root);
  const install = join(root, 'install'); const bin = join(root, 'bin'); const home = join(root, 'home'); const backups = join(root, 'backups');
  for (const d of [join(install, 'scripts'), join(install, 'data'), bin, home]) mkdirSync(d, { recursive: true });
  for (const s of ['backup-volumes.sh', 'restore-drill.sh']) writeFileSync(join(install, 'scripts', s), readFileSync(join(repo, 'scripts', s)), { mode: 0o755 });
  // The drill's key check imports the secret store through tsx.
  symlinkSync(join(repo, 'node_modules'), join(install, 'node_modules'));
  symlinkSync(join(repo, 'src'), join(install, 'src'));
  writeFileSync(join(bin, 'docker'), '#!/usr/bin/env bash\ncase "$1 $2" in "volume ls") exit 0 ;; esac\nexit 0\n', { mode: 0o755 });
  const env = {
    HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HATCHABOT_BACKUP_DIR: backups, HATCHABOT_PREFIX: 'hatchabot',
    NODE_PATH: join(dirname(createRequire(import.meta.url).resolve('better-sqlite3/package.json')), '..'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
  };
  /** The install's registry, with one credential encrypted under `key`. */
  const registry = async (key: string, file = join(install, 'data', 'hatchabot.sqlite')) => {
    const db = new Database(file);
    new Store(db);
    await new LocalSecretStore(db, LocalSecretStore.keyFromEnv({ HATCHABOT_SECRET_KEY: key })).put('fixture/credential', 'made-up secret value');
    db.close();
  };
  const backup = (key: string) => spawnSync('bash', [join(install, 'scripts', 'backup-volumes.sh')], { encoding: 'utf8', env: { ...env, HATCHABOT_SECRET_KEY: key } });
  const drill = (set: string) => spawnSync('bash', [join(install, 'scripts', 'restore-drill.sh'), set], { encoding: 'utf8', env });
  const setDir = () => join(backups, readdirSync(backups).filter((n) => /^20\d\d-/.test(n)).sort().pop()!);
  return { install, backups, registry, backup, drill, setDir };
}

describe('scripts/backup-volumes.sh writes a key line that reads back whole', () => {
  it.each([
    ['plain', 'fixture passphrase with spaces', '"'],
    ['with double quotes', 'fixture "quoted" passphrase', "'"],
    ['with $, a backtick and a backslash', 'fixture $HOME `x` \\n passphrase', "'"],
    ['with a single quote', "fixture passphrase's", '"'],
  ])('%s: quoted so .env readers get the exact key, and the set\'s own copy decrypts its database', async (_what, key, quote) => {
    const s = sandbox();
    await s.registry(key);
    const r = s.backup(key);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const line = readFileSync(join(s.setDir(), 'secret-key.env'), 'utf8');
    expect(line).toBe(`HATCHABOT_SECRET_KEY=${quote}${key}${quote}\n`);
    expect(parseEnv(line).HATCHABOT_SECRET_KEY).toBe(key);
    const db = new Database(join(s.setDir(), 'hatchabot.sqlite'), { readonly: true });
    try {
      await expect(new LocalSecretStore(db, LocalSecretStore.keyFromEnv(parseEnv(line))).get('fixture/credential')).resolves.toBe('made-up secret value');
    } finally { db.close(); }
    expect(r.stdout + r.stderr).not.toContain(key);
  });

  it('a key no quoting can carry for every reader: no copy is saved and the set is incomplete', async () => {
    const s = sandbox();
    const key = `fixture 'both' "kinds"`;
    await s.registry(key);
    const r = s.backup(key);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no \.env line reads back as that key everywhere/);
    expect(existsSync(join(s.setDir(), 'secret-key.env'))).toBe(false);
    expect(JSON.parse(readFileSync(join(s.setDir(), 'backup-status.json'), 'utf8')).state).toBe('incomplete');
  });
});

describe('scripts/restore-drill.sh reads the key line as a .env is read', () => {
  it('a set the backup made with a quoted passphrase: the drill decrypts with it', async () => {
    const s = sandbox();
    const key = 'fixture "quoted" passphrase';
    await s.registry(key);
    expect(s.backup(key).status).toBe(0);
    const r = s.drill(s.setDir());
    expect(r.stdout + r.stderr).toMatch(/backed-up key decrypts fixture\/credential/);
  });

  it('the old cut-short line (double quotes around a key holding ") fails the key check, as a recovered .env would', async () => {
    const s = sandbox();
    const key = 'fixture "quoted" passphrase';
    const set = join(s.backups, '2026-10-08'); mkdirSync(set, { recursive: true });
    await s.registry(key, join(set, 'hatchabot.sqlite'));
    writeFileSync(join(set, 'secret-key.env'), `HATCHABOT_SECRET_KEY="${key}"\n`);
    const r = s.drill(set);
    expect(r.stdout + r.stderr).toMatch(/The backed-up key could NOT decrypt the backed-up secrets/);
    const record = JSON.parse(readFileSync(join(s.backups, 'drills', readdirSync(join(s.backups, 'drills')).filter((f) => f.endsWith('.json'))[0]!), 'utf8'));
    expect(record.key).toBe('failed');
  });
});
