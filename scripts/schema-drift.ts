#!/usr/bin/env -S npx tsx
/**
 * Does the LIVE database have every table and column this build creates?
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * a column added to one after it shipped reaches a fresh database and never an
 * upgraded one — where every read of it then throws. v2.14.0 shipped exactly
 * that (pairing_window.expect) and it took the whole Telegram approve flow
 * down on the live install while every test stayed green.
 *
 *   npx tsx scripts/schema-drift.ts [path/to/hatchabot.sqlite]
 *
 * Exits non-zero on drift, so it can gate a release.
 */
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';

// Every column the CURRENT code creates, against what the LIVE database has.
// The missing-ALTER bug class, found for the whole schema at once.
const fresh = new Database(':memory:');
new Store(fresh);
const args = process.argv.slice(2).filter((a) => a !== '--migrate');
const migrate = process.argv.includes('--migrate');
const dbPath = args[0] ?? join(homedir(), 'hatchabot-data', 'hatchabot.sqlite');
// --migrate opens it the way the SERVER does — running the additive migrations
// first — which is what an upgrade check wants to prove. Without it the file is
// read as-is, which is what checking a live install wants.
const prod = new Database(dbPath, { readonly: !migrate });
if (migrate) new Store(prod);
const tables = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((t) => t.name);
const cols = (db: Database.Database, t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);

let drift = 0;
for (const t of tables(fresh)) {
  if (!tables(prod).includes(t)) { console.log(`MISSING TABLE  ${t}`); drift++; continue; }
  const missing = cols(fresh, t).filter((c) => !cols(prod, t).includes(c));
  if (missing.length) { console.log(`MISSING COLUMN ${t}: ${missing.join(', ')}`); drift++; }
}
console.log(drift
  ? `\n${drift} table(s) drifted — add an ALTER TABLE for each in store.ts`
  : `no drift: ${dbPath} has every table and column this build creates`);
process.exit(drift ? 1 : 0);
