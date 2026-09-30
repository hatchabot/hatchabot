import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { commandOwnersFor } from '../src/orchestrator/provision.js';
import { allowlistScrubScript } from '../src/orchestrator/members.js';

// OpenClaw made the FIRST sender approved by pairing the command owner when
// commands.ownerAllowFrom was empty — a member, on three live agents
// (promise review, 2026-09-29). Hatchabot now always names the owner.

const OWNER = 'user-o';
const TG = ['7', '0', '0', '2'].join('');   // made up, built at run time

function world() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Condo', slug: 'condo', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
  return store;
}

describe('command owners', () => {
  it('names the owner by their chat id', () => {
    const store = world();
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: OWNER, role: 'owner', channelUserId: TG, status: 'active' } as never);
    expect(commandOwnersFor(store, { id: 'a1', ownerId: OWNER })).toEqual([`telegram:${TG}`]);
  });

  it('with no id known yet, a placeholder that matches nobody — never an empty list', () => {
    expect(commandOwnersFor(world(), { id: 'a1', ownerId: OWNER })).toEqual(['telegram:0']);
  });

  it('a removed member is taken off the owner list too', () => {
    const script = allowlistScrubScript([{ channel: 'telegram', acct: 'condobot', id: '8001', cred: '/home/node/.openclaw/credentials/telegram-condobot-allowFrom.json' }]);
    expect(script).toContain('cfg.commands.ownerAllowFrom');
  });
});
