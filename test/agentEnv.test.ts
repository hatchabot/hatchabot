import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * Per-agent environment variables. Values are secrets: they go to the
 * SecretStore, are never returned by the API, and a reserved set is refused so a
 * var can't shadow the agent's managed AI auth or runtime PATH/PYTHONPATH.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const as = { 'x-agentclaw-owner': OWNER };

async function world() {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  const f = Fastify();
  await registerRoutes(f, { store, secrets, providers: new Map([['mock', new MockProvider()]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  return { store, secrets, f };
}

const addEnv = (f: any, body: unknown) => f.inject({ method: 'POST', url: '/v1/agents/a1/env', headers: as, payload: body });

describe('POST /v1/agents/:id/env', () => {
  it('adds a var: the value goes to the SecretStore, only the name is returned', async () => {
    const { store, secrets, f } = await world();
    const res = await addEnv(f, { name: 'MARKETDATA_API_KEY', value: 'super-secret' });
    expect(res.statusCode).toBe(200);
    const vars = store.listAgentEnv('a1');
    expect(vars).toHaveLength(1);
    expect(vars[0]!.name).toBe('MARKETDATA_API_KEY');
    expect(secrets.map.get(vars[0]!.secretRef)).toBe('super-secret');
    // The response carries the name but never the value or the secret ref.
    const inList = res.json().envVars.find((v: any) => v.name === 'MARKETDATA_API_KEY');
    expect(inList).toBeTruthy();
    expect(inList.secretRef).toBeUndefined();
    expect(JSON.stringify(res.json())).not.toContain('super-secret');
  });

  it('refuses a reserved name', async () => {
    const { store, f } = await world();
    const res = await addEnv(f, { name: 'ANTHROPIC_API_KEY', value: 'x' });
    expect(res.statusCode).toBe(400);
    expect(store.listAgentEnv('a1')).toHaveLength(0);
  });

  it('refuses credential-redirect / loader vars by shape (not just exact names)', async () => {
    const { store, f } = await world();
    // The exfil vector: redirect where a (possibly shared) key is sent, or alter
    // code/cert loading. None of these are in an exact deny-list.
    for (const name of [
      'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY',
      'HTTPS_PROXY', 'http_proxy', 'ALL_PROXY', 'LD_PRELOAD', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
    ]) {
      const res = await addEnv(f, { name, value: 'x' });
      expect(res.statusCode, name).toBe(400);
    }
    expect(store.listAgentEnv('a1')).toHaveLength(0);
  });

  it('still allows a benign, non-credential variable', async () => {
    const { store, f } = await world();
    expect((await addEnv(f, { name: 'MARKETDATA_API_KEY', value: 'ok' })).statusCode).toBe(200);
    expect((await addEnv(f, { name: 'TZ', value: 'Europe/Lisbon' })).statusCode).toBe(200);
    expect(store.listAgentEnv('a1').map((e) => e.name).sort()).toEqual(['MARKETDATA_API_KEY', 'TZ']);
  });

  it('refuses an invalid variable name', async () => {
    const { f } = await world();
    expect((await addEnv(f, { name: '2bad', value: 'x' })).statusCode).toBe(400);
    expect((await addEnv(f, { name: 'has space', value: 'x' })).statusCode).toBe(400);
  });

  it('refuses an empty value', async () => {
    const { f } = await world();
    expect((await addEnv(f, { name: 'OK_NAME', value: '' })).statusCode).toBe(400);
  });

  it('409s on a duplicate name', async () => {
    const { f } = await world();
    await addEnv(f, { name: 'DUP', value: 'a' });
    expect((await addEnv(f, { name: 'DUP', value: 'b' })).statusCode).toBe(409);
  });

  it('404s for an agent the caller does not own', async () => {
    const { f } = await world();
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/env', headers: { 'x-agentclaw-owner': 'someone-else' }, payload: { name: 'X', value: 'y' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /v1/agents/:id/env/:envId', () => {
  it('removes the var and scrubs its secret', async () => {
    const { store, secrets, f } = await world();
    const added = (await addEnv(f, { name: 'GONE', value: 'v' })).json();
    const ref = store.listAgentEnv('a1')[0]!.secretRef;
    expect(secrets.map.has(ref)).toBe(true);
    const id = added.envVars[0].id;
    const res = await f.inject({ method: 'DELETE', url: `/v1/agents/a1/env/${id}`, headers: as });
    expect(res.statusCode).toBe(200);
    expect(store.listAgentEnv('a1')).toHaveLength(0);
    expect(secrets.map.has(ref)).toBe(false);
  });

  it('404s an unknown id', async () => {
    const { f } = await world();
    const res = await f.inject({ method: 'DELETE', url: '/v1/agents/a1/env/nope', headers: as });
    expect(res.statusCode).toBe(404);
  });
});
