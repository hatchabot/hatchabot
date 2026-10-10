#!/usr/bin/env node
/**
 * release-manifest.json: what a release is, attached to it (release by
 * workflow, docs/release-by-workflow-design.md; issues #37, #38, #47,
 * 2026-10-10). The release workflow builds it from the artifacts it is about
 * to publish, attests it, and checks the release's asset list against it;
 * installs and upgrades read it to check a bundle's sha256 and to pull the
 * runtime image by its digest.
 *
 *   {"schema":1,"version":"X.Y.Z","tag":"vX.Y.Z","commit":"<40 hex>","createdAt":"<ISO>",
 *    "assets":[{"name","size","sha256"}…],          every bundle and its .sha256 file
 *    "image":{"repository":"ghcr.io/<owner>/runtime","tag":"vX.Y.Z","index":"sha256:…",
 *             "platforms":{"linux/amd64":"sha256:…","linux/arm64":"sha256:…"},"openclaw":"<version>"},
 *    "inputs":{"openclaw":"<version>","nodeImage":"<ref@sha256:…>"}}
 *
 *   node scripts/release-manifest.mjs build --version X.Y.Z --commit <sha> --assets <dir> \
 *        --image <runtime-image.json> --repository ghcr.io/<owner>/runtime \
 *        --dockerfile <docker/Dockerfile.runtime at that commit> --out <file>
 *   node scripts/release-manifest.mjs check <release-manifest.json> --assets <dir>
 *
 * `build` refuses a set that is not whole: a platform's bundle or its .sha256
 * missing, a file it does not expect, a .sha256 that does not name its bundle
 * or does not match it. `check` compares a directory with a manifest (missing,
 * extra, size or sha256 different). Exit 0 ok, 1 refused, 2 usage.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA = 1;
export const MANIFEST_NAME = 'release-manifest.json';
/** The bundles every release carries (scripts/build-bundle.sh, .github/workflows/bundles.yml). */
export const PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-arm64'];
export const IMAGE_PLATFORMS = ['linux/amd64', 'linux/arm64'];
export const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The asset names a release of `version` must carry, sorted. */
export function expectedAssets(version) {
  return PLATFORMS.flatMap((p) => [`hatchabot-v${version}-${p}.tar.gz`, `hatchabot-v${version}-${p}.tar.gz.sha256`]).sort();
}

export const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * The assets in `dir` as manifest entries, sorted by name; throws when the
 * set is not exactly `expectedAssets(version)` or a .sha256 file does not
 * vouch for its bundle.
 */
export function collectAssets(dir, version) {
  const want = expectedAssets(version);
  const have = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile() && f !== MANIFEST_NAME).sort();
  const missing = want.filter((f) => !have.includes(f));
  const extra = have.filter((f) => !want.includes(f));
  if (missing.length || extra.length) {
    throw new Error([missing.length && `missing: ${missing.join(', ')}`, extra.length && `not expected: ${extra.join(', ')}`].filter(Boolean).join('; '));
  }
  const assets = want.map((name) => ({ name, size: statSync(join(dir, name)).size, sha256: sha256File(join(dir, name)) }));
  for (const a of assets.filter((x) => x.name.endsWith('.sha256'))) {
    const bundle = a.name.slice(0, -'.sha256'.length);
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(readFileSync(join(dir, a.name), 'utf8'));
    if (!m || m[2] !== bundle) throw new Error(`${a.name} does not name ${bundle}`);
    if (m[1] !== assets.find((x) => x.name === bundle).sha256) throw new Error(`${a.name} does not match ${bundle}`);
  }
  return assets;
}

/** Installs read at most this many bytes of the manifest (the install side, 2026-10-10). */
export const MAX_BYTES = 65536;

/**
 * The OpenClaw version a release's image must carry: the `ARG
 * OPENCLAW_VERSION` default of docker/Dockerfile.runtime at the released
 * commit (a release image is built with no other). Installs compare the
 * pulled image's org.agentclaw.openclaw-version label with image.openclaw.
 */
export function openclawFromDockerfile(text) {
  const v = /^ARG OPENCLAW_VERSION=(\S+)\s*$/m.exec(String(text))?.[1];
  if (!v) throw new Error('the Dockerfile has no ARG OPENCLAW_VERSION default');
  return v;
}

/** The manifest, from its parts; throws when the result is not valid. */
export function buildManifest({ version, commit, createdAt = new Date().toISOString(), assets, image, repository, dockerfileOpenclaw }) {
  if (dockerfileOpenclaw !== undefined && image.openclaw !== dockerfileOpenclaw) {
    throw new Error(`the image carries OpenClaw ${image.openclaw}, but the Dockerfile at the released commit says ${dockerfileOpenclaw}`);
  }
  const m = {
    schema: SCHEMA,
    version,
    tag: `v${version}`,
    commit,
    createdAt,
    assets,
    image: { repository, tag: `v${version}`, index: image.index, platforms: image.platforms, openclaw: image.openclaw },
    inputs: { openclaw: image.openclaw, nodeImage: image.nodeImage },
  };
  const bad = validateManifest(m);
  if (bad.length) throw new Error(bad.join('; '));
  return m;
}

/** What is wrong with a manifest ([] when nothing). */
export function validateManifest(m) {
  const bad = [];
  if (!m || typeof m !== 'object') return ['not an object'];
  if (m.schema !== SCHEMA) bad.push(`schema is ${m.schema}, not ${SCHEMA}`);
  if (typeof m.version !== 'string' || !VERSION.test(m.version)) bad.push('version is not X.Y.Z');
  if (m.tag !== `v${m.version}`) bad.push('tag is not v<version>');
  if (typeof m.commit !== 'string' || !/^[0-9a-f]{40}$/.test(m.commit)) bad.push('commit is not a 40-character sha');
  if (typeof m.createdAt !== 'string' || Number.isNaN(Date.parse(m.createdAt)) || !/^\d{4}-\d\d-\d\dT/.test(m.createdAt)) bad.push('createdAt is not an ISO time');
  if (!Array.isArray(m.assets)) bad.push('assets is not a list');
  else {
    const names = m.assets.map((a) => a?.name);
    for (const a of m.assets) {
      if (typeof a?.name !== 'string' || !/^[\w.+-]+$/.test(a.name)) bad.push(`asset name ${JSON.stringify(a?.name)} is not a plain file name`);
      if (!Number.isInteger(a?.size) || a.size < 0) bad.push(`${a?.name}: size is not a byte count`);
      if (typeof a?.sha256 !== 'string' || !HEX64.test(a.sha256)) bad.push(`${a?.name}: sha256 is not 64 hex characters`);
    }
    if (new Set(names).size !== names.length) bad.push('an asset is listed twice');
    if (typeof m.version === 'string') {
      const want = expectedAssets(m.version);
      const missing = want.filter((n) => !names.includes(n));
      const extra = names.filter((n) => !want.includes(n));
      if (missing.length) bad.push(`assets missing: ${missing.join(', ')}`);
      if (extra.length) bad.push(`assets not expected: ${extra.join(', ')}`);
    }
  }
  const i = m.image;
  if (!i || typeof i !== 'object') bad.push('no image');
  else {
    if (typeof i.repository !== 'string' || !/^ghcr\.io\/[a-z0-9][a-z0-9-]*\/runtime$/.test(i.repository)) bad.push('image.repository is not ghcr.io/<owner>/runtime');
    if (i.tag !== m.tag) bad.push('image.tag is not the release tag');
    if (typeof i.index !== 'string' || !DIGEST.test(i.index)) bad.push('image.index is not a sha256 digest');
    const ps = i.platforms && typeof i.platforms === 'object' ? i.platforms : {};
    for (const p of IMAGE_PLATFORMS) if (typeof ps[p] !== 'string' || !DIGEST.test(ps[p])) bad.push(`image.platforms["${p}"] is not a sha256 digest`);
    for (const p of Object.keys(ps)) if (!IMAGE_PLATFORMS.includes(p)) bad.push(`image.platforms has ${p}, which is not built`);
    if (typeof i.openclaw !== 'string' || !/^\d{4}\.\d+\.\d+(-[\w.]+)?$/.test(i.openclaw)) bad.push('image.openclaw is not an OpenClaw version');
  }
  const inp = m.inputs;
  if (!inp || typeof inp !== 'object') bad.push('no inputs');
  else {
    if (inp.openclaw !== i?.openclaw) bad.push('inputs.openclaw is not image.openclaw');
    if (typeof inp.nodeImage !== 'string' || !/^[\w./:-]+@sha256:[0-9a-f]{64}$/.test(inp.nodeImage)) bad.push('inputs.nodeImage is not pinned to a digest');
  }
  const bytes = Buffer.byteLength(JSON.stringify(m, null, 2) + '\n');
  if (bytes >= MAX_BYTES) bad.push(`the manifest is ${bytes} bytes; installs read at most ${MAX_BYTES}`);
  return bad;
}

/** Where `dir` differs from the manifest's assets ([] when it holds exactly them). */
export function checkAssets(m, dir) {
  const bad = [];
  const have = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile() && f !== MANIFEST_NAME);
  for (const a of m.assets ?? []) {
    if (!have.includes(a.name)) { bad.push(`${a.name}: missing`); continue; }
    const size = statSync(join(dir, a.name)).size;
    if (size !== a.size) bad.push(`${a.name}: ${size} bytes, the manifest says ${a.size}`);
    else if (sha256File(join(dir, a.name)) !== a.sha256) bad.push(`${a.name}: sha256 differs from the manifest`);
  }
  for (const f of have) if (!(m.assets ?? []).some((a) => a.name === f)) bad.push(`${f}: not in the manifest`);
  return bad;
}

function main(args) {
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const [cmd] = args;
  if (cmd === 'build') {
    const version = opt('--version')?.replace(/^v/, ''), commit = opt('--commit'), assetsDir = opt('--assets');
    const imageFile = opt('--image'), repository = opt('--repository'), out = opt('--out'), dockerfile = opt('--dockerfile');
    if (!version || !commit || !assetsDir || !imageFile || !repository || !out || !dockerfile) return usage();
    const image = JSON.parse(readFileSync(imageFile, 'utf8'));
    const m = buildManifest({
      version, commit, assets: collectAssets(assetsDir, version), image, repository, createdAt: opt('--created-at'),
      dockerfileOpenclaw: openclawFromDockerfile(readFileSync(dockerfile, 'utf8')),
    });
    writeFileSync(out, JSON.stringify(m, null, 2) + '\n');
    console.log(`✓ ${MANIFEST_NAME} for v${version} at ${commit.slice(0, 9)}: ${m.assets.length} assets, image ${m.image.index.slice(0, 19)}…`);
    return 0;
  }
  if (cmd === 'check') {
    const file = args[1], assetsDir = opt('--assets');
    if (!file || !assetsDir) return usage();
    const m = JSON.parse(readFileSync(file, 'utf8'));
    const bad = [...validateManifest(m), ...checkAssets(m, assetsDir)];
    for (const b of bad) console.error(`✗ ${b}`);
    if (bad.length) return 1;
    console.log(`✓ ${assetsDir} holds exactly the ${m.assets.length} assets of v${m.version}`);
    return 0;
  }
  return usage();
}
function usage() {
  console.error('usage: release-manifest.mjs build --version X.Y.Z --commit <sha> --assets <dir> --image <runtime-image.json> --repository ghcr.io/<owner>/runtime --dockerfile <Dockerfile.runtime at the commit> --out <file> [--created-at <ISO>]\n       release-manifest.mjs check <release-manifest.json> --assets <dir>');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`✗ ${e.message}`); process.exitCode = 1; }
}
