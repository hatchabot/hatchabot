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

function world() {
  const db = new Database(':memory:');
  const store = new Store(db); // memberships, and the pool's table
  const secrets = new MemSecrets();
  /** Each bot's display name, by token, as Telegram holds it. */
  const names = new Map<string, string>();
  /** Each bot's @handle, by token, for a token pasted by hand. */
  const users = new Map<string, string>();
  /** Every message a bot sent: [token, chat, text]. */
  const sent: Array<[string, string, string]> = [];
  /** One call held: the next `method` for `token` waits for the gate. */
  const holds: Array<{ method: string; token: string; g: ReturnType<typeof gate> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const m = /\/bot([^/]+)\/(\w+)/.exec(String(input));
    const token = m?.[1] ?? '';
    const method = m?.[2] ?? '';
    const held = holds.findIndex((h) => h.method === method && h.token === token);
    if (held >= 0) {
      const [h] = holds.splice(held, 1);
      h!.g.entered();
      await h!.g.opened;
    }
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    let result: unknown = true;
    if (method === 'getMe') result = { first_name: names.get(token) ?? 'Fresh Bot', ...(users.has(token) ? { username: users.get(token) } : {}) };
    if (method === 'getUpdates') result = [];
    if (method === 'setMyName') names.set(token, String(body.name));
    if (method === 'sendMessage') sent.push([token, String(body.chat_id), String(body.text)]);
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const pool = new TelegramPoolProvisioner(db, secrets, { fetchImpl, renameBackoffMs: [], sleep: async () => {} });
  const hold = (method: string, token: string) => { const g = gate(); holds.push({ method, token, g }); return g; };
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
    return { f, inject };
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
    // Another agent asks for a spare while the farewell waits on Telegram.
    const during = await w.pool.provision({ agentId: 'a2', agentName: 'Budget Tracker', slug: 'budget', ownerId: OWNER })
      .then((c) => c.accountId, (err: Error) => err.name);
    expect(during).toBe('PoolExhaustedError');
    g.open();
    await release;
    // Once it is out, the bot is free for the next agent, whose notice comes last.
    expect((await w.pool.provision({ agentId: 'a2', agentName: 'Budget Tracker', slug: 'budget', ownerId: OWNER })).accountId).toBe('mealplannerbot');
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
    const during = await w.pool.provision({ agentId: 'a2', agentName: 'Budget Tracker', slug: 'budget', ownerId: OWNER })
      .then((c) => c.accountId, (err: Error) => err.name);
    expect(during).toBe('PoolExhaustedError');
    g.open();
    await release;
    expect(w.pool.list()).toEqual([expect.objectContaining({ username: 'pastedbot', leasedTo: undefined })]);
    expect(toChat(w, '9002')).toEqual([expect.stringMatching(/— end of this agent —/)]);
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
    // The token box's check with Telegram goes the default way: to the fake too.
    vi.spyOn(globalThis, 'fetch').mockImplementation(w.fetchImpl);
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
