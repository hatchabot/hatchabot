import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { LOCAL_OWNER } from '../src/api/principal.js';

function fresh() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: LOCAL_OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: LOCAL_OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({ id: 'a1', ownerId: LOCAL_OWNER, name: 'A', slug: 'a', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'docker://x', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
  return store;
}

describe('owner adoption carries the newer owner-keyed tables (audit 2026-09-11)', () => {
  it('moves agent_classes, operator_profile and posture_snapshots to the signed-in owner', () => {
    const store = fresh();
    store.upsertAgentClass({ id: 'c1', ownerId: LOCAL_OWNER, name: 'Heavy', model: 'm' });
    store.setAgentClass('a1', 'c1');
    store.setOperatorProfile(LOCAL_OWNER, 'I am Chris');
    store.upsertPostureSnapshot(LOCAL_OWNER, '2026-09-10', ['x']);
    expect(store.adoptLocalOwnerData('user-real')).toBeGreaterThan(0);
    expect(store.listAgentClasses('user-real').map((c) => c.name)).toEqual(['Heavy']);
    expect(store.getOperatorProfile('user-real')).toBe('I am Chris'); // would otherwise reset every agent to "Not set"
    expect(store.getOperatorProfile(LOCAL_OWNER)).toBe('');
    expect(store.latestPostureSnapshotBefore('user-real', '2026-09-11')).toBeDefined();
  });
});

describe('peer / class store helpers', () => {
  it('agentsWithPeersPending matches the per-agent computation', () => {
    const store = fresh();
    store.insertAgent({ id: 'a2', ownerId: LOCAL_OWNER, name: 'B', slug: 'b', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'docker://y', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
    expect([...store.agentsWithPeersPending(LOCAL_OWNER)]).toEqual([]);
    store.setAgentPeers('a1', ['a2']);
    expect([...store.agentsWithPeersPending(LOCAL_OWNER)]).toEqual(['a1']);
    store.recordAppliedPeers('a1');
    expect([...store.agentsWithPeersPending(LOCAL_OWNER)]).toEqual([]);
    store.setAgentPeers('a1', []); // revoke-to-zero is a change too
    expect([...store.agentsWithPeersPending(LOCAL_OWNER)]).toEqual(['a1']);
  });
  it('agentClassByName is case-insensitive and scrubAgentResidue drops the class tag', () => {
    const store = fresh();
    store.upsertAgentClass({ id: 'c1', ownerId: LOCAL_OWNER, name: 'Heavy' });
    expect(store.agentClassByName(LOCAL_OWNER, 'heavy')?.id).toBe('c1');
    expect(store.agentClassByName('someone-else', 'Heavy')).toBeUndefined();
    store.setAgentClass('a1', 'c1');
    store.scrubAgentResidue('a1');
    expect(store.getAgent('a1')!.classId).toBeUndefined();
  });
});
