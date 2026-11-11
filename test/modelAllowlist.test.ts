import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { foldDatedIds } from '../src/orchestrator/modelOptions.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * HB-0666, HB-0668, HB-0669 (~/hbt_models_bug.md, 2026-11-10): on OpenClaw
 * 2026.9+ an agent may pick only the models on agents.defaults.modelPolicy.allow,
 * which Hatchabot never wrote; a source's list reached its agents only at a
 * rebuild; and the source's menu offered dated ids twice. Made-up data.
 */
class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const as = { 'x-hatchabot-owner': OWNER };
const ALLOW = 'agents.defaults.modelPolicy.allow';

async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({
    id: 'p1', ownerId: OWNER, name: 'Cloud', vendor: 'anthropic', kind: 'api_key',
    model: 'claude-opus-4-8', models: ['claude-opus-4-8', 'claude-sonnet-5'], secretRef: 'ai/p1', createdAt: 'now',
  });
  store.insertAIProfile({
    id: 'p2', ownerId: OWNER, name: 'Other', vendor: 'anthropic', kind: 'api_key',
    model: 'claude-haiku-4-5', secretRef: 'ai/p2', createdAt: 'now',
  });
  async function seed(id: string, slug: string, aiProfileId: string, applied: string, opts: { model?: string; version?: string; state?: 'RUNNING' | 'STOPPED' } = {}) {
    const { runtimeRef } = await provider.provision({ agentId: id, slug, workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } }, env: {} } as any);
    await provider.start(runtimeRef);
    store.insertAgent({ id, ownerId: OWNER, name: slug, slug, state: opts.state ?? 'RUNNING', aiProfileId, hostId: 'h1', runtimeRef, model: opts.model, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
    store.setAgentApplied(id, aiProfileId, applied);
    if (opts.version) provider.infoOverride.set(runtimeRef, { openclawVersion: opts.version });
    return runtimeRef;
  }
  const f = Fastify();
  await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  return { store, provider, f, seed };
}

/** The batched `config set` the build writes, as the ops it carries. */
const opsOf = (argv: string[]): Array<{ path: string; value: unknown }> =>
  argv.includes('--batch-json') ? JSON.parse(argv[argv.indexOf('--batch-json') + 1]!) : [{ path: argv[2]!, value: JSON.parse(argv[3]!) }];
const configSets = (log: string[][]) => log.filter((c) => c[0] === 'config' && c[1] === 'set');

describe('a model change writes the allowlist first (HB-0666)', () => {
  it('on 2026.9.8: the source list, models and allowlist, then `models set`', async () => {
    const { f, provider, seed } = await world();
    await seed('a1', 'one', 'p1', 'claude-opus-4-8', { version: '2026.9.8' });
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/model', headers: as, payload: { model: 'claude-sonnet-5' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ live: true });
    const setAt = provider.execLog.findIndex((c) => c[0] === 'models' && c[1] === 'set');
    const listAt = provider.execLog.findIndex((c) => c[0] === 'config' && c[1] === 'set');
    expect(listAt).toBeGreaterThanOrEqual(0);
    expect(listAt).toBeLessThan(setAt);
    const ops = opsOf(provider.execLog[listAt]!);
    // The agent's model first, then the source's list: what the build writes.
    expect(ops.find((o) => o.path === ALLOW)?.value).toEqual(['anthropic/claude-sonnet-5', 'anthropic/claude-opus-4-8']);
    expect(Object.keys(ops.find((o) => o.path === 'agents.defaults.models')!.value as object)).toEqual(['anthropic/claude-sonnet-5', 'anthropic/claude-opus-4-8']);
    expect(provider.execLog[setAt]).toEqual(['models', 'set', 'anthropic/claude-sonnet-5']);
  });

  it('on an older runtime: `models set` alone, as before (2026.7 refuses the key)', async () => {
    const { f, provider, seed } = await world();
    await seed('a1', 'one', 'p1', 'claude-opus-4-8', { version: '2026.7.1' });
    await f.inject({ method: 'POST', url: '/v1/agents/a1/model', headers: as, payload: { model: 'claude-sonnet-5' } });
    expect(configSets(provider.execLog)).toEqual([]);
    expect(provider.execLog.filter((c) => c[0] === 'models' && c[1] === 'set')).toHaveLength(1);
  });

  it('a list the runtime refuses fails the change, and `models set` is not run', async () => {
    const { f, provider, seed } = await world();
    await seed('a1', 'one', 'p1', 'claude-opus-4-8', { version: '2026.9.8' });
    provider.execResponses.set('config set', { code: 1, stdout: '', stderr: 'Config validation failed' });
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/model', headers: as, payload: { model: 'claude-sonnet-5' } });
    expect(res.json()).toMatchObject({ failed: true });
    expect(provider.execLog.some((c) => c[0] === 'models' && c[1] === 'set')).toBe(false);
  });

  it("a stopped agent's volume gets the list, then the model, in one script", async () => {
    const { f, provider, seed } = await world();
    await seed('a1', 'one', 'p1', 'claude-opus-4-8', { version: '2026.9.8', state: 'STOPPED' });
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/model', headers: as, payload: { model: 'claude-sonnet-5' } });
    expect(res.json()).toMatchObject({ staged: true });
    const script = String(provider.execLog.find((c) => c[0] === 'sh-volume')?.[1]);
    expect(script).toContain(ALLOW);
    expect(script.indexOf(ALLOW)).toBeLessThan(script.indexOf("models set 'anthropic/claude-sonnet-5'"));
    expect(script).toMatch(/>\/dev\/null && openclaw models set/);
  });
});

describe("a source's list reaches its agents now (HB-0668)", () => {
  it('each agent on the source that runs its model gets the new list; one owed a rebuild and other sources do not', async () => {
    const { f, provider, store, seed } = await world();
    const newer = await seed('a1', 'one', 'p1', 'claude-opus-4-8', { version: '2026.9.8' });
    const older = await seed('a2', 'two', 'p1', 'claude-opus-4-8', { version: '2026.7.1' });
    const owed = await seed('a3', 'three', 'p1', 'claude-haiku-4-5', { version: '2026.9.8' }); // its model waits for a rebuild
    const other = await seed('a4', 'four', 'p2', 'claude-haiku-4-5', { version: '2026.9.8' });
    const byRef = new Map<string, string[][]>();
    const realExec = provider.exec.bind(provider);
    provider.exec = async (ref, argv, opts) => { byRef.set(ref, [...(byRef.get(ref) ?? []), argv]); return realExec(ref, argv, opts); };

    const res = await f.inject({ method: 'PATCH', url: '/v1/ai-profiles/p1', headers: as, payload: { model: 'claude-opus-4-8', models: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-fable-5-2'] } });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(byRef.get(older)?.length).toBe(1), { timeout: 10_000 });

    const want = ['anthropic/claude-opus-4-8', 'anthropic/claude-sonnet-5', 'anthropic/claude-fable-5-2'];
    const one = byRef.get(newer)!.map(opsOf).flat();
    expect(Object.keys(one.find((o) => o.path === 'agents.defaults.models')!.value as object)).toEqual(want);
    expect(one.find((o) => o.path === ALLOW)?.value).toEqual(want);
    // The older runtime gets the models map only: it refuses the allowlist key.
    const two = byRef.get(older)!.map(opsOf).flat();
    expect(two.map((o) => o.path)).toEqual(['agents.defaults.models']);
    expect(byRef.get(owed)).toBeUndefined();
    expect(byRef.get(other)).toBeUndefined();
    // No model was set: only the list.
    expect(provider.execLog.some((c) => c[0] === 'models' && c[1] === 'set')).toBe(false);
    expect(store.listEvents(['a1']).find((e) => e.event === 'model.list_set')?.detail).toMatchObject({ models: 3, allowlist: true });
  });

  it('a new default applied to some agents: a held one keeps its model and gets the new list', async () => {
    const { f, provider, store, seed } = await world();
    await seed('a1', 'one', 'p1', 'claude-opus-4-8', { version: '2026.9.8' });
    const held = await seed('a2', 'two', 'p1', 'claude-opus-4-8', { version: '2026.9.8' });
    const seen: string[][] = [];
    const realExec = provider.exec.bind(provider);
    provider.exec = async (ref, argv, opts) => { if (ref === held) seen.push(argv); return realExec(ref, argv, opts); };
    const res = await f.inject({ method: 'POST', url: '/v1/ai-profiles/p1/apply-default-model', headers: as, payload: { model: 'claude-fable-5-2', apply: ['a1'] } });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(seen.length).toBe(1), { timeout: 10_000 });
    expect(store.getAgent('a2')!.model).toBe('claude-opus-4-8'); // held
    const ops = opsOf(seen[0]!);
    expect(ops.find((o) => o.path === ALLOW)?.value).toEqual(expect.arrayContaining(['anthropic/claude-opus-4-8', 'anthropic/claude-fable-5-2']));
    expect((ops.find((o) => o.path === ALLOW)?.value as string[])[0]).toBe('anthropic/claude-opus-4-8'); // its own model first
    expect(seen.some((c) => c[0] === 'models')).toBe(false);
  });

  it('a change that leaves the list alone pushes nothing', async () => {
    const { f, provider, seed } = await world();
    await seed('a1', 'one', 'p1', 'claude-opus-4-8', { version: '2026.9.8' });
    await f.inject({ method: 'PATCH', url: '/v1/ai-profiles/p1', headers: as, payload: { mgmtLlm: false } });
    await new Promise((r) => setTimeout(r, 20));
    expect(configSets(provider.execLog)).toEqual([]);
  });
});

describe("the source's menu offers one id per model (HB-0669)", () => {
  it('folds a dated id into its undated model, keeping order; a dated id alone stays', () => {
    expect(foldDatedIds(['claude-haiku-4-5-20251001', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-sonnet-4-5-20250929', 'claude-opus-4-8']))
      .toEqual(['claude-opus-4-8', 'claude-haiku-4-5', 'claude-sonnet-4-5-20250929']);
  });

  it('available-models answers the folded list; a dated id the source lists is not called stale', async () => {
    const { f, provider, store, seed } = await world();
    await seed('a1', 'one', 'p1', 'claude-opus-4-8', { version: '2026.9.8' });
    store.setAIProfileModels('p1', ['claude-opus-4-8', 'claude-haiku-4-5-20251001']);
    provider.execResponses.set('models list', {
      code: 0, stderr: '',
      stdout: JSON.stringify({ models: ['claude-opus-4-8', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929'].map((id) => ({ key: `anthropic/${id}`, name: `Claude ${id}` })) }),
    });
    const body = (await f.inject({ method: 'GET', url: '/v1/ai-profiles/p1/available-models', headers: as })).json();
    expect(body.source).toBe('runtime');
    expect(body.models).toEqual(['claude-opus-4-8', 'claude-haiku-4-5', 'claude-sonnet-4-5-20250929']);
    expect(body.stale).toEqual([]);
  });
});
