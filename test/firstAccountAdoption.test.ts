import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { ADOPTION_RETRY_MAX_MS, ADOPTION_RETRY_MS, firstAccountAdoption } from '../src/api/firstAccount.js';
import { TelegramPoolProvisioner } from '../src/channels/telegramPool.js';

const pins = (db: Database.Database) => (db.prepare(`SELECT owner_id FROM first_account`).all() as Array<{ owner_id: string }>).map((r) => r.owner_id);

/**
 * The deep audit of v2.177.0 (2026-11-07), HB-0548: a first-account adoption
 * that failed once (a database error) was never tried again until a restart,
 * so the owner saw an empty installation.
 */
describe('the first account\'s adoption is tried again after a failure (HB-0548)', () => {
  function setup() {
    const db = new Database(':memory:');
    const store = new Store(db);
    store.insertAgent({ id: 'agent-test', ownerId: 'dev-owner', name: 'Example', slug: 'example', state: 'STOPPED', aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    const logged: Array<{ level: string; msg: string; detail: Record<string, unknown> }> = [];
    const log = {
      warn: (detail: object, msg: string) => { logged.push({ level: 'warn', msg, detail: detail as Record<string, unknown> }); },
      error: (detail: object, msg: string) => { logged.push({ level: 'error', msg, detail: detail as Record<string, unknown> }); },
    };
    let clock = 1_000_000;
    const adopt = firstAccountAdoption(store, log, () => clock);
    const fail = () => db.exec(`CREATE TRIGGER made_up_failure BEFORE UPDATE OF owner_id ON agents BEGIN SELECT RAISE(ABORT, 'made-up transient failure'); END`);
    const heal = () => db.exec('DROP TRIGGER made_up_failure');
    return { db, store, logged, log, adopt, fail, heal, now: () => clock, tick: (ms: number) => { clock += ms; } };
  }

  it('a failed attempt is logged, does not fail the request, and a later request adopts', () => {
    const { db, store, logged, adopt, tick } = setup();
    db.exec(`CREATE TRIGGER made_up_failure BEFORE UPDATE OF owner_id ON agents BEGIN SELECT RAISE(ABORT, 'made-up transient failure'); END`);
    expect(() => adopt({ ownerId: 'account-test' })).not.toThrow();
    expect(store.getAgent('agent-test')!.ownerId).toBe('dev-owner');
    expect(logged.map((l) => l.level)).toEqual(['error']);

    db.exec('DROP TRIGGER made_up_failure');
    // Not on every request while it is failing: after a pause.
    adopt({ ownerId: 'account-test' });
    expect(store.getAgent('agent-test')!.ownerId).toBe('dev-owner');
    tick(ADOPTION_RETRY_MS);
    adopt({ ownerId: 'account-test' });
    expect(store.getAgent('agent-test')!.ownerId).toBe('account-test');
    expect(logged.at(-1)).toMatchObject({ level: 'warn', msg: 'adopted this installation\'s data into the first signed-in account' });
  });

  it('dev-owner never adopts, and once done it is not tried again', () => {
    const { store, adopt } = setup();
    let calls = 0;
    const counted = firstAccountAdoption({
      adoptLocalOwnerData: (id, local, opts) => { calls++; return store.adoptLocalOwnerData(id, local, opts); },
      pinFirstAccount: (id) => store.pinFirstAccount(id),
      localOwnerHasData: () => store.localOwnerHasData(),
      localOwnerHasAnything: () => store.localOwnerHasAnything(),
      mayTakeOverInstall: (id) => store.mayTakeOverInstall(id),
      accountExists: (id) => store.accountExists(id),
    }, { warn() {}, error() {} });
    counted({ ownerId: 'dev-owner' });
    expect(calls).toBe(0);
    counted({ ownerId: 'account-test' });
    counted({ ownerId: 'account-test' });
    expect(calls).toBe(1);
    expect(store.getAgent('agent-test')!.ownerId).toBe('account-test');
    adopt({ ownerId: 'someone-else' });
    expect(store.getAgent('agent-test')!.ownerId).toBe('account-test');
  });

  // The review of the HB-0548 fix: a retry ran for whichever account asked
  // next, so a member signing in during the wait took the owner's agents.
  it('a retry is only for the account that tried first, across a restart too', () => {
    const { store, log, adopt, fail, heal, now, tick } = setup();
    fail();
    adopt({ ownerId: 'account-owner' });
    heal();
    tick(ADOPTION_RETRY_MS);
    adopt({ ownerId: 'account-member' });
    expect(store.getAgent('agent-test')!.ownerId).toBe('dev-owner');

    // A restart: a fresh latch, and the member happens to ask first.
    const restarted = firstAccountAdoption(store, log, now);
    restarted({ ownerId: 'account-member' });
    expect(store.getAgent('agent-test')!.ownerId).toBe('dev-owner');
    restarted({ ownerId: 'account-owner' });
    expect(store.getAgent('agent-test')!.ownerId).toBe('account-owner');
  });

  it('a pin the store could not read is not held in memory: the stored account\'s requests are served', () => {
    const { store } = setup();
    store.pinFirstAccount('account-owner'); // stored by an earlier run
    let pinFails = true;
    let clock = 0;
    const adopt = firstAccountAdoption({
      adoptLocalOwnerData: (id, local, opts) => store.adoptLocalOwnerData(id, local, opts),
      pinFirstAccount: (id) => { if (pinFails) throw new Error('made-up locked database'); return store.pinFirstAccount(id); },
      localOwnerHasData: () => store.localOwnerHasData(),
      localOwnerHasAnything: () => store.localOwnerHasAnything(),
      mayTakeOverInstall: (id) => store.mayTakeOverInstall(id),
      accountExists: (id) => store.accountExists(id),
    }, { warn() {}, error() {} }, () => clock);
    adopt({ ownerId: 'account-other' }); // the store is busy: nothing is decided
    pinFails = false;
    clock += ADOPTION_RETRY_MS;
    adopt({ ownerId: 'account-owner' });
    expect(store.getAgent('agent-test')!.ownerId).toBe('account-owner');
  });

  it('what an account made while the store could not save its pin does not stop it, across a restart too', () => {
    const { store, log } = setup();
    const adopt = firstAccountAdoption({
      adoptLocalOwnerData: (id, local, opts) => store.adoptLocalOwnerData(id, local, opts),
      pinFirstAccount: () => { throw new Error('made-up locked database'); },
      localOwnerHasData: () => store.localOwnerHasData(),
      localOwnerHasAnything: () => store.localOwnerHasAnything(),
      mayTakeOverInstall: (id) => store.mayTakeOverInstall(id),
      accountExists: (id) => store.accountExists(id),
    }, { warn() {}, error() {} }, () => 0);
    adopt({ ownerId: 'account-owner' });
    store.insertAgent({ id: 'agent-made-meanwhile', ownerId: 'account-owner', name: 'Meanwhile', slug: 'meanwhile', state: 'RUNNING', aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    // A restart: nothing of the failed try is left in memory.
    firstAccountAdoption(store, log, () => 0)({ ownerId: 'account-owner' });
    expect(store.getAgent('agent-test')!.ownerId).toBe('account-owner');
  });

  it('backs off from 30 seconds to an hour, says what to do, and logs an error only the first time', () => {
    const { store, logged, adopt, fail, tick } = setup();
    fail();
    const waits: number[] = [];
    for (let i = 0; i < 9; i++) {
      adopt({ ownerId: 'account-owner' });
      const wait = (logged.at(-1)!.detail.retryInSeconds as number) * 1000;
      waits.push(wait);
      tick(wait - 1);
      const before = logged.length;
      adopt({ ownerId: 'account-owner' });
      expect(logged.length).toBe(before); // not yet
      tick(1);
    }
    expect(waits).toEqual([30, 60, 120, 240, 480, 960, 1920, 3600, 3600].map((s) => s * 1000));
    expect(ADOPTION_RETRY_MAX_MS).toBe(3_600_000);
    expect(logged.map((l) => l.level)).toEqual(['error', ...Array(8).fill('warn')]);
    expect(logged[0]!.msg).toMatch(/restart Hatchabot/);
    expect(store.getAgent('agent-test')!.ownerId).toBe('dev-owner');
  });

  // The second review: a source or agent the owner made during the wait read
  // as "adopted already", so the retry took nothing and stopped for good.
  it('what the owner made during the wait does not stop the retry', () => {
    const { store, adopt, fail, heal, tick } = setup();
    fail();
    adopt({ ownerId: 'account-owner' });
    heal();
    store.insertAIProfile({ id: 'p-made-meanwhile', ownerId: 'account-owner', name: 'Mine', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/x', createdAt: 'now' });
    tick(ADOPTION_RETRY_MS);
    adopt({ ownerId: 'account-owner' });
    expect(store.getAgent('agent-test')!.ownerId).toBe('account-owner');
  });

  it('in accounts mode a member who signs in first is not pinned; the host owner is', () => {
    const { db, store, adopt } = setup();
    store.insertLocalAccount({ id: 'acct-owner', username: 'owner', pwHash: 'h', pwSalt: 's', hostOwner: true, disabled: false, createdAt: 'now' });
    store.insertLocalAccount({ id: 'acct-member', username: 'member', pwHash: 'h', pwSalt: 's', hostOwner: false, disabled: false, createdAt: 'now' });
    adopt({ ownerId: 'acct-member' });
    expect(pins(db)).toEqual([]);
    expect(store.getAgent('agent-test')!.ownerId).toBe('dev-owner');
    adopt({ ownerId: 'acct-owner' });
    expect(store.getAgent('agent-test')!.ownerId).toBe('acct-owner');
    // Handed over whole: the pin is marked done.
    expect(db.prepare(`SELECT owner_id, done_at IS NOT NULL AS done FROM first_account`).all()).toEqual([{ owner_id: 'acct-owner', done: 1 }]);
  });

  // Tenth review: what a member made meanwhile does not end the owner's hand-over.
  it('a member who signs in first and adds a source does not stop the owner getting the fleet', () => {
    const { db, store, adopt } = setup();
    store.insertLocalAccount({ id: 'acct-owner', username: 'owner', pwHash: 'h', pwSalt: 's', hostOwner: true, disabled: false, createdAt: 'now' });
    store.insertLocalAccount({ id: 'acct-member', username: 'member', pwHash: 'h', pwSalt: 's', hostOwner: false, disabled: false, createdAt: 'now' });
    adopt({ ownerId: 'acct-member' });
    store.insertAIProfile({ id: 'p-member', ownerId: 'acct-member', name: 'Mine', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p-member', createdAt: 'now' });
    adopt({ ownerId: 'acct-owner' });
    expect(store.getAgent('agent-test')!.ownerId).toBe('acct-owner');
    expect(pins(db)).toEqual(['acct-owner']);
    expect(store.listAIProfiles('acct-member').map((p) => p.id)).toContain('p-member');
  });

  it('nothing is pinned on an install that handed its data over long ago', () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    store.insertAgent({ id: 'agent-test', ownerId: 'acct-long-ago', name: 'Example', slug: 'example', state: 'STOPPED', aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    firstAccountAdoption(store, { warn() {}, error() {} })({ ownerId: 'acct-member' });
    expect(pins(db)).toEqual([]);
    expect(store.getAgent('agent-test')!.ownerId).toBe('acct-long-ago');
  });

  it('another account skipped for the pin is logged once, at warn; how to release it only when the held account is gone', () => {
    const { store, logged, adopt, fail, tick } = setup();
    store.recordAccount('account-owner');
    fail();
    adopt({ ownerId: 'account-owner' });
    tick(ADOPTION_RETRY_MS);
    adopt({ ownerId: 'account-other' });
    adopt({ ownerId: 'account-other' });
    const skipped = logged.filter((l) => /held for the account that signed in first/.test(l.msg));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.level).toBe('warn');
    expect(skipped[0]!.msg).toMatch(/takes it at its next sign-in/);
    expect(skipped[0]!.msg).not.toMatch(/DELETE FROM first_account/);

    // The held account was removed: now the way out is given.
    const { store: s2, logged: l2, adopt: a2, fail: f2, tick: t2 } = setup();
    f2();
    a2({ ownerId: 'account-owner' });
    t2(ADOPTION_RETRY_MS);
    a2({ ownerId: 'account-other' });
    expect(s2.accountExists('account-owner')).toBe(false);
    expect(l2.find((l) => /held for the account/.test(l.msg))!.msg).toMatch(/no longer exists.*DELETE FROM first_account.*restart Hatchabot/);
  });

  it('a store that cannot say whether the held account exists does not push back its retry', () => {
    const { store, logged, fail, heal } = setup();
    let clock = 0;
    const adopt = firstAccountAdoption({
      adoptLocalOwnerData: (id, local, opts) => store.adoptLocalOwnerData(id, local, opts),
      pinFirstAccount: (id) => store.pinFirstAccount(id),
      localOwnerHasData: () => store.localOwnerHasData(),
      localOwnerHasAnything: () => store.localOwnerHasAnything(),
      mayTakeOverInstall: (id) => store.mayTakeOverInstall(id),
      accountExists: () => { throw new Error('SQLITE_BUSY: made up'); },
    }, { warn: (d, msg) => { logged.push({ level: 'warn', msg, detail: d as Record<string, unknown> }); }, error: (d, msg) => { logged.push({ level: 'error', msg, detail: d as Record<string, unknown> }); } }, () => clock);
    fail();
    adopt({ ownerId: 'account-owner' }); // pinned; the hand-over fails once
    heal();
    clock += ADOPTION_RETRY_MS;
    adopt({ ownerId: 'account-other' }); // skipped: the line, without advice, and no failure
    expect(logged.filter((l) => l.level === 'error')).toHaveLength(1);
    expect(logged.find((l) => /held for the account/.test(l.msg))!.msg).not.toMatch(/DELETE|next sign-in/);
    adopt({ ownerId: 'account-owner' }); // not held back by the other's request
    expect(store.getAgent('agent-test')!.ownerId).toBe('account-owner');
  });

  it('a member who signs in while the data is held for the owner is told nothing', () => {
    const { store, logged, adopt, fail, tick } = setup();
    store.insertLocalAccount({ id: 'acct-host', username: 'host', pwHash: 'h', pwSalt: 's', hostOwner: true, disabled: false, createdAt: 'now' });
    store.insertLocalAccount({ id: 'acct-member', username: 'member', pwHash: 'h', pwSalt: 's', hostOwner: false, disabled: false, createdAt: 'now' });
    fail();
    adopt({ ownerId: 'acct-host' });
    tick(ADOPTION_RETRY_MS);
    adopt({ ownerId: 'acct-member' });
    expect(logged.filter((l) => /held for the account/.test(l.msg))).toEqual([]);
  });

  // The third review.
  it('after a full hand-over, a later dev-owner agent goes to nobody across a restart', () => {
    const { store, log, adopt, now } = setup();
    adopt({ ownerId: 'account-owner' });
    expect(store.getAgent('agent-test')!.ownerId).toBe('account-owner');
    store.insertAgent({ id: 'agent-later', ownerId: 'dev-owner', name: 'Later', slug: 'later', state: 'STOPPED', aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    const restarted = firstAccountAdoption(store, log, now);
    restarted({ ownerId: 'account-other' });
    restarted({ ownerId: 'account-owner' });
    expect(store.getAgent('agent-later')!.ownerId).toBe('dev-owner');
  });

  it('a busy database when looking at what stayed is asked again on the next request, not a failed request', () => {
    const { store } = setup();
    let busy = 0;
    const adopt = firstAccountAdoption({
      adoptLocalOwnerData: (id, local, opts) => store.adoptLocalOwnerData(id, local, opts),
      pinFirstAccount: (id) => store.pinFirstAccount(id),
      localOwnerHasData: () => { if (store.getAgent('agent-test')!.ownerId !== 'dev-owner' && busy++ === 0) throw new Error('SQLITE_BUSY: made up'); return store.localOwnerHasData(); },
      localOwnerHasAnything: () => store.localOwnerHasAnything(),
      mayTakeOverInstall: (id) => store.mayTakeOverInstall(id),
      accountExists: (id) => store.accountExists(id),
    }, { warn() {}, error() {} }, () => 0);
    expect(() => adopt({ ownerId: 'account-owner' })).not.toThrow();
    expect(store.getAgent('agent-test')!.ownerId).toBe('account-owner');
    expect(() => adopt({ ownerId: 'account-owner' })).not.toThrow();
    expect(busy).toBe(2);
  });

  it('a member is asked about once, and nothing else is looked up for them', () => {
    const { store } = setup();
    store.insertLocalAccount({ id: 'acct-member', username: 'member', pwHash: 'h', pwSalt: 's', hostOwner: false, disabled: false, createdAt: 'now' });
    const calls: string[] = [];
    const adopt = firstAccountAdoption({
      adoptLocalOwnerData: (id, local, opts) => { calls.push('adopt'); return store.adoptLocalOwnerData(id, local, opts); },
      pinFirstAccount: (id) => { calls.push('pin'); return store.pinFirstAccount(id); },
      localOwnerHasData: () => { calls.push('hasData'); return store.localOwnerHasData(); },
      localOwnerHasAnything: () => store.localOwnerHasAnything(),
      mayTakeOverInstall: (id) => { calls.push('may'); return store.mayTakeOverInstall(id); },
      accountExists: (id) => { calls.push('exists'); return store.accountExists(id); },
    }, { warn() {}, error() {} }, () => 0);
    for (let i = 0; i < 3; i++) adopt({ ownerId: 'acct-member' });
    expect(calls).toEqual(['may']);
  });
});

// Sixteenth review: the hand-over was skipped whenever the old owner had no
// live agent, source or host, so its connections and spare bots stayed
// orphaned for good.
describe('the hand-over counts everything it moves', () => {
  it('only a Google connection and a spare pool bot left under the old owner: the first account takes both', async () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    store.insertAgent({ id: 'agent-gone', ownerId: 'dev-owner', name: 'Example', slug: 'example', state: 'DELETED', aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    store.insertConnection({ id: 'conn-left', ownerId: 'dev-owner', kind: 'google', email: 'person@example.org', services: ['gmail'], secretRef: 'connection/conn-left' });
    const held = new Map<string, string>();
    const pool = new TelegramPoolProvisioner(db, { put: async (r: string, v: string) => { held.set(r, v); }, get: async (r: string) => held.get(r) ?? '', delete: async (r: string) => { held.delete(r); } } as never);
    await pool.addToPool('made_up_spare_bot', 'not-a-real-token', 'dev-owner');
    expect(store.localOwnerHasData()).toBe(false);
    expect(store.localOwnerHasAnything()).toBe(true);

    firstAccountAdoption(store, { warn() {}, error() {} })({ ownerId: 'account-test' });
    expect(store.getConnection('conn-left')!.ownerId).toBe('account-test');
    expect((db.prepare(`SELECT owner_id FROM telegram_pool WHERE username = ?`).get('made_up_spare_bot') as { owner_id: string }).owner_id).toBe('account-test');
    expect(store.localOwnerHasAnything()).toBe(false);
    expect(pins(db)).toEqual(['account-test']);
  });
});
