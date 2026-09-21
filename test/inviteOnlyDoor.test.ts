import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import type { Agent } from '../src/domain/types.js';

/**
 * A bot username is findable, so strangers DM agents. An agent admits only
 * people it is expecting: an open invite window, or somebody this owner
 * already knows. Everyone else never reaches the owner at all.
 */
const OWNER = 'user-owner';
function world() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const add = (id: string) => store.insertAgent({
    id, ownerId: OWNER, name: id, slug: id, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
    persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
  } as unknown as Agent);
  add('a1'); add('a2');
  return store;
}

describe('the invite-only door', () => {
  it('is on by default for every agent, old and new', () => {
    const s = world();
    expect(s.getAgent('a1')!.allowKnocks).toBe(false);
    s.setAllowKnocks('a1', true);
    expect(s.getAgent('a1')!.allowKnocks).toBe(true);
    expect(s.getAgent('a2')!.allowKnocks).toBe(false); // per agent, not fleet
  });

  it('an invite window opens and closes, and expires on its own', () => {
    const s = world();
    expect(s.pairingWindowOpen('a1')).toBe(false);
    s.openPairingWindow('a1', new Date(Date.now() + 60_000).toISOString(), 'user-guest');
    expect(s.pairingWindowOpen('a1')).toBe(true);
    // the same window, seen from after its deadline
    expect(s.pairingWindowOpen('a1', new Date(Date.now() + 120_000))).toBe(false);
    s.closePairingWindow('a1');
    expect(s.pairingWindowOpen('a1')).toBe(false);
  });

  it('someone who is a member of ONE agent is known at the next one', () => {
    const s = world();
    expect(s.isKnownChannelUser(OWNER, 'telegram', '555')).toBe(false);
    s.insertMembership({ id: 'm1', agentId: 'a1', userId: 'user-guest', role: 'user', status: 'active' } as never);
    s.bindMembershipChannelUser('a1', 'user-guest', '555');
    expect(s.isKnownChannelUser(OWNER, 'telegram', '555')).toBe(true); // at a2 as well
    expect(s.isKnownChannelUser('user-someone-else', 'telegram', '555')).toBe(false);
  });

  it('a revoked member is a stranger again', () => {
    const s = world();
    s.insertMembership({ id: 'm1', agentId: 'a1', userId: 'user-guest', role: 'user', status: 'active' } as never);
    s.bindMembershipChannelUser('a1', 'user-guest', '555');
    s.revokeMembership('a1', 'user-guest');
    expect(s.isKnownChannelUser(OWNER, 'telegram', '555')).toBe(false);
  });
});
