import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { OWNER_COLUMNS, Store } from '../src/store/store.js';
import { TelegramPoolProvisioner } from '../src/channels/telegramPool.js';

/**
 * The deep audit of v2.177.0 (2026-11-07): what the first account takes over
 * from password mode (HB-0545), and the gateway port range (HB-0554).
 */

const makeAgent = (store: Store, id: string, ownerId: string, state: 'RUNNING' | 'DELETED' = 'RUNNING') => store.insertAgent({
  id, ownerId, name: id, slug: id, state, aiProfileId: 'p', hostId: 'h',
  persona: '', sharedMemory: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
});

function fullSchema(): { db: Database.Database; store: Store } {
  const db = new Database(':memory:');
  const store = new Store(db);
  // The pool's table is made by the pool module, not the store.
  new TelegramPoolProvisioner(db, { get: async () => undefined, put: async () => {}, delete: async () => {} } as any);
  return { db, store };
}

describe('the first account takes over everything password mode owned (HB-0545)', () => {
  it('every column of the schema that holds an owner id is in OWNER_COLUMNS, and every entry is in the schema', () => {
    const { db } = fullSchema();
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((t) => t.name);
    const inSchema = tables.flatMap((t) => (db.prepare(`PRAGMA table_info("${t}")`).all() as Array<{ name: string }>).map((c) => `${t}.${c.name}`));
    const listed = new Set(OWNER_COLUMNS.map((c) => `${c.table}.${c.column}`));
    const ownerShaped = inSchema.filter((c) => /owner|_by$|^user_id$/.test(c.split('.')[1]!));
    expect(ownerShaped.filter((c) => !listed.has(c)), 'add these to OWNER_COLUMNS in src/store/store.ts').toEqual([]);
    expect([...listed].filter((c) => !inSchema.includes(c)), 'gone from the schema').toEqual([]);
    for (const c of OWNER_COLUMNS) if (c.how === 'stays') expect(c.why, `${c.table}.${c.column}`).toBeTruthy();
  });

  it('every moved row about one agent names its agent column, and every named column is in the schema', () => {
    const { db } = fullSchema();
    const cols = (t: string) => (db.prepare(`PRAGMA table_info("${t}")`).all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of OWNER_COLUMNS) {
      const where = `${c.table}.${c.column}`;
      if (c.agent) expect(cols(c.table), `${where}: agent column ${c.agent}`).toContain(c.agent);
      if (c.usedBy) {
        expect(cols(c.usedBy.table), `${where}: ${c.usedBy.table}.${c.usedBy.column}`).toContain(c.usedBy.column);
        expect(cols(c.usedBy.table), `${where}: ${c.usedBy.table}.${c.usedBy.agent}`).toContain(c.usedBy.agent);
      }
      // A moved row with an agent_id is about that agent: it must say so.
      if (c.how !== 'stays' && c.how !== 'own-step' && c.table !== 'agents' && cols(c.table).includes('agent_id')) {
        expect(c.agent, `${where} has agent_id: give it agent: 'agent_id'`).toBe('agent_id');
      }
    }
  });

  it('preferences, reports, budgets and alerts move with the agents', () => {
    const { db, store } = fullSchema();
    makeAgent(store, 'agent-test', 'dev-owner');
    store.setOwnerPref('dev-owner', 'ownBotsOnly', '1');
    store.setSpendAlert('agent-test', 'dev-owner', 5, '2026-11-01T00:00:00Z');
    store.setBudget('agent-test', 'dev-owner', 10, 'pause', '2026-11-01T00:00:00Z');
    store.addProblemReport({ id: 'report-test', ownerId: 'dev-owner', by: 'person', title: 'Invented report', body: 'Made up', createdAt: '2026-11-01T00:00:00Z' });
    db.prepare(`INSERT INTO usage_alerts (agent_id, owner_id, at, tokens, usual, told) VALUES ('agent-test', 'dev-owner', '2026-11-01T00:00:00Z', 9, 1, 1)`).run();
    // A row the new account already has, one per person: the owner's own from before wins.
    db.prepare(`INSERT INTO owner_prefs (owner_id, key, value, updated_at) VALUES ('account-test', 'ownBotsOnly', '0', 'now')`).run();

    expect(store.adoptLocalOwnerData('account-test')).toBeGreaterThan(0);
    expect(store.getAgent('agent-test')!.ownerId).toBe('account-test');
    expect(store.ownerPrefs('account-test').ownBotsOnly).toBe(true);
    expect(store.listSpendAlerts().map((a) => a.ownerId)).toEqual(['account-test']);
    expect(store.listBudgets().map((b) => b.ownerId)).toEqual(['account-test']);
    expect(store.listProblemReports('account-test').map((r) => r.id)).toEqual(['report-test']);
    expect(db.prepare(`SELECT owner_id FROM usage_alerts`).get()).toEqual({ owner_id: 'account-test' });
    // Nothing that moves is left under dev-owner.
    for (const c of OWNER_COLUMNS.filter((x) => x.how !== 'stays')) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${c.table} WHERE ${c.column} = 'dev-owner'`).get(), `${c.table}.${c.column}`).toEqual({ n: 0 });
    }
  });

  it('a day\'s usage and posture snapshot the account already has stays the account\'s', () => {
    const { db, store } = fullSchema();
    const usage = db.prepare(`INSERT INTO usage_snapshots (owner_id, day, total_tokens, by_billing, captured_at) VALUES (?, ?, ?, '{}', 'now')`);
    const posture = db.prepare(`INSERT INTO posture_snapshots (owner_id, day, risk_keys, captured_at) VALUES (?, ?, ?, 'now')`);
    usage.run('dev-owner', '2026-11-01', 100); usage.run('dev-owner', '2026-11-02', 200); usage.run('acct-owner', '2026-11-02', 999);
    posture.run('dev-owner', '2026-11-01', '["old-1"]'); posture.run('dev-owner', '2026-11-02', '["old-2"]'); posture.run('acct-owner', '2026-11-02', '["mine"]');
    makeAgent(store, 'first', 'dev-owner');
    store.pinFirstAccount('acct-owner');
    store.adoptLocalOwnerData('acct-owner', 'dev-owner', { pinned: true });
    expect(db.prepare(`SELECT owner_id, day, total_tokens FROM usage_snapshots ORDER BY day`).all()).toEqual([
      { owner_id: 'acct-owner', day: '2026-11-01', total_tokens: 100 }, { owner_id: 'acct-owner', day: '2026-11-02', total_tokens: 999 }]);
    expect(db.prepare(`SELECT owner_id, day, risk_keys FROM posture_snapshots ORDER BY day`).all()).toEqual([
      { owner_id: 'acct-owner', day: '2026-11-01', risk_keys: '["old-1"]' }, { owner_id: 'acct-owner', day: '2026-11-02', risk_keys: '["mine"]' }]);
  });

  it('a one-per-person row the new account already has does not stop the adoption', () => {
    const { db, store } = fullSchema();
    makeAgent(store, 'agent-test', 'dev-owner');
    // A preference (keep-old): the owner's own from before wins.
    db.prepare(`INSERT INTO owner_prefs (owner_id, key, value, updated_at) VALUES ('dev-owner', 'ownBotsOnly', '1', 'now')`).run();
    db.prepare(`INSERT INTO owner_prefs (owner_id, key, value, updated_at) VALUES ('account-test', 'ownBotsOnly', '0', 'now')`).run();
    expect(() => store.adoptLocalOwnerData('account-test')).not.toThrow();
    expect(store.getAgent('agent-test')!.ownerId).toBe('account-test');
    expect(db.prepare(`SELECT value FROM owner_prefs WHERE owner_id = 'account-test' AND key = 'ownBotsOnly'`).get()).toEqual({ value: '1' });
  });
});

/**
 * The second review of the HB-0548 fix: with retries, the account can make
 * things of its own between a failed try and the next one. What is unique per
 * owner then clashed, and every retry rolled back for good.
 */
describe('what the account made while a try waited does not block the hand-over', () => {
  it('a class with the same name: both kept, the adopted one renamed, its agents still in it', () => {
    const { store } = fullSchema();
    store.pinFirstAccount('acct-owner'); // the first try's pin, made before the account made anything
    makeAgent(store, 'agent-old', 'dev-owner');
    store.upsertAgentClass({ id: 'class-old', ownerId: 'dev-owner', name: 'Helpers' });
    store.upsertAgentClass({ id: 'class-old-2', ownerId: 'dev-owner', name: 'Helpers (2)' });
    store.upsertAgentClass({ id: 'class-new', ownerId: 'acct-owner', name: 'Helpers' });
    store.setAgentClassIf('agent-old', null, 'class-old');
    expect(() => store.adoptLocalOwnerData('acct-owner', 'dev-owner', { pinned: true })).not.toThrow();
    const names = store.listAgentClasses('acct-owner').map((c) => `${c.id}=${c.name}`).sort();
    expect(names).toEqual(['class-new=Helpers', 'class-old-2=Helpers (2)', 'class-old=Helpers (3)']);
    expect(store.getAgent('agent-old')).toMatchObject({ ownerId: 'acct-owner', classId: 'class-old' });
  });

  it('a Google connection to the same account: the account\'s newer one stays, and the old one\'s agents move to it', () => {
    const { db, store } = fullSchema();
    store.pinFirstAccount('acct-owner'); // the first try's pin, made before the account made anything
    db.exec(`CREATE TABLE IF NOT EXISTS secrets (ref TEXT PRIMARY KEY, iv BLOB, tag BLOB, ciphertext BLOB)`);
    db.prepare(`INSERT INTO secrets (ref) VALUES ('connection/conn-old'), ('connection/conn-new')`).run();
    makeAgent(store, 'agent-old', 'dev-owner');
    store.insertConnection({ id: 'conn-old', ownerId: 'dev-owner', kind: 'google', email: 'person@example.org', services: ['gmail'], secretRef: 'connection/conn-old' });
    store.insertConnection({ id: 'conn-new', ownerId: 'acct-owner', kind: 'google', email: 'person@example.org', services: ['gmail', 'calendar'], secretRef: 'connection/conn-new' });
    store.attachConnection('agent-old', 'conn-old', true);
    expect(() => store.adoptLocalOwnerData('acct-owner', 'dev-owner', { pinned: true })).not.toThrow();
    expect(store.listConnections('acct-owner').map((c) => c.id)).toEqual(['conn-new']);
    expect(store.listAgentConnections('agent-old')).toMatchObject([{ connectionId: 'conn-new', gmailNoSend: true }]);
    expect((db.prepare(`SELECT ref FROM secrets ORDER BY ref`).all() as Array<{ ref: string }>).map((r) => r.ref)).toEqual(['connection/conn-new']);
    expect(store.getAgent('agent-old')!.ownerId).toBe('acct-owner');
  });

  it('a Google connection to the same account: only the agents that move go to the account\'s; one left behind keeps the old', () => {
    const { db, store } = fullSchema();
    store.pinFirstAccount('acct-owner');
    db.exec(`CREATE TABLE IF NOT EXISTS secrets (ref TEXT PRIMARY KEY, iv BLOB, tag BLOB, ciphertext BLOB)`);
    db.prepare(`INSERT INTO secrets (ref) VALUES ('connection/conn-old'), ('connection/conn-new')`).run();
    makeAgent(store, 'garden', 'dev-owner'); // moves
    makeAgent(store, 'porch', 'dev-owner'); // moves; its connection was never delivered
    makeAgent(store, 'kitchen', 'dev-owner'); // stays: the account has a live "kitchen"
    store.insertAgent({ id: 'kitchen-new', ownerId: 'acct-owner', name: 'kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'p2', hostId: 'h2', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    store.insertConnection({ id: 'conn-old', ownerId: 'dev-owner', kind: 'google', email: 'person@example.org', services: ['gmail'], secretRef: 'connection/conn-old' });
    store.insertConnection({ id: 'conn-new', ownerId: 'acct-owner', kind: 'google', email: 'person@example.org', services: ['gmail'], secretRef: 'connection/conn-new' });
    store.attachConnection('garden', 'conn-old', false);
    store.attachConnection('kitchen', 'conn-old', true);
    store.attachConnection('porch', 'conn-old', false);
    // garden pulled the old token after the account's newer consent: still the old token.
    db.prepare(`UPDATE connections SET created_at = '2026-11-01T10:00:00.000Z' WHERE id = 'conn-new'`).run();
    store.markConnectionMaterialized('garden', 'conn-old', '2026-11-02T10:00:00.000Z');
    expect(() => store.adoptLocalOwnerData('acct-owner', 'dev-owner', { pinned: true })).not.toThrow();
    expect(store.listAgentConnections('garden').map((c) => c.connectionId)).toEqual(['conn-new']);
    // Marked stale (pulled before the account's consent), so the health view says to attach it again.
    const moved = store.listAgentConnections('garden')[0]!;
    expect(moved.materializedAt).not.toBeNull();
    expect(moved.materializedAt! < '2026-11-01T10:00:00.000Z').toBe(true);
    // Never delivered stays never delivered: not a pull time it never had.
    expect(store.listAgentConnections('porch')).toMatchObject([{ connectionId: 'conn-new' }]);
    expect(store.listAgentConnections('porch')[0]!.materializedAt ?? null).toBeNull();
    expect(store.listAgentConnections('kitchen')).toMatchObject([{ connectionId: 'conn-old', gmailNoSend: true }]);
    expect(store.listConnections('dev-owner').map((c) => c.id)).toEqual(['conn-old']);
    expect(store.listConnections('acct-owner').map((c) => c.id)).toEqual(['conn-new']);
    expect((db.prepare(`SELECT ref FROM secrets ORDER BY ref`).all() as Array<{ ref: string }>).map((r) => r.ref)).toEqual(['connection/conn-new', 'connection/conn-old']);
  });

  it('a management source on both sides, a deleted agent\'s slug, and a live agent with the same slug', () => {
    const { store } = fullSchema();
    store.pinFirstAccount('acct-owner'); // the first try's pin, made before the account made anything
    store.insertAIProfile({ id: 'p-old', ownerId: 'dev-owner', name: 'Old', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p-old', createdAt: 'now' });
    store.insertAIProfile({ id: 'p-new', ownerId: 'acct-owner', name: 'New', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p-new', createdAt: 'now' });
    store.setAIProfileMgmtLlm('dev-owner', 'p-old');
    store.setAIProfileMgmtLlm('acct-owner', 'p-new');
    makeAgent(store, 'garden', 'dev-owner', 'DELETED');
    makeAgent(store, 'kitchen', 'dev-owner');
    store.insertAgent({ id: 'garden-new', ownerId: 'acct-owner', name: 'garden', slug: 'garden', state: 'RUNNING', aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    store.insertAgent({ id: 'kitchen-new', ownerId: 'acct-owner', name: 'kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    expect(() => store.adoptLocalOwnerData('acct-owner', 'dev-owner', { pinned: true })).not.toThrow();
    expect(store.getAIProfile('p-old')).toMatchObject({ ownerId: 'acct-owner' });
    expect(store.listAIProfiles('acct-owner').filter((p) => p.mgmtLlm).map((p) => p.id)).toEqual(['p-new']);
    expect(store.getAgent('garden')).toMatchObject({ ownerId: 'acct-owner', slug: 'garden-deleted-garden' });
    // A live slug names a container and a folder: that agent stays, and the caller says so.
    expect(store.getAgent('kitchen')!.ownerId).toBe('dev-owner');
    expect(store.localOwnerHasData()).toBe(true);
  });
});

/** The third review: what is about one agent goes with it, and the guard holds once all is handed over. */
describe('an agent that stays behind keeps its own rows; a finished hand-over takes nothing more', () => {
  it('a live agent whose slug clashed keeps its budget, alerts, members, tokens, incidents and shares', () => {
    const { db, store } = fullSchema();
    store.pinFirstAccount('acct-owner');
    const agentOn = (id: string, ownerId: string, slug: string, aiProfileId: string, hostId: string) => store.insertAgent({
      id, ownerId, name: slug, slug, state: 'RUNNING', aiProfileId, hostId, persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    // kitchen and shed stay (the account has a live "kitchen" and "shed"); garden moves.
    agentOn('kitchen', 'dev-owner', 'kitchen', 'p', 'h');
    agentOn('garden', 'dev-owner', 'garden', 'p-garden', 'h');
    agentOn('shed', 'dev-owner', 'shed', 'p-garden', 'h-shed');
    agentOn('kitchen-new', 'acct-owner', 'kitchen', 'p-acct', 'h-acct');
    agentOn('shed-new', 'acct-owner', 'shed', 'p-acct', 'h-acct');
    store.insertAIProfile({ id: 'p', ownerId: 'dev-owner', name: 'Kitchen source', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p', createdAt: 'now' });
    store.insertAIProfile({ id: 'p-garden', ownerId: 'dev-owner', name: 'Garden source', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/pg', createdAt: 'now' });
    store.insertHost({ id: 'h', ownerId: 'dev-owner', kind: 'local', provider: 'mock', name: 'This machine', settings: {}, createdAt: 'now' });
    store.insertHost({ id: 'h-shed', ownerId: 'dev-owner', kind: 'cloud', provider: 'mock', name: 'A runner', settings: {}, createdAt: 'now' });
    for (const a of ['kitchen', 'garden']) {
      store.setBudget(a, 'dev-owner', 10, 'pause', 'now');
      store.setSpendAlert(a, 'dev-owner', 5, 'now');
      db.prepare(`INSERT INTO memberships (id, agent_id, user_id, role, status) VALUES (?, ?, 'dev-owner', 'owner', 'active')`).run(`m-${a}`, a);
      db.prepare(`INSERT INTO ops_tokens (agent_id, owner_id, token_hash, created_at) VALUES (?, 'dev-owner', 'made-up-hash', 'now')`).run(a);
      db.prepare(`INSERT INTO token_incidents (id, agent_id, owner_id, kind, key, opened_at, updated_at, count, text) VALUES (?, ?, 'dev-owner', 'loop', 'k', 'now', 'now', 1, 'made up')`).run(`ti-${a}`, a);
      db.prepare(`INSERT INTO agent_shares (id, from_owner, to_email, agent_name, source_agent_id, blob, created_at) VALUES (?, 'dev-owner', 'someone@example.org', ?, ?, x'00', 'now')`).run(`sh-${a}`, a, a);
    }
    store.adoptLocalOwnerData('acct-owner', 'dev-owner', { pinned: true });
    const ownerOf = (sql: string, id: string) => (db.prepare(sql).get(id) as { o: string }).o;
    // A source or machine a moved agent uses moves, even when one left behind
    // uses it too; one only agents left behind use stays with them.
    expect(store.getHost('h')!.ownerId, 'machine of kitchen and garden').toBe('acct-owner');
    expect(store.getAIProfile('p-garden')!.ownerId, 'source of garden and shed').toBe('acct-owner');
    expect(store.getAIProfile('p')!.ownerId, 'source of kitchen alone').toBe('dev-owner');
    expect(store.getHost('h-shed')!.ownerId, 'machine of shed alone').toBe('dev-owner');
    for (const [agent, want] of [['kitchen', 'dev-owner'], ['garden', 'acct-owner']] as const) {
      expect(store.getAgent(agent)!.ownerId, agent).toBe(want);
      expect(ownerOf(`SELECT owner_id AS o FROM budgets WHERE scope = ?`, agent), `budget ${agent}`).toBe(want);
      expect(ownerOf(`SELECT owner_id AS o FROM spend_alerts WHERE scope = ?`, agent), `alert ${agent}`).toBe(want);
      expect(ownerOf(`SELECT user_id AS o FROM memberships WHERE agent_id = ?`, agent), `member ${agent}`).toBe(want);
      expect(ownerOf(`SELECT owner_id AS o FROM ops_tokens WHERE agent_id = ?`, agent), `ops token ${agent}`).toBe(want);
      expect(ownerOf(`SELECT owner_id AS o FROM token_incidents WHERE agent_id = ?`, agent), `incident ${agent}`).toBe(want);
      expect(ownerOf(`SELECT from_owner AS o FROM agent_shares WHERE source_agent_id = ?`, agent), `share ${agent}`).toBe(want);
    }
  });

  it('once handed over, the old owner\'s later agent goes to nobody, even to the account it went to', () => {
    const { store } = fullSchema();
    store.pinFirstAccount('acct-owner');
    makeAgent(store, 'first', 'dev-owner');
    store.adoptLocalOwnerData('acct-owner', 'dev-owner', { pinned: true });
    expect(store.pinFirstAccount('acct-other')).toEqual({ ownerId: 'acct-owner', done: true });
    makeAgent(store, 'later', 'dev-owner'); // a leftover dev-owner CLI token made it
    expect(store.adoptLocalOwnerData('acct-owner', 'dev-owner', { pinned: true })).toBe(0);
    expect(store.getAgent('later')!.ownerId).toBe('dev-owner');
  });

  it('an install adopted before pins existed is not pinned again, so an identity account cannot take a later agent', () => {
    const { db, store } = fullSchema();
    makeAgent(store, 'earlier', 'acct-long-ago');
    makeAgent(store, 'later', 'dev-owner');
    expect(store.pinFirstAccount('acct-new')).toBeUndefined();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM first_account`).get()).toEqual({ n: 0 });
    expect(store.adoptLocalOwnerData('acct-new', 'dev-owner', { pinned: true })).toBe(0);
    expect(store.getAgent('later')!.ownerId).toBe('dev-owner');
  });

  it('a "This machine" host remade at boot for an account does not stop that account\'s hand-over', () => {
    const { store } = fullSchema();
    makeAgent(store, 'first', 'dev-owner');
    store.insertHost({ id: 'local', ownerId: 'acct-owner', kind: 'local', provider: 'mock', name: 'This machine', settings: {}, createdAt: 'now' });
    expect(store.pinFirstAccount('acct-owner')).toEqual({ ownerId: 'acct-owner', done: false });
    store.adoptLocalOwnerData('acct-owner', 'dev-owner', { pinned: true });
    expect(store.getAgent('first')!.ownerId).toBe('acct-owner');
  });

  it('a host remade at boot on an identity install while dev-owner still has agents does not end the hand-over', () => {
    const { db, store } = fullSchema();
    store.insertAIProfile({ id: 'p-main', ownerId: 'acct-main', name: 'Source', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/pm', createdAt: '2026-01-05T00:00:00Z' });
    makeAgent(store, 'still-old', 'dev-owner');
    expect(store.installOwner('identity')).toBe('acct-main');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM first_account`).get()).toEqual({ n: 0 });
    store.insertHost({ id: 'local', ownerId: 'acct-main', kind: 'local', provider: 'mock', name: 'This machine', settings: {}, createdAt: 'now' });
    // The next sign-in still takes what dev-owner has.
    expect(store.pinFirstAccount('acct-main')).toEqual({ ownerId: 'acct-main', done: false });
    store.adoptLocalOwnerData('acct-main', 'dev-owner', { pinned: true });
    expect(store.getAgent('still-old')!.ownerId).toBe('acct-main');
  });

  it('a "This machine" host made again goes to the install\'s owner, not to dev-owner', () => {
    const { store } = fullSchema();
    expect(store.installOwner('identity')).toBe('dev-owner'); // nothing handed over yet
    store.pinFirstAccount('acct-owner');
    makeAgent(store, 'first', 'dev-owner');
    store.adoptLocalOwnerData('acct-owner', 'dev-owner', { pinned: true });
    expect(store.installOwner('identity')).toBe('acct-owner');
    expect(store.installOwner('password')).toBe('dev-owner');
    store.insertLocalAccount({ id: 'acct-host', username: 'host', pwHash: 'h', pwSalt: 's', hostOwner: true, disabled: false, createdAt: 'now' });
    expect(store.installOwner('accounts')).toBe('acct-host');
  });

  it('an identity install handed over before pins existed: a re-made host goes to who set it up, not a member with more agents, and stays theirs', () => {
    const { store } = fullSchema();
    const made = (id: string, ownerId: string, at: string) => store.insertAgent({
      id, ownerId, name: id, slug: id, state: 'RUNNING', aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false, createdAt: at, updatedAt: at });
    store.insertAIProfile({ id: 'p', ownerId: 'acct-main', name: 'Household source', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p', createdAt: '2026-01-05T00:00:00Z' });
    made('a1', 'acct-main', '2026-01-06T00:00:00Z');
    for (const n of [1, 2, 3]) made(`m${n}`, 'acct-member', `2026-03-0${n}T00:00:00Z`);
    expect(store.installOwner('password')).toBe('dev-owner');
    expect(store.installOwner('identity')).toBe('acct-main');
    // Recorded: what the accounts own later does not change it.
    made('m0', 'acct-member', '2025-12-31T00:00:00Z');
    expect(store.installOwner('identity')).toBe('acct-main');
    expect(store.pinFirstAccount('acct-member')).toEqual({ ownerId: 'acct-main', done: true });
  });
});

describe('gateway ports stay within 1–65535 (HB-0554)', () => {
  const saved = process.env.HATCHABOT_GATEWAY_PORT_BASE;
  afterEach(() => {
    if (saved === undefined) delete process.env.HATCHABOT_GATEWAY_PORT_BASE;
    else process.env.HATCHABOT_GATEWAY_PORT_BASE = saved;
  });

  it('at the top of the range it takes a free port from the base, and says so when none is left', () => {
    const { store } = fullSchema();
    process.env.HATCHABOT_GATEWAY_PORT_BASE = '65534';
    for (const id of ['port-one', 'port-two', 'port-three', 'port-four']) makeAgent(store, id, 'owner-test');
    expect(store.ensureGatewayAccess('port-one').port).toBe(65534);
    expect(store.ensureGatewayAccess('port-two').port).toBe(65535);
    expect(() => store.ensureGatewayAccess('port-three')).toThrow(/No gateway port is free from 65534 to 65535/);
    // A deleted agent's port is free again once the count reaches the top.
    store.setAgentState('port-one', 'DELETING');
    store.setAgentState('port-one', 'DELETED');
    expect(store.ensureGatewayAccess('port-three').port).toBe(65534);
  });

  it('a port past 65535 saved by an older release is allocated again, keeping its token', () => {
    const { db, store } = fullSchema();
    makeAgent(store, 'port-one', 'owner-test');
    makeAgent(store, 'port-two', 'owner-test');
    db.prepare(`UPDATE agents SET gateway_port = 65535, gateway_token = 'made-up-one' WHERE id = 'port-one'`).run();
    db.prepare(`UPDATE agents SET gateway_port = 65536, gateway_token = 'made-up-two' WHERE id = 'port-two'`).run();
    process.env.HATCHABOT_GATEWAY_PORT_BASE = '19100';
    expect(store.ensureGatewayAccess('port-two')).toEqual({ port: 19100, token: 'made-up-two' });
    expect(store.ensureGatewayAccess('port-one')).toEqual({ port: 65535, token: 'made-up-one' });
  });
});
