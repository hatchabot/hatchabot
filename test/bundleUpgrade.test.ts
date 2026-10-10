import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
function bundleTree(root: string, tag: string, restartRc = 0): string {
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
  writeFileSync(join(dir, '.bundle-files'), ['.bundle-files', '.node', 'BUNDLE.json', 'VERSION', 'node_modules', 'scripts'].join('\n') + '\n');
  return dir;
}

/** The release assets for `tag` under base/tag/: the tarball and its .sha256. */
function publish(base: string, tag: string, opts: { restartRc?: number; badHash?: boolean } = {}): void {
  const work = mkdtempSync(join(tmpdir(), 'hb-bundle-src-'));
  bundleTree(work, tag, opts.restartRc ?? 0);
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
function upgrade(w: ReturnType<typeof world>, arg: string) {
  return spawnSync('bash', [join(w.install, 'scripts', 'upgrade.sh'), arg], {
    encoding: 'utf8', timeout: 60_000,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: w.home, TMPDIR: join(w.home, 'tmp'), HATCHABOT_BUNDLE_BASE: `file://${w.base}`, HATCHABOT_UPGRADE_IMAGE: '0' },
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
