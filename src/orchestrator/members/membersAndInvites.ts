import type { Agent } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import type { Store } from '../../store/store.js';
import type { ConsoleAccess } from '../console/consoleAccess.js';
import { createInvitations, type Invitations } from './invitations.js';
import { createRoster, type Roster } from './roster.js';

/**
 * The members, invites and web chat service (HB-0808): who
 * may use someone's agent besides its owner, and how they
 * come to. Two parts:
 *
 *  - `invites` (invitations.ts): a new invite, the half hour a Telegram
 *    invite holds the door for a knock, and joining by one, on the web or on
 *    a chat app;
 *  - `roster` (roster.ts): the members, web chat on or off for one, sharing
 *    for web chat with someone on this Hatchabot, removing one, the people
 *    known from another agent and adding one, and reopening the door for a
 *    member who never wrote.
 *
 * Built once per process (`registerRoutes` in src/api/routes.ts) and handed
 * to the route file on the shared context (`ctx.members`). No state of its
 * own and no timer, so no `stop()`: the door's windows and the claim's
 * watches are claim.ts's (HB-0838). Nothing here knows about HTTP: signing
 * the person in, the guess limits on a code and the reply's words are the
 * route file's (src/api/chat/memberRoutes.ts).
 *
 * The invite code itself (invite.ts, beside this), the admission and
 * revocation on an agent's volume (orchestrator/members/members.ts), the door and
 * the claim of a first message (claim.ts) and who may open a console
 * (consoleAccess.ts) are their own modules; this is what the API built on
 * them.
 */
export interface MembersAndInvites {
  invites: Invitations;
  roster: Roster;
}

/**
 * Why not: `invalid` (400), `not-found` (404), `conflict` (409, with a `code`
 * the page acts on), `expired` (410), `failed` (502), each with its words; `ops-alone`, the
 * management agent, worded by the route (OPS_ALONE).
 */
export type MemberRefusal =
  | { refused: 'invalid' | 'not-found' | 'expired'; error: string }
  | { refused: 'conflict'; error: string; code?: string }
  /** Something on the agent's machine did not happen (a write in its container): try again. */
  | { refused: 'failed'; error: string }
  | { refused: 'ops-alone' };

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export interface MembersDeps {
  store: Store;
  /** The bots' tokens: a known invitee's Telegram handle is asked of a bot of the owner's. */
  secrets: SecretStore;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** How this Hatchabot signs people in (read at each call). */
  authMode: () => 'password' | 'accounts' | 'identity' | undefined;
  /** Password accounts sign in here. */
  localAccountsOn: () => boolean;
  /**
   * The gateway's list of people (the console service's one ConsoleAccess):
   * kept in step after a member changes, and a removed guest's consoles closed.
   */
  consoleAccess: Pick<ConsoleAccess, 'ensureReady' | 'dropGuests'>;
  /** The channels service's door: back to its resting policy, and the knock cache forgotten. */
  restDoor: (agent: Agent) => Promise<void>;
  forgetKnocks: (agentId: string) => void;
  /** Told on the owner's phone: an invite redeemed and never messaged. */
  opsPush: { waiting: (ownerId: string, headline: string, detail?: string) => Promise<boolean> };
  /** Wake a sleeping agent (the routes' ensureAwake): someone joined it (HB-0992). */
  wake: (agent: Agent, why: string) => Promise<unknown>;
  /** The first-message window's waits between looks; tests hand their own clock. */
  sleep?: (ms: number) => Promise<void>;
  /** Telegram's getChat, for a known invitee's handle (tests hand a fake). */
  telegramFetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  /** Tests: a shorter limit on that look than the 10 seconds a join takes for it. */
  handleLookMs?: number;
  /** A line to the server's log for a failure the person is not told of. */
  logError: (detail: Record<string, unknown>, msg: string) => void;
}

export function createMembersAndInvites(deps: MembersDeps): MembersAndInvites {
  return { invites: createInvitations(deps), roster: createRoster(deps) };
}
