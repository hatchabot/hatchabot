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

describe('adopting carries the people already allowed to talk', () => {
  it('admits seeded Telegram ids without pairing', async () => {
    const { store, f } = await world();
    const res = await f.inject({
      method: 'POST', url: '/v1/agents', headers: as,
      payload: {
        name: 'Tech Advisor', aiProfileId: 'p1', hostId: 'h1',
        seedMembers: ['1000000001'],
      },
    });
    expect(res.statusCode).toBe(202);
    const id = res.json().id;
    // This list becomes allowFrom in the rendered config. Without it the owner
    // has to approve themselves to talk to their own adopted agent.
    expect(store.listAllowedChannelUserIds(id)).toEqual(['1000000001']);
  });

  it('rejects anything that is not a Telegram user id', async () => {
    const { f } = await world();
    const res = await f.inject({
      method: 'POST', url: '/v1/agents', headers: as,
      payload: { name: 'X', aiProfileId: 'p1', hostId: 'h1', seedMembers: ['../../etc'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('does not seed the owner as a member of their own agent', async () => {
    const { store, f } = await world();
    // First agent binds the owner's Telegram id to their owner seat, so
    // pair-once will carry it onto the next agent's owner seat.
    const first = await f.inject({
      method: 'POST', url: '/v1/agents', headers: as,
      payload: { name: 'First', aiProfileId: 'p1', hostId: 'h1' },
    });
    store.bindMembershipChannelUser(first.json().id, OWNER, '1000000001');

    // Adopt-style create: the source allowFrom carries the owner's own id AND
    // a real other member. Only the other member should become a member row.
    const res = await f.inject({
      method: 'POST', url: '/v1/agents', headers: as,
      payload: {
        name: 'Stock Advisor', aiProfileId: 'p1', hostId: 'h1',
        seedMembers: ['1000000001', '222333'],
      },
    });
    expect(res.statusCode).toBe(202);
    const id = res.json().id;
    const members = store.listMemberships(id);
    // Owner appears exactly once, as the owner — never also as a 'user'.
    expect(members.filter((m) => m.channelUserId === '1000000001').map((m) => m.role))
      .toEqual(['owner']);
    // The genuine other member is still seeded.
    expect(members.some((m) => m.role === 'user' && m.channelUserId === '222333')).toBe(true);
    // Access is intact: both ids reach the allowlist (deduped).
    expect(store.listAllowedChannelUserIds(id).sort()).toEqual(['1000000001', '222333']);
  });

  it('dedupes repeated ids within seedMembers', async () => {
    const { store, f } = await world();
    const res = await f.inject({
      method: 'POST', url: '/v1/agents', headers: as,
      payload: {
        name: 'Dupes', aiProfileId: 'p1', hostId: 'h1',
        seedMembers: ['555', '555'],
      },
    });
    expect(res.statusCode).toBe(202);
    const id = res.json().id;
    expect(store.listMemberships(id).filter((m) => m.channelUserId === '555')).toHaveLength(1);
  });
});
