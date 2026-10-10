#!/usr/bin/env node
/**
 * The runtime image's multi-arch index, made before anything is pushed
 * (release by workflow, docs/release-by-workflow-design.md, 2026-10-10).
 *
 * Each arch is built on its own runner into an OCI archive. The release
 * manifest records the image's index digest, so the index has to exist — as
 * exact bytes — while the build is still read-only: `docker buildx imagetools
 * create` only makes one on the registry, at publish time. This writes it
 * here instead, from what each archive holds; the publish job pushes these
 * bytes as they are (skopeo --preserve-digests), so the digest in the
 * manifest is the digest on the registry.
 *
 *   node scripts/oci-index.mjs describe <runtime-ARCH.tar> <arch> <digest the build reported>   > desc.json
 *   node scripts/oci-index.mjs merge <desc.json>... --openclaw <version> [--release X.Y.Z] --node-image <ref@sha256:…> --out <dir>
 *       # refuses an arch whose labels (org.agentclaw.openclaw-version, org.hatchabot.release) say otherwise
 *       # <dir>/runtime-index.json (the index's bytes) and <dir>/runtime-image.json
 *       # ({ index, platforms, openclaw, nodeImage } — what release-manifest.mjs reads)
 *
 * `describe` runs in each build job (it reads only the archive's small
 * members: index.json and the manifests and configs, never the layers);
 * `merge` in a later read-only job, from the small descriptions only.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INDEX_TYPES = new Set(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']);
export const MANIFEST_TYPES = new Set(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']);
export const ARCHES = ['amd64', 'arm64'];
const DIGEST = /^sha256:[0-9a-f]{64}$/;
/** Members bigger than this are layers: never read. */
const SMALL = 4 << 20;

export const sha256 = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;

/** An attestation manifest buildkit adds beside an image (platform unknown/unknown). */
const isAttestation = (d) => d.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest';

/**
 * One arch's descriptors, from a reader of its layout's blobs: `blob(digest)`
 * returns the bytes (checked here against the digest) and `index` is the
 * layout's index.json. Returns { arch, top, children }: `top` the archive's
 * one entry (what the build reported), `children` the descriptors the merged
 * index lists for this arch — the image manifest with its platform, and any
 * attestation manifest beside it.
 */
export function describeLayout({ index, blob }, arch, reported) {
  if (!ARCHES.includes(arch)) throw new Error(`unknown arch ${arch}`);
  if (!DIGEST.test(reported ?? '')) throw new Error('the build reported no digest');
  const read = (d) => {
    const buf = blob(d.digest);
    if (sha256(buf) !== d.digest) throw new Error(`blob ${d.digest} does not match its digest`);
    if (d.size !== undefined && buf.length !== d.size) throw new Error(`blob ${d.digest} is ${buf.length} bytes, its descriptor says ${d.size}`);
    return JSON.parse(buf.toString('utf8'));
  };
  const tops = (index?.manifests ?? []).filter((d) => !d.annotations?.['vnd.docker.reference.type']);
  if (tops.length !== 1) throw new Error(`the archive holds ${tops.length} images, not one`);
  const top = strip(tops[0]);
  if (top.digest !== reported) throw new Error(`the archive holds ${top.digest}, the build reported ${reported}`);
  let children;
  if (INDEX_TYPES.has(top.mediaType)) children = read(top).manifests.map(strip);
  else if (MANIFEST_TYPES.has(top.mediaType)) {
    const m = read(top);
    const cfg = read(m.config);
    children = [{ ...top, platform: platformOf(cfg) }];
  } else throw new Error(`unknown media type ${top.mediaType}`);
  const images = children.filter((d) => !isAttestation(d));
  if (images.length !== 1) throw new Error(`${arch}: ${images.length} image manifests, not one`);
  const p = images[0].platform;
  if (p?.os !== 'linux' || p?.architecture !== arch) throw new Error(`${arch}: the image is for ${p?.os}/${p?.architecture}`);
  for (const d of children) {
    if (!DIGEST.test(d.digest) || !MANIFEST_TYPES.has(d.mediaType)) throw new Error(`${arch}: a descriptor that is not an image manifest (${d.mediaType})`);
    read(d); // present and whole
  }
  // What the image says it is: installs compare its OpenClaw label with the manifest's.
  const labels = read(read(images[0]).config)?.config?.Labels ?? {};
  return { arch, top, children, openclaw: labels['org.agentclaw.openclaw-version'] ?? '', release: labels['org.hatchabot.release'] ?? '' };
}

/** A descriptor without the layout's own naming annotations (they are not part of the image). */
function strip(d) {
  const { annotations, ...rest } = d;
  const kept = Object.fromEntries(Object.entries(annotations ?? {}).filter(([k]) => !/^(org\.opencontainers\.image\.ref\.name|io\.containerd\.image\.name)$/.test(k)));
  return Object.keys(kept).length ? { ...rest, annotations: kept } : rest;
}

function platformOf(cfg) {
  const p = { architecture: cfg.architecture, os: cfg.os };
  if (cfg.variant) p.variant = cfg.variant;
  return p;
}

/**
 * The multi-arch index from each arch's description: its exact bytes, its
 * digest, and each platform's image manifest digest. Arches in a fixed order,
 * so the same descriptions always give the same bytes.
 */
export function mergeDescriptions(descs, { openclaw, release } = {}) {
  const byArch = new Map(descs.map((d) => [d.arch, d]));
  if (byArch.size !== descs.length) throw new Error('an arch is described twice');
  const missing = ARCHES.filter((a) => !byArch.has(a));
  if (missing.length) throw new Error(`no image for ${missing.join(', ')}`);
  // Each arch's labels say what was asked for: the OpenClaw version, and the release (when it is one).
  for (const d of descs) {
    if (openclaw !== undefined && d.openclaw !== openclaw) throw new Error(`${d.arch}: the image is labelled OpenClaw ${d.openclaw || 'nothing'}, not ${openclaw}`);
    if (release && d.release !== release) throw new Error(`${d.arch}: the image is labelled release ${d.release || 'nothing'}, not ${release}`);
  }
  const manifests = ARCHES.flatMap((a) => byArch.get(a).children);
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests }));
  const platforms = {};
  for (const a of ARCHES) {
    const img = byArch.get(a).children.find((d) => !isAttestation(d));
    platforms[`linux/${a}`] = img.digest;
  }
  return { bytes, index: sha256(bytes), platforms };
}

// ---- reading an OCI archive (tar) ----------------------------------------------------
/** The small members of an OCI archive, extracted once into a temp dir. */
export function readArchive(tarFile) {
  const listing = execFileSync('tar', ['-tvf', tarFile], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean);
  const small = [];
  for (const line of listing) {
    // "-rw-r--r-- 0/0 1234 2026-10-10 12:00 blobs/sha256/<hex>"
    const m = /^\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/.exec(line);
    if (m && Number(m[1]) <= SMALL && /^(\.\/)?(index\.json|blobs\/sha256\/[0-9a-f]{64})$/.test(m[2])) small.push(m[2]);
  }
  const dir = mkdtempSync(join(tmpdir(), 'oci-'));
  try {
    if (small.length) execFileSync('tar', ['-xf', tarFile, '-C', dir, ...small]);
    const at = (p) => join(dir, p);
    if (!existsSync(at('index.json'))) throw new Error(`${tarFile} has no index.json`);
    const index = JSON.parse(readFileSync(at('index.json'), 'utf8'));
    const blobs = new Map();
    for (const name of small) {
      const m = /blobs\/sha256\/([0-9a-f]{64})$/.exec(name);
      if (m) blobs.set(`sha256:${m[1]}`, readFileSync(at(name)));
    }
    return { index, blob: (d) => { const b = blobs.get(d); if (!b) throw new Error(`${tarFile} has no blob ${d}`); return b; } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(args) {
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const [cmd, ...rest] = args;
  if (cmd === 'describe') {
    const [tar, arch, reported] = rest;
    process.stdout.write(JSON.stringify(describeLayout(readArchive(tar), arch, reported)) + '\n');
    return 0;
  }
  if (cmd === 'merge') {
    const files = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));
    const openclaw = opt('--openclaw'), nodeImage = opt('--node-image'), out = opt('--out');
    if (!files.length || !openclaw || !nodeImage || !out) return usage();
    if (!/@sha256:[0-9a-f]{64}$/.test(nodeImage)) throw new Error(`the base image ${nodeImage} is not pinned to a digest`);
    const merged = mergeDescriptions(files.map((f) => JSON.parse(readFileSync(f, 'utf8'))), { openclaw, release: opt('--release') || undefined });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'runtime-index.json'), merged.bytes);
    writeFileSync(join(out, 'runtime-image.json'), JSON.stringify({ index: merged.index, platforms: merged.platforms, openclaw, nodeImage }, null, 2) + '\n');
    console.error(`index ${merged.index}: ${Object.entries(merged.platforms).map(([p, d]) => `${p} ${d.slice(0, 19)}…`).join(', ')}`);
    return 0;
  }
  return usage();
}
function usage() {
  console.error('usage: oci-index.mjs describe <archive.tar> <amd64|arm64> <digest> | merge <desc.json>... --openclaw <v> [--release X.Y.Z] --node-image <ref@sha256:…> --out <dir>');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`✗ ${e.message}`); process.exitCode = 1; }
}
