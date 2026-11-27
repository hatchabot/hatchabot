import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { createMembersAndInvites, type MembersAndInvites } from '../src/orchestrator/members/membersAndInvites.js';
import { checkInvite, createInvite } from '../src/orchestrator/members/invite.js';
import { revokeMember } from '../src/orchestrator/members/members.js';
import { claimFirstContact, resumeFirstContacts } from '../src/orchestrator/members/claim.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { MemSecrets } from './support/world.js';

/**
 * A join to an agent that is not running (HB-0992, as the owner decided on
 * 2026-11-23). The join works, and is kept: the window for the joiner's
 * first message opens when the agent next starts, wakes or is rebuilt; a
 * sleeping agent is woken for it; the joiner is told it is not running. It
 * used to use up the invite and open nothing, and their first message was
 * dropped under the allowlist.
 *
 * Only where it is safe (the review of it): a window open to anyone ends an
 * hour after the join, time down included, so the first DM Telegram hands
 * over at a start days later, anyone's, never takes the seat. An invite that
 * names nobody is refused, and left as it is, for an agent that waits for
 * its owner to start it; one that names its person waits up to a week.
 *
 * The join waits in the store (the agent's `pending-joins` hold), so a
 * restart of Hatchabot while it waits loses nothing. A restart here is what
 * it is on a machine: a NEW Store and a NEW service over the same database
 * and machine, and the old process's watch left where it stood, never to
 * look again. Time is the test's own clock (only Date is faked). The bot,
 * the ids and the agent are made up.
 */
const OWNER = 'user-owner';
const OWNER_TG = '5550000001'; // the owner's own Telegram, linked: the door rests at the allowlist
const JOINER_TG = '5550000002';
const BOT = 'homework_helper_bot';
const MIN = 60_000;
/** The owner's word when a join's window ended unanswered (members/invitations.ts neverMessaged). */
const NEVER_MESSAGED = '⏳ Someone opened your invite to "Homework Helper" but never messaged it.';
/** The same when its time ran out while Hatchabot was not running: they may have written then (HB-0838 review). */
const RAN_OUT_WHILE_DOWN = '⏳ Someone opened your invite to "Homework Helper", but its time to message it ran out while Hatchabot was not watching for their message.';
/** The same when its window passed over who had written to the bot before the join: that may have been them (HB-1221 review). */
const PASSED_OVER = '⏳ Someone opened your invite to "Homework Helper", but no message from them was let in.';
/** A join whose window was still stored, and its agent failed, while nothing watched (HB-1523 review). */
const FAILED_UNWATCHED = '⏳ Someone opened your invite to "Homework Helper", but it was not watched while the agent had failed, so it was closed unused.';
const PASSED_OVER_DETAIL = 'Anyone who had already written to its bot when the invite was opened was passed over, as they might have got in first. If that was the person you invited, open that agent → Sharing → Members, press "Let them in again" and ask them to write again. To be sure only they get in, invite them by their @handle.';

interface Life { store: Store; members: MembersAndInvites; told: string[]; details: string[]; woken: string[] }

afterEach(() => { vi.useRealTimers(); });

/** Lets the watch run until `cond` holds (each look is a few promise turns). */
async function settle(cond: () => boolean, rounds = 5000): Promise<void> {
  for (let i = 0; i < rounds && !cond(); i++) await new Promise((r) => setImmediate(r));
  expect(cond()).toBe(true);
}

/** One machine: its database and its containers, and the Hatchabot processes that run on it in turn. */
function machine() {
  vi.useFakeTimers({ toFake: ['Date'] });
  const db = new Database(':memory:');
  const provider = new MockProvider();
  provider.execResponses.set('pairing approve', { code: 0, stdout: 'ok', stderr: '' });
  /** Someone writes to the bot (the joiner, @made_up_guest, by default): OpenClaw records a pairing request, as it does under `pairing`. */
  const theyWrite = (id = JOINER_TG, username = 'made_up_guest') => provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ requests: [{ id, code: `CODE${id.slice(-4)}`, meta: { firstName: 'Guest', username } }] }), stderr: '' });
  /**
   * A Hatchabot process. `dead`: one that has stopped, whose watch never
   * looks again. Otherwise each wait moves the clock on, and `onWait` may
   * change the world meanwhile (the agent started); `gate` holds a wait
   * until the test lets it go, and `trace` hears the trail.
   */
  const boot = (opts: {
    dead?: boolean; onWait?: (store: Store, ms: number) => void; gate?: () => Promise<void>; trace?: (event: string) => void;
    /**
     * What Telegram answers the bot's getUpdates (HB-1221): nothing waiting
     * unless a test says, or 'no answer'. Asked anything else, it throws.
     */
    waiting?: (() => unknown[]) | 'no answer';
  } = {}): Life => {
    const store = new Store(db);
    const life = { store, told: [], details: [], woken: [] } as unknown as Life;
    const secrets = new MemSecrets();
    secrets.map.set('channel/a1/telegram', 'made-up-bot-token');
    const waiting = opts.waiting ?? (() => []);
    life.members = createMembersAndInvites({
      store, secrets, providerFor: () => provider,
      trace: () => (event: string) => { opts.trace?.(event); },
      authMode: () => 'identity', localAccountsOn: () => false,
      consoleAccess: { ensureReady: async () => ({ ok: true }) as never, dropGuests: () => 0 },
      restDoor: async () => {}, forgetKnocks: () => {},
      opsPush: { waiting: async (_owner, headline, detail) => { life.told.push(headline); life.details.push(detail ?? ''); return true; } },
      wake: async (agent) => { life.woken.push(agent.id); },
      telegramFetch: async (url) => {
        if (waiting === 'no answer' || url !== 'https://api.telegram.org/botmade-up-bot-token/getUpdates?limit=100&timeout=0') throw new Error('Telegram did not answer');
        return new Response(JSON.stringify({ ok: true, result: waiting() }));
      },
      logError: () => {},
      sleep: opts.dead ? () => new Promise<void>(() => {}) : async (ms) => { await opts.gate?.(); vi.setSystemTime(Date.now() + ms); opts.onWait?.(store, ms); },
    });
    return life;
  };
  /** A stopped agent with a Telegram bot, its owner linked on it; asleep, in another state, or with no bot yet, when asked. */
  const agent = async (store: Store, opts: { asleep?: boolean; state?: 'REBUILDING' | 'PROVISIONING'; parked?: boolean; noBot?: boolean } = {}) => {
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} } as never);
    store.insertAgent({
      id: 'a1', ownerId: OWNER, name: 'Homework Helper', slug: 'a1', state: opts.state ?? 'STOPPED', aiProfileId: 'p1', hostId: 'h1',
      persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now', runtimeRef,
      ...(opts.parked ? { pendingAction: { type: 'bot_token', instructions: 'made up' } } : {}),
    } as never);
    if (opts.asleep) store.setHibernated('a1', new Date().toISOString(), 0);
    store.insertMembership({ id: 'own-a1', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active', channelUserId: OWNER_TG });
    if (!opts.noBot) store.insertChannel({ id: 'ch-a1', agentId: 'a1', kind: 'telegram', accountId: BOT, secretRef: 'channel/a1/telegram', deepLink: `https://t.me/${BOT}`, createdAt: 'now' });
    return runtimeRef;
  };
  /** The agent starts (a Start, a wake or a rebuild: the record says RUNNING, the container runs). */
  const start = (store: Store, runtimeRef: string) => { void provider.start(runtimeRef); store.setAgentState('a1', 'RUNNING'); };
  const join = async (life: Life, handle?: string) => {
    const { code } = createInvite(life.store, 'a1', OWNER, handle);
    const joined = await life.members.invites.joinOnApp({ code, name: 'Guest', accountId: undefined, joinKind: 'telegram', pre: checkInvite(life.store, code) });
    const member = life.store.listMemberships('a1').find((m) => m.role === 'user')!;
    return { joined, code, member };
  };
  /** The joins kept, as joined (where each one's watch stands is left out: see `kept`). */
  const held = (store: Store) => kept(store).map(({ userId, kind, at, expect }) => ({ userId, kind, at, ...(expect ? { expect } : {}) }));
  /** The joins kept, with where each one's watch stands (HB-0838). */
  const kept = (store: Store) => JSON.parse(store.agentHold('a1', 'pending-joins') ?? '[]') as Array<{ userId: string; kind: string; at: number; expect?: string; generation?: string; left?: number; down?: boolean; seen?: number }>;
  const policies = () => provider.execLog.filter((c) => c[0] === 'sh-volume' && c[1]!.includes('"policy":')).map((c) => /"policy":"(\w+)"/.exec(c[1]!)![1]);
  return { db, provider, boot, agent, start, join, held, kept, policies, theyWrite };
}

describe('a join to an agent that is not running (HB-0992)', () => {
  it('one for its very person works and is kept, opens the door for its build, and lets them in once the agent starts, however long it was stopped', async () => {
    const m = machine();
    let ref = '';
    let downFor = 0;
    // Stopped for two hours, past the hour a window open to anyone may run; then started.
    const life = m.boot({ onWait: (store, ms) => { downFor += ms; if (downFor >= 120 * MIN && store.getAgent('a1')!.state === 'STOPPED') { m.theyWrite(); m.start(store, ref); } } });
    ref = await m.agent(life.store);
    const t0 = Date.now();
    const { joined, code, member } = await m.join(life, '@made_up_guest');
    // The joiner is told, and still gets the way in.
    expect(joined).toMatchObject({ agentName: 'Homework Helper', channel: 'telegram', botUsername: BOT, notRunning: true });
    expect(checkInvite(life.store, code)).toEqual({ valid: false, reason: 'used' });
    // Kept, in the store; its window stored, so a build writes the door open; the door on the volume open now.
    expect(m.held(life.store)).toEqual([{ userId: member.userId, kind: 'telegram', at: t0, expect: 'made_up_guest' }]);
    expect(life.store.pairingWindows('a1').map((w) => w.seat)).toEqual([`telegram:${member.userId}`]);
    await settle(() => m.policies()[0] === 'pairing');
    await settle(() => life.store.getMembership('a1', member.userId)?.channelUserId === JOINER_TG);
    // Let in, said hello to, and let go: nothing waits any more, the door rests again.
    expect(m.provider.execLog.some((c) => c.join(' ').startsWith(`message send --channel telegram --account ${BOT} --target user:${JOINER_TG}`))).toBe(true);
    await settle(() => life.store.agentHold('a1', 'pending-joins') === undefined);
    expect(life.store.pairingWindows('a1')).toEqual([]);
    expect(m.policies().at(-1)).toBe('allowlist');
    expect(life.told).toEqual([]);
  });

  it('a restart while it waits loses nothing: the next process watches for it at boot, and lets them in when the agent starts', async () => {
    const m = machine();
    // The process the join came to: it stops (a restart) while the agent is still stopped, and never looks again.
    const first = m.boot({ dead: true });
    const ref = await m.agent(first.store);
    const { joined, member } = await m.join(first, '@made_up_guest');
    expect(joined).toMatchObject({ notRunning: true });
    expect(m.held(first.store)).toEqual([{ userId: member.userId, kind: 'telegram', at: Date.now(), expect: 'made_up_guest' }]);
    // The next process, over the same database and machine. The agent starts a few looks after its boot.
    let looks = 0;
    const next = m.boot({ onWait: (store) => { if (++looks === 3) { m.theyWrite(); m.start(store, ref); } } });
    expect(next.store.getMembership('a1', member.userId)?.channelUserId).toBeUndefined();
    next.members.invites.resumePendingJoins();
    await settle(() => next.store.getMembership('a1', member.userId)?.channelUserId === JOINER_TG);
    await settle(() => next.store.agentHold('a1', 'pending-joins') === undefined);
    expect(next.told).toEqual([]);
  });

  /**
   * A join to a running agent, the process the join came to ending after its
   * watch's first look (a restart), and the next one `after` that later (HB-0838).
   */
  const restartedWhileRunning = async (after: number, handle?: string) => {
    const m = machine();
    const first = m.boot({ dead: true });
    const ref = await m.agent(first.store);
    m.start(first.store, ref);
    const t0 = Date.now();
    const { joined, member } = await m.join(first, handle);
    expect(joined).not.toHaveProperty('notRunning');
    await settle(() => m.provider.execLog.some((c) => c[0] === 'sh' && c[1]!.includes('channel_pairing_requests')));
    expect(m.kept(first.store)).toMatchObject([{ userId: member.userId, down: false, left: 30 * MIN, seen: t0 }]);
    vi.setSystemTime(t0 + after);
    return { m, t0, member, ref };
  };

  it('HB-0838: a join to a running agent, restarted ten minutes in: watched again by the next process, which lets them in', async () => {
    const { m, member } = await restartedWhileRunning(10 * MIN, '@made_up_guest');
    m.theyWrite();
    const next = m.boot();
    next.members.invites.resumePendingJoins();
    // Was: nothing watched the window, and their message showed as a stranger's knock to approve.
    await settle(() => next.store.getMembership('a1', member.userId)?.channelUserId === JOINER_TG);
    await settle(() => next.store.agentHold('a1', 'pending-joins') === undefined);
    expect(next.told).toEqual([]);
  });

  it('HB-0838: restarted 29 minutes in, with nobody writing: its window ends at its half hour, not a half hour after the restart', async () => {
    const { m, t0, member } = await restartedWhileRunning(29 * MIN);
    const next = m.boot();
    next.members.invites.resumePendingJoins();
    await settle(() => next.store.agentHold('a1', 'pending-joins') === undefined, 200_000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30 * MIN);
    expect(Date.now() - t0).toBeLessThan(30 * MIN + 10_000); // was: an hour from the join
    expect(next.told).toEqual([NEVER_MESSAGED]);
    expect(next.store.pairingWindows('a1', new Date(0))).toEqual([]);
    expect(next.store.getMembership('a1', member.userId)?.channelUserId).toBeUndefined();
  });

  it('HB-1222: naming its person, restarted 20 minutes in, its agent up all along: its window ends at its half hour of up time, not 30 minutes after the restart', async () => {
    const { m, t0, member } = await restartedWhileRunning(20 * MIN, '@made_up_guest');
    const next = m.boot();
    next.members.invites.resumePendingJoins();
    await settle(() => next.store.agentHold('a1', 'pending-joins') === undefined, 200_000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30 * MIN);
    expect(Date.now() - t0).toBeLessThan(30 * MIN + 10_000);
    expect(next.told).toEqual([NEVER_MESSAGED]);
    expect(next.store.getMembership('a1', member.userId)?.channelUserId).toBeUndefined();
  });

  it('HB-1222: naming its person, to a stopped agent that then ran 20 minutes before a restart: the time it was up counts, the time it was down does not', async () => {
    const m = machine();
    let ref = '';
    let startedAt = 0;
    const t0 = Date.now();
    // Stopped for two hours, then started; the process ends 20 minutes after the start.
    const first = m.boot({ onWait: (store) => { if (!startedAt && Date.now() >= t0 + 2 * 60 * MIN) { m.start(store, ref); startedAt = Date.now(); } },
      gate: () => (startedAt && Date.now() >= startedAt + 20 * MIN ? new Promise<void>(() => {}) : Promise.resolve()) });
    ref = await m.agent(first.store);
    await m.join(first, '@made_up_guest');
    await settle(() => !!startedAt && Date.now() >= startedAt + 20 * MIN, 400_000);
    const next = m.boot();
    next.members.invites.resumePendingJoins();
    await settle(() => next.store.agentHold('a1', 'pending-joins') === undefined, 200_000);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30 * MIN);
    expect(Date.now() - startedAt).toBeLessThan(31 * MIN);
    expect(next.told).toEqual([NEVER_MESSAGED]);
  });

  it('HB-0838: open to anyone, its half hour run out while Hatchabot was down: not opened again, and a stranger who writes is not let in', async () => {
    const { m, member } = await restartedWhileRunning(45 * MIN);
    m.theyWrite('5550000099', 'someone_else');
    const next = m.boot();
    next.members.invites.resumePendingJoins();
    // Let go at once, as the watch would have at its half hour: the owner is told, and nothing is watched.
    expect(next.store.agentHold('a1', 'pending-joins')).toBeUndefined();
    expect(next.store.pairingWindows('a1', new Date(0))).toEqual([]);
    for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
    // Was: watched again until an hour from the join, and the stranger bound into the seat.
    expect(next.store.getMembership('a1', member.userId)?.channelUserId).toBeUndefined();
    expect(m.provider.execLog.some((c) => c[0] === 'pairing')).toBe(false);
    expect(next.told).toEqual([RAN_OUT_WHILE_DOWN]);
  });

  it('HB-0838: naming its person, Hatchabot down for three days: not opened again, even when they write', async () => {
    const { m, member } = await restartedWhileRunning(3 * 24 * 60 * MIN, '@made_up_guest');
    m.theyWrite();
    const next = m.boot();
    next.members.invites.resumePendingJoins();
    expect(next.store.agentHold('a1', 'pending-joins')).toBeUndefined();
    for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
    // Was: a fresh half hour from the restart, and their late message let in.
    expect(next.store.getMembership('a1', member.userId)?.channelUserId).toBeUndefined();
    expect(next.told).toEqual([RAN_OUT_WHILE_DOWN]);
  });

  it('HB-0838 review: a join whose window the owner\'s Reopen took over, naming the person, just before a restart: let go, and the Reopen is watched again, not the join', async () => {
    const { m, member, ref } = await restartedWhileRunning(0);
    // The owner's Reopen, for @made_up_guest only: the seat's window is its now. The process ends before the join's watch looks again.
    const before = m.provider.execLog.length;
    void claimFirstContact({ store: m.boot({ dead: true }).store, provider: m.provider, sleep: () => new Promise(() => {}) },
      { agentId: 'a1', runtimeRef: ref, accountId: BOT, forUserId: member.userId, expect: '@made_up_guest', timeoutMs: 30 * MIN });
    await settle(() => m.provider.execLog.slice(before).some((c) => c[0] === 'sh' && c[1]!.includes('channel_pairing_requests')));
    m.theyWrite('5550000099', 'someone_else');
    const next = m.boot();
    next.members.invites.resumePendingJoins();
    // The Reopen's watch, resumed: the stranger's knock is there for its first looks; its person writes at the third.
    let looks = 0;
    resumeFirstContacts({ store: next.store, providerFor: () => m.provider, trace: () => () => {}, logError: () => {},
      sleep: async (ms) => { vi.setSystemTime(Date.now() + ms); if (++looks === 3) m.theyWrite(); } });
    // The join is let go with nothing said; the seat's window is the Reopen's still, for its person only.
    expect(next.store.agentHold('a1', 'pending-joins')).toBeUndefined();
    expect(next.store.pairingWindows('a1')).toMatchObject([{ seat: `telegram:${member.userId}`, expect: 'made_up_guest' }]);
    await settle(() => next.store.getMembership('a1', member.userId)?.channelUserId !== undefined || next.store.pairingWindows('a1').length === 0);
    // Was: the join's own window again, open to anyone, and the stranger bound into the seat.
    expect(next.store.getMembership('a1', member.userId)?.channelUserId).toBe(JOINER_TG);
    expect(m.provider.execLog.some((c) => c.join(' ').startsWith('pairing approve telegram CODE0099'))).toBe(false);
    expect(next.told).toEqual([]);
  });

  it('HB-0838 review: naming its person, who writes ten minutes in while Hatchabot is down, back 45 minutes in: not let in, and the owner is told they may have written', async () => {
    const { m, t0, member } = await restartedWhileRunning(10 * MIN, '@made_up_guest');
    m.theyWrite(); // their own first message, inside their half hour, while nothing watches
    vi.setSystemTime(t0 + 45 * MIN);
    const next = m.boot();
    next.members.invites.resumePendingJoins();
    for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
    // Not let in: its window is never opened again once its time is up.
    expect(next.store.getMembership('a1', member.userId)?.channelUserId).toBeUndefined();
    // Was: "never messaged it", which was not true.
    expect(next.told).toEqual([RAN_OUT_WHILE_DOWN]);
    expect(next.details).toEqual(['They may have written meanwhile; if so, their message was not let in. If it is waiting under "Alerts", let them in there; if not, open that agent → Sharing → Members, press "Let them in again" and ask them to write again.']);
  });

  it('HB-0838 review: Hatchabot restarts just as a join\'s window ends unanswered (its window closed, the door being put back): the owner is told, once', async () => {
    const m = machine();
    const first = m.boot();
    const ref = await m.agent(first.store);
    m.start(first.store, ref);
    // The door's write back to the allowlist never answers: the process ends there.
    const vol = m.provider.execShellOnVolume.bind(m.provider);
    let hung = false;
    m.provider.execShellOnVolume = async (r, script, opts) => { if (script.includes('"policy":"allowlist"')) { hung = true; return new Promise(() => {}); } return vol(r, script, opts); };
    await m.join(first, '@made_up_guest');
    await settle(() => hung, 400_000);
    expect(first.store.pairingWindows('a1', new Date(0))).toEqual([]);
    expect(m.held(first.store)).toHaveLength(1);
    expect(first.told).toEqual([]);
    m.provider.execShellOnVolume = vol;
    const next = m.boot();
    next.members.invites.resumePendingJoins();
    for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
    // Was: let go with nothing said, its window closed taken for another watch's.
    expect(next.told).toEqual([NEVER_MESSAGED]);
    expect(m.held(next.store)).toEqual([]);
    const again = m.boot();
    again.members.invites.resumePendingJoins();
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    expect(again.told).toEqual([]);
  });

  it('HB-0838: a join to a stopped agent, restarted before it ran: its half hour still starts when the agent does (HB-0992)', async () => {
    const m = machine();
    const first = m.boot({ dead: true });
    const ref = await m.agent(first.store);
    const t0 = Date.now();
    await m.join(first, '@made_up_guest');
    await settle(() => m.kept(first.store)[0]?.down === true);
    vi.setSystemTime(t0 + 2 * 60 * MIN);
    // Started ten minutes into the next process; nobody writes.
    let startedAt = 0;
    const next = m.boot({ onWait: (store) => { if (!startedAt && Date.now() >= t0 + 130 * MIN) { m.start(store, ref); startedAt = Date.now(); } } });
    next.members.invites.resumePendingJoins();
    await settle(() => next.store.agentHold('a1', 'pending-joins') === undefined, 400_000);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30 * MIN);
    expect(Date.now() - startedAt).toBeLessThan(31 * MIN);
    expect(next.told).toEqual([NEVER_MESSAGED]);
  });

  it('one for its very person runs from the start: unanswered half an hour after it, it ends, the join is let go, and the owner is told', async () => {
    const m = machine();
    let ref = '', startedAt = 0, endedAt = 0;
    const t0 = Date.now();
    // Stopped for three hours, then started; nobody writes.
    const life = m.boot({ onWait: (store) => { if (!startedAt && Date.now() >= t0 + 3 * 60 * MIN) { m.start(store, ref); startedAt = Date.now(); } } });
    ref = await m.agent(life.store);
    const { member } = await m.join(life, '@made_up_guest');
    await settle(() => { if (!endedAt && life.told.length) endedAt = Date.now(); return life.told.length > 0; }, 200_000);
    expect(life.told).toEqual([NEVER_MESSAGED]);
    expect(endedAt - startedAt).toBeGreaterThanOrEqual(30 * MIN);
    expect(endedAt - startedAt).toBeLessThan(32 * MIN);
    expect(life.store.agentHold('a1', 'pending-joins')).toBeUndefined();
    expect(life.store.getMembership('a1', member.userId)?.channelUserId).toBeUndefined();
  });

  it('at boot, a join with nothing left to wait for is let go: its member removed, or the agent put away', async () => {
    for (const gone of ['removed', 'archived'] as const) {
      const m = machine();
      const first = m.boot({ dead: true });
      await m.agent(first.store);
      const { member } = await m.join(first, '@made_up_guest');
      const next = m.boot();
      if (gone === 'removed') next.store.revokeMembership('a1', member.userId);
      else next.store.setAgentState('a1', 'ARCHIVED');
      next.members.invites.resumePendingJoins();
      expect(next.store.agentHold('a1', 'pending-joins'), gone).toBeUndefined();
      vi.useRealTimers();
    }
  });

  it('an invite that names nobody is refused, and left as it is, for an agent its owner has to start; for one asleep, rebuilding or setting up it is kept', async () => {
    const refused = { refused: 'conflict', error: "Homework Helper isn't running right now. Ask its owner to start it, then open this invite again: it is still good." };
    // Parked at its bot step with no bot yet too: a bot attached later opens a window for its owner only.
    for (const how of [{}, { noBot: true }, { state: 'PROVISIONING', parked: true }, { state: 'PROVISIONING', parked: true, noBot: true }] as const) {
      const m = machine();
      const life = m.boot({ dead: true });
      await m.agent(life.store, how);
      const { joined, code } = await m.join(life);
      expect(joined, JSON.stringify(how)).toEqual(refused);
      expect(checkInvite(life.store, code).valid).toBe(true);
      expect(life.store.listMemberships('a1').filter((x) => x.role === 'user')).toEqual([]);
      expect(life.store.agentHold('a1', 'pending-joins')).toBeUndefined();
      expect(life.store.pairingWindows('a1', new Date(0))).toEqual([]);
      vi.useRealTimers();
    }
    for (const how of [{ asleep: true }, { state: 'REBUILDING' }, { state: 'PROVISIONING' }] as const) {
      const m = machine();
      const life = m.boot({ dead: true });
      await m.agent(life.store, how);
      const { joined, member } = await m.join(life);
      expect(joined, JSON.stringify(how)).toMatchObject({ notRunning: true });
      expect(m.held(life.store)).toEqual([{ userId: member.userId, kind: 'telegram', at: Date.now() }]);
      vi.useRealTimers();
    }
  });

  it('one open to anyone, to a sleeping agent that stays down for days: its hour runs from the join, and a DM handed over at the start, anyone\'s, is not let in', async () => {
    const m = machine();
    let ref = '';
    const t0 = Date.now();
    let endedAt = 0;
    // The wake came to nothing: it starts three days on, and Telegram hands over a stranger's DM.
    const life = m.boot({ onWait: (store) => { if (store.getAgent('a1')!.state === 'STOPPED' && Date.now() >= t0 + 3 * 24 * 60 * MIN) { m.theyWrite('5550000099', 'someone_else'); m.start(store, ref); } } });
    ref = await m.agent(life.store, { asleep: true });
    const { joined, member } = await m.join(life);
    expect(joined).toMatchObject({ notRunning: true });
    await settle(() => { if (!endedAt && life.told.length) endedAt = Date.now(); return life.told.length > 0; }, 200_000);
    expect(endedAt - t0).toBeGreaterThanOrEqual(60 * MIN);
    expect(endedAt - t0).toBeLessThan(61 * MIN);
    expect(life.store.agentHold('a1', 'pending-joins')).toBeUndefined();
    expect(life.store.pairingWindows('a1', new Date(0))).toEqual([]);
    // Nobody is let in, then or at the start.
    life.store.setAgentState('a1', 'RUNNING');
    expect(life.store.getMembership('a1', member.userId)?.channelUserId).toBeUndefined();
    expect(m.provider.execLog.some((c) => c[0] === 'pairing')).toBe(false);
  });

  it('one open to anyone, to a sleeping agent woken within minutes: the joiner\'s first message is let in', async () => {
    const m = machine();
    let ref = '';
    const t0 = Date.now();
    const life = m.boot({ onWait: (store) => { if (store.getAgent('a1')!.state === 'STOPPED' && Date.now() >= t0 + 2 * MIN) { m.theyWrite(); m.start(store, ref); } } });
    ref = await m.agent(life.store, { asleep: true });
    const { member } = await m.join(life);
    await settle(() => life.store.getMembership('a1', member.userId)?.channelUserId === JOINER_TG);
    await settle(() => life.store.agentHold('a1', 'pending-joins') === undefined);
    expect(life.told).toEqual([]);
  });

  /** A DM waiting for the bot, sent at `date` (Telegram's seconds), as getUpdates gives it; or a message in a group the bot is in. */
  const dm = (updateId: number, from: string, date: number, chat: 'private' | 'group' = 'private') => ({ update_id: updateId, message: {
    message_id: updateId, date, chat: chat === 'private' ? { id: Number(from), type: 'private' } : { id: -1009990001, type: 'group', title: 'Made-up Club' },
    from: { id: Number(from), is_bot: false, first_name: 'Someone' }, text: 'hello' } });
  /** At the wake, OpenClaw's list: the stranger who wrote while it slept first, then the joiner. */
  const strangerFirst = (m: ReturnType<typeof machine>, stranger: string) => m.provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ requests: [
    { id: stranger, code: 'CODE0099', meta: { firstName: 'Someone' } }, { id: JOINER_TG, code: 'CODE0002', meta: { firstName: 'Guest', username: 'made_up_guest' } }] }), stderr: '' });

  it('HB-1221: open to anyone, to a sleeping agent: a stranger who wrote while it slept, handed over first at the wake, is not let in; the joiner is', async () => {
    const STRANGER = '5550000099';
    const m = machine();
    let ref = '';
    const t0 = Date.now();
    const asked: number[] = [];
    let atWake: unknown;
    // Woken two minutes on; the stranger's DM (sent a little before the join) comes in first.
    const life = m.boot({
      waiting: () => { asked.push(Date.now()); return [dm(700, STRANGER, Math.floor(t0 / 1000) - 10)]; },
      onWait: (store) => {
        if (store.getAgent('a1')!.state !== 'STOPPED' || Date.now() < t0 + 2 * MIN) return;
        // The window's row says who it never lets in, through its renewals while down (the knocks read it: HB-1221 review).
        atWake = store.pairingWindows('a1').map((w) => w.excludeIds);
        strangerFirst(m, STRANGER); m.start(store, ref);
      },
    });
    ref = await m.agent(life.store, { asleep: true });
    const { joined, member } = await m.join(life);
    expect(joined).toMatchObject({ notRunning: true });
    // Asked once, at the join, while it still slept; kept with the join for a restart.
    expect(asked).toEqual([t0]);
    expect(m.kept(life.store)).toMatchObject([{ userId: member.userId, excludeIds: [STRANGER] }]);
    await settle(() => life.store.getMembership('a1', member.userId)?.channelUserId === JOINER_TG);
    expect(atWake).toEqual([[STRANGER]]);
    expect(life.store.getActiveMembershipByChannelUser('a1', STRANGER)).toBeUndefined();
    expect(m.provider.execLog.filter((c) => c[0] === 'pairing').map((c) => c[3])).toEqual(['CODE0002']);
    await settle(() => life.store.agentHold('a1', 'pending-joins') === undefined);
    expect(life.told).toEqual([]);
  });

  it('HB-1441: a message to a Telegram Business account the bot is connected to, sent before the join, passes its sender over too', async () => {
    const STRANGER = '5550000099';
    const m = machine();
    const t0 = Date.now();
    const life = m.boot({ dead: true, waiting: () => [{ update_id: 700, business_message: {
      business_connection_id: 'made-up-connection', message_id: 700, date: Math.floor(t0 / 1000) - 10,
      chat: { id: Number(STRANGER), type: 'private' }, from: { id: Number(STRANGER), is_bot: false, first_name: 'Someone' }, text: 'hello' } }] });
    await m.agent(life.store, { asleep: true });
    const { joined, member } = await m.join(life);
    expect(joined).toMatchObject({ notRunning: true });
    // Was: only message and edited_message were read, and the sender was not passed over.
    expect(m.kept(life.store)).toMatchObject([{ userId: member.userId, excludeIds: [STRANGER] }]);
  });

  it('HB-1221: restarted before the wake, the next process still passes over who wrote while it slept', async () => {
    const STRANGER = '5550000099';
    const m = machine();
    let ref = '';
    const t0 = Date.now();
    const first = m.boot({ dead: true, waiting: () => [dm(700, STRANGER, Math.floor(t0 / 1000) - 10)] });
    ref = await m.agent(first.store, { asleep: true });
    const { member } = await m.join(first);
    vi.setSystemTime(t0 + 5 * MIN);
    // The next process asks Telegram nothing: what it passes over is kept with the join.
    const next = m.boot({ onWait: (store) => { if (store.getAgent('a1')!.state === 'STOPPED') { strangerFirst(m, STRANGER); m.start(store, ref); } } });
    next.members.invites.resumePendingJoins();
    await settle(() => next.store.getMembership('a1', member.userId)?.channelUserId === JOINER_TG);
    expect(next.store.getActiveMembershipByChannelUser('a1', STRANGER)).toBeUndefined();
    await settle(() => next.store.agentHold('a1', 'pending-joins') === undefined);
  });

  it('HB-1221 review: its window run out with nobody let in, after passing over someone who had written first: the owner is told that, not that nobody wrote', async () => {
    const STRANGER = '5550000099';
    const m = machine();
    let ref = '';
    const t0 = Date.now();
    // Woken two minutes on: the only knock is the one passed over (it may be the invitee's own), and nobody else writes.
    const life = m.boot({
      waiting: () => [dm(700, STRANGER, Math.floor(t0 / 1000) - 10)],
      onWait: (store) => { if (store.getAgent('a1')!.state === 'STOPPED' && Date.now() >= t0 + 2 * MIN) { m.theyWrite(STRANGER, 'someone_else'); m.start(store, ref); } },
    });
    ref = await m.agent(life.store, { asleep: true });
    const { member } = await m.join(life);
    await settle(() => life.told.length > 0, 200_000);
    // Was: "never messaged it", untrue if the one passed over was them.
    expect(life.told).toEqual([PASSED_OVER]);
    expect(life.details).toEqual([PASSED_OVER_DETAIL]);
    expect(life.store.getMembership('a1', member.userId)?.channelUserId).toBeUndefined();
    expect(m.provider.execLog.some((c) => c[0] === 'pairing')).toBe(false);
  });

  it('HB-1221 review: who is let in on the agent already (its owner, a member) is nobody passed over, though their messages are still in the page: the owner is told only that nobody wrote', async () => {
    const KID_TG = '5550000003';
    const m = machine();
    let ref = '';
    const t0 = Date.now();
    // The gateway's last batch stays unconfirmed: the owner's own DM, and a member's, are still in the page.
    const life = m.boot({
      waiting: () => [dm(700, OWNER_TG, Math.floor(t0 / 1000) - 3600), dm(701, KID_TG, Math.floor(t0 / 1000) - 600)],
      onWait: (store) => {
        if (store.getAgent('a1')!.state === 'STOPPED' && Date.now() >= t0 + 2 * MIN) {
          m.provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ requests: [] }), stderr: '' });
          m.start(store, ref);
        }
      },
    });
    ref = await m.agent(life.store, { asleep: true });
    life.store.insertMembership({ id: 'm-kid', agentId: 'a1', userId: 'acct-kid', role: 'user', status: 'active', channelUserId: KID_TG });
    await m.join(life);
    const member = life.store.listMemberships('a1').find((x) => x.role === 'user' && x.userId !== 'acct-kid')!;
    // Was: both kept as passed over, and the owner told that someone who had written first was.
    expect(m.kept(life.store)).toEqual([expect.not.objectContaining({ excludeIds: expect.anything() })]);
    await settle(() => life.told.length > 0, 200_000);
    expect(life.told).toEqual([NEVER_MESSAGED]);
    expect(life.store.getMembership('a1', member.userId)?.channelUserId).toBeUndefined();
  });

  it('HB-1221: Telegram not answering at the join: the window is open to the first message, as before, and the trail says so', async () => {
    const m = machine();
    const events: string[] = [];
    const life = m.boot({ dead: true, trace: (e) => events.push(e), waiting: 'no answer' });
    await m.agent(life.store, { asleep: true });
    const { joined, member } = await m.join(life);
    expect(joined).toMatchObject({ notRunning: true });
    expect(m.held(life.store)).toEqual([{ userId: member.userId, kind: 'telegram', at: Date.now() }]);
    expect(events).toContain('invite.waiting_unread');
  });

  it('HB-1221 review: what the joiner did elsewhere before the join (a group message, a button, starting the bot) passes nobody over: only a DM can ask to pair', async () => {
    const m = machine();
    let ref = '';
    const t0 = Date.now();
    const sent = Math.floor(t0 / 1000) - 600;
    const from = { id: Number(JOINER_TG), is_bot: false, first_name: 'Guest' };
    const life = m.boot({
      waiting: () => [
        dm(700, JOINER_TG, sent, 'group'),
        { update_id: 701, callback_query: { id: 'made-up-query', from, chat_instance: '1', data: 'x' } },
        { update_id: 702, my_chat_member: { chat: { id: Number(JOINER_TG), type: 'private' }, from, date: sent, old_chat_member: {}, new_chat_member: {} } },
      ],
      onWait: (store) => { if (store.getAgent('a1')!.state === 'STOPPED' && Date.now() >= t0 + 2 * MIN) { m.theyWrite(); m.start(store, ref); } },
    });
    ref = await m.agent(life.store, { asleep: true });
    const { member } = await m.join(life);
    // Was: their id passed over, so their DM at the wake was never let in, and the owner told they never messaged it.
    expect(m.held(life.store)).toEqual([{ userId: member.userId, kind: 'telegram', at: t0 }]);
    expect(m.kept(life.store)).toEqual([expect.not.objectContaining({ excludeIds: expect.anything() })]);
    await settle(() => life.store.getMembership('a1', member.userId)?.channelUserId === JOINER_TG);
    await settle(() => life.store.agentHold('a1', 'pending-joins') === undefined);
    expect(life.told).toEqual([]);
  });

  it('HB-1221 review: a full page of messages waiting may hide another sender: the join cannot tell, says so on the trail, and passes nobody over', async () => {
    const CHATTY = '5550000077';
    const m = machine();
    const t0 = Date.now();
    const events: string[] = [];
    // Telegram hands over the oldest 100, all one sender's; the stranger's DM is the 101st, unseen.
    const life = m.boot({ dead: true, trace: (e) => events.push(e),
      waiting: () => Array.from({ length: 100 }, (_, i) => dm(600 + i, CHATTY, Math.floor(t0 / 1000) - 30)) });
    await m.agent(life.store, { asleep: true });
    const { joined, member } = await m.join(life);
    expect(joined).toMatchObject({ notRunning: true });
    // Was: the page taken for everything, CHATTY passed over, the stranger not, and nothing on the trail.
    expect(m.kept(life.store)).toEqual([expect.not.objectContaining({ excludeIds: expect.anything() })]);
    expect(m.held(life.store)).toEqual([{ userId: member.userId, kind: 'telegram', at: t0 }]);
    expect(events).toContain('invite.waiting_unread');
  });

  it('someone known from another of the owner\'s agents, by an invite that names nobody, is let in once it runs, and only they are: stopped, or asleep', async () => {
    const STRANGER = '5550000099';
    for (const asleep of [false, true]) {
      const m = machine();
      let ref = '';
      const t0 = Date.now();
      // Up ten minutes on (started, or woken); a stranger's DM came in first, then theirs.
      const life = m.boot({ onWait: (store) => {
        if (store.getAgent('a1')!.state !== 'STOPPED' || Date.now() < t0 + 10 * MIN) return;
        m.provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ requests: [
          { id: STRANGER, code: 'CODE0099', meta: { firstName: 'Someone' } }, { id: JOINER_TG, code: 'CODE0002', meta: { firstName: 'Guest' } }] }), stderr: '' });
        m.start(store, ref);
      } });
      ref = await m.agent(life.store, { asleep });
      // They are on another of the owner's agents, their Telegram linked there.
      life.store.insertAgent({ id: 'a2', ownerId: OWNER, name: 'Garden Club', slug: 'a2', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
        persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
      life.store.insertMembership({ id: 'm-a2', agentId: 'a2', userId: 'acct-joiner', role: 'user', status: 'active', channelUserId: JOINER_TG });
      const { code } = createInvite(life.store, 'a1', OWNER);
      const joined = await life.members.invites.joinOnApp({ code, name: 'Guest', accountId: 'acct-joiner', joinKind: 'telegram', pre: checkInvite(life.store, code) });
      expect(joined, asleep ? 'asleep' : 'stopped').toMatchObject({ notRunning: true });
      // Their window is for their id: a week, as for an invite that named them.
      expect(m.held(life.store)).toEqual([{ userId: 'acct-joiner', kind: 'telegram', at: t0, expect: JOINER_TG }]);
      await settle(() => life.store.getMembership('a1', 'acct-joiner')?.channelUserId === JOINER_TG);
      expect(life.store.getActiveMembershipByChannelUser('a1', STRANGER)).toBeUndefined();
      await settle(() => life.store.agentHold('a1', 'pending-joins') === undefined);
      vi.useRealTimers();
    }
  });

  it('at boot, a join is watched for the time it has left: its hour, or its week, counts from the join, not from the boot', async () => {
    // Open to anyone, the agent asleep: the next process boots 20 minutes on; the agent stays down; it ends an hour after the join.
    {
      const m = machine();
      const t0 = Date.now();
      const first = m.boot({ dead: true });
      await m.agent(first.store, { asleep: true });
      await m.join(first);
      vi.setSystemTime(t0 + 20 * MIN);
      let endedAt = 0;
      const next = m.boot();
      next.members.invites.resumePendingJoins();
      await settle(() => { if (!endedAt && next.told.length) endedAt = Date.now(); return next.told.length > 0; }, 200_000);
      expect(endedAt - t0).toBeGreaterThanOrEqual(60 * MIN);
      expect(endedAt - t0).toBeLessThan(61 * MIN);
      expect(next.store.agentHold('a1', 'pending-joins')).toBeUndefined();
      vi.useRealTimers();
    }
    // Its time ran out while Hatchabot was down (two hours on; or, for its very person, eight days on): let go at once, the owner told, no door opened.
    for (const [handle, after] of [[undefined, 2 * 60 * MIN], ['@made_up_guest', 8 * 24 * 60 * MIN]] as const) {
      const m = machine();
      const t0 = Date.now();
      const first = m.boot({ dead: true });
      await m.agent(first.store, { asleep: !handle });
      await m.join(first, handle);
      // The door the first process opened for it, before it stopped.
      await settle(() => m.policies()[0] === 'pairing');
      const doorsBefore = m.policies().length;
      vi.setSystemTime(t0 + after);
      const next = m.boot();
      next.members.invites.resumePendingJoins();
      expect(next.store.agentHold('a1', 'pending-joins'), String(handle)).toBeUndefined();
      expect(next.told).toEqual([RAN_OUT_WHILE_DOWN]);
      for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
      expect(m.policies().length).toBe(doorsBefore);
      vi.useRealTimers();
    }
  });

  it('the same seat joined again (removed, invited again): the first join\'s watch, taken over, lets go of nothing and tells nobody, and a restart still has the second', async () => {
    const m = machine();
    const events: string[] = [];
    let looks = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    // The first join's watch takes a few looks at the stopped agent, then is held there.
    const life = m.boot({ trace: (e) => events.push(e), gate: async () => { if (++looks > 5) await held; } });
    await m.agent(life.store);
    const joinAs = async (on: Life) => {
      const { code } = createInvite(on.store, 'a1', OWNER, '@made_up_guest');
      return on.members.invites.joinOnApp({ code, name: 'Guest', accountId: 'acct-guest', joinKind: 'telegram', pre: checkInvite(on.store, code) });
    };
    await joinAs(life);
    await settle(() => looks > 5);
    const firstAt = m.held(life.store)[0]!.at;
    // Removed, invited again and joined again: its watch is another process's, which never looks again.
    await revokeMember({ store: life.store, provider: m.provider }, 'a1', 'acct-guest');
    vi.setSystemTime(Date.now() + MIN);
    const second = m.boot({ dead: true });
    await joinAs(second);
    const kept = m.held(life.store);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.at).toBeGreaterThan(firstAt);
    release();
    await settle(() => events.includes('claim.window_superseded'));
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    expect(m.held(life.store)).toEqual(kept);
    expect(life.told).toEqual([]);
    // A restart: the second join is still there to watch.
    const next = m.boot({ dead: true });
    next.members.invites.resumePendingJoins();
    expect(m.held(next.store)).toEqual(kept);
    expect(next.store.pairingWindows('a1').map((w) => w.seat)).toEqual(['telegram:acct-guest']);
  });

  it('taken over by the owner\'s Reopen once the agent runs: the join is let go, with nothing said, and a restart opens nothing for it', async () => {
    const m = machine();
    const events: string[] = [];
    let looks = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const life = m.boot({ trace: (e) => events.push(e), gate: async () => { if (++looks > 3) await held; } });
    const ref = await m.agent(life.store);
    const { member } = await m.join(life, '@made_up_guest');
    expect(m.held(life.store)).toHaveLength(1);
    await settle(() => looks > 3);
    m.start(life.store, ref);
    // "Let them in again" (roster.reopen starts this watcher, which knows nothing of the join); it never looks again here.
    void claimFirstContact({ store: life.store, provider: m.provider, sleep: () => new Promise<void>(() => {}) },
      { agentId: 'a1', runtimeRef: ref, accountId: BOT, kind: 'telegram', forUserId: member.userId, expect: '@made_up_guest', timeoutMs: 30 * MIN });
    await settle(() => life.store.pairingWindows('a1').length === 1 && looks > 3);
    release();
    await settle(() => events.includes('claim.window_superseded'));
    await settle(() => life.store.agentHold('a1', 'pending-joins') === undefined);
    expect(life.told).toEqual([]);
    // The Reopen's window ends unclaimed; a restart two hours on has nothing to watch.
    life.store.closePairingWindow('a1', `telegram:${member.userId}`);
    vi.setSystemTime(Date.now() + 2 * 60 * MIN);
    const next = m.boot({ dead: true });
    next.members.invites.resumePendingJoins();
    expect(next.store.pairingWindows('a1', new Date(0))).toEqual([]);
    expect(next.told).toEqual([]);
  });

  it('HB-1224: in a deploy\'s overlap the newer process takes a kept join up while the older one still watches it: the older one, taken over, leaves it to the newer, and a later restart still has it', async () => {
    const m = machine();
    const events: string[] = [];
    let looks = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    // The older process's watch takes a couple of looks, then is held there while the newer one boots.
    const older = m.boot({ trace: (e) => events.push(e), gate: async () => { if (++looks > 2) await held; } });
    const ref = await m.agent(older.store);
    m.start(older.store, ref);
    const { member } = await m.join(older, '@made_up_guest');
    await settle(() => looks > 2);
    // The newer process takes the join up at its boot, with a window of its own; it is stopped before it looks again.
    const newer = m.boot({ dead: true });
    newer.members.invites.resumePendingJoins();
    const theirs = newer.store.pairingWindows('a1')[0]!.generation;
    expect(m.kept(newer.store)).toMatchObject([{ userId: member.userId, generation: theirs }]);
    release();
    await settle(() => events.includes('claim.window_superseded'));
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    // Was: the older watch, taken over with the same join time, let the join go, and nothing watched it after the next restart.
    expect(m.kept(newer.store)).toMatchObject([{ userId: member.userId, generation: theirs }]);
    expect(older.told).toEqual([]);
    m.theyWrite();
    const next = m.boot();
    next.members.invites.resumePendingJoins();
    await settle(() => next.store.getMembership('a1', member.userId)?.channelUserId === JOINER_TG);
    await settle(() => next.store.agentHold('a1', 'pending-joins') === undefined);
    expect(next.told).toEqual([]);
  });

  it('a join to a running agent opens its window at once, and is kept for a restart all the same (HB-0838); one to a sleeping agent asks for a wake', async () => {
    const m = machine();
    const life = m.boot({ dead: true });
    const ref = await m.agent(life.store);
    m.start(life.store, ref);
    const { joined, member } = await m.join(life);
    expect(joined).not.toHaveProperty('notRunning');
    expect(m.held(life.store)).toEqual([{ userId: member.userId, kind: 'telegram', at: Date.now() }]);
    expect(life.store.pairingWindows('a1')).toHaveLength(1);
    // As a join, not as a watch of claim.ts's own: the next start watches it once.
    expect(life.store.agentHold('a1', 'first-contact')).toBeUndefined();
    // Asleep: woken; stopped by its owner: left stopped.
    life.store.setAgentState('a1', 'STOPPED');
    life.members.invites.wakeForJoin('a1');
    life.store.setHibernated('a1', new Date().toISOString(), 0);
    life.members.invites.wakeForJoin('a1');
    expect(life.woken).toEqual(['a1']);
  });
});

describe('what the owner is told when a join ends (HB-1219, HB-1223, HB-1412)', () => {
  it('HB-1219: a Discord join nobody wrote to points the owner to the agent\'s Members, under Sharing, not to its Telegram tab', async () => {
    const m = machine();
    const life = m.boot();
    const ref = await m.agent(life.store);
    life.store.insertChannel({ id: 'ch-a1-d', agentId: 'a1', kind: 'discord', accountId: 'hatchabot', secretRef: 'channel/a1/discord', deepLink: 'https://discord.com/users/100000000000000001', createdAt: 'now' });
    m.start(life.store, ref);
    const { code } = createInvite(life.store, 'a1', OWNER, '@made_up_guest');
    await life.members.invites.joinOnApp({ code, name: 'Guest', accountId: undefined, joinKind: 'discord', pre: checkInvite(life.store, code) });
    await settle(() => life.told.length > 0, 200_000);
    expect(life.told).toEqual([NEVER_MESSAGED]);
    // Was: "Open that agent → Telegram → Members", a tab with no Members, for every app.
    expect(life.details).toEqual(['Open that agent → Sharing → Members and press "Let them in again" when they are ready.']);
  });

  it('HB-1223: a member removed while their window waits: its end, unanswered or with a stranger knocking, tells the owner nothing', async () => {
    for (const knock of [false, true]) {
      const m = machine();
      const events: string[] = [];
      let member: { userId: string } | undefined;
      let removed = false;
      // Ten minutes into the window the owner removes them; with `knock`, a stranger writes after that.
      const life = m.boot({ trace: (e) => events.push(e), onWait: (store) => {
        if (removed || !member || Date.now() < t0 + 10 * MIN) return;
        removed = true;
        store.revokeMembership('a1', member.userId);
        if (knock) m.theyWrite('5550000099', 'someone_else');
      } });
      const ref = await m.agent(life.store);
      m.start(life.store, ref);
      const t0 = Date.now();
      ({ member } = await m.join(life, knock ? undefined : '@made_up_guest'));
      await settle(() => life.store.agentHold('a1', 'pending-joins') === undefined, 200_000);
      expect(removed).toBe(true);
      expect(events).toContain(knock ? 'claim.seat_gone' : 'claim.window_closed');
      // Was: "Someone opened your invite … but never messaged it", for someone the owner had removed.
      expect(life.told, `knock: ${knock}`).toEqual([]);
      vi.useRealTimers();
    }
  });

  it('HB-1412 review: a join that passed someone over, its window run out and closed just before a restart: the next start says no message from them was let in, as the watch would have', async () => {
    const STRANGER = '5550000099';
    const m = machine();
    let ref = '';
    const t0 = Date.now();
    // Asleep, someone had written first; woken two minutes on, and nobody writes.
    const first = m.boot({
      waiting: () => [{ update_id: 700, message: { message_id: 700, date: Math.floor(t0 / 1000) - 10, chat: { id: Number(STRANGER), type: 'private' },
        from: { id: Number(STRANGER), is_bot: false, first_name: 'Someone' }, text: 'hello' } }],
      onWait: (store) => { if (store.getAgent('a1')!.state === 'STOPPED' && Date.now() >= t0 + 2 * MIN) m.start(store, ref); },
    });
    ref = await m.agent(first.store, { asleep: true });
    // The door's write back to the allowlist, as its window ends, never answers: the process ends there.
    const vol = m.provider.execShellOnVolume.bind(m.provider);
    let hung = false;
    m.provider.execShellOnVolume = async (r, script, opts) => { if (script.includes('"policy":"allowlist"')) { hung = true; return new Promise(() => {}); } return vol(r, script, opts); };
    await m.join(first);
    expect(m.kept(first.store)).toMatchObject([{ excludeIds: [STRANGER] }]);
    await settle(() => hung, 400_000);
    expect(first.store.pairingWindows('a1', new Date(0))).toEqual([]);
    expect(first.told).toEqual([]);
    m.provider.execShellOnVolume = vol;
    const next = m.boot();
    next.members.invites.resumePendingJoins();
    // Was: "never messaged it", untrue if the one passed over was them.
    expect(next.told).toEqual([PASSED_OVER]);
    expect(next.details).toEqual([PASSED_OVER_DETAIL]);
  });

  it('HB-1412: a join whose window its watch gave up (the agent moved, or failed), Hatchabot restarting before the watch told the owner: the next start tells them, once', async () => {
    for (const end of ['moved', 'failed'] as const) {
      const m = machine();
      const events: string[] = [];
      let ended = false;
      // After the watch's first look (nobody has written), the agent moves to another machine and is up there, or fails.
      const first = m.boot({ trace: (e) => events.push(e), onWait: (store) => {
        if (ended) return;
        ended = true;
        if (end === 'moved') store.setAgentHost('a1', 'h2');
        else store.setAgentState('a1', 'FAILED');
      } });
      const ref = await m.agent(first.store);
      first.store.insertHost({ id: 'h2', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'other box', settings: {}, createdAt: 'now' });
      m.start(first.store, ref);
      // The door's write back to the allowlist, once the window is given up, never answers: the process ends there.
      const vol = m.provider.execShellOnVolume.bind(m.provider);
      let hung = false;
      m.provider.execShellOnVolume = async (r, script, opts) => { if (script.includes('"policy":"allowlist"')) { hung = true; return new Promise(() => {}); } return vol(r, script, opts); };
      await m.join(first, '@made_up_guest');
      await settle(() => hung, 400_000);
      expect(events, end).toContain('claim.window_abandoned');
      expect(first.store.pairingWindows('a1', new Date(0))).toEqual([]);
      expect(m.held(first.store)).toHaveLength(1);
      expect(first.told).toEqual([]);
      m.provider.execShellOnVolume = vol;
      const next = m.boot();
      next.members.invites.resumePendingJoins();
      for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
      // Was: let go with nothing said, though the watch, had it not been cut off, said it.
      expect(next.told, end).toEqual([NEVER_MESSAGED]);
      expect(m.held(next.store)).toEqual([]);
      const again = m.boot();
      again.members.invites.resumePendingJoins();
      expect(again.told).toEqual([]);
      vi.useRealTimers();
    }
  });
});

describe('two processes at once, in a deploy\'s overlap: one note per join (HB-1520)', () => {
  it('the older watch gives the window up as its agent fails, and the newer process boots before it says so: the owner is told once', async () => {
    const m = machine();
    let failed = false;
    // After the watch's first look the agent fails; its write of the door back to rest is slow.
    const older = m.boot({ onWait: (store) => { if (!failed) { failed = true; store.setAgentState('a1', 'FAILED'); } } });
    const ref = await m.agent(older.store);
    m.start(older.store, ref);
    const vol = m.provider.execShellOnVolume.bind(m.provider);
    let resting = false;
    let letRestLand: () => void = () => {};
    const restHeld = new Promise<void>((r) => { letRestLand = r; });
    m.provider.execShellOnVolume = async (r, script, opts) => { if (script.includes('"policy":"allowlist"')) { resting = true; await restHeld; } return vol(r, script, opts); };
    await m.join(older, '@made_up_guest');
    await settle(() => resting, 400_000);
    // The newer process boots meanwhile, and says it.
    const newer = m.boot();
    newer.members.invites.resumePendingJoins();
    expect(newer.told).toEqual([NEVER_MESSAGED]);
    // The older one's write lands, and its watch ends.
    letRestLand();
    for (let i = 0; i < 500; i++) await new Promise((r) => setImmediate(r));
    // Was: the older process said it too.
    expect(older.told).toEqual([]);
    expect(m.held(newer.store)).toEqual([]);
  });

  it("the newer process's window for a kept join ends first, unanswered: the older watch, finding it gone, says nothing", async () => {
    const m = machine();
    let looks = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const older = m.boot({ gate: async () => { if (++looks > 2) await held; } });
    const ref = await m.agent(older.store);
    m.start(older.store, ref);
    await m.join(older, '@made_up_guest');
    await settle(() => looks > 2);
    // The newer process takes the join up at its boot and watches it to its end; nobody writes.
    const newer = m.boot();
    newer.members.invites.resumePendingJoins();
    await settle(() => newer.told.length > 0, 400_000);
    expect(newer.told).toEqual([NEVER_MESSAGED]);
    expect(newer.store.pairingWindows('a1', new Date(0))).toEqual([]);
    // The older watch looks again: its window is gone.
    release();
    for (let i = 0; i < 500; i++) await new Promise((r) => setImmediate(r));
    // Was: "never messaged" from the older process too.
    expect(older.told).toEqual([]);
  });

  it('a window and where its watch stands are written in one go: another process never reads the window without them', async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), 'hb-overlap-'));
    const dbs = [new Database(joinPath(dir, 'hatchabot.db')), new Database(joinPath(dir, 'hatchabot.db'))];
    try {
      // Two processes' connections to one database file.
      const mine = new Store(dbs[0]!);
      const theirs = new Store(dbs[1]!);
      const provider = new MockProvider();
      mine.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
      mine.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
      const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} } as never);
      mine.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Homework Helper', slug: 'a1', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
        persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now', runtimeRef } as never);
      // What the other process reads the moment the window is written.
      const read: Array<{ windows: number; watch: boolean }> = [];
      const open = mine.openPairingWindow.bind(mine);
      mine.openPairingWindow = (...args: Parameters<Store['openPairingWindow']>) => {
        const generation = open(...args);
        read.push({ windows: theirs.pairingWindows('a1', new Date(0)).length, watch: theirs.agentHold('a1', 'first-contact') !== undefined });
        return generation;
      };
      // The watch is let look once, and then waits for good (the database is closed after it).
      let waiting = false;
      void claimFirstContact({ store: mine, provider, sleep: () => { waiting = true; return new Promise<void>(() => {}); } },
        { agentId: 'a1', runtimeRef, accountId: BOT, forUserId: OWNER, timeoutMs: 30 * MIN });
      await settle(() => waiting);
      // Was: the window was there for the other process before what its watch keeps of it.
      expect(read[0]).toEqual({ windows: 0, watch: false });
      expect(theirs.pairingWindows('a1')).toHaveLength(1);
      expect(theirs.agentHold('a1', 'first-contact')).toBeDefined();
    } finally {
      for (const db of dbs) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a list of joins changed since it was read is not written over: the second of two processes reads it again', () => {
    const store = new Store(new Database(':memory:'));
    store.setAgentHold('a1', 'pending-joins', '["first"]');
    expect(store.replaceAgentHold('a1', 'pending-joins', '["stale"]', '[]')).toBe(false);
    expect(store.agentHold('a1', 'pending-joins')).toBe('["first"]');
    expect(store.replaceAgentHold('a1', 'pending-joins', '["first"]', '["second"]')).toBe(true);
    expect(store.agentHold('a1', 'pending-joins')).toBe('["second"]');
  });
});

describe('a join whose agent failed while nothing watched it (HB-1523)', () => {
  it('its window still stored at the next start: closed, and the owner told once; a Reopen\'s window since is left to the Reopen; one another process let go is left to it', async () => {
    for (const how of ['alone', 'reopened', 'let go by another'] as const) {
      const reopened = how === 'reopened';
      const m = machine();
      const events: string[] = [];
      // The process stops right after the watch's first look: it never sees what comes next.
      const first = m.boot({ dead: true });
      const ref = await m.agent(first.store);
      m.start(first.store, ref);
      const { member } = await m.join(first, '@made_up_guest');
      await settle(() => m.kept(first.store)[0]?.generation !== undefined);
      expect(first.store.pairingWindows('a1')).toHaveLength(1);
      // The agent fails while Hatchabot is down.
      first.store.setAgentState('a1', 'FAILED');
      // With `reopened`, the owner's Reopen wrote the seat's window again before the failure (another watch's now).
      if (reopened) first.store.openPairingWindow('a1', new Date(Date.now() + 30 * MIN).toISOString(), member.userId, { kind: 'telegram', expect: '@made_up_guest' });
      const next = m.boot({ trace: (e) => events.push(e) });
      if (how === 'let go by another') {
        // The other process in a deploy's overlap lets the join go between this one's read of it and its own let-go.
        const read = next.store.agentHold.bind(next.store);
        let reads = 0;
        next.store.agentHold = ((agentId: string, kind: string) => {
          if (kind === 'pending-joins' && ++reads === 2) next.store.clearAgentHold(agentId, 'pending-joins');
          return read(agentId, kind as never);
        }) as never;
      }
      next.members.invites.resumePendingJoins();
      expect(m.held(next.store), how).toEqual([]);
      if (how === 'alone') {
        // Was: let go with nothing said, and its window kept until its time ran out.
        expect(next.store.pairingWindows('a1', new Date(0))).toEqual([]);
        expect(events).toContain('claim.window_abandoned');
        // Was: "never messaged it", though nothing watched for their message.
        expect(next.told).toEqual([FAILED_UNWATCHED]);
      } else {
        // The Reopen's window, or the other process's to close: left, and nothing said here.
        expect(next.store.pairingWindows('a1', new Date(0)), how).toHaveLength(1);
        expect(events, how).not.toContain('claim.window_abandoned');
        expect(next.told, how).toEqual([]);
      }
      const again = m.boot();
      again.members.invites.resumePendingJoins();
      expect(again.told).toEqual([]);
      vi.useRealTimers();
    }
  });
});

describe('POST /v1/join to an agent that is not running (HB-0992)', () => {
  it('asleep: answers that it is not running, and wakes it once the join has let go of its turn; stopped by its owner, an invite that names nobody is refused and still good', async () => {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    const f = Fastify();
    // Telegram, asked at the join who has written to the sleeping bot (HB-1221): nobody. Never the real one.
    const telegram: string[] = [];
    const oauthFetch = async (url: string) => { telegram.push(url.replace(/bot[^/]+\//, 'bot…/')); return new Response(JSON.stringify({ ok: true, result: [] })); };
    const routes = await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} } as never,
      providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false } } as never, oauthFetch } as never);
    try {
      store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
      store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
      const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} } as never);
      store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Homework Helper', slug: 'a1', state: 'STOPPED', aiProfileId: 'p1', hostId: 'h1',
        persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now', runtimeRef } as never);
      store.setHibernated('a1', new Date().toISOString(), 0);
      store.insertMembership({ id: 'own-a1', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active', channelUserId: OWNER_TG });
      store.insertChannel({ id: 'ch-a1', agentId: 'a1', kind: 'telegram', accountId: BOT, secretRef: 'channel/a1/telegram', deepLink: `https://t.me/${BOT}`, createdAt: 'now' });
      const { code } = createInvite(store, 'a1', OWNER);
      const r = await f.inject({ method: 'POST', url: '/v1/join', payload: { code, name: 'Guest', channel: 'telegram' } });
      expect(r.statusCode).toBe(201);
      expect(r.json()).toMatchObject({ botUsername: BOT, notRunning: true });
      expect(telegram).toEqual(['https://api.telegram.org/bot…/getUpdates?limit=100&timeout=0']);
      await settle(() => store.getAgent('a1')?.state === 'RUNNING');
      expect(store.getAgent('a1')?.hibernatedAt).toBeUndefined();
      expect(JSON.parse(store.agentHold('a1', 'pending-joins') ?? '[]')).toHaveLength(1);
      // Stopped by its owner: refused, before the invite is used.
      store.setAgentState('a1', 'STOPPED');
      const again = createInvite(store, 'a1', OWNER).code;
      const no = await f.inject({ method: 'POST', url: '/v1/join', payload: { code: again, name: 'Guest 2', channel: 'telegram' } });
      expect(no.statusCode).toBe(409);
      expect(no.json()).toEqual({ error: "Homework Helper isn't running right now. Ask its owner to start it, then open this invite again: it is still good." });
      expect(checkInvite(store, again).valid).toBe(true);
    } finally { routes.stop(); await f.close(); }
  });
});
