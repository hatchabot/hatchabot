import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { buildConfigCommands, memoryKeyPrefix } from '../src/openclaw/configWriter.js';
import { buildRuntimeSpec, recordApplied, reindexMemoryIfSwitched, type ProvisionDeps } from '../src/orchestrator/provision.js';
import { embedKeyHash } from '../src/embedder/embedder.js';

/**
 * Step 2 of the embedder: an agent switched to the machine's shared memory
 * search service. Its config points OpenClaw at the door with the agent's
 * own key; when the service cannot be had it is built on the baked engine
 * and says so; a switch re-indexes.
 */

const OWNER = 'o';
class MemSecrets {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) { const v = this.map.get(ref); if (v === undefined) throw new Error('missing'); return v; }
  async delete(ref: string) { this.map.delete(ref); }
}
const channelStub = { kind: 'telegram', pool: { owns: () => false } } as never;

describe('what OpenClaw is told', () => {
  it('shared: the openai-compatible provider at the door, with the agent key marked sensitive; baked: the plugin', () => {
    const base = { agentId: 'todo', authMode: 'api-key' as const, model: 'm' };
    const shared = buildConfigCommands({ ...base, embed: { baseUrl: 'http://172.17.0.1:8093/v1', token: 'agent-key', model: 'embeddinggemma' }, openclawVersion: '2026.7.1-2' });
    const flat = shared.map((c) => c.argv.join(' '));
    expect(flat.some((l) => l.includes('agents.defaults.memorySearch.provider openai-compatible'))).toBe(true);
    expect(flat.some((l) => l.includes('agents.defaults.memorySearch.remote.baseUrl http://172.17.0.1:8093/v1'))).toBe(true);
    expect(shared.find((c) => c.argv.includes('agents.defaults.memorySearch.remote.apiKey'))?.sensitive).toBe(true);
    expect(flat.some((l) => l.includes('plugins enable llama-cpp'))).toBe(false);
    expect(flat.some((l) => l.includes('local.modelPath'))).toBe(false);

    const baked = buildConfigCommands({ ...base, openclawVersion: '2026.7.1-2' }).map((c) => c.argv.join(' '));
    expect(baked.some((l) => l.includes('plugins enable llama-cpp'))).toBe(true);
    expect(baked.some((l) => l.includes('agents.defaults.memorySearch.provider local'))).toBe(true);
    expect(baked.some((l) => l.includes('openai-compatible'))).toBe(false);
  });

  it('2026.8 and later keep memory search under memory.search', () => {
    expect(memoryKeyPrefix('2026.7.1-2')).toBe('agents.defaults.memorySearch');
    expect(memoryKeyPrefix('2026.8.0')).toBe('memory.search');
    expect(memoryKeyPrefix('2026.9.4')).toBe('memory.search');
    expect(memoryKeyPrefix(undefined)).toBe('agents.defaults.memorySearch');
    const cmds = buildConfigCommands({ agentId: 'x', authMode: 'api-key', embed: { baseUrl: 'http://d/v1', token: 't', model: 'e' }, openclawVersion: '2026.9.4' });
    expect(cmds.some((c) => c.argv.includes('memory.search.provider'))).toBe(true);
  });
});

function world(hostKind: 'local' | 'cloud' = 'local') {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: hostKind, provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
  const secrets = new MemSecrets();
  void secrets.put('ai/p1', 'sk');
  const provider = new MockProvider();
  const events: string[] = [];
  store.insertAgent({ id: 'todo', ownerId: OWNER, name: 'To Do', slug: 'to-do', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
  store.setAgentEmbedMode('todo', 'shared');
  const minted: string[] = [];
  const embedder: NonNullable<ProvisionDeps['embedder']> = {
    async ensure() { return { doorAddress: '172.17.0.1:8093', model: 'embeddinggemma' }; },
    async mintKey(id) { const t = `key-for-${id}`; minted.push(t); store.setEmbedToken(id, embedKeyHash(t)); return t; },
  };
  const deps = (withEmbedder: boolean): ProvisionDeps => ({ store, secrets, provider, channel: channelStub, log: (e) => events.push(e), sleep: async () => {}, ...(withEmbedder ? { embedder } : {}) });
  return { store, provider, events, minted, deps };
}

describe('building a switched agent', () => {
  it('points it at the door with a freshly minted key, and records what was used', async () => {
    const w = world();
    const spec = await buildRuntimeSpec(w.deps(true), 'todo');
    expect(spec.workspace.configPatch.embed).toEqual({ baseUrl: 'http://172.17.0.1:8093/v1', token: 'key-for-todo', model: 'embeddinggemma' });
    expect(w.minted).toEqual(['key-for-todo']);
    expect(w.store.listEmbedTokens().map((t) => t.agentId)).toEqual(['todo']);
    recordApplied(w.store, 'todo');
    expect(w.store.getAgent('todo')!.appliedEmbedMode).toBe('shared');
  });

  it('with no service to be had it is built on the baked engine, and says why', async () => {
    const w = world();
    const spec = await buildRuntimeSpec(w.deps(false), 'todo');
    expect(spec.workspace.configPatch.embed).toBeUndefined();
    expect(w.events).toContain('embed.baked_instead');
    recordApplied(w.store, 'todo');
    expect(w.store.getAgent('todo')!.appliedEmbedMode).toBe('baked');
  });

  it('on a runner it stays baked (the door is on the other machine)', async () => {
    const w = world('cloud');
    const spec = await buildRuntimeSpec(w.deps(true), 'todo');
    expect(spec.workspace.configPatch.embed).toBeUndefined();
    expect(w.minted).toEqual([]);
  });

  it('an unswitched agent is untouched: no key, no embed config', async () => {
    const w = world();
    w.store.setAgentEmbedMode('todo', 'baked');
    const spec = await buildRuntimeSpec(w.deps(true), 'todo');
    expect(spec.workspace.configPatch.embed).toBeUndefined();
    expect(w.minted).toEqual([]);
  });
});

describe('re-indexing after a switch', () => {
  it('runs a forced index once, verifies with status, and records the result', async () => {
    const w = world();
    const calls: string[][] = [];
    w.provider.exec = async (_ref: string, argv: string[]) => { calls.push(argv); return { code: 0, stdout: argv[1] === 'status' ? 'Embeddings: ready\nSemantic vectors: ready' : '', stderr: '' }; };
    await buildRuntimeSpec(w.deps(true), 'todo');
    recordApplied(w.store, 'todo');
    const log = (e: string) => w.events.push(e);
    await reindexMemoryIfSwitched(w.deps(true), 'todo', 'docker://todo', log);
    expect(calls).toEqual([
      ['memory', 'index', '--force', '--agent', 'to-do'],
      ['memory', 'status', '--deep', '--agent', 'to-do'],
    ]);
    const a = w.store.getAgent('todo')!;
    expect(a.embedIndexedAt).toBeTruthy();
    expect(a.embedIndexError).toBeUndefined();
    // The next build on the same engine does not re-index.
    await buildRuntimeSpec(w.deps(true), 'todo');
    recordApplied(w.store, 'todo');
    await reindexMemoryIfSwitched(w.deps(true), 'todo', 'docker://todo', log);
    expect(calls).toHaveLength(2);
  });

  it('a failed index is a warning on the agent, not a failed build', async () => {
    const w = world();
    w.provider.exec = async () => ({ code: 1, stdout: '', stderr: 'provider unreachable' });
    await buildRuntimeSpec(w.deps(true), 'todo');
    recordApplied(w.store, 'todo');
    await reindexMemoryIfSwitched(w.deps(true), 'todo', 'docker://todo', (e) => w.events.push(e));
    const a = w.store.getAgent('todo')!;
    expect(a.embedIndexError).toMatch(/provider unreachable/);
    expect(a.embedIndexedAt).toBeUndefined();
    expect(w.events).toContain('memory.reindex_failed');
  });

  it('switching back re-indexes too', async () => {
    const w = world();
    const calls: string[][] = [];
    w.provider.exec = async (_ref: string, argv: string[]) => { calls.push(argv); return { code: 0, stdout: 'ready', stderr: '' }; };
    await buildRuntimeSpec(w.deps(true), 'todo');
    recordApplied(w.store, 'todo');
    await reindexMemoryIfSwitched(w.deps(true), 'todo', 'docker://todo', () => {});
    w.store.setAgentEmbedMode('todo', 'baked');
    await buildRuntimeSpec(w.deps(true), 'todo');
    recordApplied(w.store, 'todo');
    await reindexMemoryIfSwitched(w.deps(true), 'todo', 'docker://todo', () => {});
    expect(calls.filter((c) => c[1] === 'index')).toHaveLength(2);
    expect(w.store.getAgent('todo')!.appliedEmbedMode).toBe('baked');
  });
});

describe('over the API', () => {
  it('the owner switches an agent; the record shows the mode and what was applied', async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
    store.insertAgent({ id: 'todo', ownerId: OWNER, name: 'To Do', slug: 'to-do', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'docker://todo', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    const f = Fastify();
    await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]), channel: channelStub } as never);
    const H = { 'x-hatchabot-owner': OWNER };
    expect((await f.inject({ method: 'PATCH', url: '/v1/agents/todo', headers: H, payload: { embedMode: 'sideways' } })).statusCode).toBe(400);
    const r = await f.inject({ method: 'PATCH', url: '/v1/agents/todo', headers: H, payload: { embedMode: 'shared' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().embedMode).toBe('shared');
    expect((await f.inject({ method: 'PATCH', url: '/v1/agents/todo', headers: { 'x-hatchabot-owner': 'someone-else' }, payload: { embedMode: 'baked' } })).statusCode).toBe(404);
    expect(store.getAgent('todo')!.embedMode).toBe('shared');
  });
});
