import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { reconcileAgents } from '../src/orchestrator/reconcile.js';
import { clearBusy, markBusy } from '../src/orchestrator/busy.js';
import type { RuntimeProvider } from '../src/providers/provider.js';
import type { AgentState } from '../src/domain/types.js';

async function setup(dbState: AgentState, runtimePhase: 'running' | 'stopped' | 'absent') {
  const store = new Store(new Database(':memory:'));
  store.insertHost({
    id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box',
    settings: {}, createdAt: 'now',
  });
  const provider = new MockProvider();
  const { runtimeRef } = await provider.provision({
    agentId: 'a1', slug: 'a1',
    workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } },
    env: {},
  });
  if (runtimePhase === 'running') await provider.start(runtimeRef);
  if (runtimePhase === 'absent') await provider.destroy(runtimeRef, { purge: true });

  store.insertAgent({
    id: 'a1', ownerId: 'o', name: 'A', slug: 'a1', state: 'PROVISIONING',
    aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: false,
    createdAt: 'now', updatedAt: 'now',
  });
  store.setAgentRuntimeRef('a1', runtimeRef);
  // walk to the desired DB state through legal transitions
  if (dbState !== 'PROVISIONING') store.setAgentState('a1', 'RUNNING');
  if (dbState === 'STOPPED') store.setAgentState('a1', 'STOPPED');
  if (dbState === 'REBUILDING') store.setAgentState('a1', 'REBUILDING');

  const providers = new Map<string, RuntimeProvider>([['mock', provider]]);
  await reconcileAgents(store, providers, () => {});
  return store.getAgent('a1')!;
}

describe('busy agents are never judged', () => {
  it('leaves a busy agent alone even when its runtime looks gone', async () => {
    // The exact regression busy.ts exists for: mid-import/migrate a container
    // being replaced looks "absent", and reconcile marking it FAILED turned
    // the operation's final RUNNING write into an illegal transition — which
    // surfaced to the user as a rolled-back migration.
    markBusy('a1');
    try {
      expect((await setup('RUNNING', 'absent')).state).toBe('RUNNING');
    } finally {
      clearBusy('a1');
    }
  });
});

describe('boot reconcile', () => {
  it('marks a running-in-docker agent RUNNING when DB says STOPPED', async () => {
    expect((await setup('STOPPED', 'running')).state).toBe('RUNNING');
  });

  it('marks a stopped container STOPPED when DB says RUNNING', async () => {
    expect((await setup('RUNNING', 'stopped')).state).toBe('STOPPED');
  });

  it('fails an agent whose runtime vanished', async () => {
    const agent = await setup('RUNNING', 'absent');
    expect(agent.state).toBe('FAILED');
    expect(agent.stateReason).toMatch(/missing/);
  });

  it('completes a PROVISIONING agent whose runtime is actually up', async () => {
    expect((await setup('PROVISIONING', 'running')).state).toBe('RUNNING');
  });

  it('fails interrupted provisioning with a retry hint', async () => {
    const agent = await setup('PROVISIONING', 'stopped');
    expect(agent.state).toBe('FAILED');
    expect(agent.stateReason).toMatch(/Retry/);
  });

  it('completes a REBUILDING agent whose runtime is actually up', async () => {
    expect((await setup('REBUILDING', 'running')).state).toBe('RUNNING');
  });

  it('fails an interrupted rebuild with a retry hint', async () => {
    const agent = await setup('REBUILDING', 'stopped');
    expect(agent.state).toBe('FAILED');
    expect(agent.stateReason).toMatch(/rebuild was interrupted/i);
  });
});

describe('unhealthy detection', () => {
  it('logs an unhealthy running agent instead of silently leaving it green', async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({
      id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box',
      settings: {}, createdAt: 'now',
    });
    store.insertAgent({
      id: 'a1', ownerId: 'o', name: 'A', slug: 'a1', state: 'PROVISIONING',
      aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: false,
      createdAt: 'now', updatedAt: 'now',
    });
    // healthyAfter is high enough that status() reports running-but-unhealthy
    const provider = new MockProvider({ healthyAfter: 99 });
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'a1',
      workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } },
      env: {},
    });
    await provider.start(runtimeRef);
    store.setAgentRuntimeRef('a1', runtimeRef);
    store.setAgentState('a1', 'RUNNING');

    const events: string[] = [];
    await reconcileAgents(store, new Map([['mock', provider as RuntimeProvider]]), (e) => events.push(e));
    expect(events).toContain('reconcile.unhealthy');
    // state is left alone — a wedged gateway may recover on its own
    expect(store.getAgent('a1')!.state).toBe('RUNNING');
  });
});

describe('boot reconcile: parked agents', () => {
  function parkedWorld(withRuntime: boolean, pendingAction: boolean) {
    const store = new Store(new Database(':memory:'));
    store.insertHost({
      id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box',
      settings: {}, createdAt: 'now',
    });
    store.insertAgent({
      id: 'a1', ownerId: 'o', name: 'A', slug: 'a1', state: 'PROVISIONING',
      aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: false,
      createdAt: 'now', updatedAt: 'now',
    });
    if (pendingAction) {
      store.setAgentPendingAction('a1', { type: 'bot_token', instructions: 'paste it' });
    }
    const provider = new MockProvider();
    return { store, provider, withRuntime };
  }

  it('leaves a parked agent (pendingAction, no runtime) in PROVISIONING', async () => {
    const { store, provider } = parkedWorld(false, true);
    await reconcileAgents(store, new Map([['mock', provider as RuntimeProvider]]), () => {});
    expect(store.getAgent('a1')!.state).toBe('PROVISIONING');
  });

  it('leaves a parked agent alone even with a stopped half-made runtime', async () => {
    const { store, provider } = parkedWorld(false, true);
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'a1',
      workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } },
      env: {},
    });
    store.setAgentRuntimeRef('a1', runtimeRef);
    await reconcileAgents(store, new Map([['mock', provider as RuntimeProvider]]), () => {});
    expect(store.getAgent('a1')!.state).toBe('PROVISIONING');
  });

  it('fails an unparked PROVISIONING agent with no runtime', async () => {
    const { store, provider } = parkedWorld(false, false);
    await reconcileAgents(store, new Map([['mock', provider as RuntimeProvider]]), () => {});
    const a = store.getAgent('a1')!;
    expect(a.state).toBe('FAILED');
    expect(a.stateReason).toMatch(/interrupted/i);
  });
});

describe('a sweep judges the row as it is NOW, not as it was listed', () => {
  /**
   * The live failure: an agent created at 22:34:58 reported healthy at
   * 22:35:14 and was marked "Setup was interrupted" at 22:35:35. A sweep is
   * one docker call per agent, so on a 30-agent fleet the listing is a minute
   * stale by the time the loop reaches the end — and the agent it listed as
   * "PROVISIONING, no runtime yet" had since finished. The busy flag was no
   * help: it had been correctly cleared when provisioning completed.
   */
  const fleet = async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    const provider = new MockProvider();
    // 'slow' is listed first and stands in for the 29 agents ahead of the new
    // one; the new agent finishes provisioning during its docker call.
    const { runtimeRef } = await provider.provision({
      agentId: 'slow', slug: 'slow',
      workspace: { files: {}, configPatch: { agentId: 'slow', authMode: 'api-key' } },
      env: {},
    });
    await provider.start(runtimeRef);
    store.insertAgent({ id: 'slow', ownerId: 'o', name: 'Slow', slug: 'slow', state: 'PROVISIONING', aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    store.setAgentRuntimeRef('slow', runtimeRef);
    store.setAgentState('slow', 'RUNNING');
    store.insertAgent({ id: 'new', ownerId: 'o', name: 'New', slug: 'new', state: 'PROVISIONING', aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    return { store, provider };
  };

  it('does not fail an agent that finished setting up mid-sweep', async () => {
    const { store, provider } = await fleet();
    // Delegate to the real provider, intercepting only status(). A spread
    // wouldn't work: MockProvider's methods live on its prototype.
    const slowProvider: RuntimeProvider = Object.create(provider, {
      status: { value: async (ref: string) => {
        // Provisioning completes while the sweep is busy with the agent ahead.
        if (!store.getAgent('new')!.runtimeRef) {
          const r = await provider.provision({
            agentId: 'new', slug: 'new',
            workspace: { files: {}, configPatch: { agentId: 'new', authMode: 'api-key' } },
            env: {},
          });
          await provider.start(r.runtimeRef);
          store.setAgentRuntimeRef('new', r.runtimeRef);
          store.setAgentState('new', 'RUNNING');
        }
        return provider.status(ref);
      } },
    }) as RuntimeProvider;

    await reconcileAgents(store, new Map([['mock', slowProvider]]), () => {});
    const after = store.getAgent('new')!;
    expect(after.state).toBe('RUNNING'); // was FAILED: "Setup was interrupted"
    expect(after.stateReason ?? '').not.toMatch(/interrupted/i);
  });

  it('still fails an agent that genuinely never got a runtime', async () => {
    // The guard must not blunt the check it protects.
    const { store, provider } = await fleet();
    await reconcileAgents(store, new Map([['mock', provider]]), () => {});
    expect(store.getAgent('new')!.state).toBe('FAILED');
    expect(store.getAgent('new')!.stateReason).toMatch(/interrupted/i);
  });
});
