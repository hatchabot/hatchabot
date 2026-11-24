import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { claimFirstContact, resumeFirstContacts } from '../src/orchestrator/members/claim.js';
import { makeWorld, restartWorld, seedRunningAgent } from './support/world.js';

/**
 * A watch for a first message under way when Hatchabot restarts (HB-0838):
 * a new agent's owner, an import's, a Telegram bot attached, a member's door
 * reopened. The watch lived only in memory over its stored window, so after
 * a restart the person's first message was never claimed for them: it showed
 * as a stranger's knock to approve. It is kept in the store while it runs
 * (the agent's `first-contact` hold), and the next start watches it again,
 * with what it was started with: the ids it never claims, the hour a window
 * open to anyone may run from when it first opened, and the time it had left.
 *
 * A restart is what it is on a machine: a NEW Store over the same database
 * and machine, and the old process's watch left where it stood, never to look
 * again. Time, where it matters, is the test's own clock (only Date is
 * faked). The bot, the ids and the agents are made up.
 */
const OWNER = 'user-owner';
const GUEST = 'user-guest';
const GUEST_TG = '5550000002';
const EARLIER = '5550000007'; // wrote to the bot when it served its previous agent
const STRANGER = '5550000099';
const BOT = 'homework_helper_bot';
const MIN = 60_000;

afterEach(() => { vi.useRealTimers(); });

/** Lets the watch run until `cond` holds (each look is a few promise turns). */
async function settle(cond: () => boolean, rounds = 5000): Promise<void> {
  for (let i = 0; i < rounds && !cond(); i++) await new Promise((r) => setImmediate(r));
  expect(cond()).toBe(true);
}

/** Who knocks: the pairing requests OpenClaw would list on the agent's volume. */
type Knock = { id: string; code: string; meta?: { username?: string } };

/** One machine: its database and its containers, which outlive the Hatchabot processes that run on it in turn. */
async function machine() {
  vi.useFakeTimers({ toFake: ['Date'] });
  const db = new Database(':memory:');
  const provider = new MockProvider();
  provider.execResponses.set('pairing approve', { code: 0, stdout: 'ok', stderr: '' });
  let knocks: Knock[] = [];
  let looks = 0;
  const shell = provider.execShell.bind(provider);
  provider.execShell = async (ref, script, opts) => {
    if (!script.includes('channel_pairing_requests')) return shell(ref, script, opts);
    looks++;
    return { code: 0, stdout: JSON.stringify({ version: 1, requests: knocks }), stderr: '' };
  };
  const store = new Store(db);
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} } as never);
  await provider.start(runtimeRef);
  store.insertAgent({
    id: 'a1', ownerId: OWNER, name: 'Homework Helper', slug: 'a1', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
    persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now', runtimeRef,
  } as never);
  // Nobody's Telegram is known on it yet: the owner's seat, and a member's, wait for a first message.
  store.insertMembership({ id: 'own-a1', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active' });
  store.insertMembership({ id: 'guest-a1', agentId: 'a1', userId: GUEST, role: 'user', status: 'active' });
  store.insertChannel({ id: 'ch-a1', agentId: 'a1', kind: 'telegram', accountId: BOT, secretRef: 'channel/a1/telegram', deepLink: `https://t.me/${BOT}`, createdAt: 'now' });
  const kept = (s: Store) => JSON.parse(s.agentHold('a1', 'first-contact') ?? '[]') as Array<{ seat: string; down: boolean; left: number }>;
  return {
    db, provider, store, runtimeRef, kept,
    knock: (...k: Knock[]) => { knocks = k; },
    looks: () => looks,
  };
}

/** The next process: a new Store over the same database, and the start's resume of the watches. */
function nextProcess(m: Awaited<ReturnType<typeof machine>>, onWait: (store: Store) => void = () => {}) {
  const store = new Store(m.db);
  const events: Array<{ event: string; at: number; detail: Record<string, unknown> }> = [];
  resumeFirstContacts({
    store, providerFor: () => m.provider, logError: () => {},
    trace: () => (event, detail) => { events.push({ event, at: Date.now(), detail }); },
    sleep: async (ms) => { vi.setSystemTime(Date.now() + ms); onWait(store); },
  });
  return { store, events };
}

describe('a watch for a first message under way when the process ends (HB-0838)', () => {
  it('is watched again for the time it had left: a half hour that was twenty minutes in ends ten minutes after the restart', async () => {
    const m = await machine();
    const t0 = Date.now();
    void claimFirstContact({ store: m.store, provider: m.provider, sleep: () => new Promise(() => {}) },
      { agentId: 'a1', runtimeRef: m.runtimeRef, accountId: BOT, forUserId: OWNER, timeoutMs: 30 * MIN });
    await settle(() => m.looks() > 0);
    expect(m.kept(m.store)).toMatchObject([{ seat: `telegram:${OWNER}`, down: false, left: 30 * MIN }]);
    vi.setSystemTime(t0 + 20 * MIN);
    const next = nextProcess(m);
    await settle(() => next.events.some((e) => e.event === 'claim.window_closed'), 200_000);
    const ended = next.events.find((e) => e.event === 'claim.window_closed')!.at;
    expect(ended - t0).toBeGreaterThanOrEqual(30 * MIN);
    expect(ended - t0).toBeLessThan(30 * MIN + 10_000);
    expect(next.store.agentHold('a1', 'first-contact')).toBeUndefined();
    expect(next.store.pairingWindows('a1', new Date(0))).toEqual([]);
  });

  it('one that names its person, waiting for a stopped agent: the restart takes hours, and once the agent runs, their first message is still theirs', async () => {
    const m = await machine();
    const t0 = Date.now();
    // The agent is stopped five minutes in; the watch has seen it down, and the process ends there.
    const old = m.store;
    void claimFirstContact({
      store: old, provider: m.provider,
      sleep: async (ms) => {
        if (m.kept(old)[0]?.down) return new Promise<void>(() => {});
        vi.setSystemTime(Date.now() + ms);
        if (Date.now() >= t0 + 5 * MIN && old.getAgent('a1')!.state === 'RUNNING') old.setAgentState('a1', 'STOPPED');
      },
    }, { agentId: 'a1', runtimeRef: m.runtimeRef, accountId: BOT, forUserId: GUEST, expect: '@made_up_guest', timeoutMs: 30 * MIN });
    await settle(() => !!m.kept(old)[0]?.down, 200_000);
    // Its stored window was renewed a minute or so ahead while the agent was down: it has long lapsed by now.
    vi.setSystemTime(t0 + 3 * 60 * MIN);
    expect(old.pairingWindows('a1')).toEqual([]);
    // The agent is started half an hour into the next process; a stranger and then the person write.
    const next = nextProcess(m, (store) => {
      if (store.getAgent('a1')!.state !== 'STOPPED' || Date.now() < t0 + 3.5 * 60 * MIN) return;
      m.knock({ id: STRANGER, code: 'CODE0099', meta: { username: 'someone_else' } }, { id: GUEST_TG, code: 'CODE0002', meta: { username: 'made_up_guest' } });
      store.setAgentState('a1', 'RUNNING');
    });
    await settle(() => next.store.getMembership('a1', GUEST)?.channelUserId === GUEST_TG, 200_000);
    expect(m.provider.execLog.some((c) => c.join(' ').startsWith('pairing approve telegram CODE0099'))).toBe(false);
    await settle(() => next.store.agentHold('a1', 'first-contact') === undefined);
  });

  it('one open to anyone never runs past the hour from when it first opened: a stranger who writes once the agent is up again is not its owner', async () => {
    const m = await machine();
    const t0 = Date.now();
    const old = m.store;
    void claimFirstContact({
      store: old, provider: m.provider,
      sleep: async (ms) => {
        if (m.kept(old)[0]?.down) return new Promise<void>(() => {});
        vi.setSystemTime(Date.now() + ms);
        if (Date.now() >= t0 + 5 * MIN && old.getAgent('a1')!.state === 'RUNNING') old.setAgentState('a1', 'STOPPED');
      },
    }, { agentId: 'a1', runtimeRef: m.runtimeRef, accountId: BOT, forUserId: OWNER, timeoutMs: 30 * MIN });
    await settle(() => !!m.kept(old)[0]?.down, 200_000);
    // Restarted 50 minutes in, the agent still stopped, with 25 minutes of its half hour still to run; started 70 minutes in.
    vi.setSystemTime(t0 + 50 * MIN);
    const next = nextProcess(m, (store) => {
      if (store.getAgent('a1')!.state !== 'STOPPED' || Date.now() < t0 + 70 * MIN) return;
      m.knock({ id: STRANGER, code: 'CODE0099' });
      store.setAgentState('a1', 'RUNNING');
    });
    await settle(() => next.events.some((e) => e.event === 'claim.window_abandoned'), 200_000);
    const ended = next.events.find((e) => e.event === 'claim.window_abandoned')!;
    expect(ended.detail).toMatchObject({ reason: 'open-to-anyone' });
    expect(ended.at - t0).toBeGreaterThanOrEqual(60 * MIN);
    expect(ended.at - t0).toBeLessThan(61 * MIN);
    expect(next.store.agentHold('a1', 'first-contact')).toBeUndefined();
    next.store.setAgentState('a1', 'RUNNING');
    expect(next.store.getMembership('a1', OWNER)?.channelUserId).toBeUndefined();
    // Ran out while Hatchabot was down: let go at the start, its window closed, nothing watched.
    const m2 = await machine();
    const t1 = Date.now();
    void claimFirstContact({ store: m2.store, provider: m2.provider, sleep: () => new Promise(() => {}) },
      { agentId: 'a1', runtimeRef: m2.runtimeRef, accountId: BOT, forUserId: OWNER, timeoutMs: 30 * MIN });
    await settle(() => m2.looks() > 0);
    vi.setSystemTime(t1 + 61 * MIN);
    const late = nextProcess(m2);
    expect(late.store.agentHold('a1', 'first-contact')).toBeUndefined();
    expect(late.store.pairingWindows('a1', new Date(0))).toEqual([]);
    expect(late.events.map((e) => e.event)).toEqual(['claim.window_closed']);
  });

  it('one taken over since by a later watch of the seat is not watched again: the later one is', async () => {
    const m = await machine();
    void claimFirstContact({ store: m.store, provider: m.provider, sleep: () => new Promise(() => {}) },
      { agentId: 'a1', runtimeRef: m.runtimeRef, accountId: BOT, forUserId: GUEST, timeoutMs: 30 * MIN });
    await settle(() => m.looks() > 0);
    // A join of the same seat, kept by the invitations service itself: its window is the seat's now.
    void claimFirstContact({ store: m.store, provider: m.provider, sleep: () => new Promise(() => {}) },
      { agentId: 'a1', runtimeRef: m.runtimeRef, accountId: BOT, forUserId: GUEST, timeoutMs: 30 * MIN, kept: true });
    await settle(() => m.looks() > 1);
    const next = nextProcess(m);
    expect(next.store.agentHold('a1', 'first-contact')).toBeUndefined();
    expect(next.store.pairingWindows('a1')).toHaveLength(1); // the join's, for its own resume
    expect(next.events).toEqual([]);
  });
});

describe('through the routes, as src/index.ts starts them (HB-0838)', () => {
  it("the next process watches again: the person's first message is theirs, and the bot's earlier chatter's, sent first, is not", async () => {
    let w = await makeWorld();
    const first = w.f;
    const id = await seedRunningAgent(w, { members: [{ userId: GUEST, displayName: 'Guest' }] });
    const ref = w.store.getAgent(id)!.runtimeRef!;
    let knocks: Knock[] = [];
    let looks = 0;
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = async (r, script, opts) => {
      if (!script.includes('channel_pairing_requests')) return shell(r, script, opts);
      looks++;
      return { code: 0, stdout: JSON.stringify({ version: 1, requests: knocks }), stderr: '' };
    };
    w.provider.execResponses.set('pairing approve', { code: 0, stdout: 'ok', stderr: '' });
    try {
      // A window for them (as a reopened door or a bot attached opens one), never to claim the
      // bot's previous chatters: the process ends after its first look.
      void claimFirstContact({ store: w.store, provider: w.provider, sleep: () => new Promise(() => {}) },
        { agentId: id, runtimeRef: ref, accountId: 'kitchenbot', forUserId: GUEST, timeoutMs: 30 * MIN, excludeIds: [EARLIER] });
      await settle(() => looks > 0);
      // While Hatchabot restarts, the earlier chatter writes, and then the person it waits for.
      knocks = [{ id: EARLIER, code: 'CODE0007' }, { id: GUEST_TG, code: 'CODE0002' }];
      w = await restartWorld({ ...w, f: { close: async () => undefined } as never });
      await w.routes!.resumeOperations();
      // Was: nothing watched the window; their message showed as a knock to approve.
      await settle(() => w.store.getMembership(id, GUEST)?.channelUserId === GUEST_TG);
      expect(w.provider.execLog.some((c) => c.join(' ').startsWith('pairing approve telegram CODE0007'))).toBe(false);
      await settle(() => w.store.agentHold(id, 'first-contact') === undefined);
    } finally { await first.close(); await w.f.close(); }
  });
});
