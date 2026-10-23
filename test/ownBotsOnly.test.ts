import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { TelegramPoolProvisioner } from '../src/channels/telegramPool.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import { makeWorld, as } from './support/world.js';

/**
 * "Own bots only" (Settings → Telegram, 2026-10-23): a person who never wants
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
