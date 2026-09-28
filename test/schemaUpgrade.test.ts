import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';

/**
 * Upgrading an install that already has the tables.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that exists, so a
 * column added to one after it shipped reaches a fresh database (where the
 * CREATE runs in full) and NOT an upgraded one — where every read of that
 * column then throws. v2.14.0 shipped exactly that bug: `pairing_window.expect`
 * was added to the CREATE with no ALTER, so on the live install every pairing
 * read threw "no such column: expect" and the whole approve flow stopped.
 *
 * This builds each table in its older shape FIRST, then opens the Store, and
 * exercises the paths that read the newer columns.
 */
function olderDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE pairing_window (agent_id TEXT PRIMARY KEY, until TEXT NOT NULL, opened_for TEXT);
  `);
  return db;
}

describe('opening a database that predates the current columns', () => {
  it('migrates pairing_window and still reads and writes a window', () => {
    const store = new Store(olderDb());
    store.openPairingWindow('a1', new Date(Date.now() + 60_000).toISOString(), 'user-guest', { expect: '@maria_k' });
    expect(store.pairingWindow('a1')?.expect).toBe('maria_k');
    expect(store.pairingWindowOpen('a1')).toBe(true);
    store.closePairingWindow('a1');
    expect(store.pairingWindow('a1')).toBeUndefined();
  });

  it('every column the code selects exists after opening an older database', () => {
    const db = olderDb();
    const store = new Store(db);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols('pairing_window')).toContain('expect');
    expect(cols('invites')).toContain('expect_handle');
    expect(cols('agents')).toContain('allow_knocks');
    expect(cols('ai_profiles')).toContain('sort_order');
    expect(store.sectionsOf('nobody')).toEqual([]);
  });
});

describe('the row moves an upgrade does (night review, 2026-09-27)', () => {
  it('an open window in the old one-per-agent table moves to the per-seat table, its @handle with it', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE pairing_window (agent_id TEXT PRIMARY KEY, until TEXT NOT NULL, opened_for TEXT, expect TEXT);`);
    const until = new Date(Date.now() + 60_000).toISOString();
    db.prepare(`INSERT INTO pairing_window VALUES ('a1', ?, 'user-guest', 'maria_k')`).run(until);
    const store = new Store(db);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM pairing_window`).get() as { n: number }).n).toBe(0);
    const moved = db.prepare(`SELECT seat, until, opened_for, expect FROM pairing_windows WHERE agent_id = 'a1'`).get() as Record<string, string>;
    expect(moved).toEqual({ seat: 'telegram:user-guest', until, opened_for: 'user-guest', expect: 'maria_k' });
    expect(store.pairingWindowOpen('a1')).toBe(true);
  });
  it('a database from before the expect column moves its rows on the next opening, not never', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE pairing_window (agent_id TEXT PRIMARY KEY, until TEXT NOT NULL, opened_for TEXT);`);
    db.prepare(`INSERT INTO pairing_window VALUES ('a1', ?, NULL)`).run(new Date(Date.now() + 60_000).toISOString());
    new Store(db); // adds the column; the move waits
    new Store(db); // the next boot moves it
    expect((db.prepare(`SELECT seat FROM pairing_windows WHERE agent_id = 'a1'`).get() as { seat: string }).seat).toBe('telegram:owner');
  });
  it('model_call_hours under the old two-column key is rebuilt under three, keeping every count', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE model_call_hours (agent_id TEXT NOT NULL, profile_id TEXT, hour TEXT NOT NULL, ok INTEGER NOT NULL DEFAULT 0, limited INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (agent_id, hour));`);
    db.prepare(`INSERT INTO model_call_hours VALUES ('a1', 'p1', '2026-09-27T10', 3, 1, 0)`).run();
    db.prepare(`INSERT INTO model_call_hours VALUES ('a2', 'p1', '2026-09-27T10', 2, 0, 1)`).run();
    new Store(db);
    const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'model_call_hours'`).get() as { sql: string }).sql;
    expect(sql).toMatch(/PRIMARY KEY \(agent_id, profile_id, hour\)/);
    const rows = db.prepare(`SELECT agent_id, ok, limited, failed FROM model_call_hours ORDER BY agent_id`).all();
    expect(rows).toEqual([{ agent_id: 'a1', ok: 3, limited: 1, failed: 0 }, { agent_id: 'a2', ok: 2, limited: 0, failed: 1 }]);
  });
});
