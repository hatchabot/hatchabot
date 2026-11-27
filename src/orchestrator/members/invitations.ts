import type { Agent, Channel } from '../../domain/types.js';
import { CHANNEL_ACCOUNT } from '../../openclaw/configWriter.js';
import { NAMES_NOBODY, normalizeHandle, Store } from '../../store/store.js';
import { ID_SHAPE } from '../channels/channelIds.js';
import { claimFirstContact, holdDoorForKnocks, KnockWindowError, watchTimeLeft, windowRanOut, type WatchTime } from './claim.js';
import { AdmitError, grantChannelAccess, PRESS_WAIT_MS, removeUnboundChannelAccess } from './members.js';
import { checkInvite, createInvite, InviteInvalidError, redeemInvite, type InviteCheck } from './invite.js';
import type { MemberRefusal, MembersDeps } from './membersAndInvites.js';

/**
 * Invites and joining (HB-0808; §12.3):
 * who may be invited to an agent, the half hour a Telegram invite holds the
 * door open for a knock, and the admission of someone who redeems an invite,
 * on the web or on a chat app. The code itself and its single use are
 * invite.ts; the door, the claim of a first message and an approval written
 * on the volume are claim.ts and members.ts.
 *
 * No state of its own and no timer: the door's window and the claim's watch
 * are claim.ts's. A join is kept in the store (its `pending-joins` hold)
 * until its window has ended, and watched again at boot: one to an agent
 * that is not running (HB-0992), and one to a running agent, whose window a
 * restart left with nothing watching it (HB-0838). Nothing here knows about HTTP: the route reads the
 * request, signs the person in (a Google sign-in, or the session of someone
 * signed in here), holds the agent busy for a chat-app join, asks this, and
 * words the answer. A refusal is a `MemberRefusal`; a redemption that fails
 * throws `InviteInvalidError` or `AdmitError`, as it did.
 */
export interface Invitations {
  /**
   * A new invite, after the request's body was read: web chat only where
   * people sign in here, and never to the management agent. Undefined
   * `forHandle`: anyone with the link. `for`: the handle it is kept for, as
   * it is matched (none: anyone).
   */
  invite(agent: Agent, createdBy: string, opts: { forHandle?: string | undefined; webChat?: boolean | undefined }): MemberRefusal | { code: string; expiresAt: string; for?: string };
  /** A Telegram invite copied or shared: the door held open for its knock for 30 minutes. */
  holdKnockWindow(agent: Agent, code: string): Promise<MemberRefusal | KnockWindow>;
  /**
   * A web-chat invite redeemed by someone signed in here (`accountId`): let in
   * at once with web chat on, and on the gateway's list now. Not their own agent.
   */
  joinForWebChat(code: string, name: string, accountId: string): MemberRefusal | { agentName: string; agentId: string; webChat: true };
  /**
   * An invite redeemed for a chat app (`joinKind`), with the agent held busy
   * by the route. `pre` is the check made before the sign-in's wait. Someone
   * known on that app (and, for a named invite, its very person) is let in at
   * once; anyone else gets a window for their first message. An invite that
   * names nobody is refused, and left as it is, for an agent that waits for
   * its owner to start it (stopped, not asleep; or set up as far as a step
   * that waits for the owner, such as its bot).
   */
  joinOnApp(join: { code: string; name: string; accountId: string | undefined; joinKind: Channel['kind']; pre: InviteCheck }): Promise<MemberRefusal | JoinedOnApp>;
  /**
   * After a join to a sleeping agent (`notRunning`), once the route has let
   * go of the agent's turn: it is woken, so its window opens. A wake leaves
   * an agent held busy alone.
   */
  wakeForJoin(agentId: string): void;
  /**
   * At boot: every join still waiting for its agent to run (the
   * `pending-joins` hold) is watched again, for the time it has left: its
   * hour, or its week, counts from the join. One with nothing left to wait
   * for (no time left, the agent gone, its member removed or linked since)
   * is let go; one whose time ran out is said to the owner.
   */
  resumePendingJoins(): void;
}

/**
 * A join to an agent that was not running (HB-0992): its first-message window
 * waits for the agent's next start, wake or rebuild. Kept in the store (the
 * agent's `pending-joins` hold, a list of these), so a restart in the
 * meantime does not lose it; let go once its window has ended, claimed or not.
 * `at`: when they joined, the time its window counts from.
 */
interface PendingJoin {
  userId: string; kind: Channel['kind']; at: number; expect?: string;
  /**
   * Telegram ids its window never lets in: for an invite that names nobody,
   * joined while the agent slept, the people whose messages were waiting for
   * the bot as they joined (`wroteBeforeJoin`, HB-1221).
   */
  excludeIds?: string[];
  /**
   * Where its watch stands (claimFirstContact's `onKept`): its window's
   * generation, and the up-time it had left as of `seen`, not running while
   * the agent was `down` (HB-0838). A join to a running agent resumed after
   * a restart has that time, not a fresh half hour; one to an agent that has
   * not run since it joined still has its whole half hour.
   */
  generation?: string; left?: number; down?: boolean; seen?: number;
}
/** How long a join may spend asking Telegram whose a known id's handle is, every bot together (HB-1146). */
const HANDLE_LOOK_MS = 10_000;
/** How long a join to a sleeping agent may spend asking Telegram who has written to its bot (HB-1221). */
const WAITING_LOOK_MS = 5_000;
/** getUpdates' page, as the wake sweep asks for it (hibernate.ts): a full one may have more behind it. */
const WAITING_PAGE = 100;
/**
 * Who sent the direct messages among Telegram updates (a getUpdates page),
 * as ids of the shape Telegram issues. Only a message in a private chat with
 * the bot asks to pair: a group message, a button pressed or the bot started
 * is none, and taking those passed over a joiner who had only spoken to the
 * bot in a group (HB-1221 review). A message to a Telegram Business account
 * the bot is connected to is one too (`business_message`, a private chat):
 * whether OpenClaw makes a pairing request of it cannot be checked here, and
 * one it does make would come in first and take the seat, so its sender is
 * passed over as any other who wrote before the join (HB-1441).
 */
const sendersOf = (updates: unknown[]): string[] => {
  const ids = new Set<string>();
  for (const u of updates) {
    if (!u || typeof u !== 'object') continue;
    for (const kind of ['message', 'edited_message', 'business_message', 'edited_business_message'] as const) {
      const msg = (u as Record<string, unknown>)[kind] as { chat?: { type?: unknown }; from?: { id?: unknown } } | undefined;
      if (!msg || typeof msg !== 'object' || msg.chat?.type !== 'private') continue;
      const id = msg.from?.id;
      if ((typeof id === 'number' || typeof id === 'string') && ID_SHAPE.telegram.test(String(id))) ids.add(String(id));
    }
  }
  return [...ids];
};
/** The states a join's window waits through for the agent to run: down for now, as claimFirstContact counts it. */
const WAITS_TO_RUN: ReadonlySet<Agent['state']> = new Set(['STOPPED', 'REBUILDING', 'PROVISIONING']);
/**
 * Down until its owner does something: stopped (not asleep, which a join
 * wakes), or set up as far as its bot step and parked there. A rebuild, or a
 * setup that runs on its own, ends within minutes, running or failed; it
 * never goes back to stopped (provision.ts).
 */
const waitsForItsOwner = (a: Agent): boolean =>
  (a.state === 'STOPPED' && !a.hibernatedAt) || (a.state === 'PROVISIONING' && !!a.pendingAction);

export type KnockWindow =
  | { open: true; minutes: 0; alreadyOpen: true }
  | { open: true; minutes: 30; until: string | undefined; for?: string };

/** What the join page is told: every way in, so it can offer a button per app. */
export interface JoinedOnApp {
  agentName: string;
  channel: Channel['kind'];
  botUsername: string | undefined;
  deepLink: string | undefined;
  channels: Array<Record<string, unknown>>;
  /** The agent is not running: their first message is let in once it is (the join page says so; HB-0992). */
  notRunning?: true;
}

export function createInvitations(deps: MembersDeps): Invitations {
  const { store, secrets, providerFor, trace, consoleAccess, restDoor, forgetKnocks, opsPush, logError } = deps;
  const invalid = (error: string): MemberRefusal => ({ refused: 'invalid', error });
  const notFound = (error: string): MemberRefusal => ({ refused: 'not-found', error });
  const conflict = (error: string): MemberRefusal => ({ refused: 'conflict', error });

  const invite: Invitations['invite'] = (agent, ownerId, opts) => {
    // Web chat is used signed in: with one shared password there is nobody
    // else to sign in as (2026-09-29).
    if (opts.webChat && (deps.authMode() ?? 'password') === 'password') {
      return invalid('Chat on the web needs people to sign in to this Hatchabot — switch it to accounts or Google sign-in first (⚙ Settings → Access).');
    }
    // Your Hatchabot agent runs your whole machine: nobody else is ever let in,
    // by any door (2026-09-30 — only web-chat invites refused it before).
    if (agent.ops) return { refused: 'ops-alone' };
    const { code, expiresAt } = createInvite(store, agent.id, ownerId, opts.forHandle, { webChat: opts.webChat });
    if (opts.webChat) trace(agent.id)('invite.web_chat', {});
    // The handle it was kept for, as it is matched: what the dialog says it is for (HB-1439 review).
    const kept = store.getInviteByCode(code)?.expectHandle;
    return { code, expiresAt, ...(kept && kept !== NAMES_NOBODY ? { for: kept } : {}) };
  };

  /**
   * The Telegram invite was copied or shared: hold the door open for 30
   * minutes so the person it is for can knock (2026-09-30). The dialog
   * promised a "wants to join" prompt, but under Invite only a stranger's DM
   * is dropped in silence and nothing ever showed. The knock is only SHOWN —
   * under Alerts, and pushed like any other — and the owner's tap admits
   * it; when the invite named an @handle, only that person's knock is shown
   * and everyone else's is turned away by the sweep as before.
   */
  const holdKnockWindow: Invitations['holdKnockWindow'] = async (agent, code) => {
    if (agent.ops) return { refused: 'ops-alone' };
    const inv = store.getInviteByCode(code.trim().toUpperCase());
    if (!inv || inv.agentId !== agent.id || inv.webChat) return notFound('Not found');
    if (Date.parse(inv.expiresAt) < Date.now()) return { refused: 'expired', error: 'That invite has expired — make a new one.' };
    const channel = store.getChannelForAgent(agent.id, 'telegram');
    if (!channel) return conflict('This agent has no Telegram bot yet.');
    if (agent.state !== 'RUNNING' || !agent.runtimeRef) return conflict('Start the agent first — the door lives in its container.');
    // Open to anyone already: every knock is shown, nothing to hold open.
    if (agent.allowKnocks) return { open: true, minutes: 0, alreadyOpen: true };
    let until: string;
    try {
      ({ until } = await holdDoorForKnocks(
        { store, provider: providerFor(agent.hostId), providerFor, log: trace(agent.id) },
        { agentId: agent.id, runtimeRef: agent.runtimeRef, accountId: channel.accountId, key: inv.id, expect: inv.expectHandle, waitMs: PRESS_WAIT_MS },
      ));
    } catch (e) {
      // The door did not open, so no knock can come: say so (HB-0953).
      if (!(e instanceof KnockWindowError)) throw e;
      // Behind a slow write of its chat apps longer than a press waits (HB-1554).
      if (e.outcome === 'busy') return conflict(e.message);
      return e.outcome === 'failed'
        ? { refused: 'failed', error: "Couldn't open the agent's door for their message just now — copy the invite again in a moment." }
        : conflict("The agent's container has no Telegram set up, so its door can't open for them — rebuild the agent, then copy the invite again.");
    }
    forgetKnocks(agent.id);
    return { open: true, minutes: 30, until, ...(inv.expectHandle && inv.expectHandle !== NAMES_NOBODY ? { for: inv.expectHandle } : {}) };
  };

  /**
   * A web-chat invite: signed in, let in at once with web chat on. No pairing
   * window, no channel — they talk to it from this app.
   */
  const joinForWebChat: Invitations['joinForWebChat'] = (code, name, accountId) => {
    const inv = checkInvite(store, code);
    const agent = inv.valid ? store.getAgent(inv.agentId) : undefined;
    if (agent && agent.ownerId === accountId) {
      return invalid('This is your own agent — you can already talk to it.');
    }
    try {
      const joined = redeemInvite(store, code, name, accountId);
      trace(joined.agentId)('member.web_chat_joined', { userId: joined.membershipUserId });
      // Their name goes on the gateway's list NOW, not at their first open:
      // the new list reloads the gateway's auth and every open console (the
      // owner's too) reconnects — better while they are not connected yet.
      // Their console/access call waits for this run (2026-09-30).
      const joinedAgent = store.getAgent(joined.agentId);
      if (joinedAgent?.state === 'RUNNING') void consoleAccess.ensureReady(joinedAgent, 'grant').catch(() => {});
      return { agentName: store.getAgent(joined.agentId)!.name, agentId: joined.agentId, webChat: true };
    } catch (err) {
      if (err instanceof InviteInvalidError) return invalid(err.userMessage);
      throw err;
    }
  };

  /** Who someone signed in here is on a chat app, from another of the agents they are on. */
  const knownOn = (accountId: string | undefined, kind: Channel['kind']): string | undefined =>
    !accountId ? undefined : kind === 'telegram' ? store.knownChannelUserId(accountId) : store.identityOfUserAnywhere(accountId, kind);

  // Redeem + start watching for the invitee's first Telegram contact,
  // exactly like the owner's claim.
  const joinOnApp: Invitations['joinOnApp'] = async ({ code, name, accountId, joinKind, pre }) => {
    // The app they chose must still be one this agent is on: one removed
    // since their invite page loaded burned the single-use code for a seat
    // with no way in (audit #072). Telegram stands for "no app yet", as on
    // the invite page. Checked here, after the last wait, so nothing can
    // remove it between this and the redemption.
    if (pre.valid) {
      const on = store.listChannelsForAgent(pre.agentId);
      if (!on.some((c) => c.kind === joinKind) && (joinKind !== 'telegram' || on.length)) {
        const app = { telegram: 'Telegram', slack: 'Slack', discord: 'Discord' }[joinKind];
        return conflict(`${store.getAgent(pre.agentId)?.name ?? 'This agent'} is no longer on ${app}. Your invite is still good: reload this page to see the apps it is on now.`);
      }
    }
    // An invite that names nobody lets in the first person to write once the
    // window is open, and an hour from the join at most, time down included.
    // Kept for an agent that waits for its owner to start it, the first DM
    // Telegram handed over at the start, anyone's, days later, would take the
    // seat (HB-0992 review). Refused instead, with the invite left as it is.
    // So too with no bot on that app yet (parked at its bot step): the join
    // used the invite and made a member nothing would ever let in, since a
    // bot attached later opens a window for its owner only. Someone known
    // on that app is not anyone: their window is for them.
    if (pre.valid) {
      const target = store.getAgent(pre.agentId);
      if (target && waitsForItsOwner(target)
          && !store.getInviteByCode(code.trim().toUpperCase())?.expectHandle && !knownOn(accountId, joinKind)) {
        return conflict(`${target.name} isn't running right now. Ask its owner to start it, then open this invite again: it is still good.`);
      }
    }
    const joined = redeemInvite(store, code, name, accountId);
    // Which app they chose: "Let them in again" reopens that one only (2026-09-30).
    store.setInviteRedeemedVia(code, joinKind);
    const agent = store.getAgent(joined.agentId)!;
    const channelRow = store.getChannelForAgent(agent.id, joinKind);
    const admissionProvider = providerFor(agent.hostId);
    const channelsBefore = JSON.stringify(store.listChannelsForAgent(agent.id));
    const joinStillCurrent = () => {
      const now = store.getAgent(agent.id);
      return !!now && now.ownerId === agent.ownerId && now.runtimeRef === agent.runtimeRef && now.hostId === agent.hostId
        && now.state === agent.state && providerFor(now.hostId) === admissionProvider
        && JSON.stringify(store.listChannelsForAgent(agent.id)) === channelsBefore
        && store.getMembership(agent.id, joined.membershipUserId)?.status === 'active';
    };
    // Someone who already uses another of this owner's agents is not a
    // stranger: their Telegram id is on file, so admit them outright rather
    // than making them do the pairing dance a second time. The allowlist is
    // written on the volume and the gateway re-reads it per message, so
    // their first message just works — and no pairing window is opened,
    // which is one fewer moment when the door stands ajar.
    // An invite made for an @handle admits only that person: a known id is
    // used outright only when the invite named that very id; otherwise the
    // claim below checks the handle (night review, 2026-09-27).
    // As read back (expectedHandle): its name, or NAMES_NOBODY, which no id or name compared as one can be.
    const expected = joined.expectHandle;
    const knownIdRaw = knownOn(accountId, joinKind);
    // The handle behind a known Telegram id, asked of a bot of the owner's
    // that already talks to them: a known member invited for their own
    // @handle is let in at once again, and only they are (2026-09-28).
    // Without it the join goes on to the claim, which checks the handle.
    // A bot Telegram says cannot see them is passed over for the next; an
    // answer that is not Telegram's (a timeout, no network, not JSON) ends
    // the look, since every bot is asked of the same Telegram; and the
    // whole look ends within HANDLE_LOOK_MS, a bot token's read included.
    // Each failed bot cost five seconds, one after another, with the invite
    // already used (HB-1146). A look that ends unchecked says so.
    const handleOf = async (id: string): Promise<string | undefined> => {
      const deadline = AbortSignal.timeout(deps.handleLookMs ?? HANDLE_LOOK_MS);
      const inTime = <T>(p: Promise<T>): Promise<T | undefined> => new Promise((done) => {
        const late = () => done(undefined);
        if (deadline.aborted) return late();
        deadline.addEventListener('abort', late, { once: true });
        p.then((v) => { deadline.removeEventListener('abort', late); done(v); }, () => { deadline.removeEventListener('abort', late); done(undefined); });
      });
      let asked = 0;
      for (const a of store.listAgents(agent.ownerId)) {
        if (deadline.aborted) {
          trace(agent.id)('invite.handle_unchecked', { asked, outOfTime: true });
          return undefined;
        }
        const ch = store.getChannelForAgent(a.id, 'telegram');
        if (!ch || !store.listAllowedChannelUserIds(a.id).includes(id)) continue;
        const tok = await inTime(secrets.get(ch.secretRef));
        if (!tok) continue;
        asked++;
        const r = await deps.telegramFetch(`https://api.telegram.org/bot${tok}/getChat?chat_id=${encodeURIComponent(id)}`, { signal: AbortSignal.any([deadline, AbortSignal.timeout(5000)]) })
          .then((x) => x.json() as Promise<{ ok?: boolean; result?: { username?: string } } | null>).catch(() => undefined);
        if (!r || typeof r !== 'object') {
          trace(agent.id)('invite.handle_unchecked', { asked });
          return undefined;
        }
        if (r.ok) return r.result?.username;
      }
      // Ran out while the last bot's token was read (or its answer came):
      // unchecked as well, and said so.
      if (deadline.aborted) trace(agent.id)('invite.handle_unchecked', { asked, outOfTime: true });
      return undefined;
    };
    const matchesExpected = !expected || normalizeHandle(knownIdRaw) === expected
      || (!!knownIdRaw && joinKind === 'telegram' && normalizeHandle(await handleOf(knownIdRaw)) === expected);
    const knownId = matchesExpected ? knownIdRaw : undefined;
    // Asleep, and open to anyone: who has written to the bot meanwhile wrote
    // before this join, and is never let in by its window (HB-1221).
    const wroteBefore = joinKind === 'telegram' && channelRow && agent.hibernatedAt && agent.state === 'STOPPED'
      && !joined.expectHandle && !knownId ? await wroteBeforeJoin(agent, channelRow) : undefined;
    if (!joinStillCurrent()) throw new AdmitError('The agent or your membership changed while joining. Ask the owner for a new invitation.');
    if (knownId && agent.runtimeRef && channelRow && agent.state === 'RUNNING') {
      const grantOpts = { agentId: agent.id, runtimeRef: agent.runtimeRef, kind: joinKind, accountId: joinKind === 'telegram' ? channelRow.accountId : CHANNEL_ACCOUNT, channelUserId: knownId };
      const grantDeps = { store, provider: admissionProvider, log: trace(agent.id) };
      let granted = false;
      let skipped = false;
      const identityNow = () => (!accountId ? undefined : joinKind === 'telegram'
        ? store.knownChannelUserId(accountId) : store.identityOfUserAnywhere(accountId, joinKind));
      try {
        // The join, and the id they are known by, looked at again in the
        // grant's turn: removed while it waited for their removal's scrub, it
        // wrote them back after the flip (HB-1554); an id unlinked meanwhile
        // is not let in either. Not still so, nothing is written.
        skipped = (await grantChannelAccess(grantDeps, { ...grantOpts, onlyIf: () => joinStillCurrent() && identityNow() === knownId })) === 'skipped';
        granted = !skipped;
      } catch (err) {
        logError({ err }, 'known-invitee grant failed'); // fall through to pairing after cleanup
      }
      const current = joinStillCurrent() && identityNow() === knownId;
      const bound = granted && current && (joinKind === 'telegram'
        ? store.bindMembershipChannelUser(agent.id, joined.membershipUserId, knownId)
        : store.bindMemberIdentity(agent.id, joined.membershipUserId, joinKind, knownId));
      if (!bound) {
        // Skipped, nothing was written: nothing to take back.
        if (!skipped && !(await removeUnboundChannelAccess(grantDeps, grantOpts, knownId))) {
          throw new AdmitError('The chat approval could not be removed after joining failed. Ask the owner to check the agent\'s channel access.');
        }
        if (!current || granted) throw new AdmitError('Your membership or chat identity changed while joining. Ask the owner for a new invitation.');
      } else {
        trace(agent.id)('member.known_admitted', { userId: joined.membershipUserId });
        await restDoor(agent);
      }
    }
    // Stopped (asleep too), or being set up or rebuilt: the join is kept,
    // and its window waits for the agent to run, as claimFirstContact waits:
    // one that names its person up to a week, one open to anyone an hour from
    // the join, time down included. It consumed the invite and opened
    // nothing before, and their first message was dropped under the
    // allowlist (HB-0992).
    let notRunning = false;
    if (!store.memberIdentities(agent.id, joined.membershipUserId)[joinKind]
        && agent.runtimeRef && channelRow && (agent.state === 'RUNNING' || WAITS_TO_RUN.has(agent.state))) {
      // Someone known on that app, not let in outright (the agent not running,
      // or the grant failed): the window is for their id. Open to anyone, it
      // turned their own knock away, as an id known here (HB-0992 review).
      const expect = joined.expectHandle ?? knownId;
      const join: PendingJoin = {
        userId: joined.membershipUserId, kind: joinKind, at: Date.now(), ...(expect ? { expect } : {}),
        ...(!expect && wroteBefore?.length ? { excludeIds: wroteBefore } : {}),
      };
      // Kept whether or not it runs: a restart while their window is open
      // left it with nothing watching it, and their first message showed as
      // a stranger's knock (HB-0838). The next start watches it again.
      keepJoin(agent.id, join);
      if (agent.state !== 'RUNNING') notRunning = true;
      watchJoin(agent, join, channelRow);
    }
    // Every way in, so the join page can offer a button per app.
    const ways = store.listChannelsForAgent(agent.id).map((c) => {
      const st = (c.settings ?? {}) as Record<string, unknown>;
      return {
        kind: c.kind,
        deepLink: c.deepLink,
        ...(c.kind === 'slack' ? { team: st.team } : {}),
        ...(c.kind === 'discord' ? { servers: Array.isArray(st.servers) ? (st.servers as Array<{ name?: string }>).map((g) => g.name) : [] } : {}),
      };
    });
    return {
      agentName: agent.name,
      channel: joinKind,
      botUsername: joinKind === 'telegram' ? channelRow?.accountId : undefined,
      deepLink: channelRow?.deepLink,
      channels: ways,
      ...(notRunning ? { notRunning: true } as const : {}),
    };
  };

  /**
   * Who has messages waiting for a sleeping agent's bot (HB-1221). Telegram
   * hands them over at the wake, and OpenClaw dates a pairing request when
   * it reads the message, not when it was sent: a stranger who wrote just
   * before the join (the wake sweep had not seen it yet), or while the sweep
   * could not look, came in first and took a seat open to anyone. Asked as
   * the wake sweep asks (getUpdates with no offset, which confirms nothing:
   * hibernate.ts), while the join holds the agent's turn, so no gateway is
   * reading the bot meanwhile; everything waiting was sent before this
   * join. Undefined when Telegram could not be asked, or answered a full
   * page (the oldest hundred: a sender behind them is not seen, as the wake
   * sweep takes it), said on the trail: the window is then open to the first
   * message, as before.
   */
  const wroteBeforeJoin = async (agent: Agent, channelRow: Channel): Promise<string[] | undefined> => {
    const unread = (fullPage = false): undefined => { trace(agent.id)('invite.waiting_unread', fullPage ? { fullPage } : {}); return undefined; };
    const tok = await secrets.get(channelRow.secretRef).catch(() => undefined);
    if (!tok) return unread();
    const r = await deps.telegramFetch(`https://api.telegram.org/bot${tok}/getUpdates?limit=${WAITING_PAGE}&timeout=0`, { signal: AbortSignal.timeout(WAITING_LOOK_MS) })
      .then((x) => x.json() as Promise<{ ok?: boolean; result?: unknown } | null>).catch(() => undefined);
    if (!r || r.ok !== true || !Array.isArray(r.result)) return unread();
    if (r.result.length >= WAITING_PAGE) return unread(true);
    // Who is let in on it already is nobody passed over: the page holds the
    // gateway's last batch until it asks again, so the owner's own message, or a
    // member's, was one, and the owner was told someone had been (HB-1221
    // review). The window never claims them anyway (claim.ts).
    const allowed = new Set([...store.listAllowedChannelUserIds(agent.id, 'telegram'), store.knownChannelUserId(agent.ownerId)]);
    return sendersOf(r.result).filter((id) => !allowed.has(id));
  };

  // ---- a join waiting for its agent to run (HB-0992) -----------------------
  const pendingJoins = (agentId: string, raw = store.agentHold(agentId, 'pending-joins')): PendingJoin[] => {
    try {
      const list: unknown = JSON.parse(raw ?? '[]');
      return Array.isArray(list) ? list.filter((j): j is PendingJoin => typeof j?.userId === 'string' && typeof j?.kind === 'string' && typeof j?.at === 'number') : [];
    } catch { return []; }
  };
  /** The join's person is still a member, and not linked on its app yet: someone its window is still for. */
  const unlinkedMember = (agentId: string, join: PendingJoin): boolean =>
    store.getMembership(agentId, join.userId)?.status === 'active' && !store.memberIdentities(agentId, join.userId)[join.kind];
  const sameJoin = (a: PendingJoin, b: PendingJoin) => a.userId === b.userId && a.kind === b.kind;
  /** This very join, not a later one of the same seat (joined again after a removal). */
  const thisJoin = (a: PendingJoin, b: PendingJoin) => sameJoin(a, b) && a.at === b.at;
  const keepJoin = (agentId: string, join: PendingJoin): void => {
    store.setAgentHold(agentId, 'pending-joins', JSON.stringify([...pendingJoins(agentId).filter((j) => !sameJoin(j, join)), join]));
  };
  /**
   * This join goes from the store. `generation`: only while its watch is
   * that one, as the store says (noteWatch): in a deploy's overlap the newer
   * process takes a kept join up with a window of its own, and the older
   * one's watch, taken over, let go of the join the newer one now watches,
   * so a later restart never watched it again (HB-1224). A watch the
   * owner's Reopen took over is still its own in the store, and goes.
   * True when this call took it out: only that one tells the owner how the
   * join ended. In a deploy's overlap both processes could, each having
   * seen it end (its time run out, a window the other closed, an agent
   * that failed), and the owner was told twice (HB-1520). Taken out only
   * while the list is as it was read (replaceAgentHold), so of two
   * processes at once only one does; the other reads it again.
   */
  const letJoinGo = (agentId: string, join: PendingJoin, generation?: string): boolean => {
    for (let tries = 0; tries < 5; tries++) {
      const raw = store.agentHold(agentId, 'pending-joins');
      if (raw === undefined) return false;
      const all = pendingJoins(agentId, raw);
      const rest = all.filter((j) => !thisJoin(j, join) || (!!generation && !!j.generation && j.generation !== generation));
      if (rest.length === all.length) {
        // Nothing of it: a hold that names nobody is cleared, as before.
        if (!all.length) store.clearAgentHold(agentId, 'pending-joins', raw);
        return false;
      }
      if (rest.length ? store.replaceAgentHold(agentId, 'pending-joins', raw, JSON.stringify(rest)) : store.clearAgentHold(agentId, 'pending-joins', raw)) return true;
    }
    return false;
  };
  /** Where this join's watch stands, with the join: what the next start resumes it with (HB-0838). */
  const noteWatch = (agentId: string, join: PendingJoin, t: WatchTime): void => {
    const all = pendingJoins(agentId);
    if (!all.some((j) => thisJoin(j, join))) return; // let go meanwhile
    store.setAgentHold(agentId, 'pending-joins', JSON.stringify(all.map((j) => (thisJoin(j, join)
      ? { ...j, generation: t.generation, left: t.left, down: t.down, seen: t.at } : j))));
  };
  /**
   * The window for a joiner's first message, from when they joined (at boot,
   * for the up-time it had left, `timeoutMs`). Once its own window has ended, claimed or not,
   * the join kept for it is let go. One taken over by a later watcher of the
   * seat says nothing: the owner's word if nobody writes is that watcher's
   * (HB-0992 review). It still lets go of its own join, which the later one
   * (the owner's Reopen) knows nothing of and would leave behind for the
   * next start to watch again; a join of the seat made since is another
   * join, with its own time, and stays.
   */
  const watchJoin = (agent: Agent, join: PendingJoin, channelRow: Channel, timeoutMs = 30 * 60_000): void => {
    let takenOver = false;
    /** This watch's window, as it told the store (onKept). */
    let mine: string | undefined;
    void claimFirstContact(
      { store, provider: providerFor(agent.hostId), providerFor, log: trace(agent.id), ...(deps.sleep ? { sleep: deps.sleep } : {}) },
      {
        agentId: agent.id,
        runtimeRef: agent.runtimeRef!,
        accountId: join.kind === 'telegram' ? channelRow.accountId : CHANNEL_ACCOUNT,
        forUserId: join.userId,
        kind: join.kind,
        expect: join.expect,
        ...(Array.isArray(join.excludeIds) ? { excludeIds: join.excludeIds.filter((id): id is string => typeof id === 'string') } : {}),
        timeoutMs,
        openedAt: join.at,
        excludeKnocks: true, // nor shown as the one it waits for: they might have got in first
        kept: true, // as a join (pending-joins), not as a watch: its end is said from here
        onKept: (t) => { mine = t.generation; noteWatch(agent.id, join, t); },
        onSuperseded: () => { takenOver = true; },
      },
    ).then(
      (bound) => {
        const went = letJoinGo(agent.id, join, mine);
        if (takenOver) return;
        // Removed meanwhile: nobody is waiting to be told about (HB-1223).
        // Let go by another process already (a deploy's overlap), it was
        // that one's to tell (HB-1520).
        if (!bound && went && unlinkedMember(agent.id, join)) neverMessaged(agent, false, !!join.excludeIds?.length);
      },
      // Kept, if it was: the next start of Hatchabot watches for it again.
      (err) => logError({ err }, 'invitee claim failed'),
    );
  };

  /**
   * Redeemed, then never messaged. Under `allowlist` their late message is
   * dropped in silence — they see nothing and neither would you, so say it
   * now while the invite is fresh. Members are under the agent's Sharing tab
   * for every app (web/app/sheet.js): it said "→ Telegram → Members" for a
   * join on Discord or Slack too, and that tab has no Members (HB-1219).
   * `whileDown`: its time ran out with nothing watching it (its window still
   * stored at the boot: Hatchabot was stopped, for a restart or for days, or
   * its watch had failed), so they may have written then, and not been let
   * in: a window is never opened again once its time is up (HB-0838 review).
   * It said "while Hatchabot was restarting" after an outage of days too
   * (HB-1412). Their message waits under
   * Alerts only where the agent would show it there (anyone may knock, or
   * they are known from another agent); otherwise it was turned away.
   */
  /**
   * The owner told a join ended unused. `failedUnwatched`: its window was
   * still stored at the start, its agent failed meanwhile, so no watch saw
   * either; "never messaged" was not known to be true (HB-1523 review).
   */
  const neverMessaged = (agent: Agent, whileDown = false, passedOver = false, failedUnwatched = false): void => {
    void opsPush.waiting(
      agent.ownerId,
      failedUnwatched
        ? `⏳ Someone opened your invite to "${agent.name}", but it was not watched while the agent had failed, so it was closed unused.`
        : whileDown
        ? `⏳ Someone opened your invite to "${agent.name}", but its time to message it ran out while Hatchabot was not watching for their message.`
        : passedOver
          // Its window passed over who had written to the bot before the join
          // (HB-1221): that may have been the invitee, so "never messaged" may be untrue.
          ? `⏳ Someone opened your invite to "${agent.name}", but no message from them was let in.`
          : `⏳ Someone opened your invite to "${agent.name}" but never messaged it.`,
      failedUnwatched
        ? 'They may have written meanwhile; if so, their message was not let in. Once the agent runs again, open it → Sharing → Members, press "Let them in again" and ask them to write again.'
        : whileDown
        ? 'They may have written meanwhile; if so, their message was not let in. If it is waiting under "Alerts", let them in there; if not, open that agent → Sharing → Members, press "Let them in again" and ask them to write again.'
        : passedOver
          ? 'Anyone who had already written to its bot when the invite was opened was passed over, as they might have got in first. If that was the person you invited, open that agent → Sharing → Members, press "Let them in again" and ask them to write again. To be sure only they get in, invite them by their @handle.'
          : 'Open that agent → Sharing → Members and press "Let them in again" when they are ready.',
    );
  };

  const wakeForJoin: Invitations['wakeForJoin'] = (agentId) => {
    const agent = store.getAgent(agentId);
    if (!agent?.hibernatedAt || agent.state !== 'STOPPED') return;
    void deps.wake(agent, 'someone joined by an invite').catch((err) => logError({ err, agentId }, 'wake after a join failed'));
  };

  /** Something to wait for still: an agent that runs or will, the app, a member not linked on it yet. */
  const stillWaits = (agent: Agent, join: PendingJoin): boolean =>
    !!agent.runtimeRef && (agent.state === 'RUNNING' || WAITS_TO_RUN.has(agent.state)) && unlinkedMember(agent.id, join);
  const resumePendingJoins: Invitations['resumePendingJoins'] = () => {
    for (const { agentId } of store.agentHolds('pending-joins')) {
      const agent = store.getAgent(agentId);
      const joins = pendingJoins(agentId);
      if (!joins.length) store.clearAgentHold(agentId, 'pending-joins');
      for (const join of joins) {
        const channelRow = agent ? store.getChannelForAgent(agent.id, join.kind) : undefined;
        const seat = Store.pairingSeat(join.kind, join.userId);
        const row = store.pairingWindows(agentId, new Date(0)).find((w) => w.seat === seat);
        const passedOver = !!join.excludeIds?.length;
        if (!agent || !channelRow || !stillWaits(agent, join)) {
          const went = letJoinGo(agentId, join);
          // Its window given up for an agent that failed, by its live watch,
          // which closed it and was cut off by the restart before it let the
          // join go and told the owner: told here, as it would have (HB-1412).
          // It was let go in silence. Said only by the one that let it go, so
          // a later restart, or the other process in a deploy's overlap, does
          // not say it again (HB-1520). Its window still stored, its own (or kept before its watch said
          // which it was), the watch was cut off before it saw the failure:
          // given up here as that watch would have, the window closed and the
          // owner told, once. It was let go in silence, and the row stayed
          // until its time ran out (HB-1523). Another watch's (the owner's
          // Reopen) is that watch's.
          // Only by the call that let it go: another's (the other process
          // in a deploy's overlap) is that one's to close and say.
          const own = !!row && (!join.generation || row.generation === join.generation);
          const unwatched = went && agent?.state === 'FAILED' && own;
          if (unwatched) {
            store.closePairingWindow(agentId, seat);
            trace(agentId)('claim.window_abandoned', { agentId, state: agent.state, afterRestart: true });
          }
          if (went && agent?.state === 'FAILED' && channelRow && (own || (!!join.generation && !row)) && unlinkedMember(agentId, join)) neverMessaged(agent, false, passedOver, unwatched);
          continue;
        }
        // Its seat's window another watch's since (the owner's Reopen, which
        // may name the person; the seat joined again): not this join's to open
        // again, and nothing is said, as the live watch, taken over, says
        // nothing. Opened again here, it replaced the later watch's window
        // with its own older one, perhaps open to anyone (HB-0838 review). A
        // join kept before its watch said its window's generation is taken as
        // its own, as before.
        if (join.generation && row && row.generation !== join.generation) { letJoinGo(agentId, join); continue; }
        // The up-time its window had left (HB-0838): at its last look, less the
        // time since unless the agent was down then. A join kept before its
        // watch said so has its whole half hour, as before.
        const left = join.left === undefined ? 30 * 60_000 : watchTimeLeft({ left: join.left, down: !!join.down, at: join.seen ?? join.at });
        // Its time ran out (its half hour, or its hour or week from the join):
        // ended unclaimed, as the watch would have, its window closed, never
        // opened again, and its owner told, once. Its window closed already
        // is the live watch's end, cut off by the restart before it let the
        // join go and said so: said here (HB-0838 review). Said only if it
        // let the join go itself, so it is never said twice, nor by both
        // processes in a deploy's overlap (HB-1520). Its window still
        // there, its time ran out while Hatchabot was not running: they may
        // have written then, and the owner is told so.
        if (left <= 0 || windowRanOut(join.at, !!join.expect)) {
          if (row) store.closePairingWindow(agentId, seat);
          if (letJoinGo(agentId, join)) neverMessaged(agent, !!row, passedOver);
          continue;
        }
        // Closed with time still left, its person still to come: the live
        // watch's end for another reason (the agent moved to another
        // machine), which the restart cut off before it let the join go and
        // told the owner. Not its to open again, and told here, as the watch
        // would have (HB-1412): it was let go in silence. Said only by the one
        // that let it go, so a later restart, or the other process in a
        // deploy's overlap, does not say it again (HB-1520). A member taken
        // off, or linked on that app since, is no longer waited for: let go above.
        if (join.generation && !row) { if (letJoinGo(agentId, join)) neverMessaged(agent, false, passedOver); continue; }
        watchJoin(agent, join, channelRow, left);
      }
    }
  };

  return { invite, holdKnockWindow, joinForWebChat, joinOnApp, wakeForJoin, resumePendingJoins };
}
