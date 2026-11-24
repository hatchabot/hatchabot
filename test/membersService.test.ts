import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { createMembersAndInvites, type MembersAndInvites } from '../src/orchestrator/members/membersAndInvites.js';
import { checkInvite, createInvite, InviteInvalidError } from '../src/orchestrator/members/invite.js';
import { RevokeError } from '../src/orchestrator/members/members.js';
import type { Agent, Channel } from '../src/domain/types.js';
import { DISCORD_ID } from './support/fixtures.js';
import { MemSecrets } from './support/world.js';

/**
 * The members, invites and web chat service (HB-0808), driven as the routes
 * drive it but with no HTTP server: who may be invited, who joins and how,
 * a member removed, and who is offered for web chat. A real store on an
 * in-memory database; a runtime provider that is never reached (each case
 * stays off the volume: a stopped agent, or a member known on no app), a
 * fake gateway list and door. The people are made up.
 */
const OWNER = 'user-owner';   // owns the machine and the agents
const SAM = 'user-sam';       // signs in with Google
const PAT = 'user-pat';       // signs in with Google; owns an agent of their own
const RAE = 'user-rae';       // signs in with Google; nobody's member

interface World {
  store: Store;
  db: Database.Database;
  secrets: MemSecrets;
  members: MembersAndInvites;
  /** The gateway's list kept in step: `ensureReady` reasons, and the guests dropped. */
  ready: Array<{ agentId: string; why: string }>;
  dropped: Array<{ agentId: string; userId?: string }>;
  doors: string[];
  traced: string[];
  woken: string[];
  agent(id: string, opts?: { owner?: string; state?: Agent['state']; ops?: boolean; allowKnocks?: boolean }): Agent;
  channel(agentId: string, kind: Channel['kind'], accountId: string): Channel;
}

function world(opts: { authMode?: 'password' | 'accounts' | 'identity'; passwords?: boolean; telegramFetch?: (url: string, init: { signal: AbortSignal }) => Promise<Response>; handleLookMs?: number } = {}): World {
  const db = new Database(':memory:');
  const store = new Store(db);
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  for (const [id, email] of [[OWNER, 'owner@example.com'], [SAM, 'sam@example.com'], [PAT, 'pat@example.com'], [RAE, 'rae@example.com']]) store.recordAccount(id!, email);
  store.insertLocalAccount({ id: 'acct-robin', username: 'robin', displayName: 'Robin', pwHash: 'made-up', pwSalt: 'made-up', hostOwner: false, disabled: false, createdAt: 'now' } as never);
  const w = { store, db, secrets: new MemSecrets(), ready: [], dropped: [], doors: [], traced: [], woken: [] } as unknown as World;
  const neverReached = new Proxy({}, { get: (_t, name) => { throw new Error(`the runtime was reached (${String(name)})`); } });
  w.members = createMembersAndInvites({
    store, secrets: w.secrets,
    providerFor: () => neverReached as never,
    trace: () => (event) => { w.traced.push(event); },
    authMode: () => opts.authMode ?? 'identity',
    localAccountsOn: () => opts.passwords ?? true,
    consoleAccess: {
      ensureReady: async (agent, why) => { w.ready.push({ agentId: agent.id, why: why ?? 'open' }); return { ok: true } as never; },
      dropGuests: (agentId, userId) => { w.dropped.push({ agentId, userId }); return 0; },
    },
    restDoor: async (agent) => { w.doors.push(agent.id); },
    forgetKnocks: () => {},
    opsPush: { waiting: async () => true },
    wake: async (agent) => { w.woken.push(agent.id); },
    telegramFetch: opts.telegramFetch ?? (async () => { throw new Error('Telegram was asked'); }),
    ...(opts.handleLookMs ? { handleLookMs: opts.handleLookMs } : {}),
    logError: () => {},
    // A first-message window's watch ends at its first wait: these cases stay off the volume.
    sleep: () => Promise.reject(new Error('the test ends the watch here')),
  });
  w.agent = (id, o = {}) => {
    store.insertAgent({
      id, ownerId: o.owner ?? OWNER, name: `Agent ${id}`, slug: id, state: o.state ?? 'STOPPED', aiProfileId: 'p1', hostId: 'h1',
      persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now', runtimeRef: `rt-${id}`,
    } as never);
    store.insertMembership({ id: `own-${id}`, agentId: id, userId: o.owner ?? OWNER, role: 'owner', status: 'active' });
    if (o.ops) store.setAgentOps(id, true);
    if (o.allowKnocks) store.setAllowKnocks(id, true);
    return store.getAgent(id)!;
  };
  w.channel = (agentId, kind, accountId) => {
    store.insertChannel({ id: `ch-${agentId}-${kind}`, agentId, kind, accountId, secretRef: `channel/${agentId}/${kind}`, deepLink: `https://example.invalid/${accountId}`, createdAt: 'now' });
    return store.getChannelForAgent(agentId, kind)!;
  };
  return w;
}

describe('who may be invited', () => {
  it('makes a single-use code; a web-chat invite names nobody and is said on the timeline', () => {
    const w = world();
    const a = w.agent('a1');
    const plain = w.members.invites.invite(a, OWNER, { forHandle: '@robin_t' });
    expect(plain).toMatchObject({ code: expect.stringMatching(/^[A-Z2-9]{10}$/) });
    expect(w.store.getInviteByCode((plain as { code: string }).code)?.expectHandle).toBe('robin_t');
    const web = w.members.invites.invite(a, OWNER, { forHandle: '@robin_t', webChat: true }) as { code: string };
    expect(w.store.getInviteByCode(web.code)).toMatchObject({ webChat: true, expectHandle: undefined });
    expect(w.traced).toEqual(['invite.web_chat']);
  });

  it('refuses web chat where nobody signs in, before it refuses the management agent', () => {
    const w = world({ authMode: 'password' });
    const ops = w.agent('ops', { ops: true });
    expect(w.members.invites.invite(ops, OWNER, { webChat: true })).toMatchObject({ refused: 'invalid', error: expect.stringContaining('needs people to sign in') });
    expect(w.members.invites.invite(ops, OWNER, {})).toEqual({ refused: 'ops-alone' });
  });

  it('holds the door for a Telegram invite only: its own agent, not expired, a bot, running; open already says so', async () => {
    const w = world();
    const a = w.agent('a1');
    const other = w.agent('a2');
    const { code } = createInvite(w.store, a.id, OWNER);
    const web = createInvite(w.store, a.id, OWNER, undefined, { webChat: true }).code;
    expect(await w.members.invites.holdKnockWindow(w.agent('ops', { ops: true }), code)).toEqual({ refused: 'ops-alone' });
    expect(await w.members.invites.holdKnockWindow(other, code)).toEqual({ refused: 'not-found', error: 'Not found' });
    expect(await w.members.invites.holdKnockWindow(a, web)).toEqual({ refused: 'not-found', error: 'Not found' });
    expect(await w.members.invites.holdKnockWindow(a, code)).toMatchObject({ refused: 'conflict', error: 'This agent has no Telegram bot yet.' });
    w.channel(a.id, 'telegram', 'kitchen_bot');
    expect(await w.members.invites.holdKnockWindow(a, ` ${code.toLowerCase()} `)).toMatchObject({ refused: 'conflict', error: expect.stringContaining('Start the agent first') });
    w.store.setAgentState(a.id, 'RUNNING');
    w.store.setAllowKnocks(a.id, true);
    expect(await w.members.invites.holdKnockWindow(w.store.getAgent(a.id)!, code)).toEqual({ open: true, minutes: 0, alreadyOpen: true });
    const old = createInvite(w.store, a.id, OWNER).code;
    w.db.prepare('UPDATE invites SET expires_at = ? WHERE code = ?').run('2000-01-01T00:00:00.000Z', old);
    expect(await w.members.invites.holdKnockWindow(w.store.getAgent(a.id)!, old)).toMatchObject({ refused: 'expired' });
  });
});

describe('who joins', () => {
  it('a web-chat invite lets a signed-in person in at once with web chat, once, and never the owner', () => {
    const w = world();
    const a = w.agent('a1', { state: 'RUNNING' });
    const { code } = createInvite(w.store, a.id, OWNER, undefined, { webChat: true });
    expect(w.members.invites.joinForWebChat(code, 'Owner', OWNER)).toMatchObject({ refused: 'invalid', error: expect.stringContaining('your own agent') });
    expect(checkInvite(w.store, code).valid).toBe(true);
    expect(w.members.invites.joinForWebChat(code, '  Sam  ', SAM)).toEqual({ agentName: 'Agent a1', agentId: 'a1', webChat: true });
    expect(w.store.getMembership(a.id, SAM)).toMatchObject({ status: 'active', webChat: true, displayName: 'Sam' });
    expect(w.ready).toEqual([{ agentId: 'a1', why: 'grant' }]);
    expect(w.members.invites.joinForWebChat(code, 'Rae', RAE)).toEqual({ refused: 'invalid', error: 'This invite was already used. Ask for a new one.' });
  });

  it('a chat-app join is refused, the code kept, when the app it names is gone since the page loaded', async () => {
    const w = world();
    const a = w.agent('a1');
    w.channel(a.id, 'telegram', 'kitchen_bot');
    const { code } = createInvite(w.store, a.id, OWNER);
    const pre = checkInvite(w.store, code);
    expect(await w.members.invites.joinOnApp({ code, name: 'Pat', accountId: undefined, joinKind: 'slack', pre }))
      .toEqual({ refused: 'conflict', error: 'Agent a1 is no longer on Slack. Your invite is still good: reload this page to see the apps it is on now.' });
    expect(checkInvite(w.store, code).valid).toBe(true);
  });

  it('a chat-app join makes a member, records the app, and offers every way in; a stopped agent\'s join waits for its next start, if the invite names its person (HB-0992)', async () => {
    const w = world();
    const a = w.agent('a1');
    w.channel(a.id, 'telegram', 'kitchen_bot');
    // Named nobody: refused, the code kept, while it waits for its owner to start it.
    const anyone = createInvite(w.store, a.id, OWNER).code;
    expect(await w.members.invites.joinOnApp({ code: anyone, name: '', accountId: undefined, joinKind: 'telegram', pre: checkInvite(w.store, anyone) }))
      .toEqual({ refused: 'conflict', error: "Agent a1 isn't running right now. Ask its owner to start it, then open this invite again: it is still good." });
    expect(checkInvite(w.store, anyone).valid).toBe(true);
    const { code } = createInvite(w.store, a.id, OWNER, '@robin_t');
    const joined = await w.members.invites.joinOnApp({ code, name: '', accountId: undefined, joinKind: 'telegram', pre: checkInvite(w.store, code) });
    expect(joined).toEqual({
      agentName: 'Agent a1', channel: 'telegram', botUsername: 'kitchen_bot', deepLink: 'https://example.invalid/kitchen_bot',
      channels: [{ kind: 'telegram', deepLink: 'https://example.invalid/kitchen_bot' }], notRunning: true,
    });
    const member = w.store.listMemberships(a.id).find((m) => m.role === 'user')!;
    expect(member).toMatchObject({ displayName: 'Guest', status: 'active' });
    // Kept for its next start, with the window for their first message (test/pendingJoins.test.ts follows it through).
    expect(JSON.parse(w.store.agentHold(a.id, 'pending-joins')!)).toMatchObject([{ userId: member.userId, kind: 'telegram', at: expect.any(Number), expect: 'robin_t' }]);
    expect(w.store.pairingWindows(a.id).map((x) => x.seat)).toEqual([`telegram:${member.userId}`]);
    // Stopped by its owner, not asleep: nothing to wake.
    w.members.invites.wakeForJoin(a.id);
    expect(w.woken).toEqual([]);
    expect(w.store.inviteJoinFor(a.id, member.userId).via).toBe('telegram');
    expect(checkInvite(w.store, code)).toEqual({ valid: false, reason: 'used' });
    await expect(w.members.invites.joinOnApp({ code, name: 'Again', accountId: undefined, joinKind: 'telegram', pre: checkInvite(w.store, code) }))
      .rejects.toBeInstanceOf(InviteInvalidError);
  });
});

describe('a named invite for someone known from other agents (HB-1146)', () => {
  const setup = (answer: (n: number) => Promise<Response>, handleLookMs?: number) => {
    const asked: string[] = [];
    const w = world({ handleLookMs, telegramFetch: async (url, init) => { expect(init.signal).toBeInstanceOf(AbortSignal); asked.push(url); return answer(asked.length); } });
    // Sam is on thirteen of the owner's agents, each with a bot that knows their id.
    for (let i = 1; i <= 13; i++) {
      const id = `b${String(i).padStart(2, '0')}`;
      w.agent(id);
      const ch = w.channel(id, 'telegram', `bot_${id}`);
      void w.secrets.put(ch.secretRef, `made-up-token-${id}`);
      w.store.insertMembership({ id: `m-${id}`, agentId: id, userId: SAM, role: 'user', status: 'active' });
      w.store.bindMembershipChannelUser(id, SAM, '41001');
    }
    const t = w.agent('t1');
    w.channel(t.id, 'telegram', 'target_bot');
    const { code } = createInvite(w.store, t.id, OWNER, '@sam_k');
    const join = () => w.members.invites.joinOnApp({ code, name: 'Sam', accountId: SAM, joinKind: 'telegram', pre: checkInvite(w.store, code) });
    return { w, asked, join };
  };
  it('Telegram unreachable: asked once, not once per bot, and the join goes on to their first message', async () => {
    for (const fail of [() => Promise.reject(new TypeError('fetch failed')), () => Promise.reject(new DOMException('timed out', 'TimeoutError')), async () => new Response('<html>bad gateway</html>', { status: 502 })]) {
      const { w, asked, join } = setup(fail);
      expect(await join()).toMatchObject({ agentName: 'Agent t1', notRunning: true });
      expect(asked).toHaveLength(1);
      expect(w.traced).toContain('invite.handle_unchecked');
    }
  });
  it('the look ends on time while a token is read, and between bots, and says it did not check (HB-1146)', async () => {
    const inTime = <T>(p: Promise<T>) => Promise.race([p, new Promise<'too long'>((r) => setTimeout(() => r('too long'), 3000))]);
    // The secret store never answers.
    const stuck = setup(async () => Response.json({ ok: true, result: { username: 'sam_k' } }), 50);
    stuck.w.secrets.get = () => new Promise(() => {});
    expect(await inTime(stuck.join())).toMatchObject({ agentName: 'Agent t1', notRunning: true });
    expect(stuck.asked).toEqual([]);
    expect(stuck.w.traced.filter((e) => e === 'invite.handle_unchecked')).toHaveLength(1);
    // Each bot says it cannot see them, slowly: the limit passes between two of them.
    const slow = setup(() => new Promise((r) => setTimeout(() => r(Response.json({ ok: false, description: 'Bad Request: chat not found' })), 40)), 100);
    expect(await inTime(slow.join())).toMatchObject({ agentName: 'Agent t1', notRunning: true });
    expect(slow.asked.length).toBeLessThan(13);
    expect(slow.w.traced.filter((e) => e === 'invite.handle_unchecked')).toHaveLength(1);
  });
  it("the limit passing while the last bot's token is read is said too (HB-1146)", async () => {
    const asked: string[] = [];
    const w = world({ handleLookMs: 50, telegramFetch: async (url) => { asked.push(url); return Response.json({ ok: true, result: { username: 'sam_k' } }); } });
    // The agent joined listed first, and the one bot that knows Sam's id last.
    const t = w.agent('a0');
    w.channel(t.id, 'telegram', 'target_bot');
    w.agent('b01');
    const ch = w.channel('b01', 'telegram', 'bot_b01');
    w.store.insertMembership({ id: 'm-b01', agentId: 'b01', userId: SAM, role: 'user', status: 'active' });
    w.store.bindMembershipChannelUser('b01', SAM, '41001');
    const get = w.secrets.get.bind(w.secrets);
    w.secrets.get = (ref: string) => (ref === ch.secretRef ? new Promise(() => {}) : get(ref));
    w.db.prepare('UPDATE agents SET sort_order = ? WHERE id = ?').run(1, 'a0');
    w.db.prepare('UPDATE agents SET sort_order = ? WHERE id = ?').run(2, 'b01');
    expect(w.store.listAgents(OWNER).map((a) => a.id)).toEqual(['a0', 'b01']);
    const { code } = createInvite(w.store, t.id, OWNER, '@sam_k');
    expect(await w.members.invites.joinOnApp({ code, name: 'Sam', accountId: SAM, joinKind: 'telegram', pre: checkInvite(w.store, code) })).toMatchObject({ agentName: 'Agent a0' });
    expect(asked).toEqual([]);
    expect(w.traced.filter((e) => e === 'invite.handle_unchecked')).toHaveLength(1);
  });
  it('a bot Telegram says cannot see them is passed over for the next, which can', async () => {
    const { w, asked, join } = setup(async (n) => Response.json(n < 4 ? { ok: false, description: 'Bad Request: chat not found' } : { ok: true, result: { username: 'Sam_K' } }));
    expect(await join()).toMatchObject({ agentName: 'Agent t1' });
    expect(asked).toHaveLength(4);
    expect(w.traced).not.toContain('invite.handle_unchecked');
  });
});

describe('the members', () => {
  it('lists the active ones, marking who signs in here', () => {
    const w = world();
    const a = w.agent('a1');
    w.store.insertMembership({ id: 'm1', agentId: a.id, userId: SAM, role: 'user', displayName: 'Sam', status: 'active' });
    w.store.insertMembership({ id: 'm2', agentId: a.id, userId: 'member-telegram-only', role: 'user', displayName: 'Kit', status: 'active' });
    w.store.insertMembership({ id: 'm3', agentId: a.id, userId: RAE, role: 'user', displayName: 'Rae', status: 'active' });
    w.store.revokeMembership(a.id, RAE);
    const list = w.members.roster.list(a);
    expect(list.map((m) => [m.userId, m.account]).sort()).toEqual([['member-telegram-only', false], [OWNER, true], [SAM, true]]);
  });

  it('turns web chat on only for someone who signs in here, never the owner; off closes their console', () => {
    const w = world();
    const a = w.agent('a1', { state: 'RUNNING' });
    w.store.insertMembership({ id: 'm1', agentId: a.id, userId: SAM, role: 'user', displayName: 'Sam', status: 'active' });
    w.store.insertMembership({ id: 'm2', agentId: a.id, userId: 'member-telegram-only', role: 'user', displayName: 'Kit', status: 'active' });
    expect(w.members.roster.setWebChat(a, RAE, true)).toEqual({ refused: 'not-found', error: 'Not a member of this agent.' });
    expect(w.members.roster.setWebChat(a, OWNER, true)).toEqual({ refused: 'invalid', error: 'You can always chat with your own agent.' });
    expect(w.members.roster.setWebChat(a, 'member-telegram-only', true)).toMatchObject({ refused: 'conflict' });
    expect(w.members.roster.setWebChat(a, 'member-telegram-only', false)).toEqual({ userId: 'member-telegram-only', webChat: false });
    expect(w.members.roster.setWebChat(a, SAM, true)).toEqual({ userId: SAM, webChat: true });
    expect(w.store.webChatAllowed(a.id, SAM)).toBe(true);
    expect(w.members.roster.setWebChat(a, SAM, false)).toEqual({ userId: SAM, webChat: false });
    expect(w.dropped).toEqual([{ agentId: 'a1', userId: 'member-telegram-only' }, { agentId: 'a1', userId: SAM }]);
    expect(w.ready.map((r) => r.why)).toEqual(['removal', 'grant', 'removal']);
  });

  it('removes a member: the row revoked, their consoles closed, the gateway told; the owner stays', async () => {
    const w = world();
    const a = w.agent('a1', { state: 'RUNNING' });
    w.store.insertMembership({ id: 'm1', agentId: a.id, userId: SAM, role: 'user', displayName: 'Sam', status: 'active', webChat: true });
    expect(await w.members.roster.remove(a, SAM)).toEqual({ revoked: true });
    expect(w.store.getMembership(a.id, SAM)?.status).toBe('revoked');
    expect(w.dropped).toEqual([{ agentId: 'a1', userId: SAM }]);
    expect(w.ready).toEqual([{ agentId: 'a1', why: 'removal' }]);
    await expect(w.members.roster.remove(a, OWNER)).rejects.toBeInstanceOf(RevokeError);
    expect(w.store.getMembership(a.id, OWNER)?.status).toBe('active');
  });

  it('reopens the door only on the app they joined with, or for a named handle; refuses the rest in order', () => {
    const w = world();
    const ops = w.agent('ops', { ops: true }) as Agent & { runtimeRef: string };
    expect(w.members.roster.reopen(ops, SAM, undefined)).toEqual({ refused: 'ops-alone' });
    const a = w.agent('a1') as Agent & { runtimeRef: string };
    expect(w.members.roster.reopen(a, SAM, undefined)).toEqual({ refused: 'not-found', error: 'Not a member of this agent.' });
    w.store.insertMembership({ id: 'm1', agentId: a.id, userId: SAM, role: 'user', displayName: 'Sam', status: 'active' });
    expect(w.members.roster.reopen(a, SAM, undefined)).toEqual({ refused: 'conflict', error: 'This agent is not in a chat app yet.' });
    w.channel(a.id, 'telegram', 'kitchen_bot');
    expect(w.members.roster.reopen(a, SAM, undefined)).toEqual({ refused: 'conflict', error: 'Start the agent first.' });
    w.store.setAgentState(a.id, 'RUNNING');
    const running = w.store.getAgent(a.id) as Agent & { runtimeRef: string };
    expect(w.members.roster.reopen(running, SAM, undefined)).toMatchObject({ refused: 'conflict', code: 'needs-handle' });
  });

  it('reopens the app they joined with after a web-chat invite added web chat to their seat (HB-1136)', async () => {
    const w = world();
    const a = w.agent('a1');
    w.channel(a.id, 'telegram', 'kitchen_bot');
    // Signed in, they join on Telegram by an invite for their handle, and have not written yet.
    const app = createInvite(w.store, a.id, OWNER, '@sam_k').code;
    await w.members.invites.joinOnApp({ code: app, name: 'Sam', accountId: SAM, joinKind: 'telegram', pre: checkInvite(w.store, app) });
    expect(w.store.inviteJoinFor(a.id, SAM).via).toBe('telegram');
    // Then a web-chat invite adds web chat to the same seat.
    const web = createInvite(w.store, a.id, OWNER, undefined, { webChat: true }).code;
    expect(w.members.invites.joinForWebChat(web, 'Sam', SAM)).toMatchObject({ webChat: true });
    expect(w.store.webChatAllowed(a.id, SAM)).toBe(true);
    expect(w.store.inviteJoinFor(a.id, SAM).via).toBe('telegram');
    // The list says so, so the app offers the door and not "web chat only" (HB-1136 review).
    expect(w.members.roster.list(w.store.getAgent(a.id)!).find((m) => m.userId === SAM)).toMatchObject({ webChat: true, joinedByAppInvite: true });
    // "Let them in again" opens Telegram, for them, as their invite said.
    w.store.setAgentState(a.id, 'RUNNING');
    expect(w.members.roster.reopen(w.store.getAgent(a.id) as Agent & { runtimeRef: string }, SAM, undefined)).toEqual({ reopened: true, minutes: 30, on: ['telegram'], for: 'sam_k' });
  });

  it('never reopens an app by an invite from before they were removed (HB-1136 review)', async () => {
    // Each step a minute on: two in one millisecond cannot be told apart.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-02T09:00:00Z') });
    const later = () => vi.setSystemTime(Date.now() + 60_000);
    try {
      const w = world();
      const a = w.agent('a1', { state: 'RUNNING' });
      w.channel(a.id, 'telegram', 'kitchen_bot');
      // Joined on Telegram by an invite that named nobody, and wrote.
      const app = createInvite(w.store, a.id, OWNER).code;
      await w.members.invites.joinOnApp({ code: app, name: 'Sam', accountId: SAM, joinKind: 'telegram', pre: checkInvite(w.store, app) });
      expect(w.store.inviteJoinFor(a.id, SAM).via).toBe('telegram');
      w.store.bindMembershipChannelUser(a.id, SAM, '41001');
      // Removed, then let back in by a web-chat invite alone: their Telegram is forgotten.
      later();
      w.store.revokeMembership(a.id, SAM);
      const web = createInvite(w.store, a.id, OWNER, undefined, { webChat: true }).code;
      expect(w.members.invites.joinForWebChat(web, 'Sam', SAM)).toMatchObject({ webChat: true });
      expect(w.store.getMembership(a.id, SAM)?.channelUserId).toBeUndefined();
      expect(w.store.inviteJoinFor(a.id, SAM)).toEqual({});
      expect(w.members.roster.list(w.store.getAgent(a.id)!).find((m) => m.userId === SAM)).toMatchObject({ webChat: true, joinedByAppInvite: false });
      // So no door opens for whoever writes first: they are asked for the handle.
      expect(w.members.roster.reopen(w.store.getAgent(a.id) as Agent & { runtimeRef: string }, SAM, undefined)).toMatchObject({ refused: 'conflict', code: 'needs-handle' });
      // Let back in by an app invite instead, that one counts.
      later();
      w.store.revokeMembership(a.id, SAM);
      const again = createInvite(w.store, a.id, OWNER, '@sam_k').code;
      await w.members.invites.joinOnApp({ code: again, name: 'Sam', accountId: SAM, joinKind: 'telegram', pre: checkInvite(w.store, again) });
      expect(w.store.inviteJoinFor(a.id, SAM)).toEqual({ handle: 'sam_k', via: 'telegram', byAppInvite: true });
      expect(w.members.roster.list(w.store.getAgent(a.id)!).find((m) => m.userId === SAM)).toMatchObject({ joinedByAppInvite: true });
    } finally { vi.useRealTimers(); }
  });

  it('still reopens by an invite redeemed a moment before its seat was written, as each one before was (HB-1136 review)', () => {
    const w = world();
    const a = w.agent('a1', { state: 'RUNNING' });
    w.channel(a.id, 'telegram', 'kitchen_bot');
    // As a redemption wrote them before: the invite's time, then the seat's a few milliseconds on.
    const code = createInvite(w.store, a.id, OWNER, '@sam_k').code;
    expect(w.store.markInviteRedeemed(code, SAM, '2026-03-02T09:00:00.000Z')).toBe(true);
    w.store.insertMembership({ id: 'm-sam', agentId: a.id, userId: SAM, role: 'user', displayName: 'Sam', status: 'active', joinedAt: '2026-03-02T09:00:00.004Z' });
    expect(w.store.inviteJoinFor(a.id, SAM).handle).toBe('sam_k');
    expect(w.members.roster.reopen(w.store.getAgent(a.id) as Agent & { runtimeRef: string }, SAM, undefined)).toMatchObject({ reopened: true, for: 'sam_k' });
  });

  it('adds someone known from another agent only if they are known, on an app this agent has, while it runs', async () => {
    const w = world();
    const a = w.agent('a1') as Agent & { runtimeRef: string };
    const b = w.agent('a2');
    w.channel(b.id, 'discord', 'house');
    w.store.insertMembership({ id: 'm1', agentId: b.id, userId: SAM, role: 'user', displayName: 'Sam', status: 'active' });
    w.store.bindMemberIdentity(b.id, SAM, 'discord', DISCORD_ID);
    expect(await w.members.roster.addKnown(a, RAE, () => a)).toMatchObject({ refused: 'not-found' });
    expect(w.members.roster.knownPeople(a)).toEqual([{ userId: SAM, name: 'Sam', on: ['discord'] }]);
    expect(await w.members.roster.addKnown(a, SAM, () => a)).toEqual({ refused: 'conflict', error: 'This agent has no app you know Sam on — send them an invite instead.' });
    w.channel(a.id, 'discord', 'garden');
    expect(await w.members.roster.addKnown(a, SAM, () => a)).toEqual({ refused: 'conflict', error: 'Start the agent first — its allowlist lives in the container.' });
    expect(w.store.getMembership(a.id, SAM)).toBeUndefined();
  });

  it('someone met first on Telegram and on Discord apart, then on both at once, is one person to add (HB-1137)', () => {
    const w = world();
    const a = w.agent('a1');
    // Before account links, each approval was a member id of its own: one on Telegram, one on Discord.
    w.agent('a2');
    w.store.insertMembership({ id: 'm-tg', agentId: 'a2', userId: 'member-a-tg', role: 'user', displayName: 'Sam', status: 'active' });
    w.store.bindMembershipChannelUser('a2', 'member-a-tg', '41001');
    w.store.insertMembership({ id: 'm-dc', agentId: 'a2', userId: 'member-b-dc', role: 'user', status: 'active' });
    w.store.bindMemberIdentity('a2', 'member-b-dc', 'discord', DISCORD_ID);
    // Then a third, linked on both: the same person all along (read last, as its id sorts last).
    w.agent('a3');
    w.store.insertMembership({ id: 'm-both', agentId: 'a3', userId: 'member-c-both', role: 'user', status: 'active' });
    w.store.bindMembershipChannelUser('a3', 'member-c-both', '41001');
    w.store.bindMemberIdentity('a3', 'member-c-both', 'discord', DISCORD_ID);
    expect(w.members.roster.knownPeople(a)).toEqual([{ userId: 'member-a-tg', name: 'Sam', on: ['telegram', 'discord'] }]);
    // On this agent already, under the Discord one's id: not offered at all.
    w.store.insertMembership({ id: 'm-here', agentId: a.id, userId: 'member-b-dc', role: 'user', status: 'active' });
    expect(w.members.roster.knownPeople(a)).toEqual([]);
  });
});

describe('who is offered for web chat', () => {
  it("the machine's owner is offered everyone who signs in here but themselves and the agent's owner", () => {
    const w = world();
    const a = w.agent('a1');
    const people = w.members.roster.webChatPeople(OWNER, a, () => true);
    expect(people.map((p) => p.userId).sort()).toEqual(['acct-robin', PAT, RAE, SAM].sort());
    expect(people.find((p) => p.userId === 'acct-robin')).toEqual({ userId: 'acct-robin', kind: 'password', label: 'Robin', username: 'robin', shared: false });
  });

  it('Google accounts only in identity mode, password accounts only where they sign in', () => {
    const accounts = world({ authMode: 'accounts' });
    expect(accounts.members.roster.webChatPeople(OWNER, accounts.agent('a1'), () => true).map((p) => p.kind)).toEqual(['password']);
    const google = world({ passwords: false });
    expect(new Set(google.members.roster.webChatPeople(OWNER, google.agent('a1'), () => true).map((p) => p.kind))).toEqual(new Set(['google']));
  });

  it('anyone else is offered only the machine\'s owner and the people in their own agents', () => {
    const w = world();
    const mine = w.agent('pat-1', { owner: PAT });
    w.store.insertMembership({ id: 'm1', agentId: mine.id, userId: SAM, role: 'user', displayName: 'Sam', status: 'active' });
    const people = w.members.roster.webChatPeople(PAT, mine, () => false);
    expect(people.map((p) => p.userId).sort()).toEqual([OWNER, SAM].sort());
  });

  it('shares only with someone offered; again is "already"; a member on a chat app gets web chat on their seat', () => {
    const w = world();
    const a = w.agent('a1', { state: 'RUNNING' });
    w.store.insertMembership({ id: 'm1', agentId: a.id, userId: PAT, role: 'user', displayName: 'Pat', status: 'active' });
    expect(w.members.roster.shareWebChat(OWNER, a, () => true, { userId: 'user-nobody' })).toEqual({ refused: 'not-found', error: 'Nobody by that name signs in to this Hatchabot.' });
    expect(w.members.roster.shareWebChat(OWNER, a, () => true, { userId: RAE })).toEqual({ userId: RAE, webChat: true, name: 'rae' });
    expect(w.store.getMembership(a.id, RAE)).toMatchObject({ status: 'active', webChat: true, role: 'user' });
    expect(w.members.roster.shareWebChat(OWNER, a, () => true, { userId: RAE })).toEqual({ userId: RAE, webChat: true, already: true });
    expect(w.members.roster.shareWebChat(OWNER, a, () => true, { userId: PAT, name: 'Someone else' })).toEqual({ userId: PAT, webChat: true, name: 'Pat' });
    expect(w.store.listMemberships(a.id).filter((m) => m.userId === PAT)).toHaveLength(1);
    expect(w.ready.map((r) => r.why)).toEqual(['grant', 'grant']);
  });
});
