import Database from 'better-sqlite3';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * One server process per database (HB-1436). A second one started by hand
 * on the same database swept the first's secrets in flight at its start
 * (Store.sweepOrphanAgentSecrets: a data source's deploy key, an agent's env
 * values, call tokens, an app's pending install), and marked its running
 * operations cut off.
 *
 * The lock is an exclusive SQLite lock on an empty file beside the database
 * (`<database>.lock`), taken at the start and held for the process's life.
 * The operating system lets it go when the process ends however it ends (a
 * crash, a kill -9, the machine going down), so a lock file left behind
 * never stops the next start: only a live process holds it. Nothing is
 * written to the file (its journal is kept in memory), so it stays empty,
 * and no `-journal` beside it reads as another database to uninstall.sh.
 * The command line and the scripts open the database without it, as before.
 *
 * The lock follows POSIX record-lock rules, and those make it easy to lose
 * without a word:
 * - Inside the server, any open and close of `<database>.lock` other than
 *   this module's (a read of it, a stat through a descriptor, a copy of the
 *   data folder that opens each file) lets the lock go at the close, for the
 *   whole process. Nothing in src/ opens it, and nothing may: only this
 *   module touches the file, and then only with calls that open no
 *   descriptor (access, stat, realpath).
 * - Removing or replacing the file while a server runs (uninstall.sh's
 *   rm_db, a restore that copies the data folder back over itself) leaves
 *   the running server holding a file no longer there, and the next server
 *   makes a new one and starts beside it. uninstall.sh removes it only after
 *   it has stopped the service; whatever else removes it must too.
 */
export class InstanceLockedError extends Error {
  constructor(readonly dbPath: string) {
    super(
      `Another Hatchabot server is already running on this database (${dbPath}), so this one did not start: ` +
      'two at once undo each other\'s work. Stop the other one first, or give this one a database of its own (HATCHABOT_DB).',
    );
    this.name = 'InstanceLockedError';
  }
}

/**
 * The lock file cannot be written. SQLite then opens it read only without a
 * word, and its exclusive lock holds nothing: every server would start, two
 * at once among them. A server once started as root (`sudo npm start`)
 * leaves such a file behind, root's.
 */
export class InstanceLockUnwritableError extends Error {
  constructor(readonly lockPath: string, owner: LockOwner) {
    super(
      `Hatchabot cannot write its lock file (${lockPath}), so this one did not start: without the lock, ` +
      'a second server could run on this database unnoticed. ' +
      (owner.kind === 'mine'
        ? `The file is yours but read only. Make it writable (chmod u+w ${lockPath}), or, once no Hatchabot server is running, remove it.`
        : owner.kind === 'other'
          ? `The file belongs to ${owner.name}, perhaps left by a server started with sudo. Make it yours (sudo chown $(id -un) ${lockPath}), ` +
            'or, once no Hatchabot server is running, remove it.'
          : `It cannot be changed here (${owner.code}): the disk or folder may be read only. Start the server where its database can be written.`),
    );
    this.name = 'InstanceLockUnwritableError';
  }
}

/** Who keeps the lock file from this process: itself (the file's mode), another user (its owner), or the disk. */
export type LockOwner = { kind: 'mine' } | { kind: 'other'; name: string } | { kind: 'disk'; code: string };

/** The name of user `uid`, from /etc/passwd where it is there; "root" for 0; else "user id N". */
export function userName(uid: number, passwd = '/etc/passwd'): string {
  if (uid === 0) return 'root';
  try {
    for (const line of readFileSync(passwd, 'utf8').split('\n')) {
      const [name, , id] = line.split(':');
      if (name && id === String(uid)) return name;
    }
  } catch { /* no passwd file to read (or not this one) */ }
  return `user id ${uid}`;
}

function ownerOf(path: string, code: string): LockOwner {
  if (code !== 'EACCES' && code !== 'EPERM') return { kind: 'disk', code };
  try {
    const { uid } = statSync(path);
    return uid === process.getuid?.() ? { kind: 'mine' } : { kind: 'other', name: userName(uid) };
  } catch {
    return { kind: 'disk', code };
  }
}

/**
 * Where the database really is. Two paths to one database (a link to it, as
 * scripts/migrate-rename-host.sh leaves at the old place, or a linked folder)
 * must find one lock, beside the file SQLite itself writes beside (its -wal
 * and -shm follow links too). A database not made yet is placed by its folder.
 */
function realPlace(dbPath: string): string {
  try {
    return realpathSync(dbPath);
  } catch {
    try { return join(realpathSync(dirname(dbPath)), basename(dbPath)); } catch { return dbPath; }
  }
}

export interface InstanceLock {
  /** The lock file, beside the database. */
  readonly path: string;
  /** Lets go of the lock (at shutdown; the process's end does it too). */
  release(): void;
}

/**
 * Takes the lock for `dbPath`, waiting up to `waitMs` for one held by a
 * process that is ending (a restart whose old process is still closing).
 * Throws InstanceLockedError when another live process holds it.
 */
export function holdInstanceLock(dbPath: string, waitMs = 10_000): InstanceLock {
  // An in-memory database is this process's alone.
  if (dbPath === ':memory:') return { path: '', release: () => {} };
  const path = `${realPlace(dbPath)}.lock`;
  let lock: Database.Database | undefined;
  try {
    lock = new Database(path, { timeout: waitMs });
    // SQLite falls back to read only on a file it cannot write, and the lock
    // then holds nothing: refuse rather than run unlocked. The file is there
    // now (the open made it where it was not); access() opens no descriptor.
    try {
      accessSync(path, constants.W_OK);
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'EACCES';
      throw new InstanceLockUnwritableError(path, ownerOf(path, code));
    }
    lock.pragma('journal_mode = MEMORY');
    lock.exec('BEGIN EXCLUSIVE');
  } catch (err) {
    try { lock?.close(); } catch { /* the lock was never ours */ }
    if ((err as { code?: string }).code === 'SQLITE_BUSY') throw new InstanceLockedError(dbPath);
    throw err;
  }
  const held = lock;
  return { path, release: () => { if (held.open) held.close(); } };
}
