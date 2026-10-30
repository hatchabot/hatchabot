import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * scripts/upgrade.sh on a BUNDLE install (install.sh, docs/install-bundle.md):
 * no clone — the next release's bundle is fetched (here from file:// URLs),
 * its hash checked, unpacked and self-checked, then only the bundle's own
 * top-level files are swapped in: .env and data/ stay. A release that does not
 * come up is rolled back. Everything here is made up and stays in a temp dir.
 */

const driver = resolve('node_modules/better-sqlite3');

/** A fake bundle tree for `tag`: its restart.sh exits with `restartRc`. */
function bundleTree(root: string, tag: string, restartRc = 0, docs = false): string {
  const dir = join(root, 'hatchabot');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, '.node', 'bin'), { recursive: true });
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.execPath, join(dir, '.node', 'bin', 'node'));
  symlinkSync(driver, join(dir, 'node_modules', 'better-sqlite3'));
  for (const s of ['upgrade.sh', 'release-target.sh', 'release-manifest.sh']) writeFileSync(join(dir, 'scripts', s), readFileSync(join('scripts', s)), { mode: 0o755 });
  writeFileSync(join(dir, 'scripts', 'restart.sh'), `#!/usr/bin/env bash\nexit ${restartRc}\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'VERSION'), tag);
  writeFileSync(join(dir, 'BUNDLE.json'), JSON.stringify({ version: tag.slice(1), tag, platform: 'linux-arm64' }) + '\n');
  const files = ['.bundle-files', '.node', 'BUNDLE.json', 'VERSION', 'node_modules', 'scripts'];
  if (docs) { mkdirSync(join(dir, 'docs')); writeFileSync(join(dir, 'docs', 'guide.md'), tag); files.push('docs'); }
  writeFileSync(join(dir, '.bundle-files'), files.join('\n') + '\n');
  return dir;
}

/** The release assets for `tag` under base/tag/: the tarball and its .sha256. */
function publish(base: string, tag: string, opts: { restartRc?: number; badHash?: boolean; docs?: boolean } = {}): void {
  const work = mkdtempSync(join(tmpdir(), 'hb-bundle-src-'));
  bundleTree(work, tag, opts.restartRc ?? 0, opts.docs);
  const name = `hatchabot-${tag}-linux-arm64.tar.gz`;
  mkdirSync(join(base, tag), { recursive: true });
  const r = spawnSync('tar', ['-czf', join(base, tag, name), '-C', work, 'hatchabot']);
  expect(r.status, String(r.stderr)).toBe(0);
  const sum = opts.badHash ? '0'.repeat(64) : createHash('sha256').update(readFileSync(join(base, tag, name))).digest('hex');
  writeFileSync(join(base, tag, `${name}.sha256`), `${sum}  ${name}\n`);
}

function world() {
  const root = mkdtempSync(join(tmpdir(), 'hb-bundle-up-'));
  const home = join(root, 'home'), base = join(root, 'releases');
  mkdirSync(join(home, 'tmp'), { recursive: true });
  const install = bundleTree(join(root, 'srv'), 'v2.0.0');
  writeFileSync(join(install, '.env'), 'HATCHABOT_SECRET_KEY=made-up\n');
  mkdirSync(join(install, 'data'));
  writeFileSync(join(install, 'data', 'hatchabot.sqlite'), 'not really a database');
  return { root, home, base, install };
}
function upgrade(w: ReturnType<typeof world>, arg: string, shims = '') {
  return spawnSync('bash', [join(w.install, 'scripts', 'upgrade.sh'), arg], {
    encoding: 'utf8', timeout: 60_000,
    env: { PATH: `${shims ? `${shims}:` : ''}${dirname(process.execPath)}:/usr/bin:/bin`, HOME: w.home, TMPDIR: join(w.home, 'tmp'), HATCHABOT_BUNDLE_BASE: `file://${w.base}`, HATCHABOT_UPGRADE_IMAGE: '0' },
  });
}
const read = (p: string) => readFileSync(p, 'utf8');

describe('scripts/upgrade.sh on a bundle install', () => {
  it('swaps in the next bundle and keeps .env and data/', () => {
    const w = world();
    publish(w.base, 'v2.0.1');
    const r = upgrade(w, 'v2.0.1');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Now on v2.0.1.');
    expect(read(join(w.install, 'VERSION'))).toBe('v2.0.1');
    expect(JSON.parse(read(join(w.install, 'BUNDLE.json'))).tag).toBe('v2.0.1');
    expect(read(join(w.install, '.env'))).toBe('HATCHABOT_SECRET_KEY=made-up\n');
    expect(read(join(w.install, 'data', 'hatchabot.sqlite'))).toBe('not really a database');
    expect(existsSync(join(w.install, '.prev-release'))).toBe(false);
    expect(read(join(w.home, '.config', 'hatchabot', 'channel')).trim()).toBe('v2.0.1'); // named by hand: a pin
  });

  it('a release that does not come up is rolled back, the old one restored', () => {
    const w = world();
    publish(w.base, 'v2.0.1', { restartRc: 1 });
    const r = upgrade(w, 'v2.0.1');
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('Rolling back to v2.0.0');
    expect(read(join(w.install, 'VERSION'))).toBe('v2.0.0');
    expect(JSON.parse(read(join(w.install, 'BUNDLE.json'))).tag).toBe('v2.0.0');
    expect(read(join(w.install, '.env'))).toBe('HATCHABOT_SECRET_KEY=made-up\n');
    expect(existsSync(join(w.install, 'data', 'hatchabot.sqlite'))).toBe(true);
  });

  it('a checksum that does not match, or no bundle at all, changes nothing (exit 3: tried again later)', () => {
    const w = world();
    publish(w.base, 'v2.0.1', { badHash: true });
    const bad = upgrade(w, 'v2.0.1');
    expect(bad.status, bad.stdout + bad.stderr).toBe(3);
    expect(bad.stdout).toContain('checksum does not match');
    const none = upgrade(w, 'v2.0.9');
    expect(none.status).toBe(3);
    expect(none.stdout).toContain('No bundle for v2.0.9');
    expect(read(join(w.install, 'VERSION'))).toBe('v2.0.0');
  });
});

const REAL_MV = spawnSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).stdout.trim();

describe('a bundle swap that was cut off part-way (HB-0049)', () => {
  /** An mv that, once the new BUNDLE.json is in, kills the upgrade on the spot (SIGKILL: no trap runs). */
  const killer = (w: ReturnType<typeof world>) => {
    const bin = join(w.root, 'killer'); mkdirSync(bin);
    writeFileSync(join(bin, 'mv'), `#!/usr/bin/env bash
${JSON.stringify(REAL_MV)} "$@" || exit $?
case "$1" in */.hatchabot-next-*/hatchabot/BUNDLE.json) kill -9 "$PPID" ;; esac
`, { mode: 0o755 });
    return bin;
  };

  it('the next run puts the previous release back before anything else, instead of "Already on vNEW"', () => {
    const w = world();
    publish(w.base, 'v2.0.1');
    const cut = upgrade(w, 'v2.0.1', killer(w));
    expect(cut.signal, cut.stdout + cut.stderr).toBe('SIGKILL');
    // Half old, half new: the new BUNDLE.json is in, the old VERSION still here.
    expect(JSON.parse(read(join(w.install, 'BUNDLE.json'))).tag).toBe('v2.0.1');
    expect(read(join(w.install, 'VERSION'))).toBe('v2.0.0');
    expect(existsSync(join(w.install, '.swapping'))).toBe(true);

    // Offline now: still repaired, and on the old release whole.
    const offline = upgrade(w, 'v2.0.9');
    expect(offline.stdout).toContain('was cut off part-way — putting v2.0.0 back first');
    expect(offline.stdout).not.toContain('Already on');
    expect(offline.status, offline.stdout + offline.stderr).toBe(3);
    expect(read(join(w.install, 'VERSION'))).toBe('v2.0.0');
    expect(JSON.parse(read(join(w.install, 'BUNDLE.json'))).tag).toBe('v2.0.0');
    for (const gone of ['.swapping', '.prev-release']) expect(existsSync(join(w.install, gone)), gone).toBe(false);
    expect(readdirSync(join(w.root, 'srv')).filter((n) => n.startsWith('.hatchabot-next-'))).toEqual([]);

    const again = upgrade(w, 'v2.0.1');
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toContain('Now on v2.0.1.');
    expect(read(join(w.install, 'VERSION'))).toBe('v2.0.1');
    expect(read(join(w.install, '.env'))).toBe('HATCHABOT_SECRET_KEY=made-up\n');
    expect(read(join(w.install, 'data', 'hatchabot.sqlite'))).toBe('not really a database');
    expect(existsSync(join(w.install, '.swapping'))).toBe(false);
  });

  /** A shim mv that kills the upgrade when it moves `from` (before the move, or after it). */
  const cutAt = (w: ReturnType<typeof world>, from: string, when: 'before' | 'after') => {
    const bin = join(w.root, `cut-${when}`); mkdirSync(bin);
    const kill = `case "$1" in ${from}) kill -9 "$PPID"; exit 1 ;; esac`;
    writeFileSync(join(bin, 'mv'), `#!/usr/bin/env bash\n${when === 'before' ? kill + '\n' : ''}${JSON.stringify(REAL_MV)} "$@" || exit $?\n${when === 'after' ? kill + '\n' : ''}`, { mode: 0o755 });
    return bin;
  };
  /** The next run, offline: it must put v2.0.0 back whole before anything else. */
  const repaired = (w: ReturnType<typeof world>) => {
    const next = upgrade(w, 'v2.0.9');
    expect(next.stdout).toContain('was cut off part-way — putting v2.0.0 back first');
    expect(next.status, next.stdout + next.stderr).toBe(3);
    expect(read(join(w.install, 'VERSION'))).toBe('v2.0.0');
    expect(JSON.parse(read(join(w.install, 'BUNDLE.json'))).tag).toBe('v2.0.0');
    for (const gone of ['.swapping', '.prev-release']) expect(existsSync(join(w.install, gone)), gone).toBe(false);
  };

  it('a rollback cut off after putting one file back: the next run keeps that old file, not deletes it as the new one\'s (HB-0279)', () => {
    const w = world();
    publish(w.base, 'v2.0.1', { restartRc: 1 });
    // The new release does not come up; its rollback is killed once the old BUNDLE.json is back.
    const cut = upgrade(w, 'v2.0.1', cutAt(w, '*/.prev-release/BUNDLE.json', 'after'));
    expect(cut.signal, cut.stdout + cut.stderr).toBe('SIGKILL');
    expect(JSON.parse(read(join(w.install, 'BUNDLE.json'))).tag).toBe('v2.0.0');
    expect(existsSync(join(w.install, '.prev-release', 'VERSION'))).toBe(true);
    repaired(w);
  });

  it('a swap cut off just before it moved an old file aside: the old file is put back, not removed (HB-0279)', () => {
    const w = world();
    publish(w.base, 'v2.0.1');
    const cut = upgrade(w, 'v2.0.1', cutAt(w, `${w.install}/VERSION`, 'before'));
    expect(cut.signal, cut.stdout + cut.stderr).toBe('SIGKILL');
    expect(read(join(w.install, 'VERSION'))).toBe('v2.0.0');
    repaired(w);
  });

  it('the first upgrade off a release from before the fix, cut off between writing `in VERSION` and moving the old one aside: the old one is kept (HB-0279)', () => {
    // The installed upgrade.sh (v2.170.1 and before) writes the `in` line first, then moves the old file aside.
    const w = world();
    const now = read('scripts/upgrade.sh');
    const aside = '    if [ -e "$DIR/$f" ]; then mv "$DIR/$f" "$PREV/" || { echo "Could not move $DIR/$f aside."; exit 3; }; fi\n';
    const journal = '    printf \'in %s\\n\' "$f" >> "$SWAPPING"\n';
    expect(now).toContain(aside + journal);
    writeFileSync(join(w.install, 'scripts', 'upgrade.sh'), now.replace(aside + journal, journal + aside), { mode: 0o755 });
    publish(w.base, 'v2.0.1');
    const cut = upgrade(w, 'v2.0.1', cutAt(w, `${w.install}/VERSION`, 'before'));
    expect(cut.signal, cut.stdout + cut.stderr).toBe('SIGKILL');
    expect(read(join(w.install, '.swapping'))).toMatch(/^in VERSION$/m);
    expect(existsSync(join(w.install, '.prev-release', 'VERSION'))).toBe(false);
    expect(read(join(w.install, 'scripts', 'upgrade.sh'))).toBe(now); // the new one came in first, and repairs it
    repaired(w);
  });

  it('a rollback cut off again, then finished by the old release\'s own upgrade.sh, still ends on the old release whole (HB-0279)', () => {
    // The first upgrade off a release from before the fix: the old upgrade.sh
    // swaps (its restore_prev is v2.170.1's, below), is killed, the new one (scripts/ came in first) starts the
    // rollback and is killed after putting scripts/ and BUNDLE.json back,
    // and the old upgrade.sh, which reads only `in` lines, finishes it.
    const w = world();
    // This upgrade.sh with v2.170.1's restore_prev, which reads only `in` lines.
    const OLD_RESTORE = `restore_prev() {
  local line f
  if [ -f "$SWAPPING" ]; then
    while IFS= read -r line; do
      case "$line" in "in "?*) f="\${line#in }" ;; *) continue ;; esac
      not_ours "$f" || rm -rf "\${DIR:?}/$f"
    done < "$SWAPPING"
  fi
  for f in "$PREV"/* "$PREV"/.[!.]*; do
    [ -e "$f" ] || continue
    rm -rf "\${DIR:?}/\${f##*/}"
    mv "$f" "$DIR/" || return 1
  done
  rm -rf "$PREV"
  rm -f "$SWAPPING"
}
`;
    const now = read('scripts/upgrade.sh');
    const start = now.indexOf('restore_prev() {'), end = now.indexOf('\n}\n', start) + 3;
    expect(start).toBeGreaterThan(0);
    const oldScript = now.slice(0, start) + OLD_RESTORE + now.slice(end);
    expect(oldScript).not.toContain('grep -vxF');
    writeFileSync(join(w.install, 'scripts', 'upgrade.sh'), oldScript, { mode: 0o755 });
    publish(w.base, 'v2.0.1');
    const killer = join(w.root, 'killer'); mkdirSync(killer);
    writeFileSync(join(killer, 'mv'), `#!/usr/bin/env bash\n${JSON.stringify(REAL_MV)} "$@" || exit $?\ncase "$1" in */.hatchabot-next-*/hatchabot/BUNDLE.json) kill -9 "$PPID" ;; esac\n`, { mode: 0o755 });
    expect(upgrade(w, 'v2.0.1', killer).signal).toBe('SIGKILL');
    expect(read(join(w.install, 'scripts', 'upgrade.sh'))).not.toBe(oldScript);
    const second = upgrade(w, 'v2.0.9', cutAt(w, '*/.prev-release/BUNDLE.json', 'after'));
    expect(second.signal, second.stdout + second.stderr).toBe('SIGKILL');
    expect(read(join(w.install, 'scripts', 'upgrade.sh'))).toBe(oldScript);
    repaired(w);
    expect(existsSync(join(w.install, 'scripts', 'restart.sh'))).toBe(true);
    expect(existsSync(join(w.install, '.node', 'bin', 'node'))).toBe(true);
  });

  it('a folder the old release did not list is replaced, not given the new one inside it (HB-0071)', () => {
    const w = world();
    mkdirSync(join(w.install, 'docs')); writeFileSync(join(w.install, 'docs', 'old.md'), 'left over');
    publish(w.base, 'v2.0.1', { docs: true });
    const r = upgrade(w, 'v2.0.1');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(read(join(w.install, 'docs', 'guide.md'))).toBe('v2.0.1');
    expect(existsSync(join(w.install, 'docs', 'docs'))).toBe(false);
    expect(existsSync(join(w.install, 'docs', 'old.md'))).toBe(false);
  });

  it('rolled back, the folder it replaced comes back as it was, not inside the new one', () => {
    const w = world();
    mkdirSync(join(w.install, 'docs')); writeFileSync(join(w.install, 'docs', 'old.md'), 'left over');
    publish(w.base, 'v2.0.1', { docs: true, restartRc: 1 });
    const r = upgrade(w, 'v2.0.1');
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(read(join(w.install, 'docs', 'old.md'))).toBe('left over');
    expect(existsSync(join(w.install, 'docs', 'guide.md'))).toBe(false);
    expect(existsSync(join(w.install, 'docs', 'docs'))).toBe(false);
  });
});
