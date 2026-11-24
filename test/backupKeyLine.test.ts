/**
 * The secret-key.env a backup set keeps is a line to copy into a recovered
 * .env (README): it must read back as the same key, as a .env is read (deep
 * audit of v2.166.2, #022). A passphrase holding a " was written bare in
 * double quotes and came back cut short, the set still "complete", and the
 * restore drill stripped the quotes by hand, so it passed the broken copy.
 * Both scripts run in a sandbox: a temp HOME, install and backups folder, a
 * PATH whose docker is a shim, git hooks off. Every key is made up.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import Database from 'better-sqlite3';
import { LocalSecretStore } from '../src/secrets/localSecretStore.js';
import { Store } from '../src/store/store.js';

// Real backup/drill subprocesses, tsx startup and passphrase stretching exceeded
// 5 s on the shared CI runner (PR #122). Match restoreDrill.test.ts's bounded
// integration-test allowance; keep the real scripts and crypto assertions.
vi.setConfig({ testTimeout: 30_000 });

const repo = resolve(import.meta.dirname, '..');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'hb-keyline-')); dirs.push(root);
  const install = join(root, 'install'); const bin = join(root, 'bin'); const home = join(root, 'home'); const backups = join(root, 'backups');
  for (const d of [join(install, 'scripts'), join(install, 'data'), bin, home]) mkdirSync(d, { recursive: true });
  for (const s of ['backup-volumes.sh', 'restore-drill.sh', 'backup-owner.sh']) writeFileSync(join(install, 'scripts', s), readFileSync(join(repo, 'scripts', s)), { mode: 0o755 });
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
  /** A run by hand: no key in the environment, only the install's .env; `mac`: uname says Darwin; `extra`: what the shell also exports. */
  const byHand = (mac = false, extra: Record<string, string> = {}) => {
    if (mac) writeFileSync(join(bin, 'uname'), '#!/usr/bin/env bash\necho Darwin\n', { mode: 0o755 });
    return spawnSync('bash', [join(install, 'scripts', 'backup-volumes.sh')], { encoding: 'utf8', env: { ...env, ...extra } });
  };
  const drill = (set: string) => spawnSync('bash', [join(install, 'scripts', 'restore-drill.sh'), set], { encoding: 'utf8', env });
  const setDir = () => join(backups, readdirSync(backups).filter((n) => /^20\d\d-/.test(n)).sort().pop()!);
  return { install, backups, registry, backup, byHand, drill, setDir };
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

describe('scripts/backup-volumes.sh marks its set by the key the app reads (third review of HB-0540)', () => {
  it('HATCHABOT_SECRET_KEY set but empty is no key, as for the app: no mark from .env\'s', async () => {
    const s = sandbox();
    await s.registry('fixture key in the env file');
    writeFileSync(join(s.install, '.env'), 'HATCHABOT_SECRET_KEY=fixture key in the env file\n');
    s.backup(''); // fails its key step (no key): the mark is what is read here
    expect(existsSync(join(s.setDir(), '.backup-owner'))).toBe(false);
  });
});

describe('a backup run by hand saves the key the service reads from .env (HB-1065)', () => {
  const mark = (key: string) => createHash('sha256').update(`hatchabot-backup-owner\0${key}`).digest('hex').slice(0, 16);
  /** The set's own key line decrypts its own copy of the database. */
  const decrypts = async (set: string) => {
    const db = new Database(join(set, 'hatchabot.sqlite'), { readonly: true });
    try {
      return await new LocalSecretStore(db, LocalSecretStore.keyFromEnv(parseEnv(readFileSync(join(set, 'secret-key.env'), 'utf8')))).get('fixture/credential');
    } finally { db.close(); }
  };

  it('Linux: a # inside the key is part of it, as systemd reads .env, not the start of a comment', async () => {
    const s = sandbox();
    const key = 'fixture-pass#phrase';
    await s.registry(key);
    writeFileSync(join(s.install, '.env'), `HATCHABOT_SECRET_KEY=${key}\n`);
    const r = s.byHand();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(parseEnv(readFileSync(join(s.setDir(), 'secret-key.env'), 'utf8')).HATCHABOT_SECRET_KEY).toBe(key);
    await expect(decrypts(s.setDir())).resolves.toBe('made-up secret value');
    expect(readFileSync(join(s.setDir(), '.backup-owner'), 'utf8').trim()).toBe(mark(key));
  });

  it('a Mac: .env is read as the launchd job sources it, a $VAR in the key expanded; what the environment has still wins', async () => {
    const s = sandbox();
    const key = 'fixture-made-up-phrase';
    await s.registry(key);
    const elsewhere = join(s.install, 'not-these-backups');
    writeFileSync(join(s.install, '.env'), `FIXTURE_PART=made-up-phrase\nHATCHABOT_SECRET_KEY="fixture-$FIXTURE_PART"\nHATCHABOT_BACKUP_DIR=${elsewhere}\n`);
    const r = s.byHand(true);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(parseEnv(readFileSync(join(s.setDir(), 'secret-key.env'), 'utf8')).HATCHABOT_SECRET_KEY).toBe(key);
    await expect(decrypts(s.setDir())).resolves.toBe('made-up secret value');
    expect(readFileSync(join(s.setDir(), '.backup-owner'), 'utf8').trim()).toBe(mark(key));
    // HATCHABOT_BACKUP_DIR came from the environment (the sandbox's): .env's other one was not used.
    expect(existsSync(elsewhere)).toBe(false);
  });

  it('another key exported in the shell is refused before anything is written, on Linux and a Mac (HB-1065 review)', async () => {
    for (const [mac, envText] of [
      [false, 'HATCHABOT_SECRET_KEY=fixture-service-key\n'],
      [true, 'HATCHABOT_SECRET_KEY=fixture-service-key\n'],
      [false, 'AGENTCLAW_SECRET_KEY=fixture-service-key\n'], // a pre-rename .env: the service takes it for HATCHABOT_SECRET_KEY
    ] as const) {
      const s = sandbox();
      await s.registry('fixture-service-key');
      writeFileSync(join(s.install, '.env'), envText);
      const r = s.byHand(mac, { HATCHABOT_SECRET_KEY: 'fixture-other-shell-key' });
      const label = `${mac ? 'Mac' : 'Linux'} ${envText}`;
      expect(r.status, label + r.stdout + r.stderr).toBe(1);
      expect(r.stderr, label).toContain(`✗ This run's HATCHABOT_SECRET_KEY, from the shell that started it, is not the one in ${s.install}/.env, which the service reads — nothing was written: a set saved with this one could not decrypt its credentials.`);
      expect(r.stderr, label).toContain('  Unset it in this shell (unset HATCHABOT_SECRET_KEY AGENTCLAW_SECRET_KEY), then run this again.');
      expect(existsSync(s.backups), label).toBe(false); // no set, no secret-key.env, no record
      expect(r.stdout + r.stderr, label).not.toMatch(/fixture-(service|other-shell)-key/);
    }
  });

  it('a run with .env\'s own key in its environment, as the service and its timer have, is not refused (HB-1065 review)', async () => {
    for (const [mac, envText, key, extra] of [
      [false, 'HATCHABOT_SECRET_KEY=fixture-pass#phrase\n', 'fixture-pass#phrase', { HATCHABOT_SECRET_KEY: 'fixture-pass#phrase' }],
      [false, 'AGENTCLAW_SECRET_KEY=fixture-old-name-key\n', 'fixture-old-name-key', { HATCHABOT_SECRET_KEY: 'fixture-old-name-key', AGENTCLAW_SECRET_KEY: 'fixture-old-name-key' }],
      [true, 'FIXTURE_PART=made-up-phrase\nHATCHABOT_SECRET_KEY="fixture-$FIXTURE_PART"\n', 'fixture-made-up-phrase', { FIXTURE_PART: 'made-up-phrase', HATCHABOT_SECRET_KEY: 'fixture-made-up-phrase' }],
    ] as const) {
      const s = sandbox();
      await s.registry(key);
      writeFileSync(join(s.install, '.env'), envText);
      const r = s.byHand(mac, { ...extra });
      expect(r.status, envText + r.stdout + r.stderr).toBe(0);
      await expect(decrypts(s.setDir())).resolves.toBe('made-up secret value');
    }
  });

  it('the app\'s own run, after .env\'s key was changed under the service, saves the key the service runs with, and warns (HB-1065 review)', async () => {
    for (const mac of [false, true]) {
      const s = sandbox();
      await s.registry('fixture-running-key');
      writeFileSync(join(s.install, '.env'), 'HATCHABOT_SECRET_KEY=fixture-edited-key\n');
      const r = s.byHand(mac, { HATCHABOT_SECRET_KEY: 'fixture-running-key', HATCHABOT_BACKUP_BY_APP: '1' });
      const label = mac ? 'Mac' : 'Linux';
      expect(r.status, label + r.stdout + r.stderr).toBe(0);
      expect(parseEnv(readFileSync(join(s.setDir(), 'secret-key.env'), 'utf8')).HATCHABOT_SECRET_KEY, label).toBe('fixture-running-key');
      await expect(decrypts(s.setDir())).resolves.toBe('made-up secret value');
      expect(readFileSync(join(s.setDir(), '.backup-owner'), 'utf8').trim(), label).toBe(mark('fixture-running-key'));
      const warn = `  ⚠ The HATCHABOT_SECRET_KEY in ${s.install}/.env is not the one the service runs with. This set saves the service's, which reads the stored credentials; at its next restart the service reads .env's and will not. Put back in .env the key it had.`;
      const lines = r.stderr.trimEnd().split('\n');
      expect(lines.filter((l) => l === warn), label).toHaveLength(2); // at the start, and last, where the app's summary shows it
      expect(lines.at(-1), label).toBe(warn);
      expect(r.stdout + r.stderr, label).not.toMatch(/fixture-(running|edited)-key/);
    }
  });

  it('"Back up now" marks its run as the app\'s own (HB-1065 review)', async () => {
    const { startBackup } = await import('../src/orchestrator/backups/backupFiles.js');
    const dir = mkdtempSync(join(tmpdir(), 'hb-bk-byapp-')); dirs.push(dir);
    // A stand-in, never the real script: the test process's environment is the machine's.
    const script = join(dir, 'backup.sh');
    writeFileSync(script, '#!/bin/bash\necho "by app: ${HATCHABOT_BACKUP_BY_APP:-no}"\n', { mode: 0o700 });
    const saved = process.env.HATCHABOT_BACKUP_SCRIPT;
    process.env.HATCHABOT_BACKUP_SCRIPT = script;
    try {
      let done: { status: string; summary?: string } | undefined;
      startBackup(Date.now(), (st) => { done = st; });
      await vi.waitFor(() => expect(done).toBeTruthy(), { timeout: 10_000, interval: 50 });
      expect(done).toMatchObject({ status: 'ok', summary: 'by app: 1' });
      expect(process.env.HATCHABOT_BACKUP_BY_APP).toBeUndefined(); // the run's alone, not the app's
    } finally { if (saved !== undefined) process.env.HATCHABOT_BACKUP_SCRIPT = saved; else delete process.env.HATCHABOT_BACKUP_SCRIPT; }
  });

  it('a key ending in an escaped space keeps it, as systemd does; an escaped backslash before a space does not: by hand and as the timer runs it (review of HB-1065)', async () => {
    for (const [line, key] of [['fixture-key\\ ', 'fixture-key '], ['fixture-key\\\\ ', 'fixture-key\\']] as const) {
      // By hand (no key in the environment), and as the timer runs it: the key as systemd gives it.
      const extras: Array<Record<string, string>> = [{}, { HATCHABOT_SECRET_KEY: key }];
      for (const extra of extras) {
        const s = sandbox();
        await s.registry(key);
        writeFileSync(join(s.install, '.env'), `HATCHABOT_SECRET_KEY=${line}\n`);
        const r = s.byHand(false, extra);
        const label = `${line} ${Object.keys(extra).length ? 'timer' : 'by hand'}`;
        expect(r.status, label + r.stdout + r.stderr).toBe(0);
        expect(parseEnv(readFileSync(join(s.setDir(), 'secret-key.env'), 'utf8')).HATCHABOT_SECRET_KEY, label).toBe(key);
        await expect(decrypts(s.setDir())).resolves.toBe('made-up secret value');
      }
    }
  });

  it('the reader of systemd\'s rules is the same in backup-volumes.sh, uninstall.sh, restore-drill.sh, setup-host.sh and upgrade.sh (HB-1231, and the review of HB-1109 and HB-1210)', () => {
    const reader = (script: string) => {
      const src = readFileSync(join(repo, 'scripts', script), 'utf8');
      const at = src.indexOf('const systemd = (t) => {');
      expect(at, script).toBeGreaterThan(0);
      return src.slice(at, src.indexOf('\n    };\n', at)).split('\n').map((l) => l.trim()).join('\n');
    };
    expect(reader('backup-volumes.sh')).toBe(reader('uninstall.sh'));
    expect(reader('restore-drill.sh')).toBe(reader('backup-volumes.sh'));
    expect(reader('setup-host.sh')).toBe(reader('backup-volumes.sh'));
    expect(reader('upgrade.sh')).toBe(reader('backup-volumes.sh'));
    // And setup and the upgrade read the image settings with one function, so they never fetch two images (review of HB-1210).
    const envNamed = (script: string) => {
      const src = readFileSync(join(repo, 'scripts', script), 'utf8');
      const at = src.indexOf('\nenv_named() {\n');
      expect(at, script).toBeGreaterThan(0);
      return src.slice(at, src.indexOf('\n}\n', at));
    };
    expect(envNamed('upgrade.sh')).toBe(envNamed('setup-host.sh'));
  });
});
