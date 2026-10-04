import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { guestConsoleSessionKey } from '../src/openclaw/consoleIdentity.js';
import { publicClassFor, guestMay } from '../src/api/publicRoutes.js';

/** GET /v1/recent: who sees which agents, which lines, and that sleepers stay asleep. */

const OWNER = 'owner-recent', GUEST = 'guest-recent', MEMBER = 'member-recent', STRANGER = 'stranger-recent';
const as = (who: string) => ({ 'x-hatchabot-owner': who });

async function world(opts: { guestNewest?: boolean } = {}) {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' });
  const provider = new MockProvider();
  const now = Date.now();
  // Filled in once the agents exist (a guest's conversation key comes from its gateway secret).
  const sessions: Record<string, Record<string, unknown>> = {};
  const lines: Record<string, Record<string, unknown>> = {};
  const execShell = vi.spyOn(provider, 'execShell').mockImplementation(async (ref: string, script: string) => {
    if (script.includes('KEYS_B64=')) return { code: 0, stdout: JSON.stringify({ v: 1, s: lines[ref] ?? {} }), stderr: '' } as never;
    if (script.includes('sessions.json')) return { code: 0, stdout: JSON.stringify(sessions[ref] ?? {}), stderr: '' } as never;
    return { code: 0, stdout: '', stderr: '' } as never;
  });
  const exec = vi.spyOn(provider, 'exec');
  const start = vi.spyOn(provider, 'start');
  const execOnVolume = vi.spyOn(provider, 'execShellOnVolume');
  const f = Fastify();
  const secrets = { put: async () => {}, get: async () => 'x', delete: async () => {} };
  await registerRoutes(f, { store, secrets, providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false } } as never } as never);
  const agent = (id: string, name: string, slug: string, state = 'RUNNING') => store.insertAgent({
    id, ownerId: OWNER, name, slug, state, aiProfileId: 'p1', hostId: 'h1', runtimeRef: `mock://${id}`,
    persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now',
  } as never);
  agent('r-lunch', 'Lunch Agent', 'lunch');
  const GKEY = guestConsoleSessionKey(store.ensureGatewayAccess('r-lunch').token, 'lunch', GUEST);
  sessions['mock://r-lunch'] = {
    'agent:lunch:main': { updatedAt: now - 2 * 60_000, lastChannel: 'webchat' },
    [GKEY]: { updatedAt: now - (opts.guestNewest ? 1 : 10) * 60_000, lastChannel: 'webchat' },
  };
  sessions['mock://r-tax'] = { 'agent:tax:cron:j1': { updatedAt: now - 14 * 60_000 } };
  lines['mock://r-lunch'] = {
    'agent:lunch:main': { role: 'assistant', text: 'Booked **Thursday** at Pasta Place' },
    [GKEY]: { role: 'user', text: opts.guestNewest ? 'hello there' : 'is there a vegetarian option?' },
  };
  lines['mock://r-tax'] = { 'agent:tax:cron:j1': { role: 'assistant', text: 'summary', task: 'Daily brief' } };
  agent('r-tax', 'Tax Helper', 'tax');
  agent('r-sleepy', 'Stock Advisor', 'stocks', 'STOPPED');
  store.setHibernated('r-sleepy', new Date(now - 3600_000).toISOString());
  // Its line from before it fell asleep, as the tracker stored it.
  store.setAgentRecent('r-sleepy', { lastActiveAt: now - 3 * 3600_000, sessions: { 'agent:stocks:cron:b': { at: now - 3 * 3600_000, role: 'assistant', text: 'markets up', task: 'Morning brief' } } });
  agent('r-old', 'Cooking Teacher', 'cook', 'STOPPED');
  store.setAgentRecent('r-old', { lastActiveAt: now - 9 * 86_400_000, sessions: {} });
  store.insertMembership({ id: 'm1', agentId: 'r-lunch', userId: GUEST, role: 'user', displayName: 'Sam', status: 'active', webChat: true });
  store.insertMembership({ id: 'm2', agentId: 'r-lunch', userId: MEMBER, role: 'user', displayName: 'Robin', channelUserId: '4242', status: 'active' });
  const recent = async (who: string, q = '') => {
    const r = await f.inject({ method: 'GET', url: `/v1/recent${q}`, headers: as(who) });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { cap: number; total: number; items: Array<{ id: string; name: string; line: string; by?: string; unread: boolean; asleep?: boolean; at: string }> };
  };
  /** The first look reads; the capture lands a moment later (it never holds up the answer). */
  const settle = async (who: string) => { await recent(who); await new Promise((r) => setTimeout(r, 30)); };
  return { f, store, recent, settle, execShell, exec, start, execOnVolume, provider };
}

describe('GET /v1/recent', () => {
  it('owner: every agent of the week, newest first, with the line the console shows; an old one is left out', async () => {
    const w = await world();
    await w.settle(OWNER);
    const { items, total, cap } = await w.recent(OWNER);
    expect(cap).toBe(8);
    expect(items.map((i) => i.id)).toEqual(['r-lunch', 'r-tax', 'r-sleepy']);
    expect(total).toBe(3);
    expect(items[0]).toMatchObject({ name: 'Lunch Agent', line: 'Booked Thursday at Pasta Place', by: 'agent' });
    expect(items[1]).toMatchObject({ line: '⏰ Daily brief ran', by: 'task' });
    expect(items[2]).toMatchObject({ line: '⏰ Morning brief ran', asleep: true });
  });

  it('the asleep agent is answered from the store: never read, started or woken', async () => {
    const w = await world();
    await w.settle(OWNER);
    await w.recent(OWNER, '?all=1');
    const touched = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.some((c) => c[0] === 'mock://r-sleepy' || c[0] === 'mock://r-old');
    expect(touched(w.execShell)).toBe(false);
    expect(touched(w.exec)).toBe(false);
    expect(touched(w.start)).toBe(false);
    expect(touched(w.execOnVolume)).toBe(false);
    expect(w.store.getAgent('r-sleepy')).toMatchObject({ state: 'STOPPED' });
    expect(w.store.getAgent('r-sleepy')?.hibernatedAt).toBeTruthy();
  });

  it('a quiet agent costs no second read: the capture runs once, then only when something moved', async () => {
    const w = await world();
    await w.settle(OWNER);
    const reads = () => w.execShell.mock.calls.filter((c) => String(c[1]).includes('KEYS_B64=')).length;
    const first = reads();
    expect(first).toBe(2); // Lunch and Tax, once each
    await w.recent(OWNER);
    await w.recent(OWNER);
    expect(reads()).toBe(first);
  });

  it('guest: only the agents they chat with, and only their own conversation\'s line', async () => {
    const w = await world();
    await w.settle(OWNER);
    const { items } = await w.recent(GUEST);
    expect(items.map((i) => i.id)).toEqual(['r-lunch']);
    expect(items[0]!.line).toBe('You: is there a vegetarian option?');
    expect(JSON.stringify(items)).not.toContain('Pasta Place');
  });

  it('owner reads the guest\'s line under the guest\'s name when it is the newest', async () => {
    const w = await world({ guestNewest: true });
    await w.settle(OWNER);
    const { items } = await w.recent(OWNER);
    expect(items.find((i) => i.id === 'r-lunch')?.line).toBe('Sam: hello there');
  });

  it('a member without web chat sees the agent and its time, never a line', async () => {
    const w = await world();
    await w.settle(OWNER);
    const { items } = await w.recent(MEMBER);
    expect(items.map((i) => i.id)).toEqual(['r-lunch']);
    expect(items[0]!.line).toBe('');
  });

  it('a stranger sees nothing', async () => {
    const w = await world();
    await w.settle(OWNER);
    expect((await w.recent(STRANGER)).items).toEqual([]);
  });

  it('Needs you takes the line for the owner only', async () => {
    const w = await world();
    await w.settle(OWNER);
    w.store.setAgentPendingAction('r-lunch', { type: 'bot_token' } as never);
    expect((await w.recent(OWNER)).items.find((i) => i.id === 'r-lunch')).toMatchObject({ line: 'needs you: waiting for a Telegram bot token', by: 'needs-you', said: 'Booked Thursday at Pasta Place' });
    expect((await w.recent(GUEST)).items[0]!.line).toBe('You: is there a vegetarian option?');
  });

  it('is a signed-in route a chat-only guest may read', () => {
    expect(publicClassFor('GET', '/v1/recent')).toBe('signed-in');
    expect(guestMay('GET', '/v1/recent')).toBe(true);
    expect(publicClassFor('POST', '/v1/recent')).toBe('never');
  });
});

describe('a machine that does not answer (2026-10-04)', () => {
  it('the agent list does not wait for it: it answers in a few seconds and fills that agent in later', async () => {
    const w = await world();
    // r-tax's machine hangs: its sessions read never returns (a laptop asleep).
    const real = w.execShell.getMockImplementation()!;
    let release: (() => void) | undefined;
    w.execShell.mockImplementation(async (ref: string, script: string) => {
      if (ref === 'mock://r-tax' && script.includes('sessions.json')) {
        await new Promise<void>((r) => { release = r; });
        return { code: 0, stdout: JSON.stringify({ 'agent:tax:cron:j1': { updatedAt: Date.now() } }), stderr: '' } as never;
      }
      return real(ref, script);
    });
    const t0 = Date.now();
    const r = await w.f.inject({ method: 'GET', url: '/v1/agents', headers: as(OWNER) });
    const took = Date.now() - t0;
    expect(r.statusCode).toBe(200);
    expect(took).toBeLessThan(10_000);
    const tax = (r.json() as Array<{ id: string; lastActiveAt?: string }>).find((a) => a.id === 'r-tax')!;
    expect(tax.lastActiveAt).toBeUndefined();
    release!();
    await new Promise((res) => setTimeout(res, 30));
    const again = (await w.f.inject({ method: 'GET', url: '/v1/agents', headers: as(OWNER) })).json() as Array<{ id: string; lastActiveAt?: string }>;
    expect(again.find((a) => a.id === 'r-tax')!.lastActiveAt).toBeTruthy();
  }, 20_000);
});

describe('a machine whose agent check hangs (2026-10-04)', () => {
  it('the list answers within a few seconds and skips that machine for a minute', async () => {
    const w = await world();
    const realInfo = w.provider.info.bind(w.provider);
    let calls = 0;
    vi.spyOn(w.provider, 'info').mockImplementation(async (ref?: string) => {
      if (ref === 'mock://r-tax') { calls++; return new Promise(() => {}) as never; } // a laptop that never answers
      return realInfo(ref);
    });
    const t0 = Date.now();
    const r = await w.f.inject({ method: 'GET', url: '/v1/agents', headers: as(OWNER) });
    expect(r.statusCode).toBe(200);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect((r.json() as Array<{ id: string }>).map((a) => a.id)).toContain('r-tax');
    const before = calls;
    const t1 = Date.now();
    await w.f.inject({ method: 'GET', url: '/v1/agents', headers: as(OWNER) });
    expect(Date.now() - t1).toBeLessThan(1_000); // skipped, not waited for again
    expect(calls).toBe(before);
    // Every agent on that machine says its machine isn't answering (here the test world has one machine).
    const list = (await w.f.inject({ method: 'GET', url: '/v1/agents', headers: as(OWNER) })).json() as Array<{ id: string; hostUnreachable?: boolean; state: string }>;
    expect(list.find((a) => a.id === 'r-tax')!.hostUnreachable).toBe(true);
    // Its console answers in words, at once, instead of a JSON error.
    const ui = await w.f.inject({ method: 'GET', url: '/v1/agents/r-tax/ui/', headers: as(OWNER) });
    expect(ui.statusCode).toBe(503);
    expect(ui.headers['content-type']).toMatch(/text\/html/);
    expect(ui.body).toMatch(/isn(&#39;|&#x27;|')t answering/);
  }, 20_000);
});
