/**
 * Issue #21 (2026-10-09): a restore from a backup replaces the agent's whole
 * volume, so its runtime must be DOWN first whatever the record says. A
 * FAILED agent's container may still be running (a failed rebuild or health
 * check leaves it so); the restore used to stop it only when the record said
 * RUNNING, so the safety copy and the import ran against a live agent. When
 * the stop cannot be confirmed (its machine unreachable), the restore is
 * refused with nothing changed. The owner's held choices (finish / put back)
 * check the same before they import.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentArchiveName, restoreAgentFromBackup, restoreSafetyDir } from '../src/orchestrator/backups.js';
import { clearBusy } from '../src/orchestrator/busy.js';
import { newBootForTests, setStepHookForTests, SimulatedCrash } from '../src/orchestrator/operations.js';
import { recoverOperation, resumeOperations, type ResumeContext } from '../src/orchestrator/operationsResume.js';
import { makeWorld, seedRunningAgent } from './support/world.js';

const bdir = mkdtempSync(join(tmpdir(), 'hb-restore-quiet-'));
const prevDir = process.env.HATCHABOT_BACKUP_DIR;
beforeAll(() => { process.env.HATCHABOT_BACKUP_DIR = bdir; });
afterAll(() => {
  if (prevDir === undefined) delete process.env.HATCHABOT_BACKUP_DIR; else process.env.HATCHABOT_BACKUP_DIR = prevDir;
  rmSync(bdir, { recursive: true, force: true });
});
afterEach(() => setStepHookForTests(undefined));

let nights = 0;
async function world() {
  const w = await makeWorld();
  const id = await seedRunningAgent(w, { name: 'Test Agent', slug: 'test-agent', accountId: 'testagentbot', memory: 'current-memory' });
  const ref = w.store.getAgent(id)!.runtimeRef!;
  const date = `2026-08-${String(++nights).padStart(2, '0')}`;
  mkdirSync(join(bdir, date), { recursive: true });
  writeFileSync(join(bdir, date, agentArchiveName(ref)), 'that-night');
  const volume = () => w.provider.stateStore.get(ref)?.toString();
  const phase = async () => (await w.provider.status(ref)).phase;
  // The runtime's phase at the moment each volume step runs.
  const seen: string[] = [];
  const exp = w.provider.exportState.bind(w.provider);
  const imp = w.provider.importState.bind(w.provider);
  w.provider.exportState = async (r) => { seen.push(`export:${await phase()}`); return exp(r); };
  w.provider.importState = async (r, d) => { seen.push(`import:${await phase()}`); return imp(r, d); };
  const ctx: ResumeContext = { store: w.store, secrets: w.secrets, channel: w.channel, sleep: async () => {}, providerForHost: () => w.provider };
  return { w, id, ref, date, volume, phase, seen, ctx };
}

describe('restore from a backup: the runtime is confirmed down first (issue #21)', () => {
  it('a FAILED agent whose container is still running is stopped before the safety copy and the import, and not started after', async () => {
    const r = await world();
    r.w.store.setAgentState(r.id, 'FAILED', 'A rebuild failed.');
    expect(await r.phase()).toBe('running'); // FAILED in the record, still up on the machine
    const res = await restoreAgentFromBackup({ store: r.w.store, provider: r.w.provider }, r.id, r.date);
    expect(r.seen).toEqual(['export:stopped', 'import:stopped']);
    expect(r.volume()).toBe('that-night');
    // Its record decided: it was not running, so it is not started; Retry does that.
    expect(res.running).toBe(false);
    expect(await r.phase()).toBe('stopped');
    expect(r.w.store.getAgent(r.id)!.state).toBe('FAILED');
    expect(r.w.store.listOperations([r.id])[0]!.status).toBe('succeeded');
  });

  it('a stop that cannot be confirmed (machine unreachable) refuses the restore and changes nothing', async () => {
    const r = await world();
    r.w.provider.stop = async () => { throw new Error('cannot connect to the docker daemon'); };
    r.w.provider.status = async () => ({ phase: 'unknown' });
    await expect(restoreAgentFromBackup({ store: r.w.store, provider: r.w.provider }, r.id, r.date))
      .rejects.toThrow(/could not be confirmed stopped.*nothing was changed/s);
    expect(r.seen).toEqual([]); // no safety copy taken, no import
    expect(r.volume()).toBe('current-memory');
    expect(r.w.store.getAgent(r.id)!.state).toBe('RUNNING');
    const op = r.w.store.listOperations([r.id])[0]!;
    expect(op.status).toBe('rolled_back');
    expect(op.outcome).toMatch(/could not be confirmed stopped/);
    expect(existsSync(String(op.params.safetyFile))).toBe(false);
  });

  it('a stop that does not take (still running after it) is refused too, for a FAILED agent', async () => {
    const r = await world();
    r.w.store.setAgentState(r.id, 'FAILED', 'A rebuild failed.');
    r.w.provider.stop = async () => {}; // says it stopped, but did not
    await expect(restoreAgentFromBackup({ store: r.w.store, provider: r.w.provider }, r.id, r.date))
      .rejects.toThrow(/could not be confirmed stopped.*still running/s);
    expect(r.seen).toEqual([]);
    expect(r.volume()).toBe('current-memory');
    expect(r.w.store.getAgent(r.id)!.state).toBe('FAILED');
  });

  for (const action of ['finish', 'put-back'] as const) {
    it(`a held restore's "${action}" stops a runtime found running first, and refuses (still held) when it cannot`, async () => {
      const r = await world();
      setStepHookForTests((_op, k) => { if (k === 'replaced') throw new SimulatedCrash(); });
      await expect(restoreAgentFromBackup({ store: r.w.store, provider: r.w.provider }, r.id, r.date)).rejects.toBeInstanceOf(SimulatedCrash);
      setStepHookForTests(undefined); clearBusy(r.id); newBootForTests();
      await resumeOperations(r.ctx);
      const op = r.w.store.listOperations([r.id])[0]!;
      expect(op.status).toBe('held');
      // Something started it while it was held (the boot pass's stop did not take).
      await r.w.provider.start(r.ref);
      r.seen.length = 0;
      const realStop = r.w.provider.stop.bind(r.w.provider);
      const realStatus = r.w.provider.status.bind(r.w.provider);
      r.w.provider.stop = async () => { throw new Error('cannot connect to the docker daemon'); };
      r.w.provider.status = async () => ({ phase: 'unknown' });
      await expect(recoverOperation(r.ctx, op.id, action)).rejects.toThrow(/could not be confirmed stopped/);
      expect(r.seen).toEqual([]);
      expect(r.w.store.getOperation(op.id)!.status).toBe('held');
      // Its machine answers again: stopped first, then the volume step.
      r.w.provider.stop = realStop;
      r.w.provider.status = realStatus;
      const after = await recoverOperation(r.ctx, op.id, action);
      expect(after.status).toBe(action === 'finish' ? 'succeeded' : 'rolled_back');
      expect(r.seen).toEqual(['import:stopped']);
      expect(r.volume()).toBe(action === 'finish' ? 'that-night' : 'current-memory');
      expect(existsSync(restoreSafetyDir()) ? existsSync(String(op.params.safetyFile)) : false).toBe(false);
    });
  }
});
