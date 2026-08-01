import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { reconcileAgents } from '../src/orchestrator/reconcile.js';
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
