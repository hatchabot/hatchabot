import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';

/** Slack and Discord live beside Telegram: one channel of each kind per agent. */

function setup() {
  const store = new Store(new Database(':memory:'));
  store.insertAgent({
    id: 'a1', ownerId: 'o', name: 'A', slug: 'a', state: 'RUNNING', aiProfileId: 'p', hostId: 'h',
    persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now',
  } as never);
  const ch = (kind: 'telegram' | 'slack' | 'discord', accountId: string, settings?: Record<string, unknown>) =>
    store.insertChannel({ id: `c-${kind}`, agentId: 'a1', kind, accountId, secretRef: `s/${kind}`, deepLink: `https://x/${kind}`, createdAt: 'now', settings });
  return { store, ch };
}

describe('channels by kind', () => {
  it('old callers still mean Telegram, and see nothing else', () => {
    const { store, ch } = setup();
    ch('slack', 'U0BOT');
    expect(store.getChannelForAgent('a1')).toBeUndefined();
    ch('telegram', 'mybot');
    expect(store.getChannelForAgent('a1')?.accountId).toBe('mybot');
    expect(store.getChannelForAgent('a1', 'slack')?.accountId).toBe('U0BOT');
  });

  it('lists Telegram first and round-trips settings', () => {
    const { store, ch } = setup();
    ch('discord', '111', { rooms: { mode: 'off' }, serverName: 'Home' });
    ch('telegram', 'mybot');
    const all = store.listChannelsForAgent('a1');
    expect(all.map((c) => c.kind)).toEqual(['telegram', 'discord']);
    expect(all[1]!.settings).toEqual({ rooms: { mode: 'off' }, serverName: 'Home' });
    store.setChannelSettings('a1', 'discord', { rooms: { mode: 'room', roomId: '42' } });
    expect(store.getChannelForAgent('a1', 'discord')?.settings).toEqual({ rooms: { mode: 'room', roomId: '42' } });
  });

  it('allows one of each kind, not two', () => {
    const { store, ch } = setup();
    ch('slack', 'U0BOT');
    expect(() => store.insertChannel({ id: 'c2', agentId: 'a1', kind: 'slack', accountId: 'U1', secretRef: 's', deepLink: 'd', createdAt: 'now' })).toThrow();
  });

  it('deleting by kind leaves the others; "all" clears everything', () => {
    const { store, ch } = setup();
    ch('telegram', 'mybot'); ch('slack', 'U0BOT'); ch('discord', '111');
    store.deleteChannelForAgent('a1');
    expect(store.listChannelsForAgent('a1').map((c) => c.kind)).toEqual(['slack', 'discord']);
    store.deleteChannelForAgent('a1', 'slack');
    expect(store.listChannelsForAgent('a1').map((c) => c.kind)).toEqual(['discord']);
    store.deleteChannelForAgent('a1', 'all');
    expect(store.listChannelsForAgent('a1')).toEqual([]);
  });

  it('the one-bot-one-agent guard is per kind', () => {
    const { store, ch } = setup();
    ch('slack', 'SAMEID');
    expect(store.findAgentUsingAccount('SAMEID')).toBeUndefined();
    expect(store.findAgentUsingAccount('SAMEID', 'slack')?.id).toBe('a1');
  });
});

describe('member identities on Slack and Discord', () => {
  function members() {
    const { store } = setup();
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'owner', role: 'owner', channelUserId: '999', status: 'active' });
    store.insertMembership({ id: 'm2', agentId: 'a1', userId: 'sis', role: 'user', status: 'active' });
    return store;
  }

  it('binds, feeds the allowlist per kind, and leaves Telegram alone', () => {
    const store = members();
    expect(store.bindMemberIdentity('a1', 'owner', 'slack', 'U111')).toBe(true);
    expect(store.bindMemberIdentity('a1', 'sis', 'slack', 'U222')).toBe(true);
    expect(store.listAllowedChannelUserIds('a1', 'slack').sort()).toEqual(['U111', 'U222']);
    expect(store.listAllowedChannelUserIds('a1', 'discord')).toEqual([]);
    expect(store.listAllowedChannelUserIds('a1')).toEqual(['999']);
    expect(store.memberIdentities('a1', 'owner')).toEqual({ telegram: '999', slack: 'U111' });
  });

  it('never takes someone else\'s identity or overwrites a different one', () => {
    const store = members();
    store.bindMemberIdentity('a1', 'owner', 'slack', 'U111');
    expect(store.bindMemberIdentity('a1', 'sis', 'slack', 'U111')).toBe(false);
    expect(store.bindMemberIdentity('a1', 'owner', 'slack', 'U999')).toBe(false);
    expect(store.memberIdentities('a1', 'owner').slack).toBe('U111');
  });

  it('a revoked member drops off the allowlist; re-admission clears the old identity', () => {
    const store = members();
    store.bindMemberIdentity('a1', 'sis', 'discord', '555');
    store.revokeMembership('a1', 'sis');
    expect(store.listAllowedChannelUserIds('a1', 'discord')).toEqual([]);
    expect(store.getMemberByIdentity('a1', 'discord', '555')).toBeUndefined();
    expect(store.bindMemberIdentity('a1', 'sis', 'discord', '556')).toBe(false);
    store.reactivateMembership('a1', 'sis', 'Sis');
    expect(store.memberIdentities('a1', 'sis')).toEqual({});
  });

  it('removing the channel forgets identities of that kind only', () => {
    const store = members();
    store.insertChannel({ id: 'cs', agentId: 'a1', kind: 'slack', accountId: 'U0', secretRef: 's', deepLink: 'd', createdAt: 'now' });
    store.bindMemberIdentity('a1', 'sis', 'slack', 'U222');
    store.bindMemberIdentity('a1', 'sis', 'discord', '555');
    store.deleteChannelForAgent('a1', 'slack');
    expect(store.memberIdentities('a1', 'sis')).toEqual({ discord: '555' });
  });
});
