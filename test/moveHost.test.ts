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

  it('refuses two host rows that point at the same Docker endpoint', async () => {
    const { w, deps } = await crossDaemonWorld();
    // Both "hosts" claim the same daemon — the retire step would eat the move.
    (w.store as any).db
      .prepare(`UPDATE hosts SET settings = ? WHERE id IN ('h1','h2')`)
      .run(JSON.stringify({ dockerHost: 'ssh://user@samebox' }));
    const id = await seedRunningAgent(w);
    await expect(moveAgentToHost(deps, id, 'h2')).rejects.toThrow(/same Docker endpoint/);
    expect(w.store.getAgent(id)!.hostId).toBe('h1');
  });

  it('refuses states that are not RUNNING/STOPPED', async () => {
    const { w, deps } = await crossDaemonWorld();
    const id = await seedRunningAgent(w);
    (w.store as any).db.prepare(`UPDATE agents SET state = 'REBUILDING' WHERE id = ?`).run(id);
    await expect(moveAgentToHost(deps, id, 'h2')).rejects.toThrow(TransferError);
  });
});
