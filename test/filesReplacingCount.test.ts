import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { LocalSecretStore } from '../src/secrets/localSecretStore.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { createBackups, type Backups } from '../src/orchestrator/backups/backups.js';
import { agentArchiveName } from '../src/orchestrator/backups/backupFiles.js';
import { archiveAgent } from '../src/orchestrator/lifecycle/archive.js';
import { clearBusy, isBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import { beginOperation, filesReplacingCount, setStepHookForTests, SimulatedCrash } from '../src/orchestrator/lifecycle/operations.js';
import { recoverOperation, resumeOperations, type ResumeContext } from '../src/orchestrator/lifecycle/operationsResume.js';
import { createRebuildQueue } from '../src/orchestrator/lifecycle/rebuildQueue.js';
import { moveAgentToHost } from '../src/orchestrator/transfer/moveHost.js';
import { migrateAgent } from '../src/orchestrator/transfer/migrate.js';
import { applyWorkspace } from '../src/orchestrator/transfer/adopt.js';
import { exportAgent, importAgent } from '../src/orchestrator/transfer/transfer.js';
import type { Agent } from '../src/domain/types.js';
import { MemSecrets, makeWorld, seedRunningAgent, viaGlobalFetch } from './support/world.js';

/**
 * When the count of changes that replace an agent's files moves
 * (operations.ts: noteFilesReplacing, filesReplacingCount). A snapshot by
 * hand and an access check read it before and after they look at the agent,
 * and keep nothing when it moved (HB-0566, HB-0967). These pin today's
 * moments, which HB-1465 step 5 must keep: a change counts as its row
 * begins, once, inside its take and after the take's own checks (so a take
 * those checks refuse counts nothing), and after any wait before the row (a
 * move asks both machines first, an adopt packs the folder first); a setup
 * or a rebuild counts before its take, so one another holder refuses counts
 * all the same; a resume counts under its take once the operation is as it
 * was read, a recover in the tick of its take, and a rebuild's or setup's
 * steps run again where they run (under the owner's choice, its reuse).
 * Ids and names are made up.
 */

const count = (id: string) => filesReplacingCount(id);
const crashAt = (key: string) => setStepHookForTests((_op, k) => { if (k === key) throw new SimulatedCrash(); });
const ticks = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const held = new Set<string>();
afterEach(() => {
  setStepHookForTests(undefined);
  vi.restoreAllMocks();
  for (const id of held) clearBusy(id);
  held.clear();
});
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** One running agent on the world's machine, its reservation forgotten after the test. */
async function agentIn(w: Awaited<ReturnType<typeof makeWorld>>, id: string): Promise<string> {
  held.add(id);
  return seedRunningAgent(w, { id, slug: id, accountId: `${id.replace(/-/g, '')}bot` });
}

describe('each change that replaces files counts once, as its row begins', () => {
  it('an archive: in the tick it is taken, once its checks pass; one its checks refuse, or of an agent archived already, is taken and counts nothing', async () => {
    const w = await makeWorld();
    const id = await agentIn(w, 'fr-archive');
    const deps = { store: w.store, secrets: w.secrets, provider: w.provider, channel: w.channel, log: () => {} };
    const c0 = count(id);
    const archiving = archiveAgent(deps, id);
    expect(isBusy(id)).toBe(true);
    expect(count(id)).toBe(c0 + 1);
    await archiving;
    expect(w.store.getAgent(id)!.state).toBe('ARCHIVED');
    // A double tap: taken, and nothing to do.
    const again = archiveAgent(deps, id);
    expect(isBusy(id)).toBe(true);
    await expect(again).resolves.toEqual({});
    expect(count(id)).toBe(c0 + 1);

    const other = await agentIn(w, 'fr-archive-2');
    w.store.setAgentState(other, 'REBUILDING');
    const o0 = count(other);
    const refused = archiveAgent(deps, other);
    expect(isBusy(other)).toBe(true);
    await expect(refused).rejects.toThrow('It is rebuilding — wait for it to settle, then archive it.');
    expect(count(other)).toBe(o0);
  });

  it('a move to another machine: taken first, counted only once both machines answered and its row begins; refused after they answered, it counts nothing', async () => {
    const m = await moveWorld();
    const c0 = count(m.id);
    let answer!: () => void;
    const asked = new Promise<void>((r) => { answer = r; });
    const daemonId = m.target.daemonId.bind(m.target);
    m.target.daemonId = async () => { await asked; return daemonId(); };
    crashAt('checked');
    const moving = moveAgentToHost(m.deps, m.id, 'h2');
    expect(isBusy(m.id)).toBe(true);
    await ticks();
    // Held while its machines are asked: not counted yet.
    expect(isBusy(m.id)).toBe(true);
    expect(count(m.id)).toBe(c0);
    answer();
    await expect(moving).rejects.toBeInstanceOf(SimulatedCrash);
    expect(count(m.id)).toBe(c0 + 1);

    // One Docker daemon reached two ways: refused after the probes, in its take.
    const n = await moveWorld();
    n.w.provider.daemonId = async () => 'one-made-up-daemon';
    n.target.daemonId = async () => 'one-made-up-daemon';
    const n0 = count(n.id);
    const same = moveAgentToHost(n.deps, n.id, 'h2');
    expect(isBusy(n.id)).toBe(true);
    await expect(same).rejects.toThrow(/are the same Docker daemon/);
    expect(count(n.id)).toBe(n0);
  });

  it('a move to another Hatchabot: in the tick it is taken, once its checks pass; one its checks refuse counts nothing', async () => {
    const m = await migrateWorld();
    const c0 = count('fr-migrate');
    crashAt('preflight-ok');
    const moving = migrateAgent(m.deps as never, 'fr-migrate', PEER);
    expect(isBusy('fr-migrate')).toBe(true);
    expect(count('fr-migrate')).toBe(c0 + 1);
    await expect(moving).rejects.toBeInstanceOf(SimulatedCrash);
    setStepHookForTests(undefined);

    const n = await migrateWorld('fr-migrate-2');
    n.store.setAgentState('fr-migrate-2', 'REBUILDING');
    const n0 = count('fr-migrate-2');
    const refused = migrateAgent(n.deps as never, 'fr-migrate-2', PEER);
    expect(isBusy('fr-migrate-2')).toBe(true);
    await expect(refused).rejects.toThrow("Can't move an agent while it is REBUILDING.");
    expect(count('fr-migrate-2')).toBe(n0);
  });

  it('a workspace adopt: taken first, counted only once the folder is packed and its row begins; one its checks refuse counts nothing', async () => {
    const w = await makeWorld();
    const id = await agentIn(w, 'fr-adopt');
    const dir = tmp('hb-fr-adopt-');
    writeFileSync(join(dir, 'SOUL.md'), 'A made-up soul.\n');
    const deps = { store: w.store, provider: w.provider, log: () => {} };
    const c0 = count(id);
    crashAt('packed');
    const adopting = applyWorkspace(deps as never, id, dir);
    // Taken, and packing the folder: not counted yet.
    expect(isBusy(id)).toBe(true);
    expect(count(id)).toBe(c0);
    await expect(adopting).rejects.toBeInstanceOf(SimulatedCrash);
    expect(count(id)).toBe(c0 + 1);

    const other = await agentIn(w, 'fr-adopt-2');
    w.store.setAgentState(other, 'FAILED', 'made-up failure');
    const o0 = count(other);
    const refused = applyWorkspace(deps as never, other, dir);
    expect(isBusy(other)).toBe(true);
    await expect(refused).rejects.toThrow("Can't adopt into this agent while it is FAILED.");
    expect(count(other)).toBe(o0);
  });

  it('an import: counted once as its row begins, in the tick it takes the agent its record made', async () => {
    const { data, dst } = await importWorlds();
    let seen: { agentId: string | null; count: number; busy: boolean } | undefined;
    setStepHookForTests((op, k) => {
      if (k !== 'row-made') return;
      seen = { agentId: op.agentId, count: count(op.agentId!), busy: isBusy(op.agentId!) };
      held.add(op.agentId!);
      throw new SimulatedCrash();
    });
    await expect(importAgent(dst.deps, data, { ownerId: 'importer' })).rejects.toBeInstanceOf(SimulatedCrash);
    expect(seen).toMatchObject({ count: 1, busy: true });
    expect(count(seen!.agentId!)).toBe(1);
  });
});

describe('a restore counts as its row begins, inside its take; one its own checks refuse counts nothing', () => {
  const env = { ...process.env };
  let base = '';
  beforeEach(() => {
    base = tmp('hb-fr-bk-');
    process.env.HATCHABOT_BACKUP_DIR = base;
    process.env.HATCHABOT_PREFIX = 'hatchabot';
    delete process.env.HATCHABOT_BACKUP_SCRIPT;
    delete process.env.HATCHABOT_DRILL_SCRIPT;
  });
  const running: Backups[] = [];
  afterEach(() => {
    for (const b of running.splice(0)) b.stop();
    process.env = { ...env };
  });

  /** The backups service over a store, with a machine that answers each core-file read, stops and says it is stopped. */
  function backupsWorld() {
    const db = new Database(':memory:');
    const store = new Store(db);
    const secrets = new LocalSecretStore(db, Buffer.alloc(32, 7));
    store.insertHost({ id: 'h1', ownerId: 'user-owner', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertHost({ id: 'h2', ownerId: 'user-owner', kind: 'remote', provider: 'mock', name: 'Laptop runner', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'p1', ownerId: 'user-owner', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    const provider = {
      execShell: async () => ({ code: 0, stdout: 'notes\n', stderr: '' }),
      stop: async () => {},
      start: async () => {},
      status: async () => ({ phase: 'stopped' as const }),
      reachable: async () => false,
    };
    const backups = createBackups({
      store, secrets,
      providerFor: () => provider as never,
      trace: () => () => {},
      agentGone: (id) => !store.getAgent(id),
      withCoreFilesTurn: <T>(_agentId: string, fn: () => Promise<T>) => fn(),
      channel: {} as never,
      embedder: () => undefined,
      afterStart: () => {},
      inFlight: () => false,
      isArchiving: () => false,
      warn: () => {},
      drillSweepEveryMs: 0,
    });
    running.push(backups);
    const agent = (id: string, state: Agent['state'] = 'RUNNING'): Agent => {
      held.add(id);
      store.insertAgent({
        id, ownerId: 'user-owner', name: `Agent ${id}`, slug: id, state, aiProfileId: 'p1', hostId: 'h1',
        persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now', runtimeRef: `docker://hatchabot-${id}`,
      } as unknown as Agent);
      return store.getAgent(id)!;
    };
    return { store, backups, agent };
  }

  it('from a snapshot: a snapshot by hand counts nothing; the restore counts once its checks pass; stopped, moved meanwhile or its snapshot gone, it counts nothing', async () => {
    const w = backupsWorld();
    const a = w.agent('fr-snap');
    const c0 = count(a.id);
    const snap = await w.backups.snapshots.take(a, 'kept');
    expect(count(a.id)).toBe(c0);
    crashAt('safety-taken');
    await expect(w.backups.snapshots.restore(a, snap.id, 'user-owner')()).rejects.toBeInstanceOf(SimulatedCrash);
    expect(count(a.id)).toBe(c0 + 1);
    setStepHookForTests(undefined);

    const gone = w.agent('fr-snap-gone');
    const g0 = count(gone.id);
    await expect(w.backups.snapshots.restore(gone, 'no-such-snapshot', 'user-owner')()).rejects.toThrow('That snapshot no longer exists.');
    expect(count(gone.id)).toBe(g0);

    const stopped = w.agent('fr-snap-stopped', 'STOPPED');
    const s0 = count(stopped.id);
    await expect(w.backups.snapshots.restore(stopped, 'no-such-snapshot', 'user-owner')()).rejects.toThrow('Start the agent to restore its files.');
    expect(count(stopped.id)).toBe(s0);

    const moved = w.agent('fr-snap-moved');
    const kept = await w.backups.snapshots.take(moved, 'kept');
    w.store.setAgentHost(moved.id, 'h2');
    const m0 = count(moved.id);
    await expect(w.backups.snapshots.restore(moved, kept.id, 'user-owner')()).rejects.toThrow('It moved while this waited; restore again.');
    expect(count(moved.id)).toBe(m0);
  });

  it('from a backup: counted once its checks pass; a date that is not one, or a set without the agent, counts nothing', async () => {
    const w = backupsWorld();
    const a = w.agent('fr-backup');
    const date = '2026-11-21';
    mkdirSync(join(base, date), { recursive: true });
    writeFileSync(join(base, date, 'hatchabot.sqlite'), 'db');
    writeFileSync(join(base, date, agentArchiveName(a.runtimeRef!)), 'archive');
    writeFileSync(join(base, date, 'backup-status.json'), JSON.stringify({
      startedAt: `${date}T03:30:00`, finishedAt: `${date}T03:40:00`, state: 'complete', captured: [agentArchiveName(a.runtimeRef!).replace(/\.tgz$/, '')],
      failedVolumes: [], missing: [], orphans: [], skipped: [],
    }));
    const c0 = count(a.id);
    await expect(w.backups.sets.restore({ agent: a, date: 'last tuesday', otherKey: false, requestedBy: 'user-owner' })()).rejects.toThrow('Not a backup date.');
    await expect(w.backups.sets.restore({ agent: a, date: '2026-11-20', otherKey: false, requestedBy: 'user-owner' })()).rejects.toThrow(/doesn't contain this agent/);
    expect(count(a.id)).toBe(c0);
    crashAt('stopped');
    const restoring = w.backups.sets.restore({ agent: a, date, otherKey: false, requestedBy: 'user-owner' })();
    expect(isBusy(a.id)).toBe(true);
    expect(count(a.id)).toBe(c0 + 1);
    await expect(restoring).rejects.toBeInstanceOf(SimulatedCrash);
    expect(count(a.id)).toBe(c0 + 1);
  });
});

describe('a setup or a rebuild counts before its take, so one another holder refuses counts all the same', () => {
  it('a setup cut off by a restart, its container up: counted where its steps would run again, though another holder has the agent', async () => {
    const w = await makeWorld();
    const id = 'fr-setup';
    held.add(id);
    w.store.insertAgent({ id, ownerId: w.owner, name: 'Setup Agent', slug: id, state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    const { runtimeRef } = await w.provider.provision({ agentId: id, slug: id, workspace: { files: {}, configPatch: { agentId: id, authMode: 'api-key' } }, env: {} });
    w.store.setAgentRuntimeRef(id, runtimeRef);
    await w.provider.start(runtimeRef);
    const op = beginOperation(w.store, 'provision', id, {});
    w.store.updateOperation(op.id, { bootId: 'an-earlier-boot' });
    const release = markBusy(id); // another holder: a stand-in
    const c0 = count(id);
    await resumeOperations(resumeCtx(w));
    expect(count(id)).toBe(c0 + 1);
    // Its take was refused: left for the next pass.
    expect(w.store.getOperation(op.id)!.status).toBe('interrupted');
    release();
  });

  it('a rebuild queued before a restart: counted at its turn as it starts, though another holder refuses its take', async () => {
    const w = await makeWorld();
    const id = await agentIn(w, 'fr-requeued');
    const op = beginOperation(w.store, 'rebuild', id, { checkpoint: false, was: {} }, { queued: true });
    w.store.updateOperation(op.id, { bootId: 'an-earlier-boot' });
    const release = markBusy(id); // another holder: a stand-in
    const c0 = count(id);
    // The boot's pass as the routes run it; what else it waits for is not this test's.
    const passing = w.routes!.resumeOperations().catch(() => undefined);
    await vi.waitFor(() => expect(w.store.getOperation(op.id)!.status).toBe('failed'), { timeout: 10_000 });
    expect(w.store.getOperation(op.id)!.outcome).toBe('Another operation is already running on this agent.');
    expect(count(id)).toBe(c0 + 1);
    release();
    await passing;
  });
});

describe('settled again: a resume, a recover, a reuse', () => {
  it('a resume after a restart counts in the tick of its take; one the owner settled after it was read is taken and counts nothing', async () => {
    const w = await makeWorld();
    const id = await agentIn(w, 'fr-resume');
    const op = beginOperation(w.store, 'restore-snapshot', id, { snapshotId: 'made-up-snapshot' });
    w.store.updateOperation(op.id, { bootId: 'an-earlier-boot' });
    const c0 = count(id);
    const settling = resumeOperations(resumeCtx(w));
    expect(isBusy(id)).toBe(true);
    expect(count(id)).toBe(c0 + 1);
    await settling;

    // Read as interrupted, then settled by its owner before its rule ran.
    const other = await agentIn(w, 'fr-resume-2');
    const op2 = beginOperation(w.store, 'restore-snapshot', other, { snapshotId: 'made-up-snapshot' });
    w.store.updateOperation(op2.id, { bootId: 'an-earlier-boot' });
    const store = new Proxy(w.store, {
      get(t, k) {
        if (k === 'operationsWithStatus') {
          return (s: Parameters<Store['operationsWithStatus']>[0]) => {
            const rows = t.operationsWithStatus(s);
            if (s.includes('interrupted')) t.updateOperation(op2.id, { status: 'failed', outcome: 'Settled by its owner.', finishedAt: new Date().toISOString() });
            return rows;
          };
        }
        const v = Reflect.get(t, k) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const o0 = count(other);
    const passing = resumeOperations({ ...resumeCtx(w), store });
    expect(isBusy(other)).toBe(true);
    await passing;
    expect(count(other)).toBe(o0);
    expect(w.store.getOperation(op2.id)!.outcome).toBe('Settled by its owner.');
  });

  it("the owner's choice on a held operation counts in the tick of its take; a choice it does not offer is refused before any take and counts nothing", async () => {
    const w = await makeWorld();
    const id = await agentIn(w, 'fr-recover');
    const op = beginOperation(w.store, 'restore-snapshot', id, { snapshotId: 'made-up-snapshot' });
    op.hold('Held for its owner (made up).', { actions: [{ action: 'retry', label: 'Try again' }], recommended: 'retry' });
    const c0 = count(id);
    await expect(recoverOperation(resumeCtx(w), op.id, 'not-offered')).rejects.toThrow('"not-offered" is not one of this operation\'s choices.');
    expect(count(id)).toBe(c0);
    const choosing = recoverOperation(resumeCtx(w), op.id, 'retry');
    expect(isBusy(id)).toBe(true);
    expect(count(id)).toBe(c0 + 1);
    await choosing.catch(() => undefined);
    expect(count(id)).toBe(c0 + 1);
  });

  it("Try again on a held rebuild: counted when its steps run again under the choice's own take, once the machine answered; not when its container is not up", async () => {
    const w = await makeWorld();
    const id = await agentIn(w, 'fr-reuse');
    w.store.setAgentState(id, 'REBUILDING');
    const op = beginOperation(w.store, 'rebuild', id, {});
    op.hold('Held for its owner (made up).', { actions: [{ action: 'retry', label: 'Try again' }], recommended: 'retry' });
    const c0 = count(id);
    const choosing = recoverOperation(resumeCtx(w), op.id, 'retry');
    expect(isBusy(id)).toBe(true);
    // Its machine is asked first: not counted in the tick of the take.
    expect(count(id)).toBe(c0);
    await choosing.catch(() => undefined);
    expect(count(id)).toBe(c0 + 1);

    const other = await agentIn(w, 'fr-reuse-2');
    w.store.setAgentState(other, 'REBUILDING');
    await w.provider.stop(w.store.getAgent(other)!.runtimeRef!);
    const op2 = beginOperation(w.store, 'rebuild', other, {});
    op2.hold('Held for its owner (made up).', { actions: [{ action: 'retry', label: 'Try again' }], recommended: 'retry' });
    const o0 = count(other);
    await recoverOperation(resumeCtx(w), op2.id, 'retry').catch(() => undefined);
    expect(count(other)).toBe(o0);
  });
});

describe('the setup and rebuild queue: counted as each starts, before its take', () => {
  it('a setup: counted in the tick it is asked for, as its row begins and before its take; one another holder refuses counts all the same', async () => {
    const w = await makeWorld();
    const id = await agentIn(w, 'fr-setup-new');
    // Set up already: its take finds nothing to do.
    w.store.setAgentState(id, 'STOPPED');
    const q = queueOf(w);
    const c0 = count(id);
    q.kickProvision(id);
    expect(count(id)).toBe(c0 + 1);
    await vi.waitFor(() => expect(q.isInFlight(id)).toBe(false));
    expect(count(id)).toBe(c0 + 1);
    expect(w.store.listOperations([id])[0]).toMatchObject({ kind: 'provision', status: 'succeeded' });

    const release = markBusy(id); // another holder: a stand-in
    q.kickProvision(id);
    expect(count(id)).toBe(c0 + 2);
    await vi.waitFor(() => expect(q.isInFlight(id)).toBe(false));
    expect(count(id)).toBe(c0 + 2);
    expect(w.store.listOperations([id]).find((o) => o.status === 'failed')?.outcome).toBe('Another operation is already running on this agent.');
    release();
  });

  it('a rebuild: not counted while it waits its turn; counted at its turn as it starts, though another holder refuses its take; one its turn finds stopped counts nothing', async () => {
    const w = await makeWorld();
    const id = await agentIn(w, 'fr-rebuild-new');
    const q = queueOf(w);
    const release = markBusy(id); // another holder: a stand-in
    const c0 = count(id);
    expect(q.kickRebuild(id)).toBe(true);
    expect(w.store.listOperations([id])[0]).toMatchObject({ kind: 'rebuild', status: 'queued' });
    expect(count(id)).toBe(c0);
    await vi.waitFor(() => expect(q.isInFlight(id)).toBe(false));
    expect(count(id)).toBe(c0 + 1);
    expect(w.store.listOperations([id])[0]).toMatchObject({ status: 'failed', outcome: 'Another operation is already running on this agent.' });
    release();

    // Stopped by its owner while it waited: skipped at its turn.
    expect(q.kickRebuild(id)).toBe(true);
    w.store.setAgentState(id, 'STOPPED');
    await vi.waitFor(() => expect(q.isInFlight(id)).toBe(false));
    expect(count(id)).toBe(c0 + 1);
    expect(w.store.listOperations([id]).find((o) => o.status === 'rolled_back')?.outcome).toBe('Not rebuilt: stopped by its owner.');
  });
});

describe('settled again, the rest: a rebuild resumed, a reuse under a setup, and kinds that replace nothing', () => {
  it('a rebuild cut off with its new container up: counted where its steps run again, once the machine answered, though another holder refuses its take; one whose container is not up counts nothing', async () => {
    const w = await makeWorld();
    const id = await agentIn(w, 'fr-rebuild-up');
    w.store.setAgentState(id, 'REBUILDING');
    const op = beginOperation(w.store, 'rebuild', id, {});
    w.store.updateOperation(op.id, { bootId: 'an-earlier-boot' });
    const release = markBusy(id); // another holder: a stand-in
    const c0 = count(id);
    const passing = resumeOperations(resumeCtx(w));
    // Its machine is asked first: not counted in the tick of the pass.
    expect(count(id)).toBe(c0);
    await passing;
    expect(count(id)).toBe(c0 + 1);
    // Its take was refused: left for the next pass.
    expect(w.store.getOperation(op.id)!.status).toBe('interrupted');
    release();

    const other = await agentIn(w, 'fr-rebuild-down');
    w.store.setAgentState(other, 'REBUILDING');
    await w.provider.stop(w.store.getAgent(other)!.runtimeRef!);
    const op2 = beginOperation(w.store, 'rebuild', other, {});
    w.store.updateOperation(op2.id, { bootId: 'an-earlier-boot' });
    const o0 = count(other);
    await resumeOperations(resumeCtx(w));
    expect(count(other)).toBe(o0);
    expect(w.store.getOperation(op2.id)!.status).not.toBe('interrupted');
  });

  it("Try again on a held setup, its container up: counted when its steps run again under the choice's own take, once the machine answered", async () => {
    const w = await makeWorld();
    const id = 'fr-reuse-setup';
    held.add(id);
    w.store.insertAgent({ id, ownerId: w.owner, name: 'Setup Agent', slug: id, state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    const { runtimeRef } = await w.provider.provision({ agentId: id, slug: id, workspace: { files: {}, configPatch: { agentId: id, authMode: 'api-key' } }, env: {} });
    w.store.setAgentRuntimeRef(id, runtimeRef);
    await w.provider.start(runtimeRef);
    const op = beginOperation(w.store, 'provision', id, {});
    op.hold('Held for its owner (made up).', { actions: [{ action: 'retry', label: 'Try again' }], recommended: 'retry' });
    const c0 = count(id);
    const choosing = recoverOperation(resumeCtx(w), op.id, 'retry');
    expect(isBusy(id)).toBe(true);
    expect(count(id)).toBe(c0);
    await choosing.catch(() => undefined);
    expect(count(id)).toBe(c0 + 1);
    expect(isBusy(id)).toBe(false);
  });

  it('an app install, which replaces no files: its resume and its choices count nothing', async () => {
    const w = await makeWorld();
    const id = await agentIn(w, 'fr-app-install');
    const op = beginOperation(w.store, 'app-install', id, { app: 'demo' });
    w.store.updateOperation(op.id, { bootId: 'an-earlier-boot' });
    const c0 = count(id);
    expect(c0).toBe(0);
    // Resumed: its agent's apps cannot be reached here, so it is held for its owner.
    await resumeOperations(resumeCtx(w));
    expect(w.store.getOperation(op.id)!.status).toBe('held');
    await recoverOperation(resumeCtx(w), op.id, 'retry').catch(() => undefined);
    expect(count(id)).toBe(c0);
  });
});

// ---- the worlds -------------------------------------------------------------

/** The setup and rebuild queue over the world, as the agent lifecycle service builds it. */
function queueOf(w: Awaited<ReturnType<typeof makeWorld>>) {
  const q = createRebuildQueue({
    store: w.store, secrets: w.secrets, providerFor: () => w.provider, trace: () => () => {}, channel: w.channel,
    embedder: () => undefined, runPendingApp: async () => {}, priorChatIdsOf: () => [], deleting: () => false,
    browsersNow: async () => undefined, logError: () => {},
  });
  queues.push(q);
  return q;
}
const queues: Array<ReturnType<typeof createRebuildQueue>> = [];
afterEach(() => { for (const q of queues.splice(0)) q.stop(); });

function resumeCtx(w: Awaited<ReturnType<typeof makeWorld>>): ResumeContext {
  return { store: w.store, secrets: w.secrets, channel: w.channel, sleep: async () => {}, providerForHost: (h) => (h === 'h1' ? w.provider : undefined) };
}

/** An agent on this machine and a second machine to move it to (as test/operations.test.ts's moveWorld). */
async function moveWorld() {
  const w = await makeWorld();
  w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock2', name: 'Test Runner', settings: {}, createdAt: 'now' });
  const target = new MockProvider();
  w.providers.set('mock2', target);
  const id = await agentIn(w, 'fr-move');
  const deps = { store: w.store, secrets: w.secrets, channel: w.channel, source: w.provider, target, sleep: async () => {}, sourceHostId: 'h1' };
  return { w, target, id, deps };
}

const PEER = { id: 'peer1', name: 'Test Peer', url: 'http://peer.example.org:8080', secretRef: 'peer/tok' };

/** An agent and another Hatchabot that answers its preflight (as test/operations.test.ts's migrateWorld). */
async function migrateWorld(id = 'fr-migrate') {
  held.add(id);
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({ id, ownerId: 'o', name: 'Test Agent', slug: id, state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  store.insertMembership({ id: `m-${id}`, agentId: id, userId: 'o', role: 'owner', status: 'active' });
  await secrets.put('ai/p1', 'not-a-key');
  await secrets.put(`chan/${id}`, 'not-a-token');
  await secrets.put('peer/tok', 'not-a-peer-token');
  store.insertPeer({ ...PEER, ownerId: 'o', createdAt: 'now' });
  store.insertChannel({ id: `c-${id}`, agentId: id, kind: 'telegram', accountId: 'testagentbot', secretRef: `chan/${id}`, deepLink: 'https://t.me/testagentbot', createdAt: 'now' });
  const { runtimeRef } = await provider.provision({ agentId: id, slug: id, workspace: { files: {}, configPatch: { agentId: id, authMode: 'api-key' } }, env: {} });
  store.setAgentRuntimeRef(id, runtimeRef);
  await provider.start(runtimeRef);
  store.setAgentState(id, 'RUNNING');
  const deps = { store, secrets, provider, channel: { kind: 'telegram' } as never, sleep: async () => {}, peerFetch: viaGlobalFetch };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('/v1/agents/preflight')) return new Response(JSON.stringify({ ok: true, reasons: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error(`unexpected fetch ${u}`);
  });
  return { store, deps };
}

/** An agent exported from one install, and another to import it into (as test/operations.test.ts's importWorlds). */
async function importWorlds() {
  const mk = async (owner: string) => {
    const store = new Store(new Database(':memory:'));
    const secrets = new MemSecrets();
    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: owner, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: owner, name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    await secrets.put('ai/p1', 'not-a-key');
    return { store, secrets, provider, deps: { store, secrets, provider, channel: { kind: 'telegram' } as never, sleep: async () => {} } };
  };
  const src = await mk('o');
  src.store.insertAgent({ id: 'fr-export', ownerId: 'o', name: 'Test Agent', slug: 'test-agent', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: 'helps', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  src.store.insertMembership({ id: 'm1', agentId: 'fr-export', userId: 'o', role: 'owner', status: 'active' });
  await src.secrets.put('chan/fr-export', 'not-a-token');
  src.store.insertChannel({ id: 'c1', agentId: 'fr-export', kind: 'telegram', accountId: 'testagentbot', secretRef: 'chan/fr-export', deepLink: 'https://t.me/testagentbot', createdAt: 'now' });
  const { runtimeRef } = await src.provider.provision({ agentId: 'fr-export', slug: 'test-agent', workspace: { files: {}, configPatch: { agentId: 'test-agent', authMode: 'api-key' } }, env: {} });
  src.store.setAgentRuntimeRef('fr-export', runtimeRef);
  await src.provider.start(runtimeRef);
  src.store.setAgentState('fr-export', 'RUNNING');
  src.provider.stateStore.set(runtimeRef, Buffer.from('remembered'));
  held.add('fr-export');
  const { data } = await exportAgent(src.deps, 'fr-export');
  const dst = await mk('importer');
  return { data, dst };
}
