/**
 * Move-to-host orchestrator: the intra-cluster relocation (local ⇄ runner).
 * Uses TWO MockProvider instances to simulate two Docker daemons — the shape
 * the route tests can't exercise (the shared world has one provider), and the
 * one where the dangerous steps live: copying state across daemons and
 * retiring the source runtime afterwards.
 */
import { describe, expect, it, vi } from 'vitest';
import { MockProvider } from '../src/providers/mockProvider.js';
import { moveAgentToHost } from '../src/orchestrator/moveHost.js';
import { operationRefusal } from '../src/orchestrator/operations.js';
import { TransferError } from '../src/orchestrator/transfer.js';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';

const channelStub = { kind: 'telegram', pool: { availableCount: () => 0, owns: () => false } } as any;

async function crossDaemonWorld(): Promise<{ w: World; target: MockProvider; deps: any }> {
  const w = await makeWorld();
  w.store.insertHost({
    id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock', name: 'Runner',
    settings: {}, createdAt: 'now',
  });
  const target = new MockProvider();
  // Pin distinct daemon identities: the guard is daemon-id based now, so two
  // genuinely-separate daemons must report different ids for a move to run.
  w.provider.daemonId = async () => 'daemon-source';
  target.daemonId = async () => 'daemon-target';
  const deps = {
    store: w.store, secrets: w.secrets, channel: channelStub,
    source: w.provider, target, sleep: async () => {},
  };
  return { w, target, deps };
}

describe('moveAgentToHost — across two daemons', () => {
  it('copies the volume, starts on the target, and retires the source runtime', async () => {
    const { w, target, deps } = await crossDaemonWorld();
    const id = await seedRunningAgent(w, { memory: 'precious-memory' });
    const oldRef = w.store.getAgent(id)!.runtimeRef!;

    const moved = await moveAgentToHost(deps, id, 'h2');

    expect(moved.hostId).toBe('h2');
    expect(moved.state).toBe('RUNNING');
    // The memory crossed daemons: the target's volume holds the snapshot.
    expect(target.stateStore.get(moved.runtimeRef!)?.toString()).toBe('precious-memory');
    expect((await target.status(moved.runtimeRef!)).phase).toBe('running');
    // The agent's on-rebuild hook ran on the new host, so tools it installed
    // outside $HOME (which don't ride the volume) are reconstituted.
    expect(target.execLog.some((c) => c[0] === 'sh' && String(c[1] ?? '').includes('on-rebuild.sh'))).toBe(true);
    // The source runtime — container AND volume — was purged.
    expect((await w.provider.status(oldRef)).phase).toBe('absent');
  });

  it('a STOPPED agent moves stopped — it is not started on the target', async () => {
    const { w, target, deps } = await crossDaemonWorld();
    const id = await seedRunningAgent(w);
    await w.provider.stop(w.store.getAgent(id)!.runtimeRef!);
    w.store.setAgentState(id, 'STOPPED');

    const moved = await moveAgentToHost(deps, id, 'h2');
    expect(moved.state).toBe('STOPPED');
    expect((await target.status(moved.runtimeRef!)).phase).toBe('stopped');
  });

  it('a removed repo still to be scrubbed is scrubbed on the moved volume before it starts there (HB-0317)', async () => {
    const { w, target, deps } = await crossDaemonWorld();
    const id = await seedRunningAgent(w);
    w.store.addDataSourceRemoval({ id: 'gone', agentId: id, mountName: 'recipes', repoUrl: 'git@example.org:example-owner/recipes.git' });
    const order: string[] = [];
    const onVolume = target.execShellOnVolume.bind(target);
    target.execShellOnVolume = async (ref, script, opts) => { if (script.includes('recipes_deploy')) order.push('scrub'); return onVolume(ref, script, opts); };
    const start = target.start.bind(target);
    target.start = async (ref) => { order.push('start'); return start(ref); };

    const moved = await moveAgentToHost(deps, id, 'h2');
    expect(moved.state).toBe('RUNNING');
    expect(order).toEqual(['scrub', 'start']);
    expect(w.store.dataSourceRemovals(id)).toEqual([]);
  });

  it('a move rolled back after scrubbing its copy keeps the removal recorded for the source (HB-0317)', async () => {
    const { w, target, deps } = await crossDaemonWorld();
    const id = await seedRunningAgent(w);
    w.store.addDataSourceRemoval({ id: 'gone', agentId: id, mountName: 'recipes', repoUrl: 'git@example.org:example-owner/recipes.git' });
    let scrubbedCopy = false;
    const onVolume = target.execShellOnVolume.bind(target);
    target.execShellOnVolume = async (ref, script, opts) => { if (script.includes('recipes_deploy')) scrubbedCopy = true; return onVolume(ref, script, opts); };
    // The copy starts but never answers: the move is rolled back.
    target.status = async () => ({ phase: 'running', healthy: false });

    await expect(moveAgentToHost(deps, id, 'h2')).rejects.toThrow(/rolled back/);
    expect(scrubbedCopy).toBe(true);
    const agent = w.store.getAgent(id)!;
    expect(agent.hostId).toBe('h1');
    expect(agent.state).toBe('RUNNING');
    // The source's volume still holds the key: its next start must scrub it.
    expect(w.store.dataSourceRemovals(id).map((r) => r.id)).toEqual(['gone']);
  });

  it('a change owed to its next start: the new container has it, and an undone move still owes it (HB-0411)', async () => {
    const { w, deps } = await crossDaemonWorld();
    const id = await seedRunningAgent(w);
    await w.provider.stop(w.store.getAgent(id)!.runtimeRef!);
    w.store.setAgentState(id, 'STOPPED');
    w.store.setRebuildOnStart(id, '2026-11-05T00:00:00.000Z');
    const moved = await moveAgentToHost(deps, id, 'h2');
    expect(moved.rebuildOnStart).toBeUndefined();

    const back = await crossDaemonWorld();
    const id2 = await seedRunningAgent(back.w);
    await back.w.provider.stop(back.w.store.getAgent(id2)!.runtimeRef!);
    back.w.store.setAgentState(id2, 'STOPPED');
    back.w.store.setRebuildOnStart(id2, '2026-11-05T00:00:00.000Z');
    // It fails after the new container was recorded, so only an undo can bring the mark back.
    back.w.store.setRebuildHookDue = () => { throw new Error('the last step failed'); };
    await expect(moveAgentToHost(back.deps, id2, 'h2')).rejects.toThrow(/rolled back/);
    expect(back.w.store.getAgent(id2)!.hostId).toBe('h1');
    expect(back.w.store.getAgent(id2)!.rebuildOnStart).toBe('2026-11-05T00:00:00.000Z');
  });

  it('rolls back onto the source host when the target provision fails', async () => {
    const w = await makeWorld();
    w.store.insertHost({
      id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock', name: 'Runner',
      settings: {}, createdAt: 'now',
    });
    const target = new MockProvider({ failOn: 'provision' });
    const deps = {
      store: w.store, secrets: w.secrets, channel: channelStub,
      source: w.provider, target, sleep: async () => {},
    };
    const id = await seedRunningAgent(w);

    await expect(moveAgentToHost(deps, id, 'h2')).rejects.toThrow(/rolled back/);
    const agent = w.store.getAgent(id)!;
    expect(agent.hostId).toBe('h1');
    // The quiesced source was restarted — the move must not strand it stopped.
    expect(agent.state).toBe('RUNNING');
    expect((await w.provider.status(agent.runtimeRef!)).phase).toBe('running');
  });

  it('a source that did not come back after a failed move: failed, said so, and Start is open (HB-0416)', async () => {
    const w = await makeWorld();
    w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock', name: 'Runner', settings: {}, createdAt: 'now' });
    const target = new MockProvider({ failOn: 'provision' });
    const deps = { store: w.store, secrets: w.secrets, channel: channelStub, source: w.provider, target, sleep: async () => {} };
    const id = await seedRunningAgent(w);
    const start = w.provider.start.bind(w.provider);
    w.provider.start = async () => { throw new Error('the port is taken'); };
    const err = await moveAgentToHost(deps, id, 'h2').catch((e: Error) => e);
    expect(String(err)).toMatch(/failed.*did not start again on .*stopped there.*Start.*Rebuild/);
    expect(String(err)).not.toMatch(/stays on|rolled back|Try again/);
    const op = w.store.listOperations([id], 1)[0]!;
    expect(op).toMatchObject({ kind: 'move-host', status: 'failed', outcome: expect.stringMatching(/did not start again/) });
    expect(op.recovery).toBeFalsy();
    expect(w.store.getAgent(id)).toMatchObject({ state: 'STOPPED', hostId: 'h1' });
    expect(w.store.activeOperationFor(id)).toBeUndefined();
    // It says why, on its card and in Alerts, not just in a toast.
    expect(w.store.getAgent(id)!.stateReason).toMatch(/move to Runner failed.*did not start again on .*press Start, or Rebuild/);
    const seen = await w.f.inject({ method: 'GET', url: `/v1/agents/${id}`, headers: as() });
    expect(seen.json().stateReason).toMatch(/did not start again/);
    // Nothing is held: the machine answers again, and Start starts it.
    w.provider.start = start;
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: as(), payload: {} });
    expect(r.statusCode, r.body).toBe(200);
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');
    expect(w.store.getAgent(id)!.stateReason).toBeUndefined();
  });

  it('a move that failed on an agent left stopped says nothing: nobody expected it to run', async () => {
    const w = await makeWorld();
    w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock', name: 'Runner', settings: {}, createdAt: 'now' });
    const target = new MockProvider({ failOn: 'provision' });
    const deps = { store: w.store, secrets: w.secrets, channel: channelStub, source: w.provider, target, sleep: async () => {} };
    const id = await seedRunningAgent(w);
    w.store.setAgentState(id, 'STOPPED');
    await moveAgentToHost(deps, id, 'h2').catch(() => {});
    expect(w.store.getAgent(id)).toMatchObject({ state: 'STOPPED', hostId: 'h1' });
    expect(w.store.getAgent(id)!.stateReason).toBeUndefined();
  });

  it('what a failed move said goes with a later move that works, and a Clear from Alerts does not hide the next one (HB-0416)', async () => {
    const w = await makeWorld();
    w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock', name: 'Runner', settings: {}, createdAt: 'now' });
    const bad = new MockProvider({ failOn: 'provision' });
    bad.daemonId = async () => 'daemon-target';
    w.provider.daemonId = async () => 'daemon-source';
    const id = await seedRunningAgent(w);
    const start = w.provider.start.bind(w.provider);
    w.provider.start = async () => { throw new Error('the port is taken'); };
    const deps = { store: w.store, secrets: w.secrets, channel: channelStub, source: w.provider, target: bad, sleep: async () => {} };
    await moveAgentToHost(deps, id, 'h2').catch(() => {});
    expect(w.store.getAgent(id)!.stateReason).toMatch(/did not start again/);
    w.provider.start = start;
    // Cleared, then it happens again from RUNNING: the Clear does not cover the new one.
    w.store.setAgentAttentionAck(id, 'not-started');
    w.store.markNotStarted(id, 'made up: again');
    expect(w.store.getAgent(id)!.attentionAck ?? '').not.toContain('not-started');
    const good = new MockProvider();
    good.daemonId = async () => 'daemon-target';
    const moved = await moveAgentToHost({ ...deps, target: good }, id, 'h2');
    expect(moved).toMatchObject({ state: 'STOPPED', hostId: 'h2' });
    expect(moved.stateReason).toBeUndefined();
  });

  it('a state read that failed, and a source that did not come back: not "nothing was changed", and Rebuild is open (HB-0416)', async () => {
    const { w, deps } = await crossDaemonWorld();
    const id = await seedRunningAgent(w);
    const read = w.provider.exportStateToFile.bind(w.provider);
    w.provider.exportStateToFile = async () => { throw new Error('read failed'); };
    const start = w.provider.start.bind(w.provider);
    w.provider.start = async () => { throw new Error('the port is taken'); };
    const err = await moveAgentToHost(deps, id, 'h2').catch((e: Error) => e);
    expect(String(err)).toMatch(/did not start again on .*stopped there/);
    expect(String(err)).not.toMatch(/nothing was changed|Try again/);
    const op = w.store.listOperations([id], 1)[0]!;
    expect(op).toMatchObject({ kind: 'move-host', status: 'failed' });
    expect(op.recovery).toBeFalsy();
    expect(w.store.getAgent(id)).toMatchObject({ state: 'STOPPED', hostId: 'h1' });
    expect(w.store.getAgent(id)!.stateReason).toMatch(/did not start again on /);
    // The old container is the fault (a pruned image, a taken port): Start still
    // fails, and Rebuild, the cure, is not refused.
    w.provider.exportStateToFile = read;
    w.provider.start = start;
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/rebuild`, headers: as(), payload: {} });
    expect(r.statusCode, r.body).toBe(202);
    await vi.waitFor(() => expect(w.store.getAgent(id)!.state).toBe('RUNNING'), { timeout: 4000, interval: 20 });
  });

  it('a failed move leaves no operation that refuses Move or Delete either (HB-0416)', async () => {
    const { w, deps } = await crossDaemonWorld();
    const id = await seedRunningAgent(w);
    w.provider.exportStateToFile = async () => { throw new Error('read failed'); };
    w.provider.start = async () => { throw new Error('the runner is gone'); };
    await moveAgentToHost(deps, id, 'h2').catch(() => {});
    expect(operationRefusal(w.store, id)).toBeUndefined();
    const del = await w.f.inject({ method: 'DELETE', url: `/v1/agents/${id}`, headers: as() });
    expect(del.statusCode, del.body).not.toBe(409);
  });

  it('refuses two host rows that are the SAME daemon (aliased endpoints), volume untouched', async () => {
    const { w, target, deps } = await crossDaemonWorld();
    // The endpoints differ as strings (ssh://h vs ssh://h:22) but resolve to
    // one daemon — the trap that string-equality missed and that would purge
    // the moved volume. Both providers now report the same daemon id.
    target.daemonId = async () => 'daemon-source';
    const id = await seedRunningAgent(w, { memory: 'do-not-lose-me' });
    const oldRef = w.store.getAgent(id)!.runtimeRef!;
    await expect(moveAgentToHost(deps, id, 'h2')).rejects.toThrow(/same Docker daemon/);
    // Nothing was touched — still on the source, still running, memory intact.
    expect(w.store.getAgent(id)!.hostId).toBe('h1');
    expect((await w.provider.status(oldRef)).phase).toBe('running');
    expect(w.provider.stateStore.get(oldRef)?.toString()).toBe('do-not-lose-me');
  });

  it('refuses (without touching the agent) when a daemon can\'t be reached', async () => {
    const { w, target, deps } = await crossDaemonWorld();
    target.daemonId = async () => { throw new Error('daemon down'); };
    const id = await seedRunningAgent(w);
    await expect(moveAgentToHost(deps, id, 'h2')).rejects.toThrow(/didn't answer/);
    expect(w.store.getAgent(id)!.state).toBe('RUNNING'); // never quiesced
  });

  it('rollback leaves the agent STOPPED (not dual-polling) when the target can\'t be cleaned up', async () => {
    const { w, target, deps } = await crossDaemonWorld();
    const id = await seedRunningAgent(w);
    // Target boots but never becomes healthy → waitForHealthy throws; then the
    // rollback destroy also fails and the container is still running (phase
    // running), so restarting the source would dual-poll.
    target.status = async () => ({ phase: 'running', healthy: false });
    target.destroy = async () => { throw new Error('daemon hung'); };
    await expect(moveAgentToHost(deps, id, 'h2')).rejects.toThrow(/STOPPED to avoid two bots/);
    // Source NOT restarted — left stopped so an operator resolves the orphan.
    expect(w.store.getAgent(id)!.state).toBe('STOPPED');
  });

  it('refuses when the agent left the host its source provider was made for (2026-10-09)', async () => {
    const { w, target, deps } = await crossDaemonWorld();
    const id = await seedRunningAgent(w, { memory: 'precious-memory' });
    w.store.insertHost({ id: 'h3', ownerId: w.owner, kind: 'cloud', provider: 'mock', name: 'Third', settings: {}, createdAt: 'now' });
    // The route made `source` for h1; a move to h3 finished before this one took the lock.
    (w.store as any).db.prepare(`UPDATE agents SET host_id = 'h3' WHERE id = ?`).run(id);
    await expect(moveAgentToHost({ ...deps, sourceHostId: 'h1' }, id, 'h2')).rejects.toThrow(/moved to another machine meanwhile/);
    expect(w.store.getAgent(id)!.hostId).toBe('h3');
    expect(target.stateStore.size).toBe(0);
  });

  it('refuses states that are not RUNNING/STOPPED', async () => {
    const { w, deps } = await crossDaemonWorld();
    const id = await seedRunningAgent(w);
    (w.store as any).db.prepare(`UPDATE agents SET state = 'REBUILDING' WHERE id = ?`).run(id);
    await expect(moveAgentToHost(deps, id, 'h2')).rejects.toThrow(TransferError);
  });

  describe('the memory search key (2026-10-09)', () => {
    /** A stand-in for routes.ts's adapter: a new key per build, for the machine named. */
    const keys = (w: World) => {
      let n = 0;
      const synced: Array<Array<string | null>> = [];
      return {
        synced,
        credentialsFor: async (agentId: string, hostId?: string) => {
          w.store.setEmbedToken(agentId, `hash-${++n}`, hostId ?? null);
          return { baseUrl: 'http://door.example.org/v1', token: `t-${n}`, model: 'embeddinggemma' };
        },
        syncKeys: async (hosts: Array<string | null>) => { synced.push(hosts); },
      };
    };

    it('a move that rolls back gives the source its old key back, and both doors are told', async () => {
      const { w, target, deps } = await crossDaemonWorld();
      const id = await seedRunningAgent(w);
      w.store.setAgentEmbedMode(id, 'shared');
      w.store.setEmbedToken(id, 'hash-old', 'h1');
      w.store.commitEmbedToken(id);
      const embedder = keys(w);
      target.status = async () => ({ phase: 'stopped', healthy: false }); // never healthy → rollback
      await expect(moveAgentToHost({ ...deps, embedder }, id, 'h2')).rejects.toThrow(/rolled back/);
      expect(w.store.getAgent(id)!.hostId).toBe('h1');
      // Before: host h2 and the old key only as a "previous" one — the source's door
      // (which keeps only its own machine's keys) dropped the agent: 401 on every recall.
      expect(w.store.embedTokenRow(id)).toMatchObject({ tokenHash: 'hash-old', prevTokenHash: null, hostId: 'h1' });
      expect(embedder.synced).toEqual([['h1', 'h2']]);
    });

    it('a move that lands retires the old key (only the new one opens the door there)', async () => {
      const { w, deps } = await crossDaemonWorld();
      const id = await seedRunningAgent(w);
      w.store.setAgentEmbedMode(id, 'shared');
      w.store.setEmbedToken(id, 'hash-old', 'h1');
      w.store.commitEmbedToken(id);
      const embedder = keys(w);
      await moveAgentToHost({ ...deps, embedder }, id, 'h2');
      const row = w.store.embedTokenRow(id)!;
      expect(row.hostId).toBe('h2');
      expect(row.prevTokenHash).toBeNull();
      expect(row.tokenHash).not.toBe('hash-old');
      expect(embedder.synced).toEqual([]);
    });
  });
});
