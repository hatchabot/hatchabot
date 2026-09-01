import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { TelegramPoolProvisioner } from '../src/channels/telegramPool.js';
import { CompositeTelegramProvisioner } from '../src/channels/composite.js';
import { TelegramManualProvisioner } from '../src/channels/telegramManual.js';
import { archiveAgent } from '../src/orchestrator/archive.js';
import { runProvisionSteps } from '../src/orchestrator/provision.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * The whole point, end to end: two agents, one bot. Agent A holds the only bot
 * in the pool; archiving A lets B have it, and restoring A later gets A a
 * different bot — never B's, which B is still using.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error(`missing ${r}`); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const okFetch = (async () => new Response('{"ok":true}', {
  headers: { 'content-type': 'application/json' },
})) as unknown as typeof fetch;

describe('one bot, two agents, taking turns', () => {
  it('archiving A frees its bot for B; restoring A later gives A a different one', async () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    const secrets = new MemSecrets();
    const provider = new MockProvider();
    const pool = new TelegramPoolProvisioner(db, secrets, { fetchImpl: okFetch });
    const channel = new CompositeTelegramProvisioner(pool, new TelegramManualProvisioner(secrets));
    const log = () => {};
    // sleep is injected so the readiness gate's poll interval doesn't put real
    // seconds into the suite.
    const deps = { store, secrets, provider, channel, log, sleep: async () => {} };

    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-5', secretRef: 'ai/p1', createdAt: 'now' });
    await secrets.put('ai/p1', 'key');
    const mk = (id: string, name: string) => store.insertAgent({
      id, ownerId: 'o', name, slug: id, state: 'PROVISIONING', aiProfileId: 'p1',
      hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
    });

    // Exactly one bot exists.
    await pool.addToPool('onlybot', 'tok-1');
    mk('a', 'Tax Advisor');
    mk('b', 'Trip Planner');

    // A takes it.
    const first = await runProvisionSteps(deps as any, 'a');
    expect(first.agent.state).toBe('RUNNING');
    expect(store.getChannelForAgent('a')!.accountId).toBe('onlybot');

    // B can't have one — the pool is dry, so it parks on the human step
    // rather than failing.
    const blocked = await runProvisionSteps(deps as any, 'b');
    expect(blocked.setupRequired?.instructions).toMatch(/BotFather/i);
    expect(store.getChannelForAgent('b')).toBeUndefined();
    expect(store.getAgent('b')!.pendingAction?.type).toBe('bot_token');

    // Archive A: the bot goes back.
    await archiveAgent(deps as any, 'a');
    expect(store.getAgent('a')!.state).toBe('ARCHIVED');
    expect(pool.availableCount()).toBe(1);

    // Now B gets it, named for B.
    const second = await runProvisionSteps(deps as any, 'b');
    expect(second.agent.state).toBe('RUNNING');
    expect(store.getChannelForAgent('b')!.accountId).toBe('onlybot');

    // Restoring A must NOT take the bot back from B — it waits for a free one.
    store.setAgentState('a', 'PROVISIONING');
    const restoreDry = await runProvisionSteps(deps as any, 'a');
    expect(restoreDry.setupRequired?.instructions).toMatch(/BotFather/i);
    expect(store.getChannelForAgent('a')).toBeUndefined();      // A got nothing
    expect(store.getChannelForAgent('b')!.accountId).toBe('onlybot'); // B keeps it

    // Stock a second bot and A comes back on that one, memory and members intact.
    await pool.addToPool('secondbot', 'tok-2');
    const restored = await runProvisionSteps(deps as any, 'a');
    expect(restored.agent.state).toBe('RUNNING');
    expect(store.getChannelForAgent('a')!.accountId).toBe('secondbot');
    expect(store.getAgent('a')!.name).toBe('Tax Advisor');
  });
});
