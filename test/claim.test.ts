import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { parsePairingList, claimFirstContact } from '../src/orchestrator/claim.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { canTransition } from '../src/domain/stateMachine.js';

describe('parsePairingList', () => {
  it('parses the 2026.6.11 pairing file shape', () => {
    const out = JSON.stringify({
      version: 1,
      requests: [
        { id: '1000000001', code: '4KXAEP9W', createdAt: 'x', meta: { username: 'chris' } },
      ],
    });
    expect(parsePairingList(out)).toEqual([
      { id: '1000000001', code: '4KXAEP9W', meta: { username: 'chris' } },
    ]);
  });

  it('accepts a bare array and rejects garbage', () => {
    expect(parsePairingList('[{"id":1,"code":"AB"}]')).toEqual([
      { id: '1', code: 'AB', meta: undefined },
    ]);
    expect(parsePairingList('not json')).toEqual([]);
    expect(parsePairingList('{"requests":"nope"}')).toEqual([]);
  });
});

describe('claimFirstContact', () => {
  it('approves the first request and binds the owner membership', async () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({
      agentId: 'a1',
      slug: 'a1',
      workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } },
      env: {},
    });

    // RUNNING, as in real life: the claim watcher only starts once the agent
    // is live, and bails out for itself when the agent stops being RUNNING.
    store.insertAgent({
      id: 'a1', ownerId: 'u1', name: 'A', slug: 'a1', state: 'RUNNING',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false,
      createdAt: 'now', updatedAt: 'now',
    });
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'owner', status: 'active' });

    provider.execResponses.set('pairing list', {
      code: 0,
      stdout: JSON.stringify({ requests: [{ id: '999', code: 'ZZZZ' }] }),
      stderr: '',
    });
    provider.execResponses.set('pairing approve', { code: 0, stdout: 'ok', stderr: '' });

    const claimed = await claimFirstContact(
      { store, provider, sleep: async () => {} },
      { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', timeoutMs: 1000 },
    );

    expect(claimed).toBe('999');
    expect(store.listAllowedChannelUserIds('a1')).toEqual(['999']);
    expect(provider.execLog.some((a) => a.join(' ').startsWith('pairing approve telegram ZZZZ'))).toBe(true);
  });

  it('returns null when the window closes with no contact', async () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({
      agentId: 'a2',
      slug: 'a2',
      workspace: { files: {}, configPatch: { agentId: 'a2', authMode: 'api-key' } },
      env: {},
    });
    store.insertAgent({
      id: 'a2', ownerId: 'u1', name: 'B', slug: 'a2', state: 'RUNNING',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false,
      createdAt: 'now', updatedAt: 'now',
    });
    let now = 0;
    const claimed = await claimFirstContact(
      {
        store,
        provider,
        sleep: async () => {
          now += 5000;
        },
      },
      { agentId: 'a2', runtimeRef, accountId: 'bot', forUserId: 'u1', timeoutMs: 1, pollIntervalMs: 1 },
    );
    expect(claimed).toBeNull();
  });
});

describe('state machine', () => {
  it('enforces §11.4 transitions', () => {
    expect(canTransition('PROVISIONING', 'RUNNING')).toBe(true);
    expect(canTransition('RUNNING', 'STOPPED')).toBe(true);
    expect(canTransition('STOPPED', 'RUNNING')).toBe(true);
    expect(canTransition('DELETED', 'RUNNING')).toBe(false);
    expect(canTransition('PROVISIONING', 'STOPPED')).toBe(false);
    expect(canTransition('FAILED', 'PROVISIONING')).toBe(true);
    expect(canTransition('RUNNING', 'REBUILDING')).toBe(true);
    expect(canTransition('STOPPED', 'REBUILDING')).toBe(true);
    expect(canTransition('REBUILDING', 'RUNNING')).toBe(true);
    expect(canTransition('REBUILDING', 'FAILED')).toBe(true);
    expect(canTransition('REBUILDING', 'DELETING')).toBe(true);
    expect(canTransition('PROVISIONING', 'REBUILDING')).toBe(false);
  });
});
