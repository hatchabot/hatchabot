import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from '../domain/appVersion.js';
import { defaultDbPath } from '../envCompat.js';

/**
 * What a release vouches for (docs/install-bundle.md, "What a release vouches
 * for"; docs/release-by-workflow-design.md part 3; #38, #47): the
 * release-manifest.json the release workflow attaches to every release from
 * v2.159.0 on. The app reads it for the runtime image: it is pulled by the
 * index digest the manifest names, never by a tag (a tag can be moved), and
 * never accepted for its version label alone (a label is no proof of content).
 *
 * The same files scripts/release-manifest.sh keeps: <data dir>/release-manifests/<tag>.json,
 * so a restart offline does not need GitHub.
 */
export interface ReleaseManifest {
  schema: 1;
  version: string;
  tag: string;
  commit: string;
  createdAt: string;
  assets: Array<{ name: string; size: number; sha256: string }>;
  image: { repository: string; tag: string; index: string; platforms: Record<string, string>; openclaw: string };
  inputs?: Record<string, string>;
}

/** A release's manifest; none for a release made before manifests; or why it cannot be used. */
export type ManifestLookup =
  | { kind: 'manifest'; manifest: ReleaseManifest }
  | { kind: 'none' }
  | { kind: 'error'; problem: string };

/** A published runtime image to pull: by digest (`pinned`, from the manifest) or, for an older release, by tag. */
export type PublishedImage = { ref: string; openclawVersion: string; pinned: boolean } | { problem: string };

export interface ManifestOptions {
  /** The release whose manifest is read (default: this Hatchabot's own version). */
  version?: string;
  /** Where checked manifests are kept (default: beside the database). */
  dataDir?: string;
  /** Where releases' assets are (default: HATCHABOT_BUNDLE_BASE, else the GitHub releases of HATCHABOT_SLUG). */
  base?: string;
  /** Fetch one URL: its HTTP status and body (tests). */
  fetchText?: (url: string) => Promise<{ status: number; text: string }>;
}

const MAX_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TAG = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** The manifest for `tag` in `text`, or what is wrong with it. */
export function parseReleaseManifest(text: string, tag: string): ReleaseManifest | { problem: string } {
  let m: unknown;
  try { m = JSON.parse(text); } catch { return { problem: 'it is not JSON' }; }
  const o = m as Partial<ReleaseManifest> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { problem: 'it is not a JSON object' };
  if (o.schema !== 1) return { problem: `schema ${String(o.schema)} is not one this Hatchabot reads` };
  if (o.tag !== tag) return { problem: `it is for ${String(o.tag)}, not ${tag}` };
  if (!Array.isArray(o.assets) || !o.assets.every((a) => a && typeof a.name === 'string' && Number.isSafeInteger(a.size) && typeof a.sha256 === 'string' && SHA256.test(a.sha256))) {
    return { problem: 'its asset list is not readable' };
  }
  const img = o.image;
  if (!img || typeof img !== 'object' || typeof img.repository !== 'string' || !/^[a-z0-9][a-z0-9._:/-]*$/.test(img.repository)
    || typeof img.index !== 'string' || !DIGEST.test(img.index)
    || typeof img.openclaw !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(img.openclaw)) {
    return { problem: 'it names no usable runtime image' };
  }
  return o as ReleaseManifest;
}

function defaultDataDir(): string {
  return dirname(resolve(process.env.HATCHABOT_DB ?? defaultDbPath()));
}

function defaultBase(): string {
  return process.env.HATCHABOT_BUNDLE_BASE ?? `https://github.com/${process.env.HATCHABOT_SLUG ?? 'hatchabot/hatchabot'}/releases/download`;
}

/** GitHub (a redirect to its storage), or a file:// test bed where a missing file is a 404. */
async function defaultFetchText(url: string): Promise<{ status: number; text: string }> {
  if (url.startsWith('file://')) {
    try { return { status: 200, text: await readFile(fileURLToPath(url), 'utf8') }; } catch { return { status: 404, text: '' }; }
  }
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  const text = res.ok ? await res.text() : '';
  return { status: res.status, text };
}

/**
 * The manifest of this Hatchabot's release (or `opts.version`'s): the kept
 * copy when there is one, else fetched, checked and kept. A 404 is a release
 * made before manifests (`none`); anything else that goes wrong — no network,
 * a manifest that is unreadable or for another release — is an `error`, never
 * taken as `none` (that would fall back to trusting tags).
 */
export async function releaseManifest(opts: ManifestOptions = {}): Promise<ManifestLookup> {
  const version = opts.version ?? APP_VERSION;
  const tag = `v${version.replace(/^v/, '')}`;
  if (!TAG.test(tag)) return { kind: 'none' };
  const dir = join(opts.dataDir ?? defaultDataDir(), 'release-manifests');
  const file = join(dir, `${tag}.json`);
  const kept = await readFile(file, 'utf8').catch(() => undefined);
  if (kept !== undefined) {
    const m = parseReleaseManifest(kept, tag);
    if (!('problem' in m)) return { kind: 'manifest', manifest: m };
  }
  const url = `${(opts.base ?? defaultBase()).replace(/\/+$/, '')}/${tag}/release-manifest.json`;
  let got: { status: number; text: string };
  try {
    got = await (opts.fetchText ?? defaultFetchText)(url);
  } catch (err) {
    return { kind: 'error', problem: `Could not fetch the release manifest of ${tag} (${(err as Error).message}).` };
  }
  if (got.status === 404) return { kind: 'none' };
  if (got.status !== 200) return { kind: 'error', problem: `Could not fetch the release manifest of ${tag} (HTTP ${got.status}).` };
  if (got.text.length > MAX_BYTES) return { kind: 'error', problem: `The release manifest of ${tag} is not readable: it is too large.` };
  const m = parseReleaseManifest(got.text, tag);
  if ('problem' in m) return { kind: 'error', problem: `The release manifest of ${tag} is refused: ${m.problem}.` };
  try {
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, got.text, 'utf8');
    await rename(tmp, file);
  } catch { /* not kept: fetched again next time */ }
  return { kind: 'manifest', manifest: m };
}

/**
 * The published runtime image of `openclawVersion` this release vouches for.
 * With a manifest: its image by index digest, and only when the manifest's
 * OpenClaw is the one asked for (other versions are built here). A release
 * made before manifests: legacy — the image by its version tag, accepted when
 * its label agrees (the caller checks).
 */
export async function publishedRuntimeImage(openclawVersion: string, opts: ManifestOptions & { registry?: string } = {}): Promise<PublishedImage> {
  const found = await releaseManifest(opts);
  const registry = opts.registry ?? process.env.HATCHABOT_IMAGE_REGISTRY;
  if (found.kind === 'error') return { problem: found.problem };
  if (found.kind === 'manifest') {
    const img = found.manifest.image;
    if (img.openclaw !== openclawVersion) {
      return { problem: `Release ${found.manifest.tag} publishes the runtime image for OpenClaw ${img.openclaw} only, not ${openclawVersion}.` };
    }
    // A mirror (HATCHABOT_IMAGE_REGISTRY) serves the same digest: content-addressed, it cannot differ.
    return { ref: `${registry ?? img.repository}@${img.index}`, openclawVersion, pinned: true };
  }
  // Legacy: a release made before release manifests (before v2.159.0).
  return { ref: `${registry ?? 'ghcr.io/hatchabot/runtime'}:${openclawVersion}`, openclawVersion, pinned: false };
}
