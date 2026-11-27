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
    const serving = lines.findIndex((l) => /Serving \$WANT/.test(l));
    // A stale leftover is removed before the working one goes aside (and before the
    // `.from` record is written, HB-0266); after that, only on the serving line.
    const aside = lines.findIndex((l) => /mv node_modules node_modules\.prev/.test(l));
    expect(aside).toBeGreaterThan(-1);
    expect(removals.filter((i) => i > aside)).toEqual([serving]);
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
    // And judge a leftover the same way: by its holder, cleared under the same second lock (#226).
    // And tell the disk the same way (HB-0470): a full disk is 5 from either, never the release's.
    // Every helper the two share (eighth review: all of them, the messages
    // too; deploy-release.sh names its tree DIR and its tag TARGET, and REDO
    // what a person runs, so they can be the same text) is one file,
    // scripts/upgrade-helpers.sh, which both read (HB-0636): defined there, and
    // in neither script, so there is no copy to drift.
    const l = src('scripts/upgrade-helpers.sh');
    const names = ['machine_short', 'free_mb', 'disk_words', 'proc_start', 'proc_start_utc', 'started_as', 'lock_left_over', 'checkout_recorded', 'take_lock', 'lock_short', 'lock_in_way',
      'disk_short', 'run_step', 'put_rec', 'said_kind', 'said_path', 'step_tee', 'step_tail', 'new_step_log', 'own_place', 'step_short', 'change_failed',
      'link_end', 'put_line', 'put_dir', 'put_failed', 'deps_holder_gone', 'deps_take', 'deps_lock', 'deps_unlock', 'older_release', 'mark_rolled_back', 'rolled_back_note', 'left_ran', 'unmark_rolled_back', 'kept_tries', 'kept_record',
      'systemd_major', 'env_named', 'service_port',
      // And the ones a run cut off part-way is put back with (HB-1483).
      'git_running_here', 'clear_own_index_lock', 'save_other_edits', 'repair_tree', 'restore_deps'];
    const defined = (t: string, name: string) => new RegExp(`^\\s*${name}\\(\\) \\{`, 'm').test(t);
    for (const name of names) {
      expect(defined(l, name), `${name} in upgrade-helpers.sh`).toBe(true);
      for (const [f, t] of [['upgrade.sh', u], ['deploy-release.sh', d]]) expect(defined(t!, name), `${name} is defined in ${f} again`).toBe(false);
    }
    // restart.sh writes the rollback's note too, under an upgrade whose upgrade.sh may be older (HB-0840).
    const fn = (t: string, name: string) => { const at = t.indexOf(`${name}() {`); expect(at, name).toBeGreaterThan(-1); return t.slice(at, t.indexOf('\n}\n', at)); };
    for (const name of ['mark_rolled_back', 'rolled_back_note']) expect(fn(src('scripts/restart.sh'), name)).toBe(fn(l, name));
    // follow-latest.sh reads git's words with a copy of the same disk_words (fifteenth review).
    const disk = (s: string) => { const at = s.indexOf('disk_words() {'); expect(at).toBeGreaterThan(-1); return s.slice(at, s.indexOf('\n}\n', at)); };
    expect(disk(src('scripts/follow-latest.sh'))).toBe(disk(l));
    // The timers tell a record kept for a release put back from one an upgrade cut off left with a copy of kept_record (review of HB-1456).
    const kept = (t: string) => { const at = t.indexOf('kept_record() {'); expect(at).toBeGreaterThan(-1); return t.slice(at, t.indexOf('\n', at)); };
    for (const f of ['scripts/follow-channel.sh', 'scripts/follow-latest.sh']) expect(kept(src(f)), f).toBe(kept(l));
    for (const s of [d, u]) expect(s).toContain('mkdir "$LOCK_PATH.clearing"');
    // The dependencies' lock, ensure-deps.sh's, by the same name and holder line (review of HB-1212).
    const deps = (s: string) => s.match(/^DEPS_LOCK=.*$/m)?.[0];
    expect(deps(d)).toBe(deps(u));
    // Keyed on the physical path, links resolved, in each (HB-1377).
    expect(deps(u)).toBe('DEPS_LOCK="$LOCKS/deps-$(printf %s "$(pwd -P)" | cksum | cut -d\' \' -f1).lock.d"');
    expect(deps(src('scripts/ensure-deps.sh'))).toBe(deps(u));
    // And, through a link, the lock releases before 2.193.0 key on the path as given, in each (review of HB-1377).
    const old = (s: string) => s.match(/^DEPS_LOCK_OLD=.*\n.*$/m)?.[0];
    expect(old(u)).toBe('DEPS_LOCK_OLD="$LOCKS/deps-$(printf %s "$DIR" | cksum | cut -d\' \' -f1).lock.d"\n[ "$DEPS_LOCK_OLD" != "$DEPS_LOCK" ] || DEPS_LOCK_OLD=""');
    expect(old(d)).toBe(old(u));
    expect(old(src('scripts/ensure-deps.sh'))).toBe(old(u)!.replace('"$DIR"', '"$PWD"'));
    // A lock with no holder is a leftover once a minute old, in ensure-deps.sh and the helpers alike (HB-1377).
    const unowned = (t: string) => t.match(/^ {2}if \[ -z "\$owner" \]; then .*"\$1".*$/m)?.[0];
    expect(unowned(l)).toBe('  if [ -z "$owner" ]; then [ -n "$(find "$1" -maxdepth 0 -mmin +1 2>/dev/null)" ]; return; fi');
    expect(unowned(src('scripts/ensure-deps.sh'))).toBe(unowned(l));
    // How long each waits for the lock: the same in all three, half an hour unless a test says (HB-1382).
    const wait = (t: string) => t.match(/^DEPS_WAIT=.*\n(?:.*\n){2}esac$/m)?.[0];
    expect(wait(u)).toBe('DEPS_WAIT="${HATCHABOT_DEPS_WAIT_SECS:-1800}"\ncase "$DEPS_WAIT" in\n  \'\'|*[!0-9]*) DEPS_WAIT=1800 ;;\nesac');
    expect(wait(src('scripts/deploy-release.sh'))).toBe(wait(u));
    expect(wait(src('scripts/ensure-deps.sh'))).toBe(wait(u));
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
    for (const f of ['uninstall.sh', 'backup-owner.sh']) writeFileSync(join(repo, 'scripts', f), readFileSync(join('scripts', f)), { mode: 0o755 });
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
