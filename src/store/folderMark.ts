import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Two installs whose databases share one folder (HB-1151). Everything an
 * install keeps beside its database (the memory search service's keys in
 * `embed/` and `embed-hosts/`, `models/`, `derived-builds/`,
 * `release-manifests/`, `app-sources/`, `mgmt-cli-home/`,
 * `limits-check.json`) is named for the folder, not for the database, so
 * each install writes over the other's: the memory search key of one stops
 * matching its agents. Nothing is moved and no start is refused: the start
 * says so in the service log, and `hatchabot doctor` fails with the fix.
 *
 * Each install marks the folder at its start with a file beside its database
 * (`<database>.uses-this-folder`) that names it. Another such mark whose
 * database is there is another install's: the case warned about. One whose
 * database is gone (a database moved away or removed) says nothing, and
 * neither does the install's own (by the file, so another name for the same
 * database is its own too). A mark per database, never one shared file: two
 * installs starting at once each write only their own, so the second to
 * look always sees the first's, and both doctors see both.
 */
export const FOLDER_MARK_SUFFIX = '.uses-this-folder';

/** What the app keeps beside its database, named for the folder: what a database moved to a folder of its own needs copied after it. */
export const BESIDE_DATABASE = ['embed', 'embed-hosts', 'models', 'derived-builds', 'release-manifests', 'app-sources', 'mgmt-cli-home', 'limits-check.json'] as const;

const SHARED_FOLDER_ENTRY = 'docs/troubleshooting.md, "Two installs share one data folder"';

/**
 * The folder a move's copy of an agent goes to while it is under way, beside
 * the database and named for it (backupFiles.ts `moveCopyDir`; the
 * uninstaller's MOVE_COPY_ID): the database's name, not its whole path,
 * which a release's data/ link changes. A move cut off leaves it, with the
 * agent's tokens in it, until the next start sweeps it.
 */
export function moveCopyFolder(dbPath: string): string {
  const db = resolve(dbPath);
  return join(dirname(db), `move-copies-${createHash('sha256').update(basename(db)).digest('hex').slice(0, 16)}`);
}

/** What a database moved to a folder of its own takes with it: the files named for it, and its move-copies folder. */
function namedFor(own: string): { files: string; copies: string } {
  const name = basename(own);
  return { files: [`${name}-wal`, `${name}-shm`, `${name}-journal`, `${name}.lock`, `${name}.rolled-back`, `${name}.rolled-back.prev`].join(', ') + ` and ${name}${FOLDER_MARK_SUFFIX}`, copies: basename(moveCopyFolder(own)) };
}

/** What the mark itself says, for whoever finds it in the folder. */
function markNote(own: string): string {
  const { copies } = namedFor(own);
  return `Hatchabot's install on this database writes this file at each start: it keeps its other files in this folder, beside the database. Another install's database in this folder would overwrite them (${SHARED_FOLDER_ENTRY}). When this database moves to a folder of its own, the files named for it go with it, this one among them, and so does its folder ${copies}, if there is one. When no install uses this database any more, delete this file, or the database.`;
}

/** The mark beside `dbPath`: in the folder the app's files go to (the database's path as given, links not followed). */
export function folderMarkPath(dbPath: string): string {
  return `${resolve(dbPath)}${FOLDER_MARK_SUFFIX}`;
}

/**
 * The other databases in `dbPath`'s folder that an install marked it for
 * (a mark beside them, and the database there): their installs write the
 * same files beside them as this one. Read only; an unreadable folder has none.
 */
export function otherInstallsHere(dbPath: string): string[] {
  const own = resolve(dbPath);
  const dir = dirname(own);
  let ownFile: { dev: number; ino: number } | undefined;
  try { const s = statSync(own); ownFile = { dev: s.dev, ino: s.ino }; } catch { /* not made yet: its name is all it has */ }
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const others: string[] = [];
  for (const n of names.sort()) {
    if (!n.endsWith(FOLDER_MARK_SUFFIX) || n.length === FOLDER_MARK_SUFFIX.length) continue;
    const db = join(dir, n.slice(0, -FOLDER_MARK_SUFFIX.length));
    if (db === own) continue;
    let s;
    try { s = statSync(db); } catch { continue; } // its database is gone: a stale mark
    if (!s.isFile()) continue;
    if (ownFile && s.dev === ownFile.dev && s.ino === ownFile.ino) continue; // another name for this one
    others.push(db);
  }
  return others;
}

export interface FolderMark {
  /** The other installs' databases in this folder (otherInstallsHere). */
  others: string[];
  /** The mark could not be written, and why: another install in the folder is then not told of this one. */
  unwritten?: string;
}

/**
 * At start, after the database is open: marks the folder for `dbPath` and
 * says which other installs' databases are in it. The mark is written whole
 * or not at all (a file of its own, then renamed), with the database's own
 * permissions, 0600 (or 0644 where the database is readable to others), and
 * only when it does not already say this. A folder it cannot be written in
 * (read only) is said, never a reason not to start. A mark's own temporary
 * file left by a start that ended between its write and its rename is
 * removed first: under the instance lock no other process writes one for
 * this database (scripts/uninstall.sh's rm_db removes them too).
 */
export function markFolder(dbPath: string): FolderMark {
  // An in-memory database has no folder.
  if (dbPath === ':memory:') return { others: [] };
  const own = resolve(dbPath);
  const mark = folderMarkPath(own);
  const body = `${JSON.stringify({ database: own, note: markNote(own) })}\n`;
  removeStaleTemps(mark);
  let unwritten: string | undefined;
  let mine = false;
  try { mine = readFileSync(mark, 'utf8') === body; } catch { /* not there yet, or not readable: written */ }
  if (!mine) {
    const tmp = `${mark}.${process.pid}.tmp`;
    try {
      let mode = 0o600;
      try { if (statSync(own).mode & 0o044) mode = 0o644; } catch { /* no database to match: 0600 */ }
      writeFileSync(tmp, body, { mode });
      chmodSync(tmp, mode);
      renameSync(tmp, mark);
    } catch (err) {
      unwritten = (err as { code?: string }).code ?? String((err as Error)?.message ?? err);
      try { rmSync(tmp, { force: true }); } catch { /* never made */ }
    }
  }
  return { others: otherInstallsHere(own), ...(unwritten ? { unwritten } : {}) };
}

/** `<mark>.<pid>.tmp`: a temporary file of this database's mark, from any start. */
function removeStaleTemps(mark: string): void {
  const dir = dirname(mark), prefix = `${basename(mark)}.`;
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!n.startsWith(prefix) || !/^\d+\.tmp$/.test(n.slice(prefix.length))) continue;
    try { rmSync(join(dir, n), { force: true }); } catch { /* a folder it cannot write in: its write is said instead */ }
  }
}

/**
 * What the start logs and the doctor says of other installs' databases in
 * this one's folder. Memory search is named for what it does to the agents
 * (HB-1471): each install writes its own server key and its own agents' keys
 * into the one `embed/` (EmbedderService.syncKeys, at each start and build),
 * and the engine and door read whichever was written last, so the keys flip
 * between the installs and one's agents or the other's are refused. The
 * files are not keyed per database: the fix is one database moved out.
 */
export function sharedFolderWords(folder: string, others: readonly string[]): string {
  if (others.length === 1) {
    const [db] = others;
    return `Another Hatchabot install's database is in this install's data folder ${folder}: ${db}, which its install marked at its start with ${db}${FOLDER_MARK_SUFFIX}. The two installs keep the same files beside their databases, so each overwrites the other's. `
      + 'Memory search\'s keys are among them: they flip between the two installs as each starts or builds an agent, so memory search fails for one install\'s agents or the other\'s until one of the databases is moved out';
  }
  const named = others.length > 3 ? `${others.slice(0, 3).join(', ')} and ${others.length - 3} more` : others.join(', ');
  return `Other Hatchabot installs' databases are in this install's data folder ${folder}: ${named}, each marked at its install's start with a <database>${FOLDER_MARK_SUFFIX} file beside it. These installs keep the same files beside their databases, so each overwrites the others'. `
    + 'Memory search\'s keys are among them: they flip from one install to another as each starts or builds an agent, so memory search fails for all but one install\'s agents until each database is in a folder of its own';
}

/**
 * The fix, the same in the log and the doctor: this install's database
 * (`dbPath`) is the one moved, with what is named for it, which the words
 * name.
 */
export function sharedFolderFix(dbPath: string): string {
  const own = resolve(dbPath);
  const { files, copies } = namedFor(own);
  return `Stop this install. Move its database ${own} to a folder of its own, keeping its name, with the files named for it (${files}, whichever are there) and its folder ${copies}, if there is one (a move that was cut off left it, with an agent's tokens in it), and set HATCHABOT_DB to its new path. `
    + `Then copy into the new folder whichever of these the old one holds: ${BESIDE_DATABASE.slice(0, -1).join(', ')} and ${BESIDE_DATABASE.at(-1)}. `
    + 'Start it, and restart each install left in the old folder: each install\'s memory search keys are rebuilt from its own database at its next start. Then Rebuild any agent whose memory search still fails. '
    + `If no install uses another database there any more (a copy left behind, say), delete that database, or its ${FOLDER_MARK_SUFFIX} mark, instead. More: ${SHARED_FOLDER_ENTRY}`;
}
