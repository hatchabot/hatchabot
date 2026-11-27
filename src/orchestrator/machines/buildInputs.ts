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
function nodeRef(ref: string): { name: string; digest?: string; tagged: boolean } {
  const d = /@(sha256:[a-f0-9]{64})$/.exec(ref);
  const bare = (d ? ref.slice(0, d.index) : ref).replace(/^docker\.io\/(?:library\/)?/, '');
  const at = bare.lastIndexOf(':');
  const tagged = at > bare.lastIndexOf('/');
  return { name: tagged ? bare : `${bare}:latest`, ...(d ? { digest: d[1] } : {}), tagged };
}
/** A Node named by its digest alone (`node@sha256:…`): that very image, of no tag and no line known by its name (HB-1448). */
const byDigestOnly = (ref: string): boolean => { const r = nodeRef(ref); return !r.tagged && !!r.digest; };

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
 * A setting by hand as the words say it: a digest by its first 12 hex, as
 * docker writes an id short. Two in full made a refusal's advice longer than
 * an import's rolled-back reason keeps (HB-1333).
 */
const saidByHand = (i: BuildInputs, f: ByHand, most = Infinity): string => {
  if (f === 'plugins' && i.plugins.length > most) return most < 1 ? counted(i.plugins.length, 'plugin') : `${i.plugins.slice(0, most).join(',')} and ${i.plugins.length - most} more`;
  return byHandValue(i, f).replace(/@sha256:([a-f0-9]{12})[a-f0-9]{52}/g, '@sha256:$1…');
};
/**
 * A setting both set by hand is the same however written: the plugins in any
 * order, a Node by any of Docker Hub's names for it, its digest compared only
 * where both name one (round-2 review).
 */
function sameByHand(d: BuildInputs, b: BuildInputs, h: ByHand): boolean {
  if (h === 'plugins') return sameSet(d.plugins, b.plugins);
  if (h === 'node') {
    const [x, y] = [nodeRef(d.node), nodeRef(b.node)];
    // By its digest alone, it is that image: the same only by that digest
    // (read as node:latest, it was the same as a `node:latest` that moves, HB-1448).
    if (byDigestOnly(d.node) || byDigestOnly(b.node)) return !!x.digest && x.digest === y.digest && x.name.replace(/:[^:/]*$/, '') === y.name.replace(/:[^:/]*$/, '');
    return x.name === y.name && (!x.digest || !y.digest || x.digest === y.digest);
  }
  return byHandValue(d, h) === byHandValue(b, h);
}
const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
/**
 * A list in words: each named, or, with `most`, the first `most` and how
 * many more (HB-1333), or with none (`most` 0) only how many `noun`s, the
 * last that fits an import's reason (HB-1333 review).
 */
const and = (xs: readonly string[], most = Infinity, noun = 'one') => {
  if (!xs.length) return 'none';
  if (most < 1) return counted(xs.length, noun);
  return xs.length > most ? `${xs.slice(0, most).join(' and ')} and ${xs.length - most} more` : xs.join(' and ');
};

/**
 * The first way image `name`'s inputs `d` are not the base's `b`, or undefined
 * when it stands for it. These may differ: the Node's patch or digest on the
 * same line, Claude Code, the channel and embedding plugins' versions when
 * neither was set by hand, the release (and the CPU and the name, which the
 * label does not hold). Its packages are the base's, or none (the base's are
 * then laid on). `base` names `b` in the words (Install image: this machine's
 * image, HB-1189).
 */
export function inputsDiffer(name: string, d: BuildInputs, b: BuildInputs, base = 'the base', most = Infinity): string | undefined {
  if (d.openclaw !== b.openclaw) return `${name} runs OpenClaw ${d.openclaw}, not ${b.openclaw}`;
  if (d.engine !== b.engine) {
    return d.engine === 'baked'
      ? `${name} has its own memory search engine, and ${base} is engine-free`
      : `${name} is engine-free, and ${base} has its own memory search engine`;
  }
  // A Node set by hand by its digest alone has no line by its name: it is compared as a setting by hand (sameByHand).
  const digestByHand = (i: BuildInputs) => i.byHand.includes('node') && byDigestOnly(i.node);
  if (!digestByHand(d) && !digestByHand(b) && nodeLine(d.node) !== nodeLine(b.node)) return `${name} is built on ${nodeLine(d.node)}, not ${nodeLine(b.node)}`;
  const onlyB = b.byHand.find((h) => !d.byHand.includes(h));
  if (onlyB) return `${base} was built with ${onlyB} set by hand (${saidByHand(b, onlyB, most)}), and ${name} was not`;
  const onlyD = d.byHand.find((h) => !b.byHand.includes(h));
  if (onlyD) return `${name} was built with ${onlyD} set by hand (${saidByHand(d, onlyD, most)}), and ${base} was not`;
  for (const h of b.byHand) {
    if (!sameByHand(d, b, h)) return `${name} was built with ${h} set by hand to ${saidByHand(d, h, most)}, and ${base} to ${saidByHand(b, h, most)}`;
  }
  if (!sameSet(d.channels, b.channels)) return `${name} has ${and(d.channels, most, 'messaging plugin')} built in, and ${base} has ${and(b.channels, most, 'messaging plugin')}`;
  if (!sameSet(d.plugins, b.plugins)) {
    return `${name} bakes ${most < 1 && d.plugins.length ? and(d.plugins, most, 'plugin') : `the plugins ${and(d.plugins, most)}`}, and ${base} ${and(b.plugins, most, 'plugin')}`;
  }
  if (d.pluginInstall !== b.pluginInstall) return `${name} installs messaging plugins by ${d.pluginInstall}, and ${base} by ${b.pluginInstall}`;
  if (d.packages.length && !sameSet(d.packages, b.packages)) {
    return `${name} has ${and(d.packages, most, 'package')} added, and ${base} ${b.packages.length ? `has ${and(b.packages, most, 'package')}` : 'does not'}`;
  }
  return undefined;
}

/** What a build from Settings sets that a base may differ by: its Node, when known, and its messaging plugins. */
export interface SettingsBuild { node?: string; channels: string[] }

/**
 * What this release's build from Settings would set for OpenClaw `openclaw`,
 * by `dockerfile` (docker/Dockerfile.runtime's text), whose defaults the
 * build script passes on: its messaging plugins always; its Node for the
 * Dockerfile's own OpenClaw, and for another none (the script takes the
 * lowest Node line that version asks for, which only the build finds out).
 * The machine's `:latest` was asked, and it may be a hand build or an older
 * release's image (HB-1323). Undefined: the Dockerfile says neither.
 */
export function settingsBuild(openclaw: string, dockerfile: string | undefined): SettingsBuild | undefined {
  const arg = (name: string) => dockerfile && new RegExp(`^ARG ${name}=(\\S*)`, 'm').exec(dockerfile)?.[1];
  const channels = arg('CHANNEL_PLUGINS'), node = arg('NODE_IMAGE');
  if (typeof channels !== 'string') return undefined;
  return { channels: channels ? channels.split(',') : [], ...(node && arg('OPENCLAW_VERSION') === openclaw ? { node } : {}) };
}

/** The image to build for a base built from `w`, in words: its OpenClaw, its engine, its packages (buildAdvice). */
export function imageWhat(w: BuildInputs, most = Infinity, packagesSaid = false): string {
  const with_ = !w.packages.length ? '' : ` with ${packagesSaid ? "the base's packages" : and(w.packages, most, 'package')}`;
  return `${w.engine === 'none' ? 'an engine-free image' : 'an image'} of OpenClaw ${w.openclaw}${with_}`;
}

/**
 * How a base built from `w` is built again on a machine of this release:
 * from Settings, by hand (settings by hand, scripts/build-runtime-image.sh),
 * or not at all from here (a build from Settings would have another Node or
 * messaging plugins), as buildAdvice says it.
 */
export function buildWay(w: BuildInputs, settings: SettingsBuild | undefined): 'settings' | 'by hand' | undefined {
  if (w.byHand.length) return 'by hand';
  if (settings && ((settings.node && nodeLine(settings.node) !== nodeLine(w.node)) || !sameSet(settings.channels, w.channels))) return undefined;
  return 'settings';
}

/**
 * Where a build from Settings is made, for `where` (HB-1515): Settings builds
 * on this machine only, and a runner gets an image built here only as this
 * machine's default, copied by Install image (or Update image, as the
 * runner's row offers it after a Check, only when the runner's image is
 * missing or runs another OpenClaw: said, HB-1515 re-review). "Build … on <runner> (Settings
 * → Advanced → Runtime images)" pointed its owner at a build that never runs
 * there. `here`: `where` is this machine, by its host's kind, never by its
 * name: the local host's name is "This machine (<hostname>)", and a move back
 * here was told to install it on itself (HB-1515 review).
 */
export function settingsBuildOn(what: string, where: string, here: boolean): string {
  return here
    ? `${what} on this machine (Settings → Advanced → Runtime images)`
    : `${what} on this machine (Settings → Advanced → Runtime images), make it this machine's default and copy it to ${where} (Settings → Hosts → Check, then Install image or Update image, offered when its image is missing or runs another OpenClaw)`;
}

/**
 * What to do when nothing on `where` stands for a base built from `w`: the
 * words after the first difference (HB-0986 review). Settings builds an
 * OpenClaw, its engine and packages, with this release's Node and messaging
 * plugins (`settings`, settingsBuild): a base with settings by hand is built
 * by hand, and one whose Node or plugins built in a build from Settings would
 * not match is not offered one. `room`: the characters the words may take
 * (an import's rolled-back reason keeps only so many): the settings by hand
 * are named in full, first first, while they fit, and the rest counted
 * (HB-1333); the first difference, said before these words, names one.
 * `most`: each list (packages, plugins, messaging plugins) names that many
 * at most and counts the rest, or with 0 only counts, which the caller
 * lowers until all fits. `packagesSaid`: the first difference named the
 * base's packages, so they are not named again (HB-1333 review). `here`:
 * `where` is this machine (settingsBuildOn).
 */
export function buildAdvice(w: BuildInputs, settings: SettingsBuild | undefined, where: string, here: boolean, room = Infinity, most = Infinity, packagesSaid = false): string {
  const yours = here ? "this machine's" : "that machine's";
  const what = imageWhat(w, most, packagesSaid);
  const tail = `, then try again, or run it on ${yours} default image`;
  if (w.byHand.length) {
    const set = w.byHand.map((h) => `${h} set by hand to ${saidByHand(w, h, most) || 'none'}`);
    const words = (k: number) => {
      const more = set.length - k;
      const named = more ? [...set.slice(0, k), `${more}${k ? ' more' : ''} setting${more > 1 ? 's' : ''} set by hand`] : set;
      return `. Build ${what} on ${where} with ${named.join(' and ')}, as its base was (scripts/build-runtime-image.sh)${tail}`;
    };
    for (let k = set.length; k > 0; k--) { const said = words(k); if (said.length <= room) return said; }
    return words(0);
  }
  const cannot = !settings ? undefined
    : settings.node && nodeLine(settings.node) !== nodeLine(w.node) ? `it would be built on ${nodeLine(settings.node)}, not ${nodeLine(w.node)}`
    : !sameSet(settings.channels, w.channels) ? `it would have ${and(settings.channels, most, 'messaging plugin')} built in, not ${and(w.channels, most, 'messaging plugin')}`
    : undefined;
  if (cannot) return `; an image built ${here ? 'there from Settings' : 'from Settings on this machine and installed there'} would not be either (${cannot}), so run it on ${yours} default image`;
  return `. Build ${settingsBuildOn(what, where, here)}${tail}`;
}

/** What a recipe needs of the image it is built on: these inputs, or these very layers, and how the base runs. */
export interface BaseWanted {
  inputs?: BuildInputs;
  /** The base's chain ID. */
  layers?: string;
  /** How the base runs (runConfigId): its user, entrypoint, command, environment, volumes, working folder, ONBUILD steps, shell and stop signal (HB-1330). */
  config?: string;
}

/**
 * Whether image `t` stands for the base: `same` when its layers are the
 * base's own. By its layers or by what it was built from, it must also run
 * as the base does (HB-1330): one built FROM the base that adds no layer
 * (only USER root, an ENV, another ENTRYPOINT) has the base's layers and
 * labels, and stood for it. Not said on either side (a recipe or file from
 * before it, a listing that did not say) is not compared, as before.
 */
export function standsFor(t: ImageTagInfo, want: BaseWanted, most = Infinity): { ok: true; same: boolean } | { ok: false; why: string; runsOtherwise?: true; packages?: true } {
  // Built as the base was, by its layers or its inputs, and only how it runs differs: said apart (HB-1330 review).
  const runs = want.config && t.config && t.config !== want.config
    ? { ok: false as const, why: `${t.tag} does not run as the base does: ${RUNS_OTHERWISE} differ`, runsOtherwise: true as const }
    : undefined;
  if (want.layers && chainId(t.layers) === want.layers) return runs ?? { ok: true, same: true };
  if (!want.inputs) return { ok: false, why: `${t.tag} is not the same image` };
  const mine = effectiveInputs(t);
  if (!mine) return { ok: false, why: `${t.tag} does not say what it was built from` };
  const why = inputsDiffer(t.tag, mine, want.inputs, 'the base', most);
  // The packages are inputsDiffer's last test: the same but for them, the words named the base's (`packages`).
  if (why) return { ok: false, why, ...(inputsDiffer(t.tag, { ...mine, packages: want.inputs.packages }, want.inputs) ? {} : { packages: true as const }) };
  return runs ?? { ok: true, same: false };
}

/** What runConfigId compares, in words. */
export const RUNS_OTHERWISE = 'its user, entrypoint, command, environment, volumes, working folder or the rest of how it runs';

/**
 * `s` in at most `room` characters: whole, or cut at the end of a word with
 * "…" (HB-1333 review), as an import's rolled-back reason, which keeps only
 * so many, would otherwise cut it in the middle of one.
 */
export function fitWords(s: string, room: number): string {
  if (s.length <= room) return s;
  if (room < 1) return '';
  const cut = s.slice(0, room - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 0 ? cut.slice(0, sp) : cut).replace(/[\s,.;:(]+$/, '')}…`;
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
 * said of the default image (or the first), as `near`, or, when an image
 * is built as the base was and only runs otherwise, of the first such
 * (`otherwise`): building that image again gives the same (HB-1330 review).
 */
export function pickStandIn(
  tags: readonly ImageTagInfo[],
  want: BaseWanted,
  o: { repo: string; prefer?: string; followsDefault?: boolean },
): { image: ImageTagInfo } | { why: string; near?: ImageTagInfo; otherwise?: ImageTagInfo } {
  const latest = `${o.repo}:latest`;
  const rank = (t: ImageTagInfo) => [t.tag === o.prefer ? 0 : 1, o.followsDefault && t.tag === latest ? 0 : 1, VERSION_TAG.test(t.tag.slice(o.repo.length + 1)) ? 0 : 1];
  const order = tags
    .filter((t) => t.tag.startsWith(`${o.repo}:`) && !isDerived(t))
    .map((t) => ({ t, r: rank(t) }))
    .sort((a, b) => a.r[0]! - b.r[0]! || a.r[1]! - b.r[1]! || a.r[2]! - b.r[2]! || (a.t.tag < b.t.tag ? -1 : a.t.tag > b.t.tag ? 1 : 0))
    .map(({ t }) => ({ t, s: standsFor(t, want) }));
  const pick = order.find((j) => j.t.tag === o.prefer && j.s.ok) ?? order.find((j) => j.s.ok && j.s.same) ?? order.find((j) => j.s.ok);
  if (pick) return { image: pick.t };
  const otherwise = order.find((j) => !j.s.ok && j.s.runsOtherwise);
  if (otherwise && !otherwise.s.ok) return { why: otherwise.s.why, otherwise: otherwise.t };
  const near = order.find((j) => j.t.tag === latest) ?? order[0];
  return near && !near.s.ok ? { why: near.s.why, near: near.t } : { why: 'it has no runtime image yet' };
}
