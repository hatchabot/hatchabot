import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// @ts-expect-error — a plain .mjs script, no types
import { MAX_BYTES, buildManifest, checkAssets, collectAssets, expectedAssets, openclawFromDockerfile, validateManifest } from '../scripts/release-manifest.mjs';
// @ts-expect-error — a plain .mjs script, no types
import { describeLayout, mergeDescriptions, readArchive } from '../scripts/oci-index.mjs';

/**
 * release-manifest.json, the contract the release workflow publishes and
 * installs read (release by workflow, issues #37, #38, #47, 2026-10-10), and
 * the image index it names (scripts/oci-index.mjs). Made-up bundles and a
 * made-up OCI layout in a temp dir; nothing is built or pushed.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'hb-manifest-')); dirs.push(d); return d; };
const hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const VERSION = '9.8.7';
const DOCKERFILE = join(__dirname, '..', 'docker', 'Dockerfile.runtime');
/** The OpenClaw the real Dockerfile builds by default: a release image's, and the manifest's image.openclaw. */
const DOCKER_OPENCLAW = /^ARG OPENCLAW_VERSION=(\S+)$/m.exec(readFileSync(DOCKERFILE, 'utf8'))![1]!;
const COMMIT = 'c'.repeat(40);
const IMAGE = {
  index: `sha256:${'1'.repeat(64)}`,
  platforms: { 'linux/amd64': `sha256:${'2'.repeat(64)}`, 'linux/arm64': `sha256:${'3'.repeat(64)}` },
  openclaw: DOCKER_OPENCLAW,
  nodeImage: `node:24-slim@sha256:${'4'.repeat(64)}`,
};
const REPOSITORY = 'ghcr.io/example-owner/runtime';
const SCRIPT = join(__dirname, '..', 'scripts', 'release-manifest.mjs');

/** A directory with every bundle of VERSION (made-up bytes) and a .sha256 for each. */
function bundles() {
  const dir = tmp();
  for (const name of expectedAssets(VERSION).filter((n: string) => n.endsWith('.tar.gz'))) {
    const body = `made-up bundle ${name}\n`;
    writeFileSync(join(dir, name), body);
    writeFileSync(join(dir, `${name}.sha256`), `${hex(body)}  ${name}\n`);
  }
  return dir;
}

describe('release-manifest.mjs', () => {
  it('builds the shared format: every bundle and its .sha256 hashed, the image, the inputs', () => {
    const dir = bundles();
    const m = buildManifest({ version: VERSION, commit: COMMIT, createdAt: '2026-10-10T12:00:00.000Z', assets: collectAssets(dir, VERSION), image: IMAGE, repository: REPOSITORY });
    expect(Object.keys(m)).toEqual(['schema', 'version', 'tag', 'commit', 'createdAt', 'assets', 'image', 'inputs']);
    expect(m).toMatchObject({ schema: 1, version: VERSION, tag: 'v9.8.7', commit: COMMIT });
    expect(m.assets.map((a: { name: string }) => a.name)).toEqual([
      'hatchabot-v9.8.7-darwin-arm64.tar.gz', 'hatchabot-v9.8.7-darwin-arm64.tar.gz.sha256',
      'hatchabot-v9.8.7-linux-arm64.tar.gz', 'hatchabot-v9.8.7-linux-arm64.tar.gz.sha256',
      'hatchabot-v9.8.7-linux-x64.tar.gz', 'hatchabot-v9.8.7-linux-x64.tar.gz.sha256',
    ]);
    for (const a of m.assets) {
      const bytes = readFileSync(join(dir, a.name));
      expect(a).toEqual({ name: a.name, size: bytes.length, sha256: hex(bytes) });
    }
    expect(m.image).toEqual({ repository: REPOSITORY, tag: 'v9.8.7', index: IMAGE.index, platforms: IMAGE.platforms, openclaw: DOCKER_OPENCLAW });
    expect(m.inputs).toEqual({ openclaw: DOCKER_OPENCLAW, nodeImage: IMAGE.nodeImage });
    expect(validateManifest(m)).toEqual([]);
    expect(checkAssets(m, dir)).toEqual([]);
  });

  it('refuses a set that is not whole: a missing bundle, a stray file, a .sha256 that does not vouch for its bundle', () => {
    const missing = bundles();
    rmSync(join(missing, 'hatchabot-v9.8.7-linux-arm64.tar.gz'));
    expect(() => collectAssets(missing, VERSION)).toThrow(/missing: hatchabot-v9\.8\.7-linux-arm64\.tar\.gz$/);
    const stray = bundles();
    writeFileSync(join(stray, 'notes.txt'), 'x');
    expect(() => collectAssets(stray, VERSION)).toThrow(/not expected: notes\.txt/);
    const wrong = bundles();
    appendFileSync(join(wrong, 'hatchabot-v9.8.7-linux-x64.tar.gz'), 'changed after its checksum\n');
    expect(() => collectAssets(wrong, VERSION)).toThrow(/linux-x64\.tar\.gz\.sha256 does not match/);
    const other = bundles();
    writeFileSync(join(other, 'hatchabot-v9.8.7-linux-x64.tar.gz.sha256'), `${'0'.repeat(64)}  hatchabot-v9.8.7-darwin-arm64.tar.gz\n`);
    expect(() => collectAssets(other, VERSION)).toThrow(/does not name hatchabot-v9\.8\.7-linux-x64\.tar\.gz/);
  });

  it('checkAssets finds what differs from the manifest: a missing file, a changed one, an extra one', () => {
    const dir = bundles();
    const m = buildManifest({ version: VERSION, commit: COMMIT, assets: collectAssets(dir, VERSION), image: IMAGE, repository: REPOSITORY });
    rmSync(join(dir, 'hatchabot-v9.8.7-darwin-arm64.tar.gz.sha256'));
    writeFileSync(join(dir, 'hatchabot-v9.8.7-linux-x64.tar.gz'), 'other bytes of the same?'.padEnd(m.assets.find((a: { name: string }) => a.name === 'hatchabot-v9.8.7-linux-x64.tar.gz').size, '.'));
    appendFileSync(join(dir, 'hatchabot-v9.8.7-linux-arm64.tar.gz'), 'longer');
    writeFileSync(join(dir, 'extra.tar.gz'), 'x');
    const arm = m.assets.find((a: { name: string }) => a.name === 'hatchabot-v9.8.7-linux-arm64.tar.gz').size;
    expect(checkAssets(m, dir)).toEqual([
      'hatchabot-v9.8.7-darwin-arm64.tar.gz.sha256: missing',
      `hatchabot-v9.8.7-linux-arm64.tar.gz: ${arm + 6} bytes, the manifest says ${arm}`,
      'hatchabot-v9.8.7-linux-x64.tar.gz: sha256 differs from the manifest',
      'extra.tar.gz: not in the manifest',
    ]);
  });

  it('validateManifest names each schema problem', () => {
    const dir = bundles();
    const good = buildManifest({ version: VERSION, commit: COMMIT, assets: collectAssets(dir, VERSION), image: IMAGE, repository: REPOSITORY });
    const bad = JSON.parse(JSON.stringify(good));
    bad.schema = 2; bad.tag = 'v9.8.6'; bad.commit = 'abc'; bad.createdAt = 'yesterday';
    bad.assets[0].sha256 = 'short'; bad.assets.pop();
    bad.image.index = 'sha256:nope'; delete bad.image.platforms['linux/arm64']; bad.image.repository = 'docker.io/someone/else';
    bad.inputs.nodeImage = 'node:24-slim';
    const problems = validateManifest(bad).join('\n');
    for (const p of [/schema is 2/, /tag is not v<version>/, /commit is not a 40-character sha/, /createdAt is not an ISO time/,
      /sha256 is not 64 hex/, /assets missing: hatchabot-v9\.8\.7-linux-x64\.tar\.gz\.sha256/, /image\.index is not a sha256 digest/,
      /image\.platforms\["linux\/arm64"\]/, /image\.repository is not ghcr\.io/, /image\.tag is not the release tag/, /nodeImage is not pinned/]) {
      expect(problems).toMatch(p);
    }
    expect(() => buildManifest({ version: VERSION, commit: 'abc', assets: good.assets, image: IMAGE, repository: REPOSITORY })).toThrow(/commit/);
  });

  it('image.openclaw comes from the Dockerfile ARG at the released commit: a different one is refused', () => {
    expect(openclawFromDockerfile(readFileSync(DOCKERFILE, 'utf8'))).toBe(DOCKER_OPENCLAW);
    expect(openclawFromDockerfile('FROM x\nARG OPENCLAW_VERSION=2026.1.2\n')).toBe('2026.1.2');
    expect(() => openclawFromDockerfile('FROM x\n')).toThrow(/no ARG OPENCLAW_VERSION/);
    const dir = bundles();
    const assets = collectAssets(dir, VERSION);
    const m = buildManifest({ version: VERSION, commit: COMMIT, assets, image: IMAGE, repository: REPOSITORY, dockerfileOpenclaw: DOCKER_OPENCLAW });
    expect(m.image.openclaw).toBe(DOCKER_OPENCLAW);
    expect(m.inputs.openclaw).toBe(DOCKER_OPENCLAW);
    expect(() => buildManifest({ version: VERSION, commit: COMMIT, assets, image: { ...IMAGE, openclaw: '2026.1.2' }, repository: REPOSITORY, dockerfileOpenclaw: DOCKER_OPENCLAW }))
      .toThrow(`the image carries OpenClaw 2026.1.2, but the Dockerfile at the released commit says ${DOCKER_OPENCLAW}`);
  });

  it('stays under what installs read (64 KB): a larger manifest is refused', () => {
    const dir = bundles();
    const m = buildManifest({ version: VERSION, commit: COMMIT, assets: collectAssets(dir, VERSION), image: IMAGE, repository: REPOSITORY });
    expect(Buffer.byteLength(JSON.stringify(m, null, 2))).toBeLessThan(MAX_BYTES);
    expect(MAX_BYTES).toBe(65536);
    const big = { ...m, inputs: { ...m.inputs, nodeImage: `node:${'x'.repeat(70000)}@sha256:${'4'.repeat(64)}` } };
    expect(validateManifest(big).join('\n')).toMatch(/installs read at most 65536/);
  });

  it('the command line: build writes the file, check passes it and refuses a changed asset', () => {
    const dir = bundles();
    const img = join(tmp(), 'runtime-image.json');
    writeFileSync(img, JSON.stringify(IMAGE));
    const out = join(tmp(), 'release-manifest.json');
    const run = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tmp() } });
    const b = run('build', '--version', VERSION, '--commit', COMMIT, '--assets', dir, '--image', img, '--repository', REPOSITORY, '--dockerfile', DOCKERFILE, '--out', out);
    expect(b.status, b.stderr).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).assets).toHaveLength(6);
    const ok = run('check', out, '--assets', dir);
    expect(ok.status, ok.stderr).toBe(0);
    appendFileSync(join(dir, 'hatchabot-v9.8.7-darwin-arm64.tar.gz'), '!');
    const changed = run('check', out, '--assets', dir);
    expect(changed.status).toBe(1);
    const size = JSON.parse(readFileSync(out, 'utf8')).assets[0].size;
    expect(changed.stderr).toContain(`hatchabot-v9.8.7-darwin-arm64.tar.gz: ${size + 1} bytes, the manifest says ${size}`);
    expect(run('build', '--version', VERSION).status).toBe(2);
  });
});

/** A made-up OCI layout as buildkit writes one arch with its attestation. */
function layout(arch: string, opts: { top?: 'index' | 'manifest'; os?: string } = {}) {
  const blobs = new Map<string, Buffer>();
  const put = (o: object) => { const b = Buffer.from(JSON.stringify(o)); const d = `sha256:${hex(b)}`; blobs.set(d, b); return { digest: d, size: b.length }; };
  const config = put({ architecture: arch, os: opts.os ?? 'linux', config: { Labels: { 'org.hatchabot.release': VERSION, 'org.agentclaw.openclaw-version': DOCKER_OPENCLAW } } });
  const image = put({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { mediaType: 'application/vnd.oci.image.config.v1+json', ...config }, layers: [] });
  const imageDesc = { mediaType: 'application/vnd.oci.image.manifest.v1+json', ...image, platform: { architecture: arch, os: opts.os ?? 'linux' } };
  if (opts.top === 'manifest') {
    const top = { mediaType: 'application/vnd.oci.image.manifest.v1+json', ...image, annotations: { 'org.opencontainers.image.ref.name': 'latest' } };
    return { index: { schemaVersion: 2, manifests: [top] }, blob: (d: string) => blobs.get(d)!, blobs, top: top.digest, imageDigest: image.digest };
  }
  const att = put({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { mediaType: 'application/vnd.oci.image.config.v1+json', ...put({}) }, layers: [] });
  const attDesc = { mediaType: 'application/vnd.oci.image.manifest.v1+json', ...att, platform: { architecture: 'unknown', os: 'unknown' }, annotations: { 'vnd.docker.reference.digest': image.digest, 'vnd.docker.reference.type': 'attestation-manifest' } };
  const perArch = put({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [imageDesc, attDesc] });
  const top = { mediaType: 'application/vnd.oci.image.index.v1+json', ...perArch };
  return { index: { schemaVersion: 2, manifests: [top] }, blob: (d: string) => blobs.get(d)!, blobs, top: top.digest, imageDigest: image.digest };
}

describe('oci-index.mjs: the image index, made before anything is pushed', () => {
  it('merges each arch into one index whose bytes give the digest, with each platform\'s image digest', () => {
    const amd = layout('amd64'), arm = layout('arm64');
    const a = describeLayout(amd, 'amd64', amd.top), b = describeLayout(arm, 'arm64', arm.top);
    expect(a.children).toHaveLength(2);
    const m = mergeDescriptions([b, a]);
    expect(m.index).toBe(`sha256:${hex(m.bytes)}`);
    expect(m.platforms).toEqual({ 'linux/amd64': amd.imageDigest, 'linux/arm64': arm.imageDigest });
    const idx = JSON.parse(m.bytes.toString());
    expect(idx.mediaType).toBe('application/vnd.oci.image.index.v1+json');
    expect(idx.manifests.map((d: { platform: { architecture: string } }) => d.platform.architecture)).toEqual(['amd64', 'unknown', 'arm64', 'unknown']);
    expect(a).toMatchObject({ openclaw: DOCKER_OPENCLAW, release: VERSION });
    expect(mergeDescriptions([a, b], { openclaw: DOCKER_OPENCLAW, release: VERSION }).index).toBe(m.index);
    expect(() => mergeDescriptions([a, b], { openclaw: '2026.1.2' })).toThrow(/amd64: the image is labelled OpenClaw .* not 2026\.1\.2/);
    expect(() => mergeDescriptions([a, b], { openclaw: DOCKER_OPENCLAW, release: '9.8.8' })).toThrow(/labelled release 9\.8\.7, not 9\.8\.8/);
    // The same descriptions always make the same bytes, whatever order they come in.
    expect(mergeDescriptions([a, b]).index).toBe(m.index);
  });

  it('a single-manifest archive takes its platform from the image config', () => {
    const amd = layout('amd64', { top: 'manifest' });
    const d = describeLayout(amd, 'amd64', amd.top);
    expect(d.children).toEqual([{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: amd.imageDigest, size: expect.any(Number), platform: { architecture: 'amd64', os: 'linux' } }]);
  });

  it('refuses: a digest the build did not report, the wrong arch, a missing arch, a blob that does not match', () => {
    const amd = layout('amd64');
    expect(() => describeLayout(amd, 'amd64', `sha256:${'9'.repeat(64)}`)).toThrow(/the build reported/);
    expect(() => describeLayout(amd, 'arm64', amd.top)).toThrow(/arm64: the image is for linux\/amd64/);
    expect(() => describeLayout(layout('amd64', { os: 'windows' }), 'amd64', layout('amd64', { os: 'windows' }).top)).toThrow(/windows/);
    expect(() => mergeDescriptions([describeLayout(amd, 'amd64', amd.top)])).toThrow(/no image for arm64/);
    const tampered = layout('amd64');
    tampered.blobs.set(tampered.imageDigest, Buffer.from('{"changed":true}'));
    expect(() => describeLayout(tampered, 'amd64', tampered.top)).toThrow(/does not match its digest/);
  });

  it('reads an OCI archive (tar) and describes it from the command line; merge writes the index and runtime-image.json', () => {
    const work = tmp();
    const descs: string[] = [];
    for (const arch of ['amd64', 'arm64']) {
      const l = layout(arch);
      const root = join(work, arch);
      mkdirSync(join(root, 'blobs', 'sha256'), { recursive: true });
      for (const [d, b] of l.blobs) writeFileSync(join(root, 'blobs', 'sha256', d.slice(7)), b);
      writeFileSync(join(root, 'index.json'), JSON.stringify(l.index));
      writeFileSync(join(root, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}');
      const tar = join(work, `runtime-${arch}.tar`);
      expect(spawnSync('tar', ['-cf', tar, '-C', root, '.']).status).toBe(0);
      expect(readArchive(tar).index).toEqual(l.index);
      const r = spawnSync(process.execPath, [join(__dirname, '..', 'scripts', 'oci-index.mjs'), 'describe', tar, arch, l.top], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      const f = join(work, `runtime-${arch}.desc.json`);
      writeFileSync(f, r.stdout);
      descs.push(f);
    }
    const out = join(work, 'index');
    const m = spawnSync(process.execPath, [join(__dirname, '..', 'scripts', 'oci-index.mjs'), 'merge', ...descs, '--openclaw', DOCKER_OPENCLAW, '--release', VERSION, '--node-image', IMAGE.nodeImage, '--out', out], { encoding: 'utf8' });
    expect(m.status, m.stderr).toBe(0);
    const info = JSON.parse(readFileSync(join(out, 'runtime-image.json'), 'utf8'));
    expect(info.index).toBe(`sha256:${hex(readFileSync(join(out, 'runtime-index.json')))}`);
    expect(Object.keys(info.platforms)).toEqual(['linux/amd64', 'linux/arm64']);
    expect(info).toMatchObject({ openclaw: DOCKER_OPENCLAW, nodeImage: IMAGE.nodeImage });
    // …and it is what release-manifest.mjs takes as the image.
    const dir = bundles();
    expect(validateManifest(buildManifest({ version: VERSION, commit: COMMIT, assets: collectAssets(dir, VERSION), image: info, repository: REPOSITORY }))).toEqual([]);
    expect(dirname(out)).toBe(work);
  });
});
