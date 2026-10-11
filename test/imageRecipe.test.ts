import { describe, expect, it } from 'vitest';
import { buildRecipeOn, recipeDockerfile, recipeFor, recipeProblem } from '../src/orchestrator/imageRecipe.js';
import { MockProvider } from '../src/providers/mockProvider.js';

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
  it('a plain version tag built with extra packages gets them back after the pull (#161)', async () => {
    const dest = new MockProvider();
    dest.publishedBases.add('hatchabot-runtime:2026.9.6');
    const r = { tag: 'hatchabot-runtime:2026.9.6', base: 'hatchabot-runtime:2026.9.6', packages: ['jq'], channels: [] };
    expect(await buildRecipeOn(dest, r)).toEqual({ ok: true, built: true });
    expect(dest.pulled).toEqual(['hatchabot-runtime:2026.9.6']);
    expect(dest.built.map((b) => [b.tag, b.dockerfile.includes('install -y --no-install-recommends jq')])).toEqual([['hatchabot-runtime:2026.9.6', true]]);
    // Without packages, the pull is all.
    const plain = new MockProvider();
    plain.publishedBases.add('hatchabot-runtime:2026.9.6');
    expect(await buildRecipeOn(plain, { ...r, packages: [] })).toEqual({ ok: true, built: false });
  });
});

describe('images with their own build (2026-09-28)', () => {
  it('a -lite image gives no recipe: rebuilt from the version it would be a different image', async () => {
    const p = new MockProvider();
    p.tags.push({ tag: 'hatchabot-runtime:2026.7.1-2-lite', imageId: 'i', openclawVersion: '2026.7.1-2' } as any);
    expect(await recipeFor(p, 'hatchabot-runtime:2026.7.1-2-lite', () => undefined)).toMatchObject({ problem: expect.stringMatching(/own build/) });
  });
});
