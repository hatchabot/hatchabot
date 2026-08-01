import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { redeemInvite, createInvite, InviteInvalidError } from '../src/orchestrator/invite.js';
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
const MEMBER = 'user-member';
const STRANGER = 'user-stranger';

function world() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({
    id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box',
    settings: {}, createdAt: 'now',
  });
  store.insertAgent({
    id: 'a1', ownerId: OWNER, name: 'Family', slug: 'family', state: 'RUNNING',
    aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: true,
    createdAt: 'now', updatedAt: 'now',
  });
  store.insertMembership({ id: 'm1', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active' });
  store.insertMembership({ id: 'm2', agentId: 'a1', userId: MEMBER, role: 'user', status: 'active' });
  return store;
}

async function app(store: Store) {
  const f = Fastify();
  await registerRoutes(f, {
    store,
    secrets: new MemSecrets(),
    providers: new Map([['mock', new MockProvider()]]),
    channel: { pool: { availableCount: () => 0 } } as any,
  });
  return f;
}

const as = (u: string) => ({ 'x-agentclaw-owner': u });

describe('accessRole', () => {
  it('grades owner, member, and stranger', () => {
    const store = world();
    expect(store.accessRole('a1', OWNER)).toBe('owner');
    expect(store.accessRole('a1', MEMBER)).toBe('user');
    expect(store.accessRole('a1', STRANGER)).toBeUndefined();
  });

  it('drops access when a membership is revoked', () => {
    const store = world();
    store.revokeMembership('a1', MEMBER);
    expect(store.accessRole('a1', MEMBER)).toBeUndefined();
  });
});

describe('listVisibleAgents', () => {
  it('shows members the agents they belong to, and no others', () => {
    const store = world();
    store.insertAgent({
      id: 'a2', ownerId: OWNER, name: 'Private', slug: 'private', state: 'RUNNING',
      aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: false,
      createdAt: 'now', updatedAt: 'now',
    });
    expect(store.listVisibleAgents(OWNER).map((a) => a.id).sort()).toEqual(['a1', 'a2']);
    expect(store.listVisibleAgents(MEMBER).map((a) => a.id)).toEqual(['a1']);
    expect(store.listVisibleAgents(STRANGER)).toEqual([]);
  });
});

describe('route enforcement', () => {
  it('lets a member see the agent and its role, but not owner surfaces', async () => {
    const f = await app(world());

    const list = await f.inject({ method: 'GET', url: '/v1/agents', headers: as(MEMBER) });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toMatchObject({ id: 'a1', role: 'user' });

    expect((await f.inject({ method: 'GET', url: '/v1/agents/a1', headers: as(MEMBER) })).statusCode).toBe(200);

    // owner-only surfaces stay closed
    for (const url of ['/v1/agents/a1/bot-token', '/v1/agents/a1/export', '/v1/agents/a1/snapshots', '/v1/agents/a1/gateway']) {
      expect((await f.inject({ method: 'GET', url, headers: as(MEMBER) })).statusCode, url).toBe(404);
    }
    for (const url of ['/v1/agents/a1/stop', '/v1/agents/a1/rebuild', '/v1/agents/a1/invites']) {
      const res = await f.inject({ method: 'POST', url, headers: as(MEMBER), payload: {} });
      expect(res.statusCode, url).toBe(404);
    }
    expect((await f.inject({ method: 'DELETE', url: '/v1/agents/a1', headers: as(MEMBER) })).statusCode).toBe(404);
  });

  it('shows a stranger nothing at all', async () => {
    const f = await app(world());
    expect((await f.inject({ method: 'GET', url: '/v1/agents', headers: as(STRANGER) })).json()).toEqual([]);
    expect((await f.inject({ method: 'GET', url: '/v1/agents/a1', headers: as(STRANGER) })).statusCode).toBe(404);
  });

  it('leaves the owner fully in control', async () => {
    const f = await app(world());
    const list = await f.inject({ method: 'GET', url: '/v1/agents', headers: as(OWNER) });
    expect(list.json()[0]).toMatchObject({ role: 'owner' });
    expect((await f.inject({ method: 'GET', url: '/v1/agents/a1/snapshots', headers: as(OWNER) })).statusCode).toBe(200);
  });
});

describe('cross-owner isolation (audit regressions)', () => {
  function twoOwners() {
    const store = world();
    store.insertAIProfile({
      id: 'p-owner', ownerId: OWNER, name: 'Owner AI', vendor: 'anthropic',
      kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p', createdAt: 'now',
    });
    return store;
  }

  it("refuses to create an agent on another owner's host or AI profile", async () => {
    const f = await app(twoOwners());
    const res = await f.inject({
      method: 'POST', url: '/v1/agents', headers: as(MEMBER),
      payload: { name: 'Sneaky', aiProfileId: 'p-owner', hostId: 'h1' },
    });
    expect(res.statusCode).toBe(400); // not 202 — no container on the owner's box
  });

  it("refuses to edit or delete another owner's AI profile", async () => {
    const f = await app(twoOwners());
    const patch = await f.inject({
      method: 'PATCH', url: '/v1/ai-profiles/p-owner', headers: as(STRANGER),
      payload: { model: 'hijacked' },
    });
    expect(patch.statusCode).toBe(404);
    const del = await f.inject({
      method: 'DELETE', url: '/v1/ai-profiles/p-owner', headers: as(STRANGER),
    });
    expect(del.statusCode).toBe(404);
  });

  it('never returns the gateway token from mutation responses', async () => {
    const store = twoOwners();
    store.ensureGatewayAccess('a1');
    const f = await app(store);
    const res = await f.inject({
      method: 'PATCH', url: '/v1/agents/a1', headers: as(OWNER), payload: { name: 'Renamed' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().gatewayToken).toBeUndefined();
    expect(res.json().hasGateway).toBe(true);
  });
});

describe('full invite binding', () => {
  it('keys the membership to the account when one is supplied', () => {
    const store = world();
    const { code } = createInvite(store, 'a1', OWNER);
    const joined = redeemInvite(store, code, 'Gran', 'user-gran');
    expect(joined.membershipUserId).toBe('user-gran');
    expect(store.accessRole('a1', 'user-gran')).toBe('user');
    expect(store.listVisibleAgents('user-gran').map((a) => a.id)).toEqual(['a1']);
  });

  it('falls back to an opaque member id for a Telegram-only join', () => {
    const store = world();
    const { code } = createInvite(store, 'a1', OWNER);
    const joined = redeemInvite(store, code, 'Gran');
    expect(joined.membershipUserId).toMatch(/^member-/);
    // no account → cannot log in and see it
    expect(store.listVisibleAgents('user-gran')).toEqual([]);
  });

  it('refuses to re-add an account that is already a member', () => {
    const store = world();
    const { code } = createInvite(store, 'a1', OWNER);
    expect(() => redeemInvite(store, code, 'Dup', MEMBER)).toThrow(InviteInvalidError);
  });
});
