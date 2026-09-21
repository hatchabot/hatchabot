import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { hashPassword } from '../src/api/accountsAuth.js';

/**
 * "Forgot password?" over Telegram. A reset link goes only to a Telegram id
 * already proven to be the person's, through a bot that has talked to them;
 * and the route answers identically whatever it finds, so it cannot be used to
 * learn who has an account.
 */
async function world() {
  const store = new Store(new Database(':memory:'));
  const sent: Array<{ chat: string; text: string }> = [];
  const { hash, salt } = await hashPassword('the-old-password');
  store.insertLocalAccount({ id: 'acct-chris', username: 'chris', pwHash: hash, pwSalt: salt, hostOwner: true, disabled: false, createdAt: 'now' } as never);
  store.insertLocalAccount({ id: 'acct-nobot', username: 'sam', pwHash: hash, pwSalt: salt, hostOwner: false, disabled: false, createdAt: 'now' } as never);
  store.insertHost({ id: 'h1', ownerId: 'acct-chris', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: 'acct-chris', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
  store.insertAgent({
    id: 'a1', ownerId: 'acct-chris', name: 'Hatchabot', slug: 'hatchabot', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
    persona: '', sharedMemory: false, ops: true, createdAt: 'now', updatedAt: 'now',
  } as never);
  store.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'managerbot', secretRef: 'chan/a1', deepLink: 'x', createdAt: 'now' } as never);
  store.insertMembership({ id: 'm0', agentId: 'a1', userId: 'acct-chris', role: 'owner', status: 'active' } as never);
  store.bindMembershipChannelUser('a1', 'acct-chris', '424242');
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: { put: async () => {}, get: async () => '123:bot-token', delete: async () => {} } as never,
    providers: new Map([['mock', new MockProvider()]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never,
    authMode: 'accounts',
    oauthFetch: (async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body); sent.push({ chat: String(b.chat_id), text: b.text });
      return new Response(JSON.stringify({ ok: true }));
    }) as never,
  } as never);
  const recover = (username: string) => f.inject({ method: 'POST', url: '/v1/local-accounts/recover', payload: { username } });
  return { store, sent, recover };
}

describe('forgot password, over Telegram', () => {
  it('sends a one-time link to the proven Telegram id, through a bot that knows them', async () => {
    const w = await world();
    const r = await w.recover('chris');
    expect(r.json()).toEqual({ ok: true });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.chat).toBe('424242');
    expect(w.sent[0]!.text).toMatch(/\/\?claim=[A-Za-z0-9_-]{20,}/);
    expect(w.sent[0]!.text).toMatch(/15 minutes/);
    // The old password is untouched until the link is used.
    expect(w.store.localAccountByUsername('chris')!.pwHash).not.toBe('');
  }, 10_000);

  it('answers identically for a stranger, an account with no Telegram, and a real one — and sends nothing', async () => {
    const w = await world();
    const unknown = await w.recover('nobody-at-all');
    const noTelegram = await w.recover('sam');
    expect(unknown.statusCode).toBe(200);
    expect(noTelegram.statusCode).toBe(200);
    expect(unknown.body).toBe(noTelegram.body);
    expect(w.sent).toHaveLength(0);
  }, 10_000);

  it('a username can ask at most once every few minutes', async () => {
    const w = await world();
    await w.recover('chris');
    await w.recover('chris');
    await w.recover('CHRIS');
    expect(w.sent).toHaveLength(1);
  }, 15_000);
});
