/**
 * What a runtime image was built from (HB-0986), as its label
 * `org.hatchabot.build-inputs` says. docker/Dockerfile.runtime writes the label
 * from its own ARGs, so every build of it has one: build-runtime-image.sh's,
 * the release and candidate workflows' (docker/build-push-action, not the
 * script) and a bare `docker build`. The script adds SET_BY_HAND, the settings
 * it was given by hand (`by-hand`).
 *
 * A recipe carries its base's inputs, and another machine's image stands for
 * that base by its inputs or its layers, never by its name: a `:latest` there
 * may run another OpenClaw, a base with packages (`-plus-`) may have been
 * promoted to `:latest`, and a hand-named build (IMAGE_TAG) may carry another
 * Node or other plugins under a version's name. An image built before the
 * label stands for a base only with the same layers (`chainId`): the same
 * files, as Install image's copy or the same published image are.
 */
import { createHash } from 'node:crypto';
import type { ImageTagInfo } from '../../providers/provider.js';
import { APT_PACKAGE_NAME, DERIVED_TAG_PREFIX } from './derivedImage.js';

export const BUILD_INPUTS_LABEL = 'org.hatchabot.build-inputs';
/** On a derived image, its name: a derived image is never a base, whatever it is tagged. */
export const DERIVED_LABEL = 'org.hatchabot.derived';

/** The settings build-runtime-image.sh can be given by hand, by their names in the label. */
const BY_HAND = ['node', 'channel-plugins', 'plugins', 'plugin-install', 'embed-plugin'] as const;
type ByHand = (typeof BY_HAND)[number];

export interface BuildInputs {
  openclaw: string;
  engine: 'baked' | 'none';
  /** System packages beyond the standard list (with those laid on it, for an image: `effectiveInputs`). */
  packages: string[];
  /** The Node image it is built FROM, as named (with a digest when pinned). */
  node: string;
  channels: string[];
  channelPlugins: string;
  /** Baked plugins, `<id>=<npm package>`. */
  plugins: string[];
  pluginInstall: 'link' | 'npm';
  embedPlugin: string;
  claudeCode: string;
  byHand: ByHand[];
  /** The Hatchabot release it was built for; empty for a local or candidate build. */
  release: string;
}

/** The label's fields, in their order. */
const KEYS = ['openclaw', 'engine', 'packages', 'node', 'channels', 'channel-plugins', 'plugins', 'plugin-install', 'embed-plugin', 'claude-code', 'by-hand', 'release'] as const;
const VERSION = /^\d{4}\.\d{1,3}\.\d{1,3}(-[0-9A-Za-z.]{1,32})?$/;
const PIN = /^[0-9][0-9A-Za-z.+-]{0,63}$/;
const NODE_REF = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;
const PLUGIN = /^[a-z][a-z0-9-]{0,31}=(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}$/;
const RELEASE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]{1,32})?$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
/** A tag that is an OpenClaw version and nothing else: the release's own name for that version. */
export const VERSION_TAG = /^\d{4}\.\d+\.\d+(-\d+)?$/;

export type ParsedInputs = { ok: true; inputs: BuildInputs } | { ok: false; problem: string };

/**
 * The label read, held to its grammar field by field: a recipe's comes from a
 * file, so it is untrusted. A newer form (`v2;…`) is refused, not guessed at.
 */
export function parseBuildInputs(label: string): ParsedInputs {
  const bad = (what: string): ParsedInputs => ({ ok: false, problem: `its base's build inputs are not valid (${what})` });
  if (label.length > 2000 || /[|\r\n]/.test(label)) return bad('their form');
  const [v, ...parts] = label.split(';');
  if (v !== 'v1') {
    return /^v\d{1,3}$/.test(v ?? '')
      ? { ok: false, problem: 'its base was described by a newer Hatchabot: upgrade this one, or import it on the default image' }
      : bad('their form');
  }
  if (parts.length !== KEYS.length) return bad('their fields');
  const f: Record<string, string> = {};
  for (const [i, p] of parts.entries()) {
    const eq = p.indexOf('=');
    if (eq < 0 || p.slice(0, eq) !== KEYS[i]) return bad('their fields');
    f[KEYS[i]!] = p.slice(eq + 1);
  }
  const list = (s: string, sep: string) => (s ? s.split(sep) : []);
  const packages = list(f.packages!.trim(), ' ').filter(Boolean);
  const channels = list(f.channels!, ',');
  const plugins = list(f.plugins!, ',');
  const byHand = list(f['by-hand']!, ',');
  if (!VERSION.test(f.openclaw!)) return bad('openclaw');
  if (f.engine !== 'baked' && f.engine !== 'none') return bad('engine');
  if (/ {2}|\t/.test(f.packages!) || packages.length > 32 || packages.some((p) => p.length > 64 || !APT_PACKAGE_NAME.test(p))) return bad('packages');
  if (f.node!.length > 255 || !NODE_REF.test(f.node!)) return bad('node');
  if (channels.length > 8 || channels.some((c) => !/^[a-z]{2,16}$/.test(c))) return bad('channels');
  if (f['channel-plugins'] && !PIN.test(f['channel-plugins'])) return bad('channel-plugins');
  if (plugins.length > 16 || plugins.some((p) => !PLUGIN.test(p))) return bad('plugins');
  if (f['plugin-install'] !== 'link' && f['plugin-install'] !== 'npm') return bad('plugin-install');
  if (f['embed-plugin'] && !PIN.test(f['embed-plugin'])) return bad('embed-plugin');
  if (f['claude-code'] && !PIN.test(f['claude-code'])) return bad('claude-code');
  if (byHand.some((h) => !(BY_HAND as readonly string[]).includes(h)) || new Set(byHand).size !== byHand.length) return bad('by-hand');
  if (f.release && !RELEASE.test(f.release)) return bad('release');
  return {
    ok: true,
    inputs: {
      openclaw: f.openclaw!, engine: f.engine, packages, node: f.node!, channels,
      channelPlugins: f['channel-plugins']!, plugins, pluginInstall: f['plugin-install'],
      embedPlugin: f['embed-plugin']!, claudeCode: f['claude-code']!, byHand: byHand as ByHand[], release: f.release!,
    },
  };
}

export function formatBuildInputs(i: BuildInputs): string {
  return [
    'v1', `openclaw=${i.openclaw}`, `engine=${i.engine}`, `packages=${i.packages.join(' ')}`, `node=${i.node}`,
    `channels=${i.channels.join(',')}`, `channel-plugins=${i.channelPlugins}`, `plugins=${i.plugins.join(',')}`,
    `plugin-install=${i.pluginInstall}`, `embed-plugin=${i.embedPlugin}`, `claude-code=${i.claudeCode}`,
    `by-hand=${i.byHand.join(',')}`, `release=${i.release}`,
  ].join(';');
}

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];
const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const s = new Set(a);
  return s.size === new Set(b).size && b.every((x) => s.has(x));
};

/**
 * An image's inputs, its packages with those our own builds laid on it: a
 * recipe's build and Install image write them all in `org.hatchabot.extra-packages`.
 * Undefined: it does not say, or not in a form this reads. A name there that
 * is not a package's is kept, for the caller to refuse: one dropped quietly
 * was a tool lost (#137).
 */
export function effectiveInputs(t: Pick<ImageTagInfo, 'buildInputs' | 'extraPackages'>): BuildInputs | undefined {
  if (!t.buildInputs) return undefined;
  const p = parseBuildInputs(t.buildInputs);
  if (!p.ok) return undefined;
  return { ...p.inputs, packages: union(p.inputs.packages, t.extraPackages ?? []) };
}

/** The packages an image has beyond the standard list, as far as its labels say. */
export function packagesOf(t: Pick<ImageTagInfo, 'buildInputs' | 'extraPackages'>): string[] {
  return union(effectiveInputs(t)?.packages ?? [], t.extraPackages ?? []);
}

/**
 * The layers' chain ID (OCI ChainID): one digest for the whole list, equal
 * only for the same files in the same order. Undefined for no layers.
 */
export function chainId(layers: readonly string[] | undefined): string | undefined {
  if (!layers?.length || !layers.every((l) => DIGEST.test(l))) return undefined;
  let chain = layers[0]!;
  for (const l of layers.slice(1)) chain = `sha256:${createHash('sha256').update(`${chain} ${l}`).digest('hex')}`;
  return chain;
}

/** `lower`'s layers are the first of `upper`'s (all of them, for lines that add none): upper was built on that very image. */
export function builtOn(lower: readonly string[] | undefined, upper: readonly string[] | undefined): boolean {
  return !!lower?.length && !!upper && upper.length >= lower.length && lower.every((l, i) => upper[i] === l);
}

/**
 * A Node image's name and its digest, if it has one: Docker Hub's longer
 * names for it (`docker.io/library/node`, `docker.io/x/node`) said the short
 * way, and no tag `:latest`, as docker reads them.
 */
function nodeRef(ref: string): { name: string; digest?: string } {
  const d = /@(sha256:[a-f0-9]{64})$/.exec(ref);
  const bare = (d ? ref.slice(0, d.index) : ref).replace(/^docker\.io\/(?:library\/)?/, '');
  const at = bare.lastIndexOf(':');
  return { name: at > bare.lastIndexOf('/') ? bare : `${bare}:latest`, ...(d ? { digest: d[1] } : {}) };
}

/** A Node image's line: its name without a digest, the version its major (`node:24.11.0-slim` is `node:24-slim`). */
export function nodeLine(ref: string): string {
  const bare = nodeRef(ref).name;
  const at = bare.lastIndexOf(':');
  const [repo, tag] = [bare.slice(0, at), bare.slice(at + 1)];
  const m = /^(\d+)(?:\.\d+){0,2}(-.+)?$/.exec(tag);
  return `${repo}:${m ? `${m[1]}${m[2] ?? ''}` : tag}`;
}

const byHandValue = (i: BuildInputs, f: ByHand): string =>
  ({ node: i.node, 'channel-plugins': i.channelPlugins, plugins: i.plugins.join(','), 'plugin-install': i.pluginInstall, 'embed-plugin': i.embedPlugin })[f];
/**
 * A setting both set by hand is the same however written: the plugins in any
 * order, a Node by any of Docker Hub's names for it, its digest compared only
 * where both name one (round-2 review).
 */
function sameByHand(d: BuildInputs, b: BuildInputs, h: ByHand): boolean {
  if (h === 'plugins') return sameSet(d.plugins, b.plugins);
  if (h === 'node') {
    const [x, y] = [nodeRef(d.node), nodeRef(b.node)];
    return x.name === y.name && (!x.digest || !y.digest || x.digest === y.digest);
  }
  return byHandValue(d, h) === byHandValue(b, h);
}
const and = (xs: readonly string[]) => (xs.length ? xs.join(' and ') : 'none');

/**
 * The first way image `name`'s inputs `d` are not the base's `b`, or undefined
 * when it stands for it. These may differ: the Node's patch or digest on the
 * same line, Claude Code, the channel and embedding plugins' versions when
 * neither was set by hand, the release (and the CPU and the name, which the
 * label does not hold). Its packages are the base's, or none (the base's are
 * then laid on). `base` names `b` in the words (Install image: this machine's
 * image, HB-1189).
 */
export function inputsDiffer(name: string, d: BuildInputs, b: BuildInputs, base = 'the base'): string | undefined {
  if (d.openclaw !== b.openclaw) return `${name} runs OpenClaw ${d.openclaw}, not ${b.openclaw}`;
  if (d.engine !== b.engine) {
    return d.engine === 'baked'
      ? `${name} has its own memory search engine, and ${base} is engine-free`
      : `${name} is engine-free, and ${base} has its own memory search engine`;
  }
  if (nodeLine(d.node) !== nodeLine(b.node)) return `${name} is built on ${nodeLine(d.node)}, not ${nodeLine(b.node)}`;
  const onlyB = b.byHand.find((h) => !d.byHand.includes(h));
  if (onlyB) return `${base} was built with ${onlyB} set by hand (${byHandValue(b, onlyB)}), and ${name} was not`;
  const onlyD = d.byHand.find((h) => !b.byHand.includes(h));
  if (onlyD) return `${name} was built with ${onlyD} set by hand (${byHandValue(d, onlyD)}), and ${base} was not`;
  for (const h of b.byHand) {
    if (!sameByHand(d, b, h)) return `${name} was built with ${h} set by hand to ${byHandValue(d, h)}, and ${base} to ${byHandValue(b, h)}`;
  }
  if (!sameSet(d.channels, b.channels)) return `${name} has ${and(d.channels)} built in, and ${base} has ${and(b.channels)}`;
  if (!sameSet(d.plugins, b.plugins)) return `${name} bakes the plugins ${and(d.plugins)}, and ${base} ${and(b.plugins)}`;
  if (d.pluginInstall !== b.pluginInstall) return `${name} installs messaging plugins by ${d.pluginInstall}, and ${base} by ${b.pluginInstall}`;
  if (d.packages.length && !sameSet(d.packages, b.packages)) {
    return `${name} has ${and(d.packages)} added, and ${base} ${b.packages.length ? `has ${and(b.packages)}` : 'does not'}`;
  }
  return undefined;
}

/**
 * What to do when nothing on `where` stands for a base built from `w`: the
 * words after the first difference (HB-0986 review). Settings builds an
 * OpenClaw, its engine and packages, with this release's Node and messaging
 * plugins, as `here` (that machine's default image) has them: a base with
 * settings by hand is built by hand, and one whose Node or plugins built in
 * a build from Settings would not match is not offered one.
 */
export function buildAdvice(w: BuildInputs, here: BuildInputs | undefined, where: string, yours: string): string {
  const what = `${w.engine === 'none' ? 'an engine-free image' : 'an image'} of OpenClaw ${w.openclaw}${w.packages.length ? ` with ${and(w.packages)}` : ''}`;
  const tail = `, then try again, or run it on ${yours} default image`;
  if (w.byHand.length) {
    return `. Build ${what} on ${where} with ${w.byHand.map((h) => `${h} set by hand to ${byHandValue(w, h) || 'none'}`).join(' and ')}, as its base was (scripts/build-runtime-image.sh)${tail}`;
  }
  const cannot = !here ? undefined
    : !here.byHand.includes('node') && nodeLine(here.node) !== nodeLine(w.node) ? `it would be built on ${nodeLine(here.node)}, not ${nodeLine(w.node)}`
    : !sameSet(here.channels, w.channels) ? `it would have ${and(here.channels)} built in, not ${and(w.channels)}`
    : undefined;
  if (cannot) return `; an image built there from Settings would not be either (${cannot}), so run it on ${yours} default image`;
  return `. Build ${what} on ${where} (Settings → Advanced → Runtime images)${tail}`;
}

/** What a recipe needs of the image it is built on: these inputs, or these very layers. */
export interface BaseWanted {
  inputs?: BuildInputs;
  /** The base's chain ID. */
  layers?: string;
}

/** Whether image `t` stands for the base: `same` when its layers are the base's own. */
export function standsFor(t: ImageTagInfo, want: BaseWanted): { ok: true; same: boolean } | { ok: false; why: string } {
  if (want.layers && chainId(t.layers) === want.layers) return { ok: true, same: true };
  if (!want.inputs) return { ok: false, why: `${t.tag} is not the same image` };
  const mine = effectiveInputs(t);
  if (!mine) return { ok: false, why: `${t.tag} does not say what it was built from` };
  const why = inputsDiffer(t.tag, mine, want.inputs);
  return why ? { ok: false, why } : { ok: true, same: false };
}

/** A derived image, by its name or its label: never a base. */
export function isDerived(t: Pick<ImageTagInfo, 'tag' | 'derived'>): boolean {
  return !!t.derived || t.tag.slice(t.tag.lastIndexOf(':') + 1).startsWith(DERIVED_TAG_PREFIX);
}

/**
 * The image of repository `repo` that stands for the base, the same one every
 * time: `prefer` (the image a record here is already built on) while it
 * stands, so an import does not move the record to another tag it never
 * followed (HB-0986 review); else one with the base's own layers before one
 * built the same way; within each, the default (`:latest`) when the base was
 * the source's default, a version's own tag, then by name. None: why not,
 * said of the default image (or the first).
 */
export function pickStandIn(
  tags: readonly ImageTagInfo[],
  want: BaseWanted,
  o: { repo: string; prefer?: string; followsDefault?: boolean },
): { image: ImageTagInfo } | { why: string } {
  const latest = `${o.repo}:latest`;
  const rank = (t: ImageTagInfo) => [t.tag === o.prefer ? 0 : 1, o.followsDefault && t.tag === latest ? 0 : 1, VERSION_TAG.test(t.tag.slice(o.repo.length + 1)) ? 0 : 1];
  const order = tags
    .filter((t) => t.tag.startsWith(`${o.repo}:`) && !isDerived(t))
    .map((t) => ({ t, r: rank(t) }))
    .sort((a, b) => a.r[0]! - b.r[0]! || a.r[1]! - b.r[1]! || a.r[2]! - b.r[2]! || (a.t.tag < b.t.tag ? -1 : a.t.tag > b.t.tag ? 1 : 0))
    .map(({ t }) => ({ t, s: standsFor(t, want) }));
  const pick = order.find((j) => j.t.tag === o.prefer && j.s.ok) ?? order.find((j) => j.s.ok && j.s.same) ?? order.find((j) => j.s.ok);
  if (pick) return { image: pick.t };
  const near = order.find((j) => j.t.tag === latest) ?? order[0];
  return { why: near && !near.s.ok ? near.s.why : 'it has no runtime image yet' };
}
