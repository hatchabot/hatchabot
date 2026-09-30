import { afterEach, describe, expect, it } from 'vitest';
import { hibernateAfterMs, hibernateAgent, hibernateBlocker, hibernateSweep, resetHibernateState, wakeAgent, wakeSweep, WAKE_GIVE_UP, type HibernateDeps } from '../src/orchestrator/hibernate.js';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';

/**
 * Hibernation: idle agents sleep (stopped, volume kept) and wake when wanted.
 * A gateway holds ~1.2 GiB whether it talks or not, so on a shared host this
 * is the lever on tenants per machine (S7).
 */

const HOUR = 3_600_000;

function depsFor(w: World, over: Partial<HibernateDeps> = {}): HibernateDeps & { events: Array<[string, string]> } {
  const events: Array<[string, string]> = [];
  return {
    store: w.store, secrets: w.secrets, providerFor: () => w.provider,
    lastActiveFor: async () => new Date(Date.now() - 10 * HOUR).toISOString(),
    ownCrons: async () => [],
    isBusy: () => false,
    log: (id) => (event) => { events.push([id, event]); },
    events,
    ...over,
  };
}

describe('the idle rule', () => {
  afterEach(() => { delete process.env.HATCHABOT_HIBERNATE_AFTER; });

  it('reads HATCHABOT_HIBERNATE_AFTER as minutes, hours or days; off when unset or 0', () => {
    expect(hibernateAfterMs('90m')).toBe(90 * 60_000);
    expect(hibernateAfterMs('6h')).toBe(6 * HOUR);
    expect(hibernateAfterMs('2d')).toBe(48 * HOUR);
    expect(hibernateAfterMs('3')).toBe(3 * HOUR);
    expect(hibernateAfterMs('0')).toBe(0);
    expect(hibernateAfterMs(undefined)).toBe(0);
    expect(hibernateAfterMs('soon')).toBe(0);
  });

  it('a quiet Telegram agent with no tasks sleeps; busy, recent, Discord, scheduled and opted-out ones stay up', async () => {
    const w = await makeWorld();
    const quiet = await seedRunningAgent(w, { id: 'a1', slug: 'quiet', accountId: 'quietbot' });
    const recent = await seedRunningAgent(w, { id: 'a2', slug: 'recent', accountId: 'recentbot' });
    const busy = await seedRunningAgent(w, { id: 'a3', slug: 'busy', accountId: 'busybot' });
    const discord = await seedRunningAgent(w, { id: 'a4', slug: 'disc', accountId: 'discbot' });
    w.store.insertChannel({ id: 'c-disc', agentId: discord, kind: 'discord', accountId: '1234567890123456789', secretRef: 'chan/disc', deepLink: 'https://discord.example/x', createdAt: 'now' });
    const tasks = await seedRunningAgent(w, { id: 'a5', slug: 'tasks', accountId: 'tasksbot' });
    const awake = await seedRunningAgent(w, { id: 'a6', slug: 'awake', accountId: 'awakebot' });
    w.store.setHibernatePolicy(awake, 'never');
    const deps = depsFor(w, {
      lastActiveFor: async (a) => new Date(Date.now() - (a.id === recent ? 1 : 10) * HOUR).toISOString(),
      isBusy: (id) => id === busy,
      ownCrons: async (a) => (a.id === tasks ? [{ enabled: true }, { enabled: true, system: true }] : [{ enabled: true, system: true }]),
    });
    const now = Date.now();
    expect(await hibernateBlocker(deps, w.store.getAgent(quiet)!, now, 6 * HOUR)).toBeUndefined();
    expect(await hibernateBlocker(deps, w.store.getAgent(recent)!, now, 6 * HOUR)).toBe('active recently');
    expect(await hibernateBlocker(deps, w.store.getAgent(busy)!, now, 6 * HOUR)).toBe('busy');
    expect(await hibernateBlocker(deps, w.store.getAgent(discord)!, now, 6 * HOUR)).toMatch(/Discord or Slack/);
    expect(await hibernateBlocker(deps, w.store.getAgent(tasks)!, now, 6 * HOUR)).toBe('has scheduled tasks');
    expect(await hibernateBlocker(deps, w.store.getAgent(awake)!, now, 6 * HOUR)).toBe('set to stay awake');

    expect(await hibernateSweep(deps, now, 0)).toEqual([]); // off
    expect(await hibernateSweep(deps, now, 6 * HOUR)).toEqual([quiet]);
    const a = w.store.getAgent(quiet)!;
    expect(a.state).toBe('STOPPED');
    expect(a.hibernatedAt).toBeTruthy();
    expect(w.provider.runtimes.get(a.runtimeRef!)?.phase).toBe('stopped');
    expect(deps.events).toContainEqual([quiet, 'agent.hibernated']);
    // Already asleep: the next sweep leaves it (not running) and touches nothing else.
    expect(await hibernateSweep(deps, now, 6 * HOUR)).toEqual([]);
  });
});

describe('waking', () => {
  it('a Telegram update waiting for a sleeper wakes it; getUpdates is asked with no offset so nothing is confirmed', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { botToken: 'fake-token-Z' });
    const urls: string[] = [];
    let mail = false;
    const deps = depsFor(w, {
      fetchImpl: (async (u: string | URL | Request) => { urls.push(String(u)); return new Response(JSON.stringify({ ok: true, result: mail ? [{ update_id: 7 }] : [] })); }) as typeof fetch,
    });
    await hibernateSweep(deps, Date.now(), 6 * HOUR);
    expect(w.store.getAgent(id)!.state).toBe('STOPPED');
    expect(await wakeSweep(deps)).toEqual([]);
    expect(urls[0]).toBe('https://api.telegram.org/botfake-token-Z/getUpdates?limit=100&timeout=0');
    mail = true;
    expect(await wakeSweep(deps)).toEqual([id]);
    // Woken: the idle clock restarts at the wake (kept in the store, so a restart cannot forget it).
    expect(w.store.getAgent(id)!.wokenAt).toBeTruthy();
    expect(await hibernateSweep(deps, Date.now(), 6 * HOUR)).toEqual([]);
    expect(await hibernateBlocker(deps, w.store.getAgent(id)!, Date.now(), 6 * HOUR)).toBe('active recently');
    expect(await hibernateBlocker(deps, w.store.getAgent(id)!, Date.now() + 7 * HOUR, 6 * HOUR)).toBeUndefined();
    const a = w.store.getAgent(id)!;
    expect(a.state).toBe('RUNNING');
    expect(a.hibernatedAt).toBeUndefined();
    expect(w.provider.runtimes.get(a.runtimeRef!)?.phase).toBe('running');
    expect(deps.events).toContainEqual([id, 'agent.woken']);
    // The update the gateway had handled but not yet confirmed when the container
    // stopped is still "waiting": it is not mail. Only a newer one is.
    const later = await seedRunningAgent(w, { id: 'b1', slug: 'later', accountId: 'laterbot', botToken: 'fake-token-Y' });
    let waiting = 41;
    deps.fetchImpl = (async (u: string | URL | Request) => new Response(JSON.stringify({ ok: true, result: String(u).includes('fake-token-Y') ? [{ update_id: waiting }] : [] }))) as typeof fetch;
    await hibernateAgent(deps, w.store.getAgent(later)!, 'test');
    expect(w.store.getAgent(later)!.hibernateMark).toBe(41); // the bedtime mark, in the store
    expect(await wakeSweep(deps)).toEqual([]); // update 41 was already there when it slept
    // Telegram answers earliest first: the marked update stays in the page and
    // a newer one behind it is the mail (limit=1 never saw it; 30th audit).
    deps.fetchImpl = (async (u: string | URL | Request) => new Response(JSON.stringify({ ok: true, result: String(u).includes('fake-token-Y') ? [{ update_id: 41 }, { update_id: 42 }] : [] }))) as typeof fetch;
    expect(await wakeSweep(deps)).toEqual([later]);
    // A stopped agent the owner stopped is not a sleeper: nothing wakes it.
    w.store.setAgentState(id, 'STOPPED');
    expect(await wakeSweep(deps)).toEqual([]);
    expect(await wakeAgent(deps, w.store.getAgent(id)!, 'x')).toMatchObject({ state: 'STOPPED' });
  });

  // After a week with no updates Telegram starts update_id again at random:
  // the first message of a quiet week can sit BELOW the bedtime mark (2026-09-30).
  it('an update with a lower id than the bedtime mark is mail; the unconfirmed batch just below it is not', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { botToken: 'fake-token-W' });
    let result = [{ update_id: 50000 }];
    const deps = depsFor(w, { fetchImpl: (async () => new Response(JSON.stringify({ ok: true, result }))) as typeof fetch });
    await hibernateAgent(deps, w.store.getAgent(id)!, 'test');
    expect(w.store.getAgent(id)!.hibernateMark).toBe(50000);
    expect(await wakeSweep(deps)).toEqual([]);
    // Two the gateway handled in its last poll, still unconfirmed at bedtime: not mail.
    result = [{ update_id: 49999 }, { update_id: 50000 }];
    expect(await wakeSweep(deps)).toEqual([]);
    // A quiet week later, the marked update expired and a new one arrived far below it.
    result = [{ update_id: 17 }];
    expect(await wakeSweep(deps)).toEqual([id]);
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');
  });

  it('over the API: asking a sleeper wakes it first; hibernate/wake by hand; start clears the mark; the app sees hibernatedAt', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    w.provider.execResponses.set('sh', { code: 0, stdout: '', stderr: '' });
    const asleep = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/hibernate`, headers: as() });
    expect(asleep.statusCode, asleep.body).toBe(200);
    expect(asleep.json()).toMatchObject({ state: 'STOPPED' });
    expect(asleep.json().hibernatedAt).toBeTruthy();
    expect((await w.f.inject({ method: 'GET', url: `/v1/agents/${id}/hibernate`, headers: as() })).json()).toMatchObject({ asleep: true });
    // Ask: the agent is woken and answers (the mock answers whatever it is asked).
    const ask = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/ask`, headers: as(), payload: { text: 'hello?' } });
    expect(ask.statusCode, ask.body).not.toBe(409);
    expect(w.store.getAgent(id)!).toMatchObject({ state: 'RUNNING', hibernatedAt: undefined });
    // By hand again, then start (not wake) also clears the mark.
    await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/hibernate`, headers: as() });
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/wake`, headers: as(OWNER_OTHER) })).statusCode).toBe(404);
    const started = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: as() });
    expect(started.statusCode, started.body).toBe(200);
    expect(w.store.getAgent(id)!.hibernatedAt).toBeUndefined();
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/wake`, headers: as() })).statusCode).toBe(409);
    // Opt out: PATCH hibernate=never, and back.
    expect((await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(), payload: { hibernate: 'never' } })).statusCode).toBe(200);
    expect(w.store.getAgent(id)!.hibernate).toBe('never');
    expect((await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(), payload: { hibernate: null } })).statusCode).toBe(200);
    expect(w.store.getAgent(id)!.hibernate).toBeUndefined();
    // Discord agents may not be put to sleep even by hand.
    w.store.insertChannel({ id: 'c-d', agentId: id, kind: 'discord', accountId: '1234567890123456789', secretRef: 'chan/d', deepLink: 'https://discord.example/y', createdAt: 'now' });
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/hibernate`, headers: as() })).statusCode).toBe(409);
  });
});
const OWNER_OTHER = 'user-other';

describe('the 30th audit: sleepers and the rest of the machine', () => {
  afterEach(() => resetHibernateState());
  it('a moved-away or busy sleeper is not woken by the poll, the button or a consult; a rebuild that ends RUNNING ends the sleep', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { botToken: 'fake-token-M' });
    let busy = false;
    const deps = depsFor(w, {
      isBusy: () => busy,
      fetchImpl: (async () => new Response(JSON.stringify({ ok: true, result: [{ update_id: 9 }] }))) as typeof fetch,
    });
    await hibernateAgent(deps, w.store.getAgent(id)!, 'test');
    // Busy (a move or rebuild holds it): left asleep, no start.
    busy = true;
    expect(await wakeSweep(deps)).toEqual([]);
    expect((await wakeAgent(deps, w.store.getAgent(id)!, 'x')).state).toBe('STOPPED');
    busy = false;
    // Moved to another machine: its copy there polls the bot.
    w.store.setAgentMigratedTo(id, 'moved to the laptop');
    expect(await wakeSweep(deps)).toEqual([]);
    expect(w.provider.runtimes.get(w.store.getAgent(id)!.runtimeRef!)?.phase).toBe('stopped');
    w.store.setAgentMigratedTo(id, null);
    // Any path that makes it RUNNING (here: as a rebuild does) clears the mark, so the next sweep leaves it alone.
    w.store.setAgentState(id, 'RUNNING');
    const a = w.store.getAgent(id)!;
    expect(a.hibernatedAt).toBeUndefined();
    expect(a.wokenAt).toBeTruthy();
    expect(await hibernateBlocker(deps, a, Date.now(), 6 * HOUR)).toBe('active recently');
  });

  it('the management agent never sleeps; a start that keeps failing gives up after a few tries and says so', async () => {
    const w = await makeWorld();
    const ops = await seedRunningAgent(w, { id: 'ops1', slug: 'manager', accountId: 'mgrbot' });
    w.store.setAgentOps(ops, true);
    const deps = depsFor(w);
    const a = { ...w.store.getAgent(ops)!, ops: true };
    expect(await hibernateBlocker(deps, a, Date.now(), 6 * HOUR)).toBe('the management agent');
    const id = await seedRunningAgent(w, { id: 'f1', slug: 'flaky', accountId: 'flakybot', botToken: 'fake-token-F' });
    let waiting = 5;
    const d2 = depsFor(w, { fetchImpl: (async () => new Response(JSON.stringify({ ok: true, result: [{ update_id: waiting }] }))) as typeof fetch });
    await hibernateAgent(d2, w.store.getAgent(id)!, 'test');
    waiting = 6; // mail
    (w.provider as unknown as { opts: { failOn?: 'provision' | 'start' } }).opts.failOn = 'start';
    for (let i = 0; i < WAKE_GIVE_UP; i++) expect(await wakeSweep(d2)).toEqual([]);
    const after = w.store.getAgent(id)!;
    expect(after.state).toBe('STOPPED');
    expect(after.hibernatedAt).toBeUndefined(); // an ordinary stopped agent now: the poll leaves it
    expect(d2.events.filter(([, e]) => e === 'hibernate.wake_failed')).toHaveLength(WAKE_GIVE_UP);
    expect(d2.events).toContainEqual([id, 'hibernate.wake_abandoned']);
    (w.provider as unknown as { opts: { failOn?: 'provision' | 'start' } }).opts.failOn = undefined;
    expect(await wakeSweep(d2)).toEqual([]);
  });

  it('a bot token Telegram refuses is said once and not polled again', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { botToken: 'fake-token-R' });
    let calls = 0;
    const deps = depsFor(w, { fetchImpl: (async () => { calls++; return new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' })); }) as typeof fetch });
    await hibernateAgent(deps, w.store.getAgent(id)!, 'test'); // the bedtime poll is the one refusal
    expect(calls).toBe(1);
    await wakeSweep(deps); await wakeSweep(deps);
    expect(calls).toBe(1);
    expect(deps.events.filter(([, e]) => e === 'hibernate.token_refused')).toHaveLength(1);
  });
});

describe('the 30th audit: by hand', () => {
  it('the management agent cannot be put to sleep, by hand either', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { id: 'ops9', slug: 'mgr', accountId: 'mgr9bot' });
    w.store.setAgentOps(id, true);
    const res = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/hibernate`, headers: as() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/management agent/);
  });
});
