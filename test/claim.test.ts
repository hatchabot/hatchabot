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
        { id: '1000000001', code: '4KXAEP9W', createdAt: 'x', meta: { username: 'owner' } },
      ],
    });
    expect(parsePairingList(out)).toEqual([
      { id: '1000000001', code: '4KXAEP9W', meta: { username: 'owner' } },
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

    provider.execResponses.set('sh', {
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

  it('never binds a telegram id that already belongs to another membership', async () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'a1',
      workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } },
      env: {},
    });
    store.insertAgent({
      id: 'a1', ownerId: 'u1', name: 'A', slug: 'a1', state: 'RUNNING',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false,
      createdAt: 'now', updatedAt: 'now',
    });
    // The owner is already bound to telegram 999 (e.g. a concurrent window
    // just claimed it). An invitee's watcher must NOT re-bind 999 onto the
    // invitee — that swap is the two-identities race.
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'owner', channelUserId: '999', status: 'active' });
    store.insertMembership({ id: 'm2', agentId: 'a1', userId: 'invitee', role: 'user', status: 'active' });
    provider.execResponses.set('sh', {
      code: 0, stdout: JSON.stringify({ requests: [{ id: '999', code: 'ZZZZ' }] }), stderr: '',
    });
    provider.execResponses.set('pairing approve', { code: 0, stdout: 'ok', stderr: '' });

    const claimed = await claimFirstContact(
      { store, provider, sleep: async () => {} },
      { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'invitee', timeoutMs: 30, pollIntervalMs: 1 },
    );
    expect(claimed).toBeNull(); // 999 was skipped, no other request arrived
    expect(store.getMembership('a1', 'invitee')!.channelUserId).toBeUndefined();
    expect(store.getActiveMembershipByChannelUser('a1', '999')!.userId).toBe('u1'); // still the owner
  });

  it('waits through a transient REBUILDING instead of abandoning the window', async () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'a1',
      workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } },
      env: {},
    });
    store.insertAgent({
      id: 'a1', ownerId: 'u1', name: 'A', slug: 'a1', state: 'REBUILDING',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false,
      createdAt: 'now', updatedAt: 'now',
    });
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'owner', status: 'active' });
    provider.execResponses.set('sh', {
      code: 0, stdout: JSON.stringify({ requests: [{ id: '777', code: 'AAAA' }] }), stderr: '',
    });
    provider.execResponses.set('pairing approve', { code: 0, stdout: 'ok', stderr: '' });

    // First poll sees REBUILDING (wait, don't abandon); then it goes RUNNING
    // and the claim completes — a routine rebuild mid-window must not strand.
    let polls = 0;
    const claimed = await claimFirstContact(
      { store, provider, sleep: async () => { if (++polls === 1) store.setAgentState('a1', 'RUNNING'); } },
      { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', timeoutMs: 50, pollIntervalMs: 1 },
    );
    expect(claimed).toBe('777');
  });

  it('abandons the window when the agent is deleted or failed', async () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'a1',
      workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } },
      env: {},
    });
    store.insertAgent({
      id: 'a1', ownerId: 'u1', name: 'A', slug: 'a1', state: 'FAILED',
      aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false,
      createdAt: 'now', updatedAt: 'now',
    });
    const claimed = await claimFirstContact(
      { store, provider, sleep: async () => {} },
      { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', timeoutMs: 50, pollIntervalMs: 1 },
    );
    expect(claimed).toBeNull();
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

describe('the claim says hello', () => {
  it('greets the owner the moment their first contact binds, so they do not type "hi" twice', async () => {
    const { claimFirstContact } = await import('../src/orchestrator/claim.js');
    const { Store } = await import('../src/store/store.js');
    const Database = (await import('better-sqlite3')).default;
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
    store.insertAgent({
      id: 'a1', ownerId: 'o', name: 'October Agent', slug: 'october', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
      runtimeRef: 'docker://a1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
    } as never);
    store.insertMembership({ id: 'm0', agentId: 'a1', userId: 'o', role: 'owner', status: 'active' } as never);

    const sent: string[] = [];
    const provider = {
      execShell: async () => ({ code: 0, stdout: JSON.stringify({ version: 1, requests: [{ id: '424242', code: 'C6STF628', meta: { firstName: 'Christopher' } }] }), stderr: '' }),
      execShellOnVolume: async () => ({ code: 0, stdout: 'set', stderr: '' }),
      exec: async (_ref: string, argv: string[]) => {
        if (argv[0] === 'message') sent.push(argv[argv.indexOf('-m') + 1]!);
        return { code: 0, stdout: '', stderr: '' };
      },
    } as never;

    const bound = await claimFirstContact(
      { store, provider, sleep: async () => {} },
      { agentId: 'a1', runtimeRef: 'docker://a1', accountId: 'bot', forUserId: 'o', timeoutMs: 60, pollIntervalMs: 5 },
    );
    expect(bound).toBe('424242');
    expect(sent.join(' ')).toContain('Christopher');
    expect(sent.join(' ')).toMatch(/Connected/);
  }, 10_000);
});
