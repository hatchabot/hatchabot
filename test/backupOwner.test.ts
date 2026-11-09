import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { agentArchiveName, foreignSet, listBackups, ownerMark, pruneBackup, restoreAgentFromBackup, RestoreError } from '../src/orchestrator/backups.js';
import { applyLegacyEnv } from '../src/envCompat.js';
import { listDrills } from '../src/orchestrator/drills.js';
import { computeReadiness } from '../src/orchestrator/recoveryReadiness.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';

/**
 * Two installs that share a backup folder each write their own sets there,
 * marked in `.backup-owner` (a fingerprint of the install's key), and the
 * nightly script leaves the other's alone. Listing, deleting and restoring
 * here did not ask (HB-0540). The mark cannot tell another install from this
 * one before its key changed (a reinstall), so such a set is listed labelled,
 * never deleted from here, and restored on a yes (its review). Keys and marks
 * are made up.
 */
const OURS = 'made-up-key-for-this-install';
const THEIRS = 'made-up-key-for-another-install';
const mark = (key: string) => createHash('sha256').update(`hatchabot-backup-owner\0${key}`).digest('hex').slice(0, 16);

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
let prevKey: string | undefined, prevDir: string | undefined;
let base = '';
beforeEach(() => {
  prevKey = process.env.HATCHABOT_SECRET_KEY; prevDir = process.env.HATCHABOT_BACKUP_DIR;
  base = mkdtempSync(join(tmpdir(), 'hb-backup-owner-')); dirs.push(base);
  process.env.HATCHABOT_SECRET_KEY = OURS;
  process.env.HATCHABOT_BACKUP_DIR = base;
});
afterEach(() => {
  if (prevKey === undefined) delete process.env.HATCHABOT_SECRET_KEY; else process.env.HATCHABOT_SECRET_KEY = prevKey;
  if (prevDir === undefined) delete process.env.HATCHABOT_BACKUP_DIR; else process.env.HATCHABOT_BACKUP_DIR = prevDir;
});

/** A set with a database and one archive; `owner` its .backup-owner, `savedKey` the key it saved. */
function set(date: string, opts: { owner?: string; savedKey?: string; archive?: string } = {}) {
  const dir = join(base, date); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'hatchabot.sqlite'), 'made-up-db');
  writeFileSync(join(dir, opts.archive ?? 'hatchabot-kitchen.tgz'), `archive of ${date}`);
  writeFileSync(join(dir, 'backup-status.json'), JSON.stringify({ state: 'complete' }));
  if (opts.owner) writeFileSync(join(dir, '.backup-owner'), `${opts.owner}\n`);
  if (opts.savedKey) writeFileSync(join(dir, 'secret-key.env'), `HATCHABOT_SECRET_KEY=${opts.savedKey}\n`);
  return dir;
}

describe('a set of another install, in a shared backup folder (HB-0540)', () => {
  it('is not this install\'s newest; listed labelled when asked, beside this install\'s own, a set from before the mark with its key, and one that says neither', () => {
    set('2026-11-01', { owner: mark(OURS) });
    set('2026-11-02', { owner: mark(THEIRS) });
    set('2026-11-03', { savedKey: OURS });
    set('2026-11-04', { savedKey: THEIRS });
    set('2026-11-05');
    expect(listBackups(base).map((s) => s.date)).toEqual(['2026-11-05', '2026-11-03', '2026-11-01']);
    expect(listBackups(base, { others: true }).map((s) => [s.date, s.foreign === true])).toEqual([
      ['2026-11-05', false], ['2026-11-04', true], ['2026-11-03', false], ['2026-11-02', true], ['2026-11-01', false],
    ]);
    expect(foreignSet(join(base, '2026-11-02'))).toBe(true);
    expect(foreignSet(join(base, '2026-11-04'))).toBe(true);
  });

  it('is not deleted from here', () => {
    const theirs = set('2026-11-02', { owner: mark(THEIRS) });
    expect(() => pruneBackup('2026-11-02', base)).toThrow(/made by another install, or under an earlier key.*not deleted from here/);
    expect(existsSync(join(theirs, 'hatchabot-kitchen.tgz'))).toBe(true);
    expect(existsSync(join(theirs, '.backup-lock'))).toBe(false);
    set('2026-11-01', { owner: mark(OURS) });
    expect(pruneBackup('2026-11-01', base)).toBe(true);
  });

  it('is not restored from, though it holds an archive of the same name', async () => {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    store.insertAgent({ id: 'a1', ownerId: 'o', name: 'Kitchen', slug: 'kitchen', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: 'x', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } }, env: {} });
    store.setAgentRuntimeRef('a1', runtimeRef);
    await provider.start(runtimeRef);
    store.setAgentState('a1', 'RUNNING');
    provider.stateStore.set(runtimeRef, Buffer.from('current-memory'));

    set('2026-11-02', { owner: mark(THEIRS), archive: agentArchiveName(runtimeRef) });
    const refused = restoreAgentFromBackup({ store, provider }, 'a1', '2026-11-02');
    await expect(refused).rejects.toBeInstanceOf(RestoreError);
    await expect(refused).rejects.toMatchObject({ code: 'other_key' });
    // Why, and that its key does not stop it: only the agent's archive goes back, and its current settings over it.
    await expect(refused).rejects.toThrow(/made by another install, or under an earlier key.*The key it was made under does not stop it.*Confirm to go ahead/);
    expect(provider.stateStore.get(runtimeRef)!.toString()).toBe('current-memory');
    expect(store.getAgent('a1')!.state).toBe('RUNNING');

    set('2026-11-01', { owner: mark(OURS), archive: agentArchiveName(runtimeRef) });
    await restoreAgentFromBackup({ store, provider }, 'a1', '2026-11-01');
    expect(provider.stateStore.get(runtimeRef)!.toString()).toBe('archive of 2026-11-01');
  });

  it('after a reinstall with a new key, this install\'s older sets are still listed and offered, and restored on a yes (its review)', async () => {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    store.insertAgent({ id: 'a1', ownerId: 'o', name: 'Kitchen', slug: 'kitchen', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: 'x', sharedMemory: false, createdAt: '2026-10-01T00:00:00Z', updatedAt: 'now' });
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } }, env: {} });
    store.setAgentRuntimeRef('a1', runtimeRef);
    await provider.start(runtimeRef);
    store.setAgentState('a1', 'RUNNING');
    provider.stateStore.set(runtimeRef, Buffer.from('empty-after-reinstall'));
    // Made under the key it had before the reinstall: marked, and the key saved beside it.
    set('2026-11-02', { owner: mark(THEIRS), savedKey: THEIRS, archive: agentArchiveName(runtimeRef) });

    const sets = listBackups(base, { others: true });
    expect(sets.map((s) => [s.date, s.foreign])).toEqual([['2026-11-02', true]]);
    const r = computeReadiness({ sets, drills: [], agents: [store.getAgent('a1')!], host: () => ({ name: 'box', local: true }), now: Date.parse('2026-11-03T12:00:00Z') });
    expect(r.agents[0]!.restorable).toEqual([expect.objectContaining({ date: '2026-11-02', otherKey: true })]);
    // Offered, labelled, but not what covers it: this install's own sets do not hold it (seventh review).
    expect(r.agents[0]!.status).toBe('not covered');
    expect(r.agents[0]!.line).toBe('None of this install\'s backups holds it. A copy made by another install, or under an earlier key, is from 2026-11-02.');
    expect(r.newestSet).toBeUndefined(); // not this install's newest set: its own backups are still late
    expect(r.agents[0]!.leftOut.of).toBe(0);

    await expect(restoreAgentFromBackup({ store, provider }, 'a1', '2026-11-02')).rejects.toMatchObject({ code: 'other_key' });
    await restoreAgentFromBackup({ store, provider, otherKey: true }, 'a1', '2026-11-02');
    expect(provider.stateStore.get(runtimeRef)!.toString()).toBe('archive of 2026-11-02');
  });

  it('with no key of its own, this install cannot tell, and filters nothing', () => {
    delete process.env.HATCHABOT_SECRET_KEY;
    set('2026-11-02', { owner: mark(THEIRS) });
    expect(listBackups(base).map((s) => s.date)).toEqual(['2026-11-02']);
  });
});

describe('another install\'s drill records, in the shared drills folder (review of HB-0540)', () => {
  /** A drill record of one volume, as restore-drill.sh writes it; `owner` absent: a record from before it said. */
  function drill(stamp: string, setDate: string, passed: boolean, owner?: string) {
    mkdirSync(join(base, 'drills'), { recursive: true });
    const vol = { volume: 'hatchabot-kitchen-vol', readable: passed, layout: passed, restored: passed, note: passed ? '' : 'extract', result: passed ? 'passed' : 'failed' };
    writeFileSync(join(base, 'drills', `${stamp}.json`), JSON.stringify({
      version: 1, set: setDate, setState: 'complete', startedAt: `${stamp.slice(0, 10)}T05:00:00Z`, finishedAt: `${stamp.slice(0, 10)}T05:10:00Z`, durationSec: 600,
      trigger: 'scheduled', result: passed ? 'passed' : 'failed', reason: '', database: 'ok', key: 'ok', ...(owner !== undefined ? { owner } : {}), volumes: [vol],
    }));
  }

  it('are not this install\'s proof: readiness reads this install\'s own, and one that names no owner', () => {
    set('2026-11-01', { owner: mark(OURS), archive: 'hatchabot-kitchen-vol.tgz' });
    drill('2026-11-01T05-00-00Z', '2026-11-01', true, mark(OURS));
    drill('2026-11-02T05-00-00Z', '2026-11-01', false, mark(THEIRS)); // newer, and another install's
    expect(listDrills(base).map((d) => d.id)).toEqual(['2026-11-01T05-00-00Z']);
    const agent = { id: 'a1', name: 'Kitchen', runtimeRef: 'hatchabot-kitchen', createdAt: '2026-10-01T00:00:00Z', hostId: 'h1', state: 'RUNNING' };
    const r = computeReadiness({ sets: listBackups(base, { others: true }), drills: listDrills(base), agents: [agent], host: () => ({ name: 'box', local: true }), now: Date.parse('2026-11-02T12:00:00Z') });
    expect(r.agents[0]).toMatchObject({ status: 'ready', drill: { set: '2026-11-01', passed: true } });
    // A record from before records said whose: taken as this install's, as a set that says neither is.
    drill('2026-11-02T06-00-00Z', '2026-11-01', true);
    expect(listDrills(base).map((d) => d.id)).toEqual(['2026-11-02T06-00-00Z', '2026-11-01T05-00-00Z']);
    // No key here: nothing can be told, and every record is read.
    delete process.env.HATCHABOT_SECRET_KEY;
    expect(listDrills(base)).toHaveLength(3);
  });
});

describe('one owner mark in the scripts: scripts/backup-owner.sh (second review of HB-0540)', () => {
  const repo = join(import.meta.dirname, '..');
  const helper = join(repo, 'scripts', 'backup-owner.sh');
  /** key_owner in a bare shell: only Node and the system on PATH, no HOME of anyone's. */
  const keyOwner = (env: Record<string, string>, file = '') => {
    const home = mkdtempSync(join(tmpdir(), 'hb-owner-home-')); dirs.push(home);
    const r = spawnSync('bash', ['-c', '. "$1"; key_owner "$2"', 'sh', helper, file], {
      encoding: 'utf8', cwd: home, env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, ...env },
    });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  };
  it('the mark of a key, as ownerMark makes it: from the environment, from a saved key, by either name', () => {
    const want = ownerMark(OURS)!;
    expect(keyOwner({ HATCHABOT_SECRET_KEY: OURS })).toBe(want);
    expect(keyOwner({ AGENTCLAW_SECRET_KEY: OURS })).toBe(want);
    // Both set: the app's alias leaves HATCHABOT_* as it is (applyLegacyEnv), and so does key_owner.
    const env: NodeJS.ProcessEnv = { HATCHABOT_SECRET_KEY: OURS, AGENTCLAW_SECRET_KEY: THEIRS };
    applyLegacyEnv(env);
    expect(keyOwner({ HATCHABOT_SECRET_KEY: OURS, AGENTCLAW_SECRET_KEY: THEIRS })).toBe(ownerMark(env.HATCHABOT_SECRET_KEY));
    const legacy: NodeJS.ProcessEnv = { AGENTCLAW_SECRET_KEY: OURS };
    applyLegacyEnv(legacy);
    expect(keyOwner({ AGENTCLAW_SECRET_KEY: OURS })).toBe(ownerMark(legacy.HATCHABOT_SECRET_KEY));
    // No key, or an empty one: no mark.
    expect(keyOwner({})).toBe('');
    expect(keyOwner({ HATCHABOT_SECRET_KEY: '' })).toBe('');
    // A set's saved key (secret-key.env), read as foreignSet reads it: quoted, either name.
    for (const line of [`HATCHABOT_SECRET_KEY=${OURS}`, `AGENTCLAW_SECRET_KEY=${OURS}`, `HATCHABOT_SECRET_KEY="${OURS}"`, `export HATCHABOT_SECRET_KEY='${OURS}'`]) {
      const set = join(base, '2026-10-01'); mkdirSync(set, { recursive: true });
      writeFileSync(join(set, 'secret-key.env'), `# made up\n${line}\n`);
      expect(keyOwner({ HATCHABOT_SECRET_KEY: THEIRS }, join(set, 'secret-key.env')), line).toBe(want);
      expect(foreignSet(set, want), line).toBe(false);
      rmSync(set, { recursive: true });
    }
    expect(keyOwner({ HATCHABOT_SECRET_KEY: OURS }, join(base, 'missing.env'))).toBe('');
  });
  it('whose a set is, as foreignSet reads it: its .backup-owner, else the key it saved; that key not read with no mark here (third review)', () => {
    const setOwner = (dir: string, ...mine: string[]) => {
      const r = spawnSync('bash', ['-c', '. "$1"; shift; set_owner "$@"', 'sh', helper, dir, ...mine], {
        encoding: 'utf8', env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: base },
      });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    };
    const marked = set('2026-10-01', { owner: mark(THEIRS), savedKey: OURS });
    const legacy = set('2026-10-02', { savedKey: THEIRS });
    const unmarked = set('2026-10-03');
    expect(setOwner(marked)).toBe(mark(THEIRS)); // the mark wins over the key it saved
    expect(setOwner(legacy)).toBe(mark(THEIRS));
    expect(setOwner(unmarked)).toBe('');
    for (const dir of [marked, legacy, unmarked]) expect(foreignSet(dir, mark(OURS)), dir).toBe(setOwner(dir) !== '' && setOwner(dir) !== mark(OURS));
    // This install has no mark: a marked set still says whose; a legacy one's key is not read.
    expect(setOwner(marked, '')).toBe(mark(THEIRS));
    expect(setOwner(legacy, '')).toBe('');
    expect(setOwner(legacy, mark(OURS))).toBe(mark(THEIRS));
  });
  it('a set whose saved key file holds no key names no owner, here as in set_owner: not this install\'s by default (fifteenth review)', () => {
    const dir = set('2026-11-06');
    writeFileSync(join(dir, 'secret-key.env'), 'MADE_UP_SETTING=1\n');
    const r = spawnSync('bash', ['-c', '. "$1"; shift; set_owner "$@"', 'sh', helper, dir], {
      encoding: 'utf8', env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    });
    expect(r.stdout).toBe('');
    // Read against another mark than this install's: no owner is never another's.
    expect(foreignSet(dir, mark(THEIRS))).toBe(false);
  });

  it('the scripts that mark or read marks use it, and no copy of the hash or the set rule is left in them', () => {
    for (const f of ['backup-volumes.sh', 'restore-drill.sh', 'uninstall.sh']) {
      const text = readFileSync(join(repo, 'scripts', f), 'utf8');
      // Sourced bare, or guarded (restore-drill.sh: thirteenth review), with stand-ins that hold no rule.
      expect(text, f).toMatch(/(^\s*|&& )\. [^;&|]*scripts\/backup-owner\.sh"?( \|\|.*| && .*)?$/m);
      expect(text, f).not.toContain('hatchabot-backup-owner');
      expect(text, f).not.toMatch(/^\s*set_owner\(\) (?!\{ :; \}$)/m);
      expect(text, f).not.toMatch(/^\s*key_owner\(\) (?!\{ :; \}$)/m);
      expect(text, f).not.toMatch(/key_owner "[^"]*secret-key\.env"/);
      expect(text, f).not.toMatch(/\.backup-owner" 2>/);
    }
  });
  it('the newest 30 drill records of this install\'s are found under another install\'s newer ones (second review of HB-0540)', () => {
    mkdirSync(join(base, 'drills'), { recursive: true });
    const drill = (stamp: string, owner: string) => writeFileSync(join(base, 'drills', `${stamp}.json`), JSON.stringify({ version: 1, set: stamp.slice(0, 10), result: 'passed', owner, volumes: [] }));
    drill('2026-10-01T03-00-00Z', mark(OURS));
    for (let i = 0; i < 35; i++) drill(`2026-10-02T03-00-${String(i).padStart(2, '0')}Z`, mark(THEIRS));
    expect(listDrills(base, mark(OURS)).map((d) => d.id)).toEqual(['2026-10-01T03-00-00Z']);
  });
});

describe('the newest set alone (second review of HB-0540)', () => {
  it('listBackups stops at the first sets kept, newest first, past another install\'s newer one', () => {
    set('2026-10-01', { owner: mark(OURS) });
    set('2026-10-02', { savedKey: OURS });
    set('2026-10-03', { owner: mark(THEIRS) });
    expect(listBackups(base, { limit: 1 }).map((s) => s.date)).toEqual(['2026-10-02']);
    expect(listBackups(base, { others: true, limit: 2 }).map((s) => [s.date, !!s.foreign])).toEqual([['2026-10-03', true], ['2026-10-02', false]]);
    expect(listBackups(base).map((s) => s.date)).toEqual(['2026-10-02', '2026-10-01']);
  });
  it('a set\'s owner is read again only when the files it was read from change: a listing does not hash every older set\'s key each time (sixth review of HB-0540)', () => {
    const fixed = new Date('2026-10-02T03:30:00Z');
    const dir = set('2026-10-02', { savedKey: OURS });
    const key = join(dir, 'secret-key.env');
    utimesSync(key, fixed, fixed);
    expect(listBackups(base).map((s) => s.date)).toEqual(['2026-10-02']);
    // Changed with the same size and time (no backup does that): the owner read before stands, as it was not read again.
    const other = 'made-up-key-for-that-install'; // as long as OURS: the same size
    expect(other.length).toBe(OURS.length);
    writeFileSync(key, `HATCHABOT_SECRET_KEY=${other}\n`); utimesSync(key, fixed, fixed);
    expect(foreignSet(dir)).toBe(false);
    expect(listBackups(base).map((s) => s.date)).toEqual(['2026-10-02']);
    // Its time moved, as any rewrite moves it: read again.
    utimesSync(key, fixed, new Date(fixed.getTime() + 60_000));
    expect(foreignSet(dir)).toBe(true);
    expect(listBackups(base)).toEqual([]);
    // A mark written since is read too.
    writeFileSync(join(dir, '.backup-owner'), `${mark(OURS)}\n`);
    expect(foreignSet(dir)).toBe(false);
  });
});
