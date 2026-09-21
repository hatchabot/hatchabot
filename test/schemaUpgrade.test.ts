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
    expect(store.sectionSorts('nobody')).toEqual({});
  });
});
