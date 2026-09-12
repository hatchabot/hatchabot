import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * GET /v1/users: the people roster. The subtle part is attribution — OpenClaw
 * records only the LAST exchange per thread, so the endpoint must surface what
 * it knows without inventing per-user history it doesn't have.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const as = { 'x-hatchabot-owner': OWNER };

async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-5', secretRef: 'ai/p1', createdAt: 'now' });
  const mk = async (id: string, name: string) => {
    store.insertAgent({ id, ownerId: OWNER, name, slug: id, state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
    const { runtimeRef } = await provider.provision({ agentId: id, slug: id, workspace: { files: {}, configPatch: { agentId: id, authMode: 'api-key' } }, env: {} });
    await provider.start(runtimeRef);
    store.setAgentRuntimeRef(id, runtimeRef);
    store.setAgentState(id, 'RUNNING');
  };
  await mk('a1', 'Family Agent');
  await mk('a2', 'Tax Advisor');
  const member = (agentId: string, userId: string, tg: string | null, role = 'user', displayName?: string) =>
    store.insertMembership({
      id: `${agentId}-${userId}`, agentId, userId, role,
      ...(tg ? { channelUserId: tg } : {}), ...(displayName ? { displayName } : {}),
      status: 'active', joinedAt: '2026-08-01T00:00:00Z',
    } as any);
  member('a1', 'owner', '111', 'owner');
  member('a2', 'owner', '111', 'owner');
  member('a1', 'telegram:222', '222', 'user', 'Sophie');
  member('a1', 'invited-user', null); // invited, never messaged

  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
  });
  return { store, provider, f };
}

describe('GET /v1/users', () => {
  it('groups memberships by Telegram user and attributes the last exchange', async () => {
    const { provider, f } = await world();
    // a1's session store: the most recent DM exchange was with Sophie (222).
    provider.execResponses.set('sh', {
      code: 0,
      stdout: JSON.stringify({
        'agent:a1:main': { lastInteractionAt: 1756700000000, lastTo: 'telegram:222', chatType: 'direct' },
        'agent:a1:cron:xyz': { lastInteractionAt: 1756800000000, lastTo: 'telegram:111' }, // machine noise — ignored
      }),
      stderr: '',
    });
    const res = await f.inject({ method: 'GET', url: '/v1/users', headers: as });
    expect(res.statusCode).toBe(200);
    const { users } = res.json();
    expect(users).toHaveLength(3); // owner, Sophie, the unlinked invitee

    const sophie = users.find((u: any) => u.channelUserId === '222');
    expect(sophie.displayName).toBe('Sophie');
    expect(sophie.memberships.map((m: any) => m.agentName)).toEqual(['Family Agent']);
    expect(sophie.lastSeen.agentName).toBe('Family Agent');

    const owner = users.find((u: any) => u.channelUserId === '111');
    expect(owner.memberships).toHaveLength(2); // both agents, one row
    // The cron thread must NOT count as the owner being active.
    expect(owner.lastSeen).toBeUndefined();

    const invited = users.find((u: any) => !u.channelUserId);
    expect(invited.memberships[0].agentName).toBe('Family Agent');
    expect(invited.lastSeen).toBeUndefined();
  });

  it('refuses ?all=1 to a caller who does not own the machine', async () => {
    const { f } = await world();
    const res = await f.inject({ method: 'GET', url: '/v1/users?all=1', headers: { 'x-hatchabot-owner': 'someone-else' } });
    expect(res.statusCode).toBe(403);
  });

  it('still renders the roster when a container read fails', async () => {
    const { provider, f } = await world();
    provider.execResponses.set('sh', { code: 1, stdout: '', stderr: 'exec failed' });
    const res = await f.inject({ method: 'GET', url: '/v1/users', headers: as });
    expect(res.statusCode).toBe(200);
    expect(res.json().users.length).toBe(3); // memberships alone are enough
  });
});
