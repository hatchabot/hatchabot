import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import { LocalSecretStore } from '../src/secrets/localSecretStore.js';

/**
 * Agent deletion teardown: a tombstone must leave no live credentials, must not
 * hand a migrated-away bot back to this pool, and must survive an interrupted
 * destroy (retryable, never wedged).
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const as = { 'x-hatchabot-owner': OWNER };

async function world(opts: { migrated?: boolean; destroyThrows?: boolean } = {}) {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  const provider = new MockProvider();
  const releaseCalls: string[] = [];
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const { runtimeRef } = await provider.provision({
    agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } }, env: {},
  } as any);
  await provider.start(runtimeRef);
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  // Imported-style channel (channel/-keyed token), a git data source, and an env
  // var — each with a stored secret the delete must scrub.
  store.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'botacct', secretRef: 'channel/a1/bot-token', deepLink: 'https://t.me/x', createdAt: 'now' });
  await secrets.put('channel/a1/bot-token', 'BOT-TOKEN');
  store.insertDataSource({ id: 'ds1', agentId: 'a1', kind: 'git', access: 'ro', mountName: 'defs', repoUrl: 'git@github.com:o/defs.git', secretRef: 'data-source/ds1', pubKey: 'k', createdAt: 'now' });
  await secrets.put('data-source/ds1', 'PRIVKEY');
  store.insertAgentEnv({ id: 'e1', agentId: 'a1', name: 'MARKETDATA_API_KEY', secretRef: 'agent-env/e1', createdAt: 'now' });
  await secrets.put('agent-env/e1', 'SECRETVAL');
  if (opts.migrated) store.setAgentMigratedTo('a1', 'peer-b');
  if (opts.destroyThrows) provider.destroy = async () => { throw new Error('docker boom'); };
  const f = Fastify();
  await registerRoutes(f, { store, secrets, providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async (a: string) => { releaseCalls.push(a); } } as any });
  return { store, secrets, provider, releaseCalls, f };
}

const del = (f: any) => f.inject({ method: 'DELETE', url: '/v1/agents/a1', headers: as });

describe('DELETE /v1/agents/:id teardown', () => {
  it('scrubs data-source, env-var, and channel secrets and releases the bot', async () => {
    const { store, secrets, releaseCalls, f } = await world();
    const res = await del(f);
    expect(res.statusCode).toBe(200);
    expect(store.getAgent('a1')!.state).toBe('DELETED');
    expect(secrets.map.has('data-source/ds1')).toBe(false);
    expect(secrets.map.has('agent-env/e1')).toBe(false);
    expect(secrets.map.has('channel/a1/bot-token')).toBe(false);
    expect(releaseCalls).toEqual(['botacct']);
  });

  it('does NOT release the bot of a migrated-away agent (the peer still polls it)', async () => {
    const { store, releaseCalls, f } = await world({ migrated: true });
    const res = await del(f);
    expect(res.statusCode).toBe(200);
    expect(store.getAgent('a1')!.state).toBe('DELETED');
    expect(releaseCalls).toEqual([]);
  });

  it('parks in FAILED (retryable) and tears nothing down when destroy fails', async () => {
    const { store, secrets, releaseCalls, f } = await world({ destroyThrows: true });
    const res = await del(f);
    expect(res.statusCode).toBe(502);
    expect(store.getAgent('a1')!.state).toBe('FAILED');
    // The runtime may still be alive, so nothing is released or scrubbed yet.
    expect(releaseCalls).toEqual([]);
    expect(secrets.map.has('data-source/ds1')).toBe(true);
  });

  it('a retry after an interrupted delete re-enters DELETING and completes', async () => {
    const { store, secrets, provider, releaseCalls, f } = await world({ destroyThrows: true });
    await del(f); // → FAILED
    provider.destroy = async () => {}; // docker recovers
    const res = await del(f); // retry
    expect(res.statusCode).toBe(200);
    expect(store.getAgent('a1')!.state).toBe('DELETED');
    expect(secrets.map.has('agent-env/e1')).toBe(false);
    expect(releaseCalls).toEqual(['botacct']);
  });

  it('a stored key that will not delete keeps the agent retryable, with the rows that name it (C089)', async () => {
    const { store, secrets, f } = await world();
    await secrets.put('agent-call-token/a1', 'CALL-TOKEN');
    const realDelete = secrets.delete.bind(secrets);
    secrets.delete = async (r: string) => { if (r === 'agent-env/e1') throw new Error('database is locked'); return realDelete(r); };
    const res = await del(f);
    expect(res.statusCode).toBe(502);
    expect(store.getAgent('a1')!.state).toBe('FAILED');
    expect(secrets.map.has('agent-env/e1')).toBe(true);
    expect(store.listAgentEnv('a1').map((e) => e.secretRef)).toEqual(['agent-env/e1']); // still named, so a retry finds it
    secrets.delete = realDelete;
    const again = await del(f);
    expect(again.statusCode).toBe(200);
    expect(store.getAgent('a1')!.state).toBe('DELETED');
    expect([...secrets.map.keys()].filter((k) => k !== 'ai/p1')).toEqual([]);
  });

  it("a removed source's key still waiting for its scrub goes with the agent", async () => {
    const { store, secrets, f } = await world();
    store.addDataSourceRemoval({ id: 'ds0', agentId: 'a1', mountName: 'old', secretRef: 'data-source/ds0' });
    await secrets.put('data-source/ds0', 'OLD-PRIVKEY');
    expect((await del(f)).statusCode).toBe(200);
    expect(secrets.map.has('data-source/ds0')).toBe(false);
    expect(store.dataSourceRemovals('a1')).toEqual([]);
  });
});

describe('the boot sweep of agent secrets nothing names (C089)', () => {
  it('deletes env values, deploy keys and call tokens without a row or a live agent, and keeps the rest', async () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    const secrets = new LocalSecretStore(db, Buffer.alloc(32, 7));
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    for (const [id, state] of [['live', 'RUNNING'], ['gone', 'DELETED']] as const) {
      store.insertAgent({ id, ownerId: OWNER, name: id, slug: id, state, aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    }
    store.insertAgentEnv({ id: 'e1', agentId: 'live', name: 'PANTRY_KEY', secretRef: 'agent-env/e1', createdAt: 'now' });
    store.insertDataSource({ id: 'ds1', agentId: 'live', kind: 'git', access: 'ro', mountName: 'defs', repoUrl: 'git@example.org:o/defs.git', secretRef: 'data-source/ds1', pubKey: 'k', createdAt: 'now' });
    store.insertDataSource({ id: 'ds2', agentId: 'live', kind: 'git', access: 'ro', mountName: 'pub', repoUrl: 'https://example.org/o/pub.git', createdAt: 'now' });
    for (const ref of ['agent-env/e1', 'agent-env/e-orphan', 'data-source/ds1', 'data-source/ds-orphan', 'agent-call-token/live', 'agent-call-token/gone', 'agent-call-token/never', 'ai/p1', 'telegram/bot/x']) {
      await secrets.put(ref, 'FAKE-FIXTURE-VALUE');
    }
    expect(store.sweepOrphanAgentSecrets().sort()).toEqual(['agent-call-token/gone', 'agent-call-token/never', 'agent-env/e-orphan', 'data-source/ds-orphan']);
    const left = (db.prepare('SELECT ref FROM secrets ORDER BY ref').all() as Array<{ ref: string }>).map((r) => r.ref);
    expect(left).toEqual(['agent-call-token/live', 'agent-env/e1', 'ai/p1', 'data-source/ds1', 'telegram/bot/x']);
  });
});
