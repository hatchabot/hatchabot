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

describe('the security report names who can reach an agent', () => {
  it('lists members by name, marks an invitee who has not linked yet', async () => {
    const { computePosture } = await import('../src/orchestrator/posture.js');
    const s = world();
    s.insertMembership({ id: 'mo', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active', displayName: 'Chris' } as never);
    s.bindMembershipChannelUser('a1', OWNER, '111');
    s.insertMembership({ id: 'm2', agentId: 'a1', userId: 'user-guest', role: 'user', status: 'active', displayName: 'Maria' } as never);
    s.bindMembershipChannelUser('a1', 'user-guest', '555');
    s.insertMembership({ id: 'm3', agentId: 'a1', userId: 'user-later', role: 'user', status: 'active', displayName: 'Sam' } as never);
    s.insertMembership({ id: 'm4', agentId: 'a1', userId: 'user-gone', role: 'user', status: 'revoked', displayName: 'Ex' } as never);

    const report = computePosture(s, { ownerId: OWNER, isHostOwner: true, authMode: 'password' });
    const a1 = report.agents.find((x) => x.id === 'a1')!;
    const names = (a1.audience ?? []).map((m) => m.name);
    expect(names).toEqual(['Chris', 'Maria', 'Sam']); // owner first, revoked absent
    expect((a1.audience ?? []).find((m) => m.name === 'Sam')!.pending).toBe(true);
    expect((a1.audience ?? []).find((m) => m.name === 'Maria')!.channels).toEqual(['telegram']);
  });
});

describe('a window held open for a named person', () => {
  it('only that @handle or id is claimable; anyone else knocking is not', async () => {
    const { claimFirstContact } = await import('../src/orchestrator/claim.js');
    const s = world();
    s.insertMembership({ id: 'm1', agentId: 'a1', userId: 'user-guest', role: 'user', status: 'active' } as never);

    const requests = [
      { id: '999', code: 'STRANGER', meta: { username: 'randomer' } },
      { id: '555', code: 'MARIA', meta: { username: 'maria_k' } },
    ];
    const provider = {
      execShell: async () => ({ code: 0, stdout: JSON.stringify({ version: 1, requests }), stderr: '' }),
      execShellOnVolume: async () => ({ code: 0, stdout: '', stderr: '' }),
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    } as never;

    const bound = await claimFirstContact(
      { store: s, provider, sleep: async () => {} },
      { agentId: 'a1', runtimeRef: 'ref', accountId: 'bot', forUserId: 'user-guest',
        // A generous window: the poll is answered on its first call, but a
        // loaded test run used to eat a 40 ms budget before that call returned
        // (flaky about one full run in ten, 2026-09-24).
        expect: '@Maria_K', timeoutMs: 5000, pollIntervalMs: 5 },
    );
    // The stranger knocked FIRST and is not bound; Maria is.
    expect(bound).toBe('555');
    expect(s.getMembership('a1', 'user-guest')!.channelUserId).toBe('555');
  });

  it('records who the window is for, and reports it while open', () => {
    const s = world();
    s.openPairingWindow('a1', new Date(Date.now() + 60_000).toISOString(), 'user-guest', { expect: '@Maria_K' });
    expect(s.pairingWindow('a1')!.expect).toBe('maria_k'); // normalized
    expect(s.pairingWindow('a1', new Date(Date.now() + 120_000))).toBeUndefined();
  });
});

describe('adding someone you already know', () => {
  it('lists them, admits them without an invite, and refuses a stranger', async () => {
    const Fastify = (await import('fastify')).default;
    const { registerRoutes } = await import('../src/api/routes.js');
    const { MockProvider } = await import('../src/providers/mockProvider.js');
    const s = world();
    const provider = new MockProvider();
    // Maria already uses a2; a1 has a bot and is running.
    s.insertMembership({ id: 'm1', agentId: 'a2', userId: 'user-maria', role: 'user', status: 'active', displayName: 'Maria' } as never);
    s.bindMembershipChannelUser('a2', 'user-maria', '555');
    s.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'TaxBot', secretRef: 's', deepLink: 'https://t.me/TaxBot', createdAt: 'now' } as never);
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} } as never);
    s.setAgentRuntimeRef('a1', runtimeRef);
    const f = Fastify();
    await registerRoutes(f, {
      store: s, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} } as never,
      providers: new Map([['mock', provider]]),
      channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never,
    } as never);
    const H = { 'x-hatchabot-owner': OWNER };

    const list = await f.inject({ method: 'GET', url: '/v1/agents/a1/known-people', headers: H });
    expect(list.json()).toEqual([{ userId: 'user-maria', name: 'Maria' }]);

    const add = await f.inject({ method: 'POST', url: '/v1/agents/a1/members/known', headers: H, payload: { userId: 'user-maria' } });
    expect(add.statusCode).toBe(200);
    expect(s.getMembership('a1', 'user-maria')!.channelUserId).toBe('555'); // admitted, no pairing
    // …and she is no longer offered, being a member now.
    expect((await f.inject({ method: 'GET', url: '/v1/agents/a1/known-people', headers: H })).json()).toEqual([]);

    const nobody = await f.inject({ method: 'POST', url: '/v1/agents/a1/members/known', headers: H, payload: { userId: 'user-nobody' } });
    expect(nobody.statusCode).toBe(404);
  });
});

describe('the door rests shut', () => {
  it('a claim window opens it to pairing and closes it again', async () => {
    const { claimFirstContact } = await import('../src/orchestrator/claim.js');
    const s = world();
    s.insertMembership({ id: 'm1', agentId: 'a1', userId: 'user-guest', role: 'user', status: 'active' } as never);
    // Somebody is already allowed, so the door has somewhere to rest.
    s.insertMembership({ id: 'm0', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active' } as never);
    s.bindMembershipChannelUser('a1', OWNER, '111');

    const writes: string[] = [];
    let admitted: string[] = [];
    let config = { channels: { telegram: { accounts: { bot: { dmPolicy: 'allowlist' } } } } };
    const provider = {
      execShell: async () => ({ code: 0, stdout: JSON.stringify({ version: 1, requests: [{ id: '555', code: 'C1', meta: {} }] }), stderr: '' }),
      execShellOnVolume: async (_ref: string, script: string) => {
        const m = /"policy":"(allowlist|pairing)"/.exec(script);
        if (m) {
          writes.push(m[1]!);
          config.channels.telegram.accounts.bot.dmPolicy = m[1]!;
          admitted = JSON.parse(/"admit":(\[[^\]]*\])/.exec(script)?.[1] ?? '[]');
          return { code: 0, stdout: 'set', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    } as never;

    await claimFirstContact(
      { store: s, provider, sleep: async () => {} },
      { agentId: 'a1', runtimeRef: 'ref', accountId: 'bot', forUserId: 'user-guest', timeoutMs: 40, pollIntervalMs: 5 },
    );
    expect(writes[0]).toBe('pairing');                       // opened for them
    expect(writes[writes.length - 1]).toBe('allowlist');     // and shut behind them
    // …carrying the list it is about to enforce. An allowlist with nobody in
    // it admits nobody, including the owner (a Mac, 2026-09-21).
    expect(admitted).toContain('111');
    expect(s.pairingWindow('a1')).toBeUndefined();
  });

  it('stays in pairing when the agent is open to anyone', async () => {
    const { claimFirstContact } = await import('../src/orchestrator/claim.js');
    const s = world();
    s.setAllowKnocks('a1', true);
    s.insertMembership({ id: 'm0', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active' } as never);
    s.bindMembershipChannelUser('a1', OWNER, '111');
    const writes: string[] = [];
    const provider = {
      execShell: async () => ({ code: 0, stdout: JSON.stringify({ version: 1, requests: [] }), stderr: '' }),
      execShellOnVolume: async (_ref: string, script: string) => {
        const m = /"policy":"(allowlist|pairing)"/.exec(script);
        if (m) writes.push(m[1]!);
        return { code: 0, stdout: 'set', stderr: '' };
      },
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    } as never;
    await claimFirstContact(
      { store: s, provider, sleep: async () => {} },
      { agentId: 'a1', runtimeRef: 'ref', accountId: 'bot', forUserId: OWNER, timeoutMs: 20, pollIntervalMs: 5 },
    );
    expect(writes).toEqual(['pairing']); // opened, never shut
  });
});

describe('reopening the door after a window lapses', () => {
  it('refuses for a linked member, opens a fresh window for one who never messaged', async () => {
    const Fastify = (await import('fastify')).default;
    const { registerRoutes } = await import('../src/api/routes.js');
    const { MockProvider } = await import('../src/providers/mockProvider.js');
    const s = world();
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} } as never);
    s.setAgentRuntimeRef('a1', runtimeRef);
    s.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'TaxBot', secretRef: 's', deepLink: 'https://t.me/TaxBot', createdAt: 'now' } as never);
    s.insertMembership({ id: 'm1', agentId: 'a1', userId: 'user-late', role: 'user', status: 'active', displayName: 'Maria' } as never);
    s.insertMembership({ id: 'm2', agentId: 'a1', userId: 'user-here', role: 'user', status: 'active', displayName: 'Sam' } as never);
    s.bindMembershipChannelUser('a1', 'user-here', '555');
    const f = Fastify();
    await registerRoutes(f, {
      store: s, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} } as never,
      providers: new Map([['mock', provider]]),
      channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never,
    } as never);
    const H = { 'x-hatchabot-owner': OWNER };

    const already = await f.inject({ method: 'POST', url: '/v1/agents/a1/members/user-here/reopen', headers: H });
    expect(already.statusCode).toBe(409);

    const again = await f.inject({ method: 'POST', url: '/v1/agents/a1/members/user-late/reopen', headers: H });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ reopened: true, minutes: 30 });
    expect(s.pairingWindowOpen('a1')).toBe(true); // the door is held for them

    const notMine = await f.inject({ method: 'POST', url: '/v1/agents/a1/members/user-late/reopen', headers: { 'x-hatchabot-owner': 'someone-else' } });
    expect(notMine.statusCode).toBe(404);
  });
});

describe('the first person into a fresh agent', () => {
  it('is shown, not hidden: an agent with an empty allowlist must show its knocks', async () => {
    const Fastify = (await import('fastify')).default;
    const { registerRoutes } = await import('../src/api/routes.js');
    const { MockProvider } = await import('../src/providers/mockProvider.js');
    const s = world();
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} } as never);
    s.setAgentRuntimeRef('a1', runtimeRef);
    s.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'TaxBot', secretRef: 's', deepLink: 'https://t.me/TaxBot', createdAt: 'now' } as never);
    // Brand new: an owner seat with no Telegram id bound, so nobody can reach it.
    s.insertMembership({ id: 'm0', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active' } as never);
    expect(s.listAllowedChannelUserIds('a1')).toEqual([]);
    provider.execShell = (async () => ({
      code: 0, stdout: JSON.stringify({ version: 1, requests: [{ id: '4242', code: 'FIRST', meta: { firstName: 'Chris' } }] }), stderr: '',
    })) as never;

    const f = Fastify();
    await registerRoutes(f, {
      store: s, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} } as never,
      providers: new Map([['mock', provider]]),
      channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never,
    } as never);
    const pending = await f.inject({ method: 'GET', url: '/v1/pending', headers: { 'x-hatchabot-owner': OWNER } });
    expect(pending.json()).toHaveLength(1); // the owner knocking at their own new agent

    // Once somebody is on the list, a different stranger is hidden again.
    s.bindMembershipChannelUser('a1', OWNER, '4242');
    provider.execShell = (async () => ({
      code: 0, stdout: JSON.stringify({ version: 1, requests: [{ id: '9999', code: 'LATER', meta: {} }] }), stderr: '',
    })) as never;
    const after = await f.inject({ method: 'GET', url: '/v1/pending', headers: { 'x-hatchabot-owner': OWNER } });
    expect(after.json()).toEqual([]);
  });
});
