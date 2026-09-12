import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { clearBusy, markBusy } from '../src/orchestrator/busy.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * Route-level guards around agents that are mid-operation or moved away.
 * These 409s are the HTTP face of the one-poller-per-bot rule: a migrate or
 * adopt holds the busy flag precisely because from the outside the agent
 * looks like an ordinary stopped one.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) {
    const v = this.map.get(ref);
    if (v === undefined) throw new Error('missing');
    return v;
  }
  async delete(ref: string) { this.map.delete(ref); }
}

const OWNER = 'user-owner';
const as = { 'x-hatchabot-owner': OWNER };

async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({
    id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock',
    name: 'box', settings: {}, createdAt: 'now',
  });
  store.insertAIProfile({
    id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key',
    model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now',
  });
  const { runtimeRef } = await provider.provision({
    agentId: 'a1', slug: 'kitchen',
    workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } },
    env: {},
  });
  await provider.start(runtimeRef);
  store.insertAgent({
    id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'PROVISIONING',
    aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true,
    createdAt: 'now', updatedAt: 'now',
  });
  store.setAgentRuntimeRef('a1', runtimeRef);
  store.setAgentState('a1', 'RUNNING');
  const f = Fastify();
  await registerRoutes(f, {
    store,
    secrets: new MemSecrets(),
    providers: new Map([['mock', provider]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
  });
  return { store, provider, f };
}

afterEach(() => clearBusy('a1'));

describe('busy agents answer 409 on lifecycle routes', () => {
  for (const call of [
    { method: 'POST' as const, url: '/v1/agents/a1/stop' },
    { method: 'POST' as const, url: '/v1/agents/a1/start' },
    { method: 'POST' as const, url: '/v1/agents/a1/rebuild' },
    { method: 'POST' as const, url: '/v1/agents/a1/provision' },
    { method: 'DELETE' as const, url: '/v1/agents/a1' },
    { method: 'GET' as const, url: '/v1/agents/a1/backup' },
  ]) {
    it(`${call.method} ${call.url}`, async () => {
      const { f } = await world();
      // What a migrate/adopt/import does for its whole duration. Mid-migrate
      // the source sits STOPPED with no tombstone yet — without this guard a
      // Start here boots the copy whose bot is about to belong elsewhere.
      markBusy('a1');
      const res = await f.inject({ method: call.method, url: call.url, headers: as });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/already running/i);
    });
  }

  it('clears with the flag: the same call succeeds once the operation ends', async () => {
    const { f } = await world();
    markBusy('a1');
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/stop', headers: as })).statusCode).toBe(409);
    clearBusy('a1');
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/stop', headers: as })).statusCode).toBe(200);
  });
});

describe('moved-away agents cannot be resurrected', () => {
  it('refuses to start the stale copy after a migration', async () => {
    const { store, f } = await world();
    store.setAgentState('a1', 'STOPPED');
    store.setAgentMigratedTo('a1', 'Desktop (2026-08-06)');
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/start', headers: as });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/moved to Desktop/);
  });

  it('refuses to EXPORT a moved-away copy — the archive holds the live token', async () => {
    const { store, f } = await world();
    store.setAgentState('a1', 'STOPPED');
    store.setAgentMigratedTo('a1', 'Desktop (2026-08-06)');
    const res = await f.inject({ method: 'GET', url: '/v1/agents/a1/backup', headers: as });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/moved to Desktop/);
  });

  it('refuses to re-MIGRATE a moved-away copy to a third server', async () => {
    const { store, f } = await world();
    store.setAgentState('a1', 'STOPPED');
    store.setAgentMigratedTo('a1', 'Desktop (2026-08-06)');
    store.insertPeer({
      id: 'peer1', ownerId: OWNER, name: 'Laptop', url: 'http://laptop:8080',
      secretRef: 'peer/x', createdAt: 'now',
    });
    const res = await f.inject({
      method: 'POST', url: '/v1/agents/a1/rehost', headers: as, payload: { peerId: 'peer1' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/moved to Desktop/);
  });
});

describe('per-account agent cap', () => {
  it('refuses to create past HATCHABOT_MAX_AGENTS_PER_ACCOUNT with 429', async () => {
    const { f } = await world(); // world() already seeds profile p1 and agent a1
    const prev = process.env.HATCHABOT_MAX_AGENTS_PER_ACCOUNT;
    process.env.HATCHABOT_MAX_AGENTS_PER_ACCOUNT = '1'; // world() already has a1
    try {
      const res = await f.inject({
        method: 'POST', url: '/v1/agents', headers: as,
        payload: { name: 'Second', aiProfileId: 'p1', hostId: 'h1' },
      });
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toMatch(/limit of 1 agents/);
    } finally {
      if (prev === undefined) delete process.env.HATCHABOT_MAX_AGENTS_PER_ACCOUNT;
      else process.env.HATCHABOT_MAX_AGENTS_PER_ACCOUNT = prev;
    }
  });

  it('does NOT count archived agents toward the cap (they hold no bot/container)', async () => {
    const { f, store } = await world();
    const prev = process.env.HATCHABOT_MAX_AGENTS_PER_ACCOUNT;
    process.env.HATCHABOT_MAX_AGENTS_PER_ACCOUNT = '1';
    store.setAgentState('a1', 'ARCHIVED'); // the one seeded agent is now archived
    try {
      const res = await f.inject({
        method: 'POST', url: '/v1/agents', headers: as,
        payload: { name: 'Second', aiProfileId: 'p1', hostId: 'h1' },
      });
      expect(res.statusCode).toBe(202); // created (async) — not 429; archived a1 doesn't consume the slot
    } finally {
      if (prev === undefined) delete process.env.HATCHABOT_MAX_AGENTS_PER_ACCOUNT;
      else process.env.HATCHABOT_MAX_AGENTS_PER_ACCOUNT = prev;
    }
  });
});

describe('live model change (no rebuild)', () => {
  it('applies the model to a RUNNING agent via `models set`, no rebuild', async () => {
    const { f, store, provider } = await world();
    const before = provider.execLog.length;
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/model', headers: as, payload: { model: null } });
    expect(res.statusCode).toBe(200);
    expect(res.json().live).toBe(true);
    // it ran `openclaw models set <provider>/<model>` and no rebuild/provision
    expect(provider.execLog.some((c) => Array.isArray(c) && c[0] === 'models' && c[1] === 'set')).toBe(true);
    expect(store.getAgent('a1')!.appliedModel).toBeTruthy(); // card reflects it now
  });
});

describe('AI source list reports who is on each source', () => {
  it('counts your agents and other accounts\' agents (count only) on sources you own', async () => {
    const { f, store } = await world();
    store.insertAgent({ id: 'x1', ownerId: 'user-other', name: 'Kid', slug: 'kid', state: 'STOPPED', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
    const mine = (await f.inject({ method: 'GET', url: '/v1/ai-profiles', headers: as })).json().find((p: any) => p.id === 'p1');
    expect(mine.inUse).toEqual({ mine: 1, others: 1 });
    // A non-owner viewing a shared source sees only their own count.
    store['db'].prepare('UPDATE ai_profiles SET shared = 1 WHERE id = ?').run('p1');
    const theirs = (await f.inject({ method: 'GET', url: '/v1/ai-profiles', headers: { 'x-hatchabot-owner': 'user-other' } })).json().find((p: any) => p.id === 'p1');
    expect(theirs.inUse).toEqual({ mine: 1, others: undefined });
  });
});

describe('host-owner migrate-agents (retire a source other accounts still use)', () => {
  it('moves other accounts\' agents to a SHARED source, then the old source can be deleted', async () => {
    const { f, store } = await world(); // h1 is owned by OWNER → host owner
    store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Shared token', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', secretRef: 'ai/p2', shared: true, createdAt: 'now' } as any);
    store.insertAgent({ id: 'x1', ownerId: 'user-other', name: 'Kid Advisor', slug: 'kid', state: 'STOPPED', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
    // Refused while in use by another account…
    let del = await f.inject({ method: 'DELETE', url: '/v1/ai-profiles/p1', headers: as });
    expect(del.statusCode).toBe(400); expect(del.json().error).toMatch(/other accounts/);
    // …a non-host-owner can't migrate…
    expect((await f.inject({ method: 'POST', url: '/v1/ai-profiles/p1/migrate-agents', headers: { 'x-hatchabot-owner': 'user-other' }, payload: { toProfileId: 'p2' } })).statusCode).toBe(403);
    // …the target must be shared when other accounts are on it…
    store.insertAIProfile({ id: 'p3', ownerId: OWNER, name: 'Private', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p3', createdAt: 'now' });
    expect((await f.inject({ method: 'POST', url: '/v1/ai-profiles/p1/migrate-agents', headers: as, payload: { toProfileId: 'p3' } })).statusCode).toBe(400);
    // …and the host owner moves everyone (own + other accounts') onto the shared one.
    const mig = await f.inject({ method: 'POST', url: '/v1/ai-profiles/p1/migrate-agents', headers: as, payload: { toProfileId: 'p2', rebuild: false } });
    expect(mig.statusCode).toBe(200);
    expect(mig.json()).toMatchObject({ switched: 2, agents: 2, otherAccounts: 1 });
    expect(store.getAgent('x1')!.aiProfileId).toBe('p2');
    expect(store.getAgent('a1')!.aiProfileId).toBe('p2');
    del = await f.inject({ method: 'DELETE', url: '/v1/ai-profiles/p1', headers: as });
    expect(del.statusCode).toBe(200);
  });
});

describe('audit 2026-09-11 follow-ups', () => {
  it('PATCH cronTriggers stores the flag and sets cron.triggers.enabled live on a running agent', async () => {
    const { f, store, provider } = await world();
    const res = await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: as, payload: { cronTriggers: true } });
    expect(res.statusCode).toBe(200);
    expect(store.getAgent('a1')!.cronTriggers).toBe(true);
    expect(provider.execLog).toContainEqual(['config', 'set', 'cron.triggers.enabled', 'true']);
    await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: as, payload: { cronTriggers: false } });
    expect(provider.execLog).toContainEqual(['config', 'set', 'cron.triggers.enabled', 'false']);
  });

  it('a task can be created on a fractional-minute interval (1.5 = every 90s)', async () => {
    const { f, provider } = await world();
    provider.execResponses.set('cron add', { code: 0, stderr: '', stdout: JSON.stringify({ id: 'j1' }) });
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/crons', headers: as, payload: { name: 'poll', message: 'Inbox poll.', everyMinutes: 1.5 } });
    expect(res.statusCode).toBe(201);
    const add = provider.execLog.find((c) => Array.isArray(c) && c[0] === 'cron' && c[1] === 'add') as string[];
    const every = add[add.indexOf('--every') + 1];
    expect(every).toMatch(/90s|1\.5m|1m30s/); // not the old integer-only 1m or a rejected 0m
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/crons', headers: as, payload: { name: 'p', message: 'm', everyMinutes: 0.1 } })).statusCode).toBe(400);
  });

  it('runs at most HATCHABOT_REBUILD_CONCURRENCY rebuilds at once (default 3)', async () => {
    process.env.HATCHABOT_READY_POLL_MS = '1'; process.env.HATCHABOT_READY_TIMEOUT_MS = '2000';
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    let started = 0, armed = false; // gate only the REBUILD provisions, not the seeding ones
    class GatedProvider extends MockProvider {
      override async provision(spec: any) { if (armed) { started++; await gate; } return super.provision(spec); }
    }
    const provider = new GatedProvider();
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'p1', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    const secrets = new MemSecrets(); await secrets.put('ai/p1', 'k');
    for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) {
      const { runtimeRef } = await provider.provision({ agentId: id, slug: id, workspace: { files: {}, configPatch: { agentId: id, authMode: 'api-key' } as any }, env: {} });
      await provider.start(runtimeRef);
      store.insertAgent({ id, ownerId: OWNER, name: id, slug: id, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
      store.insertChannel({ id: `c-${id}`, agentId: id, kind: 'telegram', accountId: `bot_${id}`, secretRef: `chan/${id}`, deepLink: `https://t.me/bot_${id}`, createdAt: 'now' });
      await secrets.put(`chan/${id}`, '123:tok');
    }
    armed = true;
    const f = Fastify();
    await registerRoutes(f, { store, secrets, providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {}, syncDisplayName: async () => {} } as any });
    for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) expect((await f.inject({ method: 'POST', url: `/v1/agents/${id}/rebuild`, headers: as, payload: {} })).statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 150));
    expect(started).toBe(3); // r4, r5 are queued, not running
    release();
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && ['r1', 'r2', 'r3', 'r4', 'r5'].some((id) => store.getAgent(id)!.state !== 'RUNNING')) await new Promise((r) => setTimeout(r, 25));
    expect(started).toBe(5);
    expect(['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => store.getAgent(id)!.state)).toEqual(Array(5).fill('RUNNING'));
  }, 30000);

  it('a checkpoint turn gets its own long timeout (not the 60s docker default)', async () => {
    const { f, provider } = await world();
    await f.inject({ method: 'POST', url: '/v1/agents/a1/checkpoint', headers: as });
    const i = provider.execLog.findIndex((c) => Array.isArray(c) && c[0] === 'agent' && c[1] === '--agent');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(provider.execOpts.filter(Boolean).some((o) => (o?.timeoutMs ?? 0) >= 180_000)).toBe(true);
  });

  it('adopt-agents with recoverAfter runs a recovery (includeLive) once the rebuild completes', async () => {
    // Self-contained: a rebuild needs a channel row + the bot/AI secrets, which
    // the shared world() doesn't seed (it only ever asserts the 202).
    process.env.HATCHABOT_READY_POLL_MS = '1'; process.env.HATCHABOT_READY_TIMEOUT_MS = '2000';
    const store = new Store(new Database(':memory:')); const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    for (const id of ['p1', 'p2']) store.insertAIProfile({ id, ownerId: OWNER, name: id, vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: `ai/${id}`, createdAt: 'now' });
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } as any }, env: {} });
    await provider.start(runtimeRef);
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
    store.insertChannel({ id: 'c-a1', agentId: 'a1', kind: 'telegram', accountId: 'bot_a1', secretRef: 'chan/a1', deepLink: 'https://t.me/bot_a1', createdAt: 'now' });
    const secrets = new MemSecrets(); await secrets.put('ai/p1', 'k'); await secrets.put('ai/p2', 'k'); await secrets.put('chan/a1', '123:tok');
    const f = Fastify();
    await registerRoutes(f, { store, secrets, providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {}, syncDisplayName: async () => {} } as any });
    provider.execResponses.set('sh', { code: 0, stderr: '', stdout: JSON.stringify({ conversations: 1, messages: 5 }) });
    const res = await f.inject({ method: 'POST', url: '/v1/ai-profiles/p2/adopt-agents', headers: as, payload: { apply: ['a1'], rebuild: true, recoverAfter: true } });
    expect(res.json()).toMatchObject({ switched: 1, rebuilding: 1 });
    const deadline = Date.now() + 12000;
    let turn;
    while (!turn && Date.now() < deadline) {
      turn = provider.execLog.find((c) => c[0] === 'sh' && String(c[1]).includes('openclaw agent') && String(c[1]).includes('--deliver'));
      if (!turn) await new Promise((r) => setTimeout(r, 25));
    }
    expect(store.getAgent('a1')!.state).toBe('RUNNING');
    expect(turn).toBeTruthy();                                   // recovery started after the rebuild, on the new source
    const stage = provider.execLog.find((c) => c[0] === 'sh' && String(c[1]).includes("MODE='recover'"));
    expect(String(stage?.[1])).toContain("INCLUDE_LIVE='1'");   // the pre-switch (current) chat is included
  }, 15000);

  it('planned agents: add / list / remove, owner-scoped', async () => {
    const { f } = await world();
    const add = await f.inject({ method: 'POST', url: '/v1/agent-todos', headers: as, payload: { name: 'Home Cybersecurity', note: 'later' } });
    expect(add.statusCode).toBe(200);
    const id = add.json().todo.id;
    expect((await f.inject({ method: 'GET', url: '/v1/agent-todos', headers: as })).json().todos.map((t: any) => t.name)).toEqual(['Home Cybersecurity']);
    expect((await f.inject({ method: 'GET', url: '/v1/agent-todos', headers: { 'x-hatchabot-owner': 'user-other' } })).json().todos).toEqual([]);
    expect((await f.inject({ method: 'DELETE', url: `/v1/agent-todos/${id}`, headers: { 'x-hatchabot-owner': 'user-other' } })).statusCode).toBe(404);
    expect((await f.inject({ method: 'DELETE', url: `/v1/agent-todos/${id}`, headers: as })).statusCode).toBe(200);
    expect((await f.inject({ method: 'POST', url: '/v1/agent-todos', headers: as, payload: { name: '  ' } })).statusCode).toBe(400);
  });

  it('a live model change does NOT clear a pending source switch (rebuild still flagged)', async () => {
    const { f, store, provider } = await world();
    store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Other', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p2', createdAt: 'now' });
    store.setAgentApplied('a1', 'p1', 'claude-opus-4-8');   // container runs p1
    store.setAgentAIProfile('a1', 'p2');                     // owner switched, declined the rebuild
    const before = provider.execLog.length;
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/model', headers: as, payload: { model: null } });
    expect(res.json()).toMatchObject({ live: false, staged: false, rebuild: true });
    expect(provider.execLog.length).toBe(before);           // nothing exec'd against the old-source container
    expect(store.getAgent('a1')!.appliedProfileId).toBe('p1'); // still honest: the switch is pending
    const list = (await f.inject({ method: 'GET', url: '/v1/agents', headers: as })).json();
    expect(list.find((a: any) => a.id === 'a1').pendingModel).toBeTruthy(); // the 🔄 stays
  });

  it('POST /model on a STOPPED agent stages the model on its volume (staged:true)', async () => {
    const { f, store, provider } = await world();
    store.setAgentState('a1', 'STOPPED');
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/model', headers: as, payload: { model: null } });
    expect(res.json()).toMatchObject({ live: false, staged: true });
    expect(provider.execLog.some((c) => c[0] === 'sh-volume' && String(c[1]).includes('models set'))).toBe(true);
  });

  it('GET /v1/security/posture is read-only (does not record the day\'s baseline)', async () => {
    const { f, store } = await world();
    const res = await f.inject({ method: 'GET', url: '/v1/security/posture', headers: as });
    expect(res.statusCode).toBe(200);
    expect(store.latestPostureSnapshotBefore(OWNER, '9999-12-31')).toBeUndefined();
  });
});

describe('Chat → Memory reports honestly when the AI source cannot run', () => {
  it('returns saved:false (not a false "Saved") when the checkpoint turn fails', async () => {
    const { f, provider } = await world();
    // Simulate an out-of-credits / unreachable source: the agent turn exits non-zero.
    provider.execResponses.set('agent --agent kitchen', { code: 1, stdout: '', stderr: 'credit balance is too low' });
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/checkpoint', headers: as });
    expect(res.statusCode).toBe(200);
    expect(res.json().saved).toBe(false);
    expect(res.json().error).toMatch(/couldn't save/i);
  });

  it('returns saved:true when the checkpoint turn succeeds', async () => {
    const { f } = await world(); // mock exec defaults to code 0
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/checkpoint', headers: as });
    expect(res.json().saved).toBe(true);
  });
});

describe('delete is 404 the second time, not a 500', () => {
  it('answers 404 on a re-delete instead of an illegal DELETED->DELETING', async () => {
    const { f } = await world();
    expect((await f.inject({ method: 'DELETE', url: '/v1/agents/a1', headers: as })).statusCode).toBe(200);
    const again = await f.inject({ method: 'DELETE', url: '/v1/agents/a1', headers: as });
    expect(again.statusCode).toBe(404);
  });
});

describe('POST /v1/agents/preflight', () => {
  it('carries sharedPaths through to the folder check', async () => {
    const { f } = await world();
    // Zod strips unknown keys: before sharedPaths joined the schema, the
    // sender's folder list was silently discarded and the documented
    // missing-folders refusal could never fire over HTTP.
    const res = await f.inject({
      method: 'POST', url: '/v1/agents/preflight', headers: as,
      payload: {
        slug: 'newcomer',
        accountId: 'newbot',
        sharedPaths: ['/definitely/not/a/real/folder'],
      },
    });
    expect(res.statusCode).toBe(200);
    const answer = res.json();
    expect(answer.ok).toBe(false);
    expect(answer.warnings).toContain('missing-shared-paths');
    expect(answer.reasons.join(' ')).toContain('/definitely/not/a/real/folder');
  });
});
