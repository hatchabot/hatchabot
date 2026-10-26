/**
 * An import a restart cut off is undone whole (deep audit of v2.166.2,
 * 2026-10-24): the runtime its first provision made before its ref was saved
 * (#003), and the deploy keys it stored for its repos (#004).
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { gzipSync } from 'node:zlib';
import { importAgent, resumeImport } from '../src/orchestrator/transfer.js';
import { SimulatedCrash } from '../src/orchestrator/operations.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { MemSecrets } from './support/world.js';
import type { ChannelProvisioner } from '../src/channels/channel.js';

const OWNER = 'owner-household';

async function destination() {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'Family box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  await secrets.put('ai/p1', 'fixture-value');
  const deps = { store, secrets, provider, channel: { kind: 'telegram' } as unknown as ChannelProvisioner, sleep: async () => {} };
  return { store, secrets, provider, deps };
}

const archive = (extra: Record<string, unknown> = {}) => gzipSync(JSON.stringify({
  format: 'hatchabot-export', version: 1, exportedAt: '2026-10-20T00:00:00Z',
  agent: { name: 'Homework Helper', slug: 'homework-helper', persona: 'Helps with homework.', sharedMemory: true, ...extra },
  ai: { vendor: 'anthropic', model: 'claude-opus-4-8' },
  memberships: [{ userId: 'someone', role: 'owner', status: 'active' }],
  state: Buffer.from('memory').toString('base64'),
}));

describe('resumeImport', () => {
  it('a restart inside the first provision: the runtime it made is removed, though its ref was never saved (#003)', async () => {
    const d = await destination();
    const provision = d.provider.provision.bind(d.provider);
    d.provider.provision = async (spec) => { await provision(spec); throw new SimulatedCrash(); };
    await expect(importAgent(d.deps, archive(), { ownerId: OWNER })).rejects.toBeInstanceOf(SimulatedCrash);
    const agent = d.store.listAllActiveAgents()[0]!;
    expect(agent.runtimeRef).toBeUndefined();
    const ref = d.provider.runtimeRefFor({ agentId: agent.id, slug: agent.slug });
    expect(d.provider.runtimes.get(ref)?.purged).toBe(false);
    await resumeImport(d.deps, d.store.activeOperationFor(agent.id)!.id);
    expect(d.store.getAgent(agent.id)?.state).toBe('DELETED');
    expect(d.provider.runtimes.get(ref)?.purged).toBe(true);
  });

  it('a restart before the first provision: nothing was made, and the undo still finishes', async () => {
    const d = await destination();
    d.provider.provision = async () => { throw new SimulatedCrash(); };
    await expect(importAgent(d.deps, archive(), { ownerId: OWNER })).rejects.toBeInstanceOf(SimulatedCrash);
    const agent = d.store.listAllActiveAgents()[0]!;
    const op = d.store.activeOperationFor(agent.id)!;
    await resumeImport(d.deps, op.id);
    expect(d.store.getAgent(agent.id)?.state).toBe('DELETED');
    expect(d.store.getOperation(op.id)?.status).toBe('rolled_back');
  });

  it('a restart after the repos were made: their imported deploy keys are deleted with their rows (#004)', async () => {
    const d = await destination();
    const start = d.provider.start.bind(d.provider);
    d.provider.start = async (ref) => { await start(ref); throw new SimulatedCrash(); };
    const repo = { kind: 'git', access: 'ro', mountName: 'homework-notes', repoUrl: 'git@example.invalid:household/notes.git', deployKey: 'fixture-deploy-value' };
    await expect(importAgent(d.deps, archive({ dataSources: [repo] }), { ownerId: OWNER })).rejects.toBeInstanceOf(SimulatedCrash);
    const agent = d.store.listAllActiveAgents()[0]!;
    const keyRef = d.store.listDataSources(agent.id)[0]!.secretRef!;
    expect(d.secrets.map.get(keyRef)).toBe('fixture-deploy-value');
    await resumeImport(d.deps, d.store.activeOperationFor(agent.id)!.id);
    expect(d.store.listDataSources(agent.id)).toHaveLength(0);
    expect(d.secrets.map.has(keyRef)).toBe(false);
  });
});
