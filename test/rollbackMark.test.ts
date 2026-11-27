import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { HOLDS_AFTER_ROLLBACK, ROLLBACK_DROPS, restampRollbackMark, rollbackMarkPath, takeRollbackMark } from '../src/store/rollbackMark.js';

/**
 * HB-0840: a rollback leaves its time beside the database (the scripts:
 * test/scriptsUpgrade.test.ts, test/bundleUpgrade.test.ts,
 * test/scriptsFollow.test.ts, test/restartProbe.test.ts), and the next start
 * lets go of the holds kept before it that would change an agent if served
 * (HOLDS_AFTER_ROLLBACK). The restart in the middle of a hold
 * is in test/holdsAcrossRestart.test.ts. The data is made up.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function place() {
  const dir = mkdtempSync(join(tmpdir(), 'hb-rollback-')); dirs.push(dir);
  const dbPath = join(dir, 'hatchabot.sqlite');
  const store = new Store(new Database(dbPath));
  return { dir, dbPath, store, mark: rollbackMarkPath(dbPath) };
}
const kept = (s: Store, at: string, agentId: string, kind: Parameters<Store['setAgentHold']>[1], value = 'x') => {
  s.setAgentHold(agentId, kind, value);
  (s as unknown as { db: Database.Database }).db.prepare('UPDATE agent_holds SET at = ? WHERE agent_id = ? AND kind = ?').run(at, agentId, kind);
};

describe('the rollback note beside the database (HB-0840)', () => {
  it('is beside the database, as its lock is', () => {
    expect(rollbackMarkPath('/srv/hb/data/hatchabot.sqlite')).toBe('/srv/hb/data/hatchabot.sqlite.rolled-back');
  });

  it('with no note, nothing is let go of', () => {
    const p = place();
    kept(p.store, '2026-11-01T10:00:00.000Z', 'a1', 'model-apply');
    expect(takeRollbackMark(p.store, p.dbPath)).toBeUndefined();
    expect(p.store.agentHold('a1', 'model-apply')).toBe('x');
  });

  it('the holds kept before its time that would change an agent go; the others, and every one kept since, stay; the note goes too', () => {
    const p = place();
    kept(p.store, '2026-11-01T10:00:00.000Z', 'a1', 'model-apply', 'claude-haiku-4-5');
    kept(p.store, '2026-11-01T10:00:01.000Z', 'a1', 'class-detach', 'c1');
    kept(p.store, '2026-11-01T10:00:02.000Z', 'a2', 'budget-pause', 'p1');
    // Kept though older: facts, refusals, watches with their own clocks, guards, harmless work.
    kept(p.store, '2026-11-01T10:00:03.000Z', 'a2', 'pending-joins', '[]');
    kept(p.store, '2026-11-01T10:00:04.000Z', 'a2', 'first-contact', '{}');
    kept(p.store, '2026-11-01T10:00:05.000Z', 'a3', 'skip-pool', '1');
    kept(p.store, '2026-11-01T10:00:06.000Z', 'a3', 'embed-reindex', '1');
    kept(p.store, '2026-11-01T10:00:07.000Z', 'a3', 'docs-sync', 'ask-1');
    kept(p.store, '2026-11-01T10:00:08.000Z', 'a3', 'model-waits-image', 'claude-sonnet-5');
    writeFileSync(p.mark, '2026-11-03T09:00:00Z\n');
    const r = takeRollbackMark(p.store, p.dbPath)!;
    expect(r.before).toBe('2026-11-03T09:00:00.000Z');
    expect(r.dropped).toEqual([
      { agentId: 'a1', kind: 'model-apply', at: '2026-11-01T10:00:00.000Z' },
      { agentId: 'a1', kind: 'class-detach', at: '2026-11-01T10:00:01.000Z' },
      { agentId: 'a2', kind: 'budget-pause', at: '2026-11-01T10:00:02.000Z' },
    ]);
    expect(r.unread).toBeUndefined();
    expect(p.store.agentHold('a1', 'model-apply')).toBeUndefined();
    expect(p.store.agentHold('a1', 'class-detach')).toBeUndefined();
    expect(p.store.agentHold('a2', 'budget-pause')).toBeUndefined();
    expect([
      p.store.agentHold('a2', 'pending-joins'), p.store.agentHold('a2', 'first-contact'), p.store.agentHold('a3', 'skip-pool'),
      p.store.agentHold('a3', 'embed-reindex'), p.store.agentHold('a3', 'docs-sync'), p.store.agentHold('a3', 'model-waits-image'),
    ]).toEqual(['[]', '{}', '1', '1', 'ask-1', 'claude-sonnet-5']);
    expect(existsSync(p.mark)).toBe(false);
    // Once: the next start has nothing to do.
    kept(p.store, '2026-11-01T10:00:00.000Z', 'a4', 'model-apply');
    expect(takeRollbackMark(p.store, p.dbPath)).toBeUndefined();
    expect(p.store.agentHold('a4', 'model-apply')).toBe('x');
  });

  it('back from 2.191.0, which knows the holds but not the note: what it kept after the note is kept, of every kind', () => {
    // 2.192.0 kept these, then rolled back to 2.191.0, writing the note.
    const p = place();
    kept(p.store, '2026-12-01T10:00:00.000Z', 'a1', 'model-apply', 'claude-haiku-4-5');
    kept(p.store, '2026-12-01T10:00:00.000Z', 'a2', 'class-detach', 'c1');
    writeFileSync(p.mark, '2026-12-01T10:05:00Z\n');
    // 2.191.0 runs for days: it never reads the note, and keeps holds of its own, valid ones, after its time.
    kept(p.store, '2026-12-03T08:00:00.000Z', 'a3', 'model-apply', 'claude-sonnet-5');
    kept(p.store, '2026-12-03T08:00:01.000Z', 'a4', 'class-detach', 'c2');
    kept(p.store, '2026-12-03T08:00:02.000Z', 'a5', 'budget-pause', 'p1');
    kept(p.store, '2026-12-03T08:00:03.000Z', 'a5', 'docs-sync', 'ask-2');
    // Upgraded to 2.192.0 again: only 2.192.0's own, from before the rollback, go.
    const r = takeRollbackMark(p.store, p.dbPath)!;
    expect(r.dropped.map((h) => [h.agentId, h.kind])).toEqual([['a1', 'model-apply'], ['a2', 'class-detach']]);
    expect([
      p.store.agentHold('a3', 'model-apply'), p.store.agentHold('a4', 'class-detach'), p.store.agentHold('a5', 'budget-pause'), p.store.agentHold('a5', 'docs-sync'),
    ]).toEqual(['claude-sonnet-5', 'c2', 'p1', 'ask-2']);
  });

  it('a hold of a kind this release does not know, kept before the note (a later release\'s): its own kinds go, and the note stays for the release that knows that kind, which lets go of it and removes the note (review of HB-0840)', () => {
    const p = place();
    const db = (p.store as unknown as { db: Database.Database }).db;
    // A later release's kind, which it lets go of after a rollback; and one it keeps.
    const later = (agentId: string, kind: string, at: string) => db.prepare('INSERT INTO agent_holds (agent_id, kind, value, at) VALUES (?, ?, ?, ?)').run(agentId, kind, 'v', at);
    later('a1', 'later-apply', '2026-11-02T08:00:00.000Z');
    later('a2', 'later-watch', '2026-11-02T08:00:01.000Z');
    kept(p.store, '2026-11-02T08:00:02.000Z', 'a1', 'model-apply');
    writeFileSync(p.mark, '2026-11-03T09:00:00Z\n');
    const r = takeRollbackMark(p.store, p.dbPath)!;
    expect(r.dropped).toEqual([{ agentId: 'a1', kind: 'model-apply', at: '2026-11-02T08:00:02.000Z' }]);
    expect(r.keptFor).toEqual(['later-apply', 'later-watch']);
    expect(existsSync(p.mark)).toBe(true);
    // Its own hold kept since: the next start of this release takes the note again and lets go of nothing more.
    p.store.setAgentHold('a1', 'model-apply', 'kept since');
    const again = takeRollbackMark(p.store, p.dbPath)!;
    expect(again.dropped).toEqual([]);
    expect(again.keptFor).toEqual(['later-apply', 'later-watch']);
    expect(p.store.agentHold('a1', 'model-apply')).toBe('kept since');
    // The later release, installed again: it knows both, lets go of the one it drops, keeps the other, and the note goes.
    const newer = { ...HOLDS_AFTER_ROLLBACK, 'later-apply': { fate: 'drop' as const }, 'later-watch': { fate: 'keep' as const } };
    const taken = takeRollbackMark(p.store, p.dbPath, newer)!;
    expect(taken.dropped).toEqual([{ agentId: 'a1', kind: 'later-apply', at: '2026-11-02T08:00:00.000Z' }]);
    expect(taken.keptFor).toBeUndefined();
    expect(existsSync(p.mark)).toBe(false);
    expect(db.prepare('SELECT kind FROM agent_holds ORDER BY kind').all()).toEqual([{ kind: 'later-watch' }, { kind: 'model-apply' }]);
  });

  it('a note kept for a later release\'s holds is never moved at this release\'s stop (review of HB-0840)', () => {
    const p = place();
    const db = (p.store as unknown as { db: Database.Database }).db;
    db.prepare('INSERT INTO agent_holds (agent_id, kind, value, at) VALUES (?, ?, ?, ?)').run('a1', 'later-apply', 'v', '2026-11-02T08:00:00.000Z');
    writeFileSync(p.mark, '2026-11-03T09:00:00Z\n');
    utimesSync(p.mark, new Date('2026-11-03T09:00:00Z'), new Date('2026-11-03T09:00:00Z'));
    const startedAt = new Date('2026-11-03T09:00:05Z');
    expect(takeRollbackMark(p.store, p.dbPath)!.keptFor).toEqual(['later-apply']);
    expect(restampRollbackMark(p.dbPath, startedAt, () => new Date('2026-11-04T12:00:00Z'))).toBeUndefined();
    expect(readFileSync(p.mark, 'utf8')).toBe('2026-11-03T09:00:00Z\n');
  });

  it('src/index.ts says why a note was kept (review of HB-0840)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(src).toContain('noteKept');
    expect(src).toContain('holds of kinds this release does not know (${keptFor.join(\', \')}) were kept before the rollback: the note stays for the release that knows them');
  });

  it('places every kind of hold there is, in one list: drop or keep, each with why', () => {
    const src = readFileSync(new URL('../src/store/store.ts', import.meta.url), 'utf8');
    const union = src.match(/export type AgentHoldKind = ([^;]+);/)?.[1];
    expect(union, 'AgentHoldKind in src/store/store.ts').toBeTruthy();
    const kinds = [...union!.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort();
    // A kind added there and not placed in HOLDS_AFTER_ROLLBACK (src/store/rollbackMark.ts) fails here.
    expect(Object.keys(HOLDS_AFTER_ROLLBACK).sort()).toEqual(kinds);
    for (const [kind, { fate, why }] of Object.entries(HOLDS_AFTER_ROLLBACK)) {
      expect(['drop', 'keep'], kind).toContain(fate);
      expect(why.length, kind).toBeGreaterThan(10);
    }
    expect([...ROLLBACK_DROPS].sort()).toEqual(['budget-pause', 'class-detach', 'download-stop', 'knock-door', 'model-apply']);
  });

  it('no kind a release has kept holds of leaves AgentHoldKind or HOLDS_AFTER_ROLLBACK without a decision, and each new one is added here (HB-1455)', () => {
    // A kind gone from both while its rows stay, as an older release or a rollback leaves them, is one this
    // release does not know: takeRollbackMark keeps the note for it (keptFor) for good. Retiring one is a
    // decision: delete its rows (at each start, since a rollback can write them again), or keep it placed.
    // Every kind a release has kept holds of (all nine were in v2.191.0). A kind placed in
    // HOLDS_AFTER_ROLLBACK is added here too, and never taken out: the second loop below holds to that.
    const EVER_KEPT = ['budget-pause', 'class-detach', 'docs-sync', 'embed-reindex', 'first-contact', 'model-apply', 'model-waits-image', 'pending-joins', 'skip-pool',
      'download-stop', // 2.193.0 (HB-1479)
      'knock-door']; // 2.193.0 (HB-1264)
    const placed = Object.keys(HOLDS_AFTER_ROLLBACK);
    for (const kind of EVER_KEPT) expect(placed, `${kind} was released: retire it only by deleting its rows, or keep it in HOLDS_AFTER_ROLLBACK (src/store/rollbackMark.ts)`).toContain(kind);
    for (const kind of placed) expect(EVER_KEPT, `${kind} is new: add it to EVER_KEPT here once it is placed`).toContain(kind);
  });

  it('a note whose time cannot be read still says a rollback came: it is taken at its file\'s own time, when it was written', () => {
    const p = place();
    kept(p.store, '2026-11-01T10:00:00.000Z', 'a1', 'model-apply');
    kept(p.store, '2026-11-02T10:00:00.000Z', 'a2', 'model-apply');
    writeFileSync(p.mark, 'garbled\n');
    utimesSync(p.mark, new Date('2026-11-02T00:00:00.000Z'), new Date('2026-11-02T00:00:00.000Z'));
    const r = takeRollbackMark(p.store, p.dbPath)!;
    expect(r.before).toBe('2026-11-02T00:00:00.000Z');
    expect(r.unread).toBe('not a time: "garbled"');
    expect(r.dropped.map((h) => h.agentId)).toEqual(['a1']);
    expect(p.store.agentHold('a2', 'model-apply')).toBe('x');
    expect(existsSync(p.mark)).toBe(false);
  });

  it('a note that can be neither read nor removed (a folder in its place) lets go at each start only of what was kept before its time, never of a hold kept since (review of HB-0840)', () => {
    const p = place();
    kept(p.store, '2026-11-01T10:00:00.000Z', 'a1', 'model-apply');
    mkdirSync(p.mark);
    utimesSync(p.mark, new Date('2026-11-20T00:00:00.000Z'), new Date('2026-11-20T00:00:00.000Z'));
    const first = takeRollbackMark(p.store, p.dbPath)!;
    expect(first.unread).toBeTruthy();
    expect(first.leftBehind).toBeTruthy();
    expect(first.before).toBe('2026-11-20T00:00:00.000Z');
    expect(first.dropped.map((h) => h.agentId)).toEqual(['a1']);
    // Kept since, by the process that started; the note is still there at the next start.
    kept(p.store, '2026-11-22T10:00:00.000Z', 'a2', 'model-apply', 'claude-haiku-4-5');
    const next = takeRollbackMark(p.store, p.dbPath)!;
    expect(next.before).toBe('2026-11-20T00:00:00.000Z');
    expect(next.dropped).toEqual([]);
    expect(p.store.agentHold('a2', 'model-apply')).toBe('claude-haiku-4-5');
  });

  it('a drop the database refuses (a full disk, a database it cannot write) is said, lets go of nothing, never ends the start, and leaves the note for the next start (review of HB-0840)', () => {
    const p = place();
    kept(p.store, '2026-11-01T10:00:00.000Z', 'a1', 'model-apply');
    writeFileSync(p.mark, '2026-11-03T09:00:00Z\n');
    const db = (p.store as unknown as { db: Database.Database }).db;
    db.pragma('query_only = ON'); // every write refused, as SQLITE_FULL refuses one
    let r: ReturnType<typeof takeRollbackMark>;
    expect(() => { r = takeRollbackMark(p.store, p.dbPath); }).not.toThrow();
    expect(r!.failed).toMatch(/readonly/);
    expect(r!.dropped).toEqual([]);
    expect(existsSync(p.mark)).toBe(true);
    // Room again: the next start lets go of them, at the note's own time.
    db.pragma('query_only = OFF');
    const again = takeRollbackMark(p.store, p.dbPath)!;
    expect(again.failed).toBeUndefined();
    expect(again.before).toBe('2026-11-03T09:00:00.000Z');
    expect(again.dropped.map((h) => h.agentId)).toEqual(['a1']);
    expect(existsSync(p.mark)).toBe(false);
  });

  it('while a refused drop leaves the note, this process serves none of the holds it would have let go of: every reader reads them as not there, and a hold kept since as ever (review of HB-0840)', () => {
    const p = place();
    kept(p.store, '2026-11-01T10:00:00.000Z', 'a1', 'model-apply', 'claude-haiku-4-5');
    kept(p.store, '2026-11-01T10:00:01.000Z', 'a2', 'class-detach', 'c1');
    kept(p.store, '2026-11-01T10:00:02.000Z', 'a2', 'budget-pause', 'p1');
    kept(p.store, '2026-11-01T10:00:03.000Z', 'a3', 'skip-pool', '1'); // a kind a rollback keeps
    kept(p.store, '2026-11-04T10:00:00.000Z', 'a4', 'model-apply', 'claude-sonnet-5'); // kept after the rollback
    writeFileSync(p.mark, '2026-11-03T09:00:00Z\n');
    const db = (p.store as unknown as { db: Database.Database }).db;
    db.pragma('query_only = ON');
    expect(takeRollbackMark(p.store, p.dbPath)!.failed).toMatch(/readonly/);
    db.pragma('query_only = OFF');
    // How classChanges.ts, modelRuntime.ts (applyOwed) and budgets.ts read them.
    expect(p.store.agentHold('a1', 'model-apply')).toBeUndefined();
    expect(p.store.agentHolds('model-apply').map((h) => h.agentId)).toEqual(['a4']);
    expect(p.store.agentHolds('class-detach')).toEqual([]);
    expect(p.store.agentHold('a2', 'budget-pause')).toBeUndefined();
    expect(p.store.agentHolds('budget-pause')).toEqual([]);
    expect(p.store.agentHold('a3', 'skip-pool')).toBe('1');
    expect(p.store.agentHold('a4', 'model-apply')).toBe('claude-sonnet-5');
    // One kept again by this process reads as ever.
    p.store.setAgentHold('a1', 'model-apply', 'claude-opus-5');
    expect(p.store.agentHold('a1', 'model-apply')).toBe('claude-opus-5');
    // The next start (a new store) takes the note.
    const next = new Store(new Database(p.dbPath));
    const r = takeRollbackMark(next, p.dbPath)!;
    expect(r.dropped.map((h) => `${h.agentId} ${h.kind}`)).toEqual(['a2 class-detach', 'a2 budget-pause']);
    expect(existsSync(p.mark)).toBe(false);
  });

  it('src/index.ts takes the note inside a guard and says what a failed one left (review of HB-0840)', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/try \{ return takeRollbackMark\(store, DB_PATH\); \} catch/);
    expect(src).toContain("'holds.rollback_drop_failed'");
  });

  it("the start lets go of them before anything reads a hold: right after the store, before the routes and the agent settings service", () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const at = src.indexOf('takeRollbackMark(store, DB_PATH)');
    expect(at).toBeGreaterThan(src.indexOf('new Store(db)'));
    for (const later of ['new LocalSecretStore(', 'registerRoutes(', 'markInterrupted(store)', 'reconcileAgents(']) {
      expect(src.indexOf(later), later).toBeGreaterThan(at);
    }
  });

  it('a v2.191.0 upgrade.sh\'s rollback: what the release being left kept after restart.sh wrote the note, until the restart back stopped it, goes too (review of HB-0840)', () => {
    const p = place();
    // 2.192.0 started at 10:00; its health wait failed and its restart.sh wrote the note at 10:01.
    const started = new Date('2026-12-01T10:00:00.400Z');
    writeFileSync(p.mark, '2026-12-01T10:01:00Z\n');
    utimesSync(p.mark, new Date('2026-12-01T10:01:00.250Z'), new Date('2026-12-01T10:01:00.250Z'));
    // It ran on through the checkout back, the dependencies put back and the old release's ensure-deps.
    kept(p.store, '2026-12-01T10:01:30.000Z', 'a1', 'model-apply', 'claude-haiku-4-5');
    kept(p.store, '2026-12-01T10:01:40.000Z', 'a2', 'class-detach', 'c1');
    // The restart back stops it at 10:02.
    expect(restampRollbackMark(p.dbPath, started, () => new Date('2026-12-01T10:02:00.000Z'))).toBe('2026-12-01T10:02:00.000Z');
    expect(readFileSync(p.mark, 'utf8')).toBe('2026-12-01T10:02:00.000Z\n');
    expect(existsSync(`${p.mark}.tmp`)).toBe(false);
    // 2.191.0 runs and keeps one of its own; the next upgrade takes the note.
    kept(p.store, '2026-12-01T10:05:00.000Z', 'a3', 'model-apply', 'claude-sonnet-5');
    const r = takeRollbackMark(p.store, p.dbPath)!;
    expect(r.before).toBe('2026-12-01T10:02:00.000Z');
    expect(r.dropped.map((h) => h.agentId)).toEqual(['a1', 'a2']);
    expect(p.store.agentHold('a3', 'model-apply')).toBe('claude-sonnet-5');
  });

  it('at a stop, a note from before this start is left as it is, and no note is made (review of HB-0840)', () => {
    const p = place();
    const started = new Date('2026-12-01T10:00:00.400Z');
    expect(restampRollbackMark(p.dbPath, started, () => new Date('2026-12-01T11:00:00.000Z'))).toBeUndefined();
    expect(existsSync(p.mark)).toBe(false);
    // One this start could not take or remove: moved later, it would let go of what this process kept.
    const note = (text: string, at: string) => { writeFileSync(p.mark, text); utimesSync(p.mark, new Date(at), new Date(at)); };
    note('2026-12-01T09:59:59Z\n', '2026-12-01T09:59:59.100Z');
    expect(restampRollbackMark(p.dbPath, started, () => new Date('2026-12-01T11:00:00.000Z'))).toBeUndefined();
    expect(readFileSync(p.mark, 'utf8')).toBe('2026-12-01T09:59:59Z\n');
    // Written in the second this process started, before it did (review of HB-0840): from before it, never moved.
    note('2026-12-01T10:00:00Z\n', '2026-12-01T10:00:00.300Z');
    expect(restampRollbackMark(p.dbPath, started, () => new Date('2026-12-01T11:00:00.000Z'))).toBeUndefined();
    expect(readFileSync(p.mark, 'utf8')).toBe('2026-12-01T10:00:00Z\n');
  });

  it('the advice a script gives when it cannot write the note, typed later while the release gone back to runs: its time is the rollback\'s, and it is never moved to that release\'s stop (review of HB-0840)', () => {
    const p = place();
    // The rollback at 10:01 could not write the note; the release gone back to started at 10:02.
    const started = new Date('2026-12-01T10:02:00.000Z');
    kept(p.store, '2026-12-01T10:30:00.000Z', 'a1', 'model-apply', 'claude-haiku-4-5');
    // Room again at 11:00: printf '%s\n' 2026-12-01T10:01:00Z > "<note>", as the advice said.
    writeFileSync(p.mark, '2026-12-01T10:01:00Z\n');
    utimesSync(p.mark, new Date('2026-12-01T11:00:00Z'), new Date('2026-12-01T11:00:00Z'));
    expect(restampRollbackMark(p.dbPath, started, () => new Date('2026-12-01T12:00:00.000Z'))).toBeUndefined();
    expect(readFileSync(p.mark, 'utf8')).toBe('2026-12-01T10:01:00Z\n');
    // The next start keeps what that release kept, after the rollback.
    expect(takeRollbackMark(p.store, p.dbPath)!.dropped).toEqual([]);
    expect(p.store.agentHold('a1', 'model-apply')).toBe('claude-haiku-4-5');
  });

  it('every script\'s advice, when it cannot write the note, gives the rollback\'s own time (review of HB-0840)', () => {
    // upgrade.sh and deploy-release.sh say it in the helpers they share (HB-0636).
    for (const f of ['scripts/upgrade-helpers.sh', 'scripts/restart.sh']) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).toContain('Once there is room: printf \'%s\\n\' $at > \\"$mark\\""');
      expect(src, f).not.toMatch(/Once there is room: date /);
    }
  });

  it('src/index.ts writes the stop\'s time after the database is closed, and before it lets the database go (review of HB-0840)', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const handler = src.slice(src.indexOf("for (const sig of ['SIGTERM', 'SIGINT'] as const) {"));
    const at = handler.indexOf('restampRollbackMark(DB_PATH, startedAt)');
    expect(at).toBeGreaterThan(handler.indexOf('db.close()'));
    expect(at).toBeLessThan(handler.indexOf('instanceLock.release()'));
    expect(src.indexOf('const startedAt = new Date()')).toBeLessThan(src.indexOf('takeRollbackMark(store, DB_PATH)'));
  });
});
