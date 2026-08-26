/**
 * Move-to-host orchestrator: the intra-cluster relocation (local ⇄ runner).
 * Uses TWO MockProvider instances to simulate two Docker daemons — the shape
 * the route tests can't exercise (the shared world has one provider), and the
 * one where the dangerous steps live: copying state across daemons and
 * retiring the source runtime afterwards.
 */
import { describe, expect, it } from 'vitest';
import { MockProvider } from '../src/providers/mockProvider.js';
import { moveAgentToHost } from '../src/orchestrator/moveHost.js';
import { TransferError } from '../src/orchestrator/transfer.js';
import { makeWorld, seedRunningAgent, type World } from './support/world.js';

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

  it('refuses states that are not RUNNING/STOPPED', async () => {
    const { w, deps } = await crossDaemonWorld();
    const id = await seedRunningAgent(w);
    (w.store as any).db.prepare(`UPDATE agents SET state = 'REBUILDING' WHERE id = ?`).run(id);
    await expect(moveAgentToHost(deps, id, 'h2')).rejects.toThrow(TransferError);
  });
});
