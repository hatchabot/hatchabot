import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * HTTP tests for the highest-blast-radius routes the 2026-09-03 audit found
 * untested: pairing approve (incl. the "That's me — link" asSelf branch),
 * the file GET/PUT gate, snapshot create/delete/restore, and member removal.
 * These go through the REAL Fastify handlers — the orchestrator-level suites
 * (members.test.ts, snapshots tests) already cover the internals.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const H = { 'x-agentclaw-owner': OWNER };

async function liveWorld() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({
    id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'PROVISIONING',
    aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
  });
  store.insertMembership({ id: 'm-owner', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active' });
  store.insertChannel({
    id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'kitchenbot',
    secretRef: 'chan/a1', deepLink: 'https://t.me/kitchenbot', createdAt: 'now',
  });
  const { runtimeRef } = await provider.provision({
    agentId: 'a1', slug: 'kitchen',
    workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } }, env: {},
  } as any);
  store.setAgentRuntimeRef('a1', runtimeRef);
  store.setAgentState('a1', 'RUNNING');
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
  });
  return { store, f, provider };
}

const PAIRING_FILE = JSON.stringify([
  { id: 777, code: 'ABCD', meta: { firstName: 'Zoe', accountId: 'kitchenbot' } },
]);

describe('POST /v1/agents/:id/pairing/approve', () => {
  it('admits a pending requester as a member and welcomes them', async () => {
    const { store, f, provider } = await liveWorld();
    provider.execResponses.set('sh', { code: 0, stdout: PAIRING_FILE, stderr: '' });
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/pairing/approve', headers: H, payload: { code: 'ABCD' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().member).toMatchObject({ displayName: 'Zoe', channelUserId: '777', alreadyMember: false });
    const member = store.listMemberships('a1').find((m) => m.channelUserId === '777')!;
    expect(member.role).toBe('user');
    // the real approve verb reached the runtime
    expect(provider.execLog.some((c) => c.join(' ').startsWith('pairing approve telegram ABCD'))).toBe(true);
  });

  it('asSelf binds the OWNER seat and links the account — no duplicate member row', async () => {
    const { store, f, provider } = await liveWorld();
    provider.execResponses.set('sh', { code: 0, stdout: PAIRING_FILE, stderr: '' });
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/pairing/approve', headers: H, payload: { code: 'ABCD', asSelf: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json().member).toMatchObject({ userId: OWNER, alreadyMember: true });
    const rows = store.listMemberships('a1');
    expect(rows).toHaveLength(1); // owner seat only, now bound
    expect(rows[0]!.channelUserId).toBe('777');
    expect(store.accountTelegram(OWNER)).toBe('777'); // account-level link
  });

  it('an unknown code is a 400 with a human message, and nothing is minted', async () => {
    const { store, f, provider } = await liveWorld();
    provider.execResponses.set('sh', { code: 0, stdout: PAIRING_FILE, stderr: '' });
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/pairing/approve', headers: H, payload: { code: 'NOPE' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/no longer pending/);
    expect(store.listMemberships('a1')).toHaveLength(1);
  });
});

describe('GET/PUT /v1/agents/:id/files/:name', () => {
  it('reads and writes only the editable triple, RUNNING-gated', async () => {
    const { store, f, provider } = await liveWorld();
    provider.execResponses.set('sh', { code: 0, stdout: 'file body', stderr: '' });
    const get = await f.inject({ method: 'GET', url: '/v1/agents/a1/files/SOUL.md', headers: H });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ name: 'SOUL.md', content: 'file body' });

    const put = await f.inject({ method: 'PUT', url: '/v1/agents/a1/files/SOUL.md', headers: H, payload: { content: 'new body' } });
    expect(put.statusCode).toBe(200);
    // pre-edit snapshot landed before the write
    expect(store.listSnapshots('a1').some((s) => s.reason === 'pre-edit')).toBe(true);

    // not in the editable set — never reaches a shell
    const evil = await f.inject({ method: 'PUT', url: '/v1/agents/a1/files/openclaw.json', headers: H, payload: { content: 'x' } });
    expect(evil.statusCode).toBe(400);

    store.setAgentState('a1', 'STOPPED');
    const stopped = await f.inject({ method: 'PUT', url: '/v1/agents/a1/files/SOUL.md', headers: H, payload: { content: 'y' } });
    expect(stopped.statusCode).toBe(409);
  });

  it("another account's agent is a 404, not a read", async () => {
    const { f } = await liveWorld();
    const res = await f.inject({ method: 'GET', url: '/v1/agents/a1/files/SOUL.md', headers: { 'x-agentclaw-owner': 'stranger' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('snapshots over HTTP: create, restore, delete', () => {
  it('full lifecycle against the real routes', async () => {
    const { store, f, provider } = await liveWorld();
    provider.execResponses.set('sh', { code: 0, stdout: 'soul text', stderr: '' });
    const created = await f.inject({ method: 'POST', url: '/v1/agents/a1/snapshots', headers: H, payload: { label: 'before-surgery' } });
    expect(created.statusCode).toBe(201);
    const snapId = created.json().id as string;

    const restored = await f.inject({ method: 'POST', url: `/v1/agents/a1/snapshots/${snapId}/restore`, headers: H, payload: {} });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().restored.length).toBeGreaterThan(0);

    const del = await f.inject({ method: 'DELETE', url: `/v1/agents/a1/snapshots/${snapId}`, headers: H });
    expect(del.statusCode).toBe(200);
    expect(store.listSnapshots('a1').find((s) => s.id === snapId)).toBeUndefined();

    const gone = await f.inject({ method: 'DELETE', url: `/v1/agents/a1/snapshots/${snapId}`, headers: H });
    expect(gone.statusCode).toBe(404);
  });
});

describe('DELETE /v1/agents/:id/members/:userId', () => {
  it('revokes a member; the owner seat refuses', async () => {
    const { store, f } = await liveWorld();
    store.insertMembership({
      id: 'm2', agentId: 'a1', userId: 'member-x', role: 'user',
      displayName: 'Gran', channelUserId: '222', status: 'active', joinedAt: 'now',
    });
    const res = await f.inject({ method: 'DELETE', url: '/v1/agents/a1/members/member-x', headers: H });
    expect(res.statusCode).toBe(200);
    expect(store.listMemberships('a1').find((m) => m.userId === 'member-x')!.status).toBe('revoked');

    const owner = await f.inject({ method: 'DELETE', url: `/v1/agents/a1/members/${OWNER}`, headers: H });
    expect(owner.statusCode).toBeGreaterThanOrEqual(400); // never the owner seat
  });
});

describe('group access over HTTP', () => {
  it('PATCH stores the mode; room mode requires the bound id; discovery parses group sessions', async () => {
    const { store, f, provider } = await liveWorld();
    // room without id → refused
    const bad = await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: H, payload: { groupAccess: { mode: 'room' } } });
    expect(bad.statusCode).toBe(400);

    // discovery: only group sessions surface, deduped
    provider.execResponses.set('sessions list', {
      code: 0,
      stdout: JSON.stringify({ sessions: [
        { key: 'agent:kitchen:main' },
        { key: 'agent:kitchen:telegram:group:-1000000000001' },
        { key: 'agent:kitchen:telegram:group:-1000000000001' },
      ] }),
      stderr: '',
    });
    const rooms = (await f.inject({ method: 'GET', url: '/v1/agents/a1/group-chats', headers: H })).json().rooms;
    expect(rooms).toEqual([{ id: '-1000000000001', key: 'agent:kitchen:telegram:group:-1000000000001' }]);

    const ok = await f.inject({
      method: 'PATCH', url: '/v1/agents/a1', headers: H,
      payload: { groupAccess: { mode: 'room', roomId: '-1000000000001' } },
    });
    expect(ok.statusCode).toBe(200);
    expect(store.getAgent('a1')!.groupAccess).toEqual({ mode: 'room', roomId: '-1000000000001' });
  });
});
