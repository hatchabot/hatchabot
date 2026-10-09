/**
 * Durable operations, phase 2 (docs/operations-and-one-interface-design.md,
 * "Order of work" item 2): restores, archive, the rebuild queue, setup, a
 * runner's image copy and Back up now.
 *
 * The kill-at-every-step tests run each operation against the mock provider,
 * stop it at step n as a dead process would (no rollback, no busy flag), start
 * a "new process" (new boot id), run resumeOperations(), and check:
 *  - never two running copies, and never a container polling a bot it gave back;
 *  - a volume possibly half-replaced is never started without the owner's choice;
 *  - a held agent refuses Start.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { agentArchiveName, restoreAgentFromBackup, restoreSafetyDir } from '../src/orchestrator/backups.js';
import { captureSnapshot, restoreSnapshot } from '../src/orchestrator/snapshots.js';
import { archiveAgent } from '../src/orchestrator/archive.js';
import { clearBusy } from '../src/orchestrator/busy.js';
import {
  beginOperation, markInterrupted, newBootForTests, operationRefusal, setStepHookForTests, SimulatedCrash, STEPS,
} from '../src/orchestrator/operations.js';
import { recoverOperation, resumeOperations, retryHeldOperations, type ResumeContext } from '../src/orchestrator/operationsResume.js';
import { reconcileAgents } from '../src/orchestrator/reconcile.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { as, MemSecrets, makeWorld, seedRunningAgent, type World } from './support/world.js';

const crashAt = (key: string) => setStepHookForTests((_op, k) => { if (k === key) throw new SimulatedCrash(); });
const reboot = (agentId: string) => { setStepHookForTests(undefined); clearBusy(agentId); newBootForTests(); };
const keysOf = (kind: keyof typeof STEPS, last = '#succeeded') => [...STEPS[kind]!.map((s) => s.key), last];
const ctxFor = (w: Pick<World, 'store' | 'secrets' | 'channel' | 'provider'>): ResumeContext => ({
  store: w.store, secrets: w.secrets, channel: w.channel, sleep: async () => {}, providerForHost: () => w.provider,
});

const bdir = mkdtempSync(join(tmpdir(), 'hb-ops2-bk-'));
const prevDir = process.env.HATCHABOT_BACKUP_DIR;
beforeAll(() => { process.env.HATCHABOT_BACKUP_DIR = bdir; });
afterAll(() => {
  if (prevDir === undefined) delete process.env.HATCHABOT_BACKUP_DIR; else process.env.HATCHABOT_BACKUP_DIR = prevDir;
  rmSync(bdir, { recursive: true, force: true });
});
afterEach(() => { setStepHookForTests(undefined); vi.restoreAllMocks(); });


// ---- restore from a backup ---------------------------------------------------

let nights = 0;
async function backupWorld() {
  const w = await makeWorld();
  const id = await seedRunningAgent(w, { name: 'Test Agent', slug: 'test-agent', accountId: 'testagentbot', memory: 'current-memory' });
  const ref = w.store.getAgent(id)!.runtimeRef!;
  const date = `2026-09-${String(++nights).padStart(2, '0')}`;
  mkdirSync(join(bdir, date), { recursive: true });
  writeFileSync(join(bdir, date, agentArchiveName(ref)), 'that-night');
  const volume = () => w.provider.stateStore.get(ref)?.toString();
  const phase = async () => (await w.provider.status(ref)).phase;
  return { w, id, ref, date, ctx: ctxFor(w), volume, phase };
}

describe('restore from a backup: killed at every step, then a restart', () => {
  for (const key of keysOf('restore-backup')) {
    const before = key === 'stopped' || key === 'safety-taken';
    it(`at "${key}": ${before ? 'undone, started again as it was' : key === '#succeeded' ? 'finished' : 'held, stopped, Start refused'}`, async () => {
      const r = await backupWorld();
      crashAt(key);
      await expect(restoreAgentFromBackup({ store: r.w.store, provider: r.w.provider }, r.id, r.date)).rejects.toBeInstanceOf(SimulatedCrash);
      reboot(r.id);
      await resumeOperations(r.ctx);
      const op = r.w.store.listOperations([r.id])[0]!;
      if (before) {
        expect(op.status).toBe('rolled_back');
        expect(r.volume()).toBe('current-memory');
        expect(await r.phase()).toBe('running');
        expect(r.w.store.getAgent(r.id)!.state).toBe('RUNNING');
        expect(existsSync(String(op.params.safetyFile))).toBe(false);
        return;
      }
      if (key === '#succeeded') {
        expect(op.status).toBe('succeeded');
        expect(r.volume()).toBe('that-night');
        expect(await r.phase()).toBe('running');
        return;
      }
      // Its volume may be half-replaced: never started without a choice.
      expect(op.status).toBe('held');
      expect(op.recovery!.actions.map((a) => a.action)).toEqual(['finish', 'put-back']);
      expect(await r.phase()).toBe('stopped');
      expect(r.w.store.getAgent(r.id)!.state).toBe('STOPPED');
      expect(operationRefusal(r.w.store, r.id)).toMatch(/interrupted by a restart.*Choose what to do/s);
      // The copy of how it was is ON DISK (it was in memory only, lost with the process).
      const kept = String(op.params.safetyFile);
      expect(readFileSync(kept, 'utf8')).toBe('current-memory');
      expect(kept.startsWith(restoreSafetyDir())).toBe(true);
    });
  }

  for (const action of ['put-back', 'finish'] as const) {
    it(`held, the owner chooses "${action}": ${action === 'put-back' ? 'the copy from before goes back' : "that night's copy, with today's settings"}, started again`, async () => {
      const r = await backupWorld();
      crashAt('reapplied');
      await expect(restoreAgentFromBackup({ store: r.w.store, provider: r.w.provider }, r.id, r.date)).rejects.toBeInstanceOf(SimulatedCrash);
      reboot(r.id);
      await resumeOperations(r.ctx);
      const op = r.w.store.listOperations([r.id])[0]!;
      const after = await recoverOperation(r.ctx, op.id, action);
      expect(after.status).toBe(action === 'put-back' ? 'rolled_back' : 'succeeded');
      expect(r.volume()).toBe(action === 'put-back' ? 'current-memory' : 'that-night');
      expect(await r.phase()).toBe('running');
      expect(r.w.store.getAgent(r.id)!.state).toBe('RUNNING');
      expect(existsSync(String(op.params.safetyFile))).toBe(false); // it holds secrets: gone once settled
      expect(operationRefusal(r.w.store, r.id)).toBeUndefined();
    });
  }

  it('the API: a held restore refuses Start, offers its choices, and Put back works', async () => {
    const r = await backupWorld();
    crashAt('replaced');
    await expect(restoreAgentFromBackup({ store: r.w.store, provider: r.w.provider }, r.id, r.date)).rejects.toBeInstanceOf(SimulatedCrash);
    reboot(r.id);
    await r.w.routes!.resumeOperations();
    const start = await r.w.f.inject({ method: 'POST', url: `/v1/agents/${r.id}/start`, headers: as() });
    expect(start.statusCode).toBe(409);
    expect(start.json().error).toMatch(/Choose what to do on its page first/);
    const agent = (await r.w.f.inject({ method: 'GET', url: `/v1/agents/${r.id}`, headers: as() })).json();
    expect(agent.operation).toMatchObject({ kind: 'restore-backup', status: 'held' });
    const opId = agent.operation.id;
    const wrong = await r.w.f.inject({ method: 'POST', url: `/v1/operations/${opId}/recover`, headers: as(), payload: { action: 'undo' } });
    expect(wrong.statusCode).toBe(400);
    const ok = await r.w.f.inject({ method: 'POST', url: `/v1/operations/${opId}/recover`, headers: as(), payload: { action: 'put-back' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().operation.status).toBe('rolled_back');
    expect(r.volume()).toBe('current-memory');
    expect((await r.w.f.inject({ method: 'GET', url: `/v1/agents/${r.id}`, headers: as() })).json().state).toBe('RUNNING');
  });

  it('a restore that finishes leaves no copy on disk; one whose undo fails keeps it (issue #12 unchanged)', async () => {
    const r = await backupWorld();
    await restoreAgentFromBackup({ store: r.w.store, provider: r.w.provider }, r.id, r.date);
    const done = r.w.store.listOperations([r.id])[0]!;
    expect(done).toMatchObject({ kind: 'restore-backup', status: 'succeeded' });
    expect(existsSync(String(done.params.safetyFile))).toBe(false);
    // The extract and the put-back both fail: stopped, FAILED, the copy kept, the record failed (not held).
    const r2 = await backupWorld();
    r2.w.provider.importState = async () => { throw new Error('disk failure'); };
    await expect(restoreAgentFromBackup({ store: r2.w.store, provider: r2.w.provider }, r2.id, r2.date)).rejects.toThrow(/could not be put back/);
    const op = r2.w.store.listOperations([r2.id])[0]!;
    expect(op.status).toBe('failed');
    expect(readFileSync(String(op.params.safetyFile), 'utf8')).toBe('current-memory');
    expect(r2.w.store.getAgent(r2.id)!.state).toBe('FAILED');
    rmSync(String(op.params.safetyFile));
  });
});

// ---- restore a snapshot --------------------------------------------------------

const OLD = { 'SOUL.md': 'soul v1\n', 'AGENTS.md': 'agents v1\n', 'MEMORY.md': 'memory v1\n' };
const NEW = { 'SOUL.md': 'soul v2\n', 'AGENTS.md': 'agents v2\n', 'MEMORY.md': 'memory v2\n' };

async function snapshotWorld() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  const files: Record<string, string> = { ...OLD };
  (provider as any).execShell = async (_ref: string, script: string) => {
    const name = script.match(/agents\/[^/]+\/agent\/([A-Za-z.]+)/)?.[1] ?? '';
    if (script.startsWith('head -c')) return { code: 0, stdout: files[name] ?? '', stderr: '' };
    const b64 = script.match(/echo "([^"]*)"/)?.[1] ?? '';
    files[name] = Buffer.from(b64, 'base64').toString('utf8');
    return { code: 0, stdout: '', stderr: '' };
  };
  store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAgent({ id: 'a1', ownerId: 'o', name: 'Test Agent', slug: 'test-agent', state: 'PROVISIONING', aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  store.setAgentRuntimeRef('a1', 'mock://a1');
  store.setAgentState('a1', 'RUNNING');
  const good = await captureSnapshot({ store, provider }, 'a1', { label: 'good state' });
  Object.assign(files, NEW);
  const ctx: ResumeContext = { store, secrets: new MemSecrets(), channel: {} as never, providerForHost: () => provider };
  return { store, provider, files, snapId: good.id, ctx };
}

describe('restore a snapshot: killed at every step, then a restart', () => {
  for (const key of keysOf('restore-snapshot')) {
    it(`at "${key}"`, async () => {
      const s = await snapshotWorld();
      crashAt(key);
      await expect(restoreSnapshot({ store: s.store, provider: s.provider }, 'a1', s.snapId)).rejects.toBeInstanceOf(SimulatedCrash);
      reboot('a1');
      await resumeOperations(s.ctx);
      const op = s.store.listOperations(['a1'])[0]!;
      if (key === 'safety-taken') {
        expect(op.status).toBe('rolled_back');
        expect(s.files).toEqual(NEW);
      } else if (key === 'file-written') {
        // One file is the snapshot's, the others not: only the owner knows which way.
        expect(op.status).toBe('held');
        expect(op.recovery!.actions.map((a) => a.action)).toEqual(['finish', 'revert']);
        expect(operationRefusal(s.store, 'a1')).toMatch(/part-way through its files/);
      } else {
        expect(op.status).toBe('succeeded');
        expect(s.files).toEqual(OLD);
      }
    });
  }

  for (const action of ['finish', 'revert'] as const) {
    it(`held, the owner chooses "${action}"`, async () => {
      const s = await snapshotWorld();
      crashAt('file-written');
      await expect(restoreSnapshot({ store: s.store, provider: s.provider }, 'a1', s.snapId)).rejects.toBeInstanceOf(SimulatedCrash);
      reboot('a1');
      await resumeOperations(s.ctx);
      const op = s.store.listOperations(['a1'])[0]!;
      const after = await recoverOperation(s.ctx, op.id, action);
      expect(after.status).toBe(action === 'finish' ? 'succeeded' : 'rolled_back');
      expect(s.files).toEqual(action === 'finish' ? OLD : NEW);
      expect(operationRefusal(s.store, 'a1')).toBeUndefined();
    });
  }
});

// ---- archive -------------------------------------------------------------------

async function archiveWorld(pooled: boolean) {
  const w = await makeWorld();
  const id = await seedRunningAgent(w, { name: 'Test Agent', slug: 'test-agent', accountId: 'testagentbot' });
  const ref = w.store.getAgent(id)!.runtimeRef!;
  if (pooled) w.channel.pool.entries.push({ username: 'testagentbot', token: 'not-a-token', leasedTo: id, ownerId: w.owner });
  // Releasing a bot frees its lease, as the real pool does.
  w.channel.release = async (accountId: string) => {
    const e = w.channel.pool.entries.find((x: { username: string }) => x.username === accountId);
    if (e) e.leasedTo = undefined;
  };
  const deps = { store: w.store, secrets: w.secrets, provider: w.provider, channel: w.channel, log: () => {} };
  const botFree = () => w.channel.pool.entries.some((e: { username: string; leasedTo?: string }) => e.username === 'testagentbot' && !e.leasedTo);
  return { w, id, ref, deps, ctx: ctxFor(w), botFree };
}

describe('archive: killed at every step, then a restart', () => {
  for (const pooled of [false, true]) {
    for (const key of keysOf('archive')) {
      const given = key !== 'stopped';
      it(`${pooled ? 'a pool bot' : 'a pasted bot'}, at "${key}": ${given ? 'finished — archived, stopped' : 'undone — running again'}`, async () => {
        const a = await archiveWorld(pooled);
        crashAt(key);
        await expect(archiveAgent(a.deps, a.id)).rejects.toBeInstanceOf(SimulatedCrash);
        reboot(a.id);
        await resumeOperations(a.ctx);
        const op = a.w.store.listOperations([a.id])[0]!;
        const phase = (await a.w.provider.status(a.ref)).phase;
        // Never a container polling a bot that is free for someone else.
        expect(a.botFree() && phase === 'running').toBe(false);
        if (given) {
          expect(op.status).toBe('succeeded');
          expect(a.w.store.getAgent(a.id)!.state).toBe('ARCHIVED');
          expect(phase).toBe('stopped');
          expect(a.w.store.getChannelForAgent(a.id)).toBeUndefined();
        } else {
          expect(op.status).toBe('rolled_back');
          expect(a.w.store.getAgent(a.id)!.state).toBe('RUNNING');
          expect(phase).toBe('running');
          expect(a.w.store.getChannelForAgent(a.id)?.accountId).toBe('testagentbot');
        }
        expect(operationRefusal(a.w.store, a.id)).toBeUndefined();
      });
    }
  }
});

// ---- the rebuild queue and setup ----------------------------------------------

describe('the rebuild queue survives a restart', () => {
  it('a rebuild still waiting its turn is queued again and runs; it never refuses Start meanwhile', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    const ref = w.store.getAgent(id)!.runtimeRef!;
    const op = beginOperation(w.store, 'rebuild', id, { checkpoint: false, was: { state: 'RUNNING', hostId: 'h1', runtimeRef: ref, migratedTo: null } }, { queued: true });
    expect(operationRefusal(w.store, id)).toBeUndefined();
    newBootForTests();
    // Boot: a queued row is not interrupted; reconcile still judges the agent.
    markInterrupted(w.store);
    expect(w.store.getOperation(op.id)!.status).toBe('queued');
    await w.routes!.resumeOperations();
    await vi.waitFor(() => expect(w.store.getOperation(op.id)!.status).toBe('succeeded'));
    expect(w.store.listEvents([id], 50).some((e) => e.event === 'runtime.rebuilt')).toBe(true);
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');
  });

  it("one queued again is judged by staleRebuild against the agent as it was asked for", async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    const op = beginOperation(w.store, 'rebuild', id, { was: { state: 'RUNNING', hostId: 'h-elsewhere', runtimeRef: 'mock://elsewhere', migratedTo: null } }, { queued: true });
    newBootForTests();
    await w.routes!.resumeOperations();
    await vi.waitFor(() => expect(w.store.getOperation(op.id)!.status).toBe('rolled_back'));
    expect(w.store.getOperation(op.id)!.outcome).toMatch(/Not rebuilt: moved to another machine/);
  });

  it('Rebuild records a queued, then running, then finished operation, and Start is not refused by it', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    const res = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/rebuild`, headers: as() });
    expect(res.statusCode).toBe(202);
    const op = w.store.listOperations([id])[0]!;
    expect(op.kind).toBe('rebuild');
    expect(w.store.activeOperationFor(id)).toBeUndefined();
    await vi.waitFor(() => expect(w.store.getOperation(op.id)!.status).toBe('succeeded'));
    // Its lines stay in the journal: the timeline has the rebuild's own events, not op.*.
    expect(w.store.listEvents([id], 50).filter((e) => e.event.startsWith('op.'))).toEqual([]);
  });

  for (const phase of ['running', 'stopped'] as const) {
    it(`a rebuild cut off after REBUILDING, its container ${phase}: reconcile's rule, recorded on the operation`, async () => {
      const w = await makeWorld();
      const id = await seedRunningAgent(w);
      const ref = w.store.getAgent(id)!.runtimeRef!;
      const op = beginOperation(w.store, 'rebuild', id, {});
      w.store.setAgentState(id, 'REBUILDING');
      if (phase === 'stopped') await w.provider.stop(ref);
      newBootForTests();
      markInterrupted(w.store);
      // Reconcile leaves it to the recovery (the operation is not over).
      await reconcileAgents(w.store, new Map([['mock', w.provider]]), () => {});
      expect(w.store.getAgent(id)!.state).toBe('REBUILDING');
      await resumeOperations(ctxFor(w));
      const after = w.store.getOperation(op.id)!;
      if (phase === 'running') {
        expect(w.store.getAgent(id)!.state).toBe('RUNNING');
        expect(after.status).toBe('succeeded');
      } else {
        expect(w.store.getAgent(id)).toMatchObject({ state: 'FAILED', stateReason: 'The rebuild was interrupted — tap Retry.' });
        expect(after).toMatchObject({ status: 'failed', outcome: 'The rebuild was interrupted — tap Retry.' });
      }
    });
  }

  it("a rebuild cut off with its machine not answering stays interrupted (Start refused), and is settled when it answers", async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    const op = beginOperation(w.store, 'rebuild', id, {});
    w.store.setAgentState(id, 'REBUILDING');
    newBootForTests();
    const status = w.provider.status.bind(w.provider);
    w.provider.status = async () => ({ phase: 'unknown' }) as never;
    await resumeOperations(ctxFor(w));
    expect(w.store.getOperation(op.id)!.status).toBe('interrupted');
    expect(operationRefusal(w.store, id)).toMatch(/Rebuild was interrupted by a restart/);
    w.provider.status = status;
    await retryHeldOperations(ctxFor(w));
    expect(w.store.getOperation(op.id)!.status).toBe('succeeded');
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');
  });

  it('a setup cut off before its container existed: FAILED "Setup was interrupted — tap Retry", on the record too', async () => {
    const w = await makeWorld();
    w.store.insertAgent({ id: 'a2', ownerId: w.owner, name: 'Test Agent', slug: 'test-agent', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
    const op = beginOperation(w.store, 'provision', 'a2', {});
    newBootForTests();
    markInterrupted(w.store);
    await reconcileAgents(w.store, new Map([['mock', w.provider]]), () => {});
    expect(w.store.getAgent('a2')!.state).toBe('PROVISIONING');
    await resumeOperations(ctxFor(w));
    expect(w.store.getAgent('a2')).toMatchObject({ state: 'FAILED', stateReason: 'Setup was interrupted — tap Retry.' });
    expect(w.store.getOperation(op.id)).toMatchObject({ status: 'failed', outcome: 'Setup was interrupted — tap Retry.' });
  });

  it('Retry records a setup operation with its outcome', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    w.store.setAgentState(id, 'FAILED', 'made up');
    const res = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/provision`, headers: as() });
    expect(res.statusCode).toBe(202);
    const op = w.store.listOperations([id])[0]!;
    expect(op.kind).toBe('provision');
    await vi.waitFor(() => expect(['succeeded', 'failed']).toContain(w.store.getOperation(op.id)!.status));
    const agent = w.store.getAgent(id)!;
    expect(w.store.getOperation(op.id)!.status).toBe(agent.state === 'FAILED' ? 'failed' : 'succeeded');
  });
});

// ---- a machine's operations: image copy, Back up now --------------------------

describe("a machine's operations", () => {
  async function runnerWorld() {
    const w = await makeWorld();
    w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock2', name: 'Test Runner', settings: { dockerHost: 'ssh://runner.example.org' }, createdAt: 'now' });
    return w;
  }

  it('an image copy cut off by a restart: failed with [Install again]; the page reads "interrupted", not idle', async () => {
    const w = await runnerWorld();
    const before = await w.f.inject({ method: 'GET', url: '/v1/hosts/h2/install-image', headers: as() });
    expect(before.json()).toEqual({ idle: true });
    const op = beginOperation(w.store, 'install-image', null, { image: 'hatchabot-runtime:latest', host: 'Test Runner' }, { hostId: 'h2', requestedBy: w.owner });
    newBootForTests();
    await w.routes!.resumeOperations();
    expect(w.store.getOperation(op.id)).toMatchObject({ status: 'failed', recovery: { actions: [{ action: 'install-again', label: 'Install again' }] } });
    const after = (await w.f.inject({ method: 'GET', url: '/v1/hosts/h2/install-image', headers: as() })).json();
    expect(after).toMatchObject({ done: true, ok: false, interrupted: true, operation: op.id });
    expect(after.error).toMatch(/interrupted by a restart/);
  });

  it("the Activity list shows a machine's operations to that machine's owner only", async () => {
    const w = await runnerWorld();
    const op = beginOperation(w.store, 'install-image', null, { host: 'Test Runner' }, { hostId: 'h2' });
    op.done('The runtime image was copied to Test Runner (1.0 GB).');
    const mine = (await w.f.inject({ method: 'GET', url: '/v1/events', headers: as() })).json();
    expect(mine).toContainEqual(expect.objectContaining({
      agentId: null, agentName: 'Test Runner', event: 'op.done', label: 'Image install: The runtime image was copied to Test Runner (1.0 GB).',
    }));
    const theirs = (await w.f.inject({ method: 'GET', url: '/v1/events', headers: as('someone-else') })).json();
    expect(theirs.some((e: { agentId: string | null }) => e.agentId === null)).toBe(false);
    // One agent's timeline never carries them.
    const id = await seedRunningAgent(w);
    const one = (await w.f.inject({ method: 'GET', url: `/v1/events?agentId=${id}`, headers: as() })).json();
    expect(one.some((e: { agentId: string | null }) => e.agentId === null)).toBe(false);
  });

  it('Back up now is recorded as an operation of this machine, and how it ended', async () => {
    const w = await makeWorld();
    const scripts = mkdtempSync(join(tmpdir(), 'hb-ops2-script-'));
    const script = join(scripts, 'backup.sh');
    writeFileSync(script, '#!/bin/sh\necho "made-up backup done"\n');
    chmodSync(script, 0o700);
    const prev = process.env.HATCHABOT_BACKUP_SCRIPT;
    process.env.HATCHABOT_BACKUP_SCRIPT = script;
    try {
      const res = await w.f.inject({ method: 'POST', url: '/v1/backups/run', headers: as() });
      expect(res.statusCode).toBe(200);
      const op = w.store.listMachineOperations(['h1'])[0]!;
      expect(op.kind).toBe('backup-run');
      await vi.waitFor(() => expect(w.store.getOperation(op.id)!.status).toBe('succeeded'));
      const evs = (await w.f.inject({ method: 'GET', url: '/v1/events', headers: as() })).json();
      expect(evs).toContainEqual(expect.objectContaining({ agentId: null, agentName: 'This machine', label: 'Backup: Backed up.' }));
    } finally {
      if (prev === undefined) delete process.env.HATCHABOT_BACKUP_SCRIPT; else process.env.HATCHABOT_BACKUP_SCRIPT = prev;
      rmSync(scripts, { recursive: true, force: true });
    }
  });

  it('a backup run cut off by a restart is recorded as failed (its set is incomplete)', async () => {
    const w = await makeWorld();
    const op = beginOperation(w.store, 'backup-run', null, {}, { hostId: 'h1' });
    newBootForTests();
    await w.routes!.resumeOperations();
    expect(w.store.getOperation(op.id)).toMatchObject({ status: 'failed' });
    expect(w.store.getOperation(op.id)!.outcome).toMatch(/interrupted by a restart/);
  });
});
