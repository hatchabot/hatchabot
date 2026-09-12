import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
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
