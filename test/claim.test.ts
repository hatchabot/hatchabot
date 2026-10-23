import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { parsePairingList, claimFirstContact } from '../src/orchestrator/claim.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { canTransition } from '../src/domain/stateMachine.js';
import { DISCORD_ID } from './support/fixtures.js';

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

  // A088: the seat is checked before the approval is awaited; a removal that
  // lands during that await left OpenClaw admitting an id no member row held.
  async function approvalRace(during: (store: Store) => void) {
    const store = new Store(new Database(':memory:'));
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
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'owner', status: 'active' });
    store.insertMembership({ id: 'm2', agentId: 'a1', userId: 'invitee', role: 'user', status: 'active' });
    provider.execResponses.set('sh', {
      code: 0, stdout: JSON.stringify({ requests: [{ id: '4242', code: 'RACE' }] }), stderr: '',
    });
    const exec = provider.exec.bind(provider);
    provider.exec = async (ref, argv, o) => {
      if (argv[0] === 'pairing' && argv[1] === 'approve') during(store);
      return exec(ref, argv, o);
    };
    provider.execResponses.set('pairing approve', { code: 0, stdout: 'ok', stderr: '' });
    const claimed = await claimFirstContact(
      { store, provider, sleep: async () => {} },
      { agentId: 'a1', runtimeRef, accountId: 'famBot', forUserId: 'invitee', timeoutMs: 1000, pollIntervalMs: 1 },
    );
    const scrubs = provider.execLog.filter((a) => a[0] === 'sh-volume' && a[1]!.includes('delete from channel_pairing_allow_entries') && a[1]!.includes('"4242"'));
    return { store, claimed, scrubs };
  }

  it('an approval whose seat was removed meanwhile is taken back, and the window closes', async () => {
    const { store, claimed, scrubs } = await approvalRace((s) => s.revokeMembership('a1', 'invitee'));
    expect(claimed).toBeNull();
    expect(scrubs).toHaveLength(1);
    expect(scrubs[0]![1]).toContain('telegram-fambot-allowFrom.json');
    expect(store.pairingWindowOpen('a1')).toBe(false);
  });

  it('an approval somebody else\'s window bound meanwhile is theirs: not scrubbed', async () => {
    const { store, claimed, scrubs } = await approvalRace((s) => { s.bindMembershipChannelUser('a1', 'u1', '4242'); });
    expect(claimed).toBeNull(); // the window gives up on its own timer; the id stays the owner's
    expect(scrubs).toHaveLength(0);
    expect(store.getActiveMembershipByChannelUser('a1', '4242')!.userId).toBe('u1');
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

  // Review, 2026-10-22 (B16, B17).
  async function owner() {
    const store = new Store(new Database(':memory:'));
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
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'owner', status: 'active' });
    provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ requests: [{ id: '999', code: 'ZZZZ' }] }), stderr: '' });
    provider.execResponses.set('pairing approve', { code: 0, stdout: 'ok', stderr: '' });
    return { store, provider, runtimeRef };
  }
  const allowlisted = (p: MockProvider) => p.execLog.some((a) => a[0] === 'sh-volume' && a[1]!.includes('"policy":"allowlist"'));

  it("another chat app's window does not keep this one's door open once it is claimed", async () => {
    const { store, provider, runtimeRef } = await owner();
    store.insertMembership({ id: 'm2', agentId: 'a1', userId: 'guest', role: 'user', status: 'active' });
    store.openPairingWindow('a1', new Date(Date.now() + 600_000).toISOString(), 'guest', { kind: 'discord' });
    const claimed = await claimFirstContact(
      { store, provider, sleep: async () => {} },
      { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', timeoutMs: 1000 },
    );
    expect(claimed).toBe('999');
    expect(allowlisted(provider)).toBe(true);
  });

  it("the same chat app's other window still holds the door", async () => {
    const { store, provider, runtimeRef } = await owner();
    store.insertMembership({ id: 'm2', agentId: 'a1', userId: 'guest', role: 'user', status: 'active' });
    store.openPairingWindow('a1', new Date(Date.now() + 600_000).toISOString(), 'guest', { kind: 'telegram' });
    await claimFirstContact(
      { store, provider, sleep: async () => {} },
      { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', timeoutMs: 1000 },
    );
    expect(allowlisted(provider)).toBe(false);
  });

  it('a pairing read that throws is tried again, not the end of the watcher', async () => {
    const { store, provider, runtimeRef } = await owner();
    const execShell = provider.execShell.bind(provider);
    let n = 0;
    provider.execShell = async (ref, script, o) => {
      if (++n === 1) throw new Error('docker exec: connection reset');
      return execShell(ref, script, o);
    };
    const events: string[] = [];
    const claimed = await claimFirstContact(
      { store, provider, sleep: async () => {}, log: (e) => { events.push(e); } },
      { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', timeoutMs: 1000, pollIntervalMs: 1 },
    );
    expect(claimed).toBe('999');
    expect(events.filter((e) => e === 'claim.read_failed')).toHaveLength(1);
    expect(store.pairingWindowOpen('a1')).toBe(false);
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

describe('the owner claim never takes a known person (2026-09-25)', () => {
  // An owner window with no named handle is "the first knock". A Discord bot
  // is visible to a whole server and a recycled Telegram bot has just written
  // to its previous agent's regulars, so the first knock is only claimed when
  // the id is nobody this machine knows.
  async function world(kind: 'telegram' | 'discord', requests: Array<{ id: string; code: string }>) {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} });
    for (const [id, owner] of [['a1', 'u1'], ['b1', 'u2']] as const) {
      store.insertAgent({ id, ownerId: owner, name: id, slug: id, state: 'RUNNING', aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
      store.insertMembership({ id: `m-${id}`, agentId: id, userId: owner, role: 'owner', status: 'active' });
    }
    provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ requests }), stderr: '' });
    provider.execResponses.set('pairing approve', { code: 0, stdout: 'ok', stderr: '' });
    const claim = (extra: Record<string, unknown> = {}) => claimFirstContact(
      { store, provider, sleep: async () => {} },
      { agentId: 'a1', runtimeRef, accountId: 'bot', forUserId: 'u1', kind, timeoutMs: 1000, pollIntervalMs: 1, ...extra } as never,
    );
    return { store, claim };
  }

  it('Telegram: a member of another owner\'s agent, or another account\'s link, is passed over for a fresh id', async () => {
    const { store, claim } = await world('telegram', [{ id: '555', code: 'AAAA' }, { id: '777', code: 'BBBB' }, { id: '999', code: 'CCCC' }]);
    store.insertMembership({ id: 'm-x', agentId: 'b1', userId: 'u9', role: 'user', channelUserId: '555', status: 'active' });
    store.setAccountTelegram('u2', '777');
    expect(await claim()).toBe('999');
    expect(store.getMembership('a1', 'u1')?.channelUserId).toBe('999');
  });

  it('Telegram: the recycled bot\'s previous regulars are excluded even when unknown to the store; nobody else → the window closes unclaimed', async () => {
    const { store, claim } = await world('telegram', [{ id: '4242', code: 'AAAA' }]);
    expect(await claim({ excludeIds: ['4242'] })).toBeNull();
    expect(store.getMembership('a1', 'u1')?.channelUserId).toBeFalsy();
  });

  it('Discord: an identity bound on any agent is never the owner\'s first message; a malformed id is never bound', async () => {
    const { store, claim } = await world('discord', [{ id: 'not-an-id', code: 'AAAA' }, { id: '123456789012345678', code: 'BBBB' }, { id: '987654321098765432', code: 'CCCC' }]);
    store.insertMembership({ id: 'm-y', agentId: 'b1', userId: 'u3', role: 'user', status: 'active' });
    store.bindMemberIdentity('b1', 'u3', 'discord', DISCORD_ID);
    expect(await claim()).toBe('987654321098765432');
    expect(store.memberIdentities('a1', 'u1').discord).toBe('987654321098765432');
  });

  it('a window that names its person still claims exactly them, known or not', async () => {
    const { store, claim } = await world('telegram', [{ id: '555', code: 'AAAA' }]);
    store.insertMembership({ id: 'm-x', agentId: 'b1', userId: 'u9', role: 'user', channelUserId: '555', status: 'active' });
    expect(await claim({ expect: '555' })).toBe('555');
  });
});

