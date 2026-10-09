import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

// "Connect these agents to each other": one call grants every selected agent
// access to every other selected agent (and back), or removes exactly those.

const OWNER = 'user-o';
const as = { 'x-hatchabot-owner': OWNER };
class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}
async function world() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const add = (id: string, name: string, owner = OWNER, state = 'RUNNING') => {
    store.insertAgent({ id, ownerId: owner, name, slug: id, state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
    store.setAgentState(id, state as any);
  };
  add('stock', 'Stock'); add('tax', 'Tax'); add('legal', 'Legal'); add('cook', 'Cook');
  add('old', 'Old'); store.setAgentState('old', 'ARCHIVED');
  add('theirs', 'Theirs', 'user-other');
  const secrets = new MemSecrets();
  const f = Fastify();
  await registerRoutes(f, { store, secrets, providers: new Map([['mock', new MockProvider()]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  const mesh = (agentIds: string[], connect: boolean) => f.inject({ method: 'POST', url: '/v1/agent-peers/mesh', headers: as, payload: { agentIds, connect } });
  return { store, secrets, mesh, f };
}

describe('POST /v1/agent-peers/mesh', () => {
  it('connects three agents to each other: six grants, call tokens minted, all three flagged for rebuild', async () => {
    const { store, secrets, mesh } = await world();
    store.setAgentPeers('stock', ['cook']); // an existing grant outside the selection survives
    const res = await mesh(['stock', 'tax', 'legal'], true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ agents: 3, changed: 3, grants: 6 });
    expect(store.listAgentPeers('stock').sort()).toEqual(['cook', 'legal', 'tax']);
    expect(store.listAgentPeers('tax').sort()).toEqual(['legal', 'stock']);
    expect(store.listAgentPeers('legal').sort()).toEqual(['stock', 'tax']);
    expect(store.agentMayCall('tax', 'stock') && store.agentMayCall('legal', 'tax')).toBe(true);
    for (const id of ['stock', 'tax', 'legal']) expect(store.hasAgentCallToken(id)).toBe(true);
    expect(secrets.map.size).toBe(3);
    expect(res.json().needRebuild.map((a: any) => a.name).sort()).toEqual(['Legal', 'Stock', 'Tax']);
    // idempotent
    expect((await mesh(['stock', 'tax', 'legal'], true)).json().changed).toBe(0);
  });

  it('disconnects exactly the pairs inside the selection', async () => {
    const { store, mesh } = await world();
    store.setAgentPeers('stock', ['tax', 'legal', 'cook']);
    store.setAgentPeers('tax', ['stock']);
    const res = await mesh(['stock', 'tax'], false);
    expect(res.json().changed).toBe(2);
    expect(store.listAgentPeers('stock').sort()).toEqual(['cook', 'legal']);
    expect(store.listAgentPeers('tax')).toEqual([]);
  });

  it('skips archived agents, refuses other owners, too few agents and bad shapes', async () => {
    const { mesh } = await world();
    const res = await mesh(['stock', 'tax', 'old'], true);
    expect(res.json().skipped).toEqual([{ name: 'Old', reason: 'archived' }]);
    expect(res.json().grants).toBe(2);
    expect((await mesh(['stock', 'old'], true)).statusCode).toBe(400);
    expect((await mesh(['stock'], true)).statusCode).toBe(400);
    expect((await mesh(['stock', 'theirs'], true)).statusCode).toBe(404);
  });
});

describe('the call token: its secret and its hash always agree (2026-10-09)', () => {
  const peers = (w: Awaited<ReturnType<typeof world>>, id: string, ids: string[]) =>
    w.f.inject({ method: 'PUT', url: `/v1/agents/${id}/peers`, headers: as, payload: { peerIds: ids } });

  it('a failed secret write leaves no live hash, so the next grant mints again', async () => {
    const w = await world();
    const put = w.secrets.put.bind(w.secrets);
    let fail = true;
    w.secrets.put = async (r: string, v: string) => { if (fail) { fail = false; throw new Error('disk full'); } return put(r, v); };
    expect((await peers(w, 'stock', ['tax'])).statusCode).toBe(500);
    expect(w.store.hasAgentCallToken('stock')).toBe(false);
    expect((await peers(w, 'stock', ['tax'])).statusCode).toBe(200);
    expect(w.store.agentCallTokenIs('stock', w.secrets.map.get('agent-call-token/stock')!)).toBe(true);
  });

  it('a live hash whose secret is gone is minted again', async () => {
    const w = await world();
    w.store.createAgentCallToken('stock', OWNER); // the hash, with no secret written
    expect((await peers(w, 'stock', ['tax'])).statusCode).toBe(200);
    expect(w.store.agentCallTokenIs('stock', w.secrets.map.get('agent-call-token/stock')!)).toBe(true);
  });

  it('two grants at once end with one token, secret and hash the same', async () => {
    const w = await world();
    const put = w.secrets.put.bind(w.secrets);
    // The first write is slow: the second grant's mint would otherwise overtake it.
    let first = true;
    w.secrets.put = async (r: string, v: string) => { if (first) { first = false; await new Promise((res) => setTimeout(res, 20)); } return put(r, v); };
    const [a, b] = await Promise.all([peers(w, 'stock', ['tax']), w.mesh(['stock', 'legal'], true)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(w.store.agentCallTokenIs('stock', w.secrets.map.get('agent-call-token/stock')!)).toBe(true);
  });
});
