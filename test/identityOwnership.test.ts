import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { firstAccountAdoption } from '../src/api/signIn/firstAccount.js';
import { registerAuth } from '../src/api/signIn/auth.js';
import type { IdentityVerifier } from '../src/api/signIn/identity.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const log = { warn() {}, error() {} };
function setup() {
  const db = new Database(':memory:');
  databases.push(db);
  const store = new Store(db);
  store.insertHost({ id: 'local', ownerId: 'dev-owner', kind: 'local', provider: 'mock', name: 'Example machine', settings: {}, createdAt: 'now' });
  store.insertConnection({ id: 'leftover', ownerId: 'dev-owner', kind: 'google', email: 'connection@example.com', services: [], secretRef: 'example/connection' });
  store.insertAIProfile({ id: 'member-source', ownerId: 'user-member', name: 'Example source', vendor: 'anthropic', kind: 'api_key', model: 'example', secretRef: 'example/source', createdAt: '2020-01-01T00:00:00Z' });
  return { db, store };
}

describe('designated identity ownership (HB-0625)', () => {
  it('a verified browser cookie retries a failed hand-over and claims newly sent copies', async () => {
    const { store } = setup();
    const app = Fastify();
    let now = 0, attempts = 0;
    const original = store.adoptLocalOwnerData.bind(store);
    store.adoptLocalOwnerData = (...args) => {
      if (++attempts === 1) throw new Error('made-up temporary database failure');
      return original(...args);
    };
    const adopt = firstAccountAdoption(store, log, () => now, { identityOwner: () => store.identityInstallOwner('owner@example.com') });
    try {
      await registerAuth(app, { mode: 'identity', secret: Buffer.alloc(32, 4), store,
        verifier: { verify: async () => ({ sub: 'example-owner', email: 'owner@example.com', emailVerified: true, expMs: Date.now() + 60_000 }) } as unknown as IdentityVerifier,
        onAuthenticated: (p) => { store.recordAccount(p.ownerId, p.email); if (p.email) store.claimSharesForEmail(p.ownerId, p.email); adopt(p); },
      });
      app.get('/v1/example', async () => ({ ok: true }));
      const login = await app.inject({ method: 'POST', url: '/v1/session', payload: { idToken: 'synthetic-id' } });
      expect(login.statusCode).toBe(200);
      expect(store.localHostOwnerId()).toBe('dev-owner');
      store.insertShare({ id: 'waiting', fromOwner: 'user-sender', toEmail: 'owner@example.com', agentName: 'Example', blob: Buffer.from('example'), createdAt: 'now' });
      now = 60_000;
      const cookie = login.cookies.map(c => `${c.name}=${c.value}`).join('; ');
      expect((await app.inject({ url: '/v1/example', headers: { cookie } })).statusCode).toBe(200);
      expect(attempts).toBe(2);
      expect(store.localHostOwnerId()).toBe('user-example-owner');
      expect(store.getShareFor('waiting', 'user-example-owner')).toBeDefined();
    } finally { await app.close(); }
  });

  it('a member arriving first cannot take or pin the installation, even with earlier assets', () => {
    const { db, store } = setup();
    store.recordAccount('user-member', 'member@example.com');
    const adopt = firstAccountAdoption(store, log, Date.now, { identityOwner: () => store.identityInstallOwner('owner@example.com') });
    adopt({ ownerId: 'user-member', email: 'member@example.com' });
    expect(store.installOwner('identity')).toBe('dev-owner');
    expect(db.prepare('SELECT * FROM first_account').all()).toEqual([]);
    store.recordAccount('user-owner', 'OWNER@example.com');
    adopt({ ownerId: 'user-owner', email: 'OWNER@example.com' });
    expect(store.localHostOwnerId()).toBe('user-owner');
    expect(store.getAIProfile('member-source')!.ownerId).toBe('user-member');
    expect(db.prepare("SELECT owner_id FROM connections WHERE id = 'leftover'").get()).toEqual({ owner_id: 'user-owner' });
    expect(store.identityInstallOwner('member@example.com')).toBe('user-owner');
  });

  it('an email-shaped password username cannot satisfy the owner setting', () => {
    const { db, store } = setup();
    store.recordAccount('acct-example', 'owner@example.com');
    const adopt = firstAccountAdoption(store, log, Date.now, { identityOwner: () => store.identityInstallOwner('owner@example.com') });
    adopt({ ownerId: 'acct-example', email: 'owner@example.com' });
    expect(store.localHostOwnerId()).toBe('dev-owner');
    expect(db.prepare('SELECT * FROM first_account').all()).toEqual([]);
  });
});

describe('legacy owner leftovers (HB-0624)', () => {
  it.each(['completed pin', 'local host'])('repairs once using the %s despite a second identity account owning data', (evidence) => {
    const { db, store } = setup();
    if (evidence === 'completed pin') db.prepare("INSERT INTO first_account(id, owner_id, at, done_at) VALUES(1, 'user-owner', 'then', 'then')").run();
    else db.prepare("UPDATE hosts SET owner_id = 'user-owner' WHERE id = 'local'").run();
    // A database being upgraded has not run this versioned migration yet.
    db.prepare("DELETE FROM store_migrations WHERE name = 'legacy-owner-leftovers-v1'").run();
    new Store(db);
    expect(db.prepare("SELECT owner_id FROM connections WHERE id = 'leftover'").get()).toEqual({ owner_id: 'user-owner' });
    expect(store.getAIProfile('member-source')!.ownerId).toBe('user-member');
    store.insertConnection({ id: 'later', ownerId: 'dev-owner', kind: 'google', email: 'later@example.com', services: [], secretRef: 'example/later' });
    new Store(db);
    expect(db.prepare("SELECT owner_id FROM connections WHERE id = 'later'").get()).toEqual({ owner_id: 'dev-owner' });
  });

  it('does not guess an unknown legacy owner from the earliest source', () => {
    const { db } = setup();
    db.prepare("DELETE FROM store_migrations WHERE name = 'legacy-owner-leftovers-v1'").run();
    const upgraded = new Store(db);
    expect(upgraded.localHostOwnerId()).toBe('dev-owner');
    expect(db.prepare("SELECT owner_id FROM connections WHERE id = 'leftover'").get()).toEqual({ owner_id: 'dev-owner' });
    expect(db.prepare('SELECT * FROM first_account').all()).toEqual([]);
  });
});
