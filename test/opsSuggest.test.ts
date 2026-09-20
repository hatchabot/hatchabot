import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * "What should I add?" is the hardest question a new owner has, and the
 * management agent is the only thing here that can answer it from evidence.
 * The app hands it the question; everything after that is an ordinary card.
 */
class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}
const OWNER = 'user-owner';
const H = { 'x-hatchabot-owner': OWNER };

async function world(withOps = true, state: string = 'RUNNING') {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
  if (withOps) {
    const { runtimeRef } = await provider.provision({ agentId: 'ops1', slug: 'hatchabot', workspace: { files: {}, configPatch: { agentId: 'ops1', authMode: 'api-key' } }, env: {} } as never);
    await provider.start(runtimeRef);
    store.insertAgent({ id: 'ops1', ownerId: OWNER, name: 'Hatchabot', slug: 'hatchabot', state, runtimeRef,
      aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    store.setAgentOps('ops1', true);
  }
  const f = Fastify();
  await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never });
  return { store, provider, f };
}

describe('asking the manager what to add', () => {
  it('hands it the question, in its own conversation', async () => {
    const { provider, f } = await world();
    const res = await f.inject({ method: 'POST', url: '/v1/ops-agent/suggest', headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ asked: true, slug: 'hatchabot' });

    const turn = provider.execLog.find((a) => a[0] === 'agent');
    expect(turn).toBeTruthy();
    const text = turn!.join(' ');
    // It must ASK before it proposes, and file cards rather than create.
    expect(text).toMatch(/list_agents/);
    expect(text).toMatch(/two or three short questions/i);
    expect(text).toMatch(/create_agent cards/);
    expect(text).toMatch(/Nothing exists until they press Confirm/i);
  });

  it('says what to do instead when there is no manager, or it is stopped', async () => {
    const none = await world(false);
    const a = await none.f.inject({ method: 'POST', url: '/v1/ops-agent/suggest', headers: H });
    expect(a.statusCode).toBe(409);
    expect(a.json().error).toMatch(/Set up your Hatchabot agent/);

    const stopped = await world(true, 'STOPPED');
    const b = await stopped.f.inject({ method: 'POST', url: '/v1/ops-agent/suggest', headers: H });
    expect(b.statusCode).toBe(409);
    expect(b.json().error).toMatch(/stopped/);
    expect(stopped.provider.execLog.some((x) => x[0] === 'agent')).toBe(false);
  });

  it("is scoped to the caller: someone else's manager is not asked", async () => {
    const { provider, f } = await world();
    const res = await f.inject({ method: 'POST', url: '/v1/ops-agent/suggest', headers: { 'x-hatchabot-owner': 'user-someone-else' } });
    expect(res.statusCode).toBe(409);
    expect(provider.execLog.some((x) => x[0] === 'agent')).toBe(false);
  });
});
