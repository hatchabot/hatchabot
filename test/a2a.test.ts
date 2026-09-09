import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

const OWNER = 'user-o';

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  for (const [id, slug, name] of [['x', 'investing', 'Investing'], ['y', 'tax', 'Tax']] as const) {
    const { runtimeRef } = await provider.provision({ agentId: id, slug, workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } as any }, env: {} });
    await provider.start(runtimeRef);
    store.insertAgent({ id, ownerId: OWNER, name, slug, state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
    store.setAgentRuntimeRef(id, runtimeRef);
    store.setAgentState(id, 'RUNNING');
  }
  const secrets = new MemSecrets();
  const f = Fastify();
  await registerRoutes(f, { store, secrets, providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  // The Tax agent's turn returns a canned reply (prefix-matched on argv).
  provider.execResponses.set('agent --agent tax', { code: 0, stdout: 'Harvest the losses; watch the wash-sale window.', stderr: '' });
  return { store, provider, secrets, f };
}

describe('agent-to-agent consult', () => {
  it('a granted agent consults its peer and gets the reply', async () => {
    const { store, f } = await world();
    store.setAgentPeers('x', ['y']); // Investing may consult Tax
    const token = store.createAgentCallToken('x', OWNER);

    const res = await f.inject({
      method: 'POST', url: '/v1/agents/y/message',
      headers: { authorization: `Bearer ${token}` },
      payload: { text: 'Should I harvest these losses?' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply).toMatch(/harvest the losses/i);
  });

  it('rejects a call with no token (401)', async () => {
    const { f } = await world();
    const res = await f.inject({ method: 'POST', url: '/v1/agents/y/message', payload: { text: 'hi' } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a caller without a grant (403), and does not run a turn', async () => {
    const { store, provider, f } = await world();
    const token = store.createAgentCallToken('x', OWNER); // token but NO peer grant
    const before = provider.execLog.length;
    const res = await f.inject({
      method: 'POST', url: '/v1/agents/y/message',
      headers: { authorization: `Bearer ${token}` }, payload: { text: 'hi' },
    });
    expect(res.statusCode).toBe(403);
    expect(provider.execLog.length).toBe(before); // never reached the turn
  });

  it('an A2A token cannot act as a general owner bearer (ownerForCliToken rejects it)', async () => {
    const { store } = await world();
    const token = store.createAgentCallToken('x', OWNER);
    expect(store.ownerForCliToken(token)).toBeUndefined(); // scoped to /message only
  });
});
