import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { TelegramPoolProvisioner } from '../src/channels/telegramPool.js';
import { CompositeTelegramProvisioner } from '../src/channels/composite.js';
import { TelegramManualProvisioner } from '../src/channels/telegramManual.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import { makeWorld, as } from './support/world.js';

/**
 * "Own bots only" (Settings → Messaging → Telegram, 2026-10-23): a person who never wants
 * one of their agents on a shared house bot. The pool then offers only the
 * bots they parked themselves, and the ready count says so.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error(`missing ${r}`); return v; }
  async delete(r: string) { this.map.delete(r); }
}

/** A pool whose Telegram calls never leave the process (the rename is best-effort anyway). */
function pool() {
  const db = new Database(':memory:');
  new Store(db); // creates telegram_pool
  const fetchImpl = (async () => new Response('{"ok":true,"result":{}}', { status: 200 })) as unknown as typeof fetch;
  return new TelegramPoolProvisioner(db, new MemSecrets(), { fetchImpl });
}

describe('TelegramPoolProvisioner with ownBotsOnly', () => {
  it('counts and leases only the person\'s own bots; shared house bots stay for others', async () => {
    const p = pool();
    await p.addToPool('housebot', 'tok-house', null);
    await p.addToPool('minebot', 'tok-mine', 'alice');
    expect(p.availableCount('alice')).toBe(2);
    expect(p.availableCount('alice', true)).toBe(1);
    expect(p.availableCount('bob', true)).toBe(0);
    const ch = await p.provision({ agentId: 'a1', agentName: 'Mine', slug: 'mine', ownerId: 'alice', ownBotsOnly: true });
    expect(ch.accountId).toBe('minebot');
    // Her own is leased now: with the choice on, nothing is left for her second agent…
    await expect(p.provision({ agentId: 'a2', agentName: 'Second', slug: 'second', ownerId: 'alice', ownBotsOnly: true })).rejects.toThrow();
    // …while the house bot is still there for anyone who allows one.
    expect((await p.provision({ agentId: 'a3', agentName: 'Third', slug: 'third', ownerId: 'alice' })).accountId).toBe('housebot');
  });

  it('without the choice, own bots still go first and the house bot is the fallback', async () => {
    const p = pool();
    await p.addToPool('housebot', 'tok-house', null);
    await p.addToPool('minebot', 'tok-mine', 'alice');
    expect((await p.provision({ agentId: 'a1', agentName: 'One', slug: 'one', ownerId: 'alice' })).accountId).toBe('minebot');
    expect((await p.provision({ agentId: 'a2', agentName: 'Two', slug: 'two', ownerId: 'alice' })).accountId).toBe('housebot');
  });
});

describe('PATCH /v1/account/prefs', () => {
  it('stores the choice per person, and /v1/account reports it', async () => {
    const w = await makeWorld();
    expect((await w.f.inject({ method: 'GET', url: '/v1/account', headers: as() })).json().prefs).toEqual({ ownBotsOnly: false });
    const set = await w.f.inject({ method: 'PATCH', url: '/v1/account/prefs', headers: as(), payload: { ownBotsOnly: true } });
    expect(set.statusCode).toBe(200);
    expect(set.json().prefs).toEqual({ ownBotsOnly: true });
    expect(typeof set.json().availableBots).toBe('number');
    expect((await w.f.inject({ method: 'GET', url: '/v1/account', headers: as() })).json().prefs.ownBotsOnly).toBe(true);
    // Someone else's account is untouched.
    expect((await w.f.inject({ method: 'GET', url: '/v1/account', headers: as('someone-else') })).json().prefs.ownBotsOnly).toBe(false);
    // Off again clears the row.
    await w.f.inject({ method: 'PATCH', url: '/v1/account/prefs', headers: as(), payload: { ownBotsOnly: false } });
    expect(w.store.ownerPrefs(w.owner).ownBotsOnly).toBe(false);
    expect(w.store.getOwnerPref(w.owner, 'ownBotsOnly')).toBeUndefined();
  });

  it('refuses a key it does not know and a non-boolean', async () => {
    const w = await makeWorld();
    expect((await w.f.inject({ method: 'PATCH', url: '/v1/account/prefs', headers: as(), payload: { theme: 'dark' } })).statusCode).toBe(400);
    expect((await w.f.inject({ method: 'PATCH', url: '/v1/account/prefs', headers: as(), payload: { ownBotsOnly: 'yes' } })).statusCode).toBe(400);
  });
});

describe('own bots only, when a bot is added or changed on an existing agent (HB-0994)', () => {
  /**
   * The owner's own spare was renamed a moment ago (Telegram will not rename it
   * again for hours), a house bot was not: the pool would rather pick the one
   * it can rename, and only the choice keeps the house bot out.
   */
  async function routes(opts: { onBot?: boolean } = {}) {
    const db = new Database(':memory:');
    const store = new Store(db);
    const secrets = new MemSecrets();
    const fetchImpl = (async () => new Response('{"ok":true,"result":{}}', { status: 200 })) as unknown as typeof fetch;
    const p = new TelegramPoolProvisioner(db, secrets, { fetchImpl, renameBackoffMs: [] });
    const channel = new CompositeTelegramProvisioner(p, new TelegramManualProvisioner(secrets));
    store.insertHost({ id: 'h1', ownerId: 'alice', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: 'alice', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' });
    store.insertAgent({
      id: 'a1', ownerId: 'alice', name: 'Helper', slug: 'helper', state: 'STOPPED', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'mock://a1',
      persona: '', sharedMemory: true, webOnly: !opts.onBot, createdAt: 'now', updatedAt: 'now',
    } as never);
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'alice', role: 'owner', status: 'active' });
    store.bindMembershipChannelUser('a1', 'alice', '12345');
    if (opts.onBot) {
      await p.addToPool('oldbot', 'tok-old', 'alice');
      const leased = await p.provision({ agentId: 'a1', agentName: 'Helper', slug: 'helper', ownerId: 'alice' });
      store.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: leased.accountId, secretRef: leased.secretRef, deepLink: 'https://t.me/oldbot', createdAt: 'now' });
    }
    await p.addToPool('minebot', 'tok-mine', 'alice');
    await p.addToPool('housebot', 'tok-house', null);
    db.prepare('UPDATE telegram_pool SET rename_after = ? WHERE username = ?').run('2099-01-01T00:00:00.000Z', 'minebot');
    const f = Fastify();
    await registerRoutes(f, { store, secrets: secrets as never, providers: new Map([['mock', new MockProvider()]]), channel } as never);
    const inject = (method: string, url: string, payload?: unknown) =>
      f.inject({ method: method as never, url, headers: { 'x-hatchabot-owner': 'alice' }, payload: payload as never });
    return { store, f, inject };
  }

  it('adding Telegram takes the owner\'s own bot, not the house bot', async () => {
    const w = await routes();
    try {
      w.store.setOwnerPref('alice', 'ownBotsOnly', '1');
      const r = await w.inject('POST', '/v1/agents/a1/telegram', {});
      expect(r.statusCode, r.body).toBe(202);
      expect(r.json().username).toBe('minebot');
    } finally { await w.f.close(); }
  });

  it('Change bot moves to the owner\'s own bot, not the house bot', async () => {
    const w = await routes({ onBot: true });
    try {
      w.store.setOwnerPref('alice', 'ownBotsOnly', '1');
      const r = await w.inject('POST', '/v1/agents/a1/channel/swap', {});
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ from: 'oldbot', to: 'minebot' });
    } finally { await w.f.close(); }
  });

  it('without the choice the fresher-to-rename house bot may still be taken, as before', async () => {
    const w = await routes();
    try {
      const r = await w.inject('POST', '/v1/agents/a1/telegram', {});
      expect(r.statusCode, r.body).toBe(202);
      expect(r.json().username).toBe('housebot');
    } finally { await w.f.close(); }
  });
});
