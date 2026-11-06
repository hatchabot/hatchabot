import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { openclawAtLeast, subscriptionModelProblem } from '../src/orchestrator/modelOptions.js';
import { machineTz } from '../src/orchestrator/budgets.js';

/**
 * On a Claude subscription, OpenClaw up to 2026.9.6 presents itself to
 * Anthropic as Claude Code 2.1.278, and Opus 5.5 refuses that: every message
 * failed with "request format rejected (HTTP 400)" (2026-10-07). Choosing it
 * in Hatchabot is refused with the reason instead. Made-up data only.
 */
describe('openclawAtLeast', () => {
  it('compares versions as numbers and ignores a suffix', () => {
    expect(openclawAtLeast('2026.9.6', '2026.9.7')).toBe(false);
    expect(openclawAtLeast('2026.9.7', '2026.9.7')).toBe(true);
    expect(openclawAtLeast('2026.9.10', '2026.9.7')).toBe(true);
    expect(openclawAtLeast('2026.10.1-beta.1', '2026.9.7')).toBe(true);
    expect(openclawAtLeast('2026.7.1-2', '2026.9.7')).toBe(false);
    expect(openclawAtLeast('mock', '2026.9.7')).toBe(true); // unknown: never refuse on a guess
  });

  it('names the problem only for a listed model on an old OpenClaw', () => {
    expect(subscriptionModelProblem('claude-opus-5-5', '2026.9.6')).toMatch(/needs OpenClaw 2026\.9\.7 or newer.*runs 2026\.9\.6/);
    expect(subscriptionModelProblem('claude-opus-5-5', '2026.9.8')).toBeUndefined();
    expect(subscriptionModelProblem('claude-sonnet-5-5', '2026.9.6')).toBeUndefined();
    expect(subscriptionModelProblem('claude-opus-5-5', undefined)).toBeUndefined();
  });
});

describe('POST /v1/agents/:id/model', () => {
  const OWNER = 'owner-1';
  const as = { 'x-hatchabot-owner': OWNER };
  async function app(version: string) {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    const models = ['claude-sonnet-5', 'claude-opus-5-5'];
    store.insertAIProfile({ id: 'plan', ownerId: OWNER, name: 'Plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-sonnet-5', models, secretRef: 'ai/plan', createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'Key', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', models, secretRef: 'ai/key', createdAt: 'now' } as never);
    for (const [id, profile] of [['onplan', 'plan'], ['onkey', 'key']] as const) {
      const { runtimeRef: ref } = await provider.provision({ agentId: id, slug: id, workspace: { files: {}, configPatch: { agentId: id, authMode: 'api-key' } }, env: {} } as never);
      store.insertAgent({ id, ownerId: OWNER, name: id, slug: id, state: 'STOPPED', runtimeRef: ref, aiProfileId: profile, hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
      provider.infoOverride.set(ref, { openclawVersion: version } as never);
    }
    const f = Fastify();
    await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } } } as never);
    return { f, store };
  }
  const set = (f: Awaited<ReturnType<typeof app>>['f'], id: string, model: string) =>
    f.inject({ method: 'POST', url: `/v1/agents/${id}/model`, headers: as, payload: { model } });

  it('refuses Opus 5.5 for a subscription agent on 2026.9.6, saying why, and changes nothing', async () => {
    const { f, store } = await app('2026.9.6');
    const r = await set(f, 'onplan', 'claude-opus-5-5');
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/needs OpenClaw 2026\.9\.7 or newer/);
    expect(store.getAgent('onplan')!.model ?? null).toBeNull();
    expect((await set(f, 'onplan', 'claude-sonnet-5')).statusCode).toBe(200);
  });

  it('allows it on 2026.9.8, and on an API key whatever the version', async () => {
    expect((await set((await app('2026.9.8')).f, 'onplan', 'claude-opus-5-5')).statusCode).toBe(200);
    expect((await set((await app('2026.9.6')).f, 'onkey', 'claude-opus-5-5')).statusCode).toBe(200);
  });
});

describe('the budget and a source switch go through the same check (HB-0425)', () => {
  const OWNER = 'owner-1';
  const as = { 'x-hatchabot-owner': OWNER };
  const OPUS55 = 'claude-opus-5-5', FABLE = 'claude-fable-5-1', OPUS5 = 'claude-opus-5';
  async function app(version: string, opts: { planModels?: string[]; planDefault?: string; agent?: Record<string, unknown>; agentSource?: string } = {}) {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    provider.imageOpenclawVersion = version;
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    const planModels = opts.planModels ?? [FABLE, OPUS55];
    store.insertAIProfile({ id: 'plan', ownerId: OWNER, name: 'Plan', vendor: 'anthropic', kind: 'subscription', model: opts.planDefault ?? planModels[0], models: planModels, secretRef: 'ai/plan', createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'Key', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', models: ['claude-sonnet-5', OPUS55], secretRef: 'ai/key', createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'key2', ownerId: OWNER, name: 'Key 2', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', models: ['claude-sonnet-5', OPUS55], secretRef: 'ai/key2', createdAt: 'now' } as never);
    const { runtimeRef: ref } = await provider.provision({ agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} } as never);
    await provider.start(ref);
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Garden Notes', slug: 'a1', state: 'RUNNING', runtimeRef: ref, aiProfileId: opts.agentSource ?? 'plan', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: '2026-08-01T00:00:00Z', updatedAt: 'now', ...opts.agent } as never);
    provider.infoOverride.set(ref, { openclawVersion: version } as never);
    const f = Fastify();
    await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } } } as never);
    return { f, store, provider };
  }
  const overBudget = async (w: Awaited<ReturnType<typeof app>>) => {
    const now = Date.now();
    w.store.setCostDays('a1', new Map([[new Date(now).toLocaleString('sv-SE', { timeZone: machineTz() }).slice(0, 10), 30]]));
    return w.f.inject({ method: 'PUT', url: '/v1/agents/a1/budget', headers: as, payload: { usd: 10, atLimit: 'cheaper' } });
  };
  const moved = (w: Awaited<ReturnType<typeof app>>) => w.provider.execLog.filter((a) => a[0] === 'models' && a[1] === 'set').map((a) => a[2]);

  it('the cheaper-model budget does not move an old OpenClaw onto a model Anthropic would refuse', async () => {
    const w = await app('2026.9.6');
    const r = await overBudget(w);
    expect(r.statusCode).toBe(200);
    expect(w.store.getAgent('a1')!.model ?? null).toBeNull();
    expect(moved(w)).toEqual([]);
    expect(w.store.getBudgetPause('a1', r.json().budget.month)).toBeUndefined();
  });

  it('it takes the next cheapest it can use', async () => {
    const w = await app('2026.9.6', { planModels: [FABLE, OPUS55, OPUS5] });
    const r = await overBudget(w);
    expect(w.store.getAgent('a1')!.model).toBe(OPUS5);
    expect(r.json().budget.downgraded.to).toBe(OPUS5);
  });

  it('on a new enough OpenClaw the cheapest is still the cheapest', async () => {
    const w = await app('2026.9.8', { planModels: [FABLE, OPUS55, OPUS5] });
    await overBudget(w);
    expect(w.store.getAgent('a1')!.model).toBe(OPUS55);
  });

  it('PATCH onto a subscription drops a pin the image cannot run there; the default stands in', async () => {
    const w = await app('2026.9.6', { agentSource: 'key', agent: { model: OPUS55 } });
    const r = await w.f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: as, payload: { aiProfileId: 'plan' } });
    expect(r.statusCode).toBe(200);
    expect(w.store.getAgent('a1')).toMatchObject({ aiProfileId: 'plan' });
    expect(w.store.getAgent('a1')!.model ?? null).toBeNull();
  });

  it('PATCH keeps the pin on a new enough image, and on an API-key source', async () => {
    let w = await app('2026.9.8', { agentSource: 'key', agent: { model: OPUS55 } });
    await w.f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: as, payload: { aiProfileId: 'plan' } });
    expect(w.store.getAgent('a1')!.model).toBe(OPUS55);
    w = await app('2026.9.6', { agentSource: 'key', agent: { model: OPUS55 } });
    await w.f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: as, payload: { aiProfileId: 'key2' } });
    expect(w.store.getAgent('a1')).toMatchObject({ aiProfileId: 'key2', model: OPUS55 });
  });

  it('PATCH refuses, changing nothing, when the model asked for or the new source\'s default cannot run', async () => {
    let w = await app('2026.9.6', { agentSource: 'key' });
    let r = await w.f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: as, payload: { aiProfileId: 'plan', model: OPUS55 } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/needs OpenClaw 2026\.9\.7/);
    expect(w.store.getAgent('a1')!.aiProfileId).toBe('key');
    w = await app('2026.9.6', { agentSource: 'key', planDefault: OPUS55 });
    r = await w.f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: as, payload: { aiProfileId: 'plan' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/needs OpenClaw 2026\.9\.7/);
    expect(w.store.getAgent('a1')!.aiProfileId).toBe('key');
    // The model alone, on the source it is on, as POST …/model refuses it.
    w = await app('2026.9.6');
    r = await w.f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: as, payload: { model: OPUS55 } });
    expect(r.statusCode).toBe(400);
    expect(w.store.getAgent('a1')!.model ?? null).toBeNull();
  });

  it('the bulk switch drops such a pin, and skips an agent the new source\'s default would break, saying why', async () => {
    let w = await app('2026.9.6', { agentSource: 'key', agent: { model: OPUS55 } });
    let r = await w.f.inject({ method: 'POST', url: '/v1/ai-profiles/key/migrate-agents', headers: as, payload: { toProfileId: 'plan' } });
    expect(r.json()).toMatchObject({ switched: 1, skipped: [] });
    expect(w.store.getAgent('a1')!.aiProfileId).toBe('plan');
    expect(w.store.getAgent('a1')!.model ?? null).toBeNull();
    w = await app('2026.9.6', { agentSource: 'key', planDefault: OPUS55 });
    r = await w.f.inject({ method: 'POST', url: '/v1/ai-profiles/key/migrate-agents', headers: as, payload: { toProfileId: 'plan' } });
    expect(r.json().switched).toBe(0);
    expect(r.json().skipped[0].reason).toMatch(/needs OpenClaw 2026\.9\.7/);
    expect(w.store.getAgent('a1')!.aiProfileId).toBe('key');
    w = await app('2026.9.8', { agentSource: 'key', agent: { model: OPUS55 } });
    await w.f.inject({ method: 'POST', url: '/v1/ai-profiles/key/migrate-agents', headers: as, payload: { toProfileId: 'plan' } });
    expect(w.store.getAgent('a1')!.model).toBe(OPUS55);
  });
});
