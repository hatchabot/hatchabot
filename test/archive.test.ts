import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { TelegramPoolProvisioner } from '../src/channels/telegramPool.js';
import { CompositeTelegramProvisioner } from '../src/channels/composite.js';
import { TelegramManualProvisioner } from '../src/channels/telegramManual.js';
import { archiveAgent } from '../src/orchestrator/archive.js';
import { canTransition } from '../src/domain/stateMachine.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * Archiving exists for one reason: Telegram caps how many bots an account may
 * own, so a parked agent holding a token is pure waste. These cover what has to
 * be true for that trade to be safe — the bot really is reusable afterwards,
 * the people mid-conversation are told, and nothing else about the agent moves.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error(`missing ${r}`); return v; }
  async delete(r: string) { this.map.delete(r); }
}

async function world(opts: { pasted?: boolean } = {}) {
  const calls: Array<{ method: string; body: any }> = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ method: String(url).split('/').pop()!, body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response('{"ok":true,"result":{"username":"pastedbot"}}', {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const db = new Database(':memory:');
  const store = new Store(db);
  const secrets = new MemSecrets();
  const provider = new MockProvider();
  const pool = new TelegramPoolProvisioner(db, secrets, { fetchImpl });
  const channel = new CompositeTelegramProvisioner(pool, new TelegramManualProvisioner(secrets));

  store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAgent({
    id: 'a1', ownerId: 'o', name: 'Tax Advisor', slug: 'tax', state: 'PROVISIONING',
    aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
  });
  const { runtimeRef } = await provider.provision({
    agentId: 'a1', slug: 'tax',
    workspace: { files: {}, configPatch: { agentId: 'tax', authMode: 'api-key' } },
    env: {},
  });
  await provider.start(runtimeRef);
  store.setAgentRuntimeRef('a1', runtimeRef);
  store.setAgentState('a1', 'RUNNING');

  // Its bot: leased from the pool, or a token the owner pasted themselves.
  let accountId: string, secretRef: string;
  if (opts.pasted) {
    accountId = 'pastedbot';
    secretRef = `telegram/bot/${accountId}`;
    await secrets.put(secretRef, 'user-token');
  } else {
    await pool.addToPool('poolbot', 'pool-token');
    const ch = await pool.provision({ agentId: 'a1', agentName: 'Tax Advisor', slug: 'tax' });
    accountId = ch.accountId;
    secretRef = ch.secretRef;
  }
  store.insertChannel({
    id: 'c1', agentId: 'a1', kind: 'telegram', accountId, secretRef,
    deepLink: `https://t.me/${accountId}`, createdAt: 'now',
  });
  // Someone mid-conversation.
  store.insertMembership({
    id: 'm1', agentId: 'a1', userId: 'telegram:900', role: 'user',
    channelUserId: '900', status: 'active', joinedAt: 'now',
  });
  calls.length = 0;

  const deps = { store, secrets, provider, channel, log: () => {} };
  return { store, secrets, provider, pool, channel, calls, deps, runtimeRef };
}

describe('archiving frees the bot and keeps the agent', () => {
  it('stops the runtime, returns the bot to the pool, and drops the channel', async () => {
    const { store, provider, pool, deps, runtimeRef } = await world();
    await archiveAgent(deps as any, 'a1');

    const a = store.getAgent('a1')!;
    expect(a.state).toBe('ARCHIVED');
    expect((await provider.status(runtimeRef)).phase).toBe('stopped'); // container kept, not destroyed
    expect(a.runtimeRef).toBe(runtimeRef); //  ...and still ours on restore
    expect(store.getChannelForAgent('a1')).toBeUndefined();
    expect(pool.availableCount()).toBe(1); // the whole point: leasable again
  });

  it('tells the members while the bot still wears the agent\'s name', async () => {
    const { calls, deps } = await world();
    await archiveAgent(deps as any, 'a1');

    const sent = calls.filter((c) => c.method === 'sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.chat_id).toBe('900');
    // The archived wording must differ from the deleted one: nothing is lost,
    // and the return will be on a different bot.
    expect(sent[0]!.body.text).toMatch(/archived/i);
    expect(sent[0]!.body.text).toMatch(/new bot|NEW bot/);
    expect(sent[0]!.body.text).not.toMatch(/removed/i);
    // No rename is spent here at all — the idle name is parked for later, so a
    // restore can reuse the bot without burning Telegram's rename quota. That
    // also means the goodbye necessarily goes out under the agent's own name.
    expect(calls.filter((c) => c.method === 'setMyName')).toHaveLength(0);
  });

  it('keeps memory, members and settings — only the chat address goes', async () => {
    const { store, deps } = await world();
    await archiveAgent(deps as any, 'a1');
    const a = store.getAgent('a1')!;
    expect(a.name).toBe('Tax Advisor');
    expect(store.listMemberships('a1')).toHaveLength(1);
    // Telegram user ids are global, not per-bot, so the allowlist survives the
    // bot change and nobody has to pair again on restore.
    expect(store.listAllowedChannelUserIds('a1')).toContain('900');
  });

  it('parks a PASTED token in the pool so it is reusable too', async () => {
    // A hand-minted bot is just as scarce — it burns the same BotFather slot.
    const { pool, deps, calls } = await world({ pasted: true });
    await archiveAgent(deps as any, 'a1');
    expect(pool.owns('pastedbot')).toBe(true);
    expect(pool.availableCount()).toBe(1);
    // And its members still get the goodbye, even though the row it was just
    // added under was never leased — the regression this path used to have.
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
  });

  it('drops a parked "paste a bot token" step instead of taking it along', async () => {
    // Otherwise the archived card asks for a token for an agent that isn't
    // running, and the fleet's needs-attention count never comes down.
    const { store, deps } = await world();
    store.setAgentPendingAction('a1', { type: 'bot_token', instructions: 'x' } as any);
    await archiveAgent(deps as any, 'a1');
    expect(store.getAgent('a1')!.pendingAction).toBeFalsy();
  });

  it('is idempotent — a second archive is not an error', async () => {
    const { store, deps } = await world();
    await archiveAgent(deps as any, 'a1');
    await archiveAgent(deps as any, 'a1');
    expect(store.getAgent('a1')!.state).toBe('ARCHIVED');
  });

  it('expires outstanding invites, which point at a bot that is gone', async () => {
    const { store, deps } = await world();
    store.insertInvite({
      id: 'i1', agentId: 'a1', code: 'abc', role: 'user', createdBy: 'o',
      createdAt: 'now', expiresAt: new Date(Date.now() + 8.64e7).toISOString(),
    });
    await archiveAgent(deps as any, 'a1');
    // Redeeming it would mint a membership on an agent with no bot to talk to.
    expect(store.getInviteByCode('abc')!.redeemedAt).toBeTruthy();
  });
});

describe('the archived state is a resting state, not a broken one', () => {
  it('can be restored or deleted, but not started or rebuilt', () => {
    expect(canTransition('ARCHIVED', 'PROVISIONING')).toBe(true); // Restore
    expect(canTransition('ARCHIVED', 'DELETING')).toBe(true);
    expect(canTransition('ARCHIVED', 'RUNNING')).toBe(false); // no bot to run with
    expect(canTransition('ARCHIVED', 'REBUILDING')).toBe(false);
  });

  it('can be reached from a FAILED agent — a broken one still holds a token', () => {
    expect(canTransition('FAILED', 'ARCHIVED')).toBe(true);
    expect(canTransition('RUNNING', 'ARCHIVED')).toBe(true);
    expect(canTransition('STOPPED', 'ARCHIVED')).toBe(true);
  });
});
