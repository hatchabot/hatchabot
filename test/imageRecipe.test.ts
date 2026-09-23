import { describe, expect, it } from 'vitest';
import { recipeDockerfile, recipeFor } from '../src/orchestrator/imageRecipe.js';
import { MockProvider } from '../src/providers/mockProvider.js';

describe('image recipes', () => {
  it('a derived image is its base plus its own lines, root for the lines, node after', async () => {
    const derived = { name: 'with-pdf', tag: 'hatchabot-runtime:derived-with-pdf', base: 'hatchabot-runtime:2026.7.1-2', dockerfile: 'RUN apt-get update && apt-get install -y poppler-utils' } as any;
    const r = await recipeFor(new MockProvider(), derived.tag, (t) => (t === derived.tag ? derived : undefined));
    expect(r).toMatchObject({ base: 'hatchabot-runtime:2026.7.1-2', packages: [] });
    const df = recipeDockerfile(r as any);
    expect(df).toBe('FROM hatchabot-runtime:2026.7.1-2\nUSER root\nRUN apt-get update && apt-get install -y poppler-utils\nUSER node\n');
  });
  it('only valid package names reach the build line', async () => {
    const p = new MockProvider();
    p.tags.push({ tag: 'hatchabot-runtime:x-plus', imageId: 'i', openclawVersion: '2026.7.1-2', extraPackages: ['jq', 'evil; rm -rf /', 'curl'] } as any);
    const r = await recipeFor(p, 'hatchabot-runtime:x-plus', () => undefined);
    expect((r as any).packages).toEqual(['jq', 'curl']);
  });
});
