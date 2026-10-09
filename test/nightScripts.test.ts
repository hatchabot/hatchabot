import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { scriptEnv } from './helpers/scriptEnv.js';

// Night review, 2026-09-28: the CLI and the scripts.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const src = (p: string) => readFileSync(p, 'utf8');

describe('deploy and upgrade', () => {
  it('deploy-release keeps node_modules.prev until the new release is serving', () => {
    const s = src('scripts/deploy-release.sh');
    const lines = s.split('\n');
    const removals = lines.map((l, i) => (/rm -rf node_modules\.prev/.test(l) && !/restore_deps|\[ -d node_modules \]/.test(l) ? i : -1)).filter((i) => i >= 0);
    const serving = lines.findIndex((l) => /Serving \$GOT/.test(l));
    expect(removals).toEqual([serving]); // the only removal is on the serving line
  });
  it('deploy-release and upgrade.sh take the same mkdir lock (flock and mkdir did not exclude each other)', () => {
    const d = src('scripts/deploy-release.sh'), u = src('scripts/upgrade.sh');
    expect(d).not.toMatch(/^[^#]*\bflock\b/m); // no flock command (a comment may name it)
    // In the user's own state folder since 2026-10-09 (a /tmp name anyone on a shared host could take first).
    const locks = (s: string) => s.match(/LOCKS="\$\{XDG_STATE_HOME:-\$HOME\/\.local\/state\}\/hatchabot"/);
    expect(locks(d)).toBeTruthy(); expect(locks(u)).toBeTruthy();
    const lockOf = (s: string) => s.match(/LOCK(?:_PATH)?="\$LOCKS\/upgrade-\$\(printf %s "\$(\w+)" \| cksum \| cut -d' ' -f1\)\.lock\.d"/);
    expect(lockOf(d)?.[1]).toBe('PWD');
    expect(lockOf(u)?.[1]).toBe('DIR'); // DIR="$PWD" after its cd
    expect(u).toMatch(/DIR="\$PWD"/);
  });
  it('upgrade.sh installs through ensure-deps (it writes the stamp restart.sh checks)', () => {
    expect(src('scripts/upgrade.sh')).toMatch(/INSTALL="\$\{HATCHABOT_INSTALL_CMD:-\.\/scripts\/ensure-deps\.sh --quiet\}"/);
  });
  it('the image build never expands a possibly-empty array bare (bash 3.2 under set -u)', () => {
    const s = src('scripts/build-runtime-image.sh');
    expect(s).not.toMatch(/^\s*"\$\{[A-Z_]+_ARG\[@\]\}"/m);
  });
  it('the unit files quote the install path in ExecStart', () => {
    expect(src('deploy/hatchabot.service')).toMatch(/^ExecStart="__HATCHABOT_DIR__\/scripts\/with-docker\.sh" "__HATCHABOT_DIR__\/node_modules\/\.bin\/tsx" src\/index\.ts$/m);
    expect(src('deploy/hatchabot-backup.service')).toMatch(/^ExecStart="__HATCHABOT_DIR__\/scripts\/with-docker\.sh" "__HATCHABOT_DIR__\/scripts\/backup-volumes\.sh"$/m);
  });
  it('the installer reads a Mac install out of its launchd plist too', () => {
    expect(src('install.sh')).toMatch(/Library\/LaunchAgents\/\$p\.plist/);
  });
});

describe('scripts/uninstall.sh refuses a database it cannot read', () => {
  it('a module that is installed but fails to open the database is "unknown", not "no agents"', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-night-uninstall-')); dirs.push(root);
    const home = join(root, 'home'); mkdirSync(join(home, '.config', 'hatchabot'), { recursive: true });
    const repo = join(root, 'install'); mkdirSync(join(repo, 'scripts'), { recursive: true }); mkdirSync(join(repo, 'data'));
    mkdirSync(join(repo, 'node_modules', 'better-sqlite3'), { recursive: true });
    writeFileSync(join(repo, 'scripts', 'uninstall.sh'), readFileSync('scripts/uninstall.sh'), { mode: 0o755 });
    writeFileSync(join(repo, '.env'), 'HATCHABOT_SECRET_KEY=x\n');
    writeFileSync(join(repo, 'data', 'hatchabot.sqlite'), 'x');
    const bin = join(root, 'bin'); mkdirSync(bin);
    const log = join(root, 'calls.log');
    for (const tool of ['systemctl', 'docker', 'npm', 'launchctl']) {
      writeFileSync(join(bin, tool), `#!/usr/bin/env bash\necho "${tool} $*" >> ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
    }
    // node that cannot load the native module (a Node major upgrade).
    writeFileSync(join(bin, 'node'), '#!/usr/bin/env bash\necho "NODE_MODULE_VERSION mismatch" >&2\nexit 1\n', { mode: 0o755 });
    for (const args of [['--yes'], ['--purge', '--yes']]) {
      const r = spawnSync('bash', [join(repo, 'scripts', 'uninstall.sh'), ...args], { encoding: 'utf8', env: scriptEnv(home, `${bin}:/usr/bin:/bin`) });
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stdout).toMatch(/Cannot read the database/);
    }
    expect(existsSync(join(repo, 'data', 'hatchabot.sqlite'))).toBe(true);
    expect(existsSync(log)).toBe(false); // nothing stopped, nothing removed
  });
});

describe('hatchabot accounts reset-password', () => {
  it('revokes the account\'s CLI tokens (not rehost ones), so a token from a stolen session dies with the reset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-night-reset-')); dirs.push(dir);
    const db = join(dir, 'hatchabot.sqlite');
    const store = new Store(new Database(db));
    store.insertLocalAccount({ id: 'acct-1', username: 'sam', pwHash: 'x', pwSalt: 'y', hostOwner: true, createdAt: new Date().toISOString() } as never);
    const plain = store.createCliToken('acct-1', 'laptop');
    const rehost = store.createCliToken('acct-1', 'peer', 90, 'rehost');
    const r = spawnSync('npx', ['tsx', 'src/cli.ts', 'accounts', 'reset-password', 'sam', 'a-new-long-password-1'], {
      encoding: 'utf8', env: scriptEnv(dir, process.env.PATH ?? '/usr/bin:/bin', { HATCHABOT_DB: db, HATCHABOT_AUTH: 'accounts' }),
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/1 CLI token was revoked/);
    const after = new Store(new Database(db));
    expect(after.ownerForCliToken(plain.token)).toBeUndefined();
    expect(after.ownerForCliToken(rehost.token)).toBe('acct-1');
  }, 60_000);
});
