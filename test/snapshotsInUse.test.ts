/**
 * A held snapshot restore keeps the two snapshots it can end with (deep audit
 * of v2.166.2, #020): deleted through the ordinary route, Finish and Revert
 * both failed, and nothing could clear the held operation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { as, makeWorld, seedRunningAgent } from './support/world.js';
import { captureSnapshot, recoverSnapshotRestore, restoreSnapshot, resumeSnapshotRestore } from '../src/orchestrator/snapshots.js';
import { setStepHookForTests, SimulatedCrash } from '../src/orchestrator/operations.js';

afterEach(() => setStepHookForTests(undefined));

describe('DELETE /v1/agents/:id/snapshots/:snapId', () => {
  it('refuses the target and the safety copy of an unfinished restore; any other snapshot goes; once finished, they go too', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    // A file-aware runtime: the core files a snapshot reads and a restore writes.
    const files: Record<string, string> = { 'SOUL.md': 'old soul', 'AGENTS.md': 'old rules', 'MEMORY.md': 'old memories' };
    w.provider.execShell = async (_ref, script) => {
      const name = script.match(/agents\/[^/]+\/agent\/([A-Za-z.]+)/)?.[1] ?? '';
      if (script.startsWith('head -c')) return { code: 0, stdout: files[name] ?? '', stderr: files[name] === '' ? 'hatchabot:empty-file' : '' };
      if (script.startsWith('rm -f')) delete files[name];
      else files[name] = Buffer.from(script.match(/echo "([^"]*)"/)?.[1] ?? '', 'base64').toString('utf8');
      return { code: 0, stdout: '', stderr: '' };
    };
    const deps = { store: w.store, provider: w.provider };
    try {
      const target = await captureSnapshot(deps, id, { label: 'earlier' });
      const unrelated = await captureSnapshot(deps, id, { label: 'another day' });
      for (const name of Object.keys(files)) files[name] = `new ${name}`;
      setStepHookForTests((_op, step) => { if (step === 'file-written') throw new SimulatedCrash(); });
      await expect(restoreSnapshot(deps, id, target.id)).rejects.toBeInstanceOf(SimulatedCrash);
      setStepHookForTests(undefined);
      const op = w.store.listOperations([id])[0]!;
      await resumeSnapshotRestore(deps, op.id);
      expect(w.store.getOperation(op.id)?.status).toBe('held');
      const del = (snapId: string) => w.f.inject({ method: 'DELETE', url: `/v1/agents/${id}/snapshots/${snapId}`, headers: as() });
      for (const snapId of [target.id, String(op.params.safetySnapshotId)]) {
        const r = await del(snapId);
        expect(r.statusCode, r.body).toBe(409);
        expect(r.json().error).toMatch(/restore that has not finished still needs this snapshot/);
        expect(w.store.getSnapshot(id, snapId)).toBeDefined();
      }
      expect((await del(unrelated.id)).statusCode).toBe(200);
      await recoverSnapshotRestore(deps, op.id, 'finish');
      expect(files['AGENTS.md']).toBe('old rules');
      expect((await del(target.id)).statusCode).toBe(200);
      expect((await del(String(op.params.safetySnapshotId))).statusCode).toBe(200);
    } finally {
      await w.f.close();
    }
  });
});
