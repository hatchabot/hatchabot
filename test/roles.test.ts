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

  it("refuses to create an agent with another owner's AI profile", async () => {
    const f = await app(twoOwners());
    const res = await f.inject({
      method: 'POST', url: '/v1/agents', headers: as(MEMBER),
      payload: { name: 'Sneaky', aiProfileId: 'p-owner', hostId: 'h1' },
    });
    expect(res.statusCode).toBe(400); // not 202 — no billing someone else's key
  });

  it('lets a second account create its OWN agent on the shared local host', async () => {
    // The local host is the machine itself — an installation resource. What
    // stays per-account is the AI credential, so a second signed-in account
    // with its own profile must not be stuck at "Setup incomplete".
    const store = twoOwners();
    store.insertAIProfile({
      id: 'p-member', ownerId: MEMBER, name: 'Their AI', vendor: 'anthropic',
      kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/m', createdAt: 'now',
    });
    expect(store.listHosts(MEMBER).map((h) => h.id)).toContain('h1');
    const f = await app(store);
    const res = await f.inject({
      method: 'POST', url: '/v1/agents', headers: as(MEMBER),
      payload: { name: 'Their Agent', aiProfileId: 'p-member', hostId: 'h1' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().ownerId).toBe(MEMBER);
  });

  it('shares an AI source with the whole installation when its owner opts in', async () => {
    // The deliberate Max-sharing path: the owner flips Shared on THEIR
    // profile; other accounts can then run their own agents on it. Spend is
    // shared knowingly, and flipping it back stops new use.
    const store = twoOwners();
    const f = await app(store);

    const share = await f.inject({
      method: 'PATCH', url: '/v1/ai-profiles/p-owner', headers: as(OWNER),
      payload: { shared: true },
    });
    expect(share.statusCode).toBe(200);

    const listed = (await f.inject({
      method: 'GET', url: '/v1/ai-profiles', headers: as(MEMBER),
    })).json();
    expect(listed.map((p: any) => p.id)).toContain('p-owner');
    expect(listed.find((p: any) => p.id === 'p-owner').mine).toBe(false);

    const create = await f.inject({
      method: 'POST', url: '/v1/agents', headers: as(MEMBER),
      payload: { name: 'On Shared AI', aiProfileId: 'p-owner', hostId: 'h1' },
    });
    expect(create.statusCode).toBe(202);
    expect(create.json().ownerId).toBe(MEMBER);

    // Unshare: no NEW use, and only the owner can flip the switch at all.
    await f.inject({
      method: 'PATCH', url: '/v1/ai-profiles/p-owner', headers: as(OWNER),
      payload: { shared: false },
    });
    const blocked = await f.inject({
      method: 'POST', url: '/v1/agents', headers: as(MEMBER),
      payload: { name: 'Too Late', aiProfileId: 'p-owner', hostId: 'h1' },
    });
    expect(blocked.statusCode).toBe(400);
    const foreignFlip = await f.inject({
      method: 'PATCH', url: '/v1/ai-profiles/p-owner', headers: as(MEMBER),
      payload: { shared: true },
    });
    expect(foreignFlip.statusCode).toBe(404);
  });

  it('lets only the machine owner mount host folders (sharedPaths / inspect)', async () => {
    // The local host is owned by OWNER. A second account must not be able to
    // point their own agent at an arbitrary host directory and read it at
    // uid 1000 — the blocklist is owner-blind, so this is gated on host
    // ownership instead.
    const store = twoOwners();
    store.insertAgent({
      id: 'a-member', ownerId: MEMBER, name: 'Theirs', slug: 'theirs', state: 'RUNNING',
      aiProfileId: 'p-owner', hostId: 'h1', persona: '', sharedMemory: false,
      createdAt: 'now', updatedAt: 'now',
    });
    const f = await app(store);

    const inspect = await f.inject({
      method: 'POST', url: '/v1/workspaces/inspect', headers: as(MEMBER),
      payload: { path: '/home/someone/private' },
    });
    expect(inspect.statusCode).toBe(403);

    const mount = await f.inject({
      method: 'PATCH', url: '/v1/agents/a-member', headers: as(MEMBER),
      payload: { sharedPaths: ['/home/someone/private'] },
    });
    expect(mount.statusCode).toBe(403);

    // The machine owner is allowed through the gate (fails later on the path
    // itself — a nonexistent folder — not on 403).
    const ownerInspect = await f.inject({
      method: 'POST', url: '/v1/workspaces/inspect', headers: as(OWNER),
      payload: { path: '/home/someone/definitely-not-real' },
    });
    expect(ownerInspect.statusCode).toBe(400);
  });

  it('lists a curated model set for an anthropic profile, owner-scoped', async () => {
    const store = twoOwners(); // p-owner is anthropic, owned by OWNER
    const f = await app(store);
    const res = await f.inject({
      method: 'GET', url: '/v1/ai-profiles/p-owner/available-models', headers: as(OWNER),
    });
    expect(res.statusCode).toBe(200);
    const models = res.json().models as string[];
    expect(models).toContain('claude-opus-5');
    expect(models.length).toBeGreaterThan(2);

    // A stranger (no ownership, not shared) can't enumerate it.
    expect((await f.inject({
      method: 'GET', url: '/v1/ai-profiles/p-owner/available-models', headers: as(STRANGER),
    })).statusCode).toBe(404);
  });

  it("refuses to ride the machine owner's on-disk Claude login", async () => {
    // A subscription profile with no token mounts the HOST's ~/.claude — the
    // machine owner's Max login. A second account creating one would silently
    // bill its agents to somebody else's subscription.
    const f = await app(twoOwners());
    const res = await f.inject({
      method: 'POST', url: '/v1/ai-profiles', headers: as(MEMBER),
      payload: { kind: 'subscription', name: 'Freeload', vendor: 'anthropic', model: 'claude-opus-4-8' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/your own Claude account/);
  });

  it('accepts a second account bringing its own setup-token', async () => {
    // The deliberate-sharing path: a token pasted in is that account's own
    // credential (or one knowingly handed over) — no silent freeloading.
    const f = await app(twoOwners());
    const res = await f.inject({
      method: 'POST', url: '/v1/ai-profiles', headers: as(MEMBER),
      payload: {
        kind: 'subscription', name: 'Mine', vendor: 'anthropic',
        model: 'claude-opus-4-8', oauthToken: 'sk-ant-oat-their-own',
      },
    });
    expect(res.statusCode).toBe(201);
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

  it("refuses to point an agent at another owner's AI profile", async () => {
    const store = twoOwners();
    store.insertAIProfile({
      id: 'p-stranger', ownerId: STRANGER, name: 'Theirs', vendor: 'anthropic',
      kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/x', createdAt: 'now',
    });
    const f = await app(store);
    const res = await f.inject({
      method: 'PATCH', url: '/v1/agents/a1', headers: as(OWNER),
      payload: { aiProfileId: 'p-stranger' },
    });
    expect(res.statusCode).toBe(400);
    expect(store.getAgent('a1')!.aiProfileId).toBe('p'); // unchanged
  });

  it('switches to a profile the caller owns', async () => {
    const store = twoOwners();
    const f = await app(store);
    const res = await f.inject({
      method: 'PATCH', url: '/v1/agents/a1', headers: as(OWNER),
      payload: { aiProfileId: 'p-owner' },
    });
    expect(res.statusCode).toBe(200);
    expect(store.getAgent('a1')!.aiProfileId).toBe('p-owner');
  });

  it('scopes CLI tokens per owner across list and revoke', async () => {
    const store = twoOwners();
    const mine = store.createCliToken(OWNER, 'mine');
    store.createCliToken(STRANGER, 'theirs');
    const f = await app(store);

    const list = await f.inject({ method: 'GET', url: '/v1/cli-tokens', headers: as(OWNER) });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].label).toBe('mine');
    // and the raw token never comes back from a listing
    expect(JSON.stringify(list.json())).not.toContain(mine.token);

    const theirs = store.listCliTokens(STRANGER)[0]!;
    const del = await f.inject({
      method: 'DELETE', url: `/v1/cli-tokens/${theirs.id}`, headers: as(OWNER),
    });
    expect(del.statusCode).toBe(404);
    expect(store.listCliTokens(STRANGER)).toHaveLength(1);
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
