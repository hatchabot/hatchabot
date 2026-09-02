import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { gzipSync } from 'node:zlib';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * Sharing Phase 2a over HTTP: declaring setup fields on an agent, and filling
 * them on import — file path and inbox path. The core substitution rules are
 * pinned in template.test.ts; these pin the API boundary.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) { const v = this.map.get(ref); if (v === undefined) throw new Error('missing'); return v; }
  async delete(ref: string) { this.map.delete(ref); }
}

const OWNER = 'user-owner';
const H = { 'x-agentclaw-owner': OWNER };

const TEMPLATE = gzipSync(Buffer.from(JSON.stringify({
  format: 'agentclaw-template', version: 1, exportedAt: 'now',
  agent: { name: 'Stock Advisor', persona: 'p', sharedMemory: false },
  files: { 'SOUL.md': 'A {{style}} advisor.', 'AGENTS.md': '# A' },
  ai: { vendor: 'anthropic' }, dataNeeds: [], envNeeds: [],
  parameters: [
    { key: 'style', label: 'Investment style', required: true, type: 'choice', options: ['value', 'growth'], target: 'soul' },
  ],
})));

async function world() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Mine', slug: 'mine', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: new MemSecrets(),
    providers: new Map([['mock', new MockProvider()]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
  });
  return { store, f };
}

describe('PATCH /v1/agents/:id parameters', () => {
  it('declares, exposes on the agent, and clears with null', async () => {
    const { store, f } = await world();
    const params = [{ key: 'style', label: 'Style', required: true, type: 'text', target: 'soul' }];
    const res = await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: H, payload: { parameters: params } });
    expect(res.statusCode).toBe(200);
    expect(res.json().parameters).toMatchObject(params);
    expect(store.getAgent('a1')!.parameters).toMatchObject(params);

    const clear = await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: H, payload: { parameters: null } });
    expect(clear.statusCode).toBe(200);
    expect(store.getAgent('a1')!.parameters).toBeUndefined();
  });

  it('rejects duplicate keys and malformed keys', async () => {
    const { f } = await world();
    const dup = [
      { key: 'x', label: 'X', required: false, type: 'text', target: 'soul' },
      { key: 'x', label: 'X2', required: false, type: 'text', target: 'soul' },
    ];
    expect((await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: H, payload: { parameters: dup } })).statusCode).toBe(400);
    const bad = [{ key: 'Bad Key', label: 'B', required: false, type: 'text', target: 'soul' }];
    expect((await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: H, payload: { parameters: bad } })).statusCode).toBe(400);
  });
});

describe('POST /v1/agents/import with values', () => {
  it('substitutes provided values into the seeded files', async () => {
    const { store, f } = await world();
    const res = await f.inject({
      method: 'POST',
      url: `/v1/agents/import?values=${encodeURIComponent(JSON.stringify({ style: 'value' }))}`,
      headers: { ...H, 'content-type': 'application/octet-stream' },
      payload: TEMPLATE,
    });
    expect(res.statusCode).toBe(201);
    const seeded = store.getAgentSeed(res.json().id);
    expect(seeded['SOUL.md']).toBe('A value advisor.');
  });

  it('400s naming the missing required field, creating nothing', async () => {
    const { store, f } = await world();
    const res = await f.inject({
      method: 'POST', url: '/v1/agents/import',
      headers: { ...H, 'content-type': 'application/octet-stream' },
      payload: TEMPLATE,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Investment style/);
    expect(store.listAgents(OWNER)).toHaveLength(1); // only the pre-existing agent
  });

  it('400s on malformed values JSON instead of 500', async () => {
    const { f } = await world();
    const res = await f.inject({
      method: 'POST', url: '/v1/agents/import?values=%7Bnot-json',
      headers: { ...H, 'content-type': 'application/octet-stream' },
      payload: TEMPLATE,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('inbox with parameters', () => {
  it('lists a share with its parameters, and accept substitutes values', async () => {
    const { store, f } = await world();
    // Identity mode isn't on in this harness; insert the share directly, bound
    // to the owner — the routes under test are list + accept.
    store.insertShare({
      id: 's1', fromOwner: 'user-other', fromEmail: 'o@example.com', toEmail: 'me@example.com',
      toOwner: OWNER, agentName: 'Stock Advisor', message: 'try it', blob: TEMPLATE,
      createdAt: new Date().toISOString(),
    });

    const list = await f.inject({ method: 'GET', url: '/v1/inbox', headers: H });
    expect(list.statusCode).toBe(200);
    expect(list.json().shares[0].parameters).toMatchObject([{ key: 'style' }]);

    const missing = await f.inject({ method: 'POST', url: '/v1/inbox/s1/accept', headers: H, payload: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toMatch(/Investment style/);

    const ok = await f.inject({ method: 'POST', url: '/v1/inbox/s1/accept', headers: H, payload: { values: { style: 'growth' } } });
    expect(ok.statusCode).toBe(201);
    expect(store.getAgentSeed(ok.json().id)['SOUL.md']).toBe('A growth advisor.');
  });
});
