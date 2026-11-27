import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { TelegramPoolProvisioner } from '../src/channels/telegramPool.js';
import { CompositeTelegramProvisioner } from '../src/channels/composite.js';
import { TelegramManualProvisioner } from '../src/channels/telegramManual.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { clearBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import { archiveAgent } from '../src/orchestrator/lifecycle/archive.js';
import { newBootForTests } from '../src/orchestrator/lifecycle/operations.js';
import { resumeOperations } from '../src/orchestrator/lifecycle/operationsResume.js';
import { runProvisionSteps } from '../src/orchestrator/lifecycle/provision.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * Telegram's spare bots while Telegram is slow to answer: what a bot is
 * called, and what its chats are told, must come out in the order the bot
 * changed hands (deep audit 2026-11-23). A real pool on an in-memory
 * database; Telegram is a fake that keeps each bot's display name and every
 * message a bot sends, and can hold one call until a test lets it go.
 * Every token here is made up and shaped like none.
 */

const OWNER = 'user-owner';
const IDLE = TelegramPoolProvisioner.IDLE_NAME;
afterEach(() => { vi.restoreAllMocks(); });

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error(`missing ${r}`); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const gate = () => {
  let open!: () => void;
  let entered!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  const reached = new Promise<void>((r) => { entered = r; });
  return { open, entered, opened, reached };
};

/** A moment for whatever is not held to run its course. */
const aMoment = () => new Promise((r) => setTimeout(r, 30));

function world(poolOpts: { goodbyeWaitMs?: number } = {}) {
  const db = new Database(':memory:');
  const store = new Store(db); // memberships, and the pool's table
  const secrets = new MemSecrets();
  /** Each bot's display name, by token, as Telegram holds it. */
  const names = new Map<string, string>();
  /** Each bot's @handle, by token, for a token pasted by hand. */
  const users = new Map<string, string>();
  /** Every message a bot sent: [token, chat, text]. */
  const sent: Array<[string, string, string]> = [];
  /** One call held: the next `method` for `token` (to `chat`, when one is named) waits for the gate. */
  const holds: Array<{ method: string; token: string; chat?: string; g: ReturnType<typeof gate> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const m = /\/bot([^/]+)\/(\w+)/.exec(String(input));
    const token = m?.[1] ?? '';
    const method = m?.[2] ?? '';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const held = holds.findIndex((h) => h.method === method && h.token === token && (h.chat === undefined || h.chat === String(body.chat_id)));
    if (held >= 0) {
      const [h] = holds.splice(held, 1);
      h!.g.entered();
      await h!.g.opened;
    }
    let result: unknown = true;
    if (method === 'getMe') result = { first_name: names.get(token) ?? 'Fresh Bot', ...(users.has(token) ? { username: users.get(token) } : {}) };
    if (method === 'getUpdates') result = [];
    if (method === 'setMyName') names.set(token, String(body.name));
    if (method === 'sendMessage') sent.push([token, String(body.chat_id), String(body.text)]);
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const pool = new TelegramPoolProvisioner(db, secrets, { fetchImpl, renameBackoffMs: [], sleep: async () => {}, ...poolOpts });
  const hold = (method: string, token: string, chat?: string) => { const g = gate(); holds.push({ method, token, chat, g }); return g; };
  const agent = (id: string, name: string) => {
    store.insertAgent({
      id, ownerId: OWNER, name, slug: id, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: `mock://${id}`,
      persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now',
    } as never);
  };
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' });
  /** The real routes over this pool, as the app calls them. */
  const routes = async () => {
    const f = Fastify();
    const channel = new CompositeTelegramProvisioner(pool, new TelegramManualProvisioner(secrets));
    await registerRoutes(f, { store, secrets: secrets as never, providers: new Map([['mock', new MockProvider()]]), channel, oauthFetch: fetchImpl } as never);
    const inject = (method: string, url: string, payload?: unknown) =>
      f.inject({ method: method as never, url, headers: { 'x-hatchabot-owner': OWNER }, payload: payload as never });
    return { f, inject, channel };
  };
  return { db, store, secrets, pool, names, users, sent, hold, agent, routes, fetchImpl };
}

describe('a free bot\'s idle name queued while an agent takes it (HB-1035)', () => {
  /** A free bot still called after the agent it last served, its idle name due now. */
  const freeBotDueIdle = async () => {
    const w = world();
    await w.pool.addToPool('mealplannerbot', 'tok-meal', OWNER);
    w.names.set('tok-meal', 'Meal Planner');
    w.db.prepare(`UPDATE telegram_pool SET desired_name = ?, rename_after = ? WHERE username = ?`)
      .run(IDLE, new Date(Date.now() - 1000).toISOString(), 'mealplannerbot');
    return w;
  };

  it('the sweep waiting on Telegram\'s getMe does not rename the bot once an agent has taken it', async () => {
    const w = await freeBotDueIdle();
    const g = w.hold('getMe', 'tok-meal');
    const sweep = w.pool.retryPendingNames();
    await g.reached;
    const lease = w.pool.provision({ agentId: 'a2', agentName: 'Budget Tracker', slug: 'budget', ownerId: OWNER });
    await aMoment();
    g.open();
    await Promise.all([sweep, lease]);
    expect(w.names.get('tok-meal')).toBe('Budget Tracker');
    expect(w.pool.pendingName('mealplannerbot')).toBeUndefined();
  });

  it('a lease while the sweep\'s rename is on its way names the bot after it, not before', async () => {
    const w = await freeBotDueIdle();
    const g = w.hold('setMyName', 'tok-meal');
    const sweep = w.pool.retryPendingNames();
    await g.reached;
    const lease = w.pool.provision({ agentId: 'a2', agentName: 'Budget Tracker', slug: 'budget', ownerId: OWNER });
    await aMoment();
    g.open();
    await Promise.all([sweep, lease]);
    // The idle name landed first; the lease's came after it.
    expect(w.names.get('tok-meal')).toBe('Budget Tracker');
    expect(w.pool.pendingName('mealplannerbot')).toBeUndefined();
  });
});

describe('a farewell still going out when another agent takes the bot (HB-1048)', () => {
  /** What one chat was sent, in order. */
  const toChat = (w: ReturnType<typeof world>, chat: string) => w.sent.filter(([, c]) => c === chat).map(([, , text]) => text);

  it('a leased bot is not offered again until its farewell is out, so the new agent\'s notice comes after it', async () => {
    const w = world();
    w.agent('a1', 'Meal Planner');
    w.agent('a2', 'Budget Tracker');
    await w.pool.addToPool('mealplannerbot', 'tok-meal', OWNER);
    expect((await w.pool.provision({ agentId: 'a1', agentName: 'Meal Planner', slug: 'meal', ownerId: OWNER })).accountId).toBe('mealplannerbot');
    w.store.insertMembership({ id: 'm1', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active', channelUserId: '9001' });
    const g = w.hold('sendMessage', 'tok-meal');
    const release = w.pool.release('mealplannerbot', { reason: 'archived', agentId: 'a1' });
    await g.reached;
    // Another agent asks for a spare while the farewell waits on Telegram:
    // it waits for the farewell (HB-1266), and is not leased the bot before it.
    const during = w.pool.provision({ agentId: 'a2', agentName: 'Budget Tracker', slug: 'budget', ownerId: OWNER });
    await aMoment();
    expect(w.pool.list()).toEqual([expect.objectContaining({ username: 'mealplannerbot', leasedTo: undefined })]);
    g.open();
    await release;
    // Once it is out, the bot is the waiting agent's, whose notice comes last.
    expect((await during).accountId).toBe('mealplannerbot');
    const texts = toChat(w, '9001');
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatch(/— archived —/);
    expect(texts[1]).toMatch(/this bot is now "Budget Tracker"/);
  });

  it('a bot parked a moment before its release (a pasted one) is held for its farewell too', async () => {
    const w = world();
    w.agent('a1', 'Meal Planner');
    w.agent('a2', 'Budget Tracker');
    // Delete parks a pasted bot in the pool just before it releases it.
    await w.pool.addToPool('pastedbot', 'tok-pasted', OWNER);
    w.store.insertMembership({ id: 'm1', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active', channelUserId: '9002' });
    const g = w.hold('sendMessage', 'tok-pasted');
    const release = w.pool.release('pastedbot', { reason: 'deleted', agentId: 'a1' });
    await g.reached;
    const during = w.pool.provision({ agentId: 'a2', agentName: 'Budget Tracker', slug: 'budget', ownerId: OWNER });
    await aMoment();
    expect(w.pool.list()).toEqual([expect.objectContaining({ username: 'pastedbot', leasedTo: undefined })]);
    g.open();
    await release;
    expect((await during).accountId).toBe('pastedbot');
    expect(toChat(w, '9002')).toEqual([expect.stringMatching(/— end of this agent —/), expect.stringMatching(/this bot is now "Budget Tracker"/)]);
  });
});

describe('a spare asked for while its farewell goes out (HB-1266)', () => {
  /** A spare leased to a1, released with a farewell held on Telegram. */
  const sayingGoodbye = async (opts: { goodbyeWaitMs?: number } = {}) => {
    const w = world(opts);
    w.agent('a1', 'Meal Planner');
    w.agent('a2', 'Budget Tracker');
    await w.pool.addToPool('mealplannerbot', 'tok-meal', OWNER);
    await w.pool.provision({ agentId: 'a1', agentName: 'Meal Planner', slug: 'meal', ownerId: OWNER });
    w.store.insertMembership({ id: 'm1', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active', channelUserId: '9001' });
    const g = w.hold('sendMessage', 'tok-meal');
    const release = w.pool.release('mealplannerbot', { reason: 'deleted', agentId: 'a1' });
    await g.reached;
    return { w, g, release };
  };

  it('is counted as a spare, and an attach then waits for it rather than ask for a token', async () => {
    const { w, g, release } = await sayingGoodbye();
    expect(w.pool.availableCount(OWNER)).toBe(1);
    w.store.setAgentState('a2', 'STOPPED');
    w.store.setAgentWebOnly('a2', true);
    w.store.insertMembership({ id: 'm2', agentId: 'a2', userId: OWNER, role: 'owner', status: 'active' });
    const { f, inject } = await w.routes();
    try {
      const attach = Promise.resolve(inject('POST', '/v1/agents/a2/telegram', {}));
      await aMoment();
      expect(w.store.getChannelForAgent('a2')).toBeUndefined();
      g.open();
      await release;
      const r = await attach;
      expect(r.statusCode, r.body).toBe(202);
      expect(r.json()).toMatchObject({ username: 'mealplannerbot' });
      expect(w.store.getChannelForAgent('a2')?.accountId).toBe('mealplannerbot');
      // The farewell went out before the new agent's notice.
      expect(w.sent.filter(([, c]) => c === '9001').map(([, , t]) => t)).toEqual([expect.stringMatching(/— end of this agent —/), expect.stringMatching(/this bot is now "Budget Tracker"/)]);
    } finally { await f.close(); }
  });

  it('waits for the row of the agent it left to go too: an attach during a detach gets the bot, not "already belongs to"', async () => {
    const { w, g, release } = await sayingGoodbye();
    // The agent it left still has its row, which the detach removes once the release is done.
    w.store.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'mealplannerbot', secretRef: 'telegram/bot/mealplannerbot', deepLink: 'https://t.me/mealplannerbot', createdAt: 'now' });
    expect(w.pool.availableCount(OWNER)).toBe(1);
    w.store.setAgentState('a2', 'STOPPED');
    w.store.setAgentWebOnly('a2', true);
    w.store.insertMembership({ id: 'm2', agentId: 'a2', userId: OWNER, role: 'owner', status: 'active' });
    const { f, inject } = await w.routes();
    try {
      const attach = Promise.resolve(inject('POST', '/v1/agents/a2/telegram', {}));
      g.open();
      await release;
      await aMoment();
      expect(w.pool.list()[0]?.leasedTo).toBeUndefined();
      w.store.deleteChannelForAgent('a1');
      const r = await attach;
      expect(r.statusCode, r.body).toBe(202);
      expect(r.json()).toMatchObject({ username: 'mealplannerbot' });
    } finally { await f.close(); }
  });

  it('a bot whose row its caller never removed is waited for only as long as a lease waits, then is that agent\'s (HB-1263 review, round 3)', async () => {
    const w = world({ goodbyeWaitMs: 200 });
    w.agent('a1', 'Meal Planner');
    w.agent('a2', 'Budget Tracker');
    await w.pool.addToPool('mealplannerbot', 'tok-meal', OWNER);
    await w.pool.provision({ agentId: 'a1', agentName: 'Meal Planner', slug: 'meal', ownerId: OWNER });
    w.store.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'mealplannerbot', secretRef: 'telegram/bot/mealplannerbot', deepLink: 'https://t.me/mealplannerbot', createdAt: 'now' });
    // Let go; its caller then failed before it removed the row.
    await w.pool.release('mealplannerbot', { reason: 'swapped', agentId: 'a1' });
    expect(w.pool.availableCount(OWNER)).toBe(1);
    await new Promise((r) => setTimeout(r, 250));
    expect(w.pool.availableCount(OWNER)).toBe(0);
    const started = Date.now();
    const lease = await w.pool.provision({ agentId: 'a2', agentName: 'Budget Tracker', slug: 'budget', ownerId: OWNER })
      .then((c) => c.accountId, (err: Error) => err.name);
    expect(lease).toBe('PoolExhaustedError');
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('waits no longer than its bound: a farewell that does not end leaves the pool empty for that lease', async () => {
    const { w, g, release } = await sayingGoodbye({ goodbyeWaitMs: 40 });
    const during = await w.pool.provision({ agentId: 'a2', agentName: 'Budget Tracker', slug: 'budget', ownerId: OWNER })
      .then((c) => c.accountId, (err: Error) => err.name);
    expect(during).toBe('PoolExhaustedError');
    expect(w.pool.list()).toEqual([expect.objectContaining({ username: 'mealplannerbot', leasedTo: undefined })]);
    g.open();
    await release;
  });

  it('a spare added, given back or let go while it waits is taken then, not after the farewell (HB-1266 review)', async () => {
    for (const how of ['added', 'given back', 'let go'] as const) {
      const { w, g, release } = await sayingGoodbye({ goodbyeWaitMs: 1_000 });
      if (how !== 'added') {
        w.agent('a3', 'Garden Log');
        await w.pool.addToPool('gardenlogbot', 'tok-garden', OWNER);
        await w.pool.provision({ agentId: 'a3', agentName: 'Garden Log', slug: 'garden', ownerId: OWNER });
      }
      const started = Date.now();
      const lease = w.pool.provision({ agentId: 'a2', agentName: 'Budget Tracker', slug: 'budget', ownerId: OWNER })
        .then((c) => c.accountId, (err: Error) => err.name);
      await aMoment();
      if (how === 'added') await w.pool.addToPool('gardenlogbot', 'tok-garden', OWNER);
      else if (how === 'given back') w.pool.returnUnused('gardenlogbot', 'a3');
      else await w.pool.release('gardenlogbot', { reason: 'swapped', agentId: 'a3' });
      expect(await lease, how).toBe('gardenlogbot');
      expect(Date.now() - started, how).toBeLessThan(800);
      g.open();
      await release;
    }
  });

  it('a spare that came in unannounced is found by the look at the end of the wait (HB-1266 review)', async () => {
    const { w, g, release } = await sayingGoodbye({ goodbyeWaitMs: 60 });
    const lease = w.pool.provision({ agentId: 'a2', agentName: 'Budget Tracker', slug: 'budget', ownerId: OWNER })
      .then((c) => c.accountId, (err: Error) => err.name);
    await w.secrets.put('telegram/bot/gardenlogbot', 'tok-garden');
    w.db.prepare(`INSERT INTO telegram_pool (username, secret_ref, owner_id) VALUES ('gardenlogbot', 'telegram/bot/gardenlogbot', ?)`).run(OWNER);
    expect(await lease).toBe('gardenlogbot');
    g.open();
    await release;
  });

  it('a bot it may not have (Change bot\'s own) is not waited for', async () => {
    const { w, g, release } = await sayingGoodbye();
    const started = Date.now();
    const during = await w.pool.provision({ agentId: 'a2', agentName: 'Budget Tracker', slug: 'budget', ownerId: OWNER, exclude: ['mealplannerbot'] })
      .then((c) => c.accountId, (err: Error) => err.name);
    expect(during).toBe('PoolExhaustedError');
    expect(Date.now() - started).toBeLessThan(5_000);
    g.open();
    await release;
  });
});

describe('two releases of one bot at once (HB-1265)', () => {
  it('the first to finish does not free the bot while the other\'s farewell is still out, and the idle name never lands on a lease', async () => {
    const w = world();
    w.agent('a1', 'Meal Planner');
    w.agent('a2', 'Budget Tracker');
    w.agent('a3', 'Garden Log');
    await w.pool.addToPool('mealplannerbot', 'tok-meal', OWNER);
    await w.pool.provision({ agentId: 'a1', agentName: 'Meal Planner', slug: 'meal', ownerId: OWNER });
    // Two agents' rows name the one bot, each with people of its own.
    w.store.insertMembership({ id: 'm1', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active', channelUserId: '9001' });
    w.store.insertMembership({ id: 'm2', agentId: 'a2', userId: 'user-two', role: 'owner', status: 'active', channelUserId: '9002' });
    const g = w.hold('sendMessage', 'tok-meal');
    const first = w.pool.release('mealplannerbot', { reason: 'deleted', agentId: 'a1' });
    await g.reached;
    // The second release's farewell goes out at once and ends first.
    await w.pool.release('mealplannerbot', { reason: 'deleted', agentId: 'a2' });
    // The first farewell is still out: the bot is not leased yet; a lease waits.
    const during = w.pool.provision({ agentId: 'a3', agentName: 'Garden Log', slug: 'garden', ownerId: OWNER });
    await aMoment();
    expect(w.pool.list()).toEqual([expect.objectContaining({ username: 'mealplannerbot', leasedTo: undefined })]);
    g.open();
    await first;
    // Leased once both are out, and named for its agent: no idle name is queued over the lease.
    expect((await during).accountId).toBe('mealplannerbot');
    expect(w.pool.pendingName('mealplannerbot')).toBeUndefined();
    expect(w.names.get('tok-meal')).toBe('Garden Log');
    // Both farewells went out before the new agent's notice.
    expect(w.sent.map(([, , t]) => /— end of this agent —/.test(t) ? 'farewell' : /this bot is now/.test(t) ? 'notice' : t)).toEqual(['farewell', 'farewell', 'notice']);
  });
});

describe('a restart while a farewell goes out (HB-1048 review)', () => {
  /** The next process: a new pool over the same database, nothing in memory, Telegram answering. */
  const restarted = (w: ReturnType<typeof world>) => {
    newBootForTests();
    const answer = (async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const pool = new TelegramPoolProvisioner(w.db, w.secrets, { fetchImpl: answer, renameBackoffMs: [], sleep: async () => {} });
    return { pool, channel: new CompositeTelegramProvisioner(pool, new TelegramManualProvisioner(w.secrets)) };
  };

  for (const kind of ['pool', 'pasted'] as const) {
    it(`an archive cut off in its farewell is finished, not undone (a ${kind} bot)`, async () => {
      const w = world();
      w.agent('a1', 'Meal Planner');
      w.store.insertMembership({ id: 'm1', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active', channelUserId: '9001' });
      const [bot, token] = kind === 'pool' ? ['mealplannerbot', 'tok-meal'] : ['ownbot', 'tok-own'];
      if (kind === 'pool') {
        await w.pool.addToPool(bot, token, OWNER);
        await w.pool.provision({ agentId: 'a1', agentName: 'Meal Planner', slug: 'meal', ownerId: OWNER });
      } else {
        await w.secrets.put(`telegram/bot/${bot}`, token);
      }
      w.store.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: bot, secretRef: `telegram/bot/${bot}`, deepLink: `https://t.me/${bot}`, createdAt: 'now' });
      // A runtime that runs, so an archive undone would start it again.
      const provider = new MockProvider();
      const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} });
      await provider.start(runtimeRef);
      w.store.setAgentRuntimeRef('a1', runtimeRef);
      const channel = new CompositeTelegramProvisioner(w.pool, new TelegramManualProvisioner(w.secrets));
      const g = w.hold('sendMessage', token);
      void archiveAgent({ store: w.store, secrets: w.secrets, provider, channel, log: () => {} }, 'a1').catch(() => {});
      await g.reached;
      // The process ends here, the farewell on its way. The next one finishes what it began.
      clearBusy('a1');
      const next = restarted(w);
      await resumeOperations({ store: w.store, secrets: w.secrets, channel: next.channel, providerForHost: () => provider, sleep: async () => {} });
      expect(w.store.listOperations(['a1'])[0]).toMatchObject({ kind: 'archive', status: 'succeeded' });
      expect(w.store.getAgent('a1')?.state).toBe('ARCHIVED');
      expect(w.store.getChannelForAgent('a1')).toBeUndefined();
      // Free in the pool, for the next agent.
      expect(next.pool.list()).toEqual([expect.objectContaining({ username: bot, leasedTo: undefined })]);
      expect(next.pool.availableCount(OWNER)).toBe(1);
    });
  }

  it('a bot whose delete was cut off in its farewell is free after the restart, not held for the deleted agent', async () => {
    const w = world();
    w.agent('a1', 'Meal Planner');
    await w.pool.addToPool('mealplannerbot', 'tok-meal', OWNER);
    await w.pool.provision({ agentId: 'a1', agentName: 'Meal Planner', slug: 'meal', ownerId: OWNER });
    w.store.insertMembership({ id: 'm1', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active', channelUserId: '9001' });
    const g = w.hold('sendMessage', 'tok-meal');
    void w.pool.release('mealplannerbot', { reason: 'deleted', agentId: 'a1' });
    await g.reached;
    const next = restarted(w);
    expect(next.pool.list()).toEqual([expect.objectContaining({ username: 'mealplannerbot', leasedTo: undefined })]);
    expect((await next.pool.provision({ agentId: 'a2', agentName: 'Budget Tracker', slug: 'budget', ownerId: OWNER })).accountId).toBe('mealplannerbot');
  });
});

describe('a release run again after a restart (HB-1267)', () => {
  /** What each chat was sent as a farewell, by chat. */
  const farewells = (w: ReturnType<typeof world>) => {
    const out: Record<string, number> = {};
    for (const [, chat, text] of w.sent) if (/^— (end of this agent|archived|moved off Telegram) —/.test(text)) out[chat] = (out[chat] ?? 0) + 1;
    return out;
  };
  /** The next process's pool over the same database, Telegram as the first one had it. */
  const nextPool = (w: ReturnType<typeof world>) => {
    newBootForTests();
    return new TelegramPoolProvisioner(w.db, w.secrets, { fetchImpl: w.fetchImpl, renameBackoffMs: [], sleep: async () => {} });
  };
  /** A spare leased to a1, whose two people are on Telegram. */
  const leased = async () => {
    const w = world();
    w.agent('a1', 'Meal Planner');
    await w.pool.addToPool('mealplannerbot', 'tok-meal', OWNER);
    await w.pool.provision({ agentId: 'a1', agentName: 'Meal Planner', slug: 'meal', ownerId: OWNER });
    w.store.insertMembership({ id: 'm1', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active', channelUserId: '9001' });
    w.store.insertMembership({ id: 'm2', agentId: 'a1', userId: 'user-two', role: 'user', status: 'active', channelUserId: '9002' });
    return w;
  };

  it('Delete pressed again after a restart cut its farewell off tells only those it had not told', async () => {
    const w = await leased();
    w.store.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'mealplannerbot', secretRef: 'telegram/bot/mealplannerbot', deepLink: 'https://t.me/mealplannerbot', createdAt: 'now' });
    const first = await w.routes();
    // The first is told; the process ends while the second's goodbye is on its way.
    const g = w.hold('sendMessage', 'tok-meal', '9002');
    void Promise.resolve(first.inject('DELETE', '/v1/agents/a1')).catch(() => {});
    await g.reached;
    expect(farewells(w)).toEqual({ '9001': 1 });
    expect(w.store.getChannelForAgent('a1')?.accountId).toBe('mealplannerbot');
    // The next process; the owner presses Delete again.
    const pool = nextPool(w);
    const f = Fastify();
    await registerRoutes(f, { store: new Store(w.db), secrets: w.secrets as never, providers: new Map([['mock', new MockProvider()]]), channel: new CompositeTelegramProvisioner(pool, new TelegramManualProvisioner(w.secrets)), oauthFetch: w.fetchImpl } as never);
    try {
      const again = await f.inject({ method: 'DELETE', url: '/v1/agents/a1', headers: { 'x-hatchabot-owner': OWNER } });
      expect(again.statusCode, again.body).toBe(200);
      expect(w.store.getAgent('a1')?.state).toBe('DELETED');
      expect(farewells(w)).toEqual({ '9001': 1, '9002': 1 });
      expect(pool.list()).toEqual([expect.objectContaining({ username: 'mealplannerbot', leasedTo: undefined })]);
    } finally { await f.close(); }
  });

  it('a release run again once its farewell was all out tells nobody again', async () => {
    const w = await leased();
    await w.pool.release('mealplannerbot', { reason: 'deleted', agentId: 'a1' });
    expect(farewells(w)).toEqual({ '9001': 1, '9002': 1 });
    await nextPool(w).release('mealplannerbot', { reason: 'deleted', agentId: 'a1' });
    expect(farewells(w)).toEqual({ '9001': 1, '9002': 1 });
  });

  it('another goodbye is its own: the same agent let go for another reason, or leased the bot again first, says goodbye again', async () => {
    const w = await leased();
    await w.pool.release('mealplannerbot', { reason: 'detached', agentId: 'a1' });
    // The detach was cut off before its row went; the agent is then deleted.
    await nextPool(w).release('mealplannerbot', { reason: 'deleted', agentId: 'a1' });
    expect(w.sent.filter(([, c]) => c === '9001').map(([, , t]) => t.split('\n')[0])).toEqual(['— moved off Telegram —', '— end of this agent —']);
    // Leased again by the same agent (a restore), then let go again: a farewell of its own.
    const w2 = await leased();
    await w2.pool.release('mealplannerbot', { reason: 'archived', agentId: 'a1' });
    await w2.pool.provision({ agentId: 'a1', agentName: 'Meal Planner', slug: 'meal', ownerId: OWNER });
    await w2.pool.release('mealplannerbot', { reason: 'archived', agentId: 'a1' });
    expect(farewells(w2)).toEqual({ '9001': 2, '9002': 2 });
  });
});

describe('a bot a restart left free in the pool while its agent\'s row still names it (HB-1263 review)', () => {
  /**
   * A detach cut off by a restart in its farewell: the pool let the bot go,
   * the agent's channel row still names it. Another agent and the Change
   * bot of a third then ran over the next process's pool.
   */
  const cutOff = async () => {
    const w = world();
    w.agent('a1', 'Meal Planner');
    w.agent('a2', 'Budget Tracker');
    w.agent('a3', 'Garden Log');
    await w.pool.addToPool('mealplannerbot', 'tok-meal', OWNER);
    await w.pool.provision({ agentId: 'a1', agentName: 'Meal Planner', slug: 'meal', ownerId: OWNER });
    w.store.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'mealplannerbot', secretRef: 'telegram/bot/mealplannerbot', deepLink: 'https://t.me/mealplannerbot', createdAt: 'now' });
    w.store.insertMembership({ id: 'm1', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active', channelUserId: '9001' });
    // The third agent on a spare of its own, with someone on it.
    await w.pool.addToPool('gardenlogbot', 'tok-garden', OWNER);
    await w.pool.provision({ agentId: 'a3', agentName: 'Garden Log', slug: 'garden', ownerId: OWNER });
    w.store.insertChannel({ id: 'c3', agentId: 'a3', kind: 'telegram', accountId: 'gardenlogbot', secretRef: 'telegram/bot/gardenlogbot', deepLink: 'https://t.me/gardenlogbot', createdAt: 'now' });
    w.store.insertMembership({ id: 'm3', agentId: 'a3', userId: OWNER, role: 'owner', status: 'active', channelUserId: '9003' });
    // The second, web-only, adds Telegram.
    w.store.setAgentState('a2', 'STOPPED');
    w.store.setAgentWebOnly('a2', true);
    w.store.insertMembership({ id: 'm2', agentId: 'a2', userId: OWNER, role: 'owner', status: 'active' });
    // The detach: stopped, the bot let go, its goodbye on its way when the process ends.
    w.store.setAgentState('a1', 'STOPPED');
    const g = w.hold('sendMessage', 'tok-meal');
    void w.pool.release('mealplannerbot', { reason: 'detached', agentId: 'a1' });
    await g.reached;
    // The next process.
    newBootForTests();
    const pool = new TelegramPoolProvisioner(w.db, w.secrets, { fetchImpl: w.fetchImpl, renameBackoffMs: [], sleep: async () => {} });
    const f = Fastify();
    await registerRoutes(f, { store: new Store(w.db), secrets: w.secrets as never, providers: new Map([['mock', new MockProvider()]]), channel: new CompositeTelegramProvisioner(pool, new TelegramManualProvisioner(w.secrets)), oauthFetch: w.fetchImpl } as never);
    const inject = (method: string, url: string, payload?: unknown) => f.inject({ method: method as never, url, headers: { 'x-hatchabot-owner': OWNER }, payload: payload as never });
    const sentBefore = w.sent.length;
    /** a1's bot as it was: its name, nobody told anything, not leased, its token kept, no idle name queued. */
    const untouched = () => {
      expect(w.names.get('tok-meal')).toBe('Meal Planner');
      expect(w.sent.slice(sentBefore)).toEqual([]);
      expect(pool.list().find((b) => b.username === 'mealplannerbot')?.leasedTo).toBeUndefined();
      expect(pool.list().find((b) => b.username === 'gardenlogbot')?.leasedTo).toBe('a3');
      expect(w.secrets.map.get('telegram/bot/mealplannerbot')).toBe('tok-meal');
      expect(pool.pendingName('mealplannerbot')?.name).not.toBe(IDLE);
    };
    return { w, pool, f, inject, untouched };
  };

  it('another agent\'s attach is not given it: no spare, and nothing said or renamed on it', async () => {
    const { w, pool, f, inject, untouched } = await cutOff();
    try {
      expect(pool.availableCount(OWNER)).toBe(0);
      const r = await inject('POST', '/v1/agents/a2/telegram', {});
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ needsToken: true });
      expect(w.store.getChannelForAgent('a2')).toBeUndefined();
      untouched();
      // Once its detach is run again (its row gone), it is a spare again, and taken.
      await pool.release('mealplannerbot', { reason: 'detached', agentId: 'a1' });
      w.store.deleteChannelForAgent('a1');
      const again = await inject('POST', '/v1/agents/a2/telegram', {});
      expect(again.statusCode, again.body).toBe(202);
      expect(again.json()).toMatchObject({ username: 'mealplannerbot' });
    } finally { await f.close(); }
  });

  it('a Change bot is not moved to it, and tells nobody "end of this agent"', async () => {
    const { w, f, inject, untouched } = await cutOff();
    try {
      const r = await inject('POST', '/v1/agents/a3/channel/swap');
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error).toMatch(/No spare bot to move to/);
      expect(w.store.getChannelForAgent('a3')?.accountId).toBe('gardenlogbot');
      untouched();
    } finally { await f.close(); }
  });

  it('it is listed in use by its agent, not free, and Remove keeps its token', async () => {
    const { f, inject, untouched } = await cutOff();
    try {
      const roster = (await inject('GET', '/v1/pool')).json() as { availableBots: number; bots: Array<{ username: string; leasedTo?: string; leasedToName?: string }> };
      expect(roster.availableBots).toBe(0);
      expect(roster.bots.find((b) => b.username === 'mealplannerbot')).toMatchObject({ leasedTo: 'a1', leasedToName: 'Meal Planner' });
      const removed = await inject('DELETE', '/v1/pool/mealplannerbot');
      expect(removed.statusCode, removed.body).toBe(409);
      expect(removed.json().error).toMatch(/still connected to an agent/);
      const inventory = (await inject('GET', '/v1/bot-inventory')).json() as { bots: Array<{ username: string; where: string }> };
      expect(inventory.bots.find((b) => b.username === 'mealplannerbot')?.where).toBe('agent');
      untouched();
    } finally { await f.close(); }
  });

  it('a lease that finds the bot taken by a row meanwhile gives it back unused: no stray lease, no goodbye, no idle name on it', async () => {
    const w = world();
    w.agent('a3', 'Garden Log');
    w.agent('a2', 'Budget Tracker');
    w.agent('a4', 'Soccer Schedule');
    await w.pool.addToPool('gardenlogbot', 'tok-garden', OWNER);
    await w.pool.provision({ agentId: 'a3', agentName: 'Garden Log', slug: 'garden', ownerId: OWNER });
    w.store.insertChannel({ id: 'c3', agentId: 'a3', kind: 'telegram', accountId: 'gardenlogbot', secretRef: 'telegram/bot/gardenlogbot', deepLink: 'https://t.me/gardenlogbot', createdAt: 'now' });
    w.store.insertMembership({ id: 'm3', agentId: 'a3', userId: OWNER, role: 'owner', status: 'active', channelUserId: '9003' });
    w.store.setAgentState('a2', 'STOPPED');
    w.store.setAgentWebOnly('a2', true);
    w.store.insertMembership({ id: 'm2', agentId: 'a2', userId: OWNER, role: 'owner', status: 'active', channelUserId: '9002' });
    await w.pool.addToPool('sparebot', 'tok-spare', OWNER);
    // Each lease of the spare: the fourth agent connects the same bot (its token pasted there) as it is leased.
    const lease = w.pool.provision.bind(w.pool);
    w.pool.provision = async (req) => {
      const c = await lease(req);
      if (!w.store.getChannelForAgent('a4')) w.store.insertChannel({ id: 'c4', agentId: 'a4', kind: 'telegram', accountId: c.accountId, secretRef: 'channel/a4/bot-token', deepLink: `https://t.me/${c.accountId}`, createdAt: 'now' });
      return c;
    };
    const { f, inject } = await w.routes();
    try {
      for (const [ask, people] of [[() => inject('POST', '/v1/agents/a3/channel/swap'), '9003'], [() => inject('POST', '/v1/agents/a2/telegram', {}), '9002']] as const) {
        const r = await ask();
        expect(r.statusCode, r.body).toBe(409);
        expect(r.json().error).toBe('@sparebot already belongs to "Soccer Schedule".');
        expect(w.pool.list().find((b) => b.username === 'sparebot')?.leasedTo).toBeUndefined();
        expect(w.sent.filter(([, c, t]) => c === people && /— end of this agent —/.test(t))).toEqual([]);
        expect(w.pool.pendingName('sparebot')?.name).not.toBe(IDLE);
        w.store.deleteChannelForAgent('a4');
      }
      expect(w.store.getChannelForAgent('a3')?.accountId).toBe('gardenlogbot');
      expect(w.pool.list().find((b) => b.username === 'gardenlogbot')?.leasedTo).toBe('a3');
    } finally { await f.close(); }
  });
});

describe('a bot found to be another agent\'s after it was leased (HB-1263 review, round 3)', () => {
  /** A spare, and a fourth agent that connects the same bot (its token pasted there) as it is leased. */
  const takenAsLeased = async () => {
    const w = world();
    w.store.insertAgent({
      id: 'a2', ownerId: OWNER, name: 'Budget Tracker', slug: 'a2', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1',
      persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now',
    } as never);
    w.agent('a4', 'Soccer Schedule');
    await w.pool.addToPool('sparebot', 'tok-spare', OWNER);
    const lease = w.pool.provision.bind(w.pool);
    w.pool.provision = async (req) => {
      const c = await lease(req);
      if (!w.store.getChannelForAgent('a4')) w.store.insertChannel({ id: 'c4', agentId: 'a4', kind: 'telegram', accountId: c.accountId, secretRef: 'channel/a4/bot-token', deepLink: `https://t.me/${c.accountId}`, createdAt: 'now' });
      return c;
    };
    return w;
  };

  it('a create that finds it so fails holding no lease: its Retry is not stuck on the same one', async () => {
    const w = await takenAsLeased();
    const channel = new CompositeTelegramProvisioner(w.pool, new TelegramManualProvisioner(w.secrets));
    const create = () => runProvisionSteps({ store: w.store, secrets: w.secrets, provider: new MockProvider(), channel, sleep: async () => {}, log: () => {} }, 'a2');
    const failed = await create();
    expect(failed.agent.state).toBe('FAILED');
    expect(failed.agent.stateReason ?? '').toMatch(/already belongs to "Soccer Schedule"/);
    expect(w.pool.list().find((b) => b.username === 'sparebot')?.leasedTo).toBeUndefined();
    expect(w.store.getChannelForAgent('a2')).toBeUndefined();
    // Its Retry, the bot still the other agent's: not the same lease and the
    // same clash again, but no spare, so it asks for a token.
    const retried = await create();
    expect(retried.setupRequired).toBeDefined();
    expect(retried.agent.state).toBe('PROVISIONING');
    expect(w.pool.list().find((b) => b.username === 'sparebot')?.leasedTo).toBeUndefined();
  });

  it('a Change bot whose pasted token is another agent\'s bot leaves that agent\'s stored token alone', async () => {
    const w = world();
    w.agent('a4', 'Soccer Schedule');
    w.agent('a3', 'Garden Log');
    await w.pool.addToPool('sparebot', 'tok-spare', OWNER);
    await w.pool.addToPool('gardenlogbot', 'tok-garden', OWNER);
    await w.pool.provision({ agentId: 'a3', agentName: 'Garden Log', slug: 'garden', ownerId: OWNER });
    w.store.insertChannel({ id: 'c3', agentId: 'a3', kind: 'telegram', accountId: 'gardenlogbot', secretRef: 'telegram/bot/gardenlogbot', deepLink: 'https://t.me/gardenlogbot', createdAt: 'now' });
    // The fourth agent is on a pasted bot of its own, its token stored under the bot's name.
    await w.secrets.put('telegram/bot/ownbot', 'tok-own');
    w.store.insertChannel({ id: 'c4', agentId: 'a4', kind: 'telegram', accountId: 'ownbot', secretRef: 'telegram/bot/ownbot', deepLink: 'https://t.me/ownbot', createdAt: 'now' });
    const { f, inject, channel } = await w.routes();
    try {
      // A token held for the third agent (pasted, and not taken), for that same bot: the Change bot's lease takes it.
      await channel.submitToken('a3', 'tok-own', 'ownbot');
      const r = await inject('POST', '/v1/agents/a3/channel/swap');
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error).toBe('@ownbot already belongs to "Soccer Schedule".');
      expect(w.secrets.map.get('telegram/bot/ownbot')).toBe('tok-own');
      expect(w.store.getChannelForAgent('a3')?.accountId).toBe('gardenlogbot');
      expect(await channel.waitingFor('a3')).toBe(false);
    } finally { await f.close(); }
  });
});

describe('two Telegram attaches of one agent at once (HB-1263)', () => {
  /** A web-only agent and one spare whose naming (getMe) Telegram holds. */
  const attaching = async () => {
    const w = world();
    w.agent('a1', 'Meal Planner');
    w.store.setAgentState('a1', 'STOPPED');
    w.store.setAgentWebOnly('a1', true);
    w.store.insertMembership({ id: 'm1', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active' });
    await w.pool.addToPool('mealplannerbot', 'tok-meal', OWNER);
    return w;
  };

  it('a spare found by one, while a pasted token connected first, goes back to the pool', async () => {
    const w = await attaching();
    const token = '42:made-up-own-bot';
    w.users.set(token, 'ownbot');
    // The token box's check asks the Telegram the routes are handed (HB-1447): the fake, never the global fetch.
    const { f, inject } = await w.routes();
    try {
      const g = w.hold('getMe', 'tok-meal');
      const fromPool = Promise.resolve(inject('POST', '/v1/agents/a1/telegram', {}));
      await g.reached;
      const pasted = await inject('POST', '/v1/agents/a1/telegram', { token });
      expect(pasted.statusCode, pasted.body).toBe(202);
      g.open();
      const r = await fromPool;
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error).toMatch(/already has a Telegram bot/);
      expect(w.store.getChannelForAgent('a1')?.accountId).toBe('ownbot');
      // The spare is free again and counted, not leased to an agent with no row on it.
      expect(w.pool.list()).toEqual([expect.objectContaining({ username: 'mealplannerbot', leasedTo: undefined })]);
      expect(w.pool.availableCount(OWNER)).toBe(1);
    } finally { await f.close(); }
  });

  it('two from the pool find one lease: the second is told it has one, and the bot stays the first one\'s', async () => {
    const w = await attaching();
    const { f, inject } = await w.routes();
    try {
      const g = w.hold('getMe', 'tok-meal');
      const first = Promise.resolve(inject('POST', '/v1/agents/a1/telegram', {}));
      await g.reached;
      g.open();
      const [a, b] = await Promise.all([first, inject('POST', '/v1/agents/a1/telegram', {})]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([202, 409]);
      expect(w.store.getChannelForAgent('a1')?.accountId).toBe('mealplannerbot');
      expect(w.pool.list()).toEqual([expect.objectContaining({ username: 'mealplannerbot', leasedTo: 'a1' })]);
    } finally { await f.close(); }
  });

  it('one that goes on after the other, refused as busy, gave the spare back is refused too: no row names a free bot', async () => {
    const w = await attaching();
    // The second attach's look at the pool waits for a gate, so another change can take the agent after its first checks.
    const lease = w.pool.provision.bind(w.pool);
    const g2 = gate();
    let leases = 0;
    w.pool.provision = async (req) => { if (++leases === 2) { g2.entered(); await g2.opened; } return lease(req); };
    const { f, inject } = await w.routes();
    try {
      // The first takes the lease; naming the bot waits on Telegram.
      const g = w.hold('getMe', 'tok-meal');
      const first = Promise.resolve(inject('POST', '/v1/agents/a1/telegram', {}));
      await g.reached;
      // A second attach finds the same lease; another change takes the agent meanwhile, so it is refused, giving the spare back.
      const secondAsked = Promise.resolve(inject('POST', '/v1/agents/a1/telegram', {}));
      await g2.reached;
      markBusy('a1');
      try {
        g2.open();
        const second = await secondAsked;
        expect(second.statusCode, second.body).toBe(409);
      } finally { clearBusy('a1'); }
      expect(w.pool.list()).toEqual([expect.objectContaining({ username: 'mealplannerbot', leasedTo: undefined })]);
      // The change is over; the first goes on.
      g.open();
      const r = await first;
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error).toMatch(/went back to the pool while it was being connected/);
      expect(w.store.getChannelForAgent('a1')).toBeUndefined();
      expect(w.pool.list()).toEqual([expect.objectContaining({ username: 'mealplannerbot', leasedTo: undefined })]);
      // Named for a1 by the first lease, its idle name is queued again.
      expect(w.pool.pendingName('mealplannerbot')?.name).toBe(IDLE);
      // Tried again, it is connected, on a lease of its own.
      const again = await inject('POST', '/v1/agents/a1/telegram', {});
      expect(again.statusCode, again.body).toBe(202);
      expect(w.store.getChannelForAgent('a1')?.accountId).toBe('mealplannerbot');
      expect(w.pool.list()).toEqual([expect.objectContaining({ username: 'mealplannerbot', leasedTo: 'a1' })]);
    } finally { await f.close(); }
  });
});

describe('adding a spare Telegram bot to an agent that becomes busy meanwhile (HB-1131)', () => {
  it('the attach refused as busy gives the spare back: no channel, and the pool counts it again', async () => {
    const w = world();
    w.agent('a1', 'Meal Planner');
    w.store.setAgentState('a1', 'STOPPED');
    w.store.setAgentWebOnly('a1', true);
    w.store.insertMembership({ id: 'm1', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active' });
    await w.pool.addToPool('mealplannerbot', 'tok-meal', OWNER);
    const { f, inject } = await w.routes();
    try {
      // The lease is taken; naming the bot waits on Telegram.
      const g = w.hold('getMe', 'tok-meal');
      const attach = Promise.resolve(inject('POST', '/v1/agents/a1/telegram', {}));
      await g.reached;
      // Another change takes the agent meanwhile (a rebuild, a move).
      markBusy('a1');
      try {
        g.open();
        const r = await attach;
        expect(r.statusCode, r.body).toBe(409);
      } finally { clearBusy('a1'); }
      expect(w.store.getChannelForAgent('a1')).toBeUndefined();
      expect(w.pool.list()).toEqual([expect.objectContaining({ username: 'mealplannerbot', leasedTo: undefined })]);
      expect(w.pool.availableCount(OWNER)).toBe(1);
      // Asked again once it is free, it gets the bot.
      const again = await inject('POST', '/v1/agents/a1/telegram', {});
      expect(again.statusCode, again.body).toBe(202);
      expect(w.store.getChannelForAgent('a1')?.accountId).toBe('mealplannerbot');
    } finally { await f.close(); }
  });

  for (const meanwhile of ['busy', 'archived'] as const) {
    it(`a spare given back (the agent ${meanwhile} meanwhile) keeps the chats it had, for the next lease to tell (HB-1131 review)`, async () => {
      const w = world();
      w.agent('a1', 'Meal Planner');
      w.agent('a2', 'Budget Tracker');
      w.store.setAgentState('a1', 'STOPPED');
      w.store.setAgentWebOnly('a1', true);
      // The refused agent's people, who never talked to this bot.
      w.store.insertMembership({ id: 'm1', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active', channelUserId: '9001' });
      await w.pool.addToPool('mealplannerbot', 'tok-meal', OWNER);
      // Whom the bot served before.
      w.db.prepare(`UPDATE telegram_pool SET prior_chat_ids = ? WHERE username = ?`).run(JSON.stringify(['5550001']), 'mealplannerbot');
      const { f, inject } = await w.routes();
      try {
        const g = w.hold('getMe', 'tok-meal');
        const attach = Promise.resolve(inject('POST', '/v1/agents/a1/telegram', {}));
        await g.reached;
        if (meanwhile === 'busy') markBusy('a1');
        else w.store.setAgentState('a1', 'ARCHIVED');
        try {
          g.open();
          const r = await attach;
          expect(r.statusCode, r.body).toBe(409);
        } finally { clearBusy('a1'); }
      } finally { await f.close(); }
      expect(w.pool.list()).toEqual([expect.objectContaining({ username: 'mealplannerbot', leasedTo: undefined })]);
      expect(w.pool.priorChatIds('mealplannerbot')).toEqual(['5550001']);
      // The lease named it for the refused agent: the idle name is queued again.
      expect(w.pool.pendingName('mealplannerbot')?.name).toBe(IDLE);
      // The next agent's notice goes to the bot's own chats, not the refused agent's people.
      const before = w.sent.length;
      await w.pool.provision({ agentId: 'a2', agentName: 'Budget Tracker', slug: 'budget', ownerId: OWNER });
      const told = w.sent.slice(before).filter(([, , text]) => /this bot is now "Budget Tracker"/.test(text)).map(([, chat]) => chat);
      expect(told).toEqual(['5550001']);
    });
  }

  it('a pasted token refused as busy stays its owner\'s bot: not made a spare, not renamed, and pasting it again works (HB-1131 review)', async () => {
    const w = world();
    w.agent('a1', 'Meal Planner');
    w.store.setAgentState('a1', 'STOPPED');
    w.store.setAgentWebOnly('a1', true);
    w.store.insertMembership({ id: 'm1', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active' });
    const token = '42:made-up-own-bot';
    w.users.set(token, 'ownbot');
    w.names.set(token, 'My Own Bot');
    // The token box's check asks the Telegram the routes are handed (HB-1447): the fake, never the global fetch.
    const { f, inject } = await w.routes();
    try {
      // The token is checked with Telegram; another change takes the agent meanwhile.
      const g = w.hold('getMe', token);
      const attach = Promise.resolve(inject('POST', '/v1/agents/a1/telegram', { token }));
      await g.reached;
      markBusy('a1');
      try {
        g.open();
        const r = await attach;
        expect(r.statusCode, r.body).toBe(409);
      } finally { clearBusy('a1'); }
      expect(w.store.getChannelForAgent('a1')).toBeUndefined();
      // Not a spare, no idle name queued for it, and this machine keeps no copy of its token.
      expect(w.pool.list()).toEqual([]);
      expect(w.pool.pendingName('ownbot')).toBeUndefined();
      expect(w.secrets.map.has('telegram/bot/ownbot')).toBe(false);
      // Pasted again, it is taken, and its name is its owner's still.
      const again = await inject('POST', '/v1/agents/a1/telegram', { token });
      expect(again.statusCode, again.body).toBe(202);
      expect(w.store.getChannelForAgent('a1')?.accountId).toBe('ownbot');
      expect(w.names.get(token)).toBe('My Own Bot');
    } finally { await f.close(); }
  });
});
