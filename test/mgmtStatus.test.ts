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

const BEAT = { botUsername: 'hatchabot_mgmt_bot', mode: 'read-only', llm: 'claude-sonnet-5', allowlisted: 1 };

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
      botUsername: 'hatchabot_mgmt_bot', mode: 'read-only', llm: 'claude-sonnet-5', allowlisted: 1,
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
      (await app.inject({ method: 'GET', url: '/v1/mgmt/status', headers: { 'x-hatchabot-owner': 'someone-else' } })).body,
    );
    expect(other).toEqual({ configured: false });
    await app.close();
  });

  it('retiring it is refused while it still beats, then forgets it and revokes its token', async () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    const app = Fastify();
    await registerRoutes(app, {
      store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]),
      channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never,
    });
    await app.inject({ method: 'POST', url: '/v1/mgmt/heartbeat', payload: BEAT });
    await app.inject({ method: 'POST', url: '/v1/cli-tokens', payload: { label: 'mgmt-bot' } });
    await app.inject({ method: 'POST', url: '/v1/cli-tokens', payload: { label: 'CLI' } });

    // Still beating: refused, and the message says how to stop it.
    const live = await app.inject({ method: 'DELETE', url: '/v1/mgmt/status' });
    expect(live.statusCode).toBe(409);
    expect(live.json().error).toMatch(/hatchabot-mgmt-bot/);

    // The service has been stopped: its last beat is old now.
    db.prepare('UPDATE mgmt_heartbeat SET seen_at = ?').run(new Date(Date.now() - 600_000).toISOString());
    const gone = await app.inject({ method: 'DELETE', url: '/v1/mgmt/status' });
    expect(gone.statusCode).toBe(200);
    expect(gone.json()).toMatchObject({ forgotten: true, revoked: 1, botUsername: 'hatchabot_mgmt_bot' });

    // Forgotten for good — and only ITS token went.
    expect((await app.inject({ method: 'GET', url: '/v1/mgmt/status' })).json()).toEqual({ configured: false });
    const left = (await app.inject({ method: 'GET', url: '/v1/cli-tokens' })).json();
    expect(left.map((t: { label: string }) => t.label)).toEqual(['CLI']);
    await app.close();
  });
});
