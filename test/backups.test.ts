import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listBackups, pruneBackup } from '../src/orchestrator/backups.js';

const base = mkdtempSync(join(tmpdir(), 'acl-bk-'));

function makeSet(date: string, files: Record<string, string>) {
  const dir = join(base, date);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
}

// A complete set, an incomplete one (no key), and noise that must be ignored.
makeSet('2026-08-20', {
  'agentclaw.sqlite': 'db',
  'secret-key.env': 'k',
  'agentclaw-kitchen.tgz': 'aa',
  'agentclaw-butler.tgz': 'bbbb',
});
makeSet('2026-08-22', { 'agentclaw.sqlite': 'db', 'agentclaw-kitchen.tgz': 'cc' });
mkdirSync(join(base, 'not-a-date'), { recursive: true });
writeFileSync(join(base, 'stray.txt'), 'x');

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('listBackups', () => {
  it('lists only date-named sets, newest first, with sizes and presence flags', () => {
    const sets = listBackups(base);
    expect(sets.map((s) => s.date)).toEqual(['2026-08-22', '2026-08-20']);

    const complete = sets[1];
    expect(complete.hasDb).toBe(true);
    expect(complete.hasKey).toBe(true);
    // prefix stripped, sorted by name
    expect(complete.volumes.map((v) => v.name)).toEqual(['butler', 'kitchen']);
    expect(complete.volumes.find((v) => v.name === 'butler')!.sizeBytes).toBe(4);
    // size sums every file in the set (db + key + both tarballs)
    expect(complete.sizeBytes).toBe('db'.length + 'k'.length + 'aa'.length + 'bbbb'.length);

    // the incomplete set is flagged: registry present, key missing
    const partial = sets[0];
    expect(partial.hasDb).toBe(true);
    expect(partial.hasKey).toBe(false);
  });

  it('returns [] for a missing base dir', () => {
    expect(listBackups(join(base, 'nope'))).toEqual([]);
  });
});

describe('pruneBackup', () => {
  it('deletes one dated set and reports it', () => {
    expect(existsSync(join(base, '2026-08-20'))).toBe(true);
    expect(pruneBackup('2026-08-20', base)).toBe(true);
    expect(existsSync(join(base, '2026-08-20'))).toBe(false);
    // gone → false, not an error
    expect(pruneBackup('2026-08-20', base)).toBe(false);
  });

  it('refuses anything that is not a YYYY-MM-DD name — no path traversal', () => {
    expect(() => pruneBackup('../base', base)).toThrow();
    expect(() => pruneBackup('..', base)).toThrow();
    expect(() => pruneBackup('2026-08-22/../../etc', base)).toThrow();
    expect(() => pruneBackup('not-a-date', base)).toThrow();
    // the real set is untouched by any of the above
    expect(existsSync(join(base, '2026-08-22'))).toBe(true);
  });
});
