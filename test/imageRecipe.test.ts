import { describe, expect, it } from 'vitest';
import { recipeDockerfile, recipeFor } from '../src/orchestrator/imageRecipe.js';
import { MockProvider } from '../src/providers/mockProvider.js';

describe('image recipes', () => {
  it('a derived image is its base plus its own lines, root for the lines, node after', async () => {
    const derived = { name: 'with-pdf', tag: 'hatchabot-runtime:derived-with-pdf', base: 'hatchabot-runtime:2026.7.1-2', dockerfile: 'RUN apt-get update && apt-get install -y poppler-utils', status: 'READY' } as any;
    const r = await recipeFor(new MockProvider(), derived.tag, (t) => (t === derived.tag ? derived : undefined));
    expect(r).toMatchObject({ base: 'hatchabot-runtime:2026.7.1-2', packages: [] });
    const df = recipeDockerfile(r as any);
    expect(df).toBe('FROM hatchabot-runtime:2026.7.1-2\nUSER root\nRUN apt-get update && apt-get install -y poppler-utils\nUSER node\n');
  });
  it('only valid package names reach the build line', async () => {
    const p = new MockProvider();
    p.tags.push({ tag: 'hatchabot-runtime:2026.7.1-2-plus-jq-curl', imageId: 'i', openclawVersion: '2026.7.1-2', extraPackages: ['jq', 'evil; rm -rf /', 'curl'] } as any);
    const r = await recipeFor(p, 'hatchabot-runtime:2026.7.1-2-plus-jq-curl', () => undefined);
    expect((r as any).packages).toEqual(['jq', 'curl']);
  });
});

describe('images with their own build (2026-09-28)', () => {
  it('a -lite image gives no recipe: rebuilt from the version it would be a different image', async () => {
    const p = new MockProvider();
    p.tags.push({ tag: 'hatchabot-runtime:2026.7.1-2-lite', imageId: 'i', openclawVersion: '2026.7.1-2' } as any);
    expect(await recipeFor(p, 'hatchabot-runtime:2026.7.1-2-lite', () => undefined)).toMatchObject({ problem: expect.stringMatching(/own build/) });
  });
});
