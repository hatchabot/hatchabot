import { describe, expect, it } from 'vitest';
import { isCatalogued, parseRuntimeModels, runtimeModels } from '../src/orchestrator/runtimeModels.js';
import { MockProvider } from '../src/providers/mockProvider.js';

/**
 * Verbatim shape from a live OpenClaw 2026.7.1 claude-cli runtime — the one
 * that served claude-opus-5 as a stub and broke compaction fleet-wide.
 */
const LIVE = JSON.stringify({
  count: 4,
  models: [
    { key: 'anthropic/claude-opus-4-8', name: 'Claude Opus 4.8', input: 'text+image', contextWindow: 1048576, local: false, available: false, tags: ['default', 'configured', 'alias:opus'], missing: false },
    { key: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', input: 'text+image', contextWindow: 1000000, local: false, available: false, tags: ['configured', 'alias:sonnet'], missing: false },
    { key: 'anthropic/claude-fable-5', name: 'Claude Fable 5', input: 'text+image', contextWindow: 1000000, local: false, available: false, tags: ['configured'], missing: false },
    // The poison pill: OpenClaw echoes the id back as the name because it has
    // no catalog entry — yet it is still tagged "configured" (we put it there).
    { key: 'anthropic/claude-opus-5', name: 'claude-opus-5', input: 'text', contextWindow: 200000, local: false, available: false, tags: ['configured'], missing: false },
  ],
});

describe('isCatalogued', () => {
  it('rejects the stub that names itself after its own id', () => {
    // This exact pair is what caused the outage.
    expect(isCatalogued({ key: 'anthropic/claude-opus-4-8', name: 'Claude Opus 4.8' })).toBe(true);
    expect(isCatalogued({ key: 'anthropic/claude-opus-5', name: 'claude-opus-5' })).toBe(false);
  });

  it('treats a missing or fully-qualified echo as uncatalogued too', () => {
    expect(isCatalogued({ key: 'anthropic/x', name: '' })).toBe(false);
    expect(isCatalogued({ key: 'anthropic/x' })).toBe(false);
    expect(isCatalogued({ key: 'anthropic/x', name: 'anthropic/x' })).toBe(false);
    // Case differences alone don't make it a real name.
    expect(isCatalogued({ key: 'anthropic/Claude-Opus-5', name: 'claude-opus-5' })).toBe(false);
  });
});

describe('parseRuntimeModels', () => {
  it('keeps the bare id and flags which models are genuinely served', () => {
    const models = parseRuntimeModels(LIVE);
    expect(models).toHaveLength(4);
    const usable = models.filter((m) => m.catalogued).map((m) => m.id);
    expect(usable).toEqual(['claude-opus-4-8', 'claude-sonnet-5', 'claude-fable-5']);
    // The one that broke compaction is excluded despite being "configured".
    expect(models.find((m) => m.id === 'claude-opus-5')!.catalogued).toBe(false);
  });

  it('survives garbage rather than throwing', () => {
    expect(parseRuntimeModels('not json')).toEqual([]);
    expect(parseRuntimeModels('{}')).toEqual([]);
    expect(parseRuntimeModels(JSON.stringify({ models: [{ nope: 1 }, null] }))).toEqual([]);
    // A bare array is accepted too.
    expect(parseRuntimeModels(JSON.stringify([{ key: 'anthropic/a', name: 'A' }]))).toHaveLength(1);
  });
});

describe('runtimeModels', () => {
  async function seeded() {
    const p = new MockProvider();
    const { runtimeRef } = await p.provision({
      agentId: 'a1', slug: 'a1',
      workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {},
    } as any);
    return { p, runtimeRef };
  }

  it('asks the runtime for the full catalog as json', async () => {
    const { p, runtimeRef } = await seeded();
    p.execResponses.set('models list', { code: 0, stdout: LIVE, stderr: '' });
    const out = await runtimeModels(p, runtimeRef, 'anthropic');
    expect(out.filter((m) => m.catalogued).map((m) => m.id)).toContain('claude-opus-4-8');
    expect(p.execLog).toContainEqual(['models', 'list', '--provider', 'anthropic', '--all', '--json']);
  });

  it('returns [] (never throws) when the CLI is old or the agent is unreachable', async () => {
    const { p, runtimeRef } = await seeded();
    p.execResponses.set('models list', { code: 1, stdout: '', stderr: 'unknown option --all' });
    expect(await runtimeModels(p, runtimeRef, 'anthropic')).toEqual([]);
    p.exec = (async () => { throw new Error('container gone'); }) as any;
    expect(await runtimeModels(p, runtimeRef, 'anthropic')).toEqual([]);
  });
});
