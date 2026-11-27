import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Agent } from '../../domain/types.js';
import { AgentBusyError, markBusy } from '../../orchestrator/lifecycle/busy.js';
import { pairingKind } from '../../orchestrator/channels/knocks.js';
import { AdmitError, RevokeError } from '../../orchestrator/members/members.js';
import { ALREADY_MEMBER, checkInvite, InviteInvalidError } from '../../orchestrator/members/invite.js';
import type { MemberRefusal } from '../../orchestrator/members/membersAndInvites.js';
import { admittedPrincipal, IdentityError } from '../signIn/identity.js';
import { LOCAL_OWNER, ownerIdOf, principalOf } from '../principal.js';
import { OPS_ALONE, zodMessage, type RouteContext } from '../routeContext.js';
import { requestIsHttps } from '../signIn/sessionCookie.js';
import { isPublic } from '../trust.js';
import { HANDLE_MAX, handleText } from '../../store/store.js';

/**
 * POST /v1/agents/:id/invites: who it is for (a Telegram @handle), and whether
 * it is to chat on the web. A `for` that is no handle is refused, as Reopen's
 * (typedHandle): it was kept as none, and the invite was anyone's (HB-1439
 * review). Its 64 is the name's, not a link's (HANDLE_MAX).
 */
const NewInvite = z.object({ for: z.string().max(256).nullish(), webChat: z.boolean().optional() });

/**
 * PUT /v1/agents/:id/members/:userId/web-chat (HB-0814): on or off. Anything
 * else, the body included, is answered in the words it always was.
 */
const SetWebChat = z.object({ on: z.boolean() });

/** POST /v1/agents/:id/web-chat/people: one of the people offered, and the name they are shown by. */
const ShareWebChat = z.object({ userId: z.string().min(1).max(200), name: z.string().trim().max(64).optional() });

/**
 * POST /v1/join (HB-0814): the invite's code, the name they give, a Google
 * sign-in made on the join page, and the app they will message. `null` is as
 * good as leaving a field out, as it was.
 */
const JoinBody = z.object({
  code: z.string().nullish(),
  name: z.string().nullish(),
  idToken: z.string().nullish(),
  channel: z.string().nullish(),
  /** A chat-app invite: "Join as <name>" was pressed, so the seat is this session's account's (HB-1149). Never assumed. */
  asAccount: z.boolean().nullish(),
});

/**
 * POST /v1/agents/:id/members/:userId/reopen (HB-0814): the @handle the owner
 * typed, if any. Empty or left out: no handle, as it always was. Anything
 * else that is no handle is refused (HB-1439 review): it was taken as none,
 * and the door the owner meant for one person opened to whoever wrote first.
 */
const ReopenBody = z.object({ handle: z.string().max(256).nullish() });
const NOT_A_HANDLE = `That is not an @handle: give theirs (no more than ${HANDLE_MAX} characters after the @), or leave it empty.`;

/**
 * A handle typed, for an invite or a Reopen: '' when none was (empty, blank or
 * left out, as it always was); its name, without its @s or link (handleText);
 * undefined when it is no handle, which the routes refuse with NOT_A_HANDLE.
 */
function typedHandle(raw: string | null | undefined): string | undefined {
  const given = raw?.trim() ?? '';
  if (!given) return '';
  const name = handleText(given);
  return name && name.length <= HANDLE_MAX ? name : undefined;
}

/** POST /v1/agents/:id/members/known: one of the people known from another agent. */
const AddKnown = z.object({ userId: z.string().min(1) });

const NO_ACCOUNTS_HERE = 'Chat on the web needs people to sign in to this Hatchabot — switch it to accounts or Google sign-in first (⚙ Settings → Access).';

/** A refusal of the service, in its status and words. */
function refuse(reply: FastifyReply, r: MemberRefusal): FastifyReply {
  if (r.refused === 'ops-alone') return reply.code(400).send({ error: OPS_ALONE });
  const status = { invalid: 400, 'not-found': 404, conflict: 409, expired: 410, failed: 502 }[r.refused];
  return reply.code(status).send({ error: r.error, ...(r.refused === 'conflict' && r.code ? { code: r.code } : {}) });
}

/**
 * Members, invites and web chat: the routes (HB-0808; §12.3).
 *
 * An agent's invites (a new one; a Telegram invite's half hour for a knock),
 * the join page's two routes (what an invite opens, and redeeming it), the
 * members (the list; web chat on or off for one; removing one; the door
 * reopened for one who never wrote), the people known from another agent
 * (the list, and adding one), and sharing for web chat with someone on this
 * Hatchabot. Each route reads its request and words the answer; the rules
 * are the members service's (`ctx.members`, src/orchestrator/members/):
 * `invites` and `roster`.
 *
 * Here because it is HTTP: who a join request is (a Google sign-in made on
 * the join page, or the session cookie of someone signed in here, held to the
 * public gate's rules), the guess limits on an invite's code, and holding the
 * agent busy across a chat-app join. The join page itself (GET /join/:code)
 * is the page's, served in routes.ts with the page's scripts. The web chat
 * turn is src/api/chat/webChat.ts.
 */
export function registerMemberRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { deps, store, trace, ownedAgent, ownsLocalHost, busyNow, linkUrlFor, localAccountsOn } = ctx;
  const { invites, roster } = ctx.members;

  // ---- invites & join (§12.3) --------------------------------------------

  /**
   * The account behind a join request (2026-09-29): a Google sign-in made on
   * the join page, or the session cookie of someone already signed in here
   * (/v1/join is auth-exempt, so the hook has not read it). Never the
   * password-mode owner: that is the owner, not an invitee.
   */
  const joiningAccount = async (req: FastifyRequest, idToken?: string | null, opts: { acceptingWebChat?: boolean } = {}): Promise<{ accountId?: string; factorRefusal?: { error: string; secondFactor: string } }> => {
    if (idToken && deps.verifier) {
      const token = await deps.verifier.verify(idToken); // throws on a bad token
      return { accountId: admittedPrincipal(token).ownerId };
    }
    const decorated = (app as unknown as { principalFromCookieHeader?: (h: string | undefined, https: boolean) => { ownerId: string } | undefined }).principalFromCookieHeader;
    let fromCookie = decorated?.(req.headers.cookie, requestIsHttps(req))?.ownerId;
    // This open route reads the session itself: at the public address it
    // counts only with what the gate asks of every signed-in request (the
    // public pass, and the second factor when the person has one).
    let factorRefusal: { error: string; secondFactor: string } | undefined;
    if (fromCookie && isPublic(req)) {
      const refused = app.publicAccess ? app.publicAccess.refuseSession(req.raw, fromCookie, opts) : 'no public gate';
      if (refused) {
        // A good sign-in that only lacks a factor is told so; anything else looks like no sign-in (HB-0400).
        if (app.publicAccess && fromCookie !== LOCAL_OWNER) factorRefusal = app.publicAccess.factorRefusal(req.raw, fromCookie, refused);
        fromCookie = undefined;
      }
    }
    // Tests say who they are with the opt-in header (principal.ts).
    const p = fromCookie ?? (principalOf(req).via === 'header' ? principalOf(req).ownerId : undefined);
    return p && p !== LOCAL_OWNER ? { accountId: p } : { factorRefusal };
  };

  /**
   * A web-chat invite: signed in, let in at once with web chat on. No pairing
   * window, no channel — they talk to it from this app.
   */
  const joinForWebChat = async (req: FastifyRequest, reply: any, body: { code?: string | null; name?: string | null; idToken?: string | null }) => {
    if ((deps.authMode ?? 'password') === 'password') {
      return reply.code(400).send({ error: 'This Hatchabot has no accounts to sign in with, so it cannot offer chat on the web.' });
    }
    let joining: Awaited<ReturnType<typeof joiningAccount>>;
    try { joining = await joiningAccount(req, body.idToken, { acceptingWebChat: true }); }
    catch (err) { return reply.code(err instanceof IdentityError ? err.statusCode : 401).send({ error: err instanceof IdentityError ? err.userMessage : "That sign-in didn't verify — try again." }); }
    const accountId = joining.accountId;
    if (!accountId) return reply.code(401).send(joining.factorRefusal ?? { error: 'Sign in to this Hatchabot first.', signIn: true });
    const joined = invites.joinForWebChat(body.code!, body.name ?? '', accountId);
    if ('refused' in joined) return refuse(reply, joined);
    return reply.code(201).send(joined);
  };

  app.post<{ Params: { id: string } }>('/v1/agents/:id/invites', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const ownerId = ownerIdOf(req);
    const forParsed = NewInvite.safeParse(req.body ?? {});
    if (!forParsed.success) return reply.code(400).send({ error: zodMessage(forParsed.error) });
    const forHandle = typedHandle(forParsed.data.for);
    if (forHandle === undefined) return reply.code(400).send({ error: NOT_A_HANDLE });
    const made = invites.invite(agent, ownerId, { forHandle: forHandle || undefined, webChat: forParsed.data.webChat });
    if ('refused' in made) return refuse(reply, made);
    const { code, expiresAt } = made;
    const path = `/join/${code}`;
    return reply.code(201).send({
      code,
      expiresAt,
      path,
      // The handle it is kept for, as it is matched: the dialog says so, not what was typed (HB-1439 review).
      ...(made.for ? { for: made.for } : {}),
      url: linkUrlFor() ? `${linkUrlFor()}${path}` : undefined,
    });
  });

  /** The Telegram invite was copied or shared: the door held open for its knock (invitations.ts holdKnockWindow). */
  app.post<{ Params: { id: string; code: string } }>('/v1/agents/:id/invites/:code/knock-window', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    const held = await invites.holdKnockWindow(agent, req.params.code);
    if ('refused' in held) return refuse(reply, held);
    return held;
  });

  app.get<{ Params: { id: string } }>('/v1/agents/:id/members', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    return roster.list(agent);
  });

  /** Web chat on or off for one member (roster.ts setWebChat). Removing them (DELETE below) ends it too. */
  app.put<{ Params: { id: string; userId: string }; Body: { on?: boolean } }>(
    '/v1/agents/:id/members/:userId/web-chat',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      const body = SetWebChat.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'on must be true or false' });
      const set = roster.setWebChat(agent, req.params.userId, body.data.on);
      if ('refused' in set) return refuse(reply, set);
      return set;
    },
  );

  /** Who this agent can be shared with for web chat, without a link (roster.ts webChatPeople). */
  app.get<{ Params: { id: string } }>('/v1/agents/:id/web-chat/people', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    if ((deps.authMode ?? 'password') === 'password') return reply.code(400).send({ error: NO_ACCOUNTS_HERE });
    if (agent.ops) return reply.code(400).send({ error: OPS_ALONE });
    return { people: roster.webChatPeople(ownerIdOf(req), agent, () => ownsLocalHost(req)) };
  });

  /** Share an agent with one of those people: a member with web chat on, as a web chat link would make them. */
  app.post<{ Params: { id: string }; Body: { userId?: string; name?: string } }>('/v1/agents/:id/web-chat/people', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    if ((deps.authMode ?? 'password') === 'password') return reply.code(400).send({ error: NO_ACCOUNTS_HERE });
    if (agent.ops) return reply.code(400).send({ error: OPS_ALONE });
    const parsed = ShareWebChat.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const shared = roster.shareWebChat(ownerIdOf(req), agent, () => ownsLocalHost(req), parsed.data);
    if ('refused' in shared) return refuse(reply, shared);
    if ('already' in shared) return shared;
    return reply.code(201).send(shared);
  });

  app.delete<{ Params: { id: string; userId: string } }>(
    '/v1/agents/:id/members/:userId',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent) return reply.code(404).send({ error: 'Not found' });
      if (busyNow(agent, reply)) return reply;
      try {
        return await roster.remove(agent, req.params.userId);
      } catch (err) {
        if (err instanceof AgentBusyError) return reply.code(409).send({ error: err.userMessage });
        if (err instanceof RevokeError) return reply.code(400).send({ error: err.userMessage });
        throw err;
      }
    },
  );

  // Unauthenticated (code-gated): what the join page needs to render.
  // A miss counts like a bad sign-in link (its own count, never the password
  // form's): the route answered any number of guesses at a code.
  app.get<{ Params: { code: string } }>('/v1/invites/:code', async (req, reply) => {
    const guard = app.publicAccess?.throttle;
    if (guard?.throttled(req, undefined, 'link')) return reply.code(429).send({ valid: false, reason: 'Too many attempts — try again later.' });
    const check = checkInvite(store, req.params.code);
    if (!check.valid) {
      // A used or expired link is somebody coming back to an old one; a code nobody made is a guess.
      if (check.reason === 'unknown') guard?.noteFailure(req, undefined, 'link');
      return { valid: false, reason: check.reason };
    }
    const agent = store.getAgent(check.agentId)!;
    // Which apps the invitee can use to reach it (names only, no links yet).
    const channels = store.listChannelsForAgent(agent.id).map((c) => ({
      kind: c.kind,
      ...(c.kind === 'slack' && typeof c.settings?.team === 'string' ? { team: c.settings.team } : {}),
      ...(c.kind === 'discord' && Array.isArray(c.settings?.servers)
        ? { servers: (c.settings.servers as Array<{ name?: string }>).map((g) => String(g.name ?? '')).filter(Boolean).slice(0, 5) } : {}),
    }));
    // A web-chat invite: the page asks them to sign in, not to pick an app —
    // or, when this browser is signed in here already, offers to join as that
    // person (2026-11-10: on a Google install the page only ever offered
    // Google, so someone with a password account could not join at all).
    // A chat-app invite says it too, so the page can offer "Join as <name>"
    // beside "Join with <app> only" (HB-1149); joining as them is their
    // choice, made on the page, never taken from the session alone.
    const joining = await joiningAccount(req, undefined, { acceptingWebChat: check.webChat })
      .catch((): { accountId?: string; factorRefusal?: { error: string; secondFactor: string } } => ({}));
    const you = joining.accountId;
    if (you || joining.factorRefusal) reply.header('cache-control', 'no-store');
    // On it already (a chat-app invite: a web-chat one adds web chat to that seat): no "Join as", and said (HB-1149 review).
    const alreadyMember = !!you && !check.webChat && you !== agent.ownerId && store.getMembership(check.agentId, you)?.status === 'active';
    return {
      valid: true, agentName: agent.name, sharedMemory: agent.sharedMemory, channels,
      ...(check.webChat ? { webChat: true } : {}), authMode: deps.authMode ?? 'password', localAccounts: localAccountsOn(),
      ...(you ? { signedInAs: roster.accountLabel(you) ?? 'your account here', ...(you === agent.ownerId ? { own: true } : {}), ...(alreadyMember ? { alreadyMember: true } : {}) } : {}),
      // Signed in, but this address wants their second factor first (HB-0400): said at once.
      ...(joining.factorRefusal ? { factor: joining.factorRefusal } : {}),
    };
  });

  // Unauthenticated (code-gated): redeem + start watching for the invitee's
  // first Telegram contact, exactly like the owner's claim (invitations.ts joinOnApp).
  app.post<{ Body: { code?: string; name?: string; idToken?: string; channel?: string } }>('/v1/join', async (req, reply) => {
    const parsed = JoinBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const body = parsed.data;
    if (!body.code) return reply.code(400).send({ error: 'code required' });
    // Guesses are counted here as on GET /v1/invites/:code: this route answered any number of them, and
    // on the private listener nothing else limits it (CodeQL js/missing-rate-limiting #79, 2026-10-24).
    const guard = app.publicAccess?.throttle;
    if (guard?.throttled(req, undefined, 'link')) return reply.code(429).send({ error: 'Too many attempts — try again later.' });
    const pre = checkInvite(store, body.code);
    if (!pre.valid && pre.reason === 'unknown') guard?.noteFailure(req, undefined, 'link');
    // A link minted for the management agent before it was refused (2026-09-30).
    if (pre.valid && store.getAgent(pre.agentId)?.ops) return reply.code(400).send({ error: 'This invite is no longer valid.' });
    if (pre.valid && pre.webChat) return joinForWebChat(req, reply, body);
    // Which app the invitee will message. One window per join, on that channel
    // only: a big Slack workspace or Discord server has strangers in it, and
    // an open window on every channel would hand the seat to whoever DMs first.
    const joinKind = pairingKind(body.channel);
    if (!joinKind) return reply.code(400).send({ error: 'Unknown channel.' });
    let admissionTurn: string | undefined;
    /** The admission's own hold on its agent's busy flag, let go however the join ends (HB-1385). */
    let letAdmissionGo: (() => void) | undefined;
    /** A sleeping agent joined: woken once its turn is let go (HB-0992). */
    let wakeAfter: string | undefined;
    try {
      // Full invite (phase 4): when the invitee signs in, the membership is
      // keyed to their real account, so they can log in and see this agent.
      // Without a token it stays a lightweight, Telegram-only membership.
      let accountId: string | undefined;
      if (body.idToken && deps.verifier) {
        try {
          const token = await deps.verifier.verify(body.idToken);
          accountId = admittedPrincipal(token).ownerId;
        } catch (err) {
          return reply.code(err instanceof IdentityError ? err.statusCode : 401).send({ error: err instanceof IdentityError ? err.userMessage : "That sign-in didn't verify — try again." });
        }
      } else if (body.asAccount === true) {
        // "Join as <name>" (HB-1149): the session this browser has here,
        // held to the public gate's rules, and only because they chose it
        // on the page. A session alone binds nothing: on a shared computer
        // it would bind whoever is signed in. Refused before the invite is
        // used, so it can still be used with the app only.
        const joining = await joiningAccount(req);
        if (!joining.accountId) return reply.code(401).send(joining.factorRefusal ?? { error: 'Sign in to this Hatchabot first.', signIn: true });
        if (pre.valid && store.getAgent(pre.agentId)?.ownerId === joining.accountId) {
          return reply.code(400).send({ error: 'This is your own agent — you can already talk to it.' });
        }
        // On it already: said, and the invite left unused (it was "already used", HB-1149 review).
        if (pre.valid && !pre.webChat && store.getMembership(pre.agentId, joining.accountId)?.status === 'active') {
          return reply.code(409).send({ error: ALREADY_MEMBER, alreadyMember: true });
        }
        accountId = joining.accountId;
      }
      // Verification can wait. Re-read the invitation before taking its
      // agent's turn, and leave the single-use code intact if it is busy.
      const currentInvite = checkInvite(store, body.code);
      if (currentInvite.valid) {
        const joiningAgent = store.getAgent(currentInvite.agentId)!;
        if (busyNow(joiningAgent, reply)) return reply;
        letAdmissionGo = markBusy(joiningAgent.id, 'member-join');
        admissionTurn = joiningAgent.id;
      }
      const joined = await invites.joinOnApp({ code: body.code, name: body.name ?? '', accountId, joinKind, pre });
      if ('refused' in joined) return refuse(reply, joined);
      if (joined.notRunning) wakeAfter = admissionTurn;
      return reply.code(201).send(joined);
    } catch (err) {
      if (err instanceof InviteInvalidError || err instanceof AdmitError) {
        return reply.code(err instanceof AdmitError ? err.status : 400).send({ error: err.userMessage });
      }
      throw err;
    } finally {
      letAdmissionGo?.();
      if (wakeAfter) invites.wakeForJoin(wakeAfter);
    }
  });

  /** People already admitted to another of the owner's agents (roster.ts knownPeople). */
  app.get<{ Params: { id: string } }>('/v1/agents/:id/known-people', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    return roster.knownPeople(agent);
  });

  /** Hold the door open again for a member who redeemed an invite and never wrote (roster.ts reopen). */
  app.post<{ Params: { id: string; userId: string }; Body: { handle?: string } }>(
    '/v1/agents/:id/members/:userId/reopen',
    async (req, reply) => {
      const agent = ownedAgent(req, req.params.id);
      if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
      // Not while a change holds the agent, as adding someone you know: a
      // removal under way scrubs the member first, and a window opened during
      // its scrub let them in on another app after the scrub had read its list
      // (HB-1522 review).
      if (busyNow(agent, reply)) return reply;
      // A handle typed is used or refused, never dropped: dropped, the door
      // opened to anyone (HB-1439 review). Empty or none: no handle, as before.
      const typed = ReopenBody.safeParse(req.body ?? {});
      const handle = typed.success ? typedHandle(typed.data.handle) : undefined;
      if (handle === undefined) return reply.code(400).send({ error: NOT_A_HANDLE });
      const reopened = roster.reopen(agent as Agent & { runtimeRef: string }, req.params.userId, handle || undefined);
      if ('refused' in reopened) return refuse(reply, reopened);
      return reopened;
    },
  );

  app.post<{ Params: { id: string } }>('/v1/agents/:id/members/known', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent?.runtimeRef) return reply.code(404).send({ error: 'Not found' });
    if (busyNow(agent, reply)) return reply;
    if (agent.ops) return reply.code(400).send({ error: OPS_ALONE });
    const parsed = AddKnown.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: zodMessage(parsed.error) });
    const added = await roster.addKnown(agent as Agent & { runtimeRef: string }, parsed.data.userId, () => ownedAgent(req, agent.id));
    if ('refused' in added) return refuse(reply, added);
    return added;
  });
}
