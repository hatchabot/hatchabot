/**
 * An agent pinned to a runtime image carries that pin wherever it goes, but
 * the image itself lives on the daemon that built it. Moving to a machine
 * without it used to stop at "pull access denied" (fixed in v2.33.3 by refusing
 * up front). This rebuilds it there instead — from its RECIPE, not by copying
 * gigabytes: the plain base (pulled from the published registry if missing),
 * plus the extra apt packages recorded in the image's own labels, plus a
 * derived image's Dockerfile lines. Minutes, on the destination, on its own CPU
 * architecture.
 *
 * What cannot be rebuilt this way — messaging-app plugins the destination's
 * base doesn't have (they come only from the base; the published ones carry
 * them), a base with no published twin, a failed build — says why, and the
 * caller falls back to offering the destination's default image.
 */
import type { RuntimeProvider } from '../providers/provider.js';
import type { DerivedImage } from '../domain/types.js';
import { baseProblem, derivedNameProblem, dockerfileProblem, DERIVED_TAG_PREFIX } from './derivedImage.js';

export interface ImageRecipe {
  /** The image to rebuild, by the same name. */
  tag: string;
  /** A plain `<repo>:<openclaw version>` base; must exist or be pullable on the destination. */
  base: string;
  /** apt packages layered on the base (already validated names). */
  packages: string[];
  /** A derived image's own Dockerfile lines (validated when it was created), or none. */
  lines?: string;
  /** Messaging-app plugins the image has, which only its BASE can supply. */
  channels: string[];
}

// A trailing "-" or "+" is apt's REMOVE / install syntax ("curl-" removes curl).
const PKG = /^[a-z0-9][a-z0-9+.-]*[a-z0-9]$|^[a-z0-9]$/;

/** A derived image's record, by the tag agents pin (`…:derived-<name>`). */
export function derivedByTag(get: (name: string) => DerivedImage | undefined) {
  return (tag: string): DerivedImage | undefined => {
    const m = /:derived-([a-z][a-z0-9-]*)$/.exec(tag);
    return m ? get(m[1]!) : undefined;
  };
}

/** How to rebuild `tag` — read from the SOURCE machine, where the image exists. */
export async function recipeFor(
  source: RuntimeProvider,
  tag: string,
  derived: (tag: string) => DerivedImage | undefined,
): Promise<ImageRecipe | { problem: string }> {
  const repo = tag.replace(/:[^:]*$/, '');
  const d = derived(tag);
  if (d) {
    // A derived image is FROM a plain base plus the owner's lines.
    return { tag, base: d.base, packages: [], lines: d.dockerfile, channels: [] };
  }
  const info = (await source.listImageTags().catch(() => [])).find((t) => t.tag === tag);
  if (!info) return { problem: `${tag} is not on this machine either, so there is nothing to rebuild it from` };
  if (!info.openclawVersion) return { problem: `${tag} does not say which OpenClaw it runs` };
  const packages = (info.extraPackages ?? []).filter((p) => PKG.test(p));
  return { tag, base: `${repo}:${info.openclawVersion}`, packages, channels: info.channels ?? [] };
}

/** The thin layer that turns the base into the pinned image. */
export function recipeDockerfile(r: ImageRecipe): string {
  const out = [`FROM ${r.base}`, 'USER root'];
  if (r.packages.length) {
    out.push(`RUN apt-get update && apt-get install -y --no-install-recommends ${r.packages.join(' ')} && rm -rf /var/lib/apt/lists/*`);
  }
  if (r.lines?.trim()) out.push(r.lines.trim());
  out.push('USER node');
  return out.join('\n') + '\n';
}

/**
 * Make `tag` exist on the destination. Already there: nothing to do. A plain
 * base: pull it. Otherwise: base first, then the recipe's layer.
 */
export async function ensureImageOn(
  target: RuntimeProvider,
  source: RuntimeProvider,
  tag: string,
  derived: (tag: string) => DerivedImage | undefined,
): Promise<{ ok: true; built: boolean } | { ok: false; problem: string }> {
  const there = await target.listImageTags().then((t) => t.some((x) => x.tag === tag), () => false);
  if (there) return { ok: true, built: false };
  if (!target.ensureBaseImage || !target.buildImage) return { ok: false, problem: 'this machine cannot build images on that one' };
  const r = await recipeFor(source, tag, derived);
  if ('problem' in r) return { ok: false, problem: r.problem };
  return buildRecipeOn(target, r);
}

/**
 * A recipe that arrived from somewhere else (inside an export file) is
 * untrusted: the same rules a derived image made here must pass, plus names
 * that can only be what this app itself produces. Null when it is acceptable.
 */
export function recipeProblem(r: ImageRecipe): string | null {
  const TAG = /^(hatchabot|agentclaw)-runtime:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
  if (!TAG.test(r.tag)) return `"${r.tag}" is not a runtime image name`;
  const bp = baseProblem(r.base);
  if (bp) return bp;
  if (r.packages.length > 32 || r.packages.some((p) => !PKG.test(p) || p.length > 64)) return 'its package list is not valid';
  const derived = r.tag.split(':')[1]!.startsWith(DERIVED_TAG_PREFIX);
  if (derived) {
    // The name becomes a record here, so it must be one this machine's own derive would accept.
    const np = derivedNameProblem(r.tag.split(':')[1]!.slice(DERIVED_TAG_PREFIX.length));
    if (np) return `its name is not a derived-image name (${np})`;
  }
  if (r.lines?.trim()) {
    if (!derived) return 'only a derived image has Dockerfile lines';
    if (r.lines.length > 8000) return 'its Dockerfile lines are too long';
    const dp = dockerfileProblem(r.lines);
    if (dp) return dp;
  }
  if (r.channels.length > 8 || r.channels.some((c) => !/^[a-z]{2,16}$/.test(c))) return 'its messaging plugins are not valid';
  return null;
}

/** Base first (pulled if need be), then the recipe's layer. */
export async function buildRecipeOn(
  target: RuntimeProvider,
  r: ImageRecipe,
): Promise<{ ok: true; built: boolean } | { ok: false; problem: string }> {
  if (!target.ensureBaseImage || !target.buildImage) return { ok: false, problem: 'this machine cannot build images on that one' };
  const tag = r.tag;
  if (!(await target.ensureBaseImage(r.base))) {
    return { ok: false, problem: `the base ${r.base} is not on that machine and has no published copy to pull` };
  }
  // Messaging-app plugins come only from the base. The published bases carry
  // them, so usually this is a match; a local base built without them is not.
  if (r.channels.length) {
    const baseInfo = (await target.listImageTags().catch(() => [])).find((t) => t.tag === r.base);
    const missing = r.channels.filter((c) => !(baseInfo?.channels ?? []).includes(c));
    if (missing.length) return { ok: false, problem: `it has ${missing.join(' and ')} built in, and that machine's ${r.base} does not` };
  }
  if (r.base === tag) return { ok: true, built: false }; // the pin WAS a plain base: pulling was enough
  const built = await target.buildImage(tag, recipeDockerfile(r), {
    'org.hatchabot.extra-packages': r.packages.join(' '),
    'org.hatchabot.rebuilt-from-recipe': '1',
  });
  return built.ok ? { ok: true, built: true } : { ok: false, problem: `the rebuild failed: ${built.error ?? 'unknown error'}` };
}
