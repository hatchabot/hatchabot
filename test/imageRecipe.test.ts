import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRecipeOn, namedHere, recipeDockerfile, recipeFor, recipeProblem, sameImageHere } from '../src/orchestrator/machines/imageRecipe.js';
import { chainId } from '../src/orchestrator/machines/buildInputs.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';
import { parseImageFacts, ProviderError } from '../src/providers/provider.js';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("an imported file's image names, in this fleet's repository (HB-1183)", () => {
  it('renames the tag, and the base from its own fleet or the default names; any other base is left to be refused', () => {
    expect(namedHere('example-runtime:derived-media', 'example-runtime:2026.9.8', 'hatchabot-runtime')).toEqual({ tag: 'hatchabot-runtime:derived-media', base: 'hatchabot-runtime:2026.9.8' });
    expect(namedHere('hatchabot-runtime:derived-media', 'agentclaw-runtime:2026.7.1-2', 'garden/runtime')).toEqual({ tag: 'garden/runtime:derived-media', base: 'garden/runtime:2026.7.1-2' });
    expect(namedHere('example-runtime:derived-media', 'ubuntu:24.04', 'hatchabot-runtime')).toEqual({ tag: 'hatchabot-runtime:derived-media', base: 'ubuntu:24.04' });
    expect(namedHere('example-runtime:2026.9.8', undefined, 'hatchabot-runtime')).toEqual({ tag: 'hatchabot-runtime:2026.9.8' });
    // Not a runtime image's name at all: left as it is, and refused.
    for (const tag of ['registry.example:5000/runtime:derived-media', 'Example:derived-media', 'example-runtime', 'example-runtime:-x', ':derived-media', 'a//b:derived-media']) {
      expect(namedHere(tag, 'example-runtime:2026.9.8', 'hatchabot-runtime')).toEqual({ tag, base: 'example-runtime:2026.9.8' });
      expect(recipeProblem({ tag, base: 'hatchabot-runtime:2026.9.8', packages: [], channels: [] })).toMatch(/not a runtime image name/);
    }
    // A name in another fleet's repository is refused until it is renamed here.
    expect(recipeProblem({ tag: 'example-runtime:2026.9.8-plus-jq', base: 'hatchabot-runtime:2026.9.8', packages: ['jq'], channels: [] })).toMatch(/not a runtime image name/);
    expect(recipeProblem({ tag: 'example-runtime:2026.9.8-plus-jq', base: 'example-runtime:2026.9.8', packages: ['jq'], channels: [] }, 'example-runtime')).toBeNull();
    // This fleet's own repository is its setting, and may name a registry's port; a file's names may not.
    const fleet = 'registry.example:5000/runtime';
    const r = namedHere('example-runtime:derived-media', 'example-runtime:2026.9.8', fleet);
    expect(r).toEqual({ tag: `${fleet}:derived-media`, base: `${fleet}:2026.9.8` });
    expect(recipeProblem({ tag: r.tag, base: r.base!, packages: [], channels: [], lines: 'RUN true' }, fleet)).toBeNull();
  });
});

describe("a recipe's build is used only once it runs as node, on its base (HB-1032)", () => {
  // The lines come from a file, and the file is untrusted: a line that gets
  // past reading them (a heredoc that takes in the USER node, a FROM hidden in
  // an escape) made the importer's machine a root image, or one not built on
  // its base, under the pin's name.
  const V = 'hatchabot-runtime:2026.9.6', CHECK = 'hatchabot-runtime-check:2026.9.6';
  const recipe = { tag: V, base: V, packages: ['jq'], channels: [] };
  const machine = () => { const m = new MockProvider(); m.publishedBases.add(V); return m; };
  const NODE_WORDS = 'a line in it hides the USER node Hatchabot adds at the end (a heredoc that runs to the end, for example). Change the lines and Rebuild.';
  /** Refused: nothing takes the pin's name, its image stays the one pulled, and the build's own name is gone. */
  const refused = (m: MockProvider) => {
    expect(m.tagged).toEqual([]);
    expect(m.tags.find((t) => t.tag === V)?.imageId).toBe(`pulled-${V}`);
    expect(m.tags.map((t) => t.tag)).not.toContain(CHECK);
  };

  it('an image that runs as node on its base takes the name, and the name it was built to goes', async () => {
    const m = machine();
    expect(await buildRecipeOn(m, recipe)).toMatchObject({ ok: true, built: true });
    expect(m.built.map((b) => b.tag)).toEqual([CHECK]);
    expect(m.tagged).toEqual([[`built-${CHECK}`, V]]); // by the id that was looked at
    expect(m.removed).toEqual([CHECK]);
    expect(m.tags.find((t) => t.tag === V)?.imageId).toBe(`built-${CHECK}`);
  });

  /** A machine whose images a promote there moves just as each is read: the image picked is not the one its name names then. */
  class Moving extends MockProvider {
    override async inspectImage(ref: string) {
      const t = this.tags.find((x) => x.tag === ref);
      if (t && !t.imageId.startsWith('moved-')) this.tags = [...this.tags.filter((x) => x !== t), { ...t, imageId: `moved-${ref}`, layers: [`sha256:${'7'.repeat(64)}`] }];
      return super.inspectImage(ref);
    }
  }
  const PLAIN = { tag: 'hatchabot-runtime:mine', base: V, packages: [], channels: [] };

  it('a base moved between its choice and its read is neither built on nor named (HB-0986 review)', async () => {
    const m = new Moving();
    m.publishedBases.add(V);
    expect(await buildRecipeOn(m, recipe)).toEqual({ ok: false, problem: `that machine's image ${V} changed just now — try again` });
    expect(m.built).toEqual([]);
    const n = new Moving();
    n.publishedBases.add(V);
    expect(await buildRecipeOn(n, PLAIN)).toEqual({ ok: false, problem: `that machine's image ${V} changed just now — try again` });
    expect(n.tagged).toEqual([]);
  });

  it('a stand-in a check judged and now gone is not built on by its base\'s name: try again (HB-0986 review)', async () => {
    const H = (c: string) => `sha256:${c.repeat(64)}`;
    // A recipe that names its base by its layers alone (no label): the check found them under :latest.
    const byLayers = { tag: 'hatchabot-runtime:derived-media', base: 'hatchabot-runtime:latest', packages: [], channels: [], lines: 'RUN true', layers: chainId([H('1')]) };
    const promoted = () => {
      const m = new MockProvider();
      m.tags = [{ tag: 'hatchabot-runtime:latest', imageId: 'promoted', layers: [H('2')] }];
      return m;
    };
    const m = promoted();
    expect(await buildRecipeOn(m, byLayers, { expect: 'judged' })).toEqual({ ok: false, problem: "that machine's images changed just now — try again" });
    expect(m.built).toEqual([]);
    // With no check before it, a recipe like that is built on its base by name, as before.
    const n = promoted();
    expect(await buildRecipeOn(n, byLayers)).toMatchObject({ ok: true, built: true, base: 'hatchabot-runtime:latest' });
  });

  it("a record here is the image of its name only once its last build is READY (HB-1183 review)", () => {
    const r = { tag: 'hatchabot-runtime:derived-media', base: 'hatchabot-runtime:latest', packages: [], channels: [], lines: 'RUN true' };
    const rec = (status: 'READY' | 'FAILED' | 'BUILDING') => ({
      name: 'media', tag: r.tag, base: r.base, dockerfile: 'RUN true', status, error: null, createdBy: 'me', createdAt: '2026-11-01T00:00:00Z', builtAt: null,
    });
    const here = { tag: r.tag, imageId: 'before' };
    expect(sameImageHere(here, r, rec('READY'), [here])).toBe(true);
    expect(sameImageHere(here, r, rec('FAILED'), [here])).toBe(false);
    expect(sameImageHere(here, r, rec('BUILDING'), [here])).toBe(false);
    expect(sameImageHere(here, r, { ...rec('READY'), dockerfile: 'RUN false' }, [here])).toBe(false);
  });

  it("docker's ids: the listing's short one and the inspect's full one are the same image, and the base is not taken for moved (HB-0986 review)", async () => {
    const HEX = 'ab12'.repeat(16);
    /** As docker says them: `docker images` gives 12 hex characters, `docker image inspect` the whole sha256 id. */
    class Docker extends MockProvider {
      override async listImageTags() { return (await super.listImageTags()).map((t) => (t.tag === V ? { ...t, imageId: HEX.slice(0, 12) } : t)); }
      override async inspectImage(ref: string) { const f = await super.inspectImage(ref); return ref === V ? { ...f, id: `sha256:${HEX}` } : f; }
    }
    const m = new Docker();
    m.publishedBases.add(V);
    expect(await buildRecipeOn(m, recipe)).toMatchObject({ ok: true, built: true });
    const n = new Docker();
    n.publishedBases.add(V);
    expect(await buildRecipeOn(n, PLAIN)).toMatchObject({ ok: true, built: false });
    expect(n.tagged).toEqual([[`sha256:${HEX}`, 'hatchabot-runtime:mine']]);
  });

  it('a plain base pinned under another name is named by the id that was read, not by its name (HB-0986 review)', async () => {
    const m = machine();
    expect(await buildRecipeOn(m, PLAIN)).toMatchObject({ ok: true, built: false, base: V });
    expect(m.tagged).toEqual([[`pulled-${V}`, 'hatchabot-runtime:mine']]);
  });

  it("an image a line set one of Hatchabot's own labels in is not used (HB-0986 review)", async () => {
    const m = machine();
    m.buildLabels = { 'org.hatchabot.build-inputs': 'v1;openclaw=2026.10.1' };
    expect(await buildRecipeOn(m, recipe)).toEqual({ ok: false, problem: "the rebuild failed: The built image sets Hatchabot's own label org.hatchabot.build-inputs: a line in it hides a LABEL (in a heredoc or an escape). Change the lines and Rebuild.", refused: true });
    refused(m);
    // The labels the build itself sets, and the owner's own, are not that.
    const ok = machine();
    ok.buildLabels = { maintainer: 'the household' };
    expect(await buildRecipeOn(ok, recipe)).toMatchObject({ ok: true, built: true });
  });

  it.each([['root', 'root'], ['', 'root'], ['app', '"app"']])('an image that runs as %j is not used', async (user, who) => {
    const m = machine();
    m.buildRunsAs = user;
    expect(await buildRecipeOn(m, recipe)).toEqual({ ok: false, problem: `the rebuild failed: The built image would run as ${who}, not node: ${NODE_WORDS}`, refused: true });
    refused(m);
  });

  it('an image not built on its base is not used', async () => {
    const m = machine();
    m.buildLayers = [`sha256:${'9'.repeat(64)}`, `sha256:${'8'.repeat(64)}`];
    expect(await buildRecipeOn(m, recipe)).toEqual({ ok: false, problem: `the rebuild failed: The built image is not built on ${V}: a line in it starts another image (a FROM hidden in a heredoc or an escape). Change the lines and Rebuild.`, refused: true });
    refused(m);
  });

  it('an image that cannot be seen is not used: the check fails closed', async () => {
    const m = machine();
    const real = m.inspectImage.bind(m);
    m.inspectImage = async (ref) => (ref === CHECK ? Promise.reject(new ProviderError('image inspect failed', `Docker could not say what ${ref} is: it exited 1`)) : real(ref));
    expect(await buildRecipeOn(m, recipe)).toEqual({ ok: false, problem: `the rebuild failed: The built image could not be checked, so it is not used: Docker could not say what ${CHECK} is: it exited 1. Rebuild to try again.` });
    refused(m);
  });

  it("a base that cannot be read, or a machine that cannot look, builds nothing", async () => {
    const m = machine();
    const real = m.inspectImage.bind(m);
    m.inspectImage = async (ref) => (ref === V ? Promise.reject(new Error('docker did not answer')) : real(ref));
    expect(await buildRecipeOn(m, recipe)).toEqual({ ok: false, problem: `that machine's image ${V} could not be read just now — try again` });
    expect(m.built).toEqual([]);
    const blind = machine();
    (blind as { inspectImage?: unknown }).inspectImage = undefined;
    expect(await buildRecipeOn(blind, recipe, { where: 'the shed runner' })).toEqual({ ok: false, problem: 'the shed runner cannot check the images it builds' });
    expect(blind.built).toEqual([]);
  });

  it("a name that cannot be given leaves the pin's image as it was", async () => {
    const m = machine();
    m.tagImage = async () => { throw new Error('no space left on device'); };
    expect(await buildRecipeOn(m, recipe)).toEqual({ ok: false, problem: `the rebuild failed: The built image could not be named ${V}: no space left on device.` });
    expect(m.tags.find((t) => t.tag === V)?.imageId).toBe(`pulled-${V}`);
    expect(m.tags.map((t) => t.tag)).not.toContain(CHECK);
  });

  it('the machine asks docker for the image by its name, and refuses what it cannot read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-recipe-inspect-'));
    dirs.push(dir);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    vi.stubEnv('HOME', dir); vi.stubEnv('PATH', bin);
    const L = `sha256:${'a'.repeat(64)}`;
    const docker = join(bin, 'docker');
    writeFileSync(docker, `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] !== 'image' || a[1] !== 'inspect' || a[2] !== '--format' || a[3] !== ${JSON.stringify('[{{json .Id}},{{json .Config.User}},{{json .RootFS.Layers}},{{json .Config.Labels}}]')}) { process.stderr.write('unexpected ' + a.join(' ')); process.exit(2); }
if (a[4] === 'hatchabot-runtime-check:gone') { process.stderr.write('Error: No such image: hatchabot-runtime-check:gone\\n'); process.exit(1); }
console.log(a[4] === 'hatchabot-runtime-check:garbled' ? 'node' : JSON.stringify(['sha256:0d0d', 'node', [${JSON.stringify(`sha256:${'a'.repeat(64)}`)}], { 'org.hatchabot.derived': 'media' }]));
`, { mode: 0o755 });
    const p = new LocalDockerProvider({ docker, image: 'hatchabot-runtime:latest' });
    expect(await p.inspectImage('hatchabot-runtime-check:derived-media')).toEqual({ id: 'sha256:0d0d', user: 'node', layers: [L], labels: { 'org.hatchabot.derived': 'media' } });
    await expect(p.inspectImage('hatchabot-runtime-check:gone')).rejects.toMatchObject({ userMessage: 'Docker could not say what hatchabot-runtime-check:gone is: Error: No such image: hatchabot-runtime-check:gone' });
    await expect(p.inspectImage('hatchabot-runtime-check:garbled')).rejects.toMatchObject({ userMessage: "Docker's answer about hatchabot-runtime-check:garbled could not be read." });
    await expect(p.inspectImage('--format=x')).rejects.toBeInstanceOf(ProviderError);
  });

  it("docker's answer is read only as one: an id, a user, layers, labels", () => {
    const L = `sha256:${'a'.repeat(64)}`;
    expect(parseImageFacts(`["sha256:x","node",["${L}"],{"a":"b"}]\n`)).toEqual({ id: 'sha256:x', user: 'node', layers: [L], labels: { a: 'b' } });
    expect(parseImageFacts(`["sha256:x","",["${L}"],null]`)).toEqual({ id: 'sha256:x', user: '', layers: [L], labels: {} });
    for (const bad of ['node', '', 'null', `["sha256:x",null,["${L}"],null]`, '["sha256:x","node",[],null]', '["sha256:x","node",["sha256:short"],null]', `["sha256:x","node",["${L}"]]`, `["sha256:x","node",["${L}"],1]`, `["sha256:x","node",["${L}"],["a"]]`, `["sha256:x","node",["${L}"],{"a":1}]`, `["sha256:x","node",["${L}"],null,1]`]) {
      expect(parseImageFacts(bad)).toBeUndefined();
    }
  });
});

describe('image recipes', () => {
  it('a derived image is its base plus its own lines, root for the lines, node after', async () => {
    const derived = { name: 'with-pdf', tag: 'hatchabot-runtime:derived-with-pdf', base: 'hatchabot-runtime:2026.7.1-2', dockerfile: 'RUN apt-get update && apt-get install -y poppler-utils', status: 'READY' } as any;
    const r = await recipeFor(new MockProvider(), derived.tag, (t) => (t === derived.tag ? derived : undefined));
    expect(r).toMatchObject({ base: 'hatchabot-runtime:2026.7.1-2', packages: [] });
    const df = recipeDockerfile(r as any);
    expect(df).toBe('FROM hatchabot-runtime:2026.7.1-2\nUSER root\nRUN apt-get update && apt-get install -y poppler-utils\nUSER node\n');
  });
  it('only valid package names reach the build line; one that is not refuses the recipe rather than drop a tool (#137)', async () => {
    const p = new MockProvider();
    p.tags.push({ tag: 'hatchabot-runtime:2026.7.1-2-plus-jq-curl', imageId: 'i', openclawVersion: '2026.7.1-2', extraPackages: ['jq', 'evil; rm -rf /', 'curl'] } as any);
    expect(await recipeFor(p, 'hatchabot-runtime:2026.7.1-2-plus-jq-curl', () => undefined)).toMatchObject({ problem: expect.stringMatching(/not a package name/) });
    // g++ is a real name; "curl-" is apt's remove syntax.
    p.tags.push({ tag: 'hatchabot-runtime:2026.7.1-2-plus-gpp', imageId: 'j', openclawVersion: '2026.7.1-2', extraPackages: ['g++', 'libstdc++'] } as any);
    const r = await recipeFor(p, 'hatchabot-runtime:2026.7.1-2-plus-gpp', () => undefined);
    expect((r as any).packages).toEqual(['g++', 'libstdc++']);
    expect(recipeDockerfile(r as any)).toContain('install -y --no-install-recommends g++ libstdc++ &&');
    expect(recipeProblem(r as any)).toBeNull();
    expect(recipeProblem({ ...(r as any), packages: ['curl-'] })).toMatch(/package list/);
  });
  it('a derived image carries what its base had beyond stock: packages laid back on, plugins checked (#128)', async () => {
    const p = new MockProvider();
    p.tags.push({ tag: 'hatchabot-runtime:2026.9.6-plus-ffmpeg', imageId: 'b', openclawVersion: '2026.9.6', extraPackages: ['ffmpeg'], channels: ['slack'] } as any);
    const derived = { name: 'media', tag: 'hatchabot-runtime:derived-media', base: 'hatchabot-runtime:2026.9.6-plus-ffmpeg', dockerfile: 'RUN true', status: 'READY' } as any;
    const r = await recipeFor(p, derived.tag, (t) => (t === derived.tag ? derived : undefined));
    expect(r).toMatchObject({ packages: ['ffmpeg'], channels: ['slack'], lines: 'RUN true' });
    // A destination whose base lacks the plugin refuses, instead of building without it.
    const dest = new MockProvider();
    dest.tags.push({ tag: 'hatchabot-runtime:2026.9.6-plus-ffmpeg', imageId: 'x', openclawVersion: '2026.9.6' } as any);
    expect(await buildRecipeOn(dest, r as any)).toMatchObject({ ok: false, problem: expect.stringMatching(/slack/) });
  });
  it("images that can't be read give no recipe, not one without the base's packages (A32)", async () => {
    const p = new MockProvider();
    p.tags.push({ tag: 'hatchabot-runtime:2026.9.6-plus-ffmpeg', imageId: 'b', openclawVersion: '2026.9.6', extraPackages: ['ffmpeg'] } as any);
    p.listImageTags = async () => { throw new Error('daemon busy'); };
    const derived = { name: 'media', tag: 'hatchabot-runtime:derived-media', base: 'hatchabot-runtime:2026.9.6-plus-ffmpeg', dockerfile: 'RUN true', status: 'READY' } as any;
    expect(await recipeFor(p, derived.tag, (t) => (t === derived.tag ? derived : undefined))).toMatchObject({ problem: expect.stringMatching(/could not be read/) });
    expect(await recipeFor(p, 'hatchabot-runtime:2026.9.6-plus-ffmpeg', () => undefined)).toMatchObject({ problem: expect.stringMatching(/could not be read/) });
  });
  it('a plain version tag built with extra packages gets them back after the pull (#161)', async () => {
    const dest = new MockProvider();
    dest.publishedBases.add('hatchabot-runtime:2026.9.6');
    const r = { tag: 'hatchabot-runtime:2026.9.6', base: 'hatchabot-runtime:2026.9.6', packages: ['jq'], channels: [] };
    expect(await buildRecipeOn(dest, r)).toMatchObject({ ok: true, built: true });
    expect(dest.pulled).toEqual(['hatchabot-runtime:2026.9.6']);
    expect(dest.built.map((b) => [b.tag, b.dockerfile.includes('install -y --no-install-recommends jq')])).toEqual([['hatchabot-runtime-check:2026.9.6', true]]);
    expect(dest.tagged).toEqual([['built-hatchabot-runtime-check:2026.9.6', 'hatchabot-runtime:2026.9.6']]);
    // Without packages, the pull is all.
    const plain = new MockProvider();
    plain.publishedBases.add('hatchabot-runtime:2026.9.6');
    expect(await buildRecipeOn(plain, { ...r, packages: [] })).toMatchObject({ ok: true, built: false });
  });
});

describe('images with their own build (2026-09-28)', () => {
  it('a -lite image gives no recipe: rebuilt from the version it would be a different image', async () => {
    const p = new MockProvider();
    p.tags.push({ tag: 'hatchabot-runtime:2026.7.1-2-lite', imageId: 'i', openclawVersion: '2026.7.1-2' } as any);
    expect(await recipeFor(p, 'hatchabot-runtime:2026.7.1-2-lite', () => undefined)).toMatchObject({ problem: expect.stringMatching(/own build/) });
  });
});

describe("the Docker provider's image listing, read for a recipe (HB-0973)", () => {
  /**
   * A docker on a PATH of its own that answers `images` and `image inspect`
   * as the scenario says: a base built with extra packages and a plugin, and
   * a derived image on it.
   */
  const LA = `sha256:${'a'.repeat(64)}`, LB = `sha256:${'b'.repeat(64)}`, LC = `sha256:${'c'.repeat(64)}`;
  const STAMP = `sha256:${'5'.repeat(64)}`;
  const INPUTS = 'v1;openclaw=2026.9.6;engine=none;packages=ffmpeg;node=node:24-slim;channels=slack;channel-plugins=2026.9.6;plugins=;plugin-install=npm;embed-plugin=;claude-code=2.1.224;by-hand=;release=2.190.0';
  /** With `built`: each line ends with the image's layers and all its labels, as JSON (HB-0986). */
  const built = (layers: string, labels: string) => `|${layers}|${labels}`;
  function world(o: { images?: 'fail'; inspect?: 'fail' | 'one gone'; built?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'hb-recipe-docker-'));
    dirs.push(dir);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, 'node'));
    vi.stubEnv('HOME', dir); vi.stubEnv('PATH', bin);
    const docker = join(bin, 'docker');
    writeFileSync(docker, `#!${process.execPath}
const a = process.argv.slice(2);
const fail = (why) => { process.stderr.write(why + '\\n'); process.exit(1); };
if (a[0] === 'images') {
  ${o.images === 'fail' ? "fail('Cannot connect to the Docker daemon. Is the docker daemon running?');" : ''}
  console.log('hatchabot-runtime:2026.9.6-plus-ffmpeg|0b0b0b0b0b0b|2026-11-01 10:00:00 +0000 UTC|2GB');
  console.log('hatchabot-runtime:derived-media|0d0d0d0d0d0d|2026-11-02 10:00:00 +0000 UTC|2GB');
  console.log('hatchabot-runtime:2026.9.5|0e0e0e0e0e0e|2026-10-01 10:00:00 +0000 UTC|2GB');
} else if (a[0] === 'image' && a[1] === 'inspect') {
  ${o.inspect === 'fail' ? "fail('error during connect: context deadline exceeded');" : ''}
  console.log(${JSON.stringify(`sha256:0b0b0b0b0b0b0000|2026.9.6|slack|ffmpeg||${o.built ? built(JSON.stringify([LA, LB]), JSON.stringify({ 'org.hatchabot.build-inputs': INPUTS, 'org.hatchabot.extra-packages': 'ffmpeg' })) : ''}`)});
  console.log(${JSON.stringify(`sha256:0d0d0d0d0d0d0000|2026.9.6|slack|ffmpeg||${o.built ? built(JSON.stringify([LA, LB, LC]), JSON.stringify({ 'org.hatchabot.build-inputs': INPUTS, 'org.hatchabot.derived': 'media', 'org.hatchabot.recipe': STAMP })) : ''}`)});
  ${o.inspect === 'one gone' ? "fail('Error: No such image: 0e0e0e0e0e0e');" : `console.log(${JSON.stringify(`sha256:0e0e0e0e0e0e0000|2026.9.5|||${o.built ? built('["sha256:short"]', '{"org.hatchabot.build-inputs":"","org.hatchabot.derived":7}') : ''}`)});`}
}
`, { mode: 0o755 });
    return new LocalDockerProvider({ docker, image: 'hatchabot-runtime:latest' });
  }
  const derived = { name: 'media', tag: 'hatchabot-runtime:derived-media', base: 'hatchabot-runtime:2026.9.6-plus-ffmpeg', dockerfile: 'RUN true', status: 'READY' } as any;
  const byTag = (t: string) => (t === derived.tag ? derived : undefined);

  it('read whole: the base\'s packages and plugin are in the recipe', async () => {
    expect(await recipeFor(world(), derived.tag, byTag)).toMatchObject({ base: derived.base, packages: ['ffmpeg'], channels: ['slack'], lines: 'RUN true' });
    // One image removed since it was listed is only gone: the rest still read.
    expect(await recipeFor(world({ inspect: 'one gone' }), derived.tag, byTag)).toMatchObject({ packages: ['ffmpeg'], channels: ['slack'] });
  });

  it('reads what each image was built from, and its layers, and a recipe carries them (HB-0986)', async () => {
    const tags = await world({ built: true }).listImageTags();
    const by = (t: string) => tags.find((x) => x.tag === t)!;
    expect(by('hatchabot-runtime:2026.9.6-plus-ffmpeg')).toMatchObject({ buildInputs: INPUTS, layers: [LA, LB], extraPackages: ['ffmpeg'] });
    expect(by('hatchabot-runtime:2026.9.6-plus-ffmpeg').derived).toBeUndefined();
    // A derived image's stamp of what it was built from too (HB-1325 review).
    expect(by('hatchabot-runtime:derived-media')).toMatchObject({ buildInputs: INPUTS, derived: 'media', recipe: STAMP, layers: [LA, LB, LC] });
    // Layers that are not digests, an empty label, a label that is not a string: nothing claimed.
    expect(by('hatchabot-runtime:2026.9.5')).not.toHaveProperty('layers', expect.anything());
    expect(by('hatchabot-runtime:2026.9.5').buildInputs).toBeUndefined();
    expect(by('hatchabot-runtime:2026.9.5').derived).toBeUndefined();
    expect(by('hatchabot-runtime:2026.9.5').recipe).toBeUndefined();
    // A daemon that printed the older form says nothing of it either.
    expect((await world().listImageTags()).every((t) => !t.layers && !t.buildInputs)).toBe(true);
    expect(await recipeFor(world({ built: true }), derived.tag, byTag)).toMatchObject({ inputs: INPUTS, layers: chainId([LA, LB]), packages: ['ffmpeg'] });
  });

  it('a listing or a label read that failed gives no recipe, not one without the extras', async () => {
    for (const fails of [{ images: 'fail' as const }, { inspect: 'fail' as const }]) {
      const p = world(fails);
      await expect(p.listImageTags()).rejects.toMatchObject({ userMessage: "Couldn't ask Docker for its images." });
      expect(await recipeFor(p, derived.tag, byTag)).toMatchObject({ problem: expect.stringMatching(/could not be read/) });
      expect(await recipeFor(p, 'hatchabot-runtime:2026.9.6-plus-ffmpeg', () => undefined)).toMatchObject({ problem: expect.stringMatching(/could not be read/) });
    }
  });
});
