import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { checkInvite, createInvite, redeemInvite, InviteInvalidError } from '../src/orchestrator/invite.js';

function makeStore(): Store {
  const store = new Store(new Database(':memory:'));
  store.insertAgent({
    id: 'a1', ownerId: 'owner', name: 'Family Agent', slug: 'family-agent',
    state: 'RUNNING', aiProfileId: 'p', hostId: 'h', persona: '',
    sharedMemory: true, createdAt: 'now', updatedAt: 'now',
  });
  return store;
}

describe('invites (§12.3)', () => {
  it('mints, validates, and redeems as a user-role member', () => {
    const store = makeStore();
    const { code } = createInvite(store, 'a1', 'owner');

    expect(checkInvite(store, code)).toEqual({ valid: true, agentId: 'a1' });
    // Codes are read off phone screens — case-insensitive.
    expect(checkInvite(store, code.toLowerCase()).valid).toBe(true);

    const joined = redeemInvite(store, code, '  Sam  ');
    const members = store.listMemberships('a1');
    const sam = members.find((m) => m.userId === joined.membershipUserId);
    expect(sam?.role).toBe('user');
    expect(sam?.displayName).toBe('Sam');
  });

  it('is single-use', () => {
    const store = makeStore();
    const { code } = createInvite(store, 'a1', 'owner');
    redeemInvite(store, code, 'First');
    expect(() => redeemInvite(store, code, 'Second')).toThrow(InviteInvalidError);
    expect(checkInvite(store, code)).toEqual({ valid: false, reason: 'used' });
  });

  it('rejects unknown and expired codes', () => {
    const store = makeStore();
    expect(checkInvite(store, 'NOPE')).toEqual({ valid: false, reason: 'unknown' });

    store.insertInvite({
      id: 'i1', agentId: 'a1', code: 'EXPIRED234', role: 'user', createdBy: 'owner',
      createdAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
      expiresAt: new Date(Date.now() - 86400_000).toISOString(),
    });
    expect(checkInvite(store, 'EXPIRED234')).toEqual({ valid: false, reason: 'expired' });
  });
});
