import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { APP_VERSION } from '../src/domain/appVersion.js';

/**
 * A management agent reads its tool list once, when its gateway starts. After
 * an upgrade it would keep describing the old set — it told its owner it could
 * not add a package to a base image, one release after that became possible
 * (2026-09-19). The version its runtime was built against is recorded so the
 * control plane can restart it.
 */

describe('remembering which version an agent was built against', () => {
  it('starts unknown, is set at build time, and survives a read', () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
    store.insertAgent({
      id: 'ops1', ownerId: 'o', name: 'Hatchabot', slug: 'hatchabot', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
      runtimeRef: 'docker://ops1', persona: '', sharedMemory: false, webOnly: true, ops: true, createdAt: 'now', updatedAt: 'now',
    } as never);

    expect(store.appliedAppVersion('ops1')).toBeUndefined();   // an agent built before this existed
    store.setAppliedAppVersion('ops1', '1.34.0');
    expect(store.appliedAppVersion('ops1')).toBe('1.34.0');
    expect(store.appliedAppVersion('ops1')).not.toBe(APP_VERSION); // so an upgrade is visible
    store.setAppliedAppVersion('ops1', APP_VERSION);
    expect(store.appliedAppVersion('ops1')).toBe(APP_VERSION);
  });

  it('is set when the runtime spec is built', async () => {
    const { buildRuntimeSpec, createAgentRecord } = await import('../src/orchestrator/provision.js');
    const { MockProvider } = await import('../src/providers/mockProvider.js');
    const { setOpsHandlers } = await import('../src/ops/opsServer.js');
    setOpsHandlers({ mcp: async () => undefined, allowedHosts: () => [] });
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
    const secrets = { map: new Map<string, string>(), async put(r: string, v: string) { this.map.set(r, v); }, async get(r: string) { return this.map.get(r) ?? 'x'; }, async delete() {} };
    const deps = { store, secrets, provider: new MockProvider(), channel: {}, sleep: async () => {} };
    const agent = createAgentRecord(store, { ownerId: 'o', name: 'Hatchabot', aiProfileId: 'p1', hostId: 'h1' });
    store.setAgentWebOnly(agent.id, true);
    store.setAgentOps(agent.id, true);
    await buildRuntimeSpec(deps as never, agent.id);
    expect(store.appliedAppVersion(agent.id)).toBe(APP_VERSION);
  });
});
