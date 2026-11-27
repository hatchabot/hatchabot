import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { Store } from '../src/store/store.js';
import { createMembersAndInvites, type MembersAndInvites } from '../src/orchestrator/members/membersAndInvites.js';
import { checkInvite, createInvite, InviteInvalidError } from '../src/orchestrator/members/invite.js';
import {
  ChannelConfigBusyError, ChannelConfigTurnNested, grantChannelAccess, grantRoomAccess, inChannelConfigTurn, revokeMember, RevokeError,
} from '../src/orchestrator/members/members.js';
import { createKnocks } from '../src/orchestrator/channels/knocks.js';
import { claimFirstContact, holdDoorForKnocks } from '../src/orchestrator/members/claim.js';
import { MockProvider } from '../src/providers/mockProvider.js';
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

function world(opts: { authMode?: 'password' | 'accounts' | 'identity'; passwords?: boolean; telegramFetch?: (url: string, init: { signal: AbortSignal }) => Promise<Response>; handleLookMs?: number; provider?: MockProvider } = {}): World {
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
    providerFor: () => (opts.provider ?? neverReached) as never,
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

  it('removing a member closes the windows waiting for their first message, and puts the door back to rest; another person\'s window stays (HB-1522)', async () => {
    const w = world();
    const a = w.agent('a1', { state: 'RUNNING' });
    w.channel(a.id, 'telegram', 'kitchen_bot');
    w.store.insertMembership({ id: 'm1', agentId: a.id, userId: SAM, role: 'user', displayName: 'Sam', status: 'active' });
    w.store.insertMembership({ id: 'm2', agentId: a.id, userId: PAT, role: 'user', displayName: 'Pat', status: 'active' });
    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    w.store.openPairingWindow(a.id, until, SAM, { kind: 'telegram', expect: '@sam_made_up' });
    w.store.openPairingWindow(a.id, until, SAM, { kind: 'discord' });
    w.store.openPairingWindow(a.id, until, PAT, { kind: 'telegram' });
    expect(await w.members.roster.remove(a, SAM)).toEqual({ revoked: true });
    // Was: both of Sam's left open for the rest of their half hour, the door in pairing.
    expect(w.store.pairingWindows(a.id).map((x) => x.seat)).toEqual([`telegram:${PAT}`]);
    expect(w.doors).toEqual(['a1']);
    expect(w.traced).toContain('member.windows_closed');
    // Nothing waited for them: the door is left as it was.
    w.doors.length = 0;
    w.store.insertMembership({ id: 'm3', agentId: a.id, userId: RAE, role: 'user', displayName: 'Rae', status: 'active' });
    await w.members.roster.remove(a, RAE);
    expect(w.doors).toEqual([]);
  });

  /** A running agent on Telegram and Discord whose runtime is a mock one, Sam a member known on Telegram, and the scrub of a removal held. */
  const removalRace = async () => {
    const provider = new MockProvider();
    const w = world({ provider });
    const a = w.agent('a1', { state: 'RUNNING' });
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} });
    w.store.setAgentRuntimeRef(a.id, runtimeRef);
    w.channel(a.id, 'telegram', 'kitchen_bot');
    w.channel(a.id, 'discord', 'hatchabot');
    w.store.insertMembership({ id: 'm1', agentId: a.id, userId: SAM, role: 'user', displayName: 'Sam', status: 'active' });
    w.store.bindMembershipChannelUser(a.id, SAM, '41001');
    const scrubs: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    provider.execShellOnVolume = (async (_ref: string, script: string) => {
      if (script.includes('-allowFrom.json')) {
        scrubs.push(script);
        if (scrubs.length === 1) await held;
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: 'set\n', stderr: '' }; // a door written
    }) as never;
    const knocking = (id?: string, code?: string) => provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ version: 1, requests: id ? [{ id, code }] : [] }), stderr: '' });
    provider.execResponses.set('pairing approve', { code: 0, stdout: 'ok', stderr: '' });
    const approvals = () => provider.execLog.map((x) => x.join(' ')).filter((x) => x.startsWith('pairing approve'));
    return { w, provider, a: w.store.getAgent(a.id)!, runtimeRef, scrubs, release, knocking, approvals };
  };
  const settle = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 5)); };

  it('removing someone closes their windows before the scrub: a knock on another app while it runs is not let in for good (HB-1522 review)', async () => {
    const { w, provider, a, runtimeRef, scrubs, release, knocking, approvals } = await removalRace();
    // Sam's window for a first message on Discord, its watch at its first wait.
    knocking();
    let wake: (() => void) | undefined;
    const watch = claimFirstContact(
      { store: w.store, provider, sleep: () => new Promise<void>((r) => { wake = r; }) },
      { agentId: a.id, runtimeRef, accountId: 'hatchabot', forUserId: SAM, kind: 'discord', timeoutMs: 30 * 60_000 },
    );
    await settle(() => !!wake);
    // An invite Sam joined by, copied again: its window waits for their @handle on Telegram.
    const inv = createInvite(w.store, a.id, OWNER, '@sam_made_up');
    w.store.markInviteRedeemed(inv.code, SAM);
    const invId = w.store.getInviteByCode(inv.code)!.id;
    await holdDoorForKnocks({ store: w.store, provider, log: () => {} }, { agentId: a.id, runtimeRef, accountId: 'kitchen_bot', key: invId, expect: 'sam_made_up', noTimer: true });
    // The owner removes Sam: the scrub of their Telegram is under way, their seat still active.
    const removing = w.members.roster.remove(a, SAM);
    await settle(() => scrubs.length === 1);
    expect(w.store.getMembership(a.id, SAM)?.status).toBe('active');
    // Sam writes on Discord meanwhile, and the watch looks.
    knocking(DISCORD_ID, 'DSCCODE1');
    const woke = wake!;
    wake = undefined;
    woke();
    // Was: approved and bound while the scrub ran, on a list read before it: Sam chatted on Discord for good.
    expect(await watch).toBeNull();
    expect(approvals()).toEqual([]);
    release();
    expect(await removing).toEqual({ revoked: true });
    expect(w.store.getMembership(a.id, SAM)?.status).toBe('revoked');
    expect(Object.keys(w.store.memberIdentities(a.id, SAM))).toEqual(['telegram']);
    // Their invite's knock window closed with them, and the door went back to rest once.
    expect(w.store.pairingWindows(a.id)).toEqual([]);
    expect(w.doors).toEqual(['a1']);
  });

  it('an id bound to someone while their removal scrubs is scrubbed too before they are removed; an approval after it is taken back (HB-1522 review)', async () => {
    const { w, a, scrubs, release } = await removalRace();
    const removing = w.members.roster.remove(a, SAM);
    await settle(() => scrubs.length === 1);
    // A window that opened for them during the scrub (a Reopen pressed then) let them in on Discord: their seat was still active.
    expect(w.store.bindMemberIdentity(a.id, SAM, 'discord', DISCORD_ID)).toBe(true);
    release();
    expect(await removing).toEqual({ revoked: true });
    // Was: one scrub, of Telegram, read before; their Discord approval stayed.
    expect(scrubs).toHaveLength(2);
    expect(scrubs[0]).toContain('41001');
    expect(scrubs[0]).not.toContain(DISCORD_ID);
    expect(scrubs[1]).toContain(DISCORD_ID);
    expect(scrubs[1]).not.toContain('41001');
    expect(w.traced).toContain('member.allowlist_scrubbed');
    // Revoked, nothing binds to their seat: an approval that lands now is not theirs, and its watch takes it back
    // (test/claim.test.ts, "an approval whose seat was removed meanwhile is taken back, and the window closes").
    expect(w.store.bindMemberIdentity(a.id, SAM, 'slack', 'U0MADEUP1')).toBe(false);
  });

  it('a window opened for them while their removal scrubs waits for the scrub: their message is never let in (HB-1554)', async () => {
    const { w, provider, a, runtimeRef, scrubs, release, knocking, approvals } = await removalRace();
    const removing = w.members.roster.remove(a, SAM);
    await settle(() => scrubs.length === 1);
    // A window that opens for them during the scrub; their message on Discord is already waiting.
    knocking(DISCORD_ID, 'DSCCODE1');
    const watch = claimFirstContact(
      { store: w.store, provider, sleep: async () => {} },
      { agentId: a.id, runtimeRef, accountId: 'hatchabot', forUserId: SAM, kind: 'discord', timeoutMs: 30 * 60_000 },
    );
    // Its door is opened in the agent's turn, after the scrub's: nothing is read or approved meanwhile.
    // Was: approved and bound while the scrub ran, their seat still active (HB-1522 review's third round).
    await new Promise((r) => setTimeout(r, 50));
    expect(approvals()).toEqual([]);
    expect(Object.keys(w.store.memberIdentities(a.id, SAM))).toEqual(['telegram']);
    release();
    expect(await removing).toEqual({ revoked: true });
    // Once it looks, their seat is gone: the window closes, and nobody is let in.
    expect(await watch).toBeNull();
    expect(approvals()).toEqual([]);
    expect(scrubs).toHaveLength(1);
    expect(w.store.pairingWindows(a.id)).toEqual([]);
  });

  it('a room grant asked for during the removal\'s scrub writes nothing once they are removed, and the watch takes its approval back: their id is left in no room (HB-1522 review, HB-1554)', async () => {
    const { w, provider, a, runtimeRef, release, knocking } = await removalRace();
    // What lands on the volume, in order; the watch's door write and room grant are held.
    const landed: string[] = [];
    const base = provider.execShellOnVolume.bind(provider);
    let letGrantGo!: () => void;
    const grantHeld = new Promise<void>((r) => { letGrantGo = r; });
    let letDoorGo!: () => void;
    const doorHeld = new Promise<void>((r) => { letDoorGo = r; });
    let granting = false;
    let resting = false;
    provider.execShellOnVolume = (async (ref: string, script: string, o?: { readOnly?: boolean }) => {
      if (script.includes('r.users.push(t.id)')) { granting = true; await grantHeld; landed.push('grant'); return { code: 0, stdout: 'added\n', stderr: '' }; }
      if (script.includes('"policy":"allowlist"')) { resting = true; await doorHeld; landed.push('door'); return { code: 0, stdout: 'set\n', stderr: '' }; }
      const r = await base(ref, script, o);
      if (script.includes('-allowFrom.json')) landed.push(['scrub', script.includes('41001') ? 'telegram' : '', script.includes(DISCORD_ID) ? 'discord' : ''].filter(Boolean).join(' '));
      return r;
    }) as never;
    // Sam's first message on Discord is approved and bound, their seat active; the watch puts the door back to rest.
    knocking(DISCORD_ID, 'DSCCODE1');
    const watch = claimFirstContact(
      { store: w.store, provider, sleep: async () => {} },
      { agentId: a.id, runtimeRef, accountId: 'hatchabot', forUserId: SAM, kind: 'discord', timeoutMs: 30 * 60_000 },
    );
    await settle(() => resting);
    expect(Object.keys(w.store.memberIdentities(a.id, SAM)).sort()).toEqual(['discord', 'telegram']);
    // Removed while that write is on its way: the scrub waits for it, and the room grant for the scrub (HB-1554).
    const removing = w.members.roster.remove(a, SAM);
    release();
    await new Promise((r) => setTimeout(r, 20));
    letDoorGo();
    expect(await removing).toEqual({ revoked: true });
    expect(landed).toEqual(['door', 'scrub telegram discord']);
    letGrantGo();
    expect(await watch).toBeNull();
    // Was: the grant waited for the scrub and landed after the flip, their id back in the rooms' users lists until
    // the watch's scrub took it out again (and until the next build when that failed). Its seat looked at in its turn,
    // nothing is written.
    expect(granting).toBe(false);
    expect(landed).toEqual(['door', 'scrub telegram discord', 'scrub discord']);
    // No greeting for someone removed.
    expect(provider.execLog.some((x) => x[0] === 'message' && x[1] === 'send')).toBe(false);
  });

  it('a removal whose scrub fails still puts the door back to rest for the windows it closed (HB-1522 review)', async () => {
    const { w, provider, a } = await removalRace();
    provider.execShellOnVolume = (async () => ({ code: 1, stdout: '', stderr: 'made-up failure' })) as never;
    w.store.openPairingWindow(a.id, new Date(Date.now() + 30 * 60_000).toISOString(), SAM, { kind: 'discord' });
    await expect(w.members.roster.remove(a, SAM)).rejects.toBeInstanceOf(RevokeError);
    expect(w.store.getMembership(a.id, SAM)?.status).toBe('active');
    expect(w.store.pairingWindows(a.id)).toEqual([]);
    // Was (a rest only after a removal that took): the door left in pairing with their window closed.
    expect(w.doors).toEqual(['a1']);
    expect(w.traced).toContain('member.windows_closed');
  });

  it('removing the owner is refused, and leaves their windows open', async () => {
    const w = world();
    const a = w.agent('a1', { state: 'RUNNING' });
    w.channel(a.id, 'telegram', 'kitchen_bot');
    w.store.openPairingWindow(a.id, new Date(Date.now() + 30 * 60_000).toISOString(), OWNER, { kind: 'telegram' });
    await expect(w.members.roster.remove(a, OWNER)).rejects.toBeInstanceOf(RevokeError);
    expect(w.store.pairingWindows(a.id).map((x) => x.seat)).toEqual([`telegram:${OWNER}`]);
    expect(w.doors).toEqual([]);
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

/**
 * Door writes, grants and a removal's scrub on one agent's volume, one at a
 * time (HB-1554). The volume is a folder: each script the runtime is handed
 * runs on it as its one-shot container would, and lands when the test says.
 * `reads`: when a script reads the files, as it is asked for (it lands what
 * it wrote from that read, as a container started then does) or as it lands
 * (a container that started late). Whatever is waiting lands in turn, a scrub
 * first: the order that put a removed member back, when both were in flight.
 */
describe('a removal and the writes of the door, in order (HB-1554)', () => {
  const STATE = '/home/node/.openclaw';
  const OWNER_TG = '41000';
  const SAM_TG = '41001';
  const PAT_DISCORD = '100000000000000004';
  const OWNER_DISCORD = '100000000000000003';
  const SAM_DISCORD = '100000000000000005';
  const files = (d: string) => ['openclaw.json', ...fs.readdirSync(join(d, 'credentials')).map((f) => `credentials/${f}`)];

  const setUp = (reads: 'asked' | 'landing', telegram: { dmPolicy: string; allowFrom: string[] }) => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'hb-door-'));
    fs.mkdirSync(join(dir, 'credentials'));
    fs.writeFileSync(join(dir, 'openclaw.json'), JSON.stringify({ channels: {
      telegram: { accounts: { kitchen_bot: telegram } },
      discord: { accounts: { hatchabot: { dmPolicy: 'allowlist', allowFrom: [OWNER_DISCORD] } }, guilds: { g1: { users: [OWNER_DISCORD] } } },
    } }));
    fs.writeFileSync(join(dir, 'credentials/telegram-kitchen_bot-allowFrom.json'), JSON.stringify({ allowFrom: [SAM_TG] }));
    const run = (script: string, on: string) => {
      let stdout = '';
      const exit = new Error('exit');
      try {
        runInNewContext(script.replaceAll(STATE, on).slice("node -e '".length, -1), {
          require: (name: string) => { if (name === 'fs') return fs; if (name === 'crypto') return crypto; throw new Error(`Unexpected module: ${name}`); },
          console: { log: (line: unknown) => { stdout += `${String(line)}\n`; } },
          process: { exit: () => { throw exit; } },
        });
      } catch (err) { if (err !== exit) return { code: 1, stdout, stderr: String(err) }; }
      return { code: 0, stdout, stderr: '' };
    };
    const pending: Array<{ scrub: boolean; land: () => void }> = [];
    const landed: string[] = [];
    /** What the bot's pairing requests list says, and what a pairing approve does meanwhile. */
    const knocks: { requests: Array<{ id: string; code: string }>; onApprove?: () => Promise<void> } = { requests: [] };
    /** While true, nothing on the volume lands. */
    const hold = { landing: false };
    const what = (script: string) => (script.includes('const drop = ') ? 'scrub' : script.includes('t.policy') ? 'door' : script.includes('r.users.push(t.id)') ? 'rooms' : 'other');
    const provider = {
      execShellOnVolume: (_ref: string, script: string) => new Promise((resolve) => {
        const scrub = what(script) === 'scrub';
        if (reads === 'landing') {
          pending.push({ scrub, land: () => { landed.push(what(script)); resolve(run(script, dir)); } });
          return;
        }
        // Read now, on a copy: what it wrote lands later, whole, over the volume.
        const copy = fs.mkdtempSync(join(tmpdir(), 'hb-door-read-'));
        fs.cpSync(dir, copy, { recursive: true });
        const before = new Map(files(copy).map((f) => [f, fs.readFileSync(join(copy, f), 'utf8')]));
        const result = run(script, copy);
        const wrote = files(copy).filter((f) => fs.readFileSync(join(copy, f), 'utf8') !== before.get(f)).map((f) => [f, fs.readFileSync(join(copy, f), 'utf8')] as const);
        fs.rmSync(copy, { recursive: true, force: true });
        pending.push({ scrub, land: () => { landed.push(what(script)); for (const [f, text] of wrote) fs.writeFileSync(join(dir, f), text); resolve(result); } });
      }),
      exec: async (_ref: string, argv: string[]) => {
        if (argv[0] === 'pairing' && argv[1] === 'approve') await knocks.onApprove?.();
        return { code: 0, stdout: '', stderr: '' };
      },
      execShell: async () => ({ code: 0, stdout: JSON.stringify({ version: 1, requests: knocks.requests }), stderr: '' }),
    };
    const db = new Database(':memory:');
    const store = new Store(db);
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    // An agent of its own each time: what the door last asserted is remembered per agent, process-wide.
    const id = `door-${crypto.randomUUID()}`;
    store.insertAgent({
      id, ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
      persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now', runtimeRef: `rt-${id}`,
    } as never);
    store.insertChannel({ id: `ch-${id}-tg`, agentId: id, kind: 'telegram', accountId: 'kitchen_bot', secretRef: `channel/${id}/telegram`, deepLink: 'https://example.invalid/kitchen_bot', createdAt: 'now' });
    store.insertChannel({ id: `ch-${id}-dc`, agentId: id, kind: 'discord', accountId: 'hatchabot', secretRef: `channel/${id}/discord`, deepLink: 'https://example.invalid/discord', createdAt: 'now' });
    store.insertMembership({ id: `own-${id}`, agentId: id, userId: OWNER, role: 'owner', status: 'active' });
    store.bindMembershipChannelUser(id, OWNER, OWNER_TG);
    store.bindMemberIdentity(id, OWNER, 'discord', OWNER_DISCORD);
    store.insertMembership({ id: `sam-${id}`, agentId: id, userId: SAM, role: 'user', displayName: 'Sam', status: 'active' });
    store.bindMembershipChannelUser(id, SAM, SAM_TG);
    const doors = createKnocks({
      store, providerFor: () => provider as never, trace: () => () => {}, opsPush: { waiting: async () => true }, knockCacheMs: 0, sweepEveryMs: 0,
    });
    const deps = { store, provider: provider as never };
    /** Lands whatever waits, a scrub first, until every one of `work` has settled. */
    const landAll = async (...work: Array<Promise<unknown>>) => {
      let done = false;
      const all = Promise.allSettled(work).then((r) => { done = true; return r; });
      for (let i = 0; i < 400 && !done; i++) {
        await new Promise((r) => setTimeout(r, 5));
        if (hold.landing) continue;
        const at = pending.findIndex((x) => x.scrub);
        (at >= 0 ? pending.splice(at, 1)[0] : pending.shift())?.land();
      }
      for (const r of await all) if (r.status === 'rejected') throw r.reason;
    };
    const config = () => JSON.parse(fs.readFileSync(join(dir, 'openclaw.json'), 'utf8'));
    const approved = () => JSON.parse(fs.readFileSync(join(dir, 'credentials/telegram-kitchen_bot-allowFrom.json'), 'utf8')).allowFrom;
    const done = () => { doors.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
    /** Until a write of `kind` is on the volume, not yet landed. */
    const onVolume = async (kind: 'scrub' | 'other') => { while (!pending.some((x) => x.scrub === (kind === 'scrub'))) await new Promise((r) => setTimeout(r, 1)); };
    const writeConfig = (cfg: unknown) => fs.writeFileSync(join(dir, 'openclaw.json'), JSON.stringify(cfg));
    const scrubsOnVolume = () => pending.filter((x) => x.scrub).length;
    return {
      store, knocks: doors, deps, agent: () => store.getAgent(id)!, id, landAll, landed, onVolume, config, approved, done,
      requests: knocks, hold, writeConfig, scrubsOnVolume, provider,
    };
  };

  it('a door rest asked for while the scrub runs, landing after it, does not put the removed member back on allowFrom', async () => {
    // Its container starts late: it reads the config the scrub has already written.
    const t = setUp('landing', { dmPolicy: 'allowlist', allowFrom: [OWNER_TG, SAM_TG] });
    try {
      const removing = revokeMember(t.deps, t.id, SAM);
      const resting = t.knocks.restDoor(t.agent()); // the sweep, or another window closing
      await t.landAll(removing, resting);
      expect(t.store.getMembership(t.id, SAM)?.status).toBe('revoked');
      // Was: the rest read Sam as still active, and its write after the scrub put them back: they could DM the agent.
      expect(t.config().channels.telegram.accounts.kitchen_bot).toEqual({ dmPolicy: 'allowlist', allowFrom: [OWNER_TG] });
      expect(t.approved()).toEqual([]);
      expect(t.landed[0]).toBe('scrub');
    } finally { t.done(); }
  });

  it('a door rest that read the config before the scrub runs first, and the scrub takes out what it wrote', async () => {
    // A window had just closed: the rest writes the door shut, from the config as it read it.
    const t = setUp('asked', { dmPolicy: 'pairing', allowFrom: [OWNER_TG, SAM_TG] });
    try {
      const resting = t.knocks.restDoor(t.agent());
      const removing = revokeMember(t.deps, t.id, SAM);
      await t.landAll(removing, resting);
      expect(t.store.getMembership(t.id, SAM)?.status).toBe('revoked');
      // Was: the scrub landed first, and the rest wrote back the whole config it had read before it, Sam and all.
      expect(t.config().channels.telegram.accounts.kitchen_bot).toEqual({ dmPolicy: 'allowlist', allowFrom: [OWNER_TG] });
      expect(t.approved()).toEqual([]);
      expect(t.landed.slice(0, 2)).toEqual(['door', 'scrub']);
    } finally { t.done(); }
  });

  it('a knock window opening the door while the scrub runs does not write back what the scrub took out', async () => {
    const t = setUp('asked', { dmPolicy: 'allowlist', allowFrom: [OWNER_TG, SAM_TG] });
    try {
      // Copy pressed on someone else's Telegram invite: the door opens for half an hour.
      const opening = holdDoorForKnocks({ store: t.store, provider: t.deps.provider, log: () => {} }, { agentId: t.id, runtimeRef: `rt-${t.id}`, accountId: 'kitchen_bot', key: 'inv-pat', noTimer: true });
      const removing = revokeMember(t.deps, t.id, SAM);
      await t.landAll(removing, opening);
      // Was: its write, read before the scrub and landing after it, put Sam back.
      expect(t.config().channels.telegram.accounts.kitchen_bot).toEqual({ dmPolicy: 'pairing', allowFrom: [OWNER_TG] });
      expect(t.approved()).toEqual([]);
    } finally { t.done(); }
  });

  it("a room grant for them, asked for while their removal scrubs, writes nothing once they are removed: the claim watch's check, in its turn", async () => {
    const t = setUp('landing', { dmPolicy: 'allowlist', allowFrom: [OWNER_TG, SAM_TG] });
    try {
      t.store.bindMemberIdentity(t.id, SAM, 'discord', SAM_DISCORD);
      const removing = revokeMember(t.deps, t.id, SAM);
      await t.onVolume('scrub');
      // Their first Discord message was just bound by its watch: its grant of the rooms, with the watch's seat check.
      const seatActive = () => t.store.getMembership(t.id, SAM)?.status === 'active';
      const granting = grantRoomAccess(t.deps, { agentId: t.id, runtimeRef: `rt-${t.id}`, kind: 'discord', channelUserId: SAM_DISCORD, onlyIf: seatActive });
      await t.landAll(removing, granting);
      expect(t.store.getMembership(t.id, SAM)?.status).toBe('revoked');
      expect(await granting).toBe(false);
      // Was: it ran after the flip and put Sam back in the server's users, until the watch took it out again.
      expect(t.config().channels.discord.guilds.g1.users).toEqual([OWNER_DISCORD]);
      expect(t.landed).not.toContain('rooms');
    } finally { t.done(); }
  });

  it("a door grant for them, asked for while their removal scrubs, writes nothing once they are removed: the join's check, in its turn", async () => {
    const t = setUp('landing', { dmPolicy: 'allowlist', allowFrom: [OWNER_TG, SAM_TG] });
    try {
      const removing = revokeMember(t.deps, t.id, SAM);
      await t.onVolume('scrub');
      const granting = grantChannelAccess(t.deps, {
        agentId: t.id, runtimeRef: `rt-${t.id}`, kind: 'telegram', accountId: 'kitchen_bot', channelUserId: SAM_TG,
        onlyIf: () => t.store.getMembership(t.id, SAM)?.status === 'active',
      });
      await t.landAll(removing, granting);
      expect(await granting).toBe('skipped');
      // Was: written after the flip, back on the door and in OpenClaw's approvals, until the join took it back.
      expect(t.config().channels.telegram.accounts.kitchen_bot.allowFrom).toEqual([OWNER_TG]);
      expect(t.approved()).toEqual([]);
    } finally { t.done(); }
  });

  it("an approval the claim watch takes back while a removal scrubs waits for the removal's turn, and both changes are kept", async () => {
    const t = setUp('asked', { dmPolicy: 'allowlist', allowFrom: [OWNER_TG, SAM_TG] });
    try {
      // An approval on Discord for someone Pat's watch is about to let in: on the door and in the server's users.
      const cfg = t.config();
      cfg.channels.discord.accounts.hatchabot.allowFrom.push(PAT_DISCORD);
      cfg.channels.discord.guilds.g1.users.push(PAT_DISCORD);
      t.writeConfig(cfg);
      t.store.insertMembership({ id: `pat-${t.id}`, agentId: t.id, userId: 'user-pat', role: 'user', displayName: 'Pat', status: 'active' });
      t.requests.requests = [{ id: PAT_DISCORD, code: 'PATCODE1' }];
      let removing: Promise<void> | undefined;
      t.requests.onApprove = async () => {
        // Sam is removed while the approve runs, and Pat too: the approval binds nobody, and the watch takes it back.
        t.hold.landing = true;
        removing = revokeMember(t.deps, t.id, SAM);
        await t.onVolume('scrub');
        t.store.revokeMembership(t.id, 'user-pat');
        setTimeout(() => { t.hold.landing = false; }, 40);
      };
      const watch = claimFirstContact(
        { store: t.store, provider: t.provider as never, sleep: () => new Promise((r) => setTimeout(r, 2)) },
        { agentId: t.id, runtimeRef: `rt-${t.id}`, accountId: 'hatchabot', forUserId: 'user-pat', kind: 'discord', timeoutMs: 30 * 60_000 },
      );
      await t.landAll(watch);
      expect(await watch).toBeNull();
      await removing;
      expect(t.store.getMembership(t.id, SAM)?.status).toBe('revoked');
      const after = t.config();
      // Was: the take-back read the config before the removal's scrub landed and wrote it back after: Sam let in again.
      expect(after.channels.telegram.accounts.kitchen_bot.allowFrom).toEqual([OWNER_TG]);
      expect(after.channels.discord.accounts.hatchabot.allowFrom).toEqual([OWNER_DISCORD]);
      expect(after.channels.discord.guilds.g1.users).toEqual([OWNER_DISCORD]);
      expect(t.approved()).toEqual([]);
    } finally { t.done(); }
  });

  it('a room grant for someone else and the scrub keep each other\'s change', async () => {
    const t = setUp('asked', { dmPolicy: 'allowlist', allowFrom: [OWNER_TG, SAM_TG] });
    try {
      const granting = grantRoomAccess(t.deps, { agentId: t.id, runtimeRef: `rt-${t.id}`, kind: 'discord', channelUserId: PAT_DISCORD });
      const removing = revokeMember(t.deps, t.id, SAM);
      await t.landAll(removing, granting);
      expect(await granting).toBe(true);
      const cfg = t.config();
      // Was: the grant wrote back the config it read before the scrub: Sam on Telegram's allowFrom again.
      expect(cfg.channels.telegram.accounts.kitchen_bot.allowFrom).toEqual([OWNER_TG]);
      expect(cfg.channels.discord.guilds.g1.users).toEqual([OWNER_DISCORD, PAT_DISCORD]);
    } finally { t.done(); }
  });
});

describe("an agent's turns at its chat apps (HB-1554)", () => {
  const timeout = (ms: number) => new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms));

  it('a turn asked for inside its own agent\'s turn is refused, not left waiting for itself; another agent\'s, or one asked after it ends, is not', async () => {
    const store = new Store(new Database(':memory:'));
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    let first: unknown;
    try {
      const nested = inChannelConfigTurn(store, 'a1', () => inChannelConfigTurn(store, 'a1', async () => 'inner'));
      // Was: it waited for itself, and every later write of the agent's chat apps behind it, until a restart.
      first = await Promise.race([nested.then(() => 'ran', (err: unknown) => err), timeout(500)]);
      // Said where it is raised: most callers make any failure a write that did not take.
      expect(said.mock.calls.map((c) => String(c[0]).split('\n')[0])).toEqual([
        "[chat-app turns] A write of agent a1's chat-app access asked for its turn inside its own turn: it would wait for itself (HB-1554).",
      ]);
    } finally { said.mockRestore(); }
    expect(first).toBeInstanceOf(ChannelConfigTurnNested);
    expect(await Promise.race([inChannelConfigTurn(store, 'a1', async () => 'free'), timeout(500)])).toBe('free');
    expect(await inChannelConfigTurn(store, 'a1', () => inChannelConfigTurn(store, 'a2', async () => 'other agent'))).toBe('other agent');
    // Set off in a turn and left running: once the turn is over it waits its own turn.
    let later!: Promise<string>;
    await inChannelConfigTurn(store, 'a1', async () => {
      later = new Promise((r) => setTimeout(r, 5)).then(() => inChannelConfigTurn(store, 'a1', async () => 'after it'));
    });
    expect(await later).toBe('after it');
  });

  it("a press that waits longer than it may for the agent's turn is refused in words, and nothing of it runs", async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    store.insertAgent({
      id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
      persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
    } as never);
    let release!: () => void;
    const slow = inChannelConfigTurn(store, 'a1', () => new Promise<void>((r) => { release = r; }));
    let ran = false;
    const press = inChannelConfigTurn(store, 'a1', async () => { ran = true; }, { waitMs: 20 });
    const refused = await press.then(() => undefined, (err: unknown) => err);
    expect(refused).toBeInstanceOf(ChannelConfigBusyError);
    expect((refused as ChannelConfigBusyError).userMessage).toBe("Another change to Kitchen's chat apps is still being written: try again in a minute.");
    release();
    await slow;
    expect(ran).toBe(false);
    expect(await inChannelConfigTurn(store, 'a1', async () => 'next', { waitMs: 20 })).toBe('next');
  });
});
