import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  agentArchiveName,
  listBackups,
  pruneBackup,
  restoreAgentFromBackup,
  RestoreError,
} from '../src/orchestrator/backups.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';

const base = mkdtempSync(join(tmpdir(), 'acl-bk-'));

function makeSet(date: string, files: Record<string, string>) {
  const dir = join(base, date);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
}

// A complete set, an incomplete one (no key), and noise that must be ignored.
makeSet('2026-08-20', {
  'hatchabot.sqlite': 'db',
  'secret-key.env': 'k',
  'hatchabot-kitchen.tgz': 'aa',
  'hatchabot-butler.tgz': 'bbbb',
});
makeSet('2026-08-22', { 'hatchabot.sqlite': 'db', 'hatchabot-kitchen.tgz': 'cc' });
mkdirSync(join(base, 'not-a-date'), { recursive: true });
writeFileSync(join(base, 'stray.txt'), 'x');

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('listBackups', () => {
  it('lists only date-named sets, newest first, with sizes and presence flags', () => {
    const sets = listBackups(base);
    expect(sets.map((s) => s.date)).toEqual(['2026-08-22', '2026-08-20']);

    const complete = sets[1]!;
    expect(complete.hasDb).toBe(true);
    expect(complete.hasKey).toBe(true);
    // prefix stripped, sorted by name
    expect(complete.volumes.map((v) => v.name)).toEqual(['butler', 'kitchen']);
    expect(complete.volumes.find((v) => v.name === 'butler')!.sizeBytes).toBe(4);
    // size sums every file in the set (db + key + both tarballs)
    expect(complete.sizeBytes).toBe('db'.length + 'k'.length + 'aa'.length + 'bbbb'.length);

    // the incomplete set is flagged: registry present, key missing
    const partial = sets[0]!;
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

describe('agentArchiveName', () => {
  it('mirrors the nightly tarball name for a docker runtimeRef', () => {
    // container = hatchabot-kitchen-9221b8b8, volume = <container>-vol
    expect(agentArchiveName('docker://hatchabot-kitchen-9221b8b8')).toBe(
      'hatchabot-kitchen-9221b8b8-vol.tgz',
    );
  });
});

describe('restoreAgentFromBackup', () => {
  const rbase = mkdtempSync(join(tmpdir(), 'acl-rst-'));
  const prev = process.env.HATCHABOT_BACKUP_DIR;
  process.env.HATCHABOT_BACKUP_DIR = rbase;

  afterAll(() => {
    if (prev === undefined) delete process.env.HATCHABOT_BACKUP_DIR;
    else process.env.HATCHABOT_BACKUP_DIR = prev;
    rmSync(rbase, { recursive: true, force: true });
  });

  async function runningAgent() {
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
    return { store, provider, runtimeRef };
  }

  it('overwrites the whole volume from the set and restarts a running agent', async () => {
    const { store, provider, runtimeRef } = await runningAgent();
    mkdirSync(join(rbase, '2026-08-20'), { recursive: true });
    writeFileSync(join(rbase, '2026-08-20', agentArchiveName(runtimeRef)), 'backed-up-memory');

    const r = await restoreAgentFromBackup({ store, provider }, 'a1', '2026-08-20');
    expect(r).toEqual({ date: '2026-08-20', running: true });
    // the volume now holds the backup, and the agent is running again
    expect(provider.stateStore.get(runtimeRef)!.toString()).toBe('backed-up-memory');
    expect(store.getAgent('a1')!.state).toBe('RUNNING');
  });

  it('keeps who may use it and its bot as they are now, removes people again, and says what that undid (review #5, 2026-09-29)', async () => {
    const { store, provider, runtimeRef } = await runningAgent();
    store.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'NewBot', secretRef: 'chan/a1', deepLink: 'x', createdAt: 'now' } as never);
    store.insertMembership({ id: 'm2', agentId: 'a1', userId: 'u-sam', role: 'member', displayName: 'Sam', channelUserId: '4242', status: 'active' } as never);
    store.revokeMembership('a1', 'u-sam');
    mkdirSync(join(rbase, '2026-08-22'), { recursive: true });
    writeFileSync(join(rbase, '2026-08-22', agentArchiveName(runtimeRef)), 'that-night');
    // What the restored volume holds: Sam still approved, and the bot it had then.
    provider.execResponses.set('sh-volume', { code: 0, stdout: JSON.stringify({ ids: ['4242'], telegramAccounts: ['OldBot'] }), stderr: '' });
    const reapplied: string[] = [];
    const r = await restoreAgentFromBackup({ store, provider, reapply: async (ref) => { reapplied.push(ref); } }, 'a1', '2026-08-22');
    expect(reapplied).toEqual([runtimeRef]);
    expect(r.undone).toEqual([
      "That night's copy still let Sam in; they stay removed.",
      'It used a different Telegram bot that night; it keeps the one it has now.',
    ]);
    const scrub = provider.execLog.filter(([k, sc]) => k === 'sh-volume' && (sc ?? '').includes('channel_pairing_allow_entries where channel_key'));
    expect(scrub.length).toBe(1);
    expect(scrub[0]![1]).toContain('"id":"4242"');
    expect(provider.stateStore.get(runtimeRef)!.toString()).toBe('that-night'); // memory and files are the backup's
  });

  it('when a full re-apply cannot run, still drops the old bot and says the rest waits for a rebuild', async () => {
    const { store, provider, runtimeRef } = await runningAgent();
    mkdirSync(join(rbase, '2026-08-24'), { recursive: true });
    writeFileSync(join(rbase, '2026-08-24', agentArchiveName(runtimeRef)), 'that-night');
    const r = await restoreAgentFromBackup({ store, provider, reapply: async () => { throw new Error('its AI source is gone'); } }, 'a1', '2026-08-24');
    expect(r.undone?.at(-1)).toMatch(/follow at its next rebuild/);
    expect(provider.execLog.some(([k, sc]) => k === 'sh-volume' && (sc ?? '').includes('delete tg.accounts[k]'))).toBe(true);
    expect(provider.stateStore.get(runtimeRef)!.toString()).toBe('that-night');
  });

  it('puts the agent back as it was when even that cannot be done', async () => {
    const { store, provider, runtimeRef } = await runningAgent();
    mkdirSync(join(rbase, '2026-08-23'), { recursive: true });
    writeFileSync(join(rbase, '2026-08-23', agentArchiveName(runtimeRef)), 'that-night');
    provider.execResponses.set('sh-volume', { code: 1, stdout: '', stderr: 'disk full' });
    await expect(restoreAgentFromBackup({ store, provider, reapply: async () => { throw new Error('no build'); } }, 'a1', '2026-08-23'))
      .rejects.toBeInstanceOf(RestoreError);
    expect(provider.stateStore.get(runtimeRef)!.toString()).toBe('current-memory');
    expect(store.getAgent('a1')!.state).toBe('RUNNING');
  });

  /** importState that writes part of what it was given, then fails — a disk
   *  failing mid-extract. Calls `failFrom`..`failTo` (1-based) fail. */
  function tornImports(provider: MockProvider, runtimeRef: string, failFrom: number, failTo = Infinity) {
    let calls = 0;
    provider.importState = async (ref: string, data: Buffer) => {
      calls += 1;
      if (calls < failFrom || calls > failTo) { provider.stateStore.set(ref, data); return; }
      provider.stateStore.set(runtimeRef, Buffer.concat([data.subarray(0, 4), Buffer.from('<torn>')]));
      throw new Error(`simulated disk failure #${calls}`);
    };
  }

  it('import fails and the rollback works: restarted and left as it was (issue #12)', async () => {
    const { store, provider, runtimeRef } = await runningAgent();
    mkdirSync(join(rbase, '2026-08-25'), { recursive: true });
    writeFileSync(join(rbase, '2026-08-25', agentArchiveName(runtimeRef)), 'that-night');
    tornImports(provider, runtimeRef, 1, 1); // the restore tears; the rollback lands
    const err = await restoreAgentFromBackup({ store, provider }, 'a1', '2026-08-25').catch((e) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.userMessage).toBe('Restore failed — the agent was left as it was.');
    expect(provider.stateStore.get(runtimeRef)!.toString()).toBe('current-memory');
    expect(store.getAgent('a1')!.state).toBe('RUNNING');
    expect((await provider.status(runtimeRef)).phase).toBe('running');
    expect(existsSync(join(rbase, 'restore-safety'))).toBe(false); // nothing to keep
  });

  it('import AND rollback fail: stays stopped and failed, names both failures, keeps the copy (issue #12)', async () => {
    const { store, provider, runtimeRef } = await runningAgent();
    mkdirSync(join(rbase, '2026-08-26'), { recursive: true });
    writeFileSync(join(rbase, '2026-08-26', agentArchiveName(runtimeRef)), 'that-night');
    tornImports(provider, runtimeRef, 1);
    const err = await restoreAgentFromBackup({ store, provider }, 'a1', '2026-08-26').catch((e) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.userMessage).not.toMatch(/left as it was/);
    expect(err.userMessage).toContain('simulated disk failure #1');
    expect(err.userMessage).toContain('simulated disk failure #2');
    expect(err.userMessage).toMatch(/could not be put back/);
    const kept = /kept at (\S+\.tgz)/.exec(err.userMessage)?.[1];
    expect(kept && kept.startsWith(join(rbase, 'restore-safety'))).toBe(true);
    expect(readFileSync(kept!, 'utf8')).toBe('current-memory'); // how it was before the restore
    expect(statSync(kept!).mode & 0o777).toBe(0o600);
    // Not booted on the torn volume, and the record says why.
    expect((await provider.status(runtimeRef)).phase).toBe('stopped');
    const a = store.getAgent('a1')!;
    expect(a.state).toBe('FAILED');
    expect(a.stateReason).toContain(kept!);
    // The safety copy is not one of the dated sets.
    expect(listBackups().map((b) => b.date)).not.toContain('restore-safety');

    // Restoring a backup again is the way back, and leaves it for Retry.
    provider.importState = async (ref, data) => { provider.stateStore.set(ref, data); };
    const r = await restoreAgentFromBackup({ store, provider }, 'a1', '2026-08-26');
    expect(r.running).toBe(false);
    expect(provider.stateStore.get(runtimeRef)!.toString()).toBe('that-night');
    expect(store.getAgent('a1')!.state).toBe('FAILED');
    expect(store.getAgent('a1')!.stateReason).toMatch(/Restored from the 2026-08-26 backup — tap Retry/);
    expect(existsSync(kept!)).toBe(true); // never deleted for them
  });

  it('settings re-apply AND rollback fail: stays stopped and failed, keeps the copy (issue #12)', async () => {
    const { store, provider, runtimeRef } = await runningAgent();
    mkdirSync(join(rbase, '2026-08-27'), { recursive: true });
    writeFileSync(join(rbase, '2026-08-27', agentArchiveName(runtimeRef)), 'that-night');
    tornImports(provider, runtimeRef, 2); // the restore lands; the rollback tears
    provider.execResponses.set('sh-volume', { code: 1, stdout: '', stderr: 'disk full' });
    // A re-apply that started the container before failing.
    const reapply = async (ref: string) => { await provider.start(ref); throw new Error('no build'); };
    const err = await restoreAgentFromBackup({ store, provider, reapply }, 'a1', '2026-08-27').catch((e) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.userMessage).not.toMatch(/left as it was/);
    expect(err.userMessage).toContain('dropping the old bot failed');
    expect(err.userMessage).toContain('simulated disk failure #2');
    const kept = /kept at (\S+\.tgz)/.exec(err.userMessage)?.[1];
    expect(readFileSync(kept!, 'utf8')).toBe('current-memory');
    expect((await provider.status(runtimeRef)).phase).toBe('stopped');
    expect(store.getAgent('a1')!.state).toBe('FAILED');
  });

  it('refuses when the set has no tarball for this agent, leaving it untouched', async () => {
    const { store, provider, runtimeRef } = await runningAgent();
    mkdirSync(join(rbase, '2026-08-21'), { recursive: true }); // empty set
    await expect(restoreAgentFromBackup({ store, provider }, 'a1', '2026-08-21')).rejects.toBeInstanceOf(
      RestoreError,
    );
    expect(provider.stateStore.get(runtimeRef)!.toString()).toBe('current-memory');
    expect(store.getAgent('a1')!.state).toBe('RUNNING');
  });
});
