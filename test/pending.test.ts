import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

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
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  async function seed(id: string, slug: string, name: string, state: string, ownerId = OWNER) {
    const { runtimeRef } = await provider.provision({ agentId: id, slug, workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } }, env: {} } as any);
    store.insertAgent({ id, ownerId, name, slug, state: state as any, aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
    store.insertChannel({ id: `c-${id}`, agentId: id, kind: 'telegram', accountId: `bot_${id}`, secretRef: `chan/${id}`, deepLink: `https://t.me/bot_${id}`, createdAt: 'now' });
  }
  await seed('a1', 'fam', 'Family', 'RUNNING');
  await seed('a2', 'condo', 'Condo', 'RUNNING');
  await seed('a3', 'stop', 'Stopped', 'STOPPED');       // not RUNNING → skipped
  await seed('x9', 'theirs', 'Theirs', 'RUNNING', 'other'); // another owner → invisible
  const f = Fastify();
  await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  return { store, provider, f };
}


/** listPairingRequests now reads the pairing FILE, so fixtures are keyed by the
 *  agent's runtimeRef rather than by an --account argv. */
function pairingByAgent(provider: MockProvider, store: Store, byName: Record<string, unknown[]>) {
  const refFor = (name: string) =>
    store.listAllActiveAgents().find((a) => a.name === name)?.runtimeRef;
  const map = new Map<string, string>();
  for (const [name, requests] of Object.entries(byName)) {
    const ref = refFor(name);
    if (ref) map.set(ref, JSON.stringify({ version: 1, requests }));
  }
  provider.execShell = (async (ref: string) => ({
    code: 0, stdout: map.get(ref) ?? '', stderr: '',
  })) as any;
}

describe('GET /v1/pending (fleet-wide join requests)', () => {
  it('flattens pending pairings across the owner\'s RUNNING agents, attributed to each', async () => {
    const { store, provider, f } = await world();
    // Per-agent pairing lists (keyed by the --account slug in the argv).
    pairingByAgent(provider, store, {
      Family: [{ id: '555', code: 'CODEA', meta: { username: 'maria_k', firstName: 'Maria' } }],
      Condo: [{ id: '777', code: 'CODEB', meta: { firstName: 'Jon' } }],
    });
    const res = await f.inject({ method: 'GET', url: '/v1/pending', headers: as });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);
    const byAgent = Object.fromEntries(body.map((r: any) => [r.agentName, r]));
    expect(byAgent.Family).toMatchObject({ agentId: 'a1', code: 'CODEA', username: 'maria_k', firstName: 'Maria', telegramId: '555' });
    expect(byAgent.Condo).toMatchObject({ agentId: 'a2', code: 'CODEB', firstName: 'Jon' });
  });

  it('skips stopped agents and never includes another owner\'s agents', async () => {
    const { store, provider, f } = await world();
    // Only the other owner's agent has a request — must not surface to us.
    pairingByAgent(provider, store, { Theirs: [{ id: '999', code: 'SECRET', meta: {} }] });
    const res = await f.inject({ method: 'GET', url: '/v1/pending', headers: as });
    expect(res.json()).toEqual([]);
  });

  it('POST /pairing/deny turns a request away, owner-scoped', async () => {
    const { store, provider, f } = await world();
    provider.execResponses.set('sh-volume', { code: 0, stdout: '1\n', stderr: '' });
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/pairing/deny', headers: as, payload: { code: 'CODEA' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ denied: true });

    // Another owner can't deny on someone else's agent, and a missing code 400s.
    const notMine = await f.inject({ method: 'POST', url: '/v1/agents/a1/pairing/deny', headers: { 'x-hatchabot-owner': 'someone-else' }, payload: { code: 'CODEA' } });
    expect(notMine.statusCode).toBe(404);
    const noCode = await f.inject({ method: 'POST', url: '/v1/agents/a1/pairing/deny', headers: as, payload: {} });
    expect(noCode.statusCode).toBe(400);
  });

  it('POST /pairing/deny rejects a malformed code with a 400, not a 500', async () => {
    const { f } = await world();
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/pairing/deny', headers: as, payload: { code: 'nope; rm -rf /' } });
    expect(res.statusCode).toBe(400);
  });

  it('one unreachable agent does not sink the whole list', async () => {
    const { store, provider, f } = await world();
    const a2ref = store.listAllActiveAgents().find((a) => a.name === 'Condo')!.runtimeRef!;
    pairingByAgent(provider, store, { Family: [{ id: '555', code: 'CODEA', meta: {} }] });
    const okShell = provider.execShell.bind(provider);
    provider.execShell = (async (ref: string, script: string) => {
      if (ref === a2ref) throw new Error('container gone');
      return okShell(ref, script);
    }) as any;
    const res = await f.inject({ method: 'GET', url: '/v1/pending', headers: as });
    expect(res.json()).toHaveLength(1); // a1 survived; a2 dropped
  });
});
