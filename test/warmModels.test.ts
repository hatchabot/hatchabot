import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWarmLocalModels, WARM_FOR_MS } from '../src/orchestrator/sources/warmModels.js';
import { as, makeWorld, OWNER } from './support/world.js';

/**
 * Which local models are loaded, per model server (the agent list's
 * `modelWarm`). Every tile of the list is built at once, so each one asked
 * the same server while the first answer was still on its way: one `/api/ps`
 * per agent on each refresh of the 15-second cache (HB-1102). The model
 * server is a stub; nothing is contacted.
 */
afterEach(() => { vi.restoreAllMocks(); });

const BASE = 'http://models.invalid:11434/v1';

describe("the agent list's warm-model check (HB-1102)", () => {
  it('one list of many agents on one model server asks it once', async () => {
    const w = await makeWorld();
    const asked: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (!url.endsWith('/api/ps')) return new Response('{}', { status: 404 });
      asked.push(url);
      // The answer takes a moment, as a real server's does: every tile is being built meanwhile.
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ models: [{ name: 'gpt-oss' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      w.store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Local', vendor: 'local', kind: 'api_key', model: 'gpt-oss', baseUrl: BASE, secretRef: 'ai/p2', createdAt: 'now' });
      for (const [i, name] of ['Kitchen', 'Garden', 'Homework', 'Budget', 'Recipes', 'Travel'].entries()) {
        w.store.insertAgent({ id: `a${i}`, ownerId: OWNER, name, slug: name.toLowerCase(), state: 'STOPPED', aiProfileId: 'p2', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
      }
      const list = await w.f.inject({ method: 'GET', url: '/v1/agents', headers: as() });
      expect(list.statusCode, list.body).toBe(200);
      const tiles = list.json() as Array<{ name: string; modelWarm?: boolean }>;
      expect(tiles).toHaveLength(6);
      expect(tiles.every((t) => t.modelWarm === true), JSON.stringify(tiles.map((t) => [t.name, t.modelWarm]))).toBe(true);
      expect(asked).toEqual(['http://models.invalid:11434/api/ps']);
      // Within the 15 seconds, the next list asks nothing.
      await w.f.inject({ method: 'GET', url: '/v1/agents', headers: as() });
      expect(asked).toHaveLength(1);
    } finally { await w.f.close(); }
  });

  // Review of HB-1339: /api/ps names a model with its tag, `llama3:latest` for `llama3`, so a source naming
  // none always read cold. A name with no tag is its `:latest`, as the source's check reads it; another tag is another model.
  it('a model named with no tag is warm when the server has its :latest loaded, and only then', async () => {
    const w = await makeWorld();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (!String(input).endsWith('/api/ps')) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ models: [{ name: 'llama3:latest' }, { name: 'qwen3:8b' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      for (const [i, model] of ['llama3', 'qwen3', 'llama3:8b', 'qwen3:8b'].entries()) {
        w.store.insertAIProfile({ id: `pw${i}`, ownerId: OWNER, name: `Local ${i}`, vendor: 'local', kind: 'api_key', model, baseUrl: BASE, secretRef: `ai/pw${i}`, createdAt: 'now' });
        w.store.insertAgent({ id: `w${i}`, ownerId: OWNER, name: `Helper ${i}`, slug: `helper-${i}`, state: 'STOPPED', aiProfileId: `pw${i}`, hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
      }
      const list = await w.f.inject({ method: 'GET', url: '/v1/agents', headers: as() });
      expect(list.statusCode, list.body).toBe(200);
      const warmth = Object.fromEntries((list.json() as Array<{ id: string; modelWarm?: boolean }>).map((t) => [t.id, t.modelWarm]));
      expect(warmth).toMatchObject({ w0: true, w1: false, w2: false, w3: true });
    } finally { await w.f.close(); }
  });

  it('keeps an answer 15 seconds from when it came, per server, and a server that does not answer has nothing warm', async () => {
    let t = 1_000_000;
    const answers = new Map<string, () => void>();
    const asked: string[] = [];
    const warm = createWarmLocalModels({
      now: () => t,
      fetch: async (url) => {
        asked.push(url);
        if (url.includes('down.invalid')) throw new Error('connect refused');
        await new Promise<void>((r) => { answers.set(url, r); });
        return new Response(JSON.stringify({ models: [{ name: 'small' }, {}] }));
      },
    });
    const first = warm(BASE);
    const second = warm(`${BASE}`);
    const other = warm('http://other.invalid:11434');
    expect(asked).toEqual(['http://models.invalid:11434/api/ps', 'http://other.invalid:11434/api/ps']);
    t += WARM_FOR_MS * 2; // a slow answer: its 15 seconds start when it comes
    answers.get('http://models.invalid:11434/api/ps')!();
    expect(await first).toEqual(['small']);
    expect(await second).toEqual(['small']);
    expect(await warm(BASE)).toEqual(['small']);
    expect(asked).toHaveLength(2);
    t += WARM_FOR_MS;
    const again = warm(BASE);
    expect(asked).toHaveLength(3);
    answers.get('http://models.invalid:11434/api/ps')!();
    expect(await again).toEqual(['small']);
    answers.get('http://other.invalid:11434/api/ps')!();
    expect(await other).toEqual(['small']);
    expect(await warm('http://down.invalid:11434/v1/')).toEqual([]);
  });
});
