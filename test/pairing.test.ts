import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAIRING_UNKNOWN, parsePendingPairing, pendingPairingShell } from '../src/orchestrator/console/pairing.js';

describe('pending console-pairing requests across OpenClaw versions', () => {
  it('the shell reads the 2026.9 state database and the JSON file, else says it does not know', () => {
    const sh = pendingPairingShell();
    expect(sh).toContain('devices/pending.json');
    expect(sh).toContain('state/openclaw.sqlite');
    expect(sh).toContain('device_pairing_pending');
    expect(sh).toContain(PAIRING_UNKNOWN);
    // the node script is single-quoted in the shell: it must not contain one
    const node = /node -e '([^']*)'/.exec(sh)?.[1] ?? '';
    expect(node).toContain('DatabaseSync');
    expect(sh.split("node -e '")[1]!.split("' ")[0]).toBe(node);
  });

  it('a 2026.7 file: an object of rows, or an array', () => {
    expect(parsePendingPairing(JSON.stringify({ a: { requestId: 'r-00000001', ts: 5 } }))).toEqual([{ requestId: 'r-00000001', ts: 5 }]);
    expect(parsePendingPairing(JSON.stringify([{ requestId: 'r-00000001', createdAtMs: 7 }]))).toEqual([{ requestId: 'r-00000001', ts: 7 }]);
    expect(parsePendingPairing('{}')).toEqual([]); // a real file with nothing in it
  });

  it('a 2026.9 database: rows the shell already shaped, refreshed time included', () => {
    expect(parsePendingPairing('[{"requestId":"5c8b83a2-a6f9-4e9f-9248-8ac1a6fcd6a1","ts":1790280413534}]')).toEqual([
      { requestId: '5c8b83a2-a6f9-4e9f-9248-8ac1a6fcd6a1', ts: 1790280413534 },
    ]);
  });

  it('no store, garbage, or an unknown shape means "ask the CLI", never "nothing pending"', () => {
    expect(parsePendingPairing(PAIRING_UNKNOWN)).toBeUndefined();
    expect(parsePendingPairing(`${PAIRING_UNKNOWN}\n`)).toBeUndefined();
    expect(parsePendingPairing('')).toBeUndefined();
    expect(parsePendingPairing('not json')).toBeUndefined();
    expect(parsePendingPairing('[{"id":"x"}]')).toBeUndefined();
  });
});

/**
 * The shell run for real against a temp volume: a temp HOME, and a PATH
 * that holds only node and cat (HB-0935).
 */
describe('a 2026.7 file left beside a 2026.9 database (HB-0935)', () => {
  function volume(file: string | undefined, db: 'rows' | 'no table' | 'garbage' | undefined) {
    const home = mkdtempSync(join(tmpdir(), 'hb-pairing-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, 'node'));
    symlinkSync('/bin/cat', join(bin, 'cat'));
    mkdirSync(join(home, '.openclaw', 'devices'), { recursive: true });
    mkdirSync(join(home, '.openclaw', 'state'), { recursive: true });
    if (file !== undefined) writeFileSync(join(home, '.openclaw', 'devices', 'pending.json'), file);
    const dbPath = join(home, '.openclaw', 'state', 'openclaw.sqlite');
    if (db === 'garbage') writeFileSync(dbPath, 'not a database at all, but long enough to be read as one'.repeat(20));
    else if (db) {
      const d = new Database(dbPath);
      d.exec('CREATE TABLE other (x INTEGER)');
      if (db === 'rows') {
        d.exec('CREATE TABLE device_pairing_pending (request_id TEXT PRIMARY KEY, ts INTEGER, refreshed_at_ms INTEGER)');
        d.prepare('INSERT INTO device_pairing_pending VALUES (?, ?, ?)').run('req-database-0001', 1_000, 2_000);
        d.prepare('INSERT INTO device_pairing_pending VALUES (?, ?, ?)').run('req-shared-00001', 3_000, null);
      }
      d.close();
    }
    const out = execFileSync('/bin/sh', ['-c', pendingPairingShell()], { env: { HOME: home, PATH: bin }, encoding: 'utf8' });
    rmSync(home, { recursive: true, force: true });
    return parsePendingPairing(out);
  }

  it('an old empty file does not hide the requests in the database', () => {
    expect(volume('{}', 'rows')).toEqual([{ requestId: 'req-database-0001', ts: 2_000 }, { requestId: 'req-shared-00001', ts: 3_000 }]);
  });

  it('both are read: the database\'s row first, then the file\'s not already listed', () => {
    const file = JSON.stringify({ a: { requestId: 'req-shared-00001', ts: 9 }, b: { requestId: 'req-file-000001', createdAtMs: 4_000 } });
    expect(volume(file, 'rows')).toEqual([
      { requestId: 'req-database-0001', ts: 2_000 }, { requestId: 'req-shared-00001', ts: 3_000 }, { requestId: 'req-file-000001', ts: 4_000 },
    ]);
  });

  it('a 2026.7 volume: the file alone, or beside a database without the table, as before', () => {
    const file = JSON.stringify([{ requestId: 'req-file-000001', ts: 5 }]);
    expect(volume(file, undefined)).toEqual([{ requestId: 'req-file-000001', ts: 5 }]);
    expect(volume(file, 'no table')).toEqual([{ requestId: 'req-file-000001', ts: 5 }]);
    expect(volume('{}', 'no table')).toEqual([]);
  });

  it('a database that cannot be read, no store at all, or only an unknown file: ask the CLI', () => {
    expect(volume('{}', 'garbage')).toBeUndefined();
    expect(volume(undefined, undefined)).toBeUndefined();
    expect(volume(undefined, 'no table')).toBeUndefined();
    expect(volume('[{"id":"x"}]', undefined)).toBeUndefined();
    // An unknown file beside a database that answered: the database's rows.
    expect(volume('[{"id":"x"}]', 'rows')).toHaveLength(2);
  });
});
