import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  AUTO_KEEP,
  MAX_FILE_BYTES,
  captureSnapshot,
  restoreSnapshot,
  SnapshotError,
} from '../src/orchestrator/snapshots.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';

/** MockProvider.execShell returns a canned 'sh' response; drive it per call. */
function fileWorld(initial: Record<string, string>) {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  const files = { ...initial };
  // read → contents of whichever core file the script names; write → capture it.
  (provider as any).execShell = async (_ref: string, script: string) => {
    provider.execLog.push(['sh', script]);
    const m = script.match(/agents\/[^/]+\/agent\/([A-Za-z.]+)/);
    const name = m?.[1] ?? '';
    if (script.startsWith('head -c')) {
      // Model the real `head -c N` truncation, so a test can tell the
      // difference between reading N and reading N+1 bytes.
      const n = Number(script.match(/^head -c (\d+)/)?.[1] ?? Infinity);
      return { code: 0, stdout: (files[name] ?? '').slice(0, n), stderr: '' };
    }
    const b64 = script.match(/echo "([^"]+)"/)?.[1] ?? '';
    files[name] = Buffer.from(b64, 'base64').toString('utf8');
    return { code: 0, stdout: '', stderr: '' };
  };
  store.insertAgent({
    id: 'a1', ownerId: 'o', name: 'A', slug: 'a1', state: 'PROVISIONING',
    aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: true,
    createdAt: 'now', updatedAt: 'now',
  });
  store.setAgentRuntimeRef('a1', 'mock://a1');
  store.setAgentState('a1', 'RUNNING');
  return { store, provider, files, deps: { store, provider } };
}

const SEED = {
  'SOUL.md': '# Kitchen\nA helpful cook.\n',
  'AGENTS.md': '# Kitchen\n\n## Memory policy\n- shared\n',
  'MEMORY.md': '# Memory\n- Chris likes soup\n',
};

describe('captureSnapshot', () => {
  it('captures the three core files and lists them newest-first', async () => {
    const w = fileWorld(SEED);
    const first = await captureSnapshot(w.deps, 'a1', { label: 'good state' });
    expect(first.files.sort()).toEqual(['AGENTS.md', 'MEMORY.md', 'SOUL.md']);

    await captureSnapshot(w.deps, 'a1', { reason: 'pre-edit' });
    const list = w.store.listSnapshots('a1');
    expect(list).toHaveLength(2);
    expect(list[0]!.reason).toBe('pre-edit'); // newest first
    expect(list[1]!.label).toBe('good state');
    expect(list[1]!.bytes).toBeGreaterThan(0);
  });

  it('refuses when the agent is not running', async () => {
    const w = fileWorld(SEED);
    w.store.setAgentState('a1', 'STOPPED');
    await expect(captureSnapshot(w.deps, 'a1')).rejects.toBeInstanceOf(SnapshotError);
  });

  it('refuses an oversized file instead of silently truncating it', async () => {
    const w = fileWorld({ ...SEED, 'MEMORY.md': 'x'.repeat(300 * 1024) });
    await expect(captureSnapshot(w.deps, 'a1')).rejects.toBeInstanceOf(SnapshotError);
    // nothing half-captured
    expect(w.store.listSnapshots('a1')).toHaveLength(0);
  });

  it('detects a file just one byte over the cap', async () => {
    // Only possible because capture reads MAX_FILE_BYTES + 1: reading exactly
    // the cap makes oversize indistinguishable from a file of exactly the cap.
    const w = fileWorld({ ...SEED, 'MEMORY.md': 'x'.repeat(MAX_FILE_BYTES + 1) });
    await expect(captureSnapshot(w.deps, 'a1')).rejects.toBeInstanceOf(SnapshotError);
  });

  it('accepts a file of exactly the cap', async () => {
    const w = fileWorld({ ...SEED, 'MEMORY.md': 'x'.repeat(MAX_FILE_BYTES) });
    const snap = await captureSnapshot(w.deps, 'a1');
    expect(snap.files).toContain('MEMORY.md');
  });

  it('refuses when the files come back empty (unhealthy runtime)', async () => {
    const w = fileWorld({});
    await expect(captureSnapshot(w.deps, 'a1')).rejects.toBeInstanceOf(SnapshotError);
  });

  it('prunes automatic snapshots but keeps named ones forever', async () => {
    const w = fileWorld(SEED);
    await captureSnapshot(w.deps, 'a1', { label: 'keep me' }); // manual
    for (let i = 0; i < AUTO_KEEP + 5; i++) {
      await captureSnapshot(w.deps, 'a1', { reason: 'pre-edit' });
    }
    const list = w.store.listSnapshots('a1');
    expect(list.filter((s) => s.reason === 'pre-edit')).toHaveLength(AUTO_KEEP);
    expect(list.some((s) => s.label === 'keep me')).toBe(true);
  });
});

describe('restoreSnapshot', () => {
  it('puts the old files back and snapshots the current state first', async () => {
    const w = fileWorld(SEED);
    const good = await captureSnapshot(w.deps, 'a1', { label: 'before the mess' });

    // the agent's memory gets mangled
    w.files['MEMORY.md'] = 'oops, everything deleted';
    w.files['SOUL.md'] = 'garbage';

    const res = await restoreSnapshot(w.deps, 'a1', good.id);
    expect(res.restored.sort()).toEqual(['AGENTS.md', 'MEMORY.md', 'SOUL.md']);
    expect(w.files['MEMORY.md']).toBe(SEED['MEMORY.md']);
    expect(w.files['SOUL.md']).toBe(SEED['SOUL.md']);

    // the mangled state is itself recoverable — the restore is undoable
    expect(res.safetySnapshotId).toBeTruthy();
    const undo = w.store.getSnapshot('a1', res.safetySnapshotId!)!;
    expect(undo.files['MEMORY.md']).toBe('oops, everything deleted');
  });

  it('rejects an unknown snapshot id and a stopped agent', async () => {
    const w = fileWorld(SEED);
    await expect(restoreSnapshot(w.deps, 'a1', 'nope')).rejects.toBeInstanceOf(SnapshotError);
    const s = await captureSnapshot(w.deps, 'a1');
    w.store.setAgentState('a1', 'STOPPED');
    await expect(restoreSnapshot(w.deps, 'a1', s.id)).rejects.toBeInstanceOf(SnapshotError);
  });

  it('scopes snapshots per agent', async () => {
    const w = fileWorld(SEED);
    const s = await captureSnapshot(w.deps, 'a1');
    expect(w.store.getSnapshot('other-agent', s.id)).toBeUndefined();
    expect(w.store.deleteSnapshot('other-agent', s.id)).toBe(false);
    expect(w.store.deleteSnapshot('a1', s.id)).toBe(true);
  });
});
