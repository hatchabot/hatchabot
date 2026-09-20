import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * "My rebuild ate the chat." OpenClaw ends a conversation by renaming its file
 * to *.jsonl.reset.<ts>, so Hatchabot can say so instead of letting the owner
 * find out mid-conversation (2026-09-20).
 */
class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}
const OWNER = 'user-owner';
const H = { 'x-hatchabot-owner': OWNER };

async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
  const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} } as never);
  await provider.start(runtimeRef);
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', runtimeRef,
    aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
  const f = Fastify();
  await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never });
  return { store, f };
}

describe('a chat that lost its context', () => {
  it('rides the agent list so the app can offer Recover, and Dismiss stops the offer', async () => {
    const { store, f } = await world();
    expect((await f.inject({ method: 'GET', url: '/v1/agents', headers: H })).json()[0].contextReset).toBeUndefined();

    store.setContextReset('a1', { resetAt: '2026-09-20T09:00:00.000Z', lostMessages: 148 });
    const listed = (await f.inject({ method: 'GET', url: '/v1/agents', headers: H })).json()[0];
    expect(listed.contextReset).toMatchObject({ resetAt: '2026-09-20T09:00:00.000Z', lostMessages: 148 });

    expect((await f.inject({ method: 'DELETE', url: '/v1/agents/a1/context-reset', headers: H })).statusCode).toBe(200);
    expect((await f.inject({ method: 'GET', url: '/v1/agents', headers: H })).json()[0].contextReset).toBeUndefined();
  });

  it('a NEWER reset is news again after an older one was dismissed', async () => {
    const { store } = await world();
    store.setContextReset('a1', { resetAt: '2026-09-20T09:00:00.000Z', lostMessages: 10 });
    store.clearContextReset('a1');
    expect(store.getContextReset('a1')).toBeUndefined();

    store.setContextReset('a1', { resetAt: '2026-09-20T09:00:00.000Z', lostMessages: 10 }); // same one, seen again
    expect(store.getContextReset('a1')).toBeUndefined();

    store.setContextReset('a1', { resetAt: '2026-09-21T18:00:00.000Z', lostMessages: 42 }); // a new one
    expect(store.getContextReset('a1')).toMatchObject({ lostMessages: 42 });
  });

  it('is not offered for an agent belonging to someone else', async () => {
    const { store, f } = await world();
    store.setContextReset('a1', { resetAt: '2026-09-20T09:00:00.000Z', lostMessages: 5 });
    const other = { 'x-hatchabot-owner': 'user-someone-else' };
    expect((await f.inject({ method: 'DELETE', url: '/v1/agents/a1/context-reset', headers: other })).statusCode).toBe(404);
    expect(store.getContextReset('a1')).toBeTruthy(); // untouched
  });
});
