import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { admitMember, AdmitError, revokeMember, RevokeError } from '../src/orchestrator/members.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';

async function setup(sharedMemory = true) {
  const db = new Database(':memory:');
  const store = new Store(db);
  const provider = new MockProvider();
  const { runtimeRef } = await provider.provision({
    agentId: 'a1',
    slug: 'a1',
    workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } },
    env: {},
  });
  store.insertAgent({
    id: 'a1', ownerId: 'u1', name: 'Fam', slug: 'a1', state: 'RUNNING',
    aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory,
    createdAt: 'now', updatedAt: 'now',
  });
  store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'owner', status: 'active' });
  provider.execResponses.set('pairing list', {
    code: 0,
    stdout: JSON.stringify({
      requests: [{ id: '555', code: 'CODE1', meta: { username: 'gran', firstName: 'Grandma' } }],
    }),
    stderr: '',
  });
  provider.execResponses.set('pairing approve', { code: 0, stdout: 'ok', stderr: '' });
  const opts = {
    agentId: 'a1', runtimeRef, accountId: 'bot', code: 'CODE1',
    agentName: 'Fam', sharedMemory,
  };
  return { store, provider, opts };
}

describe('admitMember', () => {
  it('approves the request, creates a bound membership, and sends the disclosure', async () => {
    const { store, provider, opts } = await setup(true);
    const res = await admitMember({ store, provider }, opts);

    expect(res).toMatchObject({ displayName: 'Grandma', channelUserId: '555', alreadyMember: false });
    expect(store.listAllowedChannelUserIds('a1')).toEqual(['555']);
    const member = store.getMembership('a1', res.userId);
    expect(member).toMatchObject({ role: 'user', status: 'active', channelUserId: '555' });

    expect(provider.execLog.some((a) => a.join(' ').startsWith('pairing approve telegram CODE1'))).toBe(true);
    const send = provider.execLog.find((a) => a[0] === 'message' && a[1] === 'send');
    expect(send).toBeDefined();
    expect(send!).toContain('555');
    expect(send![send!.length - 1]).toContain('shared agent');
  });

  it('omits the shared-memory disclosure when memory is not shared', async () => {
    const { store, provider, opts } = await setup(false);
    await admitMember({ store, provider }, opts);
    const send = provider.execLog.find((a) => a[0] === 'message' && a[1] === 'send');
    expect(send![send!.length - 1]).not.toContain('shared agent');
  });

  it('does not mint a second membership when the sender is already a member', async () => {
    const { store, provider, opts } = await setup();
    store.insertMembership({
      id: 'm2', agentId: 'a1', userId: 'u2', role: 'user',
      displayName: 'Grandma', channelUserId: '555', status: 'active',
    });
    const res = await admitMember({ store, provider }, opts);
    expect(res).toMatchObject({ userId: 'u2', alreadyMember: true });
    expect(store.listMemberships('a1').filter((m) => m.channelUserId === '555')).toHaveLength(1);
    expect(provider.execLog.some((a) => a[0] === 'message')).toBe(false);
  });

  it('rejects a code that is no longer pending', async () => {
    const { store, provider, opts } = await setup();
    await expect(admitMember({ store, provider }, { ...opts, code: 'GONE' })).rejects.toBeInstanceOf(
      AdmitError,
    );
    expect(store.listMemberships('a1')).toHaveLength(1); // owner only
  });

  it('still admits when the welcome message fails to send', async () => {
    const { store, provider, opts } = await setup();
    provider.execResponses.set('message send', { code: 1, stdout: '', stderr: 'boom' });
    const res = await admitMember({ store, provider }, opts);
    expect(res.alreadyMember).toBe(false);
    expect(store.getMembership('a1', res.userId)?.status).toBe('active');
  });
});

describe('revokeMember', () => {
  async function withMember() {
    const s = await setup();
    s.store.insertChannel({
      id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'MixedCaseBot',
      secretRef: 'chan/a1', deepLink: 'https://t.me/MixedCaseBot', createdAt: 'now',
    });
    s.store.setAgentRuntimeRef('a1', s.opts.runtimeRef);
    s.store.setAgentState('a1', 'RUNNING');
    s.store.insertMembership({
      id: 'm2', agentId: 'a1', userId: 'u2', role: 'user',
      displayName: 'Gran', channelUserId: '555', status: 'active',
    });
    return s;
  }

  it('revokes, scrubs the lowercased allowlist file, and bounces the runtime', async () => {
    const { store, provider } = await withMember();
    await revokeMember({ store, provider }, 'a1', 'u2');
    expect(store.getMembership('a1', 'u2')!.status).toBe('revoked');
    expect(store.listAllowedChannelUserIds('a1')).toEqual([]);
    const sh = provider.execLog.find((a) => a[0] === 'sh')!;
    expect(sh[1]).toContain('telegram-mixedcasebot-allowFrom.json');
    expect(sh[1]).toContain('555');
    expect(provider.runtimes.get('mock://a1')!.phase).toBe('running'); // restarted
  });

  it("refuses to remove the owner and is idempotent on re-revoke", async () => {
    const { store, provider } = await withMember();
    await expect(revokeMember({ store, provider }, 'a1', 'o')).rejects.toBeInstanceOf(RevokeError);
    await revokeMember({ store, provider }, 'a1', 'u2');
    const callsAfterFirst = provider.execLog.length;
    await revokeMember({ store, provider }, 'a1', 'u2'); // no second surgery
    expect(provider.execLog.length).toBe(callsAfterFirst);
  });

  it('keeps the DB revocation but reports failure when the scrub fails', async () => {
    const { store, provider } = await withMember();
    provider.execResponses.set('sh', { code: 1, stdout: '', stderr: 'boom' });
    await expect(revokeMember({ store, provider }, 'a1', 'u2')).rejects.toBeInstanceOf(RevokeError);
    expect(store.getMembership('a1', 'u2')!.status).toBe('revoked');
  });

  it('skips runtime surgery for a member with no telegram identity', async () => {
    const { store, provider } = await withMember();
    store.insertMembership({ id: 'm3', agentId: 'a1', userId: 'u3', role: 'user', status: 'active' });
    await revokeMember({ store, provider }, 'a1', 'u3');
    expect(provider.execLog.some((a) => a[0] === 'sh')).toBe(false);
  });
});
