import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';

/**
 * Pair once, not once per agent. Adding a bot to an agent that had none must
 * seed the owner's known Telegram, exactly as creating an agent does — or the
 * owner meets a pairing code and a "That's me" card on their own agent.
 */
let n = 0;
async function world(ownerKnownOnAnotherAgent: boolean) {
  const ops = `hatchabot${++n}`;
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
  const mk = async (id: string, extra: object = {}) => {
    const { runtimeRef } = await provider.provision({ agentId: id, slug: id, workspace: { files: {}, configPatch: { agentId: id, authMode: 'api-key' } }, env: {} } as never);
    store.insertAgent({ id, ownerId: 'o', name: id, slug: id, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now', ...extra } as never);
    store.insertMembership({ id: `m-${id}`, agentId: id, userId: 'o', role: 'owner', status: 'active' } as never);
  };
  // The first agent: the owner already talked to it, so their id is known.
  await mk('first');
  if (ownerKnownOnAnotherAgent) store.bindMembershipChannelUser('first', 'o', '424242');
  // The Hatchabot agent: web-only, then given a bot.
  await mk(ops, { ops: true, webOnly: true });
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} } as never,
    providers: new Map([['mock', provider]]),
    channel: {
      kind: 'telegram',
      pool: { owns: () => true, availableCount: () => 1, list: () => [] },
      provision: async () => ({ accountId: 'managerbot', secretRef: 'pool/managerbot', deepLink: 'https://t.me/managerbot' }),
      syncDisplayName: async () => {},
      release: async () => {},
    } as never,
  } as never);
  const attach = () => f.inject({ method: 'POST', url: `/v1/agents/${ops}/telegram`, headers: { 'x-hatchabot-owner': 'o' }, payload: {} });
  return { store, attach, ops };
}

describe('adding a bot to an agent that had none', () => {
  it('seeds the owner’s known Telegram, so their first message is simply answered', async () => {
    const { store, attach, ops } = await world(true);
    const r = await attach();
    expect(r.statusCode).toBe(202);
    expect(r.json().ownerKnown).toBe(true);
    expect(store.getMembership(ops, 'o')!.channelUserId).toBe('424242');
    expect(store.listAllowedChannelUserIds(ops)).toEqual(['424242']); // the rebuild writes this
  });

  it('with nobody known yet, says so — the claim window takes the first message instead', async () => {
    const { store, attach, ops } = await world(false);
    const r = await attach();
    expect(r.statusCode).toBe(202);
    expect(r.json().ownerKnown).toBe(false);
    expect(store.getMembership(ops, 'o')!.channelUserId).toBeFalsy();
  });
});
