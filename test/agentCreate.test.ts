import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

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

async function world(channel?: unknown) {
  const store = new Store(new Database(':memory:'));
  store.insertHost({
    id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock',
    name: 'box', settings: {}, createdAt: 'now',
  });
  store.insertAIProfile({
    id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key',
    model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now',
  });
  const f = Fastify();
  await registerRoutes(f, {
    store,
    secrets: new MemSecrets(),
    providers: new Map([['mock', new MockProvider()]]),
    channel: (channel ?? { pool: { availableCount: () => 0 } }) as any,
  });
  return { store, f };
}

describe('POST /v1/agents name collision', () => {
  it('answers 409 with the conflicting agent, not a 500 from the UNIQUE index', async () => {
    const { store, f } = await world();
    // An agent parked mid-setup still holds the slug — this is exactly the
    // state a failed `agentclaw adopt` used to leave behind.
    store.insertAgent({
      id: 'a1', ownerId: OWNER, name: 'Tech Advisor', slug: 'tech-advisor',
      state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '',
      sharedMemory: true, createdAt: 'now', updatedAt: 'now',
    });

    const res = await f.inject({
      method: 'POST', url: '/v1/agents', headers: as,
      payload: { name: 'Tech Advisor', aiProfileId: 'p1', hostId: 'h1' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('Tech Advisor');
    // Names differing only in punctuation/case still collide, because the slug
    // is what has to be unique.
    const res2 = await f.inject({
      method: 'POST', url: '/v1/agents', headers: as,
      payload: { name: 'tech advisor', aiProfileId: 'p1', hostId: 'h1' },
    });
    expect(res2.statusCode).toBe(409);
  });

  it('still allows a name freed by deleting the old agent', async () => {
    const { store, f } = await world();
    store.insertAgent({
      id: 'a1', ownerId: OWNER, name: 'Tech Advisor', slug: 'tech-advisor',
      state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '',
      sharedMemory: true, createdAt: 'now', updatedAt: 'now',
    });
    store.setAgentState('a1', 'DELETING');
    store.setAgentState('a1', 'DELETED');
    const res = await f.inject({
      method: 'POST', url: '/v1/agents', headers: as,
      payload: { name: 'Tech Advisor', aiProfileId: 'p1', hostId: 'h1' },
    });
    expect(res.statusCode).toBe(202);
  });
});

describe('a refused bot token must not stay pending', () => {
  it('forgets the token when it already belongs to another agent', async () => {
    // Stands in for the real provisioner: submitToken() stashes the identity
    // for that agent, exactly as TelegramManualProvisioner does.
    const pending = new Map<string, string>();
    const channel = {
      pool: { availableCount: () => 0 },
      async submitToken(agentId: string) {
        pending.set(agentId, 'williamsbot');
        return { username: 'williamsbot' };
      },
      discardPending: (agentId: string) => void pending.delete(agentId),
    };

    const { store, f } = await world(channel);
    store.insertAgent({
      id: 'william', ownerId: OWNER, name: 'William Video Games Agent', slug: 'william',
      state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '',
      sharedMemory: true, createdAt: 'now', updatedAt: 'now',
    });
    store.insertChannel({
      id: 'c1', agentId: 'william', kind: 'telegram', accountId: 'williamsbot',
      secretRef: 'telegram/bot/williamsbot', deepLink: 'https://t.me/williamsbot',
      createdAt: 'now',
    });
    store.insertAgent({
      id: 'tech', ownerId: OWNER, name: 'Tech Advisor', slug: 'tech-advisor',
      state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '',
      sharedMemory: true, createdAt: 'now', updatedAt: 'now',
    });

    const res = await f.inject({
      method: 'POST', url: '/v1/agents/tech/channel-token', headers: as,
      payload: { token: '123:abc' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('William Video Games Agent');
    // The point: the rejected token is gone, so a later Retry cannot resume
    // provisioning onto William's bot.
    expect(pending.has('tech')).toBe(false);
  });

});
