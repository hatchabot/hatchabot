import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { clearBusy, markBusy } from '../src/orchestrator/busy.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * Route-level guards around agents that are mid-operation or moved away.
 * These 409s are the HTTP face of the one-poller-per-bot rule: a migrate or
 * adopt holds the busy flag precisely because from the outside the agent
 * looks like an ordinary stopped one.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) {
    const v = this.map.get(ref);
    if (v === undefined) throw new Error('missing');
    return v;
  }
  async delete(ref: string) { this.map.delete(ref); }
}

const OWNER = 'user-owner';
const as = { 'x-agentclaw-owner': OWNER };

async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({
    id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock',
    name: 'box', settings: {}, createdAt: 'now',
  });
  store.insertAIProfile({
    id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key',
    model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now',
  });
  const { runtimeRef } = await provider.provision({
    agentId: 'a1', slug: 'kitchen',
    workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } },
    env: {},
  });
  await provider.start(runtimeRef);
  store.insertAgent({
    id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'PROVISIONING',
    aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true,
    createdAt: 'now', updatedAt: 'now',
  });
  store.setAgentRuntimeRef('a1', runtimeRef);
  store.setAgentState('a1', 'RUNNING');
  const f = Fastify();
  await registerRoutes(f, {
    store,
    secrets: new MemSecrets(),
    providers: new Map([['mock', provider]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
  });
  return { store, provider, f };
}

afterEach(() => clearBusy('a1'));

describe('busy agents answer 409 on lifecycle routes', () => {
  for (const call of [
    { method: 'POST' as const, url: '/v1/agents/a1/stop' },
    { method: 'POST' as const, url: '/v1/agents/a1/start' },
    { method: 'POST' as const, url: '/v1/agents/a1/rebuild' },
    { method: 'POST' as const, url: '/v1/agents/a1/provision' },
    { method: 'DELETE' as const, url: '/v1/agents/a1' },
    { method: 'GET' as const, url: '/v1/agents/a1/export' },
  ]) {
    it(`${call.method} ${call.url}`, async () => {
      const { f } = await world();
      // What a migrate/adopt/import does for its whole duration. Mid-migrate
      // the source sits STOPPED with no tombstone yet — without this guard a
      // Start here boots the copy whose bot is about to belong elsewhere.
      markBusy('a1');
      const res = await f.inject({ method: call.method, url: call.url, headers: as });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/already running/i);
    });
  }

  it('clears with the flag: the same call succeeds once the operation ends', async () => {
    const { f } = await world();
    markBusy('a1');
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/stop', headers: as })).statusCode).toBe(409);
    clearBusy('a1');
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/stop', headers: as })).statusCode).toBe(200);
  });
});

describe('moved-away agents cannot be resurrected', () => {
  it('refuses to start the stale copy after a migration', async () => {
    const { store, f } = await world();
    store.setAgentState('a1', 'STOPPED');
    store.setAgentMigratedTo('a1', 'Desktop (2026-08-06)');
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/start', headers: as });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/moved to Desktop/);
  });
});

describe('POST /v1/agents/preflight', () => {
  it('carries sharedPaths through to the folder check', async () => {
    const { f } = await world();
    // Zod strips unknown keys: before sharedPaths joined the schema, the
    // sender's folder list was silently discarded and the documented
    // missing-folders refusal could never fire over HTTP.
    const res = await f.inject({
      method: 'POST', url: '/v1/agents/preflight', headers: as,
      payload: {
        slug: 'newcomer',
        accountId: 'newbot',
        sharedPaths: ['/definitely/not/a/real/folder'],
      },
    });
    expect(res.statusCode).toBe(200);
    const answer = res.json();
    expect(answer.ok).toBe(false);
    expect(answer.warnings).toContain('missing-shared-paths');
    expect(answer.reasons.join(' ')).toContain('/definitely/not/a/real/folder');
  });
});
