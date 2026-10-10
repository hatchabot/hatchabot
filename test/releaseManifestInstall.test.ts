import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';
import { parseReleaseManifest, publishedRuntimeImage, releaseManifest } from '../src/orchestrator/releaseManifest.js';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';
import { installRuntimeImage } from '../src/orchestrator/runnerSetup.js';

/**
 * What a release vouches for (#38, #47; docs/release-by-workflow-design.md
 * part 3): installs and upgrades check a bundle against the release's
 * release-manifest.json, and pull the runtime image by the digest it names.
 * A release made before manifests keeps the old checks (legacy).
 *
 * The scripts run in a sandbox: a temp HOME, a PATH of shims (curl serves a
 * made-up release from a temp dir, docker only writes down what it was
 * asked), git that refuses, and an environment built from scratch. Nothing
 * here reaches the network, Docker or this machine's install.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const shim = (bin: string, name: string, body: string) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const read = (p: string) => readFileSync(p, 'utf8');
const hasSetsid = spawnSync('sh', ['-c', 'command -v setsid']).status === 0;

const TAG = 'v2.0.1';
const OPENCLAW = /ARG OPENCLAW_VERSION=(\S+)/.exec(read('docker/Dockerfile.runtime'))![1]!;
const INDEX = `sha256:${'d'.repeat(64)}`;
const DOWNLOADS = 'https://github.com/hatchabot/hatchabot/releases/download';

/** A manifest in the shared format, for `tag`, listing the files given (name → path on disk). */
function manifestFor(tag: string, files: Record<string, string>, image: { openclaw?: string } = {}) {
  return {
    schema: 1, version: tag.slice(1), tag, commit: 'a'.repeat(40), createdAt: '2026-10-10T00:00:00Z',
    assets: Object.entries(files).map(([name, p]) => ({ name, size: statSync(p).size, sha256: sha(p) })),
    image: {
      repository: 'ghcr.io/hatchabot/runtime', tag, index: INDEX,
      platforms: { 'linux/amd64': `sha256:${'e'.repeat(64)}`, 'linux/arm64': `sha256:${'f'.repeat(64)}` },
      openclaw: image.openclaw ?? OPENCLAW,
    },
    inputs: { openclaw: image.openclaw ?? OPENCLAW, nodeImage: `node:22-slim@sha256:${'c'.repeat(64)}` },
  };
}

/**
 * curl, serving `releases/` as GitHub's release downloads: a missing file is a
 * 404 (exit 22 under -f), a file with a `.down` twin is a network failure,
 * and anything else is no network at all. Every URL asked for is logged.
 */
function curlShim(bin: string, releases: string, log: string) {
  shim(bin, 'curl', `out=""; fmt=""; fail=0; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) fmt="$2"; shift 2 ;;
    --retry|--max-filesize) shift 2 ;;
    --*) shift ;;
    -*) case "$1" in *f*) fail=1 ;; esac; shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "curl $url" >> ${JSON.stringify(log)}
case "$url" in ${DOWNLOADS}/*) f=${JSON.stringify(releases)}/"\${url#${DOWNLOADS}/}" ;; *) exit 6 ;; esac
[ -e "$f.down" ] && exit 7
if [ -f "$f" ]; then
  if [ -n "$out" ]; then cp "$f" "$out"; else cat "$f"; fi
  [ -z "$fmt" ] || printf 200
  exit 0
fi
[ -z "$fmt" ] || printf 404
[ "$fail" = 1 ] && exit 22
if [ -n "$out" ]; then echo "Not Found" > "$out"; else echo "Not Found"; fi
exit 0`);
}

const driver = resolve('node_modules/better-sqlite3');
/** A bundle tree for `tag` (its own Node and driver, so its self-check passes). */
function bundleTree(root: string, tag: string, platform: string, log: string): string {
  const dir = join(root, 'hatchabot');
  for (const d of ['scripts', '.node/bin', 'node_modules']) mkdirSync(join(dir, d), { recursive: true });
  symlinkSync(process.execPath, join(dir, '.node', 'bin', 'node'));
  symlinkSync(driver, join(dir, 'node_modules', 'better-sqlite3'));
  for (const s of ['upgrade.sh', 'release-target.sh', 'release-manifest.sh']) writeFileSync(join(dir, 'scripts', s), readFileSync(join('scripts', s)), { mode: 0o755 });
  writeFileSync(join(dir, 'scripts', 'restart.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  shim(join(dir, 'scripts'), 'with-docker.sh', `echo "with-docker $*" >> ${JSON.stringify(log)}`);
  writeFileSync(join(dir, 'VERSION'), tag);
  writeFileSync(join(dir, 'BUNDLE.json'), JSON.stringify({ version: tag.slice(1), tag, platform }) + '\n');
  writeFileSync(join(dir, '.bundle-files'), ['.bundle-files', '.node', 'BUNDLE.json', 'VERSION', 'node_modules', 'scripts'].join('\n') + '\n');
  return dir;
}

type Publish = { manifest?: 'good' | 'other-tag' | 'garbled' | 'down' | 'none'; tamper?: 'bytes' | 'size'; sha256File?: 'good' | 'bad' };
/** Release `tag` under releases/<tag>/: the bundle, its .sha256, and (unless 'none') its manifest. */
function publish(w: { root: string; releases: string; log: string }, tag: string, platform: string, opts: Publish = {}) {
  const work = mkdtempSync(join(w.root, 'src-'));
  bundleTree(work, tag, platform, w.log);
  const name = `hatchabot-${tag}-${platform}.tar.gz`;
  const at = join(w.releases, tag); mkdirSync(at, { recursive: true });
  const tarball = join(at, name);
  expect(spawnSync('tar', ['-czf', tarball, '-C', work, 'hatchabot']).status).toBe(0);
  writeFileSync(`${tarball}.sha256`, `${opts.sha256File === 'bad' ? '0'.repeat(64) : sha(tarball)}  ${name}\n`);
  const m = manifestFor(tag, { [name]: tarball, [`${name}.sha256`]: `${tarball}.sha256` });
  if (opts.tamper === 'size') m.assets[0]!.size += 1;
  const mf = join(at, 'release-manifest.json');
  const kind = opts.manifest ?? 'good';
  if (kind === 'good' || kind === 'down') writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
  if (kind === 'down') writeFileSync(`${mf}.down`, '');
  if (kind === 'other-tag') writeFileSync(mf, JSON.stringify({ ...m, tag: 'v2.0.0', version: '2.0.0' }));
  if (kind === 'garbled') writeFileSync(mf, JSON.stringify(m).slice(0, 200));
  // The bundle changed after the release vouched for it.
  if (opts.tamper === 'bytes') { writeFileSync(join(work, 'hatchabot', 'VERSION'), 'swapped'); expect(spawnSync('tar', ['-czf', tarball, '-C', work, 'hatchabot']).status).toBe(0); }
}

// ---- the reader is the same in both places ---------------------------------------
describe('the release manifest reader', () => {
  it('is the same text in install.sh (which has no Node or scripts yet) and scripts/release-manifest.sh', () => {
    const block = (p: string) => /# ---- release manifest reader[\s\S]*?# ---- end of the release manifest reader ----\n/.exec(read(p))?.[0];
    expect(block('scripts/release-manifest.sh')).toBeTruthy();
    expect(block('install.sh')).toBe(block('scripts/release-manifest.sh'));
  });
});

// ---- install.sh -------------------------------------------------------------------
function installWorld() {
  const root = temp('hb-mf-install-');
  const home = join(root, 'home'), bin = join(root, 'bin'), releases = join(root, 'releases');
  for (const d of [home, bin, releases]) mkdirSync(d);
  const log = join(root, 'calls.log');
  writeFileSync(log, '');
  curlShim(bin, releases, log);
  shim(bin, 'docker', 'case "$1" in version) echo 27.0 ;; esac; exit 0');
  shim(bin, 'uname', 'case "${1:-}" in -m) echo x86_64 ;; *) echo Linux ;; esac');
  shim(bin, 'getconf', 'echo "glibc 2.39"');
  // The native install, if it comes to that, goes as far as the clone, which refuses.
  shim(bin, 'node', 'echo 22');
  for (const t of ['make', 'g++', 'python3']) shim(bin, t, 'exit 0');
  shim(bin, 'git', `echo "git $*" >> ${JSON.stringify(log)}; exit 1`);
  for (const refuse of ['sudo', 'apt-get', 'brew']) shim(bin, refuse, `echo "${refuse} $*" >> ${JSON.stringify(log)}; exit 1`);
  const dir = join(root, 'hatchabot');
  const w = { root, home, bin, releases, log, dir };
  const run = () => {
    const cmd = [resolve('install.sh'), TAG];
    return spawnSync(hasSetsid ? 'setsid' : 'bash', hasSetsid ? ['bash', ...cmd] : cmd, {
      encoding: 'utf8', timeout: 60_000, input: '',
      env: scriptEnv(home, `${bin}:/usr/bin:/bin`, { HATCHABOT_DIR: dir, TMPDIR: root }),
    });
  };
  return { ...w, run };
}
const NAME = `hatchabot-${TAG}-linux-x64.tar.gz`;

describe('install.sh checks the bundle against the release manifest (#38)', () => {
  it('a bundle the manifest vouches for is installed, without the .sha256, and the manifest is kept', () => {
    const w = installWorld();
    publish(w, TAG, 'linux-x64');
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('unpacked: Hatchabot with its own Node');
    expect(JSON.parse(read(join(w.dir, 'BUNDLE.json'))).tag).toBe(TAG);
    expect(read(w.log)).not.toContain(`${NAME}.sha256`);
    expect(read(join(w.dir, 'data', 'release-manifests', `${TAG}.json`))).toBe(read(join(w.releases, TAG, 'release-manifest.json')));
    expect(read(w.log)).toContain('with-docker ./scripts/setup-host.sh');
  });

  for (const tamper of ['bytes', 'size'] as const) {
    it(`a bundle whose ${tamper === 'bytes' ? 'sha256' : 'size'} is not the manifest's is refused, and the native install takes over`, () => {
      const w = installWorld();
      publish(w, TAG, 'linux-x64', { tamper });
      const r = w.run();
      expect(r.stdout).toContain("the bundle does not match the release's manifest — not using it");
      expect(r.stdout).toContain('using the native install instead');
      expect(read(w.log)).toContain('git clone');
      expect(existsSync(join(w.dir, 'BUNDLE.json'))).toBe(false);
    });
  }

  for (const manifest of ['other-tag', 'garbled'] as const) {
    it(`a manifest that is ${manifest === 'garbled' ? 'unreadable' : 'for another release'} is refused — never passed over for the .sha256`, () => {
      const w = installWorld();
      publish(w, TAG, 'linux-x64', { manifest });
      const r = w.run();
      expect(r.stdout).toContain(`the release's manifest is not a readable manifest for ${TAG} — not using the bundle`);
      expect(r.stdout).toContain('using the native install instead');
      expect(read(w.log)).not.toContain(`${NAME}.sha256`);
      expect(existsSync(join(w.dir, 'BUNDLE.json'))).toBe(false);
    });
  }

  it('a manifest that cannot be fetched is not taken as "no manifest"', () => {
    const w = installWorld();
    publish(w, TAG, 'linux-x64', { manifest: 'down' });
    const r = w.run();
    expect(r.stdout).toContain("could not fetch the release's manifest to check the bundle");
    expect(read(w.log)).not.toContain(`${NAME}.sha256`);
    expect(existsSync(join(w.dir, 'BUNDLE.json'))).toBe(false);
  });

  it('a release made before manifests: its .sha256, as before', () => {
    const ok = installWorld();
    publish(ok, TAG, 'linux-x64', { manifest: 'none' });
    const r = ok.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(read(ok.log)).toContain(`${NAME}.sha256`);
    expect(JSON.parse(read(join(ok.dir, 'BUNDLE.json'))).tag).toBe(TAG);
    expect(existsSync(join(ok.dir, 'data', 'release-manifests'))).toBe(false);
    const bad = installWorld();
    publish(bad, TAG, 'linux-x64', { manifest: 'none', sha256File: 'bad' });
    expect(bad.run().stdout).toContain("the bundle's checksum does not match — not using it");
    expect(existsSync(join(bad.dir, 'BUNDLE.json'))).toBe(false);
  });
});

// ---- scripts/upgrade.sh on a bundle install ---------------------------------------
function upgradeWorld() {
  const root = temp('hb-mf-upgrade-');
  const home = join(root, 'home'), bin = join(root, 'bin'), releases = join(root, 'releases');
  for (const d of [home, join(home, 'tmp'), bin, releases]) mkdirSync(d, { recursive: true });
  const log = join(root, 'calls.log');
  writeFileSync(log, '');
  curlShim(bin, releases, log);
  const install = bundleTree(join(root, 'srv'), 'v2.0.0', 'linux-arm64', log);
  writeFileSync(join(install, '.env'), 'HATCHABOT_SECRET_KEY=made-up\n');
  mkdirSync(join(install, 'data'));
  const w = { root, home, bin, releases, log, install };
  const run = () => spawnSync('bash', [join(install, 'scripts', 'upgrade.sh'), TAG], {
    encoding: 'utf8', timeout: 60_000,
    env: scriptEnv(home, `${bin}:/usr/bin:/bin`, { TMPDIR: join(home, 'tmp'), HATCHABOT_UPGRADE_IMAGE: '0' }),
  });
  return { ...w, run };
}
const UNAME = `hatchabot-${TAG}-linux-arm64.tar.gz`;

describe('scripts/upgrade.sh checks the next bundle against the release manifest (#38)', () => {
  it('a bundle the manifest vouches for goes in; the manifest is kept in the data directory', () => {
    const w = upgradeWorld();
    publish(w, TAG, 'linux-arm64');
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`Now on ${TAG}.`);
    expect(read(w.log)).not.toContain(`${UNAME}.sha256`);
    expect(existsSync(join(w.install, 'data', 'release-manifests', `${TAG}.json`))).toBe(true);
  });

  it('a bundle that does not match is not installed (exit 3), and nothing moves', () => {
    const w = upgradeWorld();
    publish(w, TAG, 'linux-arm64', { tamper: 'bytes' });
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stderr).toContain('does not match the release manifest of v2.0.1');
    expect(r.stdout).toContain("the release's manifest does not vouch for it");
    expect(read(join(w.install, 'VERSION'))).toBe('v2.0.0');
  });

  for (const manifest of ['other-tag', 'garbled'] as const) {
    it(`a manifest that is ${manifest === 'garbled' ? 'unreadable' : 'for another release'} is refused (exit 3), never passed over for the .sha256`, () => {
      const w = upgradeWorld();
      publish(w, TAG, 'linux-arm64', { manifest });
      const r = w.run();
      expect(r.status, r.stdout + r.stderr).toBe(3);
      expect(r.stderr).toContain('is not a readable manifest for v2.0.1 — refusing it');
      expect(read(w.log)).not.toContain(`${UNAME}.sha256`);
      expect(read(join(w.install, 'VERSION'))).toBe('v2.0.0');
      expect(existsSync(join(w.install, 'data', 'release-manifests', `${TAG}.json`))).toBe(false);
    });
  }

  it('a release made before manifests: its .sha256, as before', () => {
    const w = upgradeWorld();
    publish(w, TAG, 'linux-arm64', { manifest: 'none' });
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(read(w.log)).toContain(`${UNAME}.sha256`);
    const bad = upgradeWorld();
    publish(bad, TAG, 'linux-arm64', { manifest: 'none', sha256File: 'bad' });
    const b = bad.run();
    expect(b.status).toBe(3);
    expect(b.stdout).toContain('checksum does not match');
  });
});

// ---- scripts/build-runtime-image.sh -----------------------------------------------
function imageWorld(label = OPENCLAW) {
  const root = temp('hb-mf-image-');
  const home = join(root, 'home'), bin = join(root, 'bin'), releases = join(root, 'releases'), app = join(root, 'app');
  for (const d of [home, bin, releases, join(app, 'scripts'), join(app, 'docker')]) mkdirSync(d, { recursive: true });
  for (const s of ['build-runtime-image.sh', 'release-manifest.sh']) writeFileSync(join(app, 'scripts', s), readFileSync(join('scripts', s)), { mode: 0o755 });
  writeFileSync(join(app, 'scripts', 'runtime-pins.mjs'), readFileSync('scripts/runtime-pins.mjs'));
  writeFileSync(join(app, 'docker', 'Dockerfile.runtime'), readFileSync('docker/Dockerfile.runtime'));
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'hatchabot', version: TAG.slice(1) }, null, 2) + '\n');
  symlinkSync(process.execPath, join(bin, 'node'));
  const log = join(root, 'calls.log');
  writeFileSync(log, '');
  curlShim(bin, releases, log);
  shim(bin, 'git', 'exit 128');
  shim(bin, 'npm', 'exit 1');
  // docker: every image carries `label`; a local build runs the default OpenClaw.
  shim(bin, 'docker', `echo "docker $*" >> ${JSON.stringify(log)}
case "$1" in
  inspect) echo ${JSON.stringify(label)} ;;
  run) echo "OpenClaw ${OPENCLAW}" ;;
  image) exit 1 ;;
esac
exit 0`);
  const w = { root, home, bin, releases, log, app };
  const run = () => spawnSync('bash', [join(app, 'scripts', 'build-runtime-image.sh')], { encoding: 'utf8', timeout: 60_000, env: scriptEnv(home, `${bin}:/usr/bin:/bin`) });
  const release = (m: unknown) => { mkdirSync(join(releases, TAG), { recursive: true }); writeFileSync(join(releases, TAG, 'release-manifest.json'), typeof m === 'string' ? m : JSON.stringify(m)); };
  return { ...w, run, release };
}

describe('scripts/build-runtime-image.sh pulls the image the release manifest names, by digest (#47)', () => {
  it('pulls by digest, checks its label, and tags it as the runtime image — no tag is trusted', () => {
    const w = imageWorld();
    w.release(manifestFor(TAG, {}));
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const calls = read(w.log);
    expect(calls).toContain(`docker pull ghcr.io/hatchabot/runtime@${INDEX}`);
    expect(calls).toContain(`docker tag ghcr.io/hatchabot/runtime@${INDEX} hatchabot-runtime:${OPENCLAW}`);
    expect(calls).toContain(`docker tag hatchabot-runtime:${OPENCLAW} hatchabot-runtime:latest`);
    expect(calls).not.toContain('manifest inspect');
    expect(calls).not.toContain('docker pull ghcr.io/hatchabot/runtime:');
    expect(existsSync(join(w.app, 'data', 'release-manifests', `${TAG}.json`))).toBe(true);
  });

  it('offline, the manifest kept in the data directory still pins the image', () => {
    const w = imageWorld();
    w.release(manifestFor(TAG, {}));
    expect(w.run().status).toBe(0);
    writeFileSync(join(w.releases, TAG, 'release-manifest.json.down'), '');
    writeFileSync(w.log, '');
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(read(w.log)).not.toContain('curl ');
    expect(read(w.log)).toContain(`docker pull ghcr.io/hatchabot/runtime@${INDEX}`);
  });

  it('an image whose label disagrees with the manifest is refused', () => {
    const w = imageWorld('1999.1.1');
    w.release(manifestFor(TAG, {}));
    const r = w.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('carries OpenClaw 1999.1.1');
    expect(read(w.log)).not.toContain('docker tag');
  });

  it('a manifest for another OpenClaw: no published image is trusted, it builds here', () => {
    const w = imageWorld();
    w.release(manifestFor(TAG, {}, { openclaw: '1999.1.1' }));
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('publishes the image for OpenClaw 1999.1.1 only');
    expect(read(w.log)).not.toContain('docker pull ghcr.io');
    expect(read(w.log)).toContain('docker build');
  });

  it('a garbled manifest is refused: nothing is pulled', () => {
    const w = imageWorld();
    w.release('<html>Sign in to the network</html>');
    const r = w.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('refusing it');
    expect(read(w.log)).not.toContain('docker pull');
    expect(read(w.log)).not.toContain('docker build');
  });

  it('a release made before manifests: the legacy pull by tag, accepted on its label', () => {
    const w = imageWorld();
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const calls = read(w.log);
    expect(calls).toContain(`docker manifest inspect ghcr.io/hatchabot/runtime:${OPENCLAW}`);
    expect(calls).toContain(`docker pull ghcr.io/hatchabot/runtime:${OPENCLAW}`);
    expect(calls).toContain(`docker tag ghcr.io/hatchabot/runtime:${OPENCLAW} hatchabot-runtime:${OPENCLAW}`);
  });
});

// ---- the app: src/orchestrator/releaseManifest.ts ----------------------------------
describe('releaseManifest / publishedRuntimeImage (#47)', () => {
  const good = JSON.stringify(manifestFor(TAG, {}));
  const served = (status: number, text = '') => { const urls: string[] = []; return { urls, fetchText: async (u: string) => { urls.push(u); return { status, text }; } }; };

  it('parses only a schema-1 manifest for the release asked about', () => {
    expect('problem' in parseReleaseManifest(good, TAG)).toBe(false);
    expect(parseReleaseManifest(good, 'v2.0.2')).toEqual({ problem: 'it is for v2.0.1, not v2.0.2' });
    expect(parseReleaseManifest(good.slice(0, 50), TAG)).toEqual({ problem: 'it is not JSON' });
    expect(parseReleaseManifest(JSON.stringify({ ...JSON.parse(good), schema: 2 }), TAG)).toHaveProperty('problem');
  });

  it('fetches once, keeps it in the data directory, and reads the kept copy offline', async () => {
    const dataDir = temp('hb-mf-data-');
    const s = served(200, good);
    const first = await releaseManifest({ version: '2.0.1', dataDir, base: 'https://example.org/dl', fetchText: s.fetchText });
    expect(first.kind).toBe('manifest');
    expect(s.urls).toEqual(['https://example.org/dl/v2.0.1/release-manifest.json']);
    expect(read(join(dataDir, 'release-manifests', 'v2.0.1.json'))).toBe(good);
    const offline = await releaseManifest({ version: '2.0.1', dataDir, fetchText: async () => { throw new Error('offline'); } });
    expect(offline.kind).toBe('manifest');
  });

  it('a 404 is a release made before manifests; anything else wrong is an error, never "none"', async () => {
    const dataDir = temp('hb-mf-data-');
    expect(await releaseManifest({ version: '2.0.1', dataDir, fetchText: served(404).fetchText })).toEqual({ kind: 'none' });
    expect((await releaseManifest({ version: '2.0.1', dataDir, fetchText: served(500).fetchText })).kind).toBe('error');
    expect((await releaseManifest({ version: '2.0.1', dataDir, fetchText: async () => { throw new Error('offline'); } })).kind).toBe('error');
    const garbled = await releaseManifest({ version: '2.0.1', dataDir, fetchText: served(200, '<html></html>').fetchText });
    expect(garbled.kind).toBe('error');
    const other = await releaseManifest({ version: '2.0.2', dataDir, fetchText: served(200, good).fetchText });
    expect(other).toMatchObject({ kind: 'error', problem: expect.stringContaining('it is for v2.0.1, not v2.0.2') });
    expect(existsSync(join(dataDir, 'release-manifests', 'v2.0.2.json'))).toBe(false);
  });

  it('the image: by digest from the manifest; another OpenClaw is not published; legacy by tag', async () => {
    const opts = (status: number, text = '') => ({ version: '2.0.1', dataDir: temp('hb-mf-data-'), registry: undefined, fetchText: served(status, text).fetchText });
    expect(await publishedRuntimeImage(OPENCLAW, opts(200, good))).toEqual({ ref: `ghcr.io/hatchabot/runtime@${INDEX}`, openclawVersion: OPENCLAW, pinned: true });
    expect(await publishedRuntimeImage('1999.1.1', opts(200, good))).toHaveProperty('problem');
    expect(await publishedRuntimeImage(OPENCLAW, { ...opts(200, good), registry: 'mirror.example.org/runtime' })).toMatchObject({ ref: `mirror.example.org/runtime@${INDEX}` });
    expect(await publishedRuntimeImage(OPENCLAW, opts(404))).toEqual({ ref: `ghcr.io/hatchabot/runtime:${OPENCLAW}`, openclawVersion: OPENCLAW, pinned: false });
    expect(await publishedRuntimeImage(OPENCLAW, opts(503))).toHaveProperty('problem');
  });
});

describe('LocalDockerProvider.ensureBaseImage pulls the release\'s image by digest (#47)', () => {
  const world = (label: string) => {
    const dir = temp('hb-mf-provider-');
    const log = join(dir, 'calls.log');
    const docker = join(dir, 'docker');
    writeFileSync(docker, `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(log)}\ncase "$1 $2" in "image inspect") case "$*" in *Labels*) echo ${JSON.stringify(label)} ;; *) exit 1 ;; esac ;; esac\nexit 0\n`, { mode: 0o755 });
    return { log, docker };
  };
  const pinned = async () => ({ ref: `registry.example.org/runtime@${INDEX}`, openclawVersion: '2026.9.6', pinned: true });

  it('by digest, label agreeing: tagged under the name asked for', async () => {
    const w = world('2026.9.6');
    const p = new LocalDockerProvider({ docker: w.docker, image: 'test-image:latest', publishedImage: pinned });
    expect(await p.ensureBaseImage('hatchabot-runtime:2026.9.6')).toBe(true);
    expect(read(w.log)).toContain(`pull --quiet registry.example.org/runtime@${INDEX}`);
    expect(read(w.log)).toContain(`tag registry.example.org/runtime@${INDEX} hatchabot-runtime:2026.9.6`);
  });

  it('by digest, label disagreeing: refused, nothing tagged', async () => {
    const w = world('1999.1.1');
    const p = new LocalDockerProvider({ docker: w.docker, image: 'test-image:latest', publishedImage: pinned });
    expect(await p.ensureBaseImage('hatchabot-runtime:2026.9.6')).toBe(false);
    expect(read(w.log)).not.toMatch(/^tag /m);
  });

  it('no image the release vouches for: nothing is pulled', async () => {
    const w = world('2026.9.6');
    const p = new LocalDockerProvider({ docker: w.docker, image: 'test-image:latest', publishedImage: async () => ({ problem: 'Release v2.0.1 publishes the runtime image for OpenClaw 2026.9.8 only, not 2026.9.6.' }) });
    expect(await p.ensureBaseImage('hatchabot-runtime:2026.9.6')).toBe(false);
    expect(read(w.log)).not.toMatch(/^pull /m);
  });

  it('legacy (a release made before manifests): by tag, as before', async () => {
    const w = world('');
    const p = new LocalDockerProvider({ docker: w.docker, image: 'test-image:latest', publishedImage: async (v) => ({ ref: `registry.example.org/runtime:${v}`, openclawVersion: v, pinned: false }) });
    expect(await p.ensureBaseImage('hatchabot-runtime:2026.9.6')).toBe(true);
    expect(read(w.log)).toContain('tag registry.example.org/runtime:2026.9.6 hatchabot-runtime:2026.9.6');
  });
});

describe('installRuntimeImage on a runner of another CPU, with the release manifest (#47)', () => {
  const stub = (dir: string, label: string) => {
    const bin = join(dir, 'docker');
    writeFileSync(bin, `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(join(dir, 'calls'))}
if [ "$1" = info ]; then echo aarch64; exit 0; fi
if [ "$1" = -H ] && [ "$3" = info ]; then echo x86_64; exit 0; fi
if [ "$3" = image ] && [ "$4" = inspect ]; then echo ${JSON.stringify(label)}; exit 0; fi
exit 0
`, { mode: 0o755 });
    return bin;
  };
  const ref = `registry.example.org/runtime@${INDEX}`;

  it('pulls the digest there and tags it', async () => {
    const dir = temp('hb-mf-runner-');
    const res = await installRuntimeImage('ssh://r@x', { docker: stub(dir, '2026.9.6'), published: { ref, openclawVersion: '2026.9.6' } });
    expect(res).toEqual({ ok: true, pulled: ref });
    expect(read(join(dir, 'calls'))).toContain(`tag ${ref} hatchabot-runtime:latest`);
  });

  it('refuses the digest when its label disagrees', async () => {
    const dir = temp('hb-mf-runner-');
    const res = await installRuntimeImage('ssh://r@x', { docker: stub(dir, '1999.1.1'), published: { ref, openclawVersion: '2026.9.6' } });
    expect(res.ok).toBe(false);
    expect(read(join(dir, 'calls'))).not.toMatch(/ tag /);
  });

  it('says why there is no published image to pull', async () => {
    const dir = temp('hb-mf-runner-');
    const res = await installRuntimeImage('ssh://r@x', { docker: stub(dir, '2026.9.6'), unpublished: 'Release v2.0.1 publishes the runtime image for OpenClaw 2026.9.8 only, not 2026.9.6.' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('(Release v2.0.1 publishes the runtime image for OpenClaw 2026.9.8 only, not 2026.9.6).');
  });
});
