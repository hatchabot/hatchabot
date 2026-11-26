import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BESIDE_DATABASE, FOLDER_MARK_SUFFIX, folderMarkPath, markFolder, moveCopyFolder, otherInstallsHere, sharedFolderFix } from '../src/store/folderMark.js';
import { dropMoveCopy, newMoveCopy } from '../src/orchestrator/backups/backupFiles.js';
import { dbSharedWith, doctorReport, type DoctorFacts } from '../src/doctor.js';

// Two installs whose databases share one folder write the same files beside
// them (HB-1151): each marks the folder at its start, and another install's
// mark, its database there, is said at the start and by the doctor.

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) { try { chmodSync(d, 0o700); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); }
});
const folder = () => { const d = mkdtempSync(join(tmpdir(), 'hb-folder-mark-')); dirs.push(d); return d; };
/** A database file, as the server has opened it by the time it marks the folder (0600, as src/index.ts leaves it). */
const db = (dir: string, name: string, mode = 0o600) => { const p = join(dir, name); writeFileSync(p, 'made-up database', { mode }); chmodSync(p, mode); return p; };
const asRoot = process.getuid?.() === 0;
/** A database's move-copies folder, by the formula the uninstaller and its test use (scriptsUninstall.test.ts). */
const COPIES = (name: string) => `move-copies-${createHash('sha256').update(name).digest('hex').slice(0, 16)}`;

describe("a data folder another install's database shares (HB-1151)", () => {
  it("each install's start marks the folder, and finds the other's database by its mark", () => {
    const dir = folder();
    const one = db(dir, 'hatchabot.sqlite'), two = db(dir, 'two.sqlite');
    expect(markFolder(one)).toEqual({ others: [] });
    expect(JSON.parse(readFileSync(folderMarkPath(one), 'utf8'))).toEqual({
      database: one,
      note: `Hatchabot's install on this database writes this file at each start: it keeps its other files in this folder, beside the database. Another install's database in this folder would overwrite them (docs/troubleshooting.md, "Two installs share one data folder"). When this database moves to a folder of its own, the files named for it go with it, this one among them, and so does its folder ${COPIES('hatchabot.sqlite')}, if there is one. When no install uses this database any more, delete this file, or the database.`,
    });
    expect(markFolder(two)).toEqual({ others: [one] });
    // The first is told at its next start, and by its doctor, whichever started last.
    expect(markFolder(one)).toEqual({ others: [two] });
    expect(dbSharedWith(one)).toEqual({ folder: dir, others: [two] });
    expect(dbSharedWith(two)).toEqual({ folder: dir, others: [one] });
  });

  it("its own mark, and a stale one whose database is gone, say nothing; nor does another file of that ending", () => {
    const dir = folder();
    const one = db(dir, 'hatchabot.sqlite'), gone = db(dir, 'old.sqlite');
    markFolder(gone);
    rmSync(gone);
    writeFileSync(join(dir, `notes${FOLDER_MARK_SUFFIX}`), 'no database by that name');
    expect(markFolder(one)).toEqual({ others: [] });
    expect(markFolder(one)).toEqual({ others: [] });
    expect(dbSharedWith(one)).toBeUndefined();
  });

  it('another name for its own database (a link to it) is its own', () => {
    const dir = folder();
    const one = db(dir, 'hatchabot.sqlite');
    const link = join(dir, 'agentclaw.sqlite');
    symlinkSync(one, link);
    markFolder(link);
    expect(markFolder(one)).toEqual({ others: [] });
    expect(otherInstallsHere(link)).toEqual([]);
  });

  it('the mark has the permissions of the database beside it, and is written whole: no part is left', () => {
    const dir = folder();
    const one = db(dir, 'hatchabot.sqlite', 0o600), two = db(dir, 'two.sqlite', 0o644);
    markFolder(one); markFolder(two);
    expect(statSync(folderMarkPath(one)).mode & 0o777).toBe(0o600);
    expect(statSync(folderMarkPath(two)).mode & 0o777).toBe(0o644);
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it("a temporary file of its own mark that a start left (ended between its write and its rename) goes at the next start; another database's, and other files, stay", () => {
    const dir = folder();
    const one = db(dir, 'hatchabot.sqlite'), two = db(dir, 'two.sqlite');
    const left = [`${folderMarkPath(one)}.4242.tmp`, `${folderMarkPath(one)}.${process.pid}.tmp`];
    const kept = [`${folderMarkPath(two)}.4242.tmp`, `${folderMarkPath(one)}.notes.tmp`, `${folderMarkPath(one)}.4242.tmp.bak`];
    for (const f of [...left, ...kept]) writeFileSync(f, 'half a mark');
    // Its mark already saying this: the leftovers go all the same.
    markFolder(one);
    for (const f of left) writeFileSync(f, 'half a mark');
    expect(markFolder(one)).toEqual({ others: [] });
    for (const f of left) expect(existsSync(f), f).toBe(false);
    for (const f of kept) expect(existsSync(f), f).toBe(true);
    expect(existsSync(folderMarkPath(one))).toBe(true);
  });

  it.skipIf(asRoot)("a folder it cannot write in is said, never thrown, and the other install's database is still found", () => {
    const dir = folder();
    const one = db(dir, 'hatchabot.sqlite'), two = db(dir, 'two.sqlite');
    markFolder(two);
    chmodSync(dir, 0o500);
    expect(markFolder(one)).toEqual({ others: [two], unwritten: 'EACCES' });
    expect(existsSync(folderMarkPath(one))).toBe(false);
    // Its mark already there and saying this: nothing to write, nothing to say.
    chmodSync(dir, 0o700);
    markFolder(one);
    chmodSync(dir, 0o500);
    expect(markFolder(one)).toEqual({ others: [two] });
  });

  it('two installs starting at once: the second to look sees the first, and both doctors see both', async () => {
    for (let round = 0; round < 3; round++) {
      const dir = folder();
      const one = db(dir, 'hatchabot.sqlite'), two = db(dir, 'two.sqlite');
      const at = Date.now() + 2500;
      const start = (p: string) => new Promise<{ others: string[] }>((done, fail) => {
        // Each waits for the same moment, then marks the folder, as a start does.
        const code = `import { markFolder } from ${JSON.stringify(resolve('src/store/folderMark.ts'))};
while (Date.now() < ${at}) {}
console.log('MARK ' + JSON.stringify(markFolder(${JSON.stringify(p)})));`;
        execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: resolve('.'), encoding: 'utf8', timeout: 60_000 }, (err, stdout, stderr) => {
          const line = String(stdout).split('\n').find((l) => l.startsWith('MARK '));
          if (!line) return fail(new Error(`no answer: ${err?.message ?? ''} ${stderr}`));
          done(JSON.parse(line.slice('MARK '.length)));
        });
      });
      const [a, b] = await Promise.all([start(one), start(two)]);
      expect(a.others.includes(two) || b.others.includes(one), JSON.stringify([a, b])).toBe(true);
      expect(dbSharedWith(one)?.others).toEqual([two]);
      expect(dbSharedWith(two)?.others).toEqual([one]);
    }
  }, 120_000);

  it('the doctor fails with the fix; alone in its folder it says nothing of it', () => {
    const facts: DoctorFacts = {
      nodeVersion: 'v22.0.0', dockerCli: true, dockerDaemon: { ok: false }, envFile: { present: true, secretKey: true, password: true, authMode: 'accounts' },
      db: { path: '/made-up/shared/two.sqlite', present: true, sharedWith: { folder: '/made-up/shared', others: ['/made-up/shared/hatchabot.sqlite'] } },
      service: { manager: 'none' }, controlPlane: { url: 'http://localhost:8080', ok: true }, backups: { dir: '/made-up/backups' },
    };
    expect(doctorReport(facts).filter((l) => /data folder/.test(l.text))).toEqual([{
      level: 'fail',
      text: "Another Hatchabot install's database is in this install's data folder /made-up/shared: /made-up/shared/hatchabot.sqlite, which its install marked at its start with /made-up/shared/hatchabot.sqlite.uses-this-folder. The two installs keep the same files beside their databases, the memory search service's keys among them, so each overwrites the other's",
      fix: sharedFolderFix('/made-up/shared/two.sqlite'),
    }]);
    expect(sharedFolderFix('/made-up/shared/two.sqlite')).toBe(`Stop this install. Move its database /made-up/shared/two.sqlite to a folder of its own, keeping its name, with the files named for it (two.sqlite-wal, two.sqlite-shm, two.sqlite-journal, two.sqlite.lock, two.sqlite.rolled-back, two.sqlite.rolled-back.prev and two.sqlite.uses-this-folder, whichever are there) and its folder ${COPIES('two.sqlite')}, if there is one (a move that was cut off left it, with an agent's tokens in it), and set HATCHABOT_DB to its new path. `
      + 'Then copy into the new folder whichever of these the old one holds: embed, embed-hosts, models, derived-builds, release-manifests, app-sources, mgmt-cli-home and limits-check.json. '
      + 'Start it, and restart each install left in the old folder: each install\'s memory search keys are rebuilt from its own database at its next start. Then Rebuild any agent whose memory search still fails. '
      + 'If no install uses another database there any more (a copy left behind, say), delete that database, or its .uses-this-folder mark, instead. More: docs/troubleshooting.md, "Two installs share one data folder"');
    const several = doctorReport({ ...facts, db: { ...facts.db, sharedWith: { folder: '/made-up/shared', others: ['/made-up/shared/a.sqlite', '/made-up/shared/b.sqlite'] } } });
    expect(several.filter((l) => /data folder/.test(l.text)).map((l) => l.text)).toEqual([
      "Other Hatchabot installs' databases are in this install's data folder /made-up/shared: /made-up/shared/a.sqlite, /made-up/shared/b.sqlite, each marked at its install's start with a <database>.uses-this-folder file beside it. These installs keep the same files beside their databases, the memory search service's keys among them, so each overwrites the others'",
    ]);
    expect(doctorReport({ ...facts, db: { path: '/made-up/shared/two.sqlite', present: true } }).filter((l) => /data folder/.test(l.text))).toEqual([]);
  });

  it("the move-copies folder the words name is the one a move uses, and the uninstaller removes", () => {
    const dir = folder();
    const one = db(dir, 'hatchabot.sqlite');
    expect(moveCopyFolder(one)).toBe(join(dir, COPIES('hatchabot.sqlite')));
    vi.stubEnv('HATCHABOT_DB', one);
    const copy = newMoveCopy();
    try { expect(dirname(copy)).toBe(moveCopyFolder(one)); } finally { dropMoveCopy(copy); }
    expect(existsSync(moveCopyFolder(one))).toBe(false);
  });

  it("the files the fix says to copy are the ones the uninstaller knows the app keeps beside its database", () => {
    const sh = readFileSync(new URL('../scripts/uninstall.sh', import.meta.url), 'utf8');
    const listed = /^\s*BESIDE_DB="([^"]+)"$/m.exec(sh)?.[1]?.split(' ');
    expect([...BESIDE_DATABASE].sort()).toEqual(listed?.sort());
  });

  it('src/index.ts marks the folder at start once its log is there, inside a guard, and says both findings', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const at = src.indexOf('markFolder(DB_PATH)');
    expect(at).toBeGreaterThan(src.indexOf('const app = Fastify('));
    expect(at).toBeGreaterThan(src.indexOf('const db = new Database(DB_PATH)'));
    expect(src.lastIndexOf('try {', at)).toBeGreaterThan(src.indexOf('const app = Fastify('));
    expect(src).toContain('data.folder_shared: ${sharedFolderWords(folder, marked.others)}. ${sharedFolderFix(DB_PATH)}');
    expect(src).toContain('data.folder_mark_unwritten: ');
  });
});
