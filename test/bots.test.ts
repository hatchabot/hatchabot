import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { TelegramPoolProvisioner } from '../src/channels/telegramPool.js';
import { auditBots } from '../src/orchestrator/bots.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

class MemSecrets implements SecretStore {
  private m = new Map<string, string>();
  async put(ref: string, val: string) { this.m.set(ref, val); }
  async get(ref: string) { const v = this.m.get(ref); if (v === undefined) throw new Error(`no secret ${ref}`); return v; }
  async delete(ref: string) { this.m.delete(ref); }
}

// getMe: a "dead-token" is rejected with 401 (definitively invalid); a
// "flaky-token" gets a 500 (inconclusive); everything else is valid. getUpdates
// is quiet.
const fetchStub = (async (url: string | URL) => {
  const u = String(url);
  if (u.includes('/getMe')) {
    if (u.includes('dead-token')) return { status: 401, json: async () => ({ ok: false }) };
    if (u.includes('flaky-token')) return { status: 500, json: async () => ({ ok: false }) };
    return { status: 200, json: async () => ({ ok: true, result: { username: 'x' } }) };
  }
  return { status: 200, json: async () => ({ ok: true }) }; // getUpdates → quiet
}) as unknown as typeof fetch;

async function fixture() {
  const db = new Database(':memory:');
  const store = new Store(db);
  const secrets = new MemSecrets();
  const pool = new TelegramPoolProvisioner(db, secrets);
  store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'DGX', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });

  const mkAgent = (id: string, state: string, acct: string, ref: string) => {
    store.insertAgent({ id, ownerId: 'o', name: id.toUpperCase(), slug: id, state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: 'x', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    store.setAgentRuntimeRef(id, `docker://${id}`);
    // Walk the legal path: PROVISIONING → RUNNING → (STOPPED).
    if (state === 'RUNNING' || state === 'STOPPED') store.setAgentState(id, 'RUNNING');
    if (state === 'STOPPED') store.setAgentState(id, 'STOPPED');
    store.insertChannel({ id: `c-${id}`, agentId: id, kind: 'telegram', accountId: acct, secretRef: ref, deepLink: `https://t.me/${acct}`, createdAt: 'now' });
  };
  mkAgent('run', 'RUNNING', 'runbot', 'chan/run');
  mkAgent('stopped', 'STOPPED', 'stopbot', 'chan/stopped');
  mkAgent('flaky', 'RUNNING', 'flakybot', 'chan/flaky');
  await secrets.put('chan/run', 'run-token');
  await secrets.put('chan/stopped', 'dead-token'); // getMe 401 → invalid
  await secrets.put('chan/flaky', 'flaky-token'); // getMe 500 → inconclusive
  await pool.addToPool('poolbot', 'pool-token'); // free, never leased

  return { store, secrets, pool };
}

describe('auditBots', () => {
  it('classifies by agent state and pool lease (no live checks)', async () => {
    const { store, secrets, pool } = await fixture();
    const res = await auditBots({ store, secrets, pool, hostName: 'DGX' }, 'o');
    expect(res.host).toBe('DGX');
    const by = Object.fromEntries(res.bots.map((b) => [b.username, b]));
    expect(by.runbot!.cls).toBe('in-use');
    expect(by.stopbot!.cls).toBe('reclaimable'); // stopped agent → idle slot
    expect(by.poolbot).toMatchObject({ cls: 'reclaimable', source: 'pool', pooled: true });
    // no live probe ran
    expect(by.runbot!.valid).toBeUndefined();
  });

  it('with live checks: invalid token → dead, and a running bot is never poll-probed', async () => {
    const { store, secrets, pool } = await fixture();
    const res = await auditBots({ store, secrets, pool, hostName: 'DGX', fetchImpl: fetchStub }, 'o', { live: true });
    const by = Object.fromEntries(res.bots.map((b) => [b.username, b]));
    // running: valid, but NOT poll-probed (protect its live poller)
    expect(by.runbot).toMatchObject({ cls: 'in-use', valid: true });
    expect(by.runbot!.polling).toBeUndefined();
    // stopped with a dead token → dead, overriding reclaimable
    expect(by.stopbot).toMatchObject({ cls: 'dead', valid: false });
    // free pool bot: valid and probed (idle) → quiet
    expect(by.poolbot).toMatchObject({ cls: 'reclaimable', valid: true, polling: 'quiet' });
    // a transient Telegram failure (500) must NOT flag a running agent dead:
    // it stays in-use with validity left unknown.
    expect(by.flakybot!.cls).toBe('in-use');
    expect(by.flakybot!.valid).toBeUndefined();
  });
});
