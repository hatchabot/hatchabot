import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { holdInstanceLock, InstanceLockedError, InstanceLockUnwritableError, userName } from '../src/store/instanceLock.js';

// One server process per database (HB-1436): a second one's start swept the
// first's secrets in flight. Each test has its own folder; a child process
// that holds the lock is a stand-in for the other server.

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dbIn = () => { const d = mkdtempSync(join(tmpdir(), 'hb-lock-')); dirs.push(d); return join(d, 'hatchabot.sqlite'); };

/** Another process holding the lock on `db`; it lets go after `exitAfterMs`, or holds until killed. */
async function otherServer(db: string, exitAfterMs?: number): Promise<ChildProcess> {
  // The handle kept, as src/index.ts keeps it: one dropped could be collected, closing the lock with it.
  const code = `import { holdInstanceLock } from './src/store/instanceLock.ts';
globalThis.heldLock = holdInstanceLock(${JSON.stringify(db)}, 0);
process.stdout.write('held\\n');
${exitAfterMs === undefined ? 'setInterval(() => {}, 60_000);' : `setTimeout(() => process.exit(0), ${exitAfterMs});`}`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let err = '';
  child.stderr!.on('data', (b) => { err += String(b); });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (b) => { if (String(b).includes('held')) resolve(); });
    child.once('exit', (c) => reject(new Error(`the other process ended (${c}) before it held the lock: ${err}`)));
  });
  return child;
}
const ended = (c: ChildProcess) => new Promise<void>((r) => { if (c.exitCode !== null || c.signalCode !== null) r(); else c.once('exit', () => r()); });

describe('one server process per database (HB-1436)', () => {
  it('a second holder in this process is refused, with a message that says what to do; once let go it can be taken', () => {
    const db = dbIn();
    const first = holdInstanceLock(db, 0);
    expect(first.path).toBe(`${join(realpathSync(dirname(db)), basename(db))}.lock`);
    let refused: unknown;
    try { holdInstanceLock(db, 0); } catch (err) { refused = err; }
    expect(refused).toBeInstanceOf(InstanceLockedError);
    expect((refused as Error).message).toBe(
      `Another Hatchabot server is already running on this database (${db}), so this one did not start: ` +
      'two at once undo each other\'s work. Stop the other one first, or give this one a database of its own (HATCHABOT_DB).',
    );
    first.release();
    holdInstanceLock(db, 0).release();
  });

  it('another live process holding it refuses this one; another database is not held', async () => {
    const db = dbIn();
    await otherServer(db);
    expect(() => holdInstanceLock(db, 0)).toThrow(InstanceLockedError);
    holdInstanceLock(dbIn(), 0).release();
  }, 60_000);

  it('a lock left by a process that was killed does not stop the next start', async () => {
    const db = dbIn();
    const other = await otherServer(db);
    other.kill('SIGKILL');
    await ended(other);
    // The file is still there, empty, and nothing beside it reads as a database.
    expect(existsSync(`${db}.lock`)).toBe(true);
    expect(statSync(`${db}.lock`).size).toBe(0);
    expect(readdirSync(join(db, '..')).sort()).toEqual(['hatchabot.sqlite.lock']);
    holdInstanceLock(db, 0).release();
  }, 60_000);

  it('a start waits for a process that is ending (a restart) rather than refusing at once', async () => {
    const db = dbIn();
    await otherServer(db, 1_000);
    const t = Date.now();
    holdInstanceLock(db, 20_000).release();
    expect(Date.now() - t).toBeGreaterThan(100);
  }, 60_000);

  it('a database reached through a link, or through a linked folder, finds the one lock its real place has', async () => {
    const db = dbIn();
    writeFileSync(db, '');
    // The old place left a link to the moved database (scripts/migrate-rename-host.sh).
    const old = join(dbIn(), '..', 'old.sqlite');
    symlinkSync(db, old);
    await otherServer(db);
    expect(() => holdInstanceLock(old, 0)).toThrow(InstanceLockedError);
    // A folder linked to the database's folder, with the database not made yet.
    const moved = join(dbIn(), '..', 'data');
    mkdirSync(moved);
    const linked = join(dbIn(), '..', 'data-link');
    symlinkSync(moved, linked);
    await otherServer(join(moved, 'hatchabot.sqlite'));
    expect(() => holdInstanceLock(join(linked, 'hatchabot.sqlite'), 0)).toThrow(InstanceLockedError);
    // The lock is beside the real database, none beside the link.
    expect(existsSync(`${old}.lock`)).toBe(false);
    expect(existsSync(`${db}.lock`)).toBe(true);
  }, 60_000);

  // SQLite opens a lock file it cannot write read only, without a word, and
  // its exclusive lock then holds nothing: two such servers both started.
  // Root writes any file, so this runs only as another user.
  it.skipIf(process.getuid?.() === 0)('a lock file it cannot write is refused, not held for nothing, and the message says how to mend it', () => {
    const db = dbIn();
    writeFileSync(`${db}.lock`, '');
    chmodSync(`${db}.lock`, 0o444);
    let refused: unknown;
    try { holdInstanceLock(db, 0).release(); } catch (err) { refused = err; }
    expect(refused).toBeInstanceOf(InstanceLockUnwritableError);
    expect((refused as Error).message).toBe(
      `Hatchabot cannot write its lock file (${db}.lock), so this one did not start: without the lock, ` +
      'a second server could run on this database unnoticed. ' +
      `The file is yours but read only. Make it writable (chmod u+w ${db}.lock), or, once no Hatchabot server is running, remove it.`,
    );
    // Made writable again, it is taken as before.
    chmodSync(`${db}.lock`, 0o644);
    holdInstanceLock(db, 0).release();
  });

  it('a lock file of another user\'s (a server once started with sudo) is named as theirs, with the fix', () => {
    expect(new InstanceLockUnwritableError('/data/hatchabot.sqlite.lock', { kind: 'other', name: 'root' }).message).toBe(
      'Hatchabot cannot write its lock file (/data/hatchabot.sqlite.lock), so this one did not start: without the lock, ' +
      'a second server could run on this database unnoticed. ' +
      'The file belongs to root, perhaps left by a server started with sudo. Make it yours (sudo chown $(id -un) /data/hatchabot.sqlite.lock), ' +
      'or, once no Hatchabot server is running, remove it.',
    );
    expect(new InstanceLockUnwritableError('/data/hatchabot.sqlite.lock', { kind: 'disk', code: 'EROFS' }).message).toBe(
      'Hatchabot cannot write its lock file (/data/hatchabot.sqlite.lock), so this one did not start: without the lock, ' +
      'a second server could run on this database unnoticed. ' +
      'It cannot be changed here (EROFS): the disk or folder may be read only. Start the server where its database can be written.',
    );
    const passwd = join(dbIn(), '..', 'passwd');
    writeFileSync(passwd, 'root:x:0:0::/root:/bin/sh\nrivergate:x:1234:1234::/home/rivergate:/bin/sh\n');
    expect(userName(0, passwd)).toBe('root');
    expect(userName(1234, passwd)).toBe('rivergate');
    expect(userName(4321, passwd)).toBe('user id 4321');
    expect(userName(4321, join(passwd, 'none'))).toBe('user id 4321');
  });

  it('the server takes it before it opens the database', () => {
    const src = readFileSync('src/index.ts', 'utf8');
    const lock = src.indexOf('holdInstanceLock(DB_PATH)');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(src.indexOf('new Database(DB_PATH)'));
    expect(src).toMatch(/err instanceof InstanceLockedError \|\| err instanceof InstanceLockUnwritableError\)\) throw err;\n\s*console\.error\(err\.message\);\n\s*process\.exit\(1\);/);
  });
});
