import { randomUUID } from 'node:crypto';
import type { Agent, Channel } from '../../domain/types.js';
import type { Store } from '../../store/store.js';
import { CHANNEL_ACCOUNT } from '../../openclaw/configWriter.js';
import { clearBusy, markBusy, whileBusy } from '../lifecycle/busy.js';
import { claimFirstContact } from './claim.js';
import { AdmitError, grantChannelAccess, removeUnboundChannelAccess, revokeMember } from './members.js';
import type { MemberRefusal, MembersDeps } from './membersAndInvites.js';

/**
 * An agent's members (HB-0808): who
 * is in, web chat on or off for one of them, sharing an agent for web chat
 * with someone already on this Hatchabot (no link), removing a member, the
 * people already admitted to another of the owner's agents and adding one of
 * them, and holding the door open again for a member who never wrote.
 * Admitting, revoking and the door are members.ts and claim.ts; who may open
 * a console is consoleAccess.ts, kept in step from here.
 *
 * No state of its own and no timer. Nothing here knows about HTTP: the route
 * checks the agent and reads the request, asks this, and words the answer. A
 * refusal is a `MemberRefusal`.
 */
export interface Roster {
  /** Someone who signs in here: a Google account (identity mode) or a local account. */
  isAccountId(userId: string): boolean;
  /** How a person who signs in here is shown to themselves: a password account's name, a Google account's email. */
  accountLabel(userId: string): string | undefined;
  /**
   * The active members, each with their identities on Discord and Slack,
   * whether they sign in here, and whether their seat came in by a chat-app
   * invite (`joinedByAppInvite`: there is a door to open again).
   */
  list(agent: Agent): Array<ReturnType<Store['listMemberships']>[number] & { identities: ReturnType<Store['memberIdentities']>; account: boolean; joinedByAppInvite: boolean }>;
  /** Web chat on or off for one member (only someone who signs in here may have it on). */
  setWebChat(agent: Agent, userId: string, on: boolean): MemberRefusal | { userId: string; webChat: boolean };
  /**
   * The people on this Hatchabot `me` may share `agent` with for web chat
   * without a link. `ownsMachine`: is `me` the account that set this machine up?
   */
  webChatPeople(me: string, agent: Agent, ownsMachine: () => boolean): WebChatPerson[];
  /** Share with one of those people: a member with web chat on, as a web chat link would make them. */
  shareWebChat(me: string, agent: Agent, ownsMachine: () => boolean, share: { userId: string; name?: string | undefined }): MemberRefusal | WebChatShared;
  /**
   * Remove a member, under the agent's lifecycle lock; their open consoles
   * close and their name leaves the gateway's list. Throws AgentBusyError or
   * RevokeError (members.ts), as it did.
   */
  remove(agent: Agent, userId: string): Promise<{ revoked: true }>;
  /** People admitted to another of the owner's agents, and the apps they are known on. */
  knownPeople(agent: Agent): Array<{ userId: string; name: string; on: string[] }>;
  /**
   * Hold the door open again for a member who redeemed an invite and never
   * wrote: on the app they joined with, or, when that was never learned, only
   * for a named @handle (`handle`: the one the owner typed, if any).
   */
  reopen(agent: Agent & { runtimeRef: string }, userId: string, handle: string | undefined): MemberRefusal | Reopened;
  /**
   * Add someone admitted to another of the owner's agents, on every app this
   * agent has that they are known on, with the agent held busy. `ownedNow`:
   * the agent as the caller owns it now (read again after the grants).
   */
  addKnown(agent: Agent & { runtimeRef: string }, userId: string, ownedNow: () => Agent | undefined): Promise<MemberRefusal | { added: true; name: string }>;
}

export interface WebChatPerson {
  userId: string;
  kind: 'google' | 'password';
  label: string;
  username?: string;
  shared: boolean;
}

export type WebChatShared =
  | { userId: string; webChat: true; already: true }
  | { userId: string; webChat: true; name: string };

export interface Reopened { reopened: true; minutes: 30; on: Channel['kind'][]; for?: string }

export function createRoster(deps: MembersDeps): Roster {
  const { store, providerFor, trace, consoleAccess, restDoor, logError } = deps;
  const notFound = (error: string): MemberRefusal => ({ refused: 'not-found', error });
  const invalid = (error: string): MemberRefusal => ({ refused: 'invalid', error });
  const conflict = (error: string, code?: string): MemberRefusal => ({ refused: 'conflict', error, ...(code ? { code } : {}) });

  /** Someone who signs in here: a Google account (identity mode) or a local account. */
  const isAccountId = (userId: string): boolean => /^user-./.test(userId) || !!store.localAccount(userId);
  /** How a person who signs in here is shown to themselves: a password account's name, a Google account's email. */
  const accountLabel = (userId: string): string | undefined => {
    const local = store.localAccount(userId);
    return local ? (local.displayName || local.username) : store.emailForOwner(userId);
  };

  const list: Roster['list'] = (agent) =>
    // With each person's identities on Discord and Slack too (Telegram's is the seat's own id).
    // `account`: they sign in here, so web chat can be given to them.
    store.listMemberships(agent.id).filter((m) => m.status === 'active')
      .map((m) => ({
        ...m, identities: store.memberIdentities(agent.id, m.userId), account: isAccountId(m.userId),
        // With web chat added, they were taken for web chat alone, and offered no door (HB-1136 review).
        joinedByAppInvite: !!store.inviteJoinFor(agent.id, m.userId).byAppInvite,
      }));

  /**
   * Web chat on or off for one member (2026-09-29). Only for someone who signs
   * in here — a chat-app-only member has no way to reach the page as
   * themselves. Removing them (remove, below) ends it too.
   */
  const setWebChat: Roster['setWebChat'] = (agent, userId, on) => {
    const m = store.getMembership(agent.id, userId);
    if (!m || m.status !== 'active') return notFound('Not a member of this agent.');
    if (m.role === 'owner' || m.userId === agent.ownerId) return invalid('You can always chat with your own agent.');
    if (on && !isAccountId(m.userId)) {
      return conflict('They joined without signing in here, so they cannot open this page as themselves. Send them a “Chat on the web” invite instead.');
    }
    store.setMembershipWebChat(agent.id, m.userId, on);
    trace(agent.id)(on ? 'member.web_chat_on' : 'member.web_chat_off', { userId: m.userId });
    // Off: their open console closes now; on or off, the gateway's list of
    // people follows (a guest's name is only admitted while they may chat).
    if (!on) consoleAccess.dropGuests(agent.id, m.userId);
    if (agent.state === 'RUNNING') void consoleAccess.ensureReady(agent, on ? 'grant' : 'removal').catch(() => {});
    return { userId: m.userId, webChat: on };
  };

  /**
   * The people on this Hatchabot an agent can be shared with for web chat
   * without a link (2026-11-10): the owner picks one and the agent is on their
   * home screen at once. The machine's owner is offered everyone who signs in
   * here; anyone else the machine's owner, the people they have swapped agents
   * with and the people already in one of their agents, not the whole
   * household (as /v1/accounts). Each is marked Google or password: the two
   * are separate accounts even under one email.
   */
  const webChatPeople: Roster['webChatPeople'] = (me, agent, ownsMachine) => {
    let people = store.listSignInAccounts().filter((p) =>
      p.id !== me && p.id !== agent.ownerId && (p.kind === 'google' ? deps.authMode() === 'identity' : deps.localAccountsOn()));
    if (!ownsMachine()) {
      const hostOwner = store.listHosts(me).find((h) => h.kind === 'local')?.ownerId;
      const known = new Set(store.listRelatedAccounts(me, hostOwner ? [hostOwner] : []).map((a) => a.ownerId));
      if (hostOwner) known.add(hostOwner);
      for (const a of store.listAgents(me)) {
        for (const m of store.listMemberships(a.id)) if (m.status === 'active') known.add(m.userId);
      }
      people = people.filter((p) => known.has(p.id));
    }
    return people.map((p) => {
      const m = store.getMembership(agent.id, p.id);
      return {
        userId: p.id,
        kind: p.kind,
        label: p.kind === 'google' ? p.email! : (p.displayName || p.username!),
        ...(p.kind === 'password' && p.displayName ? { username: p.username } : {}),
        shared: !!m && m.status === 'active' && m.webChat,
      };
    });
  };

  const shareWebChat: Roster['shareWebChat'] = (me, agent, ownsMachine, share) => {
    // Only someone the list offers this caller: an id sent by hand is not a
    // way to find out who has an account here.
    const person = webChatPeople(me, agent, ownsMachine).find((p) => p.userId === share.userId);
    if (!person) return notFound('Nobody by that name signs in to this Hatchabot.');
    if (person.shared) return { userId: person.userId, webChat: true, already: true };
    const name = (share.name || person.label.split('@')[0] || person.label).slice(0, 64);
    store.transact(() => {
      const m = store.getMembership(agent.id, person.userId);
      // Already in on a chat app: web chat is added to the seat they have.
      if (m?.status === 'active') store.setMembershipWebChat(agent.id, person.userId, true);
      else if (m) store.reactivateMembership(agent.id, person.userId, name, true);
      else {
        store.insertMembership({
          id: randomUUID(), agentId: agent.id, userId: person.userId, role: 'user',
          displayName: name, status: 'active', joinedAt: new Date().toISOString(), webChat: true,
        });
      }
    });
    trace(agent.id)('member.web_chat_shared', { userId: person.userId });
    // Their name goes on the gateway's list now, before they open it (as a join does).
    if (agent.state === 'RUNNING') void consoleAccess.ensureReady(agent, 'grant').catch(() => {});
    return { userId: person.userId, webChat: true, name: store.getMembership(agent.id, person.userId)?.displayName ?? name };
  };

  const remove: Roster['remove'] = async (agent, userId) => {
    // Under the lifecycle lock, on the host the agent is on once it is
    // held: mid-move the scrub hit the volume the move had already
    // exported (the copy kept them), a rebuild's seed or a restore's
    // import put them back (concurrency review, 2026-10-09).
    await whileBusy(agent.id, async () => {
      const now = store.getAgent(agent.id) ?? agent;
      await revokeMember(
        { store, provider: providerFor(now.hostId), log: trace(agent.id) },
        agent.id,
        userId,
      );
    });
    // Their open console (the full chat) ends with the membership, and
    // their name leaves the gateway's list.
    consoleAccess.dropGuests(agent.id, userId);
    if (agent.state === 'RUNNING') void consoleAccess.ensureReady(agent, 'removal').catch(() => {});
    return { revoked: true };
  };

  /**
   * People you have already admitted to another agent, with a Telegram id on
   * file. Adding one of them needs no invite link and no pairing: we know who
   * they are, so they go straight onto this agent's allowlist.
   */
  const knownPeople: Roster['knownPeople'] = (agent) =>
    // The apps they are known on: the card offers "Add" only where this agent has one of them.
    store.knownPeopleFor(agent.ownerId, agent.id).map((p) => ({ userId: p.userId, name: p.name, on: Object.keys(p.identities) }));

  /**
   * Hold the door open again for somebody who redeemed an invite and then got
   * on with their day. The window is deliberately short — 30 minutes, and the
   * agent is deaf to strangers outside it — so the answer to "they took two
   * hours to get round to it" is to reopen it, not to leave it ajar.
   */
  const reopen: Roster['reopen'] = (agent, userId, handle) => {
    if (agent.ops) return { refused: 'ops-alone' };
    const member = store.getMembership(agent.id, userId);
    if (!member || member.status !== 'active') return notFound('Not a member of this agent.');
    const have = store.memberIdentities(agent.id, member.userId);
    const unlinked = store.listChannelsForAgent(agent.id).filter((c) => !have[c.kind]);
    if (!unlinked.length) return conflict(store.listChannelsForAgent(agent.id).length ? 'They are already linked — nothing to reopen.' : 'This agent is not in a chat app yet.');
    if (agent.state !== 'RUNNING') return conflict('Start the agent first.');
    // Which door, and for whom (2026-09-30). This opened a window on EVERY
    // app they were not linked on, and without a handle the first stranger
    // to message any of them took the seat — on a big Slack or Discord,
    // anybody in it. Now: the app they joined with, only; or, when we never
    // learned which (joined before this was recorded), only for a named
    // @handle — the one their invite named, or one the owner types now.
    const joinedBy = store.inviteJoinFor(agent.id, member.userId);
    const expect = joinedBy.handle ?? (handle ? handle : undefined);
    const via = unlinked.find((c) => c.kind === joinedBy.via);
    if (joinedBy.via && !via) return conflict(`They are already linked on ${joinedBy.via} — nothing to reopen.`);
    if (!via && !expect) {
      return conflict(
        'We do not know which app they joined with, so the door would open to whoever messages first. Give their @handle and only they are let in.',
        'needs-handle',
      );
    }
    const open = via ? [via] : unlinked;
    for (const c of open) {
      void claimFirstContact(
        { store, provider: providerFor(agent.hostId), providerFor, log: trace(agent.id) },
        {
          agentId: agent.id, runtimeRef: agent.runtimeRef,
          accountId: c.kind === 'telegram' ? c.accountId : CHANNEL_ACCOUNT,
          kind: c.kind, forUserId: member.userId, expect, timeoutMs: 30 * 60_000,
        },
      ).catch((err) => logError({ err }, 'reopen claim failed'));
    }
    trace(agent.id)('member.door_reopened', { userId: member.userId, on: open.map((c) => c.kind), named: !!expect });
    return { reopened: true, minutes: 30, on: open.map((c) => c.kind), ...(expect ? { for: expect.replace(/^@/, '') } : {}) };
  };

  const addKnown: Roster['addKnown'] = async (agent, userId, ownedNow) => {
    const person = store.knownPeopleFor(agent.ownerId, agent.id).find((p) => p.userId === userId);
    if (!person) return notFound('Not someone you have admitted elsewhere — send them an invite instead.');
    // Every app this agent has that we know them on: Telegram by the seat,
    // Slack and Discord by the identity bound elsewhere.
    const grants = store.listChannelsForAgent(agent.id)
      .map((ch) => ({ ch, id: person.identities[ch.kind] }))
      .filter((g): g is { ch: Channel; id: string } => !!g.id);
    if (!grants.length) {
      return conflict(`This agent has no app you know ${person.name} on — send them an invite instead.`);
    }
    if (agent.state !== 'RUNNING') return conflict('Start the agent first — its allowlist lives in the container.');
    const admissionProvider = providerFor(agent.hostId);
    const channelsBefore = JSON.stringify(store.listChannelsForAgent(agent.id));
    const attempted: typeof grants = [];
    let committed = false;
    markBusy(agent.id);
    try {
      for (const g of grants) {
        attempted.push(g);
        await grantChannelAccess(
          { store, provider: admissionProvider, log: trace(agent.id) },
          { agentId: agent.id, runtimeRef: agent.runtimeRef, kind: g.ch.kind, accountId: g.ch.kind === 'telegram' ? g.ch.accountId : CHANNEL_ACCOUNT, channelUserId: g.id },
        );
      }
      const fresh = ownedNow();
      if (!fresh || fresh.state !== 'RUNNING' || fresh.runtimeRef !== agent.runtimeRef || fresh.hostId !== agent.hostId
          || providerFor(fresh.hostId) !== admissionProvider || JSON.stringify(store.listChannelsForAgent(agent.id)) !== channelsBefore) {
        throw new AdmitError('The agent changed while granting access. Refresh and try again.');
      }
      // Someone removed from this agent before keeps their old seat: it is
      // taken up again, as an invite does. A second row hit UNIQUE(agent_id,
      // user_id) after the allowlist was written — a 500, a seat left revoked
      // and a runtime that let them in anyway (audit #071).
      store.transact(() => {
        const current = store.getMembership(agent.id, person.userId);
        if (person.identities.telegram) {
          const holder = store.getActiveMembershipByChannelUser(agent.id, person.identities.telegram);
          if (holder && holder.userId !== person.userId) throw new AdmitError('That Telegram identity now belongs to another member. Refresh and try again.');
        }
        if (current) {
          if (current.status !== 'active') store.reactivateMembership(agent.id, person.userId, person.name);
          if (person.identities.telegram && !store.bindMembershipChannelUser(agent.id, person.userId, person.identities.telegram)) {
            throw new AdmitError('Their Telegram identity changed while granting access. Refresh and try again.');
          }
        } else {
          store.insertMembership({
            id: randomUUID(),
            agentId: agent.id,
            userId: person.userId,
            role: 'user',
            displayName: person.name,
            channelUserId: person.identities.telegram,
            status: 'active',
            joinedAt: new Date().toISOString(),
          });
        }
        for (const g of grants) if (g.ch.kind !== 'telegram' && !store.bindMemberIdentity(agent.id, person.userId, g.ch.kind, g.id)) {
          throw new AdmitError('Their chat identity changed while granting access. Refresh and try again.');
        }
      });
      committed = true;
      trace(agent.id)('member.added_known', { userId: person.userId, on: grants.map((g) => g.ch.kind) });
      await restDoor(agent);
      return { added: true, name: person.name };
    } catch (err) {
      if (!committed) {
        let removed = true;
        for (const g of attempted) {
          const done = await removeUnboundChannelAccess({ store, provider: admissionProvider, log: trace(agent.id) },
            { agentId: agent.id, runtimeRef: agent.runtimeRef, kind: g.ch.kind, accountId: g.ch.kind === 'telegram' ? g.ch.accountId : CHANNEL_ACCOUNT }, g.id);
          removed = done && removed;
        }
        if (!removed) return invalid('Adding the person failed and the chat approval could not be removed. Check the agent\'s channel access before trying again.');
      }
      if (err instanceof AdmitError) return invalid(err.userMessage);
      throw err;
    } finally {
      clearBusy(agent.id);
    }
  };

  return { isAccountId, accountLabel, list, setWebChat, webChatPeople, shareWebChat, remove, knownPeople, reopen, addKnown };
}
