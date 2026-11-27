import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { gzipSync, gunzipSync } from 'node:zlib';
import { exportAgent, ImageDecisionNeeded, importAgent, TransferError } from '../src/orchestrator/transfer/transfer.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import type { ChannelProvisioner } from '../src/channels/channel.js';
import { chainId, formatBuildInputs, type BuildInputs } from '../src/orchestrator/machines/buildInputs.js';
import { derivedByTag, ensureImageOn, recipeProblem } from '../src/orchestrator/machines/imageRecipe.js';
import { recipeStamp } from '../src/orchestrator/machines/derivedImage.js';

/**
 * A downloaded copy carries its pinned image as a RECIPE. The file is
 * untrusted: nothing is built without the machine owner's say-so, and a
 * recipe that could only have been crafted (a FROM of its own, a foreign
 * image name, shell in a package name) can never be built at all.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) { const v = this.map.get(ref); if (v === undefined) throw new Error(`no secret ${ref}`); return v; }
  async delete(ref: string) { this.map.delete(ref); }
}
const channelStub = { kind: 'telegram' } as unknown as ChannelProvisioner;
const BASE = 'hatchabot-runtime:2026.7.1-2';

async function installation(owner = 'o') {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: owner, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: owner, name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  await secrets.put('ai/p1', 'sk-test');
  const deps = { store, secrets, provider, channel: channelStub, sleep: async () => {} };
  return { store, secrets, provider, deps };
}

/** A web-only agent pinned to `image`, downloaded as a .hatchabot file. */
async function exported(image: string, setup: (src: Awaited<ReturnType<typeof installation>>) => void) {
  const src = await installation();
  src.store.insertAgent({ id: 'a1', ownerId: 'o', name: 'Kitchen', slug: 'kitchen', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' });
  src.store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'o', role: 'owner', status: 'active' });
  const { runtimeRef } = await src.provider.provision({ agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } }, env: {} });
  src.store.setAgentRuntimeRef('a1', runtimeRef);
  src.store.setAgentState('a1', 'RUNNING');
  src.provider.stateStore.set(runtimeRef, Buffer.from('the-volume'));
  src.store.setAgentImage('a1', image);
  setup(src);
  return (await exportAgent(src.deps as never, 'a1')).data;
}

const derivedFile = () =>
  exported('hatchabot-runtime:derived-media', (src) => {
    src.store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: BASE, dockerfile: 'RUN apt-get update && apt-get install -y ffmpeg', createdBy: 'o' });
    src.store.setDerivedImageStatus('media', 'READY');
  });

/** Rewrite the file's image section, as a hostile sender could. */
function tamper(data: Buffer, fn: (image: any) => void): Buffer {
  const m = JSON.parse(gunzipSync(data).toString('utf8'));
  fn(m.image);
  return gzipSync(Buffer.from(JSON.stringify(m)));
}

async function decision(p: Promise<unknown>): Promise<ImageDecisionNeeded> {
  const e = await p.then(() => undefined, (err) => err);
  expect(e).toBeInstanceOf(ImageDecisionNeeded);
  return e as ImageDecisionNeeded;
}

describe('a pinned image in a downloaded copy', () => {
  it('the file carries the recipe: base, packages, a derived image\'s lines', async () => {
    const d = JSON.parse(gunzipSync(await derivedFile()).toString('utf8'));
    expect(d.image).toEqual({ tag: 'hatchabot-runtime:derived-media', recipe: { base: BASE, packages: [], lines: 'RUN apt-get update && apt-get install -y ffmpeg', channels: [] } });

    const pkgs = JSON.parse(gunzipSync(await exported(`${BASE}-plus-traceroute`, (src) => {
      src.provider.tags.push({ tag: `${BASE}-plus-traceroute`, imageId: 'x', openclawVersion: '2026.7.1-2', extraPackages: ['traceroute'], channels: ['slack'] } as never);
    })).toString('utf8'));
    expect(pkgs.image.recipe).toEqual({ base: BASE, packages: ['traceroute'], channels: ['slack'] });
  });

  it('an image the source cannot describe still exports, saying why', async () => {
    const d = JSON.parse(gunzipSync(await exported(`${BASE}-plus-mystery`, () => {})).toString('utf8'));
    expect(d.image.tag).toBe(`${BASE}-plus-mystery`);
    expect(d.image.recipe).toBeUndefined();
    expect(d.image.problem).toMatch(/not on this machine/);
  });

  it('no decision yet: stops before creating anything, with the recipe to show', async () => {
    const dst = await installation('me');
    dst.provider.publishedBases.add(BASE);
    const e = await decision(importAgent(dst.deps as never, await derivedFile(), { ownerId: 'me', mayBuild: true }));
    expect(e.mayBuild).toBe(true);
    expect(e.problem).toBeUndefined();
    expect(e.recipe?.lines).toContain('ffmpeg');
    expect(dst.store.listAgents('me')).toEqual([]);
    expect(dst.provider.built).toEqual([]);
  });

  it('the owner says build: built here, pinned, and listed among this machine\'s images', async () => {
    const dst = await installation('me');
    dst.provider.publishedBases.add(BASE);
    const agent = await importAgent(dst.deps as never, await derivedFile(), { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(agent.state).toBe('RUNNING');
    expect(dst.store.getAgent(agent.id)?.image).toBe('hatchabot-runtime:derived-media');
    expect(dst.provider.pulled).toEqual([BASE]);
    expect(dst.provider.built[0]!.dockerfile).toBe(`FROM ${BASE}\nUSER root\nRUN apt-get update && apt-get install -y ffmpeg\nUSER node\n`);
    expect(dst.store.getDerivedImage('media')).toMatchObject({ status: 'READY', createdBy: 'me' });
  });

  it("a fleet whose repository is on a registry with a port keeps the derived image's record too, and its later builds (HB-1357 review)", async () => {
    const REPO = 'registry.example:5000/hatchabot-runtime';
    const dst = await installation('me');
    dst.provider.image = `${REPO}:latest`;
    dst.provider.publishedBases.add(`${REPO}:2026.7.1-2`);
    const agent = await importAgent(dst.deps as never, await derivedFile(), { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(dst.store.getAgent(agent.id)?.image).toBe(`${REPO}:derived-media`);
    expect(dst.store.getDerivedImage('media')).toMatchObject({ status: 'READY', tag: `${REPO}:derived-media`, base: `${REPO}:2026.7.1-2` });
    expect(dst.provider.built[0]!.labels['org.hatchabot.derived']).toBe('media');
  });

  it('someone who does not own the machine cannot build, even asking to', async () => {
    const dst = await installation('me');
    dst.provider.publishedBases.add(BASE);
    const e = await decision(importAgent(dst.deps as never, await derivedFile(), { ownerId: 'me', mayBuild: false, image: 'build' }));
    expect(e.mayBuild).toBe(false);
    expect(dst.provider.built).toEqual([]);
  });

  it('drop: the default image, nothing built', async () => {
    const dst = await installation('me');
    const agent = await importAgent(dst.deps as never, await derivedFile(), { ownerId: 'me', image: 'drop' });
    expect(dst.store.getAgent(agent.id)?.image).toBeUndefined();
    expect(dst.provider.built).toEqual([]);
  });

  it('the same image already here: used as it is, no question asked', async () => {
    const dst = await installation('me');
    dst.provider.tags.push({ tag: 'hatchabot-runtime:derived-media', imageId: 'local' });
    const agent = await importAgent(dst.deps as never, await derivedFile(), { ownerId: 'me', mayBuild: true });
    expect(dst.store.getAgent(agent.id)?.image).toBe('hatchabot-runtime:derived-media');
    expect(dst.provider.built).toEqual([]);
  });

  it('the same image here, imported by someone who is not the machine\'s owner: asked, never pinned (night review)', async () => {
    const dst = await installation('me');
    dst.provider.tags.push({ tag: 'hatchabot-runtime:derived-media', imageId: 'local' });
    await expect(importAgent(dst.deps as never, await derivedFile(), { ownerId: 'me', mayBuild: false })).rejects.toThrow(/machine's owner/);
    const agent = await importAgent(dst.deps as never, await derivedFile(), { ownerId: 'me', mayBuild: false, image: 'drop' });
    expect(dst.store.getAgent(agent.id)?.image ?? null).toBeNull();
  });

  it("the question says what is here: no image of that name, this machine's own, or another of that name (HB-1515)", async () => {
    const TAG = 'hatchabot-runtime:derived-media';
    const absent = await installation('me');
    absent.provider.publishedBases.add(BASE);
    expect((await decision(importAgent(absent.deps as never, await derivedFile(), { ownerId: 'me', mayBuild: true }))).message)
      .toBe(`This agent is pinned to the image ${TAG}, which this machine does not have. Build it here from the recipe in the file, or run it on the default image.`);
    // This machine's own image of it, imported by someone who is not its owner. Was: "which this machine does not have".
    const own = await installation('me');
    own.provider.tags.push({ tag: TAG, imageId: 'local' });
    expect((await decision(importAgent(own.deps as never, await derivedFile(), { ownerId: 'me', mayBuild: false }))).message)
      .toBe(`This agent is pinned to the image ${TAG}, which this machine has. It can't be pinned to it here (only this machine's owner can pin an agent to a particular image), so it can only run on the default image.`);
    // Another image of that name: a record here of other lines.
    const other = await installation('me');
    other.provider.tags.push({ tag: TAG, imageId: 'local' });
    other.store.upsertDerivedImage({ name: 'media', tag: TAG, base: BASE, dockerfile: 'RUN false', createdBy: 'me' });
    other.store.setDerivedImageStatus('media', 'READY');
    expect((await decision(importAgent(other.deps as never, await derivedFile(), { ownerId: 'me', mayBuild: true }))).message)
      .toBe(`This agent is pinned to the image ${TAG}, and this machine already has an image of that name. It can't be built here (a different image here already has the name ${TAG}), so it can only run on the default image.`);
    // That record and no image of that name: the record has the name (HB-1515 review). Was: "which this machine does not have. It can't be built here (a different image here already has the name …)".
    const kept = await installation('me');
    kept.store.upsertDerivedImage({ name: 'media', tag: TAG, base: BASE, dockerfile: 'RUN false', createdBy: 'me' });
    kept.store.setDerivedImageStatus('media', 'FAILED');
    expect((await decision(importAgent(kept.deps as never, await derivedFile(), { ownerId: 'me', mayBuild: true }))).message)
      .toBe(`This agent is pinned to the image ${TAG}, which this machine does not have. It can't be built here (the name ${TAG} is kept here for a different derived image, in Settings → Advanced → Runtime images), so it can only run on the default image.`);
  });

  it.each([
    ['its own FROM', (i: any) => { i.recipe.lines = 'FROM evil/image\nRUN true'; }, /own FROM/],
    ['a network flag split over a continued line', (i: any) => { i.recipe.lines = 'RUN --network\\\n=host curl http://127.0.0.1:11434/'; }, /--network/],
    ['a mount flag split over a continued line', (i: any) => { i.recipe.lines = 'RUN --mount \\\n=type=bind,source=/,target=/h cat /h/x'; }, /--mount/],
    ['a package name that removes', (i: any) => { i.tag = `${BASE}-plus-x`; i.recipe.lines = undefined; i.recipe.packages = ['curl-']; }, /package list/],
    ['a derived name the machine would not accept', (i: any) => { i.tag = 'hatchabot-runtime:derived-Foo.Bar'; }, /derived-image name/],
    ['a build-time mount', (i: any) => { i.recipe.lines = 'RUN --mount=type=bind,source=/,target=/h cat /h/etc/shadow'; }, /--mount/],
    ['a USER of its own', (i: any) => { i.recipe.lines = 'USER root'; }, /USER is managed/],
    ['a COPY of another image\'s files', (i: any) => { i.recipe.lines = 'COPY --from=registry.example/fixture-secrets:1 /app/.env /tmp/x'; }, /^COPY --from is not allowed in a derived image/],
    ['an ADD of a URL', (i: any) => { i.recipe.lines = 'ADD http://127.0.0.1:11434/api/tags /tmp/x'; }, /^ADD of a URL is not allowed in a derived image/],
    ['an ADD of a git address', (i: any) => { i.recipe.lines = 'ADD --keep-git-dir=true git@git.example:team/repo.git /opt/repo'; }, /^ADD of a URL is not allowed in a derived image/],
    ['a registry and port in its name', (i: any) => { i.tag = 'registry.example:5000/runtime:derived-media'; }, /not a runtime image name/],
    ['a name in capitals', (i: any) => { i.tag = 'Example-Runtime:derived-media'; }, /not a runtime image name/],
    ['a base from another fleet than its own name', (i: any) => { i.tag = 'example-runtime:derived-media'; i.recipe.base = 'other-runtime:2026.7.1-2'; }, /Base must be/],
    ['a foreign base', (i: any) => { i.recipe.base = 'ubuntu:24.04'; }, /Base must be/],
    ['a derived base', (i: any) => { i.recipe.base = 'hatchabot-runtime:derived-other'; }, /another derived image/],
    ['shell in a package name', (i: any) => { i.tag = `${BASE}-plus-x`; i.recipe.lines = undefined; i.recipe.packages = ['curl;rm', 'x']; }, /package list/],
    ['lines on a non-derived image', (i: any) => { i.tag = `${BASE}-plus-x`; }, /only a derived image/],
  ])('a crafted recipe with %s can never be built', async (_what, edit, why) => {
    const dst = await installation('me');
    dst.provider.publishedBases.add(BASE);
    const file = tamper(await derivedFile(), edit);
    const e = await decision(importAgent(dst.deps as never, file, { ownerId: 'me', mayBuild: true, image: 'build' }));
    expect(e.problem).toMatch(why);
    expect(dst.provider.built).toEqual([]);
    expect(dst.store.listAgents('me')).toEqual([]);
  });

  it("a copy from a fleet whose images have another name is built and pinned under this fleet's (HB-1183)", async () => {
    const theirs = await exported('example-runtime:derived-media', (src) => {
      src.provider.image = 'example-runtime:latest';
      src.store.upsertDerivedImage({ name: 'media', tag: 'example-runtime:derived-media', base: 'example-runtime:2026.7.1-2', dockerfile: 'RUN apt-get update && apt-get install -y ffmpeg', createdBy: 'o' });
      src.store.setDerivedImageStatus('media', 'READY');
    });
    expect(JSON.parse(gunzipSync(theirs).toString('utf8')).image).toMatchObject({ tag: 'example-runtime:derived-media', recipe: { base: 'example-runtime:2026.7.1-2' } });
    const dst = await installation('me');
    dst.provider.publishedBases.add(BASE);
    const asked = await decision(importAgent(dst.deps as never, theirs, { ownerId: 'me', mayBuild: true }));
    expect(asked.image).toBe('hatchabot-runtime:derived-media');
    expect(asked.recipe).toMatchObject({ tag: 'hatchabot-runtime:derived-media', base: BASE });
    expect(asked.problem).toBeUndefined();
    const agent = await importAgent(dst.deps as never, theirs, { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(dst.store.getAgent(agent.id)?.image).toBe('hatchabot-runtime:derived-media');
    expect(dst.provider.pulled).toEqual([BASE]);
    expect(dst.provider.built[0]).toMatchObject({ tag: 'hatchabot-runtime-check:derived-media', dockerfile: expect.stringMatching(new RegExp(`^FROM ${BASE}\n`)) });
    expect(dst.provider.tagged).toEqual([['built-hatchabot-runtime-check:derived-media', 'hatchabot-runtime:derived-media']]);
    expect(dst.store.getDerivedImage('media')).toMatchObject({ status: 'READY', tag: 'hatchabot-runtime:derived-media', base: BASE });

    // The other way round: a fleet named example-runtime reads ours in its names.
    const there = await installation('me');
    there.provider.image = 'example-runtime:latest';
    there.provider.publishedBases.add('example-runtime:2026.7.1-2');
    const moved = await importAgent(there.deps as never, await derivedFile(), { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(there.store.getAgent(moved.id)?.image).toBe('example-runtime:derived-media');
    expect(there.provider.pulled).toEqual(['example-runtime:2026.7.1-2']);

    // A plain version pin is the image of that name here: pinned, nothing built.
    const plain = await installation('me');
    plain.provider.tags.push({ tag: BASE, imageId: 'local' });
    const pinned = await importAgent(plain.deps as never, tamper(await derivedFile(), (i) => { i.tag = 'example-runtime:2026.7.1-2'; i.recipe = { base: 'example-runtime:2026.7.1-2', packages: [], channels: [] }; }), { ownerId: 'me', mayBuild: true });
    expect(plain.store.getAgent(pinned.id)?.image).toBe(BASE);
    expect(plain.provider.built).toEqual([]);
    // One whose recipe lays something on it is not that image by its name: asked (HB-1183 review).
    for (const laid of [{ packages: ['jq'] }, { lines: 'RUN true' }]) {
      const other = await installation('me');
      other.provider.tags.push({ tag: BASE, imageId: 'local' });
      const file = tamper(await derivedFile(), (i) => { i.tag = 'example-runtime:2026.7.1-2'; i.recipe = { base: 'example-runtime:2026.7.1-2', packages: [], channels: [], ...laid }; });
      const e = await decision(importAgent(other.deps as never, file, { ownerId: 'me', mayBuild: true }));
      expect(e.problem, JSON.stringify(laid)).toBe(`an image here already has the name ${BASE}, and nothing here says it is this one`);
    }

    // A name outside this fleet's repository is never pinned, even one this
    // mock lists (docker lists this fleet's repository alone): renamed, asked.
    const outside = await installation('me');
    outside.provider.tags.push({ tag: 'example-runtime:derived-media', imageId: 'local' });
    const renamed = await decision(importAgent(outside.deps as never, theirs, { ownerId: 'me', mayBuild: true }));
    expect(renamed.image).toBe('hatchabot-runtime:derived-media');
    expect(outside.store.listAgents('me')).toEqual([]);
  });

  it('a different image here under the same name is not replaced', async () => {
    const dst = await installation('me');
    dst.provider.publishedBases.add(BASE);
    dst.store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: BASE, dockerfile: 'RUN apt-get install -y imagemagick', createdBy: 'me' });
    dst.store.setDerivedImageStatus('media', 'FAILED', 'earlier failure');
    const e = await decision(importAgent(dst.deps as never, await derivedFile(), { ownerId: 'me', mayBuild: true, image: 'build' }));
    // Its record, no image of that name: the record has the name (HB-1515 review).
    expect(e.problem).toBe('the name hatchabot-runtime:derived-media is kept here for a different derived image, in Settings → Advanced → Runtime images');
    expect(dst.store.getDerivedImage('media')?.dockerfile).toContain('imagemagick');
  });

  it('a fleet whose default is pinned by digest names an import in its repository, never "<name>@sha256" (review of HB-1182)', async () => {
    const dst = await installation('me');
    dst.provider.image = `hatchabot-runtime@sha256:${'ab'.repeat(32)}`;
    dst.provider.publishedBases.add(BASE);
    const asked = await decision(importAgent(dst.deps as never, await derivedFile(), { ownerId: 'me', mayBuild: true }));
    expect(asked.image).toBe('hatchabot-runtime:derived-media');
    expect(asked.recipe).toMatchObject({ tag: 'hatchabot-runtime:derived-media', base: BASE });
    const agent = await importAgent(dst.deps as never, await derivedFile(), { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(dst.store.getAgent(agent.id)?.image).toBe('hatchabot-runtime:derived-media');
    expect(dst.provider.pulled).toEqual([BASE]);
    expect(dst.provider.tagged).toEqual([['built-hatchabot-runtime-check:derived-media', 'hatchabot-runtime:derived-media']]);
  });

  it("an image here of a file's image's name is pinned only when it is that image, renamed or not (HB-1183 review)", async () => {
    const theirs = await exported('example-runtime:derived-media', (src) => {
      src.provider.image = 'example-runtime:latest';
      src.store.upsertDerivedImage({ name: 'media', tag: 'example-runtime:derived-media', base: 'example-runtime:2026.7.1-2', dockerfile: 'RUN apt-get update && apt-get install -y ffmpeg', createdBy: 'o' });
      src.store.setDerivedImageStatus('media', 'READY');
    });
    const machine = async (lines: string) => {
      const dst = await installation('me');
      dst.store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: BASE, dockerfile: lines, createdBy: 'me' });
      dst.store.setDerivedImageStatus('media', 'READY');
      dst.provider.tags.push({ tag: BASE, imageId: 'base' }, { tag: 'hatchabot-runtime:derived-media', imageId: 'mine' });
      return dst;
    };
    // Renamed into a name here whose image has other lines (imagemagick, not ffmpeg): someone else's, never pinned.
    const other = await machine('RUN apt-get update && apt-get install -y imagemagick');
    const e = await decision(importAgent(other.deps as never, theirs, { ownerId: 'me', mayBuild: true }));
    expect(e.image).toBe('hatchabot-runtime:derived-media');
    expect(e.problem).toBe('a different image here already has the name hatchabot-runtime:derived-media');
    // A file in this fleet's own names is held to the same check.
    const ours = await decision(importAgent(other.deps as never, await derivedFile(), { ownerId: 'me', mayBuild: true }));
    expect(ours.problem).toBe('a different image here already has the name hatchabot-runtime:derived-media');
    expect(other.store.listAgents('me')).toEqual([]);
    expect(other.provider.built).toEqual([]);
    // The same lines on the same base: that image, pinned as it is.
    const same = await machine('RUN apt-get update && apt-get install -y ffmpeg');
    const agent = await importAgent(same.deps as never, theirs, { ownerId: 'me', mayBuild: true });
    expect(same.store.getAgent(agent.id)?.image).toBe('hatchabot-runtime:derived-media');
    expect(same.provider.built).toEqual([]);
  });

  it("a renamed name is pinned only when something here says the image of that name is the file's, recipe or none (HB-1183 review)", async () => {
    const theirs = await exported('example-runtime:derived-media', (src) => {
      src.provider.image = 'example-runtime:latest';
      src.store.upsertDerivedImage({ name: 'media', tag: 'example-runtime:derived-media', base: 'example-runtime:2026.7.1-2', dockerfile: 'RUN apt-get update && apt-get install -y ffmpeg', createdBy: 'o' });
      src.store.setDerivedImageStatus('media', 'READY');
    });
    const NOTHING_SAYS = 'an image here already has the name hatchabot-runtime:derived-media, and nothing here says it is this one';
    const withMine = async () => {
      const dst = await installation('me');
      dst.store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: BASE, dockerfile: 'RUN apt-get update && apt-get install -y imagemagick', createdBy: 'me' });
      dst.store.setDerivedImageStatus('media', 'READY');
      dst.provider.tags.push({ tag: BASE, imageId: 'base' }, { tag: 'hatchabot-runtime:derived-media', imageId: 'mine' });
      return dst;
    };
    const noRecipe = (file: Buffer) => tamper(file, (i) => { delete i.recipe; i.problem = 'its recipe was changed and has not built'; });
    // A file with no recipe (one its source could not make), onto someone else's image of that name: asked.
    const other = await withMine();
    expect((await decision(importAgent(other.deps as never, noRecipe(theirs), { ownerId: 'me', mayBuild: true }))).problem).toBe(NOTHING_SAYS);
    // A derived name with no record here, whatever its recipe lays on: asked.
    for (const lines of ['', 'RUN true']) {
      const leftover = await installation('me');
      leftover.provider.tags.push({ tag: 'hatchabot-runtime:derived-media', imageId: 'leftover' });
      const file = tamper(theirs, (i) => { i.recipe.lines = lines; i.recipe.packages = []; });
      expect((await decision(importAgent(leftover.deps as never, file, { ownerId: 'me', mayBuild: true }))).problem, lines).toBe(NOTHING_SAYS);
    }
    expect(other.store.listAgents('me')).toEqual([]);
    // In this fleet's own names, a file with no recipe is pinned by name, as before.
    const own = await withMine();
    const kept = await importAgent(own.deps as never, noRecipe(await derivedFile()), { ownerId: 'me', mayBuild: true });
    expect(own.store.getAgent(kept.id)?.image).toBe('hatchabot-runtime:derived-media');
  });

  it("this machine's own record of the file's lines, its last build failed: offered, and rebuilt, never pinned to the build before it (HB-1183 review)", async () => {
    const mine = async (status: 'FAILED' | 'BUILDING' | 'READY') => {
      const dst = await installation('me');
      // Changed to the file's lines (ffmpeg): until a build of them is READY, the tag names the build before it.
      dst.store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: BASE, dockerfile: 'RUN apt-get update && apt-get install -y ffmpeg', createdBy: 'me' });
      dst.store.setDerivedImageStatus('media', status, status === 'FAILED' ? 'apt failed' : null);
      dst.provider.tags.push({ tag: BASE, imageId: 'base' }, { tag: 'hatchabot-runtime:derived-media', imageId: 'before' });
      return dst;
    };
    const file = await derivedFile();
    for (const status of ['FAILED', 'BUILDING'] as const) {
      const asked = await mine(status);
      const e = await decision(importAgent(asked.deps as never, file, { ownerId: 'me', mayBuild: true }));
      expect([e.problem, e.recipe?.tag, e.mayBuild], status).toEqual([undefined, 'hatchabot-runtime:derived-media', true]);
      expect(asked.store.listAgents('me')).toEqual([]);
    }
    const failed = await mine('FAILED');
    const rebuilt = await importAgent(failed.deps as never, file, { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(failed.store.getAgent(rebuilt.id)?.image).toBe('hatchabot-runtime:derived-media');
    expect(failed.provider.built.length).toBe(1);
    expect(failed.store.getDerivedImage('media')?.status).toBe('READY');
    // Its last build is the image: pinned, nothing built.
    const ready = await mine('READY');
    const kept = await importAgent(ready.deps as never, file, { ownerId: 'me', mayBuild: true });
    expect(ready.store.getAgent(kept.id)?.image).toBe('hatchabot-runtime:derived-media');
    expect(ready.provider.built).toEqual([]);
  });

  it('a renamed pin from before the label is pinned by its name only as a version or latest, and never onto a derived image (HB-1183 review)', async () => {
    const pin = async (tag: string, here: { derived?: string } = {}) => {
      const dst = await installation('me');
      dst.provider.tags.push({ tag: `hatchabot-runtime:${tag}`, imageId: 'local', ...here });
      const file = tamper(await derivedFile(), (i) => { i.tag = `example-runtime:${tag}`; i.recipe = { base: `example-runtime:${tag}`, packages: [], channels: [] }; });
      const r = await importAgent(dst.deps as never, file, { ownerId: 'me', mayBuild: true }).then((a) => dst.store.getAgent(a.id)?.image, (e: unknown) => (e instanceof ImageDecisionNeeded ? `asked: ${e.problem}` : e));
      return r;
    };
    const asked = (tag: string) => `asked: an image here already has the name hatchabot-runtime:${tag}, and nothing here says it is this one`;
    expect(await pin('latest')).toBe('hatchabot-runtime:latest');
    expect(await pin('2026.9.8')).toBe('hatchabot-runtime:2026.9.8');
    // Another name is someone's own image here, whatever it is.
    expect(await pin('mytool')).toBe(asked('mytool'));
    // A derived image under a version's name is not that version.
    expect(await pin('2026.9.8', { derived: 'media' })).toBe(asked('2026.9.8'));
  });

  it("a member's import of another fleet's :latest runs on this machine's default, unpinned, with no question; the owner is still asked (HB-1332)", async () => {
    const latestFile = async () => tamper(await derivedFile(), (i) => { i.tag = 'example-runtime:latest'; i.recipe = { base: 'example-runtime:2026.7.1-2', packages: [], channels: [] }; });
    const machine = async (has: boolean) => {
      const dst = await installation('me');
      // This machine's default is pinned to a version; its :latest, when there, is another image.
      dst.provider.image = 'hatchabot-runtime:2026.9.8';
      dst.provider.tags = [{ tag: 'hatchabot-runtime:2026.9.8', imageId: 'default' }, ...(has ? [{ tag: 'hatchabot-runtime:latest', imageId: 'older' }] : [])];
      dst.provider.publishedBases.add(BASE);
      return dst;
    };
    for (const has of [true, false]) {
      // Asked before: "only this machine's owner can pin…" with its :latest here, else told only the owner can build it.
      const member = await machine(has);
      const agent = await importAgent(member.deps as never, await latestFile(), { ownerId: 'me' });
      expect(member.store.getAgent(agent.id)?.image ?? null, `:latest here: ${has}`).toBeNull();
      expect(member.provider.built).toEqual([]);
    }
    // The owner is asked as before: a build with none here, the image of that name with one (pinned by it, HB-1183 review).
    const owner = await machine(false);
    expect((await decision(importAgent(owner.deps as never, await latestFile(), { ownerId: 'me', mayBuild: true }))).image).toBe('hatchabot-runtime:latest');
    const ownerHas = await machine(true);
    const pinned = await importAgent(ownerHas.deps as never, await latestFile(), { ownerId: 'me', mayBuild: true });
    expect(ownerHas.store.getAgent(pinned.id)?.image).toBe('hatchabot-runtime:latest');
    // A member's import of this fleet's own :latest, not renamed, is asked as before.
    const own = await machine(true);
    const ours = tamper(await derivedFile(), (i) => { i.tag = 'hatchabot-runtime:latest'; i.recipe = { base: BASE, packages: [], channels: [] }; });
    expect((await decision(importAgent(own.deps as never, ours, { ownerId: 'me' }))).mayBuild).toBe(false);
  });

  it("the test machine's default image is the one its provider names, as a real machine's is (HB-1557)", async () => {
    // Asked for no tag, the made-up machine read hatchabot-runtime:latest whatever its default was,
    // so a test of a fleet pinned to another image read the wrong one.
    const p = new MockProvider();
    p.image = 'hatchabot-runtime:2026.9.8';
    p.tags = [{ tag: 'hatchabot-runtime:2026.9.8', imageId: 'pinned', openclawVersion: '2026.9.8' }, { tag: 'hatchabot-runtime:latest', imageId: 'older', openclawVersion: '2026.9.6' }];
    expect(await p.currentImageInfo()).toMatchObject({ imageId: 'pinned', openclawVersion: '2026.9.8' });
    expect(await p.currentImageInfo('hatchabot-runtime:latest')).toMatchObject({ imageId: 'older', openclawVersion: '2026.9.6' });
  });

  it("a file from before the label, of this machine's base and lines but other packages, is asked about, its base here or gone (HB-1513)", async () => {
    // By the base's name alone, a file with curl was pinned to this machine's image built with jq.
    const LINES = 'RUN apt-get update && apt-get install -y ffmpeg';
    const fileWith = async (packages: string[]) => tamper(await derivedFile(), (i) => { i.recipe.packages = packages; });
    const machine = async (o: { base: boolean; stamp?: string | null }) => {
      const dst = await installation('me');
      dst.provider.tags = [
        ...(o.base ? [{ tag: BASE, imageId: 'base' }] : []),
        { tag: 'hatchabot-runtime:derived-media', imageId: 'ours', derived: 'media', extraPackages: ['jq'], ...(o.stamp === null ? {} : { recipe: o.stamp ?? recipeStamp(BASE, LINES, ['jq']) }) },
      ];
      dst.store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: BASE, basePackages: ['jq'], dockerfile: LINES, createdBy: 'me' });
      dst.store.setDerivedImageStatus('media', 'READY');
      return dst;
    };
    for (const base of [true, false]) {
      const dst = await machine({ base });
      const e = await decision(importAgent(dst.deps as never, await fileWith(['curl']), { ownerId: 'me', mayBuild: true }));
      expect(e.problem, `base here: ${base}`).toBe('a different image here already has the name hatchabot-runtime:derived-media');
      expect(dst.provider.built).toEqual([]);
      // The same packages: this machine's image, as before.
      const same = await machine({ base });
      const agent = await importAgent(same.deps as never, await fileWith(['jq']), { ownerId: 'me', mayBuild: true });
      expect(same.store.getAgent(agent.id)?.image, `base here: ${base}`).toBe('hatchabot-runtime:derived-media');
      expect(same.provider.built).toEqual([]);
    }
    // Its base gone: an image from before the stamp is taken by name, as before; one stamped from other lines is not.
    const unstamped = await machine({ base: false, stamp: null });
    const agent = await importAgent(unstamped.deps as never, await fileWith(['jq']), { ownerId: 'me', mayBuild: true });
    expect(unstamped.store.getAgent(agent.id)?.image).toBe('hatchabot-runtime:derived-media');
    const other = await machine({ base: false, stamp: recipeStamp(BASE, 'RUN false', ['jq']) });
    expect((await decision(importAgent(other.deps as never, await fileWith(['jq']), { ownerId: 'me', mayBuild: true }))).problem).toBe('a different image here already has the name hatchabot-runtime:derived-media');
  });

  it('a failed build rolls the whole import back', async () => {
    const dst = await installation('me');
    dst.provider.publishedBases.add(BASE);
    dst.provider.buildFails = true;
    await expect(importAgent(dst.deps as never, await derivedFile(), { ownerId: 'me', mayBuild: true, image: 'build' }))
      .rejects.toThrow(TransferError);
    expect(dst.store.listAgents('me').filter((a) => a.state !== 'DELETED')).toEqual([]);
    expect(dst.store.getDerivedImage('media')).toBeUndefined(); // no record for an image that never existed
    // Nothing left holding the slug: importing again (on the default) works.
    const agent = await importAgent(dst.deps as never, await derivedFile(), { ownerId: 'me', image: 'drop' });
    expect(agent.slug).toBe('kitchen');
  });
});

describe("an imported image's base, found by what it was built from (HB-0986)", () => {
  const L = (c: string) => `sha256:${c.repeat(64)}`;
  const B7: BuildInputs = {
    openclaw: '2026.7.1-2', engine: 'baked', packages: [], node: 'node:24-slim', channels: [], channelPlugins: '2026.7.1',
    plugins: [], pluginInstall: 'link', embedPlugin: '2026.7.1', claudeCode: '2.1.224', byHand: [], release: '2.190.0',
  };
  const label = (o: Partial<BuildInputs> = {}) => formatBuildInputs({ ...B7, ...o });
  /** 7,988 characters of the owner's own lines: twelve short of their cap. */
  const LINES = 'RUN echo step\n'.repeat(570) + 'RUN true';
  const JQ_BASE = `${BASE}-plus-jq`;
  /** A derived image of LINES on a base built with jq, as its labels say. */
  const jqFile = () => exported('hatchabot-runtime:derived-media', (src) => {
    src.provider.tags.push(
      { tag: JQ_BASE, imageId: 'b', openclawVersion: '2026.7.1-2', buildInputs: label({ packages: ['jq'] }), extraPackages: ['jq'], layers: [L('1'), L('2')] },
      { tag: 'hatchabot-runtime:derived-media', imageId: 'd', openclawVersion: '2026.7.1-2', buildInputs: label({ packages: ['jq'] }), extraPackages: ['jq'], layers: [L('1'), L('2'), L('3')], derived: 'media' },
    );
    src.store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: JQ_BASE, dockerfile: LINES, createdBy: 'o' });
    src.store.setDerivedImageStatus('media', 'READY');
  });
  /** A machine whose default image is that OpenClaw without jq, on another CPU (other layers). */
  const plainMachine = async () => {
    const dst = await installation('me');
    dst.provider.tags = [{ tag: 'hatchabot-runtime:latest', imageId: 'mock-image', openclawVersion: '2026.7.1-2', buildInputs: label(), layers: [L('a')] }];
    return dst;
  };

  it("lays the base's jq on apart from the owner's lines, which keep their whole cap, and the image travels on again", async () => {
    expect(LINES.length).toBe(7988);
    const file = await jqFile();
    expect(JSON.parse(gunzipSync(file).toString('utf8')).image.recipe).toMatchObject({ base: JQ_BASE, packages: ['jq'], lines: LINES, inputs: label({ packages: ['jq'] }), layers: expect.stringMatching(/^sha256:/) });
    const dst = await plainMachine();
    const agent = await importAgent(dst.deps as never, file, { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(dst.store.getAgent(agent.id)?.image).toBe('hatchabot-runtime:derived-media');
    expect(dst.provider.pulled).toEqual([]);
    expect(dst.provider.built.map((b) => b.dockerfile)).toEqual([`FROM hatchabot-runtime:latest\nUSER root\nRUN apt-get update && apt-get install -y --no-install-recommends jq && rm -rf /var/lib/apt/lists/*\n${LINES}\nUSER node\n`]);
    expect(dst.store.getDerivedImage('media')).toMatchObject({ status: 'READY', base: 'hatchabot-runtime:latest', basePackages: ['jq'], dockerfile: LINES });

    // From there, to a third machine: the same lines, still under their cap.
    const again = (await exportAgent(dst.deps as never, agent.id)).data;
    expect(JSON.parse(gunzipSync(again).toString('utf8')).image.recipe).toMatchObject({ packages: ['jq'], lines: LINES, inputs: label({ packages: ['jq'] }) });
    const third = await plainMachine();
    const moved = await importAgent(third.deps as never, again, { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(third.store.getAgent(moved.id)?.image).toBe('hatchabot-runtime:derived-media');
    expect(third.store.getDerivedImage('media')).toMatchObject({ status: 'READY', basePackages: ['jq'], dockerfile: LINES });
  });

  it('a file says how its base runs: an image here that runs otherwise is not built on, and a file from before it is, as before (HB-1330)', async () => {
    // Ids as runConfigId makes them: this release's version, then a digest.
    const RUNS = `v1:${L('5')}`, ROOT = `v1:${L('6')}`;
    const file = await exported('hatchabot-runtime:derived-media', (src) => {
      src.provider.tags.push(
        { tag: JQ_BASE, imageId: 'b', openclawVersion: '2026.7.1-2', buildInputs: label({ packages: ['jq'] }), extraPackages: ['jq'], layers: [L('1'), L('2')], config: RUNS },
        // Its own lines may change how it runs: the file says its base's.
        { tag: 'hatchabot-runtime:derived-media', imageId: 'd', openclawVersion: '2026.7.1-2', buildInputs: label({ packages: ['jq'] }), extraPackages: ['jq'], layers: [L('1'), L('2'), L('3')], derived: 'media', config: `v1:${L('8')}` },
      );
      src.store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: JQ_BASE, dockerfile: 'RUN true', createdBy: 'o' });
      src.store.setDerivedImageStatus('media', 'READY');
    });
    expect(JSON.parse(gunzipSync(file).toString('utf8')).image.recipe).toMatchObject({ layers: chainId([L('1'), L('2')]), config: RUNS });
    const machine = async (config: string) => { const dst = await plainMachine(); dst.provider.tags[0]!.config = config; return dst; };
    const builtOn = (dst: Awaited<ReturnType<typeof plainMachine>>) => dst.provider.built.map((b) => b.dockerfile.split('\n')[0]);
    const same = await machine(RUNS);
    await importAgent(same.deps as never, file, { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(builtOn(same)).toEqual(['FROM hatchabot-runtime:latest']);
    // Its :latest, built FROM that OpenClaw with only a USER root (its label and all), runs otherwise.
    const root = await machine(ROOT);
    const refused = await importAgent(root.deps as never, file, { ownerId: 'me', mayBuild: true, image: 'build' }).then(() => 'imported', (e: Error) => e.message);
    expect(refused).toContain(`no image on this machine runs as hatchabot-runtime:derived-media's base ${JQ_BASE} does: hatchabot-runtime:latest here is built the same way and runs otherwise (its user, entrypoint, command, environment, volumes, working folder or the rest of how it runs), so one of them was built by hand. Build that base the same way on this machine, or run it on this machine's default image`);
    expect(root.provider.built).toEqual([]);
    // A file from before it, or from an older Hatchabot, says nothing of it: built on its :latest, as before.
    const older = tamper(file, (i) => { delete i.recipe.config; });
    const before = await machine(ROOT);
    await importAgent(before.deps as never, older, { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(builtOn(before)).toEqual(['FROM hatchabot-runtime:latest']);
    // A later release's id (another version) is not compared here: built on its :latest, as a file without one is.
    const later = tamper(file, (i) => { i.recipe.config = `v2:${L('7')}`; });
    const v2 = await machine(ROOT);
    await importAgent(v2.deps as never, later, { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(builtOn(v2)).toEqual(['FROM hatchabot-runtime:latest']);
    // A file whose run settings are not an id is refused, as its layers are; one of this release's form without its version too.
    for (const bad of [tamper(file, (i) => { i.recipe.config = 'USER root'; }), tamper(file, (i) => { i.recipe.config = L('5'); })]) {
      const got = await importAgent((await machine(RUNS)).deps as never, bad, { ownerId: 'me', mayBuild: true, image: 'build' }).then(() => 'imported', (e: Error) => e.message);
      expect(got).toContain('how its base runs is not valid');
    }
  });

  it("after a Rebuild here the image still travels: its record's base packages are among what its base was built from (HB-0986 review)", async () => {
    const dst = await plainMachine();
    const agent = await importAgent(dst.deps as never, await jqFile(), { ownerId: 'me', mayBuild: true, image: 'build' });
    // As a Rebuild here leaves it: the base's labels and its own, and no packages label.
    const rebuilt = dst.provider.tags.find((x) => x.tag === 'hatchabot-runtime:derived-media')!;
    rebuilt.buildInputs = label();
    delete rebuilt.extraPackages;
    const again = (await exportAgent(dst.deps as never, agent.id)).data;
    expect(JSON.parse(gunzipSync(again).toString('utf8')).image.recipe).toMatchObject({ packages: ['jq'], inputs: label({ packages: ['jq'] }) });
    // A third machine whose only image is that OpenClaw with jq: it stands for the base.
    const third = await installation('me');
    third.provider.tags = [{ tag: 'hatchabot-runtime:latest', imageId: 'jq', openclawVersion: '2026.7.1-2', buildInputs: label({ packages: ['jq'] }), extraPackages: ['jq'], layers: [L('5')] }];
    const moved = await importAgent(third.deps as never, again, { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(third.store.getAgent(moved.id)?.image).toBe('hatchabot-runtime:derived-media');
    expect(third.provider.built.map((b) => b.dockerfile.split('\n')[0])).toEqual(['FROM hatchabot-runtime:latest']);
  });

  it("the cap is on the owner's lines alone", async () => {
    const long = tamper(await jqFile(), (i) => { i.recipe.lines = `${LINES}\nRUN echo too long`; });
    const dst = await plainMachine();
    await expect(importAgent(dst.deps as never, long, { ownerId: 'me', mayBuild: true, image: 'build' })).rejects.toThrow(/malformed .*\(image\.recipe\.lines\)/);
    expect(recipeProblem({ tag: 'hatchabot-runtime:derived-media', base: 'hatchabot-runtime:latest', packages: ['jq'], channels: [], lines: `${LINES}\nRUN echo too long` })).toBe('its Dockerfile lines are too long');
    expect(dst.provider.built).toEqual([]);
  });

  it("an image of the same name here is the same one when it builds the same, whatever its base is called", async () => {
    const dst = await plainMachine();
    dst.store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: 'hatchabot-runtime:latest', basePackages: ['jq'], dockerfile: LINES, createdBy: 'me' });
    dst.store.setDerivedImageStatus('media', 'READY');
    const agent = await importAgent(dst.deps as never, await jqFile(), { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(dst.store.getAgent(agent.id)?.image).toBe('hatchabot-runtime:derived-media');
    expect(dst.store.getDerivedImage('media')).toMatchObject({ status: 'READY', base: 'hatchabot-runtime:latest', basePackages: ['jq'] });
    // On a base built another way (another OpenClaw), it is someone else's image.
    const other = await plainMachine();
    other.provider.tags[0]!.buildInputs = label({ openclaw: '2026.7.1-1' });
    other.store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: 'hatchabot-runtime:latest', basePackages: ['jq'], dockerfile: LINES, createdBy: 'me' });
    other.store.setDerivedImageStatus('media', 'READY');
    const e = await decision(importAgent(other.deps as never, await jqFile(), { ownerId: 'me', mayBuild: true, image: 'build' }));
    expect(e.problem).toMatch(/is kept here for a different derived image/);
    expect(other.provider.built).toEqual([]);
  });

  it("a base image here of a file's image's name is pinned only when it is built the same, with the same packages (HB-1183 review)", async () => {
    const file = tamper(await jqFile(), (i) => { i.tag = 'example-runtime:2026.7.1-2-plus-jq'; i.recipe = { base: 'example-runtime:2026.7.1-2', packages: ['jq'], channels: [], inputs: label({ packages: ['jq'] }) }; });
    const machine = async (packages: string[]) => {
      const dst = await plainMachine();
      dst.provider.tags.push({ tag: JQ_BASE, imageId: 'here', openclawVersion: '2026.7.1-2', buildInputs: label({ packages }), extraPackages: packages, layers: [L('a'), L('b')] });
      return dst;
    };
    const other = await machine(['curl']);
    const e = await decision(importAgent(other.deps as never, file, { ownerId: 'me', mayBuild: true }));
    expect(e.problem).toBe(`a different image here already has the name ${JQ_BASE}`);
    // Built the same way but without the jq: it stands for the base, and is still not that image.
    const fewer = await machine([]);
    expect((await decision(importAgent(fewer.deps as never, file, { ownerId: 'me', mayBuild: true }))).problem).toBe(`a different image here already has the name ${JQ_BASE}`);
    const same = await machine(['jq']);
    const agent = await importAgent(same.deps as never, file, { ownerId: 'me', mayBuild: true });
    expect(same.store.getAgent(agent.id)?.image).toBe(JQ_BASE);
    expect(same.provider.built).toEqual([]);
  });

  it("this machine's own image of the file's lines is the file's image though the base it was built on is gone here (HB-1331)", async () => {
    const file = await jqFile();
    const OLD = 'hatchabot-runtime:2026.7.1-2-plus-jq-old';
    /** This machine's record of the same lines, built on OLD (deleted since), and the image that build made, its base's labels its own. */
    const machine = async (o: { lines?: string; stamp?: string; openclaw?: string; layers?: string[] } = {}) => {
      const dst = await plainMachine();
      dst.provider.tags.push({
        tag: 'hatchabot-runtime:derived-media', imageId: 'ours', openclawVersion: '2026.7.1-2', derived: 'media',
        buildInputs: label({ packages: ['jq'], ...(o.openclaw ? { openclaw: o.openclaw } : {}) }), extraPackages: ['jq'], layers: o.layers ?? [L('x'), L('y')],
        recipe: o.stamp ?? recipeStamp(OLD, LINES, ['jq']),
      });
      dst.store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: OLD, dockerfile: o.lines ?? LINES, createdBy: 'me' });
      dst.store.setDerivedImageStatus('media', 'READY');
      return dst;
    };
    const ours = await machine();
    const agent = await importAgent(ours.deps as never, file, { ownerId: 'me', mayBuild: true });
    expect(ours.store.getAgent(agent.id)?.image).toBe('hatchabot-runtime:derived-media');
    expect(ours.provider.built).toEqual([]);
    expect(ours.store.getDerivedImage('media')).toMatchObject({ status: 'READY', base: OLD });
    // Still asked: the image is not this record's build (another stamp), the record's lines are not the file's, or the base it was built on ran another OpenClaw.
    for (const o of [{ stamp: recipeStamp(OLD, 'RUN false', ['jq']) }, { lines: 'RUN false' }, { openclaw: '2026.7.1-1' }]) {
      const dst = await machine(o);
      const e = await decision(importAgent(dst.deps as never, file, { ownerId: 'me', mayBuild: true }));
      expect(e.problem, JSON.stringify(o)).toBe('a different image here already has the name hatchabot-runtime:derived-media');
      expect(dst.provider.built).toEqual([]);
    }
    // A file is not trusted: layers it names (the image's first, its whole chain, or its base and one layer more)
    // never stand for build inputs that disagree with the image's (review of HB-1331).
    const ABC = [L('a'), L('b'), L('c')];
    for (const layers of [[L('a')], ABC, [L('a'), L('b')]]) {
      for (const inputs of [label({ packages: ['jq'], openclaw: '2026.7.1-1' }), label({ packages: ['jq'], engine: 'none' })]) {
        const crafted = tamper(file, (i) => { i.recipe.inputs = inputs; i.recipe.layers = chainId(layers); });
        const dst = await machine({ layers: ABC });
        const got = await importAgent(dst.deps as never, crafted, { ownerId: 'me', mayBuild: true }).then((a) => dst.store.getAgent(a.id)?.image, (err) => err);
        expect(got, `${layers.length} ${inputs}`).toBeInstanceOf(ImageDecisionNeeded);
        expect((got as ImageDecisionNeeded).problem).toBe('a different image here already has the name hatchabot-runtime:derived-media');
        expect(dst.provider.built).toEqual([]);
      }
    }
    // With no inputs, its layers decide, the whole chain: a part of it is still asked about.
    for (const [layers, pinned] of [[[L('a')], false], [[L('a'), L('b')], false], [ABC, true]] as const) {
      const bare = tamper(file, (i) => { delete i.recipe.inputs; i.recipe.layers = chainId([...layers]); });
      const dst = await machine({ layers: ABC });
      const got = await importAgent(dst.deps as never, bare, { ownerId: 'me', mayBuild: true }).then((a) => dst.store.getAgent(a.id)?.image, (err) => err);
      if (pinned) expect(got).toBe('hatchabot-runtime:derived-media');
      else expect((got as ImageDecisionNeeded).problem, String(layers.length)).toBe('a different image here already has the name hatchabot-runtime:derived-media');
      expect(dst.provider.built).toEqual([]);
    }
  });

  it("an import keeps the base a record here is built on while it stands, though another image here is the file's very base (HB-0986 review)", async () => {
    const dst = await installation('me');
    dst.provider.tags = [
      { tag: 'hatchabot-runtime:latest', imageId: 'rel', openclawVersion: '2026.7.1-2', buildInputs: label(), layers: [L('1')] },
      { tag: BASE, imageId: 'loc', openclawVersion: '2026.7.1-2', buildInputs: label({ release: '2.189.0' }), layers: [L('2')] },
    ];
    dst.store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: BASE, dockerfile: 'RUN true', createdBy: 'me' });
    dst.store.setDerivedImageStatus('media', 'FAILED', 'an earlier failure');
    const file = await exported('hatchabot-runtime:derived-media', (src) => {
      src.provider.tags = [
        { tag: BASE, imageId: 'rel', openclawVersion: '2026.7.1-2', buildInputs: label(), layers: [L('1')] },
        { tag: 'hatchabot-runtime:derived-media', imageId: 'd', openclawVersion: '2026.7.1-2', buildInputs: label(), layers: [L('1'), L('3')], derived: 'media' },
      ];
      src.store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: BASE, dockerfile: 'RUN true', createdBy: 'o' });
      src.store.setDerivedImageStatus('media', 'READY');
    });
    await importAgent(dst.deps as never, file, { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(dst.provider.built.map((b) => b.dockerfile.split('\n')[0])).toEqual([`FROM ${BASE}`]);
    expect(dst.store.getDerivedImage('media')).toMatchObject({ status: 'READY', base: BASE });
  });

  it("what a base was built from names no image: a file from another fleet's names finds the same base (HB-1183)", async () => {
    const theirs = tamper(await jqFile(), (i) => { i.tag = 'example-runtime:derived-media'; i.recipe.base = 'example-runtime:2026.7.1-2-plus-jq'; });
    const dst = await plainMachine();
    const agent = await importAgent(dst.deps as never, theirs, { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(dst.store.getAgent(agent.id)?.image).toBe('hatchabot-runtime:derived-media');
    expect(dst.provider.built.map((b) => b.dockerfile.split('\n')[0])).toEqual(['FROM hatchabot-runtime:latest']);
    expect(dst.store.getDerivedImage('media')).toMatchObject({ status: 'READY', base: 'hatchabot-runtime:latest', basePackages: ['jq'] });
  });

  it("an image an import builds is stamped with the base its record here names, as a Rebuild here stamps it (HB-1516)", async () => {
    const theirs = tamper(await jqFile(), (i) => { i.tag = 'example-runtime:derived-media'; i.recipe.base = 'example-runtime:2026.7.1-2-plus-jq'; });
    const dst = await plainMachine();
    await importAgent(dst.deps as never, theirs, { ownerId: 'me', mayBuild: true, image: 'build' });
    const rec = dst.store.getDerivedImage('media')!;
    expect(rec).toMatchObject({ base: 'hatchabot-runtime:latest', basePackages: ['jq'] });
    // Was: stamped with the file's base, hatchabot-runtime:2026.7.1-2-plus-jq, which no record here names.
    const stamp = dst.provider.built[0]!.labels['org.hatchabot.recipe'];
    expect(stamp).toBe(recipeStamp(rec.base, rec.dockerfile, ['jq']));
    // So a move takes a copy of it on a runner whose listing gives no layers, by that stamp, instead of building it again.
    const mine = dst.provider.tags.find((t) => t.tag === 'hatchabot-runtime:derived-media')!;
    const runner = new MockProvider();
    runner.tags = [{ tag: mine.tag, imageId: 'copy', openclawVersion: '2026.7.1-2', buildInputs: mine.buildInputs, extraPackages: ['jq'], derived: 'media', recipe: stamp }];
    expect(await ensureImageOn(runner, dst.provider, mine.tag, derivedByTag((n) => dst.store.getDerivedImage(n)), 'garden-shed')).toEqual({ ok: true, built: false });
    expect(runner.built).toEqual([]);
  });

  it.each([
    ['runs as root', (p: MockProvider) => { p.buildRunsAs = 'root'; }, 'The built image would run as root, not node: a line in it hides the USER node Hatchabot adds at the end (a heredoc that runs to the end, for example). Change the lines and Rebuild.'],
    ['sets one of Hatchabot\'s own labels', (p: MockProvider) => { p.buildLabels = { 'org.hatchabot.build-inputs': 'v1;openclaw=2026.10.1' }; }, "The built image sets Hatchabot's own label org.hatchabot.build-inputs: a line in it hides a LABEL (in a heredoc or an escape). Change the lines and Rebuild."],
    ['is not built on its base', (p: MockProvider) => { p.buildLayers = [L('9')]; }, 'The built image is not built on hatchabot-runtime:latest: a line in it starts another image (a FROM hidden in a heredoc or an escape). Change the lines and Rebuild.'],
  ])("a file whose lines build an image that %s gets nothing: the import is rolled back, saying why in full (HB-1032)", async (_what, makes, why) => {
    const dst = await plainMachine();
    makes(dst.provider);
    const e = await importAgent(dst.deps as never, await jqFile(), { ownerId: 'me', mayBuild: true, image: 'build' }).catch((err) => err);
    expect(e).toBeInstanceOf(TransferError);
    expect(e.message).toBe(`Import failed and was rolled back — fix the cause and import again. (the image hatchabot-runtime:derived-media could not be built here: the rebuild failed: ${why})`);
    expect(e.message.length).toBeLessThanOrEqual(600);
    expect(dst.provider.tags.map((t) => t.tag)).toEqual(['hatchabot-runtime:latest']);
    expect(dst.store.getDerivedImage('media')).toBeUndefined();
    expect(dst.store.listAgents('me').filter((a) => a.state !== 'DELETED')).toEqual([]);
  });

  it("a base tag moved at the source since its image was built gives no layers to match, so the image here of the moved tag's layers is not taken for its base (HB-0986 review)", async () => {
    const MOVED = { tag: 'hatchabot-runtime:latest', imageId: 'new', openclawVersion: '2026.9.9', buildInputs: label({ openclaw: '2026.9.9' }), layers: [L('9')] };
    const file = await exported('hatchabot-runtime:derived-media', (src) => {
      // Built on the :latest of then (layers 1); :latest is another image now.
      src.provider.tags = [{ ...MOVED }, { tag: 'hatchabot-runtime:derived-media', imageId: 'd', openclawVersion: '2026.7.1-2', buildInputs: label(), layers: [L('1'), L('3')], derived: 'media' }];
      src.store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', createdBy: 'o' });
      src.store.setDerivedImageStatus('media', 'READY');
    });
    expect(JSON.parse(gunzipSync(file).toString('utf8')).image.recipe).toMatchObject({ inputs: label() });
    expect(JSON.parse(gunzipSync(file).toString('utf8')).image.recipe.layers).toBeUndefined();
    const dst = await installation('me');
    dst.provider.tags = [{ ...MOVED }, { tag: BASE, imageId: 'old', openclawVersion: '2026.7.1-2', buildInputs: label(), layers: [L('5')] }];
    await importAgent(dst.deps as never, file, { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(dst.provider.built.map((b) => b.dockerfile.split('\n')[0])).toEqual([`FROM ${BASE}`]);
  });

  it("a promote between the OpenClaw check and the build's own pick is not built on: the import says to try again (HB-0986 review)", async () => {
    const dst = await plainMachine();
    // Just as the build starts, after the check read the images: :latest is another image now.
    (dst.deps as { log?: (event: string) => void }).log = (event) => {
      if (event === 'import.image_build') dst.provider.tags = [{ ...dst.provider.tags[0]!, imageId: 'promoted', layers: [L('b')] }];
    };
    await expect(importAgent(dst.deps as never, await jqFile(), { ownerId: 'me', mayBuild: true, image: 'build' }))
      .rejects.toThrow("(the image hatchabot-runtime:derived-media could not be built here: this machine's images changed just now — try again)");
    expect(dst.provider.built).toEqual([]);
    // Unchanged between the two, it builds.
    const steady = await plainMachine();
    await importAgent(steady.deps as never, await jqFile(), { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(steady.provider.built.map((b) => b.dockerfile.split('\n')[0])).toEqual(['FROM hatchabot-runtime:latest']);
  });

  it("a file from before the label, judged by the image of its base's name, is not built on another image a promote put under that name since (HB-1319)", async () => {
    const m = JSON.parse(gunzipSync(await derivedFile()).toString('utf8'));
    expect([m.image.recipe.inputs, m.image.recipe.layers]).toEqual([undefined, undefined]);
    m.openclawVersion = '2026.7.1-2';
    const file = gzipSync(Buffer.from(JSON.stringify(m)));
    const machine = async () => {
      const dst = await installation('me');
      dst.provider.tags.push({ tag: BASE, imageId: 'judged', openclawVersion: '2026.7.1-2' });
      return dst;
    };
    // Just as the build starts, after the check read the image of BASE's name: another image has it now.
    const promoted = await machine();
    (promoted.deps as { log?: (event: string) => void }).log = (event) => {
      if (event === 'import.image_build') promoted.provider.tags = promoted.provider.tags.map((t) => (t.tag === BASE ? { tag: BASE, imageId: 'promoted', openclawVersion: '2026.9.8' } : t));
    };
    await expect(importAgent(promoted.deps as never, file, { ownerId: 'me', mayBuild: true, image: 'build' }))
      .rejects.toThrow("(the image hatchabot-runtime:derived-media could not be built here: this machine's images changed just now — try again)");
    expect(promoted.provider.built).toEqual([]);
    // The images not read at the build: said so, not taken for a change.
    const unread = await machine();
    (unread.deps as { log?: (event: string) => void }).log = (event) => {
      if (event === 'import.image_build') unread.provider.listImageTags = async () => { throw new Error('made-up daemon hiccup'); };
    };
    await expect(importAgent(unread.deps as never, file, { ownerId: 'me', mayBuild: true, image: 'build' }))
      .rejects.toThrow("(the image hatchabot-runtime:derived-media could not be built here: this machine's images could not be read just now — try again)");
    // Unchanged between the two, it builds on it.
    const steady = await machine();
    await importAgent(steady.deps as never, file, { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(steady.provider.built.map((b) => b.dockerfile.split('\n')[0])).toEqual([`FROM ${BASE}`]);
  });

  it("a stand-in that comes between an OpenClaw check that found none and the build is not built on unjudged (HB-1320)", async () => {
    const saved = await exported('hatchabot-runtime:derived-media', (src) => {
      src.provider.tags = [
        { tag: 'hatchabot-runtime:latest', imageId: 'srcbase', openclawVersion: '2026.9.8', buildInputs: label({ openclaw: '2026.9.8' }), layers: [L('1')] },
        { tag: 'hatchabot-runtime:derived-media', imageId: 'd', openclawVersion: '2026.9.8', buildInputs: label({ openclaw: '2026.9.8' }), layers: [L('1'), L('3')], derived: 'media' },
      ];
      src.store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', createdBy: 'o' });
      src.store.setDerivedImageStatus('media', 'READY');
    });
    const m = JSON.parse(gunzipSync(saved).toString('utf8'));
    m.openclawVersion = '2026.9.8';
    const file = gzipSync(Buffer.from(JSON.stringify(m)));
    const machine = async () => {
      const dst = await installation('me');
      // Nothing here stands for its base (an older OpenClaw); the published image of 2026.9.8 can be pulled.
      dst.provider.tags = [{ tag: 'hatchabot-runtime:latest', imageId: 'mock-image', openclawVersion: '2026.7.1-2', buildInputs: label(), layers: [L('a')] }];
      dst.provider.publishedBases.add('hatchabot-runtime:2026.9.8');
      dst.provider.publishedInfo.set('hatchabot-runtime:2026.9.8', { openclawVersion: '2026.9.8', buildInputs: label({ openclaw: '2026.9.8' }), layers: [L('9')] });
      return dst;
    };
    // Just as the build starts: an image that says it was built as the base was, and runs an older OpenClaw.
    const late = await machine();
    (late.deps as { log?: (event: string) => void }).log = (event) => {
      if (event === 'import.image_build') late.provider.tags.push({ tag: 'hatchabot-runtime:by-hand', imageId: 'by-hand', openclawVersion: '2026.7.1-2', buildInputs: label({ openclaw: '2026.9.8' }), layers: [L('h')] });
    };
    await expect(importAgent(late.deps as never, file, { ownerId: 'me', mayBuild: true, image: 'build' }))
      .rejects.toThrow("(the image hatchabot-runtime:derived-media could not be built here: this machine's images changed just now — try again)");
    expect([late.provider.built, late.provider.pulled]).toEqual([[], []]);
    // Nothing came: the published image of the OpenClaw it judged is pulled and built on.
    const steady = await machine();
    await importAgent(steady.deps as never, file, { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(steady.provider.pulled).toEqual(['hatchabot-runtime:2026.9.8']);
    expect(steady.provider.built.map((b) => b.dockerfile.split('\n')[0])).toEqual(['FROM hatchabot-runtime:2026.9.8']);
    // The published image of it pulled meanwhile (another import or move, Install image): built on, not refused.
    const pulled = await machine();
    (pulled.deps as { log?: (event: string) => void }).log = (event) => {
      if (event === 'import.image_build') pulled.provider.ensureBaseImage('hatchabot-runtime:2026.9.8').catch(() => undefined);
    };
    await importAgent(pulled.deps as never, file, { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(pulled.provider.pulled).toEqual(['hatchabot-runtime:2026.9.8']);
    expect(pulled.provider.built.map((b) => b.dockerfile.split('\n')[0])).toEqual(['FROM hatchabot-runtime:2026.9.8']);
    // Under that name, an image of another OpenClaw is refused.
    const other = await machine();
    (other.deps as { log?: (event: string) => void }).log = (event) => {
      if (event === 'import.image_build') other.provider.tags.push({ tag: 'hatchabot-runtime:2026.9.8', imageId: 'renamed', openclawVersion: '2026.7.1-2', buildInputs: label({ openclaw: '2026.9.8' }), layers: [L('r')] });
    };
    await expect(importAgent(other.deps as never, file, { ownerId: 'me', mayBuild: true, image: 'build' }))
      .rejects.toThrow("(the image hatchabot-runtime:derived-media could not be built here: this machine's images changed just now — try again)");
    expect(other.provider.built).toEqual([]);
  });

  it("the OpenClaw check's images not read is a refusal to try again, never a judgement by the file's own word (HB-0986 review)", async () => {
    const saved = await exported('hatchabot-runtime:derived-media', (src) => {
      src.provider.tags = [
        { tag: 'hatchabot-runtime:latest', imageId: 'srcbase', openclawVersion: '2026.9.8', buildInputs: label({ openclaw: '2026.9.8' }), layers: [L('1')] },
        { tag: 'hatchabot-runtime:derived-media', imageId: 'd', openclawVersion: '2026.9.8', buildInputs: label({ openclaw: '2026.9.8' }), layers: [L('1'), L('3')], derived: 'media' },
      ];
      src.store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', createdBy: 'o' });
      src.store.setDerivedImageStatus('media', 'READY');
    });
    const m = JSON.parse(gunzipSync(saved).toString('utf8'));
    m.openclawVersion = '2026.9.8';
    expect(m.image.recipe.inputs).toBe(label({ openclaw: '2026.9.8' }));
    const file = gzipSync(Buffer.from(JSON.stringify(m)));
    const machine = async () => {
      const dst = await installation('me');
      // The source base's very layers, under the label of an older OpenClaw: the build would run that.
      dst.provider.tags = [{ tag: 'hatchabot-runtime:latest', imageId: 'relabelled', openclawVersion: '2026.7.1-2', buildInputs: label({ openclaw: '2026.9.8' }), layers: [L('1')] }];
      return dst;
    };
    const read = await machine();
    await expect(importAgent(read.deps as never, file, { ownerId: 'me', mayBuild: true, image: 'build' })).rejects.toThrow(/would run it on 2026\.7\.1-2/);
    // The check's own read fails once (the first read is the image's name here).
    const busy = await machine();
    let reads = 0;
    const list = busy.provider.listImageTags.bind(busy.provider);
    busy.provider.listImageTags = async () => { if (++reads === 2) throw new Error('docker busy'); return list(); };
    await expect(importAgent(busy.deps as never, file, { ownerId: 'me', mayBuild: true, image: 'build' }))
      .rejects.toThrow("This machine's images could not be read just now. Try the import again.");
    expect([reads, busy.provider.built, busy.store.listAgents('me')]).toEqual([2, [], []]);
  });

  it('an older OpenClaw is judged by the base a record here is built on, as the build picks it (HB-0986 review)', async () => {
    const saved = await exported('hatchabot-runtime:derived-media', (src) => {
      src.provider.tags.push(
        { tag: 'hatchabot-runtime:2026.9.8', imageId: 'b', openclawVersion: '2026.9.8', buildInputs: label({ openclaw: '2026.9.8' }), layers: [L('1')] },
        { tag: 'hatchabot-runtime:derived-media', imageId: 'd', openclawVersion: '2026.9.8', buildInputs: label({ openclaw: '2026.9.8' }), layers: [L('1'), L('3')], derived: 'media' },
      );
      src.store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: 'hatchabot-runtime:2026.9.8', dockerfile: 'RUN true', createdBy: 'o' });
      src.store.setDerivedImageStatus('media', 'READY');
    });
    const m = JSON.parse(gunzipSync(saved).toString('utf8'));
    m.openclawVersion = '2026.9.8';
    const file = gzipSync(Buffer.from(JSON.stringify(m)));
    const dst = await installation('me');
    dst.provider.tags = [
      // The source base's very layers, under a label of an older OpenClaw (a LABEL adds no layer).
      { tag: 'hatchabot-runtime:latest', imageId: 'relabelled', openclawVersion: '2026.7.1-2', buildInputs: label({ openclaw: '2026.9.8' }), layers: [L('1')] },
      // What the record here is built on: built the same way, and kept as its base (F3).
      { tag: 'hatchabot-runtime:2026.9.8', imageId: 'here', openclawVersion: '2026.9.8', buildInputs: label({ openclaw: '2026.9.8', release: '2.189.0' }), layers: [L('2')] },
    ];
    dst.store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: 'hatchabot-runtime:2026.9.8', dockerfile: 'RUN true', createdBy: 'me' });
    dst.store.setDerivedImageStatus('media', 'FAILED', 'an earlier failure');
    await importAgent(dst.deps as never, file, { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(dst.provider.built.map((b) => b.dockerfile.split('\n')[0])).toEqual(['FROM hatchabot-runtime:2026.9.8']);
  });

  it('an older OpenClaw is judged by the image it will be built on here, not by its base by name (HB-0986 review)', async () => {
    // A base from before the label: the file has its layers, not what it was built from.
    const saved = await exported('hatchabot-runtime:derived-media', (src) => {
      src.provider.tags.push(
        { tag: 'hatchabot-runtime:2026.9.8', imageId: 'b', openclawVersion: '2026.9.8', layers: [L('1')] },
        { tag: 'hatchabot-runtime:derived-media', imageId: 'd', openclawVersion: '2026.9.8', layers: [L('1'), L('3')], derived: 'media' },
      );
      src.store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: 'hatchabot-runtime:2026.9.8', dockerfile: 'RUN true', createdBy: 'o' });
      src.store.setDerivedImageStatus('media', 'READY');
    });
    // Its agent ran OpenClaw 2026.9.8, which 2026.7 cannot read.
    const m = JSON.parse(gunzipSync(saved).toString('utf8'));
    m.openclawVersion = '2026.9.8';
    const file = gzipSync(Buffer.from(JSON.stringify(m)));
    expect(m.image.recipe.inputs).toBeUndefined();
    expect(m.image.recipe.layers).toMatch(/^sha256:/);
    // Here, the name is a hand-made build of an older OpenClaw; the image of those very layers is :latest.
    const dst = await installation('me');
    dst.provider.tags = [
      { tag: 'hatchabot-runtime:latest', imageId: 'same', openclawVersion: '2026.9.8', layers: [L('1')] },
      { tag: 'hatchabot-runtime:2026.9.8', imageId: 'hand', openclawVersion: '2026.7.1-2', layers: [L('2')] },
    ];
    const agent = await importAgent(dst.deps as never, file, { ownerId: 'me', mayBuild: true, image: 'build' });
    expect(dst.store.getAgent(agent.id)?.image).toBe('hatchabot-runtime:derived-media');
    expect(dst.provider.built.map((b) => b.dockerfile.split('\n')[0])).toEqual(['FROM hatchabot-runtime:latest']);
  });

  it('nothing here is built that way: the import says so, and builds nothing', async () => {
    const dst = await installation('me');
    dst.provider.tags = [{ tag: 'hatchabot-runtime:latest', imageId: 'mock-image', openclawVersion: '2026.9.8', buildInputs: label({ openclaw: '2026.9.8', engine: 'none' }) }];
    await expect(importAgent(dst.deps as never, await jqFile(), { ownerId: 'me', mayBuild: true, image: 'build' }))
      .rejects.toThrow("Import failed and was rolled back — fix the cause and import again. (the image hatchabot-runtime:derived-media could not be built here: no image on this machine is built the way hatchabot-runtime:derived-media's base is: hatchabot-runtime:latest runs OpenClaw 2026.9.8, not 2026.7.1-2; an image built there from Settings would not be either (it would have slack and discord built in, not none), so run it on this machine's default image)");
    // A base with the messaging plugins a build from Settings bakes (docker/Dockerfile.runtime): one is offered.
    const file = tamper(await jqFile(), (i) => { i.recipe.inputs = label({ packages: ['jq'], channels: ['slack', 'discord'] }); });
    await expect(importAgent(dst.deps as never, file, { ownerId: 'me', mayBuild: true, image: 'build' }))
      .rejects.toThrow("Import failed and was rolled back — fix the cause and import again. (the image hatchabot-runtime:derived-media could not be built here: no image on this machine is built the way hatchabot-runtime:derived-media's base is: hatchabot-runtime:latest runs OpenClaw 2026.9.8, not 2026.7.1-2. Build an image of OpenClaw 2026.7.1-2 with jq on this machine (Settings → Advanced → Runtime images), then try again, or run it on this machine's default image)");
    expect(dst.provider.built).toEqual([]);
    expect(dst.store.getDerivedImage('media')).toBeUndefined();
  });

  it('the advice on what to build is kept whole in the rolled-back reason: digests short, the first difference in full and a count of the rest (HB-1333)', async () => {
    // Its base was built with a Node by digest and the plugins set by hand: 691 characters of cause, cut at 500
    // mid-setting ("…node:24-slim@sha256:eee… and plugi").
    const dst = await installation('me');
    dst.provider.tags = [{ tag: 'hatchabot-runtime:latest', imageId: 'mock-image', openclawVersion: '2026.7.1-2', buildInputs: label() }];
    const byHand = { packages: ['jq'], byHand: ['node', 'plugins'] as BuildInputs['byHand'], node: `node:24-slim@${L('e')}`, plugins: ['duckduckgo=@openclaw/duckduckgo-plugin', 'brave=@openclaw/brave-plugin'] };
    const file = tamper(await jqFile(), (i) => { i.recipe.inputs = label(byHand); });
    const e = await importAgent(dst.deps as never, file, { ownerId: 'me', mayBuild: true, image: 'build' }).then(() => undefined, (err: unknown) => err as Error);
    expect(e?.message).toBe("Import failed and was rolled back — fix the cause and import again. (the image hatchabot-runtime:derived-media could not be built here: no image on this machine is built the way hatchabot-runtime:derived-media's base is: the base was built with node set by hand (node:24-slim@sha256:eeeeeeeeeeee…), and hatchabot-runtime:latest was not. Build an image of OpenClaw 2026.7.1-2 with jq on this machine with 2 settings set by hand, as its base was (scripts/build-runtime-image.sh), then try again, or run it on this machine's default image)");
    // Where it fits, it is named.
    const one = tamper(await jqFile(), (i) => { i.recipe.inputs = label({ ...byHand, byHand: ['node'] }); });
    const named = await importAgent(dst.deps as never, one, { ownerId: 'me', mayBuild: true, image: 'build' }).then(() => undefined, (err: unknown) => err as Error);
    expect(named?.message).toMatch(/ with node set by hand to node:24-slim@sha256:eeeeeeeeeeee…, as its base was \(scripts\/build-runtime-image\.sh\), then try again, or run it on this machine's default image\)$/);
    expect(named!.message.length).toBeLessThanOrEqual(600);
    expect(dst.provider.built).toEqual([]);
  });

  it("an older OpenClaw is judged by the one its base was built from, not by the base's name here", async () => {
    // Saved by an OpenClaw newer than the one the recipe's base runs.
    const file = gzipSync(Buffer.from(JSON.stringify({ ...JSON.parse(gunzipSync(await jqFile()).toString('utf8')), openclawVersion: '2026.9.8' })));
    const dst = await plainMachine();
    await expect(importAgent(dst.deps as never, file, { ownerId: 'me', mayBuild: true, image: 'build' })).rejects.toThrow(/saved by OpenClaw 2026\.9\.8; this machine would run it on 2026\.7\.1-2/);
    expect(dst.provider.built).toEqual([]);
  });
});
