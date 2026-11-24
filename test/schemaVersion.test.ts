import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { APP_VERSION } from '../src/domain/appVersion.js';
import {
  SCHEMA_STEPS, SCHEMA_VERSION, SchemaTooNewError, applySchemaSteps, checkSchemaVersion, schemaStanding, stepFingerprints,
  type SchemaStanding, type SchemaStep,
} from '../src/store/schemaVersion.js';
import { doctorReport, schemaFacts, schemaLine, type DoctorFacts } from '../src/doctor.js';

/**
 * The database's schema number (HB-0813, src/store/schemaVersion.ts).
 *
 * Three things are held here:
 *   - a database from before the number takes it with no change to its data;
 *   - a release meeting a database a NEWER release has changed runs with one
 *     warning when the newer steps only add, and refuses to start when one
 *     does not;
 *   - the step list only ever grows at its end.
 */

/**
 * The fingerprint of every step, one a line: `number fingerprint`.
 *
 * ADDING A STEP: append its line here (the failing test prints it). A line
 * that is here never changes: when the test says a step no longer matches,
 * the step was edited, moved or removed, and it must be put back — a
 * database that has run it will never run it again. Append a new step
 * instead.
 */
const RECORDED = `
1 b76f4464d53e
2 7cbbdb4b4ef5
3 8951e1e81626
4 5e6d434f6ae4
5 49b3d7f85d95
6 486d16936ad0
7 cc0cea18e62f
8 5032070195cc
9 d0016973269e
10 5f9bc907917b
11 497ac05ca31a
12 ea5d6261e4d2
13 2eb60ff63692
14 19c45c059845
15 800063708a53
16 2fc6fe2070b7
17 53d9092dd536
18 a1947768fe6f
19 5394ba7c3356
20 8f6cf141f253
21 9abf6f4ea7ba
22 16c388820a73
23 46325a710b67
24 3aa0a9efb052
25 a919aaedefff
26 befa1a9349bf
27 dbe64eda4f87
28 cdfe697d0d62
29 c21473363368
30 8b1eaa3d262d
31 e227459564c4
32 98fff40cc9a2
33 19660dfa1fc1
34 cd173f2cb1db
35 69b581473c48
36 f06fb954b7d3
37 ee8a3b7d7358
38 c365934d614b
39 dff7edbcd715
40 0a1a398d0327
41 0a9b48ab2a37
42 b5c09f009815
43 0dd340ba22a0
44 0fef2304b632
45 2819ab8c6372
46 93e8d220f5dd
47 0e09c2bd992f
48 15543a9d328d
49 ac8932077079
50 c02ccb95d815
51 3b3209b53560
52 bad100772fa9
53 e32ba2afac42
54 d376315a36a5
55 b810c8f14988
56 cfb70516fe67
57 a0b570fdabb7
58 9cba5a165533
59 51b95398a16e
60 7e9376ade94a
61 0e62d1263884
62 f271fafac9f1
63 c94c850d664e
64 1fc8fa55bd32
65 637b56981ef8
66 81b89b67c487
67 f0316020562b
68 604660309495
69 e650e3505d71
70 fb2319b6db67
71 67f44d95fad3
72 169196742152
73 73dff601cb74
74 d64b2a10c261
75 ad0a9ae24de4
76 248a3525c761
77 ec40942935c2
78 17ecfa4858b1
79 525d4957ba40
80 9694259dacce
81 a6538819fb31
82 7a5097b965f3
83 46d7b66d8667
84 8ad0027c98fa
85 079c35021d6b
86 022f943ed3b9
87 8c53558540d1
88 d5089d174ab3
89 ee6cf497d751
90 d5353e994ab8
91 ff4b8c7c70ea
92 3ec232831c66
93 16efd98be789
94 fae923c423a1
95 d889bb83748f
96 307b72daec84
97 2d406e02d7d8
98 bb0a5f11ae34
99 b9fee5206a7e
100 f115644f30ca
101 bbc8a87256be
102 8e3ddeb4aeab
103 f3c1a7982478
104 5232525e66bc
105 a5416e86be45
106 27ceb709b221
107 f3f12b13ae58
108 73f6bee44fdb
109 3598e36082ee
110 28e087e1fe58
111 9480a1e6f7a0
112 73e52a85e5d2
113 d7e240d89ee0
114 e1ef61f659f8
115 35ebc7605840
116 7af09496718b
`;

type Db = Database.Database;
const N = SCHEMA_VERSION;
const version = (db: Db): number => Number(db.pragma('user_version', { simple: true }));
const tablesOf = (db: Db): string[] =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>).map((t) => t.name);
const colsOf = (db: Db, table: string) => db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>;
const rowsOf = (db: Db, table: string, cols = '*'): unknown[] => db.prepare(`SELECT ${cols} FROM ${table} ORDER BY rowid`).all();
/**
 * Tables made since v2.190.0. A new table needs no step (`CREATE TABLE IF NOT
 * EXISTS` makes it on every database), so it is the one way the schema grows
 * without a line in RECORDED: named here, left out where a database is held
 * to the v2.190.0 schema, and held to its own text below.
 *   - agent_holds: what a restart may not lose for an agent (HB-0809).
 *   - adopt_carried_tasks: the scheduled tasks an adopt gave an agent (HB-0985).
 *   - ai_profile_tombstones: a deleted AI source, as its usage readings name it (HB-0931).
 *   - connection_cleanups: a deleted connection's token still to end, which
 *     the vault's pass tries again (HB-0901).
 *   - connection_removed: the accounts taken off an agent, and when, for a
 *     backup restored from before then (HB-1085).
 *   - practice_usage: what each skill Practice spent, per model (HB-0933).
 */
const TABLES_SINCE_2_190 = ['adopt_carried_tasks', 'agent_holds', 'ai_profile_tombstones', 'connection_cleanups', 'connection_removed', 'practice_usage'];
/**
 * The steps since v2.190.0 (its schema was step 112): a column or an index
 * each, added to a table v2.190.0 had. Where a database is held to the v2.190.0 schema,
 * it is held to that schema with these run on it, in order.
 *   - 113: agent_shares.parameters, a share's setup fields (HB-0960).
 *   - 114: an index on rate_hits.at, for its prune by time (HB-0836).
 */
const STEPS_SINCE_2_190 = SCHEMA_STEPS.filter((s) => s.n > 112);
/** v2.190.0's schema on disk, with the steps since run on it: what every database comes to. */
const sinceV2190 = (db: Db): Db => { for (const s of STEPS_SINCE_2_190) db.exec(s.sql); return db; };
/** Every table, index and their exact text, but for the record the numbered scheme adds and the tables made since v2.190.0. */
const schemaOf = (db: Db): unknown[] =>
  (db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'schema_steps' ORDER BY type, name`).all() as Array<{ tbl_name: string }>)
    .filter((o) => !TABLES_SINCE_2_190.includes(o.tbl_name));
const recordsOf = (db: Db) => rowsOf(db, 'schema_steps') as Array<{ step: number; additive: number; release: string; at: string }>;

/**
 * A database as an older release left it on disk: test/fixtures/schema-*.sql
 * is what that release's own Store wrote, and has no schema number.
 */
function legacyDb(release: 'v2.190.0' | 'v1.0.0'): Db {
  const db = new Database(':memory:');
  db.exec(readFileSync(`test/fixtures/schema-${release}.sql`, 'utf8'));
  return db;
}

/** Two made-up rows in every table that holds none, a value in every column. Returns the tables it filled. */
function fillEveryTable(db: Db, leaveOut: string[]): string[] {
  const filled: string[] = [];
  for (const table of tablesOf(db)) {
    if (leaveOut.includes(table) || rowsOf(db, table).length) continue;
    const cols = colsOf(db, table);
    const insert = db.prepare(`INSERT INTO ${table} (${cols.map((c) => c.name).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    let n = 0;
    for (let i = 0; i < 2; i++) {
      try {
        insert.run(...cols.map((c) => (/INT/i.test(c.type) ? i + 1 : /REAL/i.test(c.type) ? i + 1.5 : `${c.name}-${i}`)));
        n++;
      } catch { /* a table that takes one row (first_account) */ }
    }
    if (n) filled.push(table);
  }
  return filled;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('a database from before the schema had a number', () => {
  it('v2.190.0, every column there: takes the number with its schema and every row as they were', () => {
    const db = legacyDb('v2.190.0');
    try {
      expect(version(db)).toBe(0);
      // pairing_window is left empty: a start moves its rows to pairing_windows, as it always has.
      const filled = fillEveryTable(db, ['pairing_window']);
      expect(filled.length).toBeGreaterThanOrEqual(85);
      const was = legacyDb('v2.190.0');
      const before = {
        schema: schemaOf(sinceV2190(was)),
        rows: new Map(tablesOf(db).map((t) => [t, rowsOf(db, t)])),
        cols: new Map(tablesOf(db).map((t) => [t, colsOf(db, t).map((c) => c.name).join(', ')])),
      };
      was.close();
      /** Its rows, in the columns it had (a step since adds one, empty on them). */
      const rowsAsTheyWere = (table: string) => rowsOf(db, table, before.cols.get(table));

      new Store(db);

      expect(version(db)).toBe(N);
      expect(schemaOf(db)).toEqual(before.schema);
      expect(tablesOf(db).filter((t) => !before.rows.has(t))).toEqual([...TABLES_SINCE_2_190, 'schema_steps'].sort());
      for (const [table, rows] of before.rows) expect(rowsAsTheyWere(table), table).toEqual(rows);
      // Every step is recorded, by the release that numbered it.
      const records = recordsOf(db);
      expect(records.map((r) => r.step)).toEqual(SCHEMA_STEPS.map((s) => s.n));
      expect(records.every((r) => r.additive === 1 && r.release === APP_VERSION)).toBe(true);

      // The next start finds the number and runs nothing.
      expect(applySchemaSteps(db)).toBe(0);
      new Store(db);
      expect(version(db)).toBe(N);
      expect(recordsOf(db)).toEqual(records);
      expect(schemaOf(db)).toEqual(before.schema);
      for (const [table, rows] of before.rows) expect(rowsAsTheyWere(table), table).toEqual(rows);
    } finally { db.close(); }
  });

  it('v1.0.0, an old install with few of the columns: gets the rest, and its rows keep what they held', () => {
    const db = legacyDb('v1.0.0');
    try {
      expect(version(db)).toBe(0);
      expect(colsOf(db, 'agents').map((c) => c.name)).not.toContain('allow_knocks');
      // usage_snapshots is left empty: an install from before the readings were
      // re-based drops them once at its first start, as it always has.
      const filled = fillEveryTable(db, ['usage_snapshots']);
      expect(filled.length).toBeGreaterThanOrEqual(25);
      const before = new Map(tablesOf(db).map((t) => [t, { cols: colsOf(db, t).map((c) => c.name), rows: rowsOf(db, t) }]));

      new Store(db);

      expect(version(db)).toBe(N);
      expect(recordsOf(db).map((r) => r.step)).toEqual(SCHEMA_STEPS.map((s) => s.n));
      // The columns each table had hold what they held.
      for (const [table, b] of before) expect(rowsOf(db, table, b.cols.join(', ')), table).toEqual(b.rows);
      // The columns it was missing are there, at their defaults on the old rows.
      expect(rowsOf(db, 'agents', 'allow_knocks, browser_sites')).toEqual([{ allow_knocks: 0, browser_sites: null }, { allow_knocks: 0, browser_sites: null }]);
      // And it has every table and column a new database has.
      const fresh = new Database(':memory:');
      new Store(fresh);
      for (const table of tablesOf(fresh)) {
        expect(colsOf(db, table).map((c) => c.name), table).toEqual(expect.arrayContaining(colsOf(fresh, table).map((c) => c.name)));
      }
      fresh.close();
    } finally { db.close(); }
  });

  it('a new database gets the number at its first start, and the schema the release before made', () => {
    const db = new Database(':memory:');
    const legacy = sinceV2190(legacyDb('v2.190.0'));
    try {
      new Store(db);
      expect(version(db)).toBe(N);
      expect(schemaStanding(db)).toEqual({ kind: 'current', db: N, code: N });
      // Column for column what a new v2.190.0 database was, with the steps
      // since: the steps run in the order the ALTERs did.
      expect(schemaOf(db)).toEqual(schemaOf(legacy));
      // And the tables made since, which an upgraded database gets as a new one does.
      expect(tablesOf(db).filter((t) => !tablesOf(legacy).includes(t))).toEqual([...TABLES_SINCE_2_190, 'schema_steps'].sort());
      const upgraded = legacyDb('v2.190.0');
      try {
        new Store(upgraded);
        for (const t of TABLES_SINCE_2_190) expect(colsOf(upgraded, t), t).toEqual(colsOf(db, t));
      } finally { upgraded.close(); }
    } finally { db.close(); legacy.close(); }
  });
});

describe('running the steps', () => {
  const steps: SchemaStep[] = [
    { n: 1, additive: true, sql: `ALTER TABLE notes ADD COLUMN colour TEXT` },
    { n: 2, additive: true, sql: `ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0` },
    { n: 3, additive: true, sql: `ALTER TABLE notes ADD COLUMN folder TEXT` },
  ];
  const notesDb = (): Db => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT, colour TEXT)`);
    db.prepare(`INSERT INTO notes VALUES ('n1', 'water the tomatoes', 'green')`).run();
    return db;
  };

  it('runs each step once, in order, and only the ones a database has not had', () => {
    const db = notesDb();
    expect(schemaStanding(db, steps)).toEqual({ kind: 'behind', db: 0, code: 3 });
    // An earlier release with two steps: colour is already there and is recorded as done.
    expect(applySchemaSteps(db, steps.slice(0, 2), '9.1.0')).toBe(2);
    expect(version(db)).toBe(2);
    expect(schemaStanding(db, steps)).toEqual({ kind: 'behind', db: 2, code: 3 });
    // The next release runs the third alone.
    expect(applySchemaSteps(db, steps, '9.2.0')).toBe(1);
    expect(version(db)).toBe(3);
    expect(applySchemaSteps(db, steps, '9.3.0')).toBe(0);
    expect(recordsOf(db).map((r) => [r.step, r.additive, r.release])).toEqual([[1, 1, '9.1.0'], [2, 1, '9.1.0'], [3, 1, '9.2.0']]);
    expect(rowsOf(db, 'notes')).toEqual([{ id: 'n1', body: 'water the tomatoes', colour: 'green', pinned: 0, folder: null }]);
    db.close();
  });

  it('a step that fails leaves the database as it was: no step applied, no number, no record', () => {
    const db = notesDb();
    const broken: SchemaStep[] = [steps[1]!, { n: 2, additive: true, sql: `ALTER TABLE no_such_table ADD COLUMN x TEXT` }].map((s, i) => ({ ...s, n: i + 1 }));
    expect(() => applySchemaSteps(db, broken, '9.1.0')).toThrow(/no such table/);
    expect(version(db)).toBe(0);
    expect(tablesOf(db)).toEqual(['notes']);
    expect(colsOf(db, 'notes').map((c) => c.name)).toEqual(['id', 'body', 'colour']);
    db.close();
  });

  it('accepts "column already there" only from a step that adds one column', () => {
    const db = notesDb();
    const two: SchemaStep[] = [{ n: 1, additive: true, sql: `ALTER TABLE notes ADD COLUMN colour TEXT; ALTER TABLE notes ADD COLUMN folder TEXT` }];
    // Accepted here, the second statement would be skipped with the first.
    expect(() => applySchemaSteps(db, two, '9.1.0')).toThrow(/duplicate column name/);
    expect(version(db)).toBe(0);
    db.close();
  });

  it('refuses a list whose numbers are not its places', () => {
    const db = notesDb();
    expect(() => applySchemaSteps(db, [steps[0]!, steps[2]!], '9.1.0')).toThrow(/Schema step 2 is numbered 3/);
    expect(version(db)).toBe(0);
    db.close();
  });
});

describe('a database a newer release has changed', () => {
  // Steps a later release might add. A release that has them wrote this
  // database; the Store under test is this release, which does not.
  const NOTE: SchemaStep = { n: N + 1, additive: true, sql: `ALTER TABLE agents ADD COLUMN made_up_note TEXT` };
  const RANK: SchemaStep = { n: N + 2, additive: true, sql: `ALTER TABLE hosts ADD COLUMN made_up_rank INTEGER NOT NULL DEFAULT 0` };
  const RENAME: SchemaStep = { n: N + 3, additive: false, sql: `ALTER TABLE agents RENAME COLUMN made_up_note TO made_up_text` };
  function writtenByNewer(extra: SchemaStep[], release = '99.1.0'): Db {
    const db = new Database(':memory:');
    new Store(db);
    expect(applySchemaSteps(db, [...SCHEMA_STEPS, ...extra], release)).toBe(extra.length);
    return db;
  }
  /** A row a start moves (to pairing_windows): still here after a start that was refused. */
  const openWindow = (db: Db) => db.prepare(`INSERT INTO pairing_window (agent_id, until, opened_for, expect) VALUES ('agent-1', '2099-01-01T00:00:00.000Z', NULL, NULL)`).run();
  const everything = (db: Db) => ({ version: version(db), schema: schemaOf(db), rows: tablesOf(db).map((t) => [t, rowsOf(db, t)]) });

  it('newer by additive steps only: one warning, and it runs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = writtenByNewer([NOTE, RANK]);
    const records = recordsOf(db);

    const store = new Store(db);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `[store] This database was written by a newer Hatchabot (v99.1.0, schema ${N + 2}) than this one (v${APP_VERSION}, schema ${N}). `
      + `Schema steps ${N + 1} and ${N + 2} only add to it, so this release runs; what they added goes unused until the newer release is back. `
      + `Install v99.1.0 or newer (hatchabot upgrade v99.1.0) to use it.`,
    );
    // It reads and writes.
    store.setOperatorProfile('owner-1', 'Keeps the greenhouse.');
    expect(store.getOperatorProfile('owner-1')).toBe('Keeps the greenhouse.');
    expect(store.listAgents('owner-1')).toEqual([]);
    // The number and the record stay the newer release's, and so does what it added.
    expect(version(db)).toBe(N + 2);
    expect(recordsOf(db)).toEqual(records);
    expect(colsOf(db, 'agents').map((c) => c.name)).toContain('made_up_note');
    expect(colsOf(db, 'hosts').map((c) => c.name)).toContain('made_up_rank');
    db.close();
  });

  it('newer by one additive step: the warning names the one step', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = writtenByNewer([NOTE]);
    new Store(db);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(`Schema step ${N + 1} only adds to it, so this release runs; what it added goes unused`);
    db.close();
  });

  it('newer by a step that is not additive: refuses to start, names the release, and changes nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = writtenByNewer([NOTE, RANK, RENAME], '99.2.0');
    openWindow(db);
    const before = everything(db);

    let thrown: unknown;
    try { new Store(db); } catch (e) { thrown = e; }

    expect(thrown).toBeInstanceOf(SchemaTooNewError);
    expect((thrown as SchemaTooNewError).message).toBe(
      `This database was written by a newer Hatchabot (v99.2.0, schema ${N + 3}) than this one (v${APP_VERSION}, schema ${N}), `
      + `and schema step ${N + 3} changed it in a way this release cannot work with. `
      + `Hatchabot is not starting, and has changed nothing in the database. `
      + `Install v99.2.0 or newer (hatchabot upgrade v99.2.0).`,
    );
    expect((thrown as SchemaTooNewError).standing).toEqual({ kind: 'newer', db: N + 3, code: N, refused: true, writtenBy: '99.2.0', notAdditive: [N + 3], unrecorded: [] });
    expect(warn).not.toHaveBeenCalled();
    expect(everything(db)).toEqual(before);
    expect(rowsOf(db, 'pairing_window')).toHaveLength(1);
    db.close();
  });

  it('a number past this release with no record of the steps: refuses, since nothing says they are safe', () => {
    const db = new Database(':memory:');
    new Store(db);
    db.pragma(`user_version = ${N + 2}`);
    expect(() => new Store(db)).toThrow(SchemaTooNewError);
    expect(() => new Store(db)).toThrow(
      `This database was written by a newer Hatchabot (schema ${N + 2}) than this one (v${APP_VERSION}, schema ${N}), `
      + `and nothing in it records what schema steps ${N + 1} and ${N + 2} did, so this release cannot tell that it is safe to run. `
      + `Hatchabot is not starting, and has changed nothing in the database. `
      + `Install the release that wrote it, or newer (hatchabot upgrade).`,
    );
    db.close();
  });

  it('a copy that lost its number (dumped and reloaded) is still judged by its record', () => {
    const db = writtenByNewer([NOTE, RANK, RENAME], '99.2.0');
    db.pragma('user_version = 0');
    expect(schemaStanding(db)).toMatchObject({ kind: 'newer', db: N + 3, refused: true, notAdditive: [N + 3] });
    expect(() => new Store(db)).toThrow(SchemaTooNewError);
    expect(version(db)).toBe(0);
    db.close();
  });

  it('the check alone: this release\'s database against the list of a release two steps older', () => {
    const db = new Database(':memory:');
    new Store(db);
    const older = SCHEMA_STEPS.slice(0, N - 2);
    const said: string[] = [];
    const standing = checkSchemaVersion(db, older, { release: '2.190.0', warn: (m) => said.push(m) });
    expect(standing).toEqual({ kind: 'newer', db: N, code: N - 2, refused: false, writtenBy: APP_VERSION, notAdditive: [], unrecorded: [] });
    expect(said).toEqual([
      `This database was written by a newer Hatchabot (v${APP_VERSION}, schema ${N}) than this one (v2.190.0, schema ${N - 2}). `
      + `Schema steps ${N - 1} and ${N} only add to it, so this release runs; what they added goes unused until the newer release is back. `
      + `Install v${APP_VERSION} or newer (hatchabot upgrade v${APP_VERSION}) to use it.`,
    ]);
    // And the older release's steps do not run against it.
    expect(applySchemaSteps(db, older, '2.190.0')).toBe(0);
    expect(version(db)).toBe(N);
    db.close();
  });
});

describe('hatchabot doctor: the database schema line', () => {
  const facts = (schema: SchemaStanding | undefined): DoctorFacts => ({
    nodeVersion: 'v22.22.2', dockerCli: true, dockerDaemon: { ok: true, arch: 'arm64', version: '27.1' },
    runtimeImage: { openclawVersion: '2026.9.8', sizeGb: 1.97 },
    envFile: { present: true, secretKey: true, password: true, authMode: 'password', publicUrl: 'https://hatchabot.example' },
    db: { path: '/x/hatchabot.sqlite', present: true, sizeMb: 10, schema },
    service: { manager: 'systemd', active: true, enabled: true },
    controlPlane: { url: 'http://localhost:8080', ok: true, version: '2.191.0' },
    diskFreeGb: 120, backups: { dir: '/b', lastSet: '2026-11-21', ageDays: 0 },
  });

  it('says the number when it is this release\'s, and when the next start will bring it up', () => {
    expect(schemaLine({ kind: 'current', db: 112, code: 112 })).toEqual({ level: 'ok', text: `Database schema 112 (this release's)` });
    expect(schemaLine({ kind: 'behind', db: 110, code: 112 })).toEqual({ level: 'ok', text: `Database schema 110; this release's is 112, and the next start brings it up` });
    expect(schemaLine({ kind: 'behind', db: 0, code: 112 })).toEqual({ level: 'ok', text: `Database schema not numbered yet; the next start numbers it (112)` });
  });

  it('warns of a database newer by additive steps, with the release to install', () => {
    expect(schemaLine({ kind: 'newer', db: 114, code: 112, refused: false, writtenBy: '99.1.0', notAdditive: [], unrecorded: [] })).toEqual({
      level: 'warn',
      text: `Database schema 114 (written by v99.1.0) is newer than this release's 112: steps 113 and 114 only add to it, so this release runs, and what was added goes unused`,
      fix: 'Install v99.1.0 or newer (hatchabot upgrade v99.1.0) to use it',
    });
  });

  it('fails on one newer by a step that is not additive: the start refuses it', () => {
    const refused: SchemaStanding = { kind: 'newer', db: 115, code: 112, refused: true, writtenBy: '99.2.0', notAdditive: [115], unrecorded: [] };
    const line = {
      level: 'fail',
      text: `Database schema 115 (written by v99.2.0) is newer than this release's 112, and step 115 changed it in a way this release cannot work with: Hatchabot does not start on it`,
      fix: 'Install v99.2.0 or newer (hatchabot upgrade v99.2.0); or restore a backup of the database made before that upgrade (docs/troubleshooting.md)',
    };
    expect(schemaLine(refused)).toEqual(line);
    expect(doctorReport(facts(refused))).toContainEqual(line);
    expect(schemaLine({ kind: 'newer', db: 114, code: 112, refused: true, notAdditive: [], unrecorded: [113, 114] })).toEqual({
      level: 'fail',
      text: `Database schema 114 is newer than this release's 112, and nothing in it records what steps 113 and 114 did: Hatchabot does not start on it`,
      fix: 'Install the release that wrote it, or newer (hatchabot upgrade); or restore a backup of the database made before that upgrade (docs/troubleshooting.md)',
    });
  });

  it('a healthy report carries the line, and one with no reading leaves it out', () => {
    const lines = doctorReport(facts({ kind: 'current', db: 112, code: 112 }));
    expect(lines.every((l) => l.level === 'ok')).toBe(true);
    expect(lines.map((l) => l.text)).toContain(`Database schema 112 (this release's)`);
    expect(doctorReport(facts(undefined)).some((l) => /schema/.test(l.text))).toBe(false);
  });

  it('reads the standing from the file without changing it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-schema-'));
    try {
      const path = join(dir, 'hatchabot.sqlite');
      const db = new Database(path);
      new Store(db);
      expect(await schemaFacts(path)).toEqual({ kind: 'current', db: N, code: N });
      applySchemaSteps(db, [...SCHEMA_STEPS, { n: N + 1, additive: false, sql: `ALTER TABLE agents RENAME COLUMN icon TO made_up_icon` }], '99.2.0');
      expect(await schemaFacts(path)).toEqual({ kind: 'newer', db: N + 1, code: N, refused: true, writtenBy: '99.2.0', notAdditive: [N + 1], unrecorded: [] });
      expect(version(db)).toBe(N + 1);
      db.close();
      // No file, and a file that is not a database: no reading, and no throw.
      expect(await schemaFacts(join(dir, 'missing.sqlite'))).toBeUndefined();
      writeFileSync(join(dir, 'notes.sqlite'), 'not a database, only some text that is long enough to be read as a header');
      expect(await schemaFacts(join(dir, 'notes.sqlite'))).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/**
 * What is wrong between a step list and the recorded fingerprints, in the
 * words the developer needs. Empty when the list is the recorded one, or
 * the recorded one with new steps whose lines were added.
 */
function fingerprintProblems(steps: readonly SchemaStep[], recorded: readonly string[]): string[] {
  const out: string[] = [];
  steps.forEach((s, i) => { if (s.n !== i + 1) out.push(`Step ${i + 1} is numbered ${s.n}: a step's number is its place in SCHEMA_STEPS.`); });
  const now = stepFingerprints(steps);
  const changed = recorded.findIndex((r, i) => i < now.length && now[i] !== r);
  if (changed >= 0) {
    out.push(`Step ${changed + 1} is not the step that was recorded: it was edited, moved or removed, or a step was put in before the end. `
      + `A database that has run step ${changed + 1} will never run it again. Put SCHEMA_STEPS back as it was and append a new step.`);
    return out;
  }
  if (now.length < recorded.length) out.push(`Steps ${now.length + 1} to ${recorded.length} were removed from the end of SCHEMA_STEPS: databases have run them. Put them back.`);
  for (let i = recorded.length; i < now.length; i++) out.push(`Step ${i + 1} is new: append this line to RECORDED in test/schemaVersion.test.ts:  ${i + 1} ${now[i]}`);
  return out;
}

describe('the step list only grows at its end', () => {
  const lines = RECORDED.trim().split('\n').map((l) => l.trim().split(' '));
  const recorded = lines.map((l) => l[1]!);

  it('the recorded lines are numbered 1, 2, 3 …', () => {
    expect(lines.map((l) => Number(l[0]))).toEqual(lines.map((_, i) => i + 1));
    expect(recorded.every((f) => /^[0-9a-f]{12}$/.test(f))).toBe(true);
  });

  it('every step is the one that was recorded, and every step is recorded', () => {
    expect(fingerprintProblems(SCHEMA_STEPS, recorded)).toEqual([]);
    expect(SCHEMA_STEPS.map((s) => s.n)).toEqual(SCHEMA_STEPS.map((_, i) => i + 1));
  });

  it('catches an edited, re-marked, reordered, inserted or removed step, and says what to add for a new one', () => {
    const steps = [...SCHEMA_STEPS];
    const at = (i: number, s: Partial<SchemaStep>) => steps.map((x, j) => (j === i ? { ...x, ...s } : x));
    expect(fingerprintProblems(at(4, { sql: `${steps[4]!.sql} DEFAULT 'x'` }), recorded)[0]).toMatch(/^Step 5 is not the step that was recorded/);
    expect(fingerprintProblems(at(36, { additive: false }), recorded)[0]).toMatch(/^Step 37 is not the step that was recorded/);
    const swapped = steps.map((x, j) => (j === 9 ? { ...steps[10]!, n: 10 } : j === 10 ? { ...steps[9]!, n: 11 } : x));
    expect(fingerprintProblems(swapped, recorded)[0]).toMatch(/^Step 10 is not the step that was recorded/);
    const inserted = [...steps.slice(0, 50), { n: 51, additive: true, sql: `ALTER TABLE agents ADD COLUMN made_up TEXT` }, ...steps.slice(50).map((x) => ({ ...x, n: x.n + 1 }))];
    expect(fingerprintProblems(inserted, recorded)[0]).toMatch(/^Step 51 is not the step that was recorded/);
    expect(fingerprintProblems(steps.slice(0, -2), recorded)).toEqual([`Steps ${N - 1} to ${N} were removed from the end of SCHEMA_STEPS: databases have run them. Put them back.`]);
    const appended = [...steps, { n: N + 1, additive: true, sql: `ALTER TABLE agents ADD COLUMN made_up TEXT` }];
    expect(fingerprintProblems(appended, recorded)).toEqual([
      `Step ${N + 1} is new: append this line to RECORDED in test/schemaVersion.test.ts:  ${N + 1} ${stepFingerprints(appended).at(-1)}`,
    ]);
    // Once its line is added, the longer list passes, and the first 112 fingerprints are what they were.
    expect(fingerprintProblems(appended, [...recorded, stepFingerprints(appended).at(-1)!])).toEqual([]);
    expect(stepFingerprints(appended).slice(0, N)).toEqual(recorded);
    expect(fingerprintProblems(steps.map((x, j) => (j === 2 ? { ...x, n: 30 } : x)), recorded)[0]).toBe(`Step 3 is numbered 30: a step's number is its place in SCHEMA_STEPS.`);
  });
});
