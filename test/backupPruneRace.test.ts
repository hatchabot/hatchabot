import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupBusyError, pruneBackup } from '../src/orchestrator/backups/backupFiles.js';
import { processAlive } from '../src/domain/processAlive.js';

vi.mock('../src/domain/processAlive.js', () => ({ processAlive: vi.fn() }));
const homes: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

it('does not delete a set when a new backup takes over its stale lock during prune', () => {
  const home = mkdtempSync(join(tmpdir(), 'hb-prune-race-')); homes.push(home);
  const date = '2026-10-01', dir = join(home, date), lock = join(dir, '.backup-lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'pid'), '10101');
  writeFileSync(join(dir, 'hatchabot.sqlite'), 'registry being backed up');
  vi.mocked(processAlive).mockImplementation(pid => {
    if (pid === 10101) {
      // The script's atomic takeover wins after prune has read the old PID.
      rmSync(lock, { recursive: true }); mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), '20202');
      return false;
    }
    return pid === 20202;
  });
  expect(() => pruneBackup(date, home)).toThrow(BackupBusyError);
  expect(readFileSync(join(dir, 'hatchabot.sqlite'), 'utf8')).toBe('registry being backed up');
  expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe('20202');
  expect(existsSync(lock + '.takeover')).toBe(false);
});

it('refuses a stale lock whose takeover is already held by the backup script', () => {
  const home = mkdtempSync(join(tmpdir(), 'hb-prune-takeover-')); homes.push(home);
  const date = '2026-10-02', dir = join(home, date), lock = join(dir, '.backup-lock');
  mkdirSync(lock, { recursive: true }); mkdirSync(lock + '.takeover');
  writeFileSync(join(lock, 'pid'), '10101');
  vi.mocked(processAlive).mockReturnValue(false);
  expect(() => pruneBackup(date, home)).toThrow(BackupBusyError);
  expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe('10101');
  expect(existsSync(lock + '.takeover')).toBe(true);
});

it('clears an old empty takeover without deleting its set until a fresh retry', () => {
  const home = mkdtempSync(join(tmpdir(), 'hb-prune-old-takeover-')); homes.push(home);
  const date = '2026-10-03', dir = join(home, date), lock = join(dir, '.backup-lock');
  mkdirSync(lock, { recursive: true }); mkdirSync(lock + '.takeover');
  writeFileSync(join(lock, 'pid'), '10101');
  const old = new Date(Date.now() - 120_000); utimesSync(lock + '.takeover', old, old);
  vi.mocked(processAlive).mockReturnValue(false);
  expect(() => pruneBackup(date, home)).toThrow(BackupBusyError);
  expect(existsSync(dir)).toBe(true);
  expect(existsSync(lock + '.takeover')).toBe(false);
  expect(pruneBackup(date, home)).toBe(true);
});
