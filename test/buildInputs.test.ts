import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILD_INPUTS_LABEL, buildAdvice, builtOn, chainId, formatBuildInputs, inputsDiffer, isDerived, nodeLine, parseBuildInputs, pickStandIn, standsFor, type BuildInputs,
} from '../src/orchestrator/machines/buildInputs.js';
import { buildRecipeOn, ensureImageOn, recipeFor, recipeProblem, type ImageRecipe } from '../src/orchestrator/machines/imageRecipe.js';
import { fitWords } from '../src/orchestrator/machines/buildInputs.js';
import { recipeStamp } from '../src/orchestrator/machines/derivedImage.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { runConfigId, type ImageTagInfo } from '../src/providers/provider.js';

/**
 * What a runtime image was built from (HB-0986): the label every build of
 * docker/Dockerfile.runtime writes, and another machine's image standing for a
 * moved or imported agent's base by it, or by its layers, never by its name.
 */

const DOCKERFILE = readFileSync('docker/Dockerfile.runtime', 'utf8');
/** Pins a release's Dockerfile sets and no build's arguments do. */
const RELEASE_ONLY = ['EMBED_MODEL_SHA256', 'EMBED_MODEL_URL', 'GOG_SHA256_amd64', 'GOG_SHA256_arm64', 'GOG_VERSION'];
const defaults = new Map<string, string>();
for (const m of DOCKERFILE.matchAll(/^ARG ([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/gm)) if (!defaults.has(m[1]!)) defaults.set(m[1]!, m[2] ?? '');
const labelLine = DOCKERFILE.split('\n').find((l) => l.startsWith(`LABEL ${BUILD_INPUTS_LABEL}=`))!;
const named = new Set([...labelLine.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!));
/** The label as docker fills it in: the build's arguments, else the ARGs' defaults. */
const filled = (args: Record<string, string> = {}) => /="(.*)"$/.exec(labelLine)![1]!.replace(/\$\{(\w+)\}/g, (_, k: string) => args[k] ?? defaults.get(k) ?? '');

const L = (c: string) => `sha256:${c.repeat(64)}`;
const B: BuildInputs = {
  openclaw: '2026.9.8', engine: 'none', packages: [], node: `node:24-slim@${L('d')}`, channels: ['slack', 'discord'],
  channelPlugins: '2026.9.8', plugins: ['duckduckgo=@openclaw/duckduckgo-plugin', 'brave=@openclaw/brave-plugin'], pluginInstall: 'npm',
  embedPlugin: '2026.7.1', claudeCode: '2.1.224', byHand: [], release: '2.190.0',
};
const label = (o: Partial<BuildInputs> = {}) => formatBuildInputs({ ...B, ...o });
const img = (tag: string, o: Partial<ImageTagInfo> = {}): ImageTagInfo => ({ tag, imageId: `id-${tag}`, ...o });

describe("the runtime Dockerfile's run settings (HB-1330 review)", () => {
  it('are the ones every stock image\'s run-settings id is made of, held here as they are', () => {
    // Joined where a line goes on, and its comments left out.
    const lines = DOCKERFILE.replace(/\\\n/g, ' ').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const from = lines.map((l) => /^FROM\s/i.test(l)).lastIndexOf(true);
    const last = lines.slice(from + 1);
    const of = (k: string) => last.filter((l) => new RegExp(`^${k}\\s`, 'i').test(l)).map((l) => l.replace(/^\S+\s+/, '').replace(/\s+/g, ' '));
    const WHY = "Every runtime image's run-settings id (runConfigId, src/providers/provider.ts) is made of these: a change makes every image built after it stand for none built before in a move or an import, refused in words that blame an image built by hand. Leave a new environment variable out of the id, as NODE_VERSION and YARN_VERSION are, or take the break and say so in the CHANGELOG; then change this list.";
    expect({ USER: of('USER'), ENV: of('ENV'), ENTRYPOINT: of('ENTRYPOINT'), CMD: of('CMD') }, WHY).toEqual({
      USER: ['node'],
      ENV: ['HATCHABOT_EMBED_PLUGIN=/opt/agentclaw/llama-cpp/llama-cpp-provider HATCHABOT_EMBED_MODEL=/opt/agentclaw/models/embeddinggemma-300m-qat-Q8_0.gguf', 'HOME=/home/node'],
      ENTRYPOINT: ['["agentclaw-entrypoint"]'],
      CMD: ['["openclaw", "gateway"]'],
    });
    for (const k of ['WORKDIR', 'VOLUME', 'SHELL', 'STOPSIGNAL', 'ONBUILD']) expect(of(k), `${k} is in the image: ${WHY}`).toEqual([]);
  });
});

describe("the build-inputs label in docker/Dockerfile.runtime (HB-0986)", () => {
  it('names every ARG of the build but the pins only a release sets', () => {
    expect([...defaults.keys()].filter((k) => !named.has(k)).sort()).toEqual(RELEASE_ONLY);
    for (const k of named) expect(defaults.has(k), k).toBe(true);
    // Each is declared before the label, so docker fills it in.
    for (const k of named) expect(DOCKERFILE.lastIndexOf(`\nARG ${k}`, DOCKERFILE.indexOf(labelLine)), k).toBeGreaterThan(0);
  });

  it('names each build argument a workflow or the build script passes', () => {
    const passed = new Set<string>();
    const files = readdirSync('.github/workflows').filter((f) => /\.ya?ml$/.test(f)).map((f) => join('.github/workflows', f));
    for (const file of [...files, 'scripts/build-runtime-image.sh']) {
      const text = readFileSync(file, 'utf8');
      // docker/build-push-action: `build-args: |` and NAME=value lines under it.
      for (const m of text.matchAll(/^( *)build-args: *\|\n((?:\1 +\S.*\n)+)/gm)) {
        for (const line of m[2]!.split('\n')) { const n = /^\s*([A-Za-z_][A-Za-z0-9_]*)=/.exec(line); if (n) passed.add(n[1]!); }
      }
      for (const m of text.matchAll(/--build-arg[ =]"?([A-Za-z_][A-Za-z0-9_]*)=/g)) passed.add(m[1]!);
    }
    // The release workflow's own arguments are among them: this reads them.
    expect([...passed]).toEqual(expect.arrayContaining(['OPENCLAW_VERSION', 'EMBED_ENGINE', 'CHANNEL_PLUGIN_VERSION', 'BAKED_PLUGINS', 'PLUGIN_INSTALL', 'HATCHABOT_RELEASE', 'SET_BY_HAND', 'NODE_IMAGE', 'EXTRA_PACKAGES']));
    expect([...passed].filter((k) => !named.has(k))).toEqual([]);
  });

  it('reads back as docker fills it in, for a plain build, a release build and a build with settings by hand', () => {
    const plain = parseBuildInputs(filled());
    expect(plain).toMatchObject({ ok: true, inputs: { openclaw: defaults.get('OPENCLAW_VERSION'), node: defaults.get('NODE_IMAGE'), channels: ['slack', 'discord'], byHand: [], release: '', packages: [] } });
    const release = parseBuildInputs(filled({
      OPENCLAW_VERSION: '2026.9.8', EMBED_ENGINE: 'none', CHANNEL_PLUGIN_VERSION: '2026.9.8',
      BAKED_PLUGINS: 'duckduckgo=@openclaw/duckduckgo-plugin,brave=@openclaw/brave-plugin', PLUGIN_INSTALL: 'npm', HATCHABOT_RELEASE: '2.191.0',
    }));
    expect(release).toMatchObject({ ok: true, inputs: { engine: 'none', plugins: B.plugins, pluginInstall: 'npm', release: '2.191.0' } });
    const byHand = parseBuildInputs(filled({ EXTRA_PACKAGES: 'jq curl', NODE_IMAGE: 'node:26-slim', SET_BY_HAND: 'node' }));
    expect(byHand).toMatchObject({ ok: true, inputs: { packages: ['jq', 'curl'], node: 'node:26-slim', byHand: ['node'] } });
  });
});

describe('build inputs, read from a label or a file (HB-0986)', () => {
  it('reads back what it writes', () => {
    for (const s of [label(), label({ packages: ['jq', 'g++'], byHand: ['node', 'plugins'], node: 'node:26-slim', release: '', channels: [], plugins: [] })]) {
      const p = parseBuildInputs(s);
      expect(p.ok, s).toBe(true);
      if (p.ok) expect(formatBuildInputs(p.inputs)).toBe(s);
    }
  });

  it('holds every field to its form, and refuses a form it does not know', () => {
    const swap = (k: string, v: string) => label().replace(new RegExp(`;${k}=[^;]*`), `;${k}=${v}`);
    const bad: Array<[string, string]> = [
      [swap('openclaw', 'latest'), 'openclaw'], [swap('engine', 'shared'), 'engine'], [swap('packages', 'curl-'), 'packages'],
      [swap('packages', 'jq  curl'), 'packages'], [swap('node', 'registry.example:5000/node:24'), 'node'], [swap('node', 'node:24 --network=host'), 'node'],
      [swap('channels', 'Slack'), 'channels'], [swap('channel-plugins', 'next'), 'channel-plugins'], [swap('plugins', 'brave'), 'plugins'],
      [swap('plugin-install', 'curl'), 'plugin-install'], [swap('embed-plugin', '$(id)'), 'embed-plugin'], [swap('claude-code', 'latest'), 'claude-code'],
      [swap('by-hand', 'openclaw'), 'by-hand'], [swap('by-hand', 'node,node'), 'by-hand'], [swap('release', 'v2'), 'release'],
      [label().replace(';engine=none;packages=;', ';packages=;engine=none;'), 'their fields'], [label().replace(/;release=.*$/, ''), 'their fields'],
      [`${label()}|x`, 'their form'], [`${label()}\nx`, 'their form'], ['v1', 'their fields'], ['', 'their form'],
    ];
    for (const [s, field] of bad) expect(parseBuildInputs(s), s).toEqual({ ok: false, problem: `its base's build inputs are not valid (${field})` });
    expect(parseBuildInputs(label().replace(/^v1/, 'v2'))).toEqual({ ok: false, problem: 'its base was described by a newer Hatchabot: upgrade this one, or import it on the default image' });
  });

  it("a chain ID is the OCI one, over every layer in order", () => {
    const two = `sha256:${createHash('sha256').update(`${L('a')} ${L('b')}`).digest('hex')}`;
    expect(chainId([L('a')])).toBe(L('a'));
    expect(chainId([L('a'), L('b')])).toBe(two);
    expect(chainId([L('a'), L('b'), L('c')])).toBe(`sha256:${createHash('sha256').update(`${two} ${L('c')}`).digest('hex')}`);
    expect(chainId([L('b'), L('a')])).not.toBe(two);
    for (const none of [undefined, [], ['sha256:short'], [L('a'), 'x']]) expect(chainId(none)).toBeUndefined();
  });

  it('an image was built on another only when that one\'s layers are its first', () => {
    expect(builtOn([L('a'), L('b')], [L('a'), L('b'), L('c')])).toBe(true);
    expect(builtOn([L('a'), L('b')], [L('a'), L('b')])).toBe(true); // lines that add no layer
    // The base tag moved since: another image under its name.
    expect(builtOn([L('a'), L('x')], [L('a'), L('b'), L('c')])).toBe(false);
    expect(builtOn([L('a'), L('b'), L('c')], [L('a'), L('b')])).toBe(false);
    expect(builtOn([], [L('a')])).toBe(false);
    expect(builtOn([L('a')], undefined)).toBe(false);
  });

  it("a Node image's line is its name and major version", () => {
    expect(nodeLine(`node:24-slim@${L('d')}`)).toBe('node:24-slim');
    expect(nodeLine('node:24.11.0-slim')).toBe('node:24-slim');
    expect(nodeLine('node:24')).toBe('node:24');
    expect(nodeLine('node')).toBe('node:latest');
    // Docker Hub's own names for it are the same image (round-2 review).
    expect(nodeLine('docker.io/library/node:22.3-bookworm')).toBe('node:22-bookworm');
    expect(nodeLine('docker.io/someone/node:22')).toBe('someone/node:22');
  });
});

describe('an image standing for a base (HB-0986)', () => {
  it('everything it was built from must be the same, but for what no setting by hand chose', () => {
    const refused: Array<[Partial<BuildInputs>, Partial<BuildInputs>, string]> = [
      [{ openclaw: '2026.9.6' }, {}, 'D runs OpenClaw 2026.9.6, not 2026.9.8'],
      [{ engine: 'baked' }, {}, 'D has its own memory search engine, and the base is engine-free'],
      [{ node: 'node:22-slim' }, {}, 'D is built on node:22-slim, not node:24-slim'],
      [{ byHand: ['node'], node: 'node:24-slim' }, {}, 'D was built with node set by hand (node:24-slim), and the base was not'],
      [{}, { byHand: ['channel-plugins'] }, 'the base was built with channel-plugins set by hand (2026.9.8), and D was not'],
      [{ byHand: ['channel-plugins'], channelPlugins: '2026.9.9' }, { byHand: ['channel-plugins'] }, 'D was built with channel-plugins set by hand to 2026.9.9, and the base to 2026.9.8'],
      [{ channels: ['slack'] }, {}, 'D has slack built in, and the base has slack and discord'],
      [{ plugins: [] }, {}, 'D bakes the plugins none, and the base duckduckgo=@openclaw/duckduckgo-plugin and brave=@openclaw/brave-plugin'],
      [{ pluginInstall: 'link' }, {}, 'D installs messaging plugins by link, and the base by npm'],
      [{ packages: ['curl'] }, {}, 'D has curl added, and the base does not'],
      [{ packages: ['jq'] }, { packages: ['jq', 'curl'] }, 'D has jq added, and the base has jq and curl'],
      // Set by hand on both, and other: two digests of one name (said short, HB-1333), other plugins.
      [{ byHand: ['node'], node: `node:24-slim@${L('e')}` }, { byHand: ['node'] }, 'D was built with node set by hand to node:24-slim@sha256:eeeeeeeeeeee…, and the base to node:24-slim@sha256:dddddddddddd…'],
      [{ byHand: ['plugins'], plugins: ['brave=@openclaw/brave-plugin'] }, { byHand: ['plugins'] }, 'D was built with plugins set by hand to brave=@openclaw/brave-plugin, and the base to duckduckgo=@openclaw/duckduckgo-plugin,brave=@openclaw/brave-plugin'],
    ];
    for (const [d, b, why] of refused) expect(inputsDiffer('D', { ...B, ...d }, { ...B, ...b }), why).toBe(why);
    // Set by hand on both, and the same written another way (round-2 review): plugins in another order, a Node by
    // Docker Hub's longer name, with a digest on one side only.
    const sameByHand: Array<[Partial<BuildInputs>, Partial<BuildInputs>]> = [
      [{ byHand: ['plugins'], plugins: [...B.plugins].reverse() }, { byHand: ['plugins'] }],
      [{ byHand: ['node'], node: `docker.io/library/node:24-slim@${L('d')}` }, { byHand: ['node'] }],
      [{ byHand: ['node'], node: 'node:24-slim' }, { byHand: ['node'] }],
      [{ byHand: ['node'], node: 'docker.io/node:24-slim' }, { byHand: ['node'], node: 'node:24-slim' }],
    ];
    for (const [d, b] of sameByHand) expect(inputsDiffer('D', { ...B, ...d }, { ...B, ...b }), JSON.stringify(d)).toBeUndefined();
    // A Node set by hand by its digest alone names that image, not :latest, nor a line (HB-1448).
    const digestOnly: Array<[string, string, string | undefined]> = [
      [`node@${L('e')}`, 'node:latest', 'D was built with node set by hand to node@sha256:eeeeeeeeeeee…, and the base to node:latest'],
      [`node@${L('e')}`, 'node:24-slim', 'D was built with node set by hand to node@sha256:eeeeeeeeeeee…, and the base to node:24-slim'],
      [`node@${L('e')}`, `node@${L('d')}`, 'D was built with node set by hand to node@sha256:eeeeeeeeeeee…, and the base to node@sha256:dddddddddddd…'],
      [`node@${L('e')}`, `docker.io/library/node:24-slim@${L('e')}`, undefined],
      [`node@${L('e')}`, `node@${L('e')}`, undefined],
    ];
    for (const [d, b, why] of digestOnly) expect(inputsDiffer('D', { ...B, byHand: ['node'], node: d }, { ...B, byHand: ['node'], node: b }), `${d} / ${b}`).toBe(why);
    const allowed: Array<[Partial<BuildInputs>, Partial<BuildInputs>]> = [
      [{ node: 'node:24.11.1-slim' }, {}], [{ node: `node:24-slim@${L('e')}` }, {}], [{ claudeCode: '2.1.300' }, {}],
      [{ channelPlugins: '2026.9.9' }, {}], [{ embedPlugin: '2026.9.1' }, {}], [{ release: '' }, {}], [{ release: '2.191.0' }, {}],
      // None of the base's packages: they are laid on. The same ones, in any order.
      [{}, { packages: ['jq'] }], [{ packages: ['curl', 'jq'] }, { packages: ['jq', 'curl'] }],
      [{ byHand: ['node'], node: 'node:26-slim' }, { byHand: ['node'], node: 'node:26-slim' }],
    ];
    for (const [d, b] of allowed) expect(inputsDiffer('D', { ...B, ...d }, { ...B, ...b }), JSON.stringify([d, b])).toBeUndefined();
  });

  it("the advice says each setting by hand, a digest short, while they fit the room, and counts the rest (HB-1333)", () => {
    const w: BuildInputs = { ...B, byHand: ['node', 'plugins', 'plugin-install'] };
    const head = '. Build an engine-free image of OpenClaw 2026.9.8 on garden-shed with ';
    const tail = ", as its base was (scripts/build-runtime-image.sh), then try again, or run it on that machine's default image";
    const node = 'node set by hand to node:24-slim@sha256:dddddddddddd…';
    const all = `${head}${node} and plugins set by hand to ${B.plugins.join(',')} and plugin-install set by hand to npm${tail}`;
    expect(buildAdvice(w, undefined, 'garden-shed', false)).toBe(all);
    expect(buildAdvice(w, undefined, 'garden-shed', false, all.length)).toBe(all);
    const two = `${head}${node} and plugins set by hand to ${B.plugins.join(',')} and 1 more setting set by hand${tail}`;
    expect(buildAdvice(w, undefined, 'garden-shed', false, all.length - 1)).toBe(two);
    expect(buildAdvice(w, undefined, 'garden-shed', false, two.length - 1)).toBe(`${head}${node} and 2 more settings set by hand${tail}`);
    // No room for even the first: counted.
    expect(buildAdvice(w, undefined, 'garden-shed', false, 100)).toBe(`${head}3 settings set by hand${tail}`);
    expect(buildAdvice({ ...B, byHand: ['node'] }, undefined, 'garden-shed', false, 100)).toBe(`${head}1 setting set by hand${tail}`);
  });

  it('by its layers, an image with no label stands for the very image it is; with one, by what it was built from', () => {
    const layers = [L('a'), L('b')];
    expect(standsFor(img('hatchabot-runtime:latest', { layers }), { layers: chainId(layers) })).toEqual({ ok: true, same: true });
    expect(standsFor(img('hatchabot-runtime:latest', { layers: [L('c')] }), { layers: chainId(layers) })).toEqual({ ok: false, why: 'hatchabot-runtime:latest is not the same image' });
    // One built FROM it, its layers beginning with the base's, is not the base by them: the whole chain is compared (HB-1330).
    expect(standsFor(img('hatchabot-runtime:mine', { layers: [...layers, L('c')] }), { layers: chainId(layers) })).toEqual({ ok: false, why: 'hatchabot-runtime:mine is not the same image' });
    expect(pickStandIn([img('hatchabot-runtime:mine', { layers: [...layers, L('c')] })], { layers: chainId(layers) }, { repo: 'hatchabot-runtime' })).not.toHaveProperty('image');
    expect(standsFor(img('hatchabot-runtime:latest'), { inputs: B })).toEqual({ ok: false, why: 'hatchabot-runtime:latest does not say what it was built from' });
    expect(standsFor(img('hatchabot-runtime:latest', { buildInputs: label() }), { inputs: B })).toEqual({ ok: true, same: false });
    // Packages laid on by our own builds count, as the image's own label says.
    expect(standsFor(img('hatchabot-runtime:latest', { buildInputs: label(), extraPackages: ['jq'] }), { inputs: { ...B, packages: ['jq'] } })).toEqual({ ok: true, same: false });
    expect(isDerived(img('hatchabot-runtime:2026.9.8', { derived: 'media' }))).toBe(true);
    expect(isDerived(img('hatchabot-runtime:derived-media'))).toBe(true);
    expect(isDerived(img('hatchabot-runtime:2026.9.8'))).toBe(false);
  });

  it('the one it is built on is the same every time, and never a derived image', () => {
    const repo = 'hatchabot-runtime';
    const tags = [
      img('hatchabot-runtime:zz-trial', { buildInputs: label() }), img('hatchabot-runtime:2026.9.8', { buildInputs: label() }),
      img('hatchabot-runtime:latest', { buildInputs: label() }), img('hatchabot-runtime:aa-trial', { buildInputs: label() }),
      img('hatchabot-runtime:derived-media', { buildInputs: label() }), img('hatchabot-runtime:2026.9.9', { buildInputs: label(), derived: 'other' }),
      img('example-runtime:2026.9.8', { buildInputs: label() }),
    ];
    const pick = (o: { prefer?: string; followsDefault?: boolean }, t = tags, want: Parameters<typeof pickStandIn>[1] = { inputs: B }) => {
      const p = pickStandIn(t, want, { repo, ...o });
      return 'image' in p ? p.image.tag : p.why;
    };
    expect(pick({ prefer: 'hatchabot-runtime:zz-trial', followsDefault: true })).toBe('hatchabot-runtime:zz-trial');
    expect(pick({ followsDefault: true })).toBe('hatchabot-runtime:latest');
    expect(pick({})).toBe('hatchabot-runtime:2026.9.8');
    expect(pick({}, tags.filter((t) => /trial|derived|example|9\.9/.test(t.tag)))).toBe('hatchabot-runtime:aa-trial');
    // The very image beats one built the same way.
    const copy = img('hatchabot-runtime:zz-copy', { layers: [L('a'), L('b')] });
    expect(pick({ followsDefault: true }, [...tags, copy], { inputs: B, layers: chainId([L('a'), L('b')]) })).toBe('hatchabot-runtime:zz-copy');
    // Derived images and other repositories are never one, however built.
    expect(pick({}, tags.filter((t) => /derived|9\.9|example/.test(t.tag)))).toBe('it has no runtime image yet');
    expect(pick({}, [img('hatchabot-runtime:latest', { buildInputs: label({ openclaw: '2026.9.6' }) }), img('hatchabot-runtime:aa', {})]))
      .toBe('hatchabot-runtime:latest runs OpenClaw 2026.9.6, not 2026.9.8');
    expect(pick({}, [])).toBe('it has no runtime image yet');
  });
});

describe("a recipe's base on another machine (HB-0986)", () => {
  const TAG = 'hatchabot-runtime:derived-media';
  const derived = (o: Record<string, unknown> = {}) => ({ name: 'media', tag: TAG, base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', status: 'READY', ...o }) as never;
  /** A machine whose derived image is built on `base`, its labels and layers as docker gives them. */
  const source = (base: Partial<ImageTagInfo>, rec = derived()) => {
    const p = new MockProvider();
    const baseTag = (rec as { base: string }).base;
    p.tags = [img(baseTag, { openclawVersion: '2026.9.8', ...base }), img(TAG, { openclawVersion: '2026.9.8', ...base, layers: [...(base.layers ?? []), L('3')], derived: 'media' })];
    return { p, byTag: (t: string) => (t === TAG ? rec : undefined) };
  };

  it('a derived image carries what its base was built from, every package under its lines, and its base\'s layers while its tag names that image', async () => {
    const { p, byTag } = source({ buildInputs: label({ packages: ['jq'] }), extraPackages: ['jq'], layers: [L('1'), L('2')] }, derived({ basePackages: ['curl'] }));
    const r = await recipeFor(p, TAG, byTag);
    expect(r).toMatchObject({ tag: TAG, base: 'hatchabot-runtime:latest', packages: ['jq', 'curl'], lines: 'RUN true', layers: chainId([L('1'), L('2')]) });
    // Its record's base packages too: a Rebuild here labels none (HB-0986 review).
    expect(parseBuildInputs((r as { inputs: string }).inputs)).toMatchObject({ ok: true, inputs: { openclaw: '2026.9.8', packages: ['jq', 'curl'] } });
    expect(recipeProblem(r as never)).toBeNull();
    // :latest has moved on since it was built: its layers are another image's.
    p.tags[0]!.layers = [L('9')];
    expect((await recipeFor(p, TAG, byTag) as { layers?: string }).layers).toBeUndefined();
  });

  it('a runner with only its own :latest, a copy of the same image, builds on it: nothing pulled, nothing laid on', async () => {
    // Install image put the very image there, unlabelled as it was built.
    const { p, byTag } = source({ layers: [L('1'), L('2')] });
    const runner = new MockProvider();
    runner.tags = [img('hatchabot-runtime:latest', { layers: [L('1'), L('2')] })];
    expect(await ensureImageOn(runner, p, TAG, byTag, 'garden-shed')).toMatchObject({ ok: true, built: true });
    expect(runner.pulled).toEqual([]);
    expect(runner.built.map((b) => b.dockerfile)).toEqual(['FROM hatchabot-runtime:latest\nUSER root\nRUN true\nUSER node\n']);
    expect(runner.built[0]!.labels).toMatchObject({ 'org.hatchabot.derived': 'media', 'org.hatchabot.rebuilt-from-recipe': '1' });
  });

  describe('an image of the same name already on the other machine is checked, not taken by its name (HB-1325)', () => {
    const PLUS = 'hatchabot-runtime:2026.9.8-plus-jq';
    /** This machine, with an image of extra packages agents are pinned to. */
    const plus = () => {
      const p = new MockProvider();
      p.tags = [img(PLUS, { openclawVersion: '2026.9.8', buildInputs: label({ packages: ['jq'] }), extraPackages: ['jq'], layers: [L('1'), L('2')] })];
      return p;
    };
    const runner = (o: Partial<ImageTagInfo>) => { const m = new MockProvider(); m.tags = [img(PLUS, o)]; return m; };
    const none = () => undefined;

    it('built another way there, as both labels say, is refused, saying how, and left as it is', async () => {
      const older = runner({ buildInputs: label({ openclaw: '2026.9.6', packages: ['jq'] }), extraPackages: ['jq'], layers: [L('a')] });
      expect(await ensureImageOn(older, plus(), PLUS, none, 'garden-shed')).toEqual({ ok: false, differs: true, problem: 'the one there runs OpenClaw 2026.9.6, not 2026.9.8' });
      const engine = runner({ buildInputs: label({ engine: 'baked', packages: ['jq'] }), extraPackages: ['jq'], layers: [L('a')] });
      const lite = new MockProvider();
      lite.tags = [img(PLUS, { openclawVersion: '2026.9.8', buildInputs: label({ engine: 'none', packages: ['jq'] }), extraPackages: ['jq'], layers: [L('1'), L('2')] })];
      expect(await ensureImageOn(engine, lite, PLUS, none, 'garden-shed')).toEqual({ ok: false, differs: true, problem: "the one there has its own memory search engine, and the agent's is engine-free" });
      const without = runner({ buildInputs: label(), layers: [L('a')] });
      expect(await ensureImageOn(without, plus(), PLUS, none, 'garden-shed')).toEqual({ ok: false, differs: true, problem: "the one there has nothing added, and the agent's has jq" });
      for (const m of [older, engine, without]) { expect(m.built).toEqual([]); expect(m.tagged).toEqual([]); expect(m.pulled).toEqual([]); }
    });

    it('the same files, or built the same way with the same packages (another CPU), is taken as it is', async () => {
      const copy = runner({ layers: [L('1'), L('2')] });
      expect(await ensureImageOn(copy, plus(), PLUS, none, 'garden-shed')).toEqual({ ok: true, built: false });
      const otherCpu = runner({ buildInputs: label({ packages: ['jq'], release: '2.191.0' }), extraPackages: ['jq'], layers: [L('b'), L('c')] });
      expect(await ensureImageOn(otherCpu, plus(), PLUS, none, 'garden-shed')).toEqual({ ok: true, built: false });
      expect([...copy.built, ...otherCpu.built]).toEqual([]);
    });

    it("layers alone never refuse it: images from before the label, with their layers as every real listing has them, are taken by name, back home too (HB-1325 review)", async () => {
      // Built by 2.190.0 or older: no build-inputs label, and a runner's copy rebuilt from the recipe has layers of its own.
      const home = () => { const p = new MockProvider(); p.tags = [img(PLUS, { openclawVersion: '2026.9.8', extraPackages: ['jq'], layers: [L('1'), L('2')] })]; return p; };
      const there = () => runner({ openclawVersion: '2026.9.8', extraPackages: ['jq'], layers: [L('8'), L('9')] });
      expect(await ensureImageOn(there(), home(), PLUS, none, 'garden-shed')).toEqual({ ok: true, built: false });
      expect(await ensureImageOn(home(), there(), PLUS, none, 'this machine', true)).toEqual({ ok: true, built: false });
      // Only one of the two says: nothing to compare, so by name too.
      const labelled = runner({ buildInputs: label({ openclaw: '2026.9.6', packages: ['jq'] }), extraPackages: ['jq'], layers: [L('8')] });
      expect(await ensureImageOn(labelled, home(), PLUS, none, 'garden-shed')).toEqual({ ok: true, built: false });
      expect(await ensureImageOn(there(), plus(), PLUS, none, 'garden-shed')).toEqual({ ok: true, built: false });
      // This machine's images unread: by name.
      const unread = plus();
      unread.listImageTags = async () => { throw new Error('daemon busy'); };
      expect(await ensureImageOn(there(), unread, PLUS, none, 'garden-shed')).toEqual({ ok: true, built: false });
    });

    it("a derived image there is taken when its stamp says it was built from the record; built again from other lines or other packages (HB-1325 review)", async () => {
      const { p, byTag } = source({ layers: [L('1'), L('2')] });
      const stamp = recipeStamp('hatchabot-runtime:latest', 'RUN true', []);
      const runner = (o: Partial<ImageTagInfo>) => {
        const m = new MockProvider();
        m.tags = [img('hatchabot-runtime:latest', { layers: [L('1'), L('2')] }), img(TAG, { layers: [L('1'), L('2'), L('7')], derived: 'media', ...o })];
        return m;
      };
      // Built there from this record (its layers its own): taken, nothing built, nothing pulled.
      const same = runner({ recipe: stamp });
      expect(await ensureImageOn(same, p, TAG, byTag, 'garden-shed')).toEqual({ ok: true, built: false });
      expect([...same.built, ...same.pulled]).toEqual([]);
      // Stamped from other lines (the record was rebuilt since): built again from the record.
      const stale = runner({ recipe: recipeStamp('hatchabot-runtime:latest', 'RUN false') });
      expect(await ensureImageOn(stale, p, TAG, byTag, 'garden-shed')).toMatchObject({ ok: true, built: true });
      expect(stale.built.map((b) => b.dockerfile)).toEqual(['FROM hatchabot-runtime:latest\nUSER root\nRUN true\nUSER node\n']);
      expect(stale.built[0]!.labels['org.hatchabot.recipe']).toBe(stamp);
      // The record's base packages changed since (Change base): its stamp says other packages, so built again.
      const { p: more, byTag: moreBy } = source({ layers: [L('1'), L('2')] }, derived({ basePackages: ['curl'] }));
      const before = runner({ recipe: stamp });
      expect(await ensureImageOn(before, more, TAG, moreBy, 'garden-shed')).toMatchObject({ ok: true, built: true });
      expect(before.built[0]!.labels['org.hatchabot.recipe']).toBe(recipeStamp('hatchabot-runtime:latest', 'RUN true', ['curl']));
      // The very image (a copy) is taken as it is.
      const copied = new MockProvider();
      copied.tags = [img(TAG, { layers: [L('1'), L('2'), L('3')], derived: 'media' })];
      expect(await ensureImageOn(copied, p, TAG, byTag, 'garden-shed')).toEqual({ ok: true, built: false });
      expect(copied.built).toEqual([]);
    });

    it("the same stamp on another OpenClaw or engine, under the same base name (:latest moved), is built again on what the agent's is built on (HB-1325 review)", async () => {
      // Home: derived-media on an engine-free 2026.9.8 :latest. The runner's copy: the same stamp, built when its :latest was a baked 2026.9.6.
      const { p, byTag } = source({ buildInputs: label({ engine: 'none' }), layers: [L('1'), L('2')] });
      const there = new MockProvider();
      there.tags = [
        img('hatchabot-runtime:latest', { buildInputs: label({ engine: 'none' }), layers: [L('5')] }),
        img(TAG, { buildInputs: label({ openclaw: '2026.9.6', engine: 'baked' }), layers: [L('8'), L('9')], derived: 'media', recipe: recipeStamp('hatchabot-runtime:latest', 'RUN true', []) }),
      ];
      expect(await ensureImageOn(there, p, TAG, byTag, 'garden-shed')).toMatchObject({ ok: true, built: true });
      expect(there.built.map((b) => b.dockerfile)).toEqual(['FROM hatchabot-runtime:latest\nUSER root\nRUN true\nUSER node\n']);
      // Built on the same inputs, its layers its own: taken.
      const same = new MockProvider();
      same.tags = [img(TAG, { buildInputs: label({ engine: 'none', release: '2.191.0' }), layers: [L('8')], derived: 'media', recipe: recipeStamp('hatchabot-runtime:latest', 'RUN true', []) })];
      expect(await ensureImageOn(same, p, TAG, byTag, 'garden-shed')).toEqual({ ok: true, built: false });
    });

    it('one from before the stamp is built again once, which stamps it; taken by name only when that build cannot run, never when its lines or their image are refused (HB-1325 review)', async () => {
      const { p, byTag } = source({ layers: [L('1'), L('2')] });
      const runner = () => {
        const m = new MockProvider();
        m.tags = [img('hatchabot-runtime:latest', { layers: [L('1'), L('2')] }), img(TAG, { layers: [L('1'), L('2'), L('7')], derived: 'media' })];
        return m;
      };
      const old = runner();
      expect(await ensureImageOn(old, p, TAG, byTag, 'garden-shed')).toMatchObject({ ok: true, built: true });
      expect(old.tags.find((t) => t.tag === TAG)?.recipe).toBe(recipeStamp('hatchabot-runtime:latest', 'RUN true', []));
      // apt failing there, or its base not to be had: the old one, by name, as before.
      const offline = runner();
      offline.buildFails = true;
      expect(await ensureImageOn(offline, p, TAG, byTag, 'garden-shed')).toEqual({ ok: true, built: false });
      const noBase = new MockProvider();
      noBase.tags = [img(TAG, { layers: [L('7')], derived: 'media' })];
      expect(await ensureImageOn(noBase, p, TAG, byTag, 'garden-shed')).toEqual({ ok: true, built: false });
      // Lines refused today, or an image they made that would run as root: refused, the old one not taken.
      const { p: bad, byTag: badBy } = source({ layers: [L('1'), L('2')] }, derived({ dockerfile: 'RUN --security=insecure true' }));
      expect(await ensureImageOn(runner(), bad, TAG, badBy, 'garden-shed')).toEqual({ ok: false, problem: 'RUN --security is not allowed in a derived image.', refused: true });
      const root = runner();
      root.buildRunsAs = 'root';
      expect(await ensureImageOn(root, p, TAG, byTag, 'garden-shed')).toMatchObject({ ok: false, problem: expect.stringMatching(/^the rebuild failed: The built image would run as root/) });
    });

    it("a base retagged there while one from before the stamp is built again is a build that could not run, not a refusal (HB-1448)", async () => {
      const { p, byTag } = source({ layers: [L('1'), L('2')] });
      /** A promote there as the build starts: its base's name is another image's by the time it is built on. */
      class Promoted extends MockProvider {
        override async buildImage(tag: string, dockerfile: string, labels: Record<string, string>) {
          this.tags = this.tags.map((t) => (t.tag === 'hatchabot-runtime:latest' ? { ...t, imageId: 'promoted', layers: [L('5')] } : t));
          return super.buildImage(tag, dockerfile, labels);
        }
      }
      const there = new Promoted();
      there.tags = [img('hatchabot-runtime:latest', { layers: [L('1'), L('2')] }), img(TAG, { layers: [L('1'), L('2'), L('7')], derived: 'media' })];
      expect(await buildRecipeOn(there, { tag: TAG, base: 'hatchabot-runtime:latest', packages: [], channels: [], lines: 'RUN true' }, { where: 'garden-shed' }))
        .toEqual({ ok: false, problem: "garden-shed's image hatchabot-runtime:latest changed just now — try again" });
      // A move then takes the old one by name, as for any build that could not run.
      const again = new Promoted();
      again.tags = [img('hatchabot-runtime:latest', { layers: [L('1'), L('2')] }), img(TAG, { layers: [L('1'), L('2'), L('7')], derived: 'media' })];
      expect(await ensureImageOn(again, p, TAG, byTag, 'garden-shed')).toEqual({ ok: true, built: false });
      expect(again.tags.find((t) => t.tag === TAG)?.imageId).toBe(`id-${TAG}`);
      // Any other refusal stays one, the base moved or not: an image that would run as root.
      const root = new Promoted();
      root.tags = [img('hatchabot-runtime:latest', { layers: [L('1'), L('2')] }), img(TAG, { layers: [L('1'), L('2'), L('7')], derived: 'media' })];
      root.buildRunsAs = 'root';
      expect(await ensureImageOn(root, p, TAG, byTag, 'garden-shed')).toMatchObject({ ok: false, problem: expect.stringMatching(/^the rebuild failed: The built image would run as root/), refused: true });
      // The base where it was: an image not built on it is still refused.
      const hidden = new MockProvider();
      hidden.tags = [img('hatchabot-runtime:latest', { layers: [L('1'), L('2')] }), img(TAG, { layers: [L('1'), L('2'), L('7')], derived: 'media' })];
      hidden.buildLayers = [L('9')];
      expect(await ensureImageOn(hidden, p, TAG, byTag, 'garden-shed')).toMatchObject({ ok: false, problem: expect.stringMatching(/^the rebuild failed: The built image is not built on hatchabot-runtime:latest/), refused: true });
    });

    it('built there by one move, the next move takes it, though the runner cannot build now (offline, or apt failing)', async () => {
      const { p, byTag } = source({ layers: [L('1'), L('2')] });
      const there = new MockProvider();
      there.tags = [img('hatchabot-runtime:latest', { layers: [L('1'), L('2')] })];
      expect(await ensureImageOn(there, p, TAG, byTag, 'garden-shed')).toMatchObject({ ok: true, built: true });
      there.buildFails = true;
      expect(await ensureImageOn(there, p, TAG, byTag, 'garden-shed')).toEqual({ ok: true, built: false });
      expect(there.built).toHaveLength(1);
    });

    it('moved back to the machine whose records they are, its own derived image is the record\'s: taken, not built over', async () => {
      // The runner's copy was built from the record there, so its layers are not this machine's.
      const { p: runnerCopy, byTag } = source({ layers: [L('5'), L('6')] });
      const home = new MockProvider();
      home.tags = [img('hatchabot-runtime:latest', { layers: [L('1'), L('2')] }), img(TAG, { layers: [L('1'), L('2'), L('3')], derived: 'media' })];
      expect(await ensureImageOn(home, runnerCopy, TAG, byTag, 'this machine', true)).toEqual({ ok: true, built: false });
      expect(home.built).toEqual([]);
    });
  });

  it('on another CPU, the published image of that OpenClaw stands for it, and the packages its base had are laid on', async () => {
    const { p, byTag } = source({ buildInputs: label({ packages: ['jq'] }), extraPackages: ['jq'], layers: [L('1'), L('2')] }, derived({ base: 'hatchabot-runtime:2026.9.8-plus-jq' }));
    const runner = new MockProvider();
    runner.tags = [img('hatchabot-runtime:latest', { buildInputs: label({ openclaw: '2026.9.6' }), layers: [L('a')] })];
    runner.publishedBases.add('hatchabot-runtime:2026.9.8');
    runner.publishedInfo.set('hatchabot-runtime:2026.9.8', { buildInputs: label({ release: '2.191.0', node: `node:24-slim@${L('e')}` }), layers: [L('b'), L('c')] });
    expect(await ensureImageOn(runner, p, TAG, byTag, 'garden-shed')).toMatchObject({ ok: true, built: true });
    expect(runner.pulled).toEqual(['hatchabot-runtime:2026.9.8']);
    expect(runner.built[0]!.dockerfile).toBe('FROM hatchabot-runtime:2026.9.8\nUSER root\nRUN apt-get update && apt-get install -y --no-install-recommends jq && rm -rf /var/lib/apt/lists/*\nRUN true\nUSER node\n');
    // As a base, it now says it has jq.
    expect(runner.built[0]!.labels['org.hatchabot.extra-packages']).toBe('jq');
  });

  it(':latest promoted from a base with packages stands for that base; a hand-made build under a version\'s name does not', async () => {
    const { p, byTag } = source({ buildInputs: label({ packages: ['jq'] }), extraPackages: ['jq'], layers: [L('1'), L('2')] });
    const promoted = new MockProvider();
    promoted.tags = [img('hatchabot-runtime:latest', { buildInputs: label({ packages: ['jq'] }), extraPackages: ['jq'], layers: [L('x')] })];
    expect(await ensureImageOn(promoted, p, TAG, byTag, 'garden-shed')).toMatchObject({ ok: true, built: true });
    expect(promoted.built[0]!.dockerfile).toBe('FROM hatchabot-runtime:latest\nUSER root\nRUN true\nUSER node\n');

    // IMAGE_TAG=2026.9.8 NODE_IMAGE=node:26-slim: the version's name, another Node.
    const handMade = new MockProvider();
    handMade.tags = [img('hatchabot-runtime:2026.9.8', { buildInputs: label({ node: 'node:26-slim', byHand: ['node'] }) })];
    const asked: string[] = [];
    const ensure = handMade.ensureBaseImage.bind(handMade);
    handMade.ensureBaseImage = async (t: string) => { asked.push(t); return ensure(t); };
    expect(await ensureImageOn(handMade, p, TAG, byTag, 'garden-shed')).toEqual({
      ok: false,
      problem: "no image on garden-shed is built the way hatchabot-runtime:derived-media's base is: hatchabot-runtime:2026.9.8 is built on node:26-slim, not node:24-slim. Build an engine-free image of OpenClaw 2026.9.8 with jq on this machine (Settings → Advanced → Runtime images), make it this machine's default and copy it to garden-shed (Settings → Hosts → Check, then Install image or Update image, offered when its image is missing or runs another OpenClaw), then try again, or run it on that machine's default image",
    });
    expect(handMade.built).toEqual([]);
    expect(asked).toEqual(['hatchabot-runtime:2026.9.8']);
  });

  it('how to build what stands for it there comes from what its base was built from, or no build from Settings is offered (HB-0986 review)', async () => {
    const runner = (o: Partial<BuildInputs> = {}) => { const m = new MockProvider(); m.tags = [img('hatchabot-runtime:latest', { buildInputs: label(o) })]; return m; };
    const why = (s: string) => `no image on garden-shed is built the way hatchabot-runtime:derived-media's base is: ${s}`;
    const byHand = source({ buildInputs: label({ node: 'node:22-bookworm', byHand: ['node'] }), layers: [L('1')] });
    expect(await ensureImageOn(runner(), byHand.p, TAG, byHand.byTag, 'garden-shed')).toEqual({ ok: false, problem: why("hatchabot-runtime:latest is built on node:24-slim, not node:22-bookworm. Build an engine-free image of OpenClaw 2026.9.8 on garden-shed with node set by hand to node:22-bookworm, as its base was (scripts/build-runtime-image.sh), then try again, or run it on that machine's default image") });
    const fewer = source({ buildInputs: label({ channels: ['slack'] }), layers: [L('1')] });
    expect(await ensureImageOn(runner(), fewer.p, TAG, fewer.byTag, 'garden-shed')).toEqual({ ok: false, problem: why("hatchabot-runtime:latest has slack and discord built in, and the base has slack; an image built from Settings on this machine and installed there would not be either (it would have slack and discord built in, not slack), so run it on that machine's default image") });
    const jq = source({ buildInputs: label({ packages: ['jq'] }), extraPackages: ['jq'], layers: [L('1')] });
    expect(await ensureImageOn(runner({ openclaw: '2026.9.6' }), jq.p, TAG, jq.byTag, 'garden-shed')).toEqual({ ok: false, problem: why("hatchabot-runtime:latest runs OpenClaw 2026.9.6, not 2026.9.8. Build an engine-free image of OpenClaw 2026.9.8 with jq on this machine (Settings → Advanced → Runtime images), make it this machine's default and copy it to garden-shed (Settings → Hosts → Check, then Install image or Update image, offered when its image is missing or runs another OpenClaw), then try again, or run it on that machine's default image") });
  });

  it("a build from Settings is judged by this release's Dockerfile, not by the machine's :latest (HB-1323)", async () => {
    const runner = (o: Partial<BuildInputs> = {}) => { const m = new MockProvider(); m.tags = [img('hatchabot-runtime:latest', { buildInputs: label(o) })]; return m; };
    const why = (s: string) => `no image on garden-shed is built the way hatchabot-runtime:derived-media's base is: ${s}`;
    const dfNode = nodeLine(defaults.get('NODE_IMAGE')!), dfChannels = defaults.get('CHANNEL_PLUGINS')!.split(',');
    expect(defaults.get('OPENCLAW_VERSION')).toBe(B.openclaw);
    expect(dfNode).not.toBe('node:22-bookworm');
    // The base is on this release's Node line; :latest there is an older release's image on another: a build from Settings would do.
    const onRelease = source({ buildInputs: label({ node: defaults.get('NODE_IMAGE')!, channels: dfChannels }), layers: [L('1')] });
    expect(await ensureImageOn(runner({ node: 'node:22-bookworm', channels: dfChannels }), onRelease.p, TAG, onRelease.byTag, 'garden-shed')).toEqual({ ok: false, problem: why(`hatchabot-runtime:latest is built on node:22-bookworm, not ${dfNode}. Build an engine-free image of OpenClaw ${B.openclaw} on this machine (Settings → Advanced → Runtime images), make it this machine's default and copy it to garden-shed (Settings → Hosts → Check, then Install image or Update image, offered when its image is missing or runs another OpenClaw), then try again, or run it on that machine's default image`) });
    // The other way: :latest is on the base's Node line, which this release's build from Settings is not.
    const older = source({ buildInputs: label({ node: 'node:22-bookworm', channels: dfChannels }), layers: [L('1')] });
    expect(await ensureImageOn(runner({ node: 'node:22-bookworm', channels: [] }), older.p, TAG, older.byTag, 'garden-shed')).toEqual({ ok: false, problem: why(`hatchabot-runtime:latest has none built in, and the base has ${dfChannels.join(' and ')}; an image built from Settings on this machine and installed there would not be either (it would be built on ${dfNode}, not node:22-bookworm), so run it on that machine's default image`) });
  });

  it('a hand-made image FROM the base that changes only how it runs (USER root, an ENV) has its layers and label, and stands for it no more (HB-1330)', async () => {
    const runs = (o: { node?: string; user?: string; env?: string[] } = {}) => runConfigId({
      User: o.user ?? 'node', Entrypoint: ['agentclaw-entrypoint'], Cmd: ['openclaw', 'gateway'],
      Env: ['PATH=/usr/local/bin:/usr/bin:/bin', `NODE_VERSION=${o.node ?? '24.1.0'}`, 'HOME=/home/node', ...(o.env ?? [])],
    })!;
    const RUNS = runs(), ROOT = runs({ user: 'root' });
    const { p, byTag } = source({ buildInputs: label(), layers: [L('1'), L('2')], config: RUNS });
    const r = await recipeFor(p, TAG, byTag) as ImageRecipe;
    expect(r).toMatchObject({ layers: chainId([L('1'), L('2')]), config: RUNS });
    expect(recipeProblem(r)).toBeNull();
    expect(recipeProblem({ ...r, config: 'root' })).toBe('how its base runs is not valid');
    const want = { inputs: B, layers: chainId([L('1'), L('2')]), config: RUNS };
    const hand = img('hatchabot-runtime:latest', { buildInputs: label(), layers: [L('1'), L('2')], config: ROOT });
    const differ = { ok: false, why: 'hatchabot-runtime:latest does not run as the base does: its user, entrypoint, command, environment, volumes, working folder or the rest of how it runs differ', runsOtherwise: true };
    // By its layers, or by its label (one that added a layer too).
    expect(standsFor(hand, want)).toEqual(differ);
    expect(standsFor({ ...hand, layers: [L('1'), L('2'), L('3')] }, want)).toEqual(differ);
    // What it was built from is said first.
    expect(standsFor({ ...hand, layers: [L('7')], buildInputs: label({ openclaw: '2026.9.6' }) }, want)).toEqual({ ok: false, why: 'hatchabot-runtime:latest runs OpenClaw 2026.9.6, not 2026.9.8' });
    expect(standsFor({ ...hand, config: RUNS }, want)).toEqual({ ok: true, same: true });
    expect(standsFor({ ...hand, layers: [L('7')], config: RUNS }, want)).toEqual({ ok: true, same: false });
    // Not said on either side (a recipe or file from before it, a listing that did not say): not compared, as before.
    expect(standsFor({ ...hand, config: undefined }, want)).toEqual({ ok: true, same: true });
    expect(standsFor(hand, { ...want, config: undefined })).toEqual({ ok: true, same: true });

    // An ENV of its own is running otherwise too.
    expect(standsFor({ ...hand, config: runs({ env: ['HTTP_PROXY=http://proxy.example:3128'] }) }, want)).toEqual(differ);
    // A runner whose only image is the hand-made one: the published image is pulled and built on, not it,
    // though that is built on another patch of the same Node, as it may be.
    const runner = new MockProvider();
    runner.tags = [hand];
    runner.publishedBases.add('hatchabot-runtime:2026.9.8');
    runner.publishedInfo.set('hatchabot-runtime:2026.9.8', { buildInputs: label({ node: `node:24-slim@${L('e')}` }), layers: [L('b'), L('c')], config: runs({ node: '24.3.0' }) });
    expect(await ensureImageOn(runner, p, TAG, byTag, 'garden-shed')).toMatchObject({ ok: true, built: true });
    expect(runner.pulled).toEqual(['hatchabot-runtime:2026.9.8']);
    expect(runner.built.map((b) => b.dockerfile)).toEqual(['FROM hatchabot-runtime:2026.9.8\nUSER root\nRUN true\nUSER node\n']);
    // Nothing published: it says why, and builds nothing; a derived image's base is built the same way there,
    // whichever of the two was built by hand (HB-1330 review).
    const none = new MockProvider();
    none.tags = [hand];
    expect(await ensureImageOn(none, p, TAG, byTag, 'garden-shed')).toEqual({ ok: false, problem: "no image on garden-shed runs as hatchabot-runtime:derived-media's base hatchabot-runtime:latest does: hatchabot-runtime:latest there is built the same way and runs otherwise (its user, entrypoint, command, environment, volumes, working folder or the rest of how it runs), so one of them was built by hand. Build that base the same way on garden-shed, or run it on that machine's default image" });
    expect(none.built).toEqual([]);
    // A recipe from before it, the same runner: built on the hand-made image, as before.
    const older = new MockProvider();
    older.tags = [hand];
    expect(await buildRecipeOn(older, { ...r, config: undefined }, { where: 'garden-shed' })).toMatchObject({ ok: true, built: true, base: 'hatchabot-runtime:latest' });
  });

  it("an image pinned to a hand-made image that runs otherwise is refused on a stock image of its layers and label, and the other way round, in words that give each side its own fix (HB-1330 review)", async () => {
    const runs = (env: string[] = []) => runConfigId({ User: 'node', Entrypoint: ['agentclaw-entrypoint'], Cmd: ['openclaw', 'gateway'], Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/home/node', ...env] })!;
    const STOCK = { buildInputs: label(), openclawVersion: '2026.9.8', layers: [L('1'), L('2')], config: runs() };
    // FROM hatchabot-runtime:2026.9.8 + ENV HTTP_PROXY=…: its layers and label, and its own config.
    const src = new MockProvider();
    src.tags = [img('hatchabot-runtime:2026.9.8', STOCK), img('hatchabot-runtime:proxy', { ...STOCK, config: runs(['HTTP_PROXY=http://proxy.example:3128']) })];
    const runner = new MockProvider();
    runner.tags = [img('hatchabot-runtime:2026.9.8', STOCK), img('hatchabot-runtime:latest', STOCK)];
    const got = await ensureImageOn(runner, src, 'hatchabot-runtime:proxy', () => undefined, 'garden-shed');
    // Which was built by hand is not known there: each is said with its own fix, a build of the same again only for the image there.
    expect(got).toEqual({ ok: false, problem: "no image on garden-shed runs as hatchabot-runtime:proxy does: hatchabot-runtime:2026.9.8 there is built the same way and runs otherwise (its user, entrypoint, command, environment, volumes, working folder or the rest of how it runs), so one of them was built by hand: if it is hatchabot-runtime:2026.9.8, build an engine-free image of OpenClaw 2026.9.8 on this machine (Settings → Advanced → Runtime images), make it this machine's default and copy it to garden-shed (Settings → Hosts → Check, then Install image or Update image, offered when its image is missing or runs another OpenClaw) or take hatchabot-runtime:2026.9.8 out of the runtime repository; if it is hatchabot-runtime:proxy, make it a derived image where it was made, so its lines travel; or run it on that machine's default image" });
    expect(runner.built).toEqual([]);
    // The other way round (HB-1330 review): the stock image moves, and the only one there is the hand-made :mine.
    const mine = new MockProvider();
    mine.tags = [img('hatchabot-runtime:mine', { ...STOCK, config: runs(['HTTP_PROXY=http://proxy.example:3128']) })];
    const other = await ensureImageOn(mine, src, 'hatchabot-runtime:2026.9.8', () => undefined, 'garden-shed');
    expect(other).toEqual({ ok: false, problem: "no image on garden-shed runs as hatchabot-runtime:2026.9.8 does: hatchabot-runtime:mine there is built the same way and runs otherwise (its user, entrypoint, command, environment, volumes, working folder or the rest of how it runs), so one of them was built by hand: if it is hatchabot-runtime:mine, build an engine-free image of OpenClaw 2026.9.8 on this machine (Settings → Advanced → Runtime images), make it this machine's default and copy it to garden-shed (Settings → Hosts → Check, then Install image or Update image, offered when its image is missing or runs another OpenClaw) or take hatchabot-runtime:mine out of the runtime repository; if it is hatchabot-runtime:2026.9.8, make it a derived image where it was made, so its lines travel; or run it on that machine's default image" });
    // Each fix said for :mine works: the stock image built there, or :mine taken out and the published one pulled.
    mine.tags.push(img('hatchabot-runtime:2026.9.8', STOCK));
    expect(await ensureImageOn(mine, src, 'hatchabot-runtime:2026.9.8', () => undefined, 'garden-shed')).toMatchObject({ ok: true });
    mine.publishedBases.add('hatchabot-runtime:2026.9.8');
    mine.publishedInfo.set('hatchabot-runtime:2026.9.8', STOCK);
    mine.tags = [];
    expect(await ensureImageOn(mine, src, 'hatchabot-runtime:2026.9.8', () => undefined, 'garden-shed')).toMatchObject({ ok: true });
    expect(mine.pulled).toEqual(['hatchabot-runtime:2026.9.8']);
    // Said so though another image there differs by more, and the one that only runs otherwise is not the default.
    runner.tags = [img('hatchabot-runtime:latest', { ...STOCK, buildInputs: label({ openclaw: '2026.9.6' }), layers: [L('9')] }), img('hatchabot-runtime:2026.9.8', STOCK)];
    expect(await ensureImageOn(runner, src, 'hatchabot-runtime:proxy', () => undefined, 'garden-shed')).toMatchObject({ ok: false, problem: expect.stringMatching(/^no image on garden-shed runs as hatchabot-runtime:proxy does: hatchabot-runtime:2026\.9\.8 there /) });
    // A stock image of it moves as before.
    const plain = await ensureImageOn(runner, src, 'hatchabot-runtime:2026.9.8', () => undefined, 'garden-shed');
    expect(plain).toMatchObject({ ok: true });
  });

  it('a hand-made image FROM the base with only a VOLUME or an ONBUILD runs otherwise too; a stock one still stands for it (HB-1330 review)', () => {
    const RUNS = { User: 'node', Entrypoint: ['agentclaw-entrypoint'], Cmd: ['openclaw', 'gateway'], Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/home/node'] };
    const want = { inputs: B, layers: chainId([L('1'), L('2')]), config: runConfigId(RUNS) };
    const on = (config: Record<string, unknown>) => img('hatchabot-runtime:latest', { buildInputs: label(), layers: [L('1'), L('2')], config: runConfigId(config) });
    for (const by of [{ Volumes: { '/home/node/.openclaw': {} } }, { OnBuild: ['RUN rm -rf /home/node'] }, { WorkingDir: '/tmp' }, { Shell: ['/bin/bash', '-c'] }, { StopSignal: 'SIGKILL' }]) {
      expect(standsFor(on({ ...RUNS, ...by }), want), JSON.stringify(by)).toMatchObject({ ok: false, runsOtherwise: true });
    }
    // None said is none: docker's null, podman leaving it out.
    expect(standsFor(on({ ...RUNS, Volumes: null, WorkingDir: '', OnBuild: null, Shell: null, StopSignal: '' }), want)).toEqual({ ok: true, same: true });
    // No working folder is `/`, where a container then runs (HB-1330 review).
    expect(runConfigId({ ...RUNS, WorkingDir: '/' })).toBe(runConfigId(RUNS));
    expect(runConfigId({ ...RUNS, WorkingDir: '' })).toBe(runConfigId(RUNS));
    expect(standsFor(on(RUNS), want)).toEqual({ ok: true, same: true });
    // A versioned id, of the one version this release makes.
    expect(runConfigId(RUNS)).toMatch(/^v1:sha256:[a-f0-9]{64}$/);
    for (const bad of [{ ...RUNS, Volumes: ['/home/node'] }, { ...RUNS, WorkingDir: 7 }]) expect(runConfigId(bad)).toBeUndefined();
  });

  it("in an import's room, every list in the words is counted past what fits: the packages, and the plugins of the first difference (HB-1333 review)", async () => {
    const channels = defaults.get('CHANNEL_PLUGINS')!.split(',');
    const packages = Array.from({ length: 20 }, (_, i) => `libexample-tool-number-${i}-dev-extra-long-name`);
    const plugins = (who: string) => Array.from({ length: 8 }, (_, i) => `${who}${i}=@example/${who}-plugin-number-${i}`);
    const r: ImageRecipe = { tag: 'hatchabot-runtime:2026.9.8-plus-many', base: 'hatchabot-runtime:2026.9.8', packages, channels: [], inputs: label({ packages, channels, plugins: plugins('mine') }) };
    expect(recipeProblem(r)).toBeNull();
    const runner = new MockProvider();
    runner.tags = [img('hatchabot-runtime:latest', { buildInputs: label({ channels, plugins: plugins('theirs') }) })];
    const whole = await buildRecipeOn(runner, r, { where: 'garden-shed' }) as { problem: string };
    expect(whole.problem.length).toBeGreaterThan(1500);
    expect(whole.problem).toContain(packages.at(-1));
    // A runner's words say how a build gets there (HB-1515): a room of 660 for them.
    const fit = await buildRecipeOn(runner, r, { where: 'garden-shed', room: 660 }) as { problem: string };
    expect(fit.problem.length).toBeLessThanOrEqual(660);
    expect(fit.problem).toMatch(/^no image on garden-shed is built the way hatchabot-runtime:2026\.9\.8-plus-many's base is: hatchabot-runtime:latest bakes the plugins theirs0=@example\/theirs-plugin-number-0.* and \d+ more, and the base mine0=.* and \d+ more\. Build an engine-free image of OpenClaw 2026\.9\.8 with libexample-tool-number-0-dev-extra-long-name.* and \d+ more on this machine \(Settings → Advanced → Runtime images\), make it this machine's default and copy it to garden-shed \(Settings → Hosts → Check, then Install image or Update image, offered when its image is missing or runs another OpenClaw\), then try again, or run it on that machine's default image$/);
    expect(runner.built).toEqual([]);
  });

  it("at an import's own room the whole reason fits, cut at no word: packages that differ first, named once, names of 64 characters, and a derived image's long names that run otherwise (HB-1333 review)", async () => {
    // As buildPinned says it: its words, then the refusal, in the 500 characters the rolled-back reason keeps.
    const failed = (tag: string) => `the image ${tag} could not be built here: `;
    const fits = async (r: ImageRecipe, tags: ImageTagInfo[]) => {
      expect(recipeProblem(r)).toBeNull();
      const p = new MockProvider();
      p.tags = tags;
      const got = await buildRecipeOn(p, r, { where: 'this machine', here: true, room: 500 - failed(r.tag).length }) as { ok: false; problem: string };
      expect(got.ok).toBe(false);
      expect(`${failed(r.tag)}${got.problem}`.length).toBeLessThanOrEqual(500);
      expect(p.built).toEqual([]);
      return got.problem;
    };
    const tag = 'hatchabot-runtime:2026.9.8-plus-c0ffee12';
    const two = (c: string, n: number) => [0, 1].map((i) => `${c}${i}-made-up`.padEnd(n, 'x'));
    for (const n of [31, 64]) {
      const said = await fits({ tag, base: 'hatchabot-runtime:2026.9.8', packages: [], channels: [], inputs: label({ packages: two('a', n) }) }, [img('hatchabot-runtime:latest', { buildInputs: label({ packages: two('b', n) }) })]);
      // Whole, with its advice at the end; the base's packages, named by the difference, are not named again in what to build.
      expect(said, String(n)).toMatch(/^no image on this machine is built the way hatchabot-runtime:2026\.9\.8-plus-c0ffee12's base is: hatchabot-runtime:latest has .+ added, and the base has .+\. Build an engine-free image of OpenClaw 2026\.9\.8 with the base's packages on this machine \(Settings → Advanced → Runtime images\), then try again, or run it on this machine's default image$/);
      expect(said, String(n)).not.toContain(two('a', n)[1]);
    }
    // Names of 64 characters do not fit even one each: only counted.
    expect(await fits({ tag, base: 'hatchabot-runtime:2026.9.8', packages: [], channels: [], inputs: label({ packages: two('a', 64) }) }, [img('hatchabot-runtime:latest', { buildInputs: label({ packages: two('b', 64) }) })]))
      .toContain('hatchabot-runtime:latest has 2 packages added, and the base has 2 packages.');
    // A derived image's long names, on a base that runs otherwise: said without the parenthesis.
    const runsAs = (env: string[]) => runConfigId({ User: 'node', Entrypoint: ['agentclaw-entrypoint'], Cmd: ['openclaw', 'gateway'], Env: ['HOME=/home/node', ...env] })!;
    expect(await fits(
      { tag: 'hatchabot-runtime:derived-kitchen-media-tools', base: 'hatchabot-runtime:proxied-for-the-garden-shed', packages: [], channels: B.channels, lines: 'RUN true', inputs: label(), config: runsAs(['HTTP_PROXY=http://proxy.example:3128']) },
      [img('hatchabot-runtime:made-by-hand-with-a-proxy', { buildInputs: label(), config: runsAs(['HTTPS_PROXY=http://other.example:3128']) })],
    )).toBe("no image on this machine runs as hatchabot-runtime:derived-kitchen-media-tools's base hatchabot-runtime:proxied-for-the-garden-shed does: hatchabot-runtime:made-by-hand-with-a-proxy here is built the same way and runs otherwise, so one of them was built by hand. Build that base the same way on this machine, or run it on this machine's default image");
    // No room for even the counts: cut at the end of a word, with "…", in the room.
    const p = new MockProvider();
    p.tags = [img('hatchabot-runtime:latest', { buildInputs: label({ packages: two('b', 64) }) })];
    const cut = await buildRecipeOn(p, { tag, base: 'hatchabot-runtime:2026.9.8', packages: [], channels: [], inputs: label({ packages: two('a', 64) }) }, { where: 'this machine', here: true, room: 120 }) as { problem: string };
    expect(cut.problem.length).toBeLessThanOrEqual(120);
    expect(cut.problem).toMatch(/^no image on this machine is built the way .*[a-z0-9']…$/);
  });

  it('fitWords keeps words whole: all of them that fit, then "…" (HB-1333 review)', () => {
    expect(fitWords('alpha beta gamma', 16)).toBe('alpha beta gamma');
    expect(fitWords('alpha beta gamma', 15)).toBe('alpha beta…');
    expect(fitWords('alpha beta, gamma', 14)).toBe('alpha beta…');
    expect(fitWords('alphabetical', 6)).toBe('alpha…');
    expect(fitWords('alpha', 0)).toBe('');
  });

  it('a recipe built on its base by name (from before the build-inputs label) is held to how its base ran too (HB-1330 review)', async () => {
    const runsAs = (user: string) => runConfigId({ User: user, Entrypoint: ['agentclaw-entrypoint'], Cmd: ['openclaw', 'gateway'], Env: ['HOME=/home/node'] })!;
    // Its base's layers say which image it was; this machine's image of that name is another build of it.
    const r: ImageRecipe = { tag: 'hatchabot-runtime:2026.7.1-2-plus-jq', base: 'hatchabot-runtime:2026.7.1-2', packages: ['jq'], channels: [], layers: chainId([L('1')]), config: runsAs('node') };
    expect(recipeProblem(r)).toBeNull();
    const on = (config?: string) => { const p = new MockProvider(); p.tags = [img('hatchabot-runtime:2026.7.1-2', { layers: [L('5')], ...(config ? { config } : {}) })]; return p; };
    const root = on(runsAs('root'));
    expect(await buildRecipeOn(root, r, { where: 'garden-shed' })).toEqual({ ok: false, problem: "no image on garden-shed runs as hatchabot-runtime:2026.7.1-2-plus-jq does: hatchabot-runtime:2026.7.1-2 there runs otherwise (its user, entrypoint, command, environment, volumes, working folder or the rest of how it runs), so one of them was built by hand: if it is hatchabot-runtime:2026.7.1-2, take hatchabot-runtime:2026.7.1-2 out of the runtime repository and try again; if it is hatchabot-runtime:2026.7.1-2-plus-jq, make it a derived image where it was made, so its lines travel; or run it on that machine's default image" });
    expect(root.built).toEqual([]);
    // Running as it did, or not saying how (an older listing), it is built on that name, as before.
    for (const p of [on(runsAs('node')), on()]) expect(await buildRecipeOn(p, r, { where: 'garden-shed' })).toMatchObject({ ok: true, built: true, base: 'hatchabot-runtime:2026.7.1-2' });
  });

  it('nothing there stands for it and nothing is published: it says why and how, and builds nothing', async () => {
    const { p, byTag } = source({ buildInputs: label(), layers: [L('1')] });
    const runner = new MockProvider();
    runner.tags = [img('hatchabot-runtime:latest', { buildInputs: label({ engine: 'baked' }) }), img('hatchabot-runtime:derived-other', { buildInputs: label(), derived: 'other' })];
    const got = await ensureImageOn(runner, p, TAG, byTag, 'garden-shed');
    expect(got).toMatchObject({ ok: false, problem: expect.stringContaining("hatchabot-runtime:latest has its own memory search engine, and the base is engine-free. Build an engine-free image of OpenClaw 2026.9.8 on this machine (Settings → Advanced → Runtime images), make it this machine's default and copy it to garden-shed (Settings → Hosts → Check, then Install image or Update image, offered when its image is missing or runs another OpenClaw)") });
    expect(runner.built).toEqual([]);
    expect(runner.tagged).toEqual([]);
  });

  it("a recipe's by-hand settings are only matched: no build here is given them", async () => {
    // A file says its base was built on a Node of its own choosing.
    const r = { tag: TAG, base: 'hatchabot-runtime:latest', packages: [], lines: 'RUN true', channels: [], inputs: label({ node: 'registry.example/evil/node:24', byHand: ['node'] }) };
    expect(recipeProblem(r)).toBeNull();
    const here = new MockProvider();
    const asked: string[] = [];
    here.ensureBaseImage = async (t: string) => { asked.push(t); return false; };
    expect(await buildRecipeOn(here, r, { where: 'this machine', here: true })).toMatchObject({ ok: false, problem: expect.stringMatching(/^no image on this machine is built the way .* or run it on this machine's default image$/) });
    expect(asked).toEqual(['hatchabot-runtime:2026.9.8']);
    // One built that very way stands for it, and is built FROM by its own name.
    here.tags = [img('hatchabot-runtime:2026.9.8-node', { buildInputs: label({ node: 'registry.example/evil/node:24', byHand: ['node'] }) })];
    expect(await buildRecipeOn(here, r, { where: 'this machine', here: true })).toMatchObject({ ok: true, built: true, base: 'hatchabot-runtime:2026.9.8-node', laid: [] });
    expect(here.built[0]!.dockerfile).toBe('FROM hatchabot-runtime:2026.9.8-node\nUSER root\nRUN true\nUSER node\n');
  });

  it('a plain pin that stands for itself under another name is tagged, not built', async () => {
    const r = { tag: 'hatchabot-runtime:2026.9.8-plus-jq', base: 'hatchabot-runtime:2026.9.8', packages: ['jq'], channels: [], inputs: label({ packages: ['jq'] }) };
    const here = new MockProvider();
    here.tags = [img('hatchabot-runtime:latest', { buildInputs: label({ packages: ['jq'] }), extraPackages: ['jq'] })];
    expect(await buildRecipeOn(here, r)).toEqual({ ok: true, built: false, base: 'hatchabot-runtime:latest', laid: [] });
    expect(here.tagged).toEqual([['id-hatchabot-runtime:latest', 'hatchabot-runtime:2026.9.8-plus-jq']]); // by the id read (HB-0986 review)
    expect(here.built).toEqual([]);
  });
});
