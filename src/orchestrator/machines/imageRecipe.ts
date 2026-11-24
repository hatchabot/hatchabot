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
 *
 * The base is found on the destination by what it was built from, never by
 * its name (HB-0986, buildInputs.ts): the recipe carries its base's build
 * inputs and layers, and an image there with the same layers, or built the
 * same way, is the one it is built on. A recipe from an image or a file made
 * before the label names its base as before, and is built on that name.
 */
import { ProviderError, type ImageTagInfo, type RuntimeProvider } from '../../providers/provider.js';
import type { DerivedImage } from '../../domain/types.js';
import { APT_PACKAGE_NAME, baseProblem, checkTag, dockerfileProblem, DERIVED_TAG_PREFIX, aptInstallLine, RECIPE_LABEL, recipeStamp, useBuiltImage } from './derivedImage.js';
import { derivedNameProblem } from '../../domain/derivedImageName.js';
import { imageRepository } from '../../domain/imageRepository.js';
import { buildAdvice, builtOn, chainId, DERIVED_LABEL, effectiveInputs, formatBuildInputs, inputsDiffer, packagesOf, parseBuildInputs, pickStandIn, standsFor, type BaseWanted } from './buildInputs.js';

export interface ImageRecipe {
  /** The image to rebuild, by the same name. */
  tag: string;
  /** Its base by name, as the source has it: shown, and what a recipe without `inputs` (or an older Hatchabot) builds on. */
  base: string;
  /** apt packages layered on the base (already validated names): every one it has beyond the standard list, a derived image's base packages included. */
  packages: string[];
  /** A derived image's own Dockerfile lines (validated when it was created), or none. */
  lines?: string;
  /** Messaging-app plugins the image has, which only its BASE can supply. */
  channels: string[];
  /** What its base was built from (label org.hatchabot.build-inputs, buildInputs.ts), with the packages laid on it; absent for an image built before the label. */
  inputs?: string;
  /** Its base's layer chain, when that base is proven to be the very image it was built on. */
  layers?: string;
}

/** A repository's name as a file may give it: lowercase parts, `/` between them, never a registry's host and port. */
const REPO_NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const TAG_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
/** The names a fleet's runtime images had before it named its own (HB-0882): still this fleet's. */
const DEFAULT_REPOS = ['hatchabot-runtime', 'agentclaw-runtime'];

/** `<repository>:<tag>`, when a file's name is a runtime image's name in any fleet's repository. */
function imageName(ref: string): { repo: string; name: string } | undefined {
  const at = ref.lastIndexOf(':');
  if (at < 1) return undefined;
  const repo = ref.slice(0, at), name = ref.slice(at + 1);
  return repo.length <= 128 && REPO_NAME.test(repo) && TAG_NAME.test(name) ? { repo, name } : undefined;
}

/**
 * A file's image names in this fleet's repository `repo` (HB-1183): a fleet
 * on another one (HATCHABOT_IMAGE) exports its own names, which an import
 * here refused. The tag is renamed when it is a runtime image's name; the
 * base only from the tag's own repository or the default names, else it is
 * left as it is, and refused. What it was built from never names either.
 * `repo` is this fleet's own setting, so it alone may name a registry's port.
 */
export function namedHere(tag: string, base: string | undefined, repo: string): { tag: string; base?: string } {
  const t = imageName(tag);
  if (!t) return { tag, base };
  const b = base === undefined ? undefined : imageName(base);
  const ours = b && (b.repo === t.repo || DEFAULT_REPOS.includes(b.repo));
  return { tag: `${repo}:${t.name}`, ...(base === undefined ? {} : { base: ours ? `${repo}:${b!.name}` : base }) };
}

// The one rule for an extra package's name (derivedImage.ts, where a derived
// image's base packages are laid on): a base build's packages (cleanPackages)
// are held to it too (HB-0972).
export { APT_PACKAGE_NAME };
const PKG = APT_PACKAGE_NAME;

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
  // Unread is not "no packages": a recipe from a listing that failed rebuilt
  // the image without the tools its labels record (A32, 2026-10-22).
  let tags: Awaited<ReturnType<RuntimeProvider['listImageTags']>>;
  try { tags = await source.listImageTags(); } catch {
    return { problem: `this machine's images could not be read just now, so ${tag}'s recipe is not known — try again` };
  }
  if (d) {
    // Only a derived image that built: a failed or running edit's lines are
    // not what the agent actually runs (night review, 2026-09-28).
    if (d.status !== 'READY') return { problem: `${tag}'s recipe was changed and has not built (${String(d.status).toLowerCase()}), so it is not what the agent runs` };
    // A derived image is FROM a base plus the owner's lines — and that base
    // may itself carry extra packages or messaging plugins, which a stock
    // base on the destination lacks. Its labels (inherited from the base, or
    // the base's own) say which: the packages are laid back on, the plugins
    // checked against the destination's base (#128).
    const self = tags.find((t) => t.tag === tag);
    const baseImage = tags.find((t) => t.tag === d.base);
    const from = self ?? baseImage;
    const basePackages = from ? packagesOf(from) : [];
    const packages = [...new Set([...basePackages, ...(d.basePackages ?? [])])];
    const bad = packages.find((p) => !PKG.test(p));
    if (bad) return { problem: `its base records a package "${bad.slice(0, 40)}" that is not a package name` };
    // What it was built on, from its own labels (its base's, inherited), so
    // a base tag moved since does not change it. Its layers only when the
    // base tag still names that very image (HB-0986). With the record's base
    // packages: a Rebuild here lays them on but labels none, and a base with
    // them elsewhere was then refused (HB-0986 review).
    const labelled = from && effectiveInputs(from);
    const inputs = labelled && { ...labelled, packages };
    const layers = self && baseImage && builtOn(baseImage.layers, self.layers) ? chainId(baseImage.layers) : undefined;
    return {
      tag, base: d.base, packages, lines: d.dockerfile, channels: from?.channels ?? [],
      ...(inputs ? { inputs: formatBuildInputs(inputs) } : {}), ...(layers ? { layers } : {}),
    };
  }
  const info = tags.find((t) => t.tag === tag);
  if (!info) return { problem: `${tag} is not on this machine either, so there is nothing to rebuild it from` };
  if (!info.openclawVersion) return { problem: `${tag} does not say which OpenClaw it runs` };
  // A recipe is "that version, its channels and packages". An engine-free
  // (-lite) build is none of those: rebuilt from the version it would come
  // back with its own memory engine under the same name (2026-09-28).
  const name = tag.slice(repo.length + 1);
  if (/-lite(\b|$)/.test(name)) {
    return { problem: `${tag} is an engine-free image with its own build, so it cannot be rebuilt from a recipe` };
  }
  // Every recorded package, or no recipe: one dropped quietly was a tool the
  // agent lost on the destination (#137).
  const packages = packagesOf(info);
  const bad = packages.find((p) => !PKG.test(p));
  if (bad) return { problem: `${tag} records a package "${bad.slice(0, 40)}" that is not a package name` };
  const inputs = effectiveInputs(info);
  const layers = chainId(info.layers);
  return {
    tag, base: `${repo}:${info.openclawVersion}`, packages, channels: info.channels ?? [],
    ...(inputs ? { inputs: formatBuildInputs(inputs) } : {}), ...(layers ? { layers } : {}),
  };
}

/** The thin layer that turns the base into the pinned image. */
export function recipeDockerfile(r: ImageRecipe): string {
  const out = [`FROM ${r.base}`, 'USER root'];
  if (r.packages.length) out.push(aptInstallLine(r.packages));
  if (r.lines?.trim()) out.push(r.lines.trim());
  out.push('USER node');
  return out.join('\n') + '\n';
}

/**
 * Make `tag` exist on the destination. A plain base: pull it. Otherwise: base
 * first, then the recipe's layer.
 *
 * Already there by that name is not yet the same image (HB-1325): a runner's
 * own build of it, on another base or with other lines, ran the moved agent.
 * It is taken when it has this image's very files (a copy, the same pulled
 * image). Its layers alone never refuse it: a copy built from the recipe
 * there never has this machine's, and every move of an agent pinned to it
 * was refused for good (HB-1325 review). It is refused (`differs`), and left
 * as it is, only when both images say what they were built from (the
 * build-inputs label) and that shows a real difference: OpenClaw, engine,
 * Node, messaging plugins, plugins, settings by hand, or the packages
 * (imageDiffers). An image from before the label, on either side, is taken
 * by name, as before. A derived image's lines are in no other label: one
 * built from its record carries the record's stamp (RECIPE_LABEL), and is
 * taken when it matches; one stamped from other lines or another base is
 * built there again over the old one; one with no stamp (built before it) is
 * taken by name, as before (HB-1325 review: rebuilt on every move, a move
 * to a runner offline, or whose apt failed, was refused though the image
 * was there). On the machine whose records they are (`recordsThere`), its
 * image of a derived name is the record's, whatever another machine's copy
 * is: taken. With no recipe to judge it by, or nothing that says, it is
 * taken by name, as before.
 */
export async function ensureImageOn(
  target: RuntimeProvider,
  source: RuntimeProvider,
  tag: string,
  derived: (tag: string) => DerivedImage | undefined,
  where = 'that machine',
  recordsThere = false,
): Promise<{ ok: true; built: boolean } | { ok: false; problem: string; differs?: true }> {
  const listed = await target.listImageTags().catch(() => undefined);
  const there = listed?.find((x) => x.tag === tag);
  if (there) {
    const isDerived = tag.slice(imageRepository(tag).length + 1).startsWith(DERIVED_TAG_PREFIX);
    if (isDerived && recordsThere) return { ok: true, built: false };
    const mine = await source.listImageTags().then((t) => t.find((x) => x.tag === tag), () => undefined);
    const files = chainId(there.layers);
    if (files && files === chainId(mine?.layers)) return { ok: true, built: false };
    const r = await recipeFor(source, tag, derived);
    if ('problem' in r) return { ok: true, built: false };
    if (!isDerived) {
      const how = imageDiffers(there, r);
      return how ? { ok: false, differs: true, problem: how } : { ok: true, built: false };
    }
    // Built from this very record (its stamp), on what the record's image is
    // built on (both build-inputs labels, packages aside: the stamp has them),
    // is taken. Anything else is built again: a stamp from other lines,
    // another base or other packages, or a copy built on another OpenClaw or
    // engine under the same base name (HB-1325 review: `:latest` moves).
    if (there.recipe === recipeStamp(r.base, r.lines ?? '', r.packages) && !derivedOn(there, r)) return { ok: true, built: false };
    if (!target.ensureBaseImage || !target.buildImage) return { ok: false, problem: 'this machine cannot build images on that one' };
    const built = await buildRecipeOn(target, r, { where });
    // One from before the stamp is built again once, which stamps it; when
    // that cannot run just now (offline, apt failing) it is taken by name, as
    // before, so the move still goes ahead. Never one whose lines, or the
    // image they made, were refused.
    if (!built.ok && !there.recipe && !built.refused) return { ok: true, built: false };
    return built;
  }
  if (!target.ensureBaseImage || !target.buildImage) return { ok: false, problem: 'this machine cannot build images on that one' };
  const r = await recipeFor(source, tag, derived);
  if ('problem' in r) return { ok: false, problem: r.problem };
  return buildRecipeOn(target, r, { where });
}

/**
 * How derived image `t` on another machine is built on something other than
 * the recipe's image is, by both build-inputs labels (a derived image takes
 * its base's), its packages aside; undefined when either does not say or
 * they agree.
 */
function derivedOn(t: ImageTagInfo, r: ImageRecipe): string | undefined {
  const want = r.inputs !== undefined ? parseBuildInputs(r.inputs) : undefined;
  const theirs = effectiveInputs(t);
  if (!want?.ok || !theirs) return undefined;
  return inputsDiffer('the one there', { ...theirs, packages: [] }, { ...want.inputs, packages: [] }, "the agent's");
}

/**
 * How image `t` on another machine, of the recipe's name, is not built as the
 * agent's image is, by both images' build-inputs labels; undefined when either
 * does not say (it is then taken by name) or they agree. Layers are never
 * looked at here. Both images share one name, so the words call them "the
 * one there" and "the agent's".
 */
export function imageDiffers(t: ImageTagInfo, r: ImageRecipe): string | undefined {
  const want = r.inputs !== undefined ? parseBuildInputs(r.inputs) : undefined;
  const theirs = effectiveInputs(t);
  if (!want?.ok || !theirs) return undefined;
  // Their packages are compared whole below, not as a base's laid-on ones.
  const how = inputsDiffer('the one there', { ...theirs, packages: [] }, want.inputs, "the agent's");
  if (how) return how;
  const has = packagesOf(t);
  const same = has.length === new Set(r.packages).size && r.packages.every((p) => has.includes(p));
  const and = (xs: readonly string[]) => xs.join(' and ');
  return same ? undefined : `the one there has ${has.length ? and(has) : 'nothing'} added, and the agent's ${r.packages.length ? `has ${and(r.packages)}` : 'has nothing'}`;
}

/**
 * A recipe that arrived from somewhere else (inside an export file) is
 * untrusted: the same rules a derived image made here must pass, plus names
 * that can only be what this app itself produces. Null when it is acceptable.
 */
export function recipeProblem(r: ImageRecipe, repo = 'hatchabot-runtime'): string | null {
  // In this fleet's repository (an import renames it there first: namedHere).
  const name = [repo, ...DEFAULT_REPOS].filter((x) => r.tag.startsWith(`${x}:`)).map((x) => r.tag.slice(x.length + 1)).find((n) => TAG_NAME.test(n));
  if (name === undefined) return `"${r.tag.slice(0, 200)}" is not a runtime image name`;
  const bp = baseProblem(r.base, repo);
  if (bp) return bp;
  if (r.packages.length > 32 || r.packages.some((p) => !PKG.test(p) || p.length > 64)) return 'its package list is not valid';
  const derived = name.startsWith(DERIVED_TAG_PREFIX);
  if (derived) {
    // The name becomes a record here, so it must be one this machine's own derive would accept.
    const np = derivedNameProblem(name.slice(DERIVED_TAG_PREFIX.length));
    if (np) return `its name is not a derived-image name (${np})`;
  }
  if (r.lines?.trim()) {
    if (!derived) return 'only a derived image has Dockerfile lines';
    if (r.lines.length > 8000) return 'its Dockerfile lines are too long';
    const dp = dockerfileProblem(r.lines);
    if (dp) return dp;
  }
  if (r.channels.length > 8 || r.channels.some((c) => !/^[a-z]{2,16}$/.test(c))) return 'its messaging plugins are not valid';
  // What its base was built from is matched against images here, never
  // built from: a Node or plugins set by hand in it are not passed to a build.
  if (r.inputs !== undefined) {
    const p = parseBuildInputs(r.inputs);
    if (!p.ok) return p.problem;
  }
  if (r.layers !== undefined && !/^sha256:[a-f0-9]{64}$/.test(r.layers)) return "its base's layers are not valid";
  return null;
}

/** What a recipe's base must be on the destination; undefined for a recipe from before the label, built on its base by name. */
function wanted(r: ImageRecipe): BaseWanted | { problem: string } | undefined {
  if (r.inputs === undefined) return r.layers ? { layers: r.layers } : undefined;
  const p = parseBuildInputs(r.inputs);
  return p.ok ? { inputs: p.inputs, ...(r.layers ? { layers: r.layers } : {}) } : { problem: p.problem };
}

/** Not built; `refused` when the lines, or the image they made, were refused (not a build that could not run). */
export type RecipeBuilt = { ok: true; built: boolean; base: string; laid: string[] } | { ok: false; problem: string; refused?: true };

/** How buildRecipeOn picks a recipe's base among a machine's images: one rule for it and for standInAmong. */
const standInHow = (r: ImageRecipe, prefer?: string) => ({ repo: imageRepository(r.tag), prefer, followsDefault: /:latest$/.test(r.base) });

/**
 * The image among `tags` that buildRecipeOn would build `r` on, before
 * anything is pulled; undefined when it would pull one, or build on its
 * base by name. An import judges the OpenClaw its agent will run by it
 * (HB-0986 review).
 */
export function standInAmong(tags: readonly ImageTagInfo[], r: ImageRecipe, prefer?: string): ImageTagInfo | undefined {
  const want = wanted(r);
  if (!want || 'problem' in want) return undefined;
  const pick = pickStandIn(tags, want, standInHow(r, prefer));
  return 'image' in pick ? pick.image : undefined;
}

/**
 * Base first, then the recipe's layer. The base is an image there that
 * stands for the recipe's (buildInputs.ts `pickStandIn`): by its layers, or
 * built the same way, with the base's packages or none (they are laid on).
 * None: the published image of that OpenClaw, pulled only as this release's
 * manifest names it, and judged the same way; still none, it says why and how
 * to build one, and builds nothing. A recipe from before the label: its base
 * by the same layers, else by name (pulled when it is a published version),
 * as before. `prefer`: the image a record here is built on, kept when it
 * stands for the base. `expect`: the id of the stand-in a check before this
 * judged (standInAmong); another pick now refuses. Answers which image it was
 * built on and what was laid on it.
 */
export async function buildRecipeOn(
  target: RuntimeProvider,
  r: ImageRecipe,
  o: { where?: string; prefer?: string; expect?: string } = {},
): Promise<RecipeBuilt> {
  if (!target.ensureBaseImage || !target.buildImage) return { ok: false, problem: 'this machine cannot build images on that one' };
  const where = o.where ?? 'that machine';
  const tag = r.tag;
  const repo = imageRepository(tag);
  const want = wanted(r);
  if (want && 'problem' in want) return { ok: false, problem: want.problem };
  // The lines held to today's rules where they are built, as a derived build
  // here holds a saved record: one saved before a rule (RUN --security,
  // HB-1291) was built on another machine by a move unread.
  const linesProblem = r.lines?.trim() ? dockerfileProblem(r.lines) : null;
  if (linesProblem) return { ok: false, problem: linesProblem, refused: true };
  const listed = async (): Promise<ImageTagInfo[] | undefined> => target.listImageTags().catch(() => undefined);
  let base: ImageTagInfo | undefined;
  /** An id as `docker images` gives it (12 hex) and as inspect does (sha256:…) compare by this. */
  const short = (id: string) => id.replace(/^sha256:/, '').slice(0, 12);
  if (want) {
    const how = standInHow(r, o.prefer);
    let tags = await listed();
    if (!tags) return { ok: false, problem: `${where}'s images could not be read just now — try again` };
    let pick = pickStandIn(tags, want, how);
    if ('why' in pick && want.inputs) {
      if (await target.ensureBaseImage(`${repo}:${want.inputs.openclaw}`)) {
        tags = await listed();
        if (!tags) return { ok: false, problem: `${where}'s images could not be read just now — try again` };
        pick = pickStandIn(tags, want, how);
      }
    }
    if ('image' in pick) base = pick.image;
    else if (want.inputs) {
      const yours = where === 'this machine' ? "this machine's" : "that machine's";
      // How to build one there, from what differs (HB-0986 review): its default image is what a build from Settings is like.
      const latest = tags.find((t) => t.tag === `${repo}:latest`);
      const advice = buildAdvice(want.inputs, latest && effectiveInputs(latest), where, yours);
      return { ok: false, problem: `no image on ${where} is built the way ${tag}'s base is: ${pick.why}${advice}` };
    }
    // The image a check before this chose (an import's OpenClaw check), when
    // it gave one: a promote since then changed the pick (HB-0986 review).
    if (o.expect !== undefined && (!base || short(base.imageId) !== short(o.expect))) {
      return { ok: false, problem: `${where}'s images changed just now — try again` };
    }
  }
  if (!base) {
    if (!(await target.ensureBaseImage(r.base))) {
      return { ok: false, problem: `the base ${r.base} is not on that machine and has no published copy to pull` };
    }
    base = (await listed())?.find((t) => t.tag === r.base) ?? { tag: r.base, imageId: '' };
  }
  // Messaging-app plugins come only from the base. The published bases carry
  // them, so usually this is a match; a local base built without them is not.
  const missing = r.channels.filter((c) => !(base.channels ?? []).includes(c));
  if (missing.length) return { ok: false, problem: `it has ${missing.join(' and ')} built in, and that machine's ${base.tag} does not` };
  // The packages the base lacks are laid on it; those it has, not again.
  const has = packagesOf(base);
  const laid = r.packages.filter((p) => !has.includes(p));
  const lines = r.lines?.trim();
  // The pin WAS a plain base: pulling it was enough.
  if (!laid.length && !lines && base.tag === tag) return { ok: true, built: false, base: base.tag, laid };
  // The base as it is now, which must still be the image chosen above: a
  // promote there in between built on another OpenClaw, and the check after
  // the build, against the base as read here, passed it (HB-0986 review).
  if (!target.inspectImage) return { ok: false, problem: `${where} cannot check the images it builds` };
  const baseFacts = await target.inspectImage(base.tag).catch(() => undefined);
  if (!baseFacts) return { ok: false, problem: `${where}'s image ${base.tag} could not be read just now — try again` };
  const moved = base.imageId ? short(baseFacts.id) !== short(base.imageId) : !!base.layers?.length && chainId(base.layers) !== chainId(baseFacts.layers);
  if (moved) return { ok: false, problem: `${where}'s image ${base.tag} changed just now — try again` };
  if (!laid.length && !lines) {
    // Another name for the same image is a tag, by the id just read (#161:
    // packages it carries under that plain name, which the pulled stock base
    // lacks, are built onto it).
    try { await target.tagImage(baseFacts.id, tag); } catch (err) {
      return { ok: false, problem: `${base.tag} could not be named ${tag}: ${String(err instanceof Error ? err.message : err).slice(0, 300)}` };
    }
    return { ok: true, built: false, base: base.tag, laid };
  }
  // The lines come from a file, and the file is untrusted: what the build
  // makes is looked at before it is used, as a derived build here is
  // (HB-1032). Built to a name of its own, then it must run as node and be
  // built on the base as it was read just before the build; only then does
  // it take its tag. Not seen is not used.
  const name = tag.slice(repo.length + 1);
  const building = checkTag(tag);
  const set: Record<string, string> = {
    // Every package it has beyond the standard list: what it stands for, as a base.
    'org.hatchabot.extra-packages': [...new Set([...has, ...laid])].join(' '),
    'org.hatchabot.rebuilt-from-recipe': '1',
    ...(name.startsWith(DERIVED_TAG_PREFIX) ? { [DERIVED_LABEL]: name.slice(DERIVED_TAG_PREFIX.length), [RECIPE_LABEL]: recipeStamp(r.base, r.lines ?? '', r.packages) } : {}),
  };
  const built = await target.buildImage(building, recipeDockerfile({ ...r, base: base.tag, packages: laid }), set);
  if (!built.ok) return { ok: false, problem: `the rebuild failed: ${built.error ?? 'unknown error'}` };
  const said = (err: unknown) => String(err instanceof ProviderError ? err.userMessage : err instanceof Error ? err.message : err).slice(0, 300);
  const inspect = target.inspectImage.bind(target);
  const used = await useBuiltImage({
    inspect: (ref) => inspect(ref).then((f) => f, said),
    name: (id, to) => target.tagImage(id, to).then(() => null, said),
    remove: (ref) => target.removeImageTag(ref).catch(() => {}),
  }, building, tag, { name: base.tag, layers: baseFacts.layers, labels: baseFacts.labels }, set);
  return used.ok ? { ok: true, built: true, base: base.tag, laid } : { ok: false, problem: `the rebuild failed: ${used.error}`, ...(used.refused ? { refused: true as const } : {}) };
}

/**
 * Whether a derived image's record here builds what the recipe builds: the
 * same lines, on an image that stands for the recipe's base, with the same
 * packages under the lines (its base's and its own). A recipe from before the
 * label: the same base by name, as before. Undefined: the images here could
 * not be read.
 */
export function recordBuilds(rec: DerivedImage, r: ImageRecipe, tags: readonly ImageTagInfo[] | undefined): boolean | undefined {
  if (rec.dockerfile.trim() !== (r.lines ?? '').trim()) return false;
  const want = wanted(r);
  if (!want) return rec.base === r.base;
  if ('problem' in want) return false;
  if (!tags) return undefined;
  const on = tags.find((t) => t.tag === rec.base);
  if (!on || !standsFor(on, want).ok) return false;
  const under = new Set([...packagesOf(on), ...(rec.basePackages ?? [])]);
  return under.size === new Set(r.packages).size && r.packages.every((p) => under.has(p));
}

/**
 * Whether image `t` here, of a recipe's name, is the image the recipe builds
 * (HB-1183 review): a derived image's record here builds the same
 * (recordBuilds) and its last build is the image (READY: after a failed
 * one, the image of its name is the build before), or any other image
 * stands for the recipe's base with the
 * recipe's packages, no more and no fewer. Undefined when nothing here says:
 * a derived name with no record here, or a recipe from before the label.
 */
export function sameImageHere(t: ImageTagInfo, r: ImageRecipe, rec: DerivedImage | undefined, tags: readonly ImageTagInfo[]): boolean | undefined {
  if (rec) return rec.status === 'READY' && recordBuilds(rec, r, tags) === true;
  if (r.tag.slice(imageRepository(r.tag).length + 1).startsWith(DERIVED_TAG_PREFIX)) return undefined;
  const want = wanted(r);
  if (!want) return undefined;
  if ('problem' in want || !standsFor(t, want).ok) return false;
  const has = new Set(packagesOf(t));
  return has.size === new Set(r.packages).size && r.packages.every((p) => has.has(p));
}
