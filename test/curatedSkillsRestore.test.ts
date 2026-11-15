import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentArchiveName, recoverBackupRestore, restoreAgentFromBackup, resumeBackupRestore } from '../src/orchestrator/backups.js';
import { reapplyCurrentSettings } from '../src/orchestrator/provision.js';
import { SimulatedCrash } from '../src/orchestrator/operations.js';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';

let directory: string;
const worlds: World[] = [];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hatchabot-skill-restore-'));
  vi.stubEnv('HATCHABOT_BACKUP_DIR', directory);
});
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.f.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

async function fixture(before: string[] | undefined) {
  const w = await makeWorld();
  worlds.push(w);
  const id = await seedRunningAgent(w, { memory: 'before-restore' });
  const ref = w.store.getAgent(id)!.runtimeRef!;
  const date = '2026-11-01';
  mkdirSync(join(directory, date));
  writeFileSync(join(directory, date, agentArchiveName(ref)), 'backup-memory');
  w.store.setAgentCuratedSkills(id, ['gog']);
  w.store.setAgentCuratedSkillsApplied(id, before);
  return { w, id, ref, date, deps: { store: w.store, provider: w.provider } };
}

describe('skill apply metadata follows whole-volume backup restoration', () => {
  it('clears the old applied choice when a restored volume can only receive fallback access repairs', async () => {
    const { w, id, ref, date, deps } = await fixture(['gog']);
    await restoreAgentFromBackup({ ...deps, reapply: async () => {
      expect(w.store.getAgent(id)?.appliedCuratedSkills).toBeUndefined();
      throw new Error('isolated reapply failure');
    } }, id, date);
    expect(w.provider.stateStore.get(ref)?.toString()).toBe('backup-memory');
    expect(w.store.getAgent(id)).toMatchObject({ state: 'RUNNING', curatedSkills: ['gog'], appliedCuratedSkills: undefined });
    const view = await w.f.inject({ method: 'GET', url: `/v1/agents/${id}/skills`, headers: as(w.owner) });
    expect(view.json()).toMatchObject({ selected: ['gog'], applied: null, pending: true });
  });

  it('records a fresh applied choice only after the current configuration succeeds', async () => {
    const { w, id, date, deps } = await fixture(['gog']);
    w.store.setAgentCuratedSkills(id, []);
    await restoreAgentFromBackup({ ...deps, reapply: async () => {
      expect(w.store.getAgent(id)?.appliedCuratedSkills).toBeUndefined();
      await reapplyCurrentSettings({ ...deps, secrets: w.secrets, channel: w.channel }, id);
    } }, id, date);
    expect(w.store.getAgent(id)).toMatchObject({ curatedSkills: [], appliedCuratedSkills: [] });
  });

  for (const before of [undefined, [], ['gog']]) {
    it(`restores the prior ${JSON.stringify(before)} metadata when the safety volume is put back`, async () => {
      const { w, id, ref, date, deps } = await fixture(before);
      w.store.setAgentCuratedSkills(id, ['hatchabot-writing']);
      w.provider.execShellOnVolume = async () => ({ code: 1, stdout: '', stderr: 'isolated access repair failure' });
      await expect(restoreAgentFromBackup({ ...deps, reapply: async () => {
        // A configuration may succeed before a subsequent safety step fails.
        w.store.setAgentCuratedSkillsApplied(id, ['hatchabot-writing']);
        throw new Error('isolated reapply failure');
      } }, id, date)).rejects.toThrow(/left as it was/);
      expect(w.provider.stateStore.get(ref)?.toString()).toBe('before-restore');
      expect(w.store.getAgent(id)).toMatchObject({ state: 'RUNNING', curatedSkills: ['hatchabot-writing'], appliedCuratedSkills: before });
    });
  }

  it('keeps the applied choice unknown if both the restore and its safety rollback fail', async () => {
    const { w, id, date, deps } = await fixture(['gog']);
    w.provider.importStateFromFile = async () => { throw new Error('isolated partial extraction failure'); };
    await expect(restoreAgentFromBackup(deps, id, date)).rejects.toThrow(/could not be put back/);
    expect(w.store.getAgent(id)).toMatchObject({ state: 'FAILED', curatedSkills: ['gog'], appliedCuratedSkills: undefined });
  });

  it('clears a successfully reapplied choice if a later access scrub fails and the safety copy tears', async () => {
    const { w, id, ref, date, deps } = await fixture(['gog']);
    w.store.setAgentCuratedSkills(id, ['hatchabot-writing']);
    w.store.insertMembership({ id: 'revoked-seat', agentId: id, userId: 'removed-member', role: 'user', channelUserId: '4242', status: 'revoked' });
    const importFile = w.provider.importStateFromFile.bind(w.provider);
    let imports = 0;
    w.provider.importStateFromFile = async (runtime, path) => {
      if (++imports === 2) {
        w.provider.stateStore.set(runtime, Buffer.from('partial-safety-copy'));
        throw new Error('isolated partial safety extraction');
      }
      await importFile(runtime, path);
    };
    w.provider.execShellOnVolume = async () => ({ code: 1, stdout: '', stderr: 'isolated access scrub failure' });
    await expect(restoreAgentFromBackup({ ...deps, reapply: async () => {
      await reapplyCurrentSettings({ ...deps, secrets: w.secrets, channel: w.channel }, id);
      expect(w.store.getAgent(id)?.appliedCuratedSkills).toEqual(['hatchabot-writing']);
    } }, id, date)).rejects.toThrow(/could not be put back/);
    expect(imports).toBe(2);
    expect(w.provider.stateStore.get(ref)?.toString()).toBe('partial-safety-copy');
    expect(w.store.getAgent(id)).toMatchObject({ state: 'FAILED', curatedSkills: ['hatchabot-writing'], appliedCuratedSkills: undefined });
  });

  it.each(['put-back', 'finish'])('recovers skill metadata through the persisted %s choice', async (action) => {
    const { w, id, ref, date, deps } = await fixture([]);
    await expect(restoreAgentFromBackup({ ...deps, reapply: async () => { throw new SimulatedCrash(); } }, id, date)).rejects.toBeInstanceOf(SimulatedCrash);
    const op = w.store.listOperations([id])[0]!;
    expect(op.params.appliedCuratedSkillsBefore).toEqual([]);
    await resumeBackupRestore(deps, op.id);
    expect(w.store.getAgent(id)?.appliedCuratedSkills).toBeUndefined();
    await recoverBackupRestore(deps, op.id, action);
    expect(w.provider.stateStore.get(ref)?.toString()).toBe(action === 'put-back' ? 'before-restore' : 'backup-memory');
    expect(w.store.getAgent(id)).toMatchObject({ curatedSkills: ['gog'], appliedCuratedSkills: action === 'put-back' ? [] : undefined });
  });
});
