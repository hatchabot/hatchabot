import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// These run upgrade.sh several times a test: 1-3 s alone, past vitest's 5 s
// when the self-hosted runner shares the machine (PR #76, 2026-11-05).
vi.setConfig({ testTimeout: 30_000 });

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
  for (const s of ['upgrade.sh', 'follow-channel.sh', 'release-target.sh', 'release-manifest.sh']) writeFileSync(join(dir, 'scripts', s), readFileSync(join('scripts', s)), { mode: 0o755 });
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
  // From v2.159.0 a release must have a manifest (scripts/release-manifest.sh).
  const [maj, min] = tag.slice(1).split('.').map(Number);
  if (maj! > 2 || (maj === 2 && min! >= 159)) {
    writeFileSync(join(base, tag, 'release-manifest.json'), JSON.stringify({
      schema: 1, version: tag.slice(1), tag, commit: 'a'.repeat(40), createdAt: '2026-10-10T00:00:00Z',
      assets: [{ name, size: statSync(join(base, tag, name)).size, sha256: sum }],
      image: { repository: 'ghcr.io/hatchabot/runtime', tag, index: `sha256:${'d'.repeat(64)}`, platforms: { 'linux/amd64': `sha256:${'e'.repeat(64)}`, 'linux/arm64': `sha256:${'f'.repeat(64)}` }, openclaw: '2026.9.8' },
      inputs: { openclaw: '2026.9.8', nodeImage: `node:22-slim@sha256:${'c'.repeat(64)}` },
    }));
  }
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
function upgrade(w: ReturnType<typeof world>, arg: string, shims = '', extra: Record<string, string> = {}) {
  return spawnSync('bash', [join(w.install, 'scripts', 'upgrade.sh'), arg], {
    encoding: 'utf8', timeout: 60_000,
    env: { PATH: `${shims ? `${shims}:` : ''}${dirname(process.execPath)}:/usr/bin:/bin`, HOME: w.home, TMPDIR: join(w.home, 'tmp'), HATCHABOT_BUNDLE_BASE: `file://${w.base}`, HATCHABOT_UPGRADE_IMAGE: '0', ...extra },
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

  it('a checksum that does not match, or no bundle yet for what a channel names, changes nothing (exit 3: tried again later)', () => {
    const w = world();
    publish(w.base, 'v2.0.1', { badHash: true });
    const bad = upgrade(w, 'v2.0.1');
    expect(bad.status, bad.stdout + bad.stderr).toBe(3);
    expect(bad.stdout).toContain('checksum does not match');
    const none = upgrade(w, 'stable', '', { HATCHABOT_UPGRADE_BY_TIMER: '1', HATCHABOT_UPGRADE_TARGET: 'v2.0.9' });
    expect(none.status).toBe(3);
    expect(none.stdout).toContain('No bundle for v2.0.9');
    expect(read(join(w.install, 'VERSION'))).toBe('v2.0.0');
  });

  describe('a version named by hand is a pin only once it is there (HB-0428)', () => {
    const channel = (w: ReturnType<typeof world>) => {
      const f = join(w.install, 'data', 'channel'), u = join(w.home, '.config', 'hatchabot', 'channel');
      return existsSync(f) ? read(f).trim() : existsSync(u) ? `user:${read(u).trim()}` : undefined;
    };
    it('one with no release is refused with exit 2, and the channel stays', () => {
      const w = world();
      writeFileSync(join(w.install, 'data', 'channel'), 'stable\n');
      const r = upgrade(w, 'v2.172.9');
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stdout).toContain('There is no release v2.172.9');
      expect(r.stdout).not.toContain('Pinned');
      expect(channel(w)).toBe('stable');
      expect(read(join(w.install, 'VERSION'))).toBe('v2.0.0');
    });
    it('and with none remembered, none is written', () => {
      const w = world();
      expect(upgrade(w, 'v2.172.9').status).toBe(2);
      expect(channel(w)).toBeUndefined();
    });
    it('a checksum that fails writes no pin; one that does not come up is taken back', () => {
      const w = world();
      writeFileSync(join(w.install, 'data', 'channel'), 'beta\n');
      publish(w.base, 'v2.0.1', { badHash: true });
      expect(upgrade(w, 'v2.0.1').status).toBe(3);
      expect(channel(w)).toBe('beta');
      publish(w.base, 'v2.0.2', { restartRc: 1 });
      const r = upgrade(w, 'v2.0.2');
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stdout).toContain('Not pinned to v2.0.2');
      expect(channel(w)).toBe('beta');
      expect(read(join(w.install, 'VERSION'))).toBe('v2.0.0');
    });
    it('one that comes up, or the one already here, is pinned', () => {
      const w = world();
      publish(w.base, 'v2.0.1');
      const r = upgrade(w, 'v2.0.1');
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain('Pinned to v2.0.1');
      expect(channel(w)).toBe('user:v2.0.1'); // from before v2.169.0: the user's file
      rmSync(join(w.home, '.config', 'hatchabot', 'channel'));
      const again = upgrade(w, 'v2.0.1');
      expect(again.status).toBe(0);
      expect(again.stdout).toContain('Pinned to v2.0.1');
      expect(again.stdout).toContain('Already on v2.0.1');
      expect(channel(w)).toBe('user:v2.0.1');
    });
    it('a busy upgrade lock writes no pin', () => {
      const w = world();
      publish(w.base, 'v2.0.1');
      const key = spawnSync('sh', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', w.install], { encoding: 'utf8' }).stdout.trim();
      const lock = join(w.home, '.local', 'state', 'hatchabot', `upgrade-${key}.lock.d`);
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, 'owner'), String(process.pid)); // a holder that is alive
      expect(upgrade(w, 'v2.0.1').status).toBe(4);
      expect(channel(w)).toBeUndefined();
    });
  });

  describe('a full disk is named as one (HB-0438)', () => {
    const shimmed = (w: ReturnType<typeof world>, name: string, body: string) => {
      const bin = join(w.root, 'shims'); mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
      return bin;
    };
    it('curl unable to write the download: exit 3, the disk, and no word of a missing release', () => {
      const w = world();
      const r = upgrade(w, 'stable', shimmed(w, 'curl', 'echo "curl: (23) Failure writing output to destination" >&2; exit 23'), { HATCHABOT_UPGRADE_BY_TIMER: '1', HATCHABOT_UPGRADE_TARGET: 'v2.0.1' });
      expect(r.status, r.stdout + r.stderr).toBe(3);
      expect(r.stdout).toMatch(/is full \(\d+ MB free\), so the v2\.0\.1 bundle could not be written there: nothing was changed\. Free about 1 GB/);
      expect(r.stdout).not.toContain('No bundle');
      expect(read(join(w.install, 'VERSION'))).toBe('v2.0.0');
    });
    it('tar out of space: the same, with what tar said', () => {
      const w = world();
      publish(w.base, 'v2.0.1');
      const r = upgrade(w, 'v2.0.1', shimmed(w, 'tar', 'echo "tar: hatchabot/VERSION: Cannot write: No space left on device"; exit 2'));
      expect(r.status, r.stdout + r.stderr).toBe(3);
      expect(r.stdout).toContain('No space left on device');
      expect(r.stdout).toMatch(/is full/);
      expect(r.stdout).not.toContain('Could not unpack');
    });
    it('tar out of space in another language: still the disk, as tar is asked in English', () => {
      const w = world();
      publish(w.base, 'v2.0.1');
      const r = upgrade(w, 'v2.0.1', shimmed(w, 'tar', '[ "${LC_ALL:-}" = C ] && echo "tar: x: Cannot write: No space left on device" || echo "tar: x: Auf dem Gerät ist kein Speicherplatz mehr verfügbar"; exit 2'), { LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8' });
      expect(r.status, r.stdout + r.stderr).toBe(3);
      expect(r.stdout).toMatch(/is full/);
      expect(r.stdout).not.toContain('Could not unpack');
    });
    it('a parent folder this user cannot write is not called a full disk', () => {
      if (process.getuid?.() === 0) return; // root writes anywhere
      const w = world();
      const parent = dirname(w.install);
      chmodSync(parent, 0o555);
      const r = upgrade(w, 'stable', '', { HATCHABOT_UPGRADE_BY_TIMER: '1', HATCHABOT_UPGRADE_TARGET: 'v2.0.1' });
      chmodSync(parent, 0o755);
      expect(r.status, r.stdout + r.stderr).toBe(3);
      expect(r.stdout).toContain(`This user cannot write to ${parent}`);
      expect(r.stdout).toContain('nothing was changed');
      expect(r.stdout).not.toMatch(/is full/);
      expect(read(join(w.install, 'VERSION'))).toBe('v2.0.0');
    });
    it('a mktemp that fails in a folder this user can write: room or permission, with the space free, never "full"', () => {
      const w = world();
      // Only the folder beside the install: its first mktemp, for its own copy, goes on.
      const mktemp = spawnSync('sh', ['-c', 'command -v mktemp'], { encoding: 'utf8' }).stdout.trim();
      const r = upgrade(w, 'stable', shimmed(w, 'mktemp', `case "$*" in *.hatchabot-next-*) echo "mktemp: failed" >&2; exit 1 ;; esac\nexec ${JSON.stringify(mktemp)} "$@"`), { HATCHABOT_UPGRADE_BY_TIMER: '1', HATCHABOT_UPGRADE_TARGET: 'v2.0.1' });
      expect(r.status, r.stdout + r.stderr).toBe(3);
      expect(r.stdout).toMatch(/no room or no permission there \(\d+ MB free\): nothing was changed/);
      expect(r.stdout).not.toMatch(/is full/);
    });
    it('a tar that fails for another reason is not the disk', () => {
      const w = world();
      publish(w.base, 'v2.0.1');
      const r = upgrade(w, 'v2.0.1', shimmed(w, 'tar', 'echo "gzip: stdin: not in gzip format"; exit 2'));
      expect(r.status).toBe(3);
      expect(r.stdout).toContain('Could not unpack the v2.0.1 bundle');
    });
    it('no room for the temporary copy of itself: exit 3, which the timer does not read as a bad release', () => {
      const w = world();
      const r = upgrade(w, 'stable', shimmed(w, 'mktemp', 'echo "mktemp: failed to create file: No space left on device" >&2; exit 1'));
      expect(r.status, r.stdout + r.stderr).toBe(3);
      expect(r.stdout).toContain('a full disk?');
    });
    it('the network is the network', () => {
      const w = world();
      const r = upgrade(w, 'stable', shimmed(w, 'curl', 'exit 7'), { HATCHABOT_UPGRADE_BY_TIMER: '1', HATCHABOT_UPGRADE_TARGET: 'v2.0.1' });
      expect(r.status).toBe(3);
      expect(r.stdout).toContain('Could not download the v2.0.1 bundle (curl 7');
    });
  });
});

const REAL_MV = spawnSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).stdout.trim();

describe('a pin left by a kill, on a bundle install (HB-0428)', () => {
  const PIN = 'v2.170.0', file = (w: ReturnType<typeof world>) => join(w.install, 'data', 'channel');
  const userFile = (w: ReturnType<typeof world>) => join(w.home, '.config', 'hatchabot', 'channel');
  const keyOf = (w: ReturnType<typeof world>) => spawnSync('sh', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', w.install], { encoding: 'utf8' }).stdout.trim();
  const stateOf = (w: ReturnType<typeof world>) => join(w.home, '.local', 'state', 'hatchabot');
  const record = (w: ReturnType<typeof world>) => join(stateOf(w), `upgrade-${keyOf(w)}.pin`);
  /** A curl that answers for the channels file (never the network) and goes on for the file:// releases. */
  const offlineCurl = (w: ReturnType<typeof world>) => {
    const bin = join(w.root, 'curl-bin'); mkdirSync(bin, { recursive: true });
    const curl = spawnSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash\ncase "$*" in *raw.githubusercontent*) echo asked >> '${w.root}/asked.log'; echo '{"stable":"v2.0.0"}'; exit 0 ;; *api.github*) exit 7 ;; esac\nexec ${JSON.stringify(curl)} "$@"\n`, { mode: 0o755 });
    return bin;
  };
  const asked = (w: ReturnType<typeof world>) => (existsSync(join(w.root, 'asked.log')) ? read(join(w.root, 'asked.log')).trim().split('\n').length : 0);
  const tick = (w: ReturnType<typeof world>) => spawnSync('bash', [join(w.install, 'scripts', 'follow-channel.sh'), 'stable'], {
    encoding: 'utf8', timeout: 60_000,
    env: { PATH: `${offlineCurl(w)}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: w.home, TMPDIR: join(w.home, 'tmp'), HATCHABOT_BUNDLE_BASE: `file://${w.base}`, HATCHABOT_UPGRADE_IMAGE: '0' },
  });
  /** `hatchabot upgrade <pin>` SIGKILLed: in the swap, or (`at: 'pin'`) with the pin written and nothing moved yet. */
  const cut = (w: ReturnType<typeof world>, pin = PIN, at: 'swap' | 'pin' = 'swap') => {
    publish(w.base, pin);
    const bin = join(w.root, `killer-${at}`); mkdirSync(bin, { recursive: true });
    if (at === 'swap') {
      const mv = spawnSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).stdout.trim();
      writeFileSync(join(bin, 'mv'), `#!/usr/bin/env bash\n${JSON.stringify(mv)} "$@" || exit $?\ncase "$1" in */.hatchabot-next-*/hatchabot/BUNDLE.json) kill -9 "$PPID" ;; esac\n`, { mode: 0o755 });
    } else {
      const mkdir = spawnSync('sh', ['-c', 'command -v mkdir'], { encoding: 'utf8' }).stdout.trim();
      writeFileSync(join(bin, 'mkdir'), `#!/usr/bin/env bash\ncase "$*" in *.prev-release*) kill -9 "$PPID"; exit 1 ;; esac\nexec ${JSON.stringify(mkdir)} "$@"\n`, { mode: 0o755 });
    }
    const r = upgrade(w, pin, bin);
    expect(r.signal, r.stdout + r.stderr).toBe('SIGKILL');
    return r;
  };
  const gone = (w: ReturnType<typeof world>, pin = PIN) => rmSync(join(w.base, pin), { recursive: true, force: true });
  const onOld = (w: ReturnType<typeof world>) => {
    expect(read(join(w.install, 'VERSION'))).toBe('v2.0.0');
    expect(JSON.parse(read(join(w.install, 'BUNDLE.json'))).tag).toBe('v2.0.0');
    expect(existsSync(join(w.install, '.swapping'))).toBe(false);
    expect(existsSync(record(w))).toBe(false);
  };

  it('the repair cannot get the release: the machine follows its channel again, and the next tick asks it', () => {
    const w = world();
    writeFileSync(file(w), 'stable\n');
    cut(w);
    expect(read(file(w)).trim()).toBe(PIN);
    expect(existsSync(join(w.install, '.swapping'))).toBe(true);
    gone(w);
    const r = tick(w);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('cut off part-way — putting v2.0.0 back first');
    expect(r.stdout).toContain(`Not pinned to ${PIN}`);
    expect(r.stdout).toContain('is no longer pinned to it');
    expect(r.stdout).not.toContain('tried again later');
    onOld(w);
    expect(read(file(w)).trim()).toBe('stable');
    const next = tick(w);
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(asked(w)).toBe(1); // the channel, asked: the timer is not quiet
  });
  it('the release does not come up on that try: the same', () => {
    const w = world();
    writeFileSync(file(w), 'beta\n');
    cut(w);
    publish(w.base, PIN, { restartRc: 1 });
    const r = tick(w);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain(`Not pinned to ${PIN}`);
    onOld(w);
    expect(read(file(w)).trim()).toBe('beta');
  });
  it('the release does come up on that try: the pin was meant, and it stays, with the timer quiet', () => {
    const w = world();
    writeFileSync(file(w), 'stable\n');
    cut(w);
    const r = tick(w);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(read(join(w.install, 'VERSION'))).toBe(PIN);
    expect(read(file(w)).trim()).toBe(PIN);
    expect(existsSync(record(w))).toBe(false);
    const next = tick(w);
    expect(next.status).toBe(0);
    expect(next.stdout).toBe('');
    expect(asked(w)).toBe(0);
  });
  it('a pin made on purpose and completed stays through ticks, and leaves no record', () => {
    const w = world();
    writeFileSync(file(w), 'stable\n');
    publish(w.base, PIN);
    expect(upgrade(w, PIN).status).toBe(0);
    expect(existsSync(record(w))).toBe(false);
    gone(w);
    const r = tick(w);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(read(file(w)).trim()).toBe(PIN);
  });
  it('the earlier pin comes back if there was one; with nothing before, nothing is left', () => {
    const w = world();
    writeFileSync(file(w), 'v2.169.5\n');
    cut(w); gone(w);
    expect(tick(w).status).toBe(1);
    onOld(w);
    expect(read(file(w)).trim()).toBe('v2.169.5');
    const w2 = world();
    cut(w2); gone(w2);
    expect(tick(w2).status).toBe(1);
    onOld(w2);
    expect(existsSync(file(w2))).toBe(false);
    expect(existsSync(userFile(w2))).toBe(false);
    expect(tick(w2).status).toBe(0);
    expect(asked(w2)).toBe(1); // the timer's own channel
  });
  it('a pin in the user\'s file, for a release from before v2.169.0, comes back out of it', () => {
    const w = world();
    writeFileSync(file(w), 'stable\n');
    mkdirSync(dirname(userFile(w)), { recursive: true }); writeFileSync(userFile(w), 'beta\n');
    cut(w, 'v2.0.1');
    expect(read(userFile(w)).trim()).toBe('v2.0.1');
    expect(existsSync(file(w))).toBe(false);
    gone(w, 'v2.0.1');
    expect(tick(w).status).toBe(1);
    onOld(w);
    expect(read(file(w)).trim()).toBe('stable');
    expect(read(userFile(w)).trim()).toBe('beta');
  });
  it('killed with the pin written and no swap begun: not quiet either', () => {
    const w = world();
    writeFileSync(file(w), 'stable\n');
    cut(w, PIN, 'pin');
    expect(read(file(w)).trim()).toBe(PIN);
    expect(existsSync(join(w.install, '.swapping'))).toBe(false);
    expect(existsSync(record(w))).toBe(true);
    gone(w);
    const r = tick(w);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    onOld(w);
    expect(read(file(w)).trim()).toBe('stable');
  });
  it('a pin an earlier upgrade.sh left, with no record: taken off when the release does not end up here', () => {
    const w = world();
    mkdirSync(dirname(userFile(w)), { recursive: true }); writeFileSync(userFile(w), 'beta\n');
    writeFileSync(file(w), 'stable\n');
    cut(w); gone(w);
    rmSync(record(w));
    // What that upgrade.sh wrote: its swap's record does not say it writes pin records.
    writeFileSync(join(w.install, '.swapping'), read(join(w.install, '.swapping')).replace('pins-recorded\n', ''));
    const r = tick(w);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    onOld(w);
    expect(existsSync(file(w))).toBe(false);
    expect(read(userFile(w)).trim()).toBe('beta'); // what is left of what it knew
  });
  it('a completed pin survives a later pin killed whose repair keeps failing, and a repair that works keeps it', () => {
    const w = world();
    writeFileSync(file(w), 'stable\n');
    publish(w.base, PIN);
    expect(upgrade(w, PIN).status).toBe(0);
    expect(read(file(w)).trim()).toBe(PIN);
    // Cut off on the way to a later one, from the pinned release.
    cut(w, 'v2.171.0');
    expect(read(file(w)).trim()).toBe('v2.171.0');
    expect(read(record(w))).toContain(`channel ${PIN}`);
    // Every try of the repair fails: the old release's files will not move back.
    const bin = join(w.root, 'no-mv'); mkdirSync(bin);
    const mv = spawnSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(bin, 'mv'), `#!/usr/bin/env bash\ncase "$1" in */.prev-release/BUNDLE.json) exit 1 ;; esac\nexec ${JSON.stringify(mv)} "$@"\n`, { mode: 0o755 });
    for (let i = 0; i < 3; i++) {
      const r = upgrade(w, 'stable', bin, { HATCHABOT_UPGRADE_BY_TIMER: '1', HATCHABOT_UPGRADE_TARGET: PIN });
      expect(r.status, r.stdout + r.stderr).toBe(3);
      expect(existsSync(join(w.install, '.swapping'))).toBe(true);
      expect(read(file(w)).trim(), `try ${i}: ${r.stdout}`).toBe(PIN);
      expect(existsSync(record(w))).toBe(false);
    }
    // It can be repaired at last: on the pinned release, still pinned, and the timer quiet.
    const fixed = tick(w);
    expect(fixed.status, fixed.stdout + fixed.stderr).toBe(0);
    expect(read(join(w.install, 'VERSION'))).toBe(PIN);
    expect(read(file(w)).trim()).toBe(PIN);
    expect(existsSync(join(w.install, '.swapping'))).toBe(false);
    expect(tick(w).stdout).toBe('');
    expect(asked(w)).toBe(0);
  });
  it('a channel named by hand after the kill wins: the record does not bring the old channel back', () => {
    const w = world();
    writeFileSync(file(w), 'beta\n');
    cut(w);
    const r = upgrade(w, 'stable', offlineCurl(w));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    onOld(w);
    expect(read(file(w)).trim()).toBe('stable');
  });
  it('another version named by hand after the kill, and refused: back to the channel, not to the first pin', () => {
    const w = world();
    writeFileSync(file(w), 'stable\n');
    cut(w);
    const r = upgrade(w, 'v2.171.0');
    expect(r.status, r.stdout + r.stderr).toBe(2);
    onOld(w);
    expect(read(file(w)).trim()).toBe('stable');
    // And that second version fails once pinned: still the channel it started from.
    const w2 = world();
    writeFileSync(file(w2), 'stable\n');
    cut(w2);
    publish(w2.base, 'v2.171.0', { restartRc: 1 });
    const r2 = upgrade(w2, 'v2.171.0');
    expect(r2.status, r2.stdout + r2.stderr).toBe(1);
    onOld(w2);
    expect(read(file(w2)).trim()).toBe('stable');
  });
  it('killed once the release was up: the pin stands, and the record goes at the next tick', () => {
    const w = world();
    writeFileSync(file(w), 'stable\n');
    publish(w.base, PIN);
    expect(upgrade(w, PIN).status).toBe(0);
    writeFileSync(record(w), `pin ${PIN}\nchannel stable\nuser \n`);
    const r = tick(w);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(read(file(w)).trim()).toBe(PIN);
    expect(existsSync(record(w))).toBe(false);
  });
  it('with another upgrade running, the pin and its record wait for it', () => {
    const w = world();
    writeFileSync(file(w), 'stable\n');
    cut(w);
    const lock = join(stateOf(w), `upgrade-${keyOf(w)}.lock.d`);
    rmSync(lock, { recursive: true, force: true }); mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner'), String(process.pid));
    const r = tick(w);
    expect(r.status).toBe(1);
    expect(read(file(w)).trim()).toBe(PIN);
    expect(existsSync(record(w))).toBe(true);
    expect(existsSync(join(w.install, '.swapping'))).toBe(true);
  });
  it('the channel it goes back to is noted before the pin, and this run answers for the pin before it is written', () => {
    const src = read('scripts/upgrade.sh');
    const body = /^pin_named\(\) \{[\s\S]*?^\}$/m.exec(src)![0];
    const at = (t: string) => { expect(body).toContain(t); return body.indexOf(t); };
    expect(at('mv -f "$PIN_RECORD.tmp" "$PIN_RECORD"')).toBeLessThan(at('PIN_ON="$ARG"'));
    expect(at('PIN_ON="$ARG"')).toBeLessThan(at('remember_channel "$ARG" "$ARG"'));
  });
});

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

    // A release that is not there: still repaired first, and on the old release whole.
    const offline = upgrade(w, 'v2.0.9');
    expect(offline.stdout).toContain('was cut off part-way — putting v2.0.0 back first');
    expect(offline.stdout).not.toContain('Already on');
    expect(offline.status, offline.stdout + offline.stderr).toBe(2);
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
  /** The next run, for a release that is not there: it must put v2.0.0 back whole before anything else. */
  const repaired = (w: ReturnType<typeof world>) => {
    const next = upgrade(w, 'v2.0.9');
    expect(next.stdout).toContain('was cut off part-way — putting v2.0.0 back first');
    expect(next.status, next.stdout + next.stderr).toBe(2);
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
