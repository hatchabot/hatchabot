import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { gzipSync, gunzipSync } from 'node:zlib';
import { exportAgent, ImageDecisionNeeded, importAgent, TransferError } from '../src/orchestrator/transfer.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import type { ChannelProvisioner } from '../src/channels/channel.js';

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
    const agent = await importAgent(dst.deps as never, await derivedFile(), { ownerId: 'me' });
    expect(dst.store.getAgent(agent.id)?.image).toBe('hatchabot-runtime:derived-media');
    expect(dst.provider.built).toEqual([]);
  });

  it.each([
    ['its own FROM', (i: any) => { i.recipe.lines = 'FROM evil/image\nRUN true'; }, /own FROM/],
    ['a network flag split over a continued line', (i: any) => { i.recipe.lines = 'RUN --network\\\n=host curl http://127.0.0.1:11434/'; }, /--network/],
    ['a mount flag split over a continued line', (i: any) => { i.recipe.lines = 'RUN --mount \\\n=type=bind,source=/,target=/h cat /h/x'; }, /--mount/],
    ['a package name that removes', (i: any) => { i.tag = `${BASE}-plus-x`; i.recipe.lines = undefined; i.recipe.packages = ['curl-']; }, /package list/],
    ['a derived name the machine would not accept', (i: any) => { i.tag = 'hatchabot-runtime:derived-Foo.Bar'; }, /derived-image name/],
    ['a build-time mount', (i: any) => { i.recipe.lines = 'RUN --mount=type=bind,source=/,target=/h cat /h/etc/shadow'; }, /--mount/],
    ['a USER of its own', (i: any) => { i.recipe.lines = 'USER root'; }, /USER is managed/],
    ['a foreign image name', (i: any) => { i.tag = 'evil/hatchabot:derived-media'; }, /not a runtime image name/],
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

  it('a different image here under the same name is not replaced', async () => {
    const dst = await installation('me');
    dst.provider.publishedBases.add(BASE);
    dst.store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: BASE, dockerfile: 'RUN apt-get install -y imagemagick', createdBy: 'me' });
    dst.store.setDerivedImageStatus('media', 'FAILED', 'earlier failure');
    const e = await decision(importAgent(dst.deps as never, await derivedFile(), { ownerId: 'me', mayBuild: true, image: 'build' }));
    expect(e.problem).toMatch(/different image here already has the name/);
    expect(dst.store.getDerivedImage('media')?.dockerfile).toContain('imagemagick');
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
