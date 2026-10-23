import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTO_KEEP,
  MAX_FILE_BYTES,
  captureSnapshot,
  readCoreFiles,
  workspacePath,
  restoreSnapshot,
  recoverSnapshotRestore,
  SnapshotError,
} from '../src/orchestrator/snapshots.js';
import { setStepHookForTests, SimulatedCrash } from '../src/orchestrator/operations.js';
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
  'MEMORY.md': '# Memory\n- The owner likes soup\n',
};

describe('captureSnapshot', () => {
  it('captures the three core files and lists them newest-first', async () => {
    const w = fileWorld(SEED);
    const first = await captureSnapshot(w.deps, 'a1', { label: 'good state' });
    expect(first.files.sort()).toEqual(['AGENTS.md', 'MEMORY.md', 'SOUL.md']);

    w.files['MEMORY.md'] += '- and bread\n';
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
      w.files['MEMORY.md'] = `# Memory\n- note ${i}\n`;
      await captureSnapshot(w.deps, 'a1', { reason: 'pre-edit' });
    }
    const list = w.store.listSnapshots('a1');
    expect(list.filter((s) => s.reason === 'pre-edit')).toHaveLength(AUTO_KEEP);
    expect(list.some((s) => s.label === 'keep me')).toBe(true);
  });

  it('skips an automatic snapshot identical to the newest one, never a named one (review, 2026-09-29)', async () => {
    const w = fileWorld(SEED);
    const first = await captureSnapshot(w.deps, 'a1', { reason: 'pre-rebuild' });
    const again = await captureSnapshot(w.deps, 'a1', { reason: 'pre-rebuild' });
    expect(again.id).toBe(first.id); // the rebuild-twice case: one row, not two
    expect(w.store.listSnapshots('a1')).toHaveLength(1);
    // A named snapshot of the same files is still its own row.
    await captureSnapshot(w.deps, 'a1', { label: 'named' });
    expect(w.store.listSnapshots('a1')).toHaveLength(2);
    // Any change is a new version.
    w.files['SOUL.md'] += 'Also bakes.\n';
    const changed = await captureSnapshot(w.deps, 'a1', { reason: 'pre-rebuild' });
    expect(changed.id).not.toBe(first.id);
    expect(w.store.listSnapshots('a1')).toHaveLength(3);
  });
});

describe('restoreSnapshot', () => {
  it('refuses to restore when the current files cannot be snapshotted first (use-case audit, 2026-09-27)', async () => {
    const w = fileWorld({ 'SOUL.md': 'soul', 'AGENTS.md': 'agents', 'MEMORY.md': 'short memory' });
    const snap = await captureSnapshot(w.deps, 'a1', { reason: 'manual', label: 'early' });
    w.files['MEMORY.md'] = 'x'.repeat(MAX_FILE_BYTES + 1); // grew past what a snapshot holds
    await expect(restoreSnapshot(w.deps, 'a1', snap.id)).rejects.toThrow(/nothing was changed/);
    expect(w.files['MEMORY.md']!.length).toBe(MAX_FILE_BYTES + 1); // untouched
  });

  it("the safety copy taken at the limit never prunes the snapshot being restored (A40)", async () => {
    const w = fileWorld(SEED);
    const tick = () => new Promise((r) => setTimeout(r, 3));
    const target = await captureSnapshot(w.deps, 'a1', { reason: 'pre-edit' });
    for (let i = 1; i < AUTO_KEEP; i++) {
      await tick();
      w.files['MEMORY.md'] = `# Memory\n- note ${i}\n`;
      await captureSnapshot(w.deps, 'a1', { reason: 'pre-edit' });
    }
    await tick();
    w.files['MEMORY.md'] = 'changed since';
    await restoreSnapshot(w.deps, 'a1', target.id);
    expect(w.store.getSnapshot('a1', target.id)).toBeTruthy();   // a restart part-way still has it to finish with
    expect(w.files['MEMORY.md']).toBe(SEED['MEMORY.md']);
  });

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

  it('a write failing partway says which files were already restored and where the way back is (issue #12)', async () => {
    const w = fileWorld(SEED);
    const good = await captureSnapshot(w.deps, 'a1', { label: 'before the mess' });
    w.files['SOUL.md'] = 'garbage';
    w.files['MEMORY.md'] = 'mangled';
    const write = (w.provider as any).execShell;
    (w.provider as any).execShell = async (ref: string, script: string) =>
      script.includes('/MEMORY.md') && !script.startsWith('head -c') ? { code: 1, stdout: '', stderr: 'disk full' } : write(ref, script);
    const order = Object.keys(w.store.getSnapshot('a1', good.id)!.files);
    const before = order.slice(0, order.indexOf('MEMORY.md'));
    const err = await restoreSnapshot(w.deps, 'a1', good.id).catch((e) => e);
    expect(err).toBeInstanceOf(SnapshotError);
    expect(err.userMessage).toContain("Couldn't write MEMORY.md: disk full");
    expect(err.userMessage).toContain(before.length ? `${before.join(', ')} ${before.length === 1 ? 'was' : 'were'} already restored` : 'Nothing was changed');
    expect(err.userMessage).toContain('"before restoring before the mess"');
    expect(w.files['MEMORY.md']).toBe('mangled');
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

/** The real read and write scripts, run by bash against a local folder standing in for the workspace. */
function folderWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'hb-snap-'));
  const w = fileWorld({});
  (w.provider as any).execShell = async (_ref: string, script: string) => {
    const local = script.replaceAll(workspacePath('a1', ''), `${dir}/`);
    const r = spawnSync('bash', ['-c', local], { encoding: 'utf8' });
    return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  };
  return { ...w, dir };
}

describe('reading the core files', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('refuses a snapshot when one file is there but cannot be read, instead of leaving it out (#66)', async () => {
    const w = folderWorld(); dirs.push(w.dir);
    writeFileSync(join(w.dir, 'SOUL.md'), 'soul\n');
    writeFileSync(join(w.dir, 'AGENTS.md'), 'agents\n');
    mkdirSync(join(w.dir, 'MEMORY.md')); // there, but head cannot read it
    await expect(readCoreFiles(w.provider, 'mock://a1', 'a1')).rejects.toThrow(/MEMORY\.md is there but could not be read/);
    await expect(captureSnapshot(w.deps, 'a1')).rejects.toBeInstanceOf(SnapshotError);
    expect(w.store.listSnapshots('a1')).toHaveLength(0);
  });

  it('a failed read is not a missing file (#66)', async () => {
    const w = fileWorld(SEED);
    (w.provider as any).execShell = async () => ({ code: 1, stdout: '', stderr: 'container is not running' });
    await expect(readCoreFiles(w.provider, 'mock://a1', 'a1')).rejects.toBeInstanceOf(SnapshotError);
  });

  it('keeps an empty file as empty, so restoring empties it again; a missing one is left out (#67)', async () => {
    const w = folderWorld(); dirs.push(w.dir);
    writeFileSync(join(w.dir, 'SOUL.md'), 'soul\n');
    writeFileSync(join(w.dir, 'AGENTS.md'), '');
    expect(await readCoreFiles(w.provider, 'mock://a1', 'a1')).toEqual({ 'SOUL.md': 'soul\n', 'AGENTS.md': '' });
    const snap = await captureSnapshot(w.deps, 'a1', { label: 'empty rules' });
    expect(snap.files.sort()).toEqual(['AGENTS.md', 'SOUL.md']);
    writeFileSync(join(w.dir, 'AGENTS.md'), 'filled in later\n');
    await restoreSnapshot(w.deps, 'a1', snap.id);
    expect(readFileSync(join(w.dir, 'AGENTS.md'), 'utf8')).toBe('');
  });
});

describe('a core file that was not there when the snapshot was taken (#214)', () => {
  const dirs: string[] = [];
  afterEach(() => { setStepHookForTests(undefined); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('is taken away by the restore; an empty one is emptied, a filled one refilled; the safety copy keeps the newer file', async () => {
    const w = folderWorld(); dirs.push(w.dir);
    writeFileSync(join(w.dir, 'SOUL.md'), 'A calm cook.\n');
    writeFileSync(join(w.dir, 'AGENTS.md'), '');
    const snap = await captureSnapshot(w.deps, 'a1', { label: 'before memory' });
    expect(snap.files.sort()).toEqual(['AGENTS.md', 'SOUL.md']);
    writeFileSync(join(w.dir, 'SOUL.md'), 'A loud cook.\n');
    writeFileSync(join(w.dir, 'AGENTS.md'), 'rules added later\n');
    writeFileSync(join(w.dir, 'MEMORY.md'), '- The owner likes bread\n');
    const r = await restoreSnapshot(w.deps, 'a1', snap.id);
    expect(existsSync(join(w.dir, 'MEMORY.md'))).toBe(false);
    expect(readFileSync(join(w.dir, 'SOUL.md'), 'utf8')).toBe('A calm cook.\n');
    expect(readFileSync(join(w.dir, 'AGENTS.md'), 'utf8')).toBe('');
    expect(r.restored.sort()).toEqual(['AGENTS.md', 'MEMORY.md', 'SOUL.md']);
    // Undoable: the copy taken first still holds the newer memory.
    expect(w.store.getSnapshot('a1', r.safetySnapshotId!)!.files['MEMORY.md']).toBe('- The owner likes bread\n');
  });

  it('a restore finished after a restart takes it away too; a revert puts it back', async () => {
    for (const action of ['finish', 'revert'] as const) {
      const w = folderWorld(); dirs.push(w.dir);
      writeFileSync(join(w.dir, 'SOUL.md'), 'soul\n');
      const snap = await captureSnapshot(w.deps, 'a1', { label: 'before memory' });
      writeFileSync(join(w.dir, 'MEMORY.md'), 'memory\n');
      setStepHookForTests((_op, k) => { if (k === 'file-written') throw new SimulatedCrash(); });
      await expect(restoreSnapshot(w.deps, 'a1', snap.id)).rejects.toBeInstanceOf(SimulatedCrash);
      setStepHookForTests(undefined);
      const op = w.store.listOperations(['a1'])[0]!;
      await recoverSnapshotRestore(w.deps, op.id, action);
      expect(existsSync(join(w.dir, 'MEMORY.md'))).toBe(action === 'revert');
    }
  });
});

describe('a restore and the setup-values layer (#68)', () => {
  it('puts the layer and the values back with the files', async () => {
    const w = fileWorld({ ...SEED, 'SOUL.md': 'A calm cook.\n' });
    w.store.setAgentParamState('a1', { style: 'calm' }, { soul: 'A {{style}} cook.\n', persona: 'p {{style}}' });
    const before = await captureSnapshot(w.deps, 'a1', { label: 'calm' });
    // A direct edit rewrote SOUL.md and, with it, the layer; values changed too.
    w.files['SOUL.md'] = 'A loud cook who shouts.\n';
    w.store.setAgentParamState('a1', { style: 'loud' }, { soul: 'A {{style}} cook who shouts.\n', persona: 'p {{style}}' });
    await restoreSnapshot(w.deps, 'a1', before.id);
    const a = w.store.getAgent('a1')!;
    expect(w.files['SOUL.md']).toBe('A calm cook.\n');
    expect(a.paramFiles).toEqual({ soul: 'A {{style}} cook.\n', persona: 'p {{style}}' });
    expect(a.paramValues).toEqual({ style: 'calm' });
  });

  it('a snapshot from before the agent had a layer clears it; one from before layers were kept makes the files the layer', async () => {
    const w = fileWorld(SEED);
    const none = await captureSnapshot(w.deps, 'a1', { label: 'no layer yet' });
    w.store.setAgentParamState('a1', { style: 'calm' }, { soul: 'A {{style}} cook.\n' });
    w.files['SOUL.md'] = 'A calm cook.\n';
    await restoreSnapshot(w.deps, 'a1', none.id);
    expect(w.store.getAgent('a1')!.paramFiles).toBeUndefined();

    // A row written before v2.160.0 has no layer recorded.
    w.store.setAgentParamState('a1', { style: 'calm' }, { soul: 'A {{style}} cook.\n', agents: 'old rules' });
    w.store.insertSnapshot({ id: 'legacy', agentId: 'a1', label: 'old', reason: 'manual', files: { 'SOUL.md': 'An old cook.\n' }, createdAt: '2026-01-01T00:00:00Z' });
    await restoreSnapshot(w.deps, 'a1', 'legacy');
    expect(w.store.getAgent('a1')!.paramFiles).toEqual({ soul: 'An old cook.\n', agents: 'old rules' });
  });
});
