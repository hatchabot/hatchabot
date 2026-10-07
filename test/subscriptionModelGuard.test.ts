import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { openclawAtLeast, subscriptionModelProblem } from '../src/orchestrator/modelOptions.js';

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
