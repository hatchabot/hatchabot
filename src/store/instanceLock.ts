import Database from 'better-sqlite3';
import { accessSync, constants, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

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
 *
 * Whether the lock holds is asked of the handle itself, by a write it
 * takes back (a SAVEPOINT rolled back, so the file stays empty): a file
 * SQLite opened read only answers it with SQLITE_READONLY whatever access()
 * said of the path (a file swapped between the open and that check, an odd
 * FUSE or SMB mount; HB-1443).
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
          : owner.kind === 'no-folder'
            ? `The folder it goes in (${owner.folder}) is not there: a link on the way to the database leads to a folder that does not exist. ` +
              'Make that folder, or set HATCHABOT_DB to where the database is.'
            : owner.kind === 'unsearchable'
              ? `Hatchabot cannot look in ${owner.folder} (${owner.code}): this user may not open one of the folders on the way to it (its x permission; ls -ld each one). ` +
                'Give this user that access, or set HATCHABOT_DB to where the database is.'
              : `It cannot be changed here (${owner.code}): the disk or folder may be read only. Start the server where its database can be written.`),
    );
    this.name = 'InstanceLockUnwritableError';
  }
}

/** Who keeps the lock file from this process: itself (the file's mode), another user (its owner), the disk, a folder not there, or one it may not look in. */
export type LockOwner = { kind: 'mine' } | { kind: 'other'; name: string } | { kind: 'disk'; code: string } | { kind: 'no-folder'; folder: string } | { kind: 'unsearchable'; folder: string; code: string };

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

/** A handle SQLite opened read only: whose the file is, when access() says it cannot be written; else the disk, with SQLite's code. */
function ownerOfReadOnly(path: string, sqliteCode: string): LockOwner {
  try {
    accessSync(path, constants.W_OK);
  } catch (err) {
    return ownerOf(path, (err as { code?: string }).code ?? 'EACCES');
  }
  return { kind: 'disk', code: sqliteCode };
}

/** Links followed at most: the system's own limit (ELOOP past it). */
const MAX_LINKS = 40;

/**
 * Where the database really is. Two paths to one database (a link to it, as
 * scripts/migrate-rename-host.sh leaves at the old place, or a linked folder)
 * must find one lock, beside the file SQLite itself writes beside (its -wal
 * and -shm follow links too). A database not made yet is placed by its
 * folder, and one a link leads to by where the link leads: SQLite makes it
 * there, and placed by the link's own folder, a start by the database's own
 * path once it was made found another lock (HB-1443). A link's own path is
 * read from the folder it is really in, as the system reads it: from a
 * linked folder, `../moved` is beside the folder it leads to, not beside the
 * link (review). readlink and realpath open no descriptor.
 */
function realPlace(dbPath: string): string {
  let p = dbPath;
  for (let links = 0; links <= MAX_LINKS; links++) {
    try { return realpathSync(p); } catch { /* not made yet, or a link to what is not */ }
    let to: string;
    try { to = readlinkSync(p); } catch { break; } // not a link: a file not made yet
    let dir = dirname(p);
    try { dir = realpathSync(dir); } catch { /* a folder not there: as written */ }
    p = resolve(dir, to);
  }
  try { return join(realpathSync(dirname(p)), basename(p)); } catch { return p; }
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
  // A link into a folder not there (moved, or not made yet): said in plain
  // words, not as better-sqlite3's TypeError with a stack at every restart
  // (review of HB-1443). One that is there but that this user may not look
  // in (a folder on the way without x) is not "not there" (review). A stat:
  // it opens no descriptor.
  try {
    statSync(dirname(path));
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'ENOENT';
    throw new InstanceLockUnwritableError(path, code === 'ENOENT' || code === 'ENOTDIR'
      ? { kind: 'no-folder', folder: dirname(path) }
      : { kind: 'unsearchable', folder: dirname(path), code });
  }
  let lock: Database.Database | undefined;
  try {
    try {
      lock = new Database(path, { timeout: waitMs });
    } catch (err) {
      // No file yet, in a folder it cannot be made in (read only, or another
      // user's): said in plain words, as a file it cannot write is, not as
      // SQLite's error with a stack at every restart (HB-1443).
      if ((err as { code?: string }).code === 'SQLITE_CANTOPEN') throw new InstanceLockUnwritableError(path, { kind: 'disk', code: 'SQLITE_CANTOPEN' });
      throw err;
    }
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
    // And the handle itself, by a write it takes back: one opened read only
    // holds nothing, whatever access() said of the path (HB-1443).
    try {
      lock.exec('SAVEPOINT lock_probe; PRAGMA user_version = 1; ROLLBACK TO lock_probe; RELEASE lock_probe');
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (!code.startsWith('SQLITE_READONLY')) throw err;
      throw new InstanceLockUnwritableError(path, ownerOfReadOnly(path, code));
    }
  } catch (err) {
    try { lock?.close(); } catch { /* the lock was never ours */ }
    if ((err as { code?: string }).code === 'SQLITE_BUSY') throw new InstanceLockedError(dbPath);
    throw err;
  }
  const held = lock;
  return { path, release: () => { if (held.open) held.close(); } };
}
