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

async function makeApp() {
  const store = new Store(new Database(':memory:'));
  const app = Fastify();
  await registerRoutes(app, {
    store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
  });
  return app;
}

const BEAT = { botUsername: 'agentclaw_mgmt_bot', mode: 'read-only', llm: 'claude-sonnet-5', allowlisted: 1 };

describe('management-bot heartbeat → presence', () => {
  it('unconfigured until the first beat, then online with the beat fields', async () => {
    const app = await makeApp();
    const before = JSON.parse((await app.inject({ method: 'GET', url: '/v1/mgmt/status' })).body);
    expect(before).toEqual({ configured: false });

    const post = await app.inject({ method: 'POST', url: '/v1/mgmt/heartbeat', payload: BEAT });
    expect(post.statusCode).toBe(200);

    const after = JSON.parse((await app.inject({ method: 'GET', url: '/v1/mgmt/status' })).body);
    expect(after).toMatchObject({
      configured: true, online: true,
      botUsername: 'agentclaw_mgmt_bot', mode: 'read-only', llm: 'claude-sonnet-5', allowlisted: 1,
    });
    expect(Date.parse(after.seenAt)).not.toBeNaN();
    await app.close();
  });

  it('a later beat overwrites (mode flip shows up), and bad payloads 400', async () => {
    const app = await makeApp();
    await app.inject({ method: 'POST', url: '/v1/mgmt/heartbeat', payload: BEAT });
    await app.inject({ method: 'POST', url: '/v1/mgmt/heartbeat', payload: { ...BEAT, mode: 'read-write', llm: undefined } });
    const s = JSON.parse((await app.inject({ method: 'GET', url: '/v1/mgmt/status' })).body);
    expect(s.mode).toBe('read-write');
    expect(s.llm).toBeUndefined();

    const bad = await app.inject({ method: 'POST', url: '/v1/mgmt/heartbeat', payload: { botUsername: '', mode: 'sideways' } });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('presence is owner-scoped — another account sees no heartbeat', async () => {
    const app = await makeApp();
    await app.inject({ method: 'POST', url: '/v1/mgmt/heartbeat', payload: BEAT });
    const other = JSON.parse(
      (await app.inject({ method: 'GET', url: '/v1/mgmt/status', headers: { 'x-agentclaw-owner': 'someone-else' } })).body,
    );
    expect(other).toEqual({ configured: false });
    await app.close();
  });
});
