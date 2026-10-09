/**
 * Durable operations (src/orchestrator/operations.ts, operationsResume.ts):
 * a long change records its steps on disk, and a restart in the middle is
 * finished, undone or held on purpose.
 *
 * The kill-at-every-step tests run each operation against mock daemons, stop
 * it at step n the way a dead process would (no rollback runs, the in-memory
 * busy flag is gone), start a "new process" (a new boot id), run
 * resumeOperations(), and check what must always hold:
 *  - never two running copies of an agent;
 *  - never a half-imported agent started;
 *  - the agent either running where its record says, undone, finished, or
 *    held with Start refused.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MockProvider } from '../src/providers/mockProvider.js';
import type { RuntimeProvider } from '../src/providers/provider.js';
import { moveAgentToHost } from '../src/orchestrator/moveHost.js';
import { migrateAgent } from '../src/orchestrator/migrate.js';
import { exportAgent, importAgent } from '../src/orchestrator/transfer.js';
import { reconcileAgents, reconcileEventLog } from '../src/orchestrator/reconcile.js';
import { clearBusy } from '../src/orchestrator/busy.js';
import { eventLabel } from '../src/orchestrator/eventLabels.js';
import {
  beginOperation, markInterrupted, newBootForTests, operationRefusal, setStepHookForTests, SimulatedCrash, STEPS,
} from '../src/orchestrator/operations.js';
import { recoverOperation, resumeOperations, retryHeldOperations, type ResumeContext } from '../src/orchestrator/operationsResume.js';
import { Store } from '../src/store/store.js';
import { MemSecrets, makeWorld, seedRunningAgent } from './support/world.js';

afterEach(() => {
  setStepHookForTests(undefined);
  vi.restoreAllMocks();
});

/** Die at this step: the work before it is done, the step itself is not recorded. */
const crashAt = (key: string) => setStepHookForTests((_op, k) => { if (k === key) throw new SimulatedCrash(); });
/** The process is gone: no hook, no busy flag, a new boot id. */
const reboot = (agentId: string) => { setStepHookForTests(undefined); clearBusy(agentId); newBootForTests(); };
const keysOf = (kind: 'move-host' | 'migrate' | 'import', last: string) => [...STEPS[kind]!.map((s) => s.key), last];

describe('the operation record', () => {
  it('records each step on disk and as a timeline line carrying the operation id', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { name: 'Test Agent' });
    const op = beginOperation(w.store, 'move-host', id, { to: 'h2', wasRunning: true }, { hostId: 'h2', requestedBy: w.owner });
    op.step('checked');
    op.step('stopped', { note: 'x' });
    const row = w.store.getOperation(op.id)!;
    expect(row).toMatchObject({ kind: 'move-host', status: 'running', step: 'stopped', hostId: 'h2', requestedBy: w.owner });
    expect(row.params).toMatchObject({ to: 'h2', wasRunning: true, note: 'x' });
    const steps = w.store.listEvents([id], 50).filter((e) => e.event === 'op.step');
    expect(steps.map((e) => e.detail?.op)).toEqual([op.id, op.id]);
    expect(eventLabel('op.step', steps[0]!.detail)).toBe('stopped here (step 2 of 10)');
    // Busy on disk while it is not over, with its own words.
    expect(operationRefusal(w.store, id)).toMatch(/Move to another machine is under way \(step 2 of 10: stopped here\)/);
    op.done('Moved to Test Runner.');
    expect(w.store.getOperation(op.id)).toMatchObject({ status: 'succeeded', outcome: 'Moved to Test Runner.' });
    expect(operationRefusal(w.store, id)).toBeUndefined();
  });

  it('a running row from another process is interrupted at boot, and still refuses Start', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    const op = beginOperation(w.store, 'import', id, {});
    newBootForTests();
    expect(markInterrupted(w.store).map((o) => o.id)).toEqual([op.id]);
    expect(w.store.getOperation(op.id)!.status).toBe('interrupted');
    expect(operationRefusal(w.store, id)).toMatch(/interrupted by a restart/);
  });

  it('keeps 90 days, and at least the last 50 per agent; never one that is not over', async () => {
    const store = new Store(new Database(':memory:'));
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const row = (i: number, at: string, status: 'succeeded' | 'held' = 'succeeded') => ({
      id: `op_${i}`, agentId: 'a1', kind: 'import', requestedAt: at, params: {}, status, bootId: 'b', updatedAt: at,
    });
    store.insertOperation(row(0, old, 'held'));
    for (let i = 1; i <= 60; i++) store.insertOperation(row(i, new Date(Date.now() - (100 + i) * 86_400_000).toISOString()));
    store.insertOperation(row(99, new Date().toISOString()));
    const left = store.listOperations(['a1'], 500).map((o) => o.id);
    // Older than 90 days and not among the newest 50: gone. The held one stays whatever its age.
    expect(left).toHaveLength(50);
    expect(left).toContain('op_0');
    expect(left).toContain('op_99');
    expect(left).toContain('op_48');
    expect(left).not.toContain('op_49');
    // Within 90 days nothing goes, however many.
    for (let i = 100; i < 160; i++) store.insertOperation(row(i, new Date(Date.now() - i * 60_000).toISOString()));
    expect(store.listOperations(['a1'], 500).filter((o) => Number(o.id.slice(3)) >= 100)).toHaveLength(60);
  });
});

// ---- move-host -----------------------------------------------------------

async function moveWorld(running = true) {
  const w = await makeWorld();
  w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock2', name: 'Test Runner', settings: {}, createdAt: 'now' });
  const target = new MockProvider();
  w.providers.set('mock2', target);
  const id = await seedRunningAgent(w, { name: 'Test Agent', slug: 'test-agent', accountId: 'testagentbot', memory: 'remembered' });
  const ref = w.store.getAgent(id)!.runtimeRef!;
  if (!running) {
    await w.provider.stop(ref);
    w.store.setAgentState(id, 'STOPPED');
  }
  const up = { h1: true, h2: true };
  const byHost: Record<string, MockProvider> = { h1: w.provider, h2: target };
  const ctx: ResumeContext = {
    store: w.store, secrets: w.secrets, channel: w.channel, sleep: async () => {},
    providerForHost: (h) => byHost[h],
    answers: async (p: RuntimeProvider) => (p === target ? up.h2 : up.h1),
  };
  const deps = { store: w.store, secrets: w.secrets, channel: w.channel, source: w.provider, target, sleep: async () => {}, sourceHostId: 'h1' };
  const running2 = async () => [
    (await w.provider.status(ref)).phase === 'running',
    (await target.status(ref)).phase === 'running',
  ];
  return { w, target, id, ref, up, ctx, deps, running2 };
}

describe('move-host: killed at every step, then a restart', () => {
  const FLIP = STEPS['move-host']!.findIndex((s) => s.key === 'host-flipped');
  for (const key of keysOf('move-host', '#succeeded')) {
    const i = STEPS['move-host']!.findIndex((s) => s.key === key);
    const flipped = key === '#succeeded' || i >= FLIP;

    it(`at "${key}": ${flipped ? 'finished on the target' : 'undone onto the source'}, running in one place only`, async () => {
      const m = await moveWorld();
      crashAt(key);
      await expect(moveAgentToHost(m.deps, m.id, 'h2')).rejects.toBeInstanceOf(SimulatedCrash);
      reboot(m.id);
      await resumeOperations(m.ctx);

      const [onSource, onTarget] = await m.running2();
      expect(onSource && onTarget).toBe(false);
      const agent = m.w.store.getAgent(m.id)!;
      expect(agent.state).toBe('RUNNING');
      expect(agent.hostId).toBe(flipped ? 'h2' : 'h1');
      expect(flipped ? onTarget : onSource).toBe(true);
      const op = m.w.store.listOperations([m.id])[0]!;
      expect(op.status).toBe(flipped ? 'succeeded' : key === 'checked' ? 'failed' : 'rolled_back');
      expect(operationRefusal(m.w.store, m.id)).toBeUndefined();
      if (flipped) {
        // The memory crossed, the source's stale copy is gone.
        expect(m.target.stateStore.get(m.ref)?.toString()).toBe('remembered');
        expect((await m.w.provider.status(m.ref)).phase).toBe('absent');
      } else {
        expect(m.w.provider.stateStore.get(m.ref)?.toString()).toBe('remembered');
        expect((await m.target.status(m.ref)).phase).toBe('absent');
      }
    });

    it(`at "${key}", with the machine it needs not answering: ${flipped ? 'held, Start refused, then finished or put back' : 'still undone'}`, async () => {
      const m = await moveWorld();
      crashAt(key);
      await expect(moveAgentToHost(m.deps, m.id, 'h2')).rejects.toBeInstanceOf(SimulatedCrash);
      reboot(m.id);
      m.up.h2 = false;
      await resumeOperations(m.ctx);
      const [onSource, onTarget] = await m.running2();
      expect(onSource && onTarget).toBe(false);
      const op = m.w.store.listOperations([m.id])[0]!;
      if (!flipped) {
        expect(m.w.store.getAgent(m.id)).toMatchObject({ hostId: 'h1', state: 'RUNNING' });
        expect(['rolled_back', 'failed']).toContain(op.status);
        return;
      }
      if (key === '#succeeded' || key === 'source-removed') {
        // Everything on the target was done: only the old copy and the record
        // were left, and those need only the machine it left.
        expect(op.status).toBe('succeeded');
        expect(m.w.store.getAgent(m.id)).toMatchObject({ hostId: 'h2', state: 'RUNNING' });
        return;
      }
      expect(op.status).toBe('held');
      expect(op.recovery!.actions.map((a) => a.action)).toEqual(['retry', 'put-back']);
      expect(operationRefusal(m.w.store, m.id)).toMatch(/isn't answering/);
      // Put back while it is away: only if its copy there never started.
      const mayRun = STEPS['move-host']!.findIndex((s) => s.key === op.step) >= STEPS['move-host']!.findIndex((s) => s.key === 'target-configured');
      if (mayRun) {
        await expect(recoverOperation(m.ctx, op.id, 'put-back')).rejects.toThrow(/may already be running/);
        // It comes back: finish.
        m.up.h2 = true;
        const after = await recoverOperation(m.ctx, op.id, 'retry');
        expect(after.status).toBe('succeeded');
        expect(m.w.store.getAgent(m.id)).toMatchObject({ hostId: 'h2', state: 'RUNNING' });
      } else {
        const after = await recoverOperation(m.ctx, op.id, 'put-back');
        expect(after.status).toBe('rolled_back');
        expect(m.w.store.getAgent(m.id)).toMatchObject({ hostId: 'h1', state: 'RUNNING' });
      }
      const [s2, t2] = await m.running2();
      expect(s2 && t2).toBe(false);
      expect(s2 || t2).toBe(true);
    });
  }

  it('a STOPPED agent stays stopped wherever the restart leaves it', async () => {
    for (const key of keysOf('move-host', '#succeeded')) {
      const m = await moveWorld(false);
      crashAt(key);
      // A stopped agent is not started there, so it has no "target-started" to die at.
      await moveAgentToHost(m.deps, m.id, 'h2').then(
        () => expect(key).toBe('target-started'),
        (e) => expect(e).toBeInstanceOf(SimulatedCrash),
      );
      reboot(m.id);
      await resumeOperations(m.ctx);
      expect(await m.running2(), key).toEqual([false, false]);
      expect(m.w.store.getAgent(m.id)!.state, key).toBe('STOPPED');
      expect(['succeeded', 'rolled_back', 'failed'], key).toContain(m.w.store.listOperations([m.id])[0]!.status);
    }
  });

  it('puts the memory-search key back when it undoes a move', async () => {
    const m = await moveWorld();
    m.w.store.restoreEmbedToken(m.id, { tokenHash: 'hash-before', prevTokenHash: null, hostId: 'h1', createdAt: '2026-10-01T00:00:00.000Z' });
    const synced: Array<Array<string | null>> = [];
    const embedder = {
      credentialsFor: async () => { m.w.store.restoreEmbedToken(m.id, { tokenHash: 'hash-target', prevTokenHash: 'hash-before', hostId: 'h2', createdAt: '2026-10-09T00:00:00.000Z' }); return { baseUrl: 'http://embed.example.org', token: 'x', model: 'm' }; },
      syncKeys: async (hosts: Array<string | null>) => { synced.push(hosts); },
    };
    // The target's build mints its key, then the process dies before the flip.
    m.w.store.restoreEmbedToken(m.id, { tokenHash: 'hash-target', prevTokenHash: 'hash-before', hostId: 'h2', createdAt: '2026-10-09T00:00:00.000Z' });
    crashAt('state-copied');
    const op = beginOperation(m.w.store, 'move-host', m.id, {
      from: 'h1', to: 'h2', fromName: 'box', toName: 'Test Runner', wasRunning: true, oldRef: m.ref,
      keyBefore: { tokenHash: 'hash-before', prevTokenHash: null, hostId: 'h1', createdAt: '2026-10-01T00:00:00.000Z' },
    });
    setStepHookForTests(undefined);
    op.step('checked');
    await m.w.provider.stop(m.ref);
    m.w.store.setAgentState(m.id, 'STOPPED');
    op.step('stopped');
    reboot(m.id);
    await resumeOperations({ ...m.ctx, embedder });
    expect(m.w.store.embedTokenRow(m.id)).toMatchObject({ tokenHash: 'hash-before', hostId: 'h1' });
    expect(synced).toEqual([['h1', 'h2']]);
    expect(m.w.store.getAgent(m.id)).toMatchObject({ state: 'RUNNING', hostId: 'h1' });
  });
});

// ---- migrate ---------------------------------------------------------------

const PEER = { id: 'peer1', name: 'Test Peer', url: 'http://peer.example.org:8080', secretRef: 'peer/tok' };

async function migrateWorld() {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({ id: 'a1', ownerId: 'o', name: 'Test Agent', slug: 'test-agent', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'o', role: 'owner', status: 'active' });
  await secrets.put('ai/p1', 'not-a-key');
  await secrets.put('chan/a1', 'not-a-token');
  await secrets.put('peer/tok', 'not-a-peer-token');
  store.insertPeer({ ...PEER, ownerId: 'o', createdAt: 'now' });
  store.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'testagentbot', secretRef: 'chan/a1', deepLink: 'https://t.me/testagentbot', createdAt: 'now' });
  const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'test-agent', workspace: { files: {}, configPatch: { agentId: 'test-agent', authMode: 'api-key' } }, env: {} });
  store.setAgentRuntimeRef('a1', runtimeRef);
  await provider.start(runtimeRef);
  store.setAgentState('a1', 'RUNNING');
  const channel = { kind: 'telegram' } as any;
  const deps = { store, secrets, provider, channel, sleep: async () => {} };
  const ctx: ResumeContext = { store, secrets, channel, sleep: async () => {}, providerForHost: (h) => (h === 'h1' ? provider : undefined) };
  // The other server: did the import reach it, and does it answer now?
  const peer = { received: false, answers: 'yes' as 'yes' | 'no' | 'down' };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: any) => {
    const u = String(url);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/v1/agents/preflight')) return json({ ok: true, reasons: [] });
    if (u.includes('/v1/agents/restore')) { peer.received = true; return json({ id: 'remote1', name: 'Test Agent', state: 'RUNNING' }, 201); }
    if (u.endsWith('/v1/agents') && (init?.method ?? 'GET') === 'GET') {
      if (peer.answers === 'down') throw new Error('connect ECONNREFUSED');
      return json(peer.received && peer.answers === 'yes' ? [{ slug: 'test-agent', state: 'RUNNING' }] : []);
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  const localRunning = async () => (await provider.status(runtimeRef)).phase === 'running';
  return { store, provider, deps, ctx, peer, localRunning };
}

describe('migrate: killed at every step, then a restart', () => {
  for (const key of keysOf('migrate', '#succeeded')) {
    it(`at "${key}": the other server's answer decides, and two copies never run`, async () => {
      const m = await migrateWorld();
      crashAt(key);
      await expect(migrateAgent(m.deps as any, 'a1', PEER)).rejects.toBeInstanceOf(SimulatedCrash);
      reboot('a1');
      await resumeOperations(m.ctx);
      const op = m.store.listOperations(['a1'])[0]!;
      const agent = m.store.getAgent('a1')!;
      const remoteRuns = m.peer.received; // the peer answers truthfully here
      // Never both: a copy there means none here.
      expect(remoteRuns && (await m.localRunning())).toBe(false);
      if (remoteRuns) {
        expect(op.status).toBe('succeeded');
        expect(agent.migratedTo).toMatch(/Test Peer/);
        expect(agent.state).toBe('STOPPED');
      } else {
        expect(['failed', 'rolled_back']).toContain(op.status);
        expect(agent.migratedTo).toBeFalsy();
        expect(agent.state).toBe('RUNNING');
        expect(await m.localRunning()).toBe(true);
      }
      expect(operationRefusal(m.store, 'a1')).toBeUndefined();
    });
  }

  for (const key of ['answered', '#succeeded']) {
    it(`at "${key}" with the other server not answering: held, Start refused, asked again until it answers`, async () => {
      const m = await migrateWorld();
      crashAt(key);
      await expect(migrateAgent(m.deps as any, 'a1', PEER)).rejects.toBeInstanceOf(SimulatedCrash);
      reboot('a1');
      if (key === '#succeeded') {
        // It had already said yes and the copy here was marked as moved: nothing to ask.
        m.peer.answers = 'down';
        await resumeOperations(m.ctx);
        expect(m.store.listOperations(['a1'])[0]!.status).toBe('succeeded');
        return;
      }
      m.peer.answers = 'down';
      await resumeOperations(m.ctx);
      let op = m.store.listOperations(['a1'])[0]!;
      expect(op.status).toBe('held');
      expect(op.recovery!.actions.map((a) => a.action)).toEqual(['retry', 'arrived', 'start-here']);
      expect(m.store.getAgent('a1')!.state).toBe('STOPPED');
      expect(await m.localRunning()).toBe(false);
      expect(operationRefusal(m.store, 'a1')).toMatch(/could not be confirmed|hasn't said/);
      // The 10-minute question, still unanswered: still held, one line in the timeline.
      await retryHeldOperations(m.ctx);
      expect(m.store.listOperations(['a1'])[0]!.status).toBe('held');
      expect(m.store.listEvents(['a1'], 200).filter((e) => e.event === 'op.held')).toHaveLength(1);
      // It answers: it is there.
      m.peer.answers = 'yes';
      await retryHeldOperations(m.ctx);
      op = m.store.listOperations(['a1'])[0]!;
      expect(op.status).toBe('succeeded');
      expect(m.store.getAgent('a1')!.migratedTo).toMatch(/Test Peer/);
      expect(await m.localRunning()).toBe(false);
    });
  }

  it('held: the owner may say it is not there, and it is started here again', async () => {
    const m = await migrateWorld();
    crashAt('answered');
    await expect(migrateAgent(m.deps as any, 'a1', PEER)).rejects.toBeInstanceOf(SimulatedCrash);
    reboot('a1');
    m.peer.answers = 'down';
    await resumeOperations(m.ctx);
    const op = m.store.listOperations(['a1'])[0]!;
    await expect(recoverOperation(m.ctx, op.id, 'nonsense')).rejects.toThrow(/not one of this operation's choices/);
    const after = await recoverOperation(m.ctx, op.id, 'start-here');
    expect(after.status).toBe('rolled_back');
    expect(m.store.getAgent('a1')!.state).toBe('RUNNING');
    await expect(recoverOperation(m.ctx, op.id, 'start-here')).rejects.toThrow(/not waiting on you/);
  });

  it('an unconfirmed transfer in one go is held too (it used to leave Start allowed)', async () => {
    const m = await migrateWorld();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.endsWith('/v1/agents/preflight')) return new Response(JSON.stringify({ ok: true, reasons: [] }), { status: 200 });
      throw new Error('connection reset');
    });
    await expect(migrateAgent(m.deps as any, 'a1', PEER)).rejects.toThrow(/couldn't confirm/);
    expect(m.store.listOperations(['a1'])[0]!.status).toBe('held');
    expect(operationRefusal(m.store, 'a1')).toBeTruthy();
  });
});

// ---- import ----------------------------------------------------------------

async function importWorlds() {
  const mk = async (owner: string) => {
    const store = new Store(new Database(':memory:'));
    const secrets = new MemSecrets();
    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: owner, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: owner, name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    await secrets.put('ai/p1', 'not-a-key');
    return { store, secrets, provider, deps: { store, secrets, provider, channel: { kind: 'telegram' } as any, sleep: async () => {} } };
  };
  const src = await mk('o');
  src.store.insertAgent({ id: 'a1', ownerId: 'o', name: 'Test Agent', slug: 'test-agent', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: 'helps', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  src.store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'o', role: 'owner', status: 'active' });
  src.store.insertMembership({ id: 'm2', agentId: 'a1', userId: 'member-x', role: 'user', displayName: 'Test Member', status: 'active', channelUserId: '222' });
  await src.secrets.put('chan/a1', 'not-a-token');
  src.store.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'testagentbot', secretRef: 'chan/a1', deepLink: 'https://t.me/testagentbot', createdAt: 'now' });
  await src.secrets.put('agent-env/e1', 'made-up-value');
  src.store.insertAgentEnv({ id: 'e1', agentId: 'a1', name: 'TEST_SETTING', secretRef: 'agent-env/e1', createdAt: 'now' });
  const { runtimeRef } = await src.provider.provision({ agentId: 'a1', slug: 'test-agent', workspace: { files: {}, configPatch: { agentId: 'test-agent', authMode: 'api-key' } }, env: {} });
  src.store.setAgentRuntimeRef('a1', runtimeRef);
  await src.provider.start(runtimeRef);
  src.store.setAgentState('a1', 'RUNNING');
  src.provider.stateStore.set(runtimeRef, Buffer.from('remembered'));
  const { data } = await exportAgent(src.deps, 'a1');
  const dst = await mk('importer');
  const ctx: ResumeContext = { store: dst.store, secrets: dst.secrets, channel: dst.deps.channel, sleep: async () => {}, providerForHost: () => dst.provider };
  return { data, dst, ctx };
}

describe('import: killed at every step, then a restart', () => {
  for (const key of keysOf('import', '#succeeded')) {
    it(`at "${key}": ${key === '#succeeded' ? 'it was done — kept' : 'undone, never started half-made'}`, async () => {
      const { data, dst, ctx } = await importWorlds();
      crashAt(key);
      await expect(importAgent(dst.deps, data, { ownerId: 'importer' })).rejects.toBeInstanceOf(SimulatedCrash);
      const op = dst.store.operationsWithStatus(['running'])[0]!;
      const id = op.agentId!;
      reboot(id);
      // Boot order: interrupted rows first, then reconcile (which must leave
      // the half-made agent alone), then the recovery.
      markInterrupted(dst.store);
      await reconcileAgents(dst.store, new Map([['mock', dst.provider]]), () => {});
      const midway = dst.store.getAgent(id)!.state;
      expect(midway).toBe(key === '#succeeded' ? 'RUNNING' : 'PROVISIONING');
      await resumeOperations(ctx);

      const agent = dst.store.getAgent(id)!;
      const status = (await dst.provider.status(`mock://${id}`)).phase;
      if (key === '#succeeded') {
        expect(agent.state).toBe('RUNNING');
        expect(dst.store.getOperation(op.id)!.status).toBe('succeeded');
        return;
      }
      expect(agent.state).toBe('DELETED');
      expect(status).toBe('absent');
      expect(dst.store.getOperation(op.id)).toMatchObject({ status: 'rolled_back', outcome: 'Import interrupted — import the file again.' });
      expect(dst.store.getChannelForAgent(id)).toBeUndefined();
      expect(dst.store.listMemberships(id)).toHaveLength(0);
      await expect(dst.secrets.get(`channel/${id}/bot-token`)).rejects.toThrow();
      expect([...dst.secrets.map.keys()].filter((k) => k.startsWith('agent-env/'))).toEqual([]);
      // Never a half-made agent left to start, and "import again" works.
      expect(dst.store.listAllActiveAgents()).toHaveLength(0);
      const again = await importAgent(dst.deps, data, { ownerId: 'importer' });
      expect(again.state).toBe('RUNNING');
    });
  }

  it('a half-made copy whose machine does not answer is held, refused, and undone on Try again', async () => {
    const { data, dst, ctx } = await importWorlds();
    crashAt('started');
    await expect(importAgent(dst.deps, data, { ownerId: 'importer' })).rejects.toBeInstanceOf(SimulatedCrash);
    const id = dst.store.operationsWithStatus(['running'])[0]!.agentId!;
    reboot(id);
    const destroy = dst.provider.destroy.bind(dst.provider);
    dst.provider.destroy = async () => { throw new Error('daemon not answering'); };
    await resumeOperations(ctx);
    const op = dst.store.listOperations([id])[0]!;
    expect(op.status).toBe('held');
    expect(operationRefusal(dst.store, id)).toMatch(/could not be removed yet/);
    expect(dst.store.getAgent(id)!.state).toBe('PROVISIONING');
    dst.provider.destroy = destroy;
    const after = await recoverOperation(ctx, op.id, 'retry');
    expect(after.status).toBe('rolled_back');
    expect(dst.store.getAgent(id)!.state).toBe('DELETED');
    expect((await dst.provider.status(`mock://${id}`)).phase).toBe('absent');
  });
});

describe('small fixes', () => {
  it('the agent.moved line names the machine (the event carries toName; the label read toHost)', () => {
    expect(eventLabel('agent.moved', { from: 'h1', to: 'h2', toName: 'Test Runner' })).toBe('moved to Test Runner');
    expect(eventLabel('agent.moved', { from: 'h1', to: 'h2' })).toBe('moved to another host');
  });

  it("a completed move records toName", async () => {
    const m = await moveWorld();
    const logged: Array<[string, Record<string, unknown>]> = [];
    await moveAgentToHost({ ...m.deps, log: (e, d) => logged.push([e, d]) }, m.id, 'h2');
    expect(logged.find(([e]) => e === 'agent.moved')?.[1]).toMatchObject({ to: 'h2', toName: 'Test Runner' });
  });

  it("reconcile's findings about an agent reach its timeline; a repeated one is written once", async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    const journal: string[] = [];
    const log = reconcileEventLog(w.store, (e) => journal.push(e));
    log('reconcile.marked_stopped', { agentId: id });
    log('reconcile.unhealthy', { agentId: id });
    log('reconcile.unhealthy', { agentId: id });
    log('reconcile.loop_error', { error: 'x' });
    expect(journal).toEqual(['reconcile.marked_stopped', 'reconcile.unhealthy', 'reconcile.unhealthy', 'reconcile.loop_error']);
    expect(w.store.listEvents([id], 10).map((e) => e.event).reverse()).toEqual(['reconcile.marked_stopped', 'reconcile.unhealthy']);
  });
});
