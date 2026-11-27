import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Agent, ChannelKind } from '../../domain/types.js';
import { VOLUME_GONE, type RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { ACCOUNT_SHAPE, ID_SHAPE } from '../channels/channelIds.js';
import { approvePairing, listPairingRequests, PAIRING_DB, PAIRING_DB_JS, pairingStorePath } from './claim.js';
import { CHANNEL_ACCOUNT } from '../../openclaw/configWriter.js';
import { keyedLock, type KeyedLock } from '../../util/queues.js';
import { beginDmPolicyAssertion, dmPolicyAsserted, forgetDmPolicy, rememberDmPolicy } from '../channels/dmPolicyMemo.js';

/**
 * Each agent's turns at its chat apps' access on its volume (HB-1554): the
 * door (its DM policy and the config's allowFrom), a grant or a scrub of
 * someone (the approval stores, the config's lists, the rooms' users), and
 * the rest of each app's section of openclaw.json. Every one of these reads
 * a file, changes it and writes it back whole, in a container of its own,
 * so two of them at once on one agent could lose either's change: a door
 * write that read the config before a removal's scrub and landed after it
 * put the removed person back. One at a time per agent, in the order they
 * were asked for; and a writer decides what to write in its turn, from the
 * store as it is then, not as it was when it asked (writeDmPolicy).
 *
 * One lock per process, kept by its store: a test that starts a second
 * process on the same agents (a restart) has a store of its own, and a
 * write the first left hanging holds up nothing of the second's, as after
 * a real restart. In memory (docs/architecture.md, "In-memory state,
 * sorted"): what waits ends with the process, and nothing is owed for it.
 */
const channelConfigTurns = new WeakMap<object, KeyedLock>();

/**
 * The turns the code running now holds (channelConfigTurns), while each
 * still runs. Not re-entrant: a turn that asked for its own agent's turn
 * again would wait for itself, and every later write of that agent's chat
 * apps behind it, until a restart. Refused instead (ChannelConfigTurnNested).
 */
const turnsHeld = new AsyncLocalStorage<ReadonlyArray<{ turns: KeyedLock; agentId: string; live: boolean }>>();

/**
 * How long each write of an owner's press waits for the agent's turn at its
 * chat apps before it is refused (ChannelConfigBusyError): per write, so a
 * press that writes each of several apps' doors, and looks again, can take a
 * few times this.
 */
export const PRESS_WAIT_MS = 30_000;

/** A press that waited `waitMs` for the agent's turn at its chat apps, refused: nothing of it was written. */
export class ChannelConfigBusyError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'ChannelConfigBusyError';
  }
}

/** A turn asked for inside the same agent's turn: a mistake in the code, refused rather than waiting for itself. */
export class ChannelConfigTurnNested extends Error {
  constructor(agentId: string) {
    super(`A write of agent ${agentId}'s chat-app access asked for its turn inside its own turn: it would wait for itself (HB-1554).`);
    this.name = 'ChannelConfigTurnNested';
  }
}

/**
 * `fn` in the agent's turn at its chat apps' access on its volume (see
 * channelConfigTurns), once every earlier one has landed or failed. Not
 * re-entrant: one asked for inside its own agent's turn is refused
 * (ChannelConfigTurnNested), not left waiting for itself. `waitMs`: a
 * press's longest wait (PRESS_WAIT_MS), then refused, with words
 * (ChannelConfigBusyError), and `fn` never runs; with none it waits as long
 * as the turns ahead take (each one's container is bounded by its timeout).
 */
export function inChannelConfigTurn<T>(store: Store, agentId: string, fn: () => Promise<T>, opts: { waitMs?: number } = {}): Promise<T> {
  let turns = channelConfigTurns.get(store);
  if (!turns) { turns = keyedLock({ refusal: () => new ChannelConfigBusyError('') }); channelConfigTurns.set(store, turns); }
  const held = turnsHeld.getStore() ?? [];
  if (held.some((h) => h.live && h.turns === turns && h.agentId === agentId)) {
    // A mistake in the code, and most callers make any failure a write that
    // did not take: said here, with where it was asked from, or nobody sees it.
    const err = new ChannelConfigTurnNested(agentId);
    console.error(`[chat-app turns] ${err.message}\n${err.stack ?? ''}`);
    return Promise.reject(err);
  }
  const mine = { turns, agentId, live: true };
  const inTurn = () => turnsHeld.run([...held, mine], async () => {
    // Over once it settles: what it set off and left running is not in it.
    try { return await fn(); } finally { mine.live = false; }
  });
  return turns.run(agentId, inTurn, opts.waitMs).catch((err: unknown) => {
    if (!(err instanceof ChannelConfigBusyError) || err.userMessage) throw err;
    const name = store.getAgent(agentId)?.name ?? 'this agent';
    throw new ChannelConfigBusyError(`Another change to ${name}'s chat apps is still being written: try again in a minute.`);
  });
}

// Agent-writable directories can already contain a staging file or symlink.
// Create our own file exclusively, then publish only that file atomically.
const WRITE_JSON_ATOMIC_JS = `
    const writeAtomic = (f, obj) => {
      const tmp = f + "." + require("crypto").randomUUID() + ".tmp";
      let fd = fs.openSync(tmp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(obj, null, 2));
        fs.closeSync(fd); fd = undefined;
        fs.renameSync(tmp, f);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== "ENOENT") throw e; }
      }
    };`;

/**
 * Revoke = flip status + drop the member from the bot's allowlist immediately
 * (§12.3 step 5). OpenClaw keeps pairing approvals in
 * credentials/telegram-<account>-allowFrom.json on the agent's volume, and its
 * CLI has approve/list but no verb to un-approve — so the removal is a small
 * file surgery.
 *
 * This file surgery is the ONLY act that actually revokes. Verified against
 * OpenClaw 2026.6.11 source: under dmPolicy=pairing the runtime admits the
 * UNION of config allowFrom and this credentials file, the file survives
 * rebuilds (it lives on the volume), and it is re-read per message (mtime
 * cache) — so "rebuild to enforce it" was never true, and no gateway restart
 * is needed for the edit to take effect. The surgery runs in a one-shot
 * container against the volume so it works on a stopped agent too.
 */
export interface RevokeDeps {
  store: Store;
  provider: RuntimeProvider;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export class RevokeError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'RevokeError';
  }
}

export class AdmitError extends Error {
  /** `status`: 400 for what the request asked; 502 for a read on the agent's machine that failed. */
  constructor(readonly userMessage: string, readonly status: 400 | 502 = 400) {
    super(userMessage);
    this.name = 'AdmitError';
  }
}

export interface AdmitOptions {
  agentId: string;
  runtimeRef: string;
  accountId: string;
  /** OpenClaw pairing code of the pending request being admitted. */
  code: string;
  /** Which channel the request came in on. Telegram when absent. */
  kind?: ChannelKind;
  agentName: string;
  sharedMemory: boolean;
  /**
   * "That's me — link & approve": the approving OWNER states the requester is
   * themself. Binds the owner seat, records the Telegram id on their ACCOUNT
   * (so every future agent admits them at creation), and absorbs any duplicate
   * member rows carrying the same id. Without it, a fresh account's first
   * self-approval minted the owner a second time as a member named from their
   * Telegram profile, and the account-level link never formed.
   */
  asSelf?: boolean;
}

export interface AdmitResult {
  userId: string;
  displayName: string;
  channelUserId: string;
  alreadyMember: boolean;
  /** Their @handle on the app, when it gave one — which invite window they answered. */
  username?: string;
}

function telegramOwnerRefusal(store: Store, agentId: string, ownerId: string, id: string, asSelf: boolean): string | undefined {
  const seat = store.getMembership(agentId, ownerId);
  if (!seat || seat.status !== 'active' || seat.role !== 'owner') return 'Your owner seat is no longer active. Refresh and try again.';
  if (seat.channelUserId && seat.channelUserId !== id) return 'You are already linked to a different Telegram account on this agent.';
  if (asSelf && store.telegramBoundOutside(id, ownerId)) {
    return 'That Telegram account already belongs to someone on this machine (a member or another account), so it cannot be linked as you.';
  }
}

function admissionAgentUnchanged(store: Store, before: Agent): boolean {
  const current = store.getAgent(before.id);
  return !!current && current.ownerId === before.ownerId && current.runtimeRef === before.runtimeRef
    && current.hostId === before.hostId && current.state === before.state;
}

/** Undo only an unbound approval, never an existing member's access. */
export async function removeUnboundChannelAccess(
  deps: RevokeDeps,
  opts: { agentId: string; runtimeRef: string; kind?: ChannelKind; accountId: string },
  id: string,
): Promise<boolean> {
  const kind = opts.kind ?? 'telegram';
  // Whose it is, and the scrub, in one turn: bound to somebody meanwhile, it is theirs to keep.
  return inChannelConfigTurn(deps.store, opts.agentId, async () => {
    const holder = kind === 'telegram'
      ? deps.store.getActiveMembershipByChannelUser(opts.agentId, id)
      : deps.store.getMemberByIdentity(opts.agentId, kind, id);
    if (holder) return true;
    let removed = false;
    if (ID_SHAPE[kind].test(id) && ACCOUNT_SHAPE.test(opts.accountId)) {
      const script = allowlistScrubScript([{
        channel: kind, acct: opts.accountId, id,
        cred: `/home/node/.openclaw/credentials/${kind}-${opts.accountId.toLowerCase()}-allowFrom.json`,
      }]);
      const result = await deps.provider.execShellOnVolume(opts.runtimeRef, script).catch(() => undefined);
      removed = !!result && result.code === 0 && !result.volumeMissing;
    }
    deps.log?.(removed ? 'member.unbound_approval_scrubbed' : 'member.unbound_approval_scrub_failed', { agentId: opts.agentId, kind });
    return removed;
  });
}

async function refuseApprovedIdentity(deps: RevokeDeps, opts: AdmitOptions, id: string, message: string): Promise<never> {
  if (!(await removeUnboundChannelAccess(deps, opts, id))) {
    throw new AdmitError(`${message} The chat approval could not be removed; check the agent's channel access before trying again.`);
  }
  throw new AdmitError(message);
}

/**
 * The Telegram-native invite path (§12.3 without the web page): the invitee
 * simply messages the bot from anywhere — no tailnet needed — and the owner's
 * "Let them in" tap turns the pending pairing request into a real membership.
 * The §12.6 shared-memory disclosure, which the web join page would have
 * shown before joining, is delivered as the bot's first message instead.
 */
export async function admitMember(deps: RevokeDeps, opts: AdmitOptions): Promise<AdmitResult> {
  const kind = opts.kind ?? 'telegram';
  forgetDmPolicy(opts.agentId); // a member change: the next rest asserts the door afresh
  if (kind !== 'telegram') return admitOtherChannel(deps, { ...opts, kind });
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});
  const before = store.getAgent(opts.agentId);
  if (!before) throw new AdmitError('The agent is no longer available.');

  const requests = await pendingRequests(provider, opts.runtimeRef, opts.accountId, 'telegram');
  if (!admissionAgentUnchanged(store, before)) throw new AdmitError('The agent changed while reading requests. Refresh and try again.');
  const req = requests.find((r) => r.code === opts.code);
  if (!req) throw new AdmitError('That request is no longer pending. Ask them to message again.');

  // Every refusal before the approval: approving first let a refused "That's
  // me" in anyway, with no member row to remove them by (night review).
  const owner = store.getAgent(opts.agentId);
  const bindingOwner = owner && (opts.asSelf || store.knownChannelUserId(owner.ownerId) === req.id);
  if (bindingOwner) {
    const refusal = telegramOwnerRefusal(store, opts.agentId, owner.ownerId, req.id, !!opts.asSelf);
    if (refusal) throw new AdmitError(refusal);
  }

  if (!(await approvePairing(provider, opts.runtimeRef, opts.accountId, opts.code))) {
    throw new AdmitError("Couldn't approve the request — try again.");
  }
  if (!admissionAgentUnchanged(store, before)) {
    return refuseApprovedIdentity(deps, opts, req.id, 'The agent changed while approving. Refresh and try again.');
  }

  // The owner talking to their OWN agent should claim the owner seat, not
  // become a "member" of it. On an agent whose owner seat was never bound to
  // Telegram (typically one created before pair-once), the owner's first
  // message lands here as a pending request; without this it would mint a
  // member row named from their Telegram profile — the same person listed
  // twice. If this telegram id is the owner's own (known from any of their
  // agents), bind the owner seat instead.
  const agent = store.getAgent(opts.agentId);
  if (bindingOwner) {
    if (!agent || agent.ownerId !== owner.ownerId) {
      return refuseApprovedIdentity(deps, opts, req.id, 'The agent changed while approving. Refresh and try again.');
    }
    const refusal = telegramOwnerRefusal(store, opts.agentId, agent.ownerId, req.id, !!opts.asSelf);
    if (refusal) return refuseApprovedIdentity(deps, opts, req.id, refusal);
    let absorbed = 0;
    try {
      store.transact(() => {
        if (opts.asSelf) {
          // Link and absorb duplicates in the same transaction as the seat:
          // a failed binding must never leave an account-level identity behind.
          store.setAccountTelegram(agent.ownerId, req.id);
          absorbed = store.absorbOwnerTelegram(agent.ownerId, req.id);
        }
        if (!store.bindMembershipChannelUser(opts.agentId, agent.ownerId, req.id)) {
          throw new AdmitError('Your Telegram identity could not be linked to this agent. Refresh and try again.');
        }
      });
    } catch (error) {
      if (!(error instanceof AdmitError)) throw error;
      return refuseApprovedIdentity(deps, opts, req.id, error.userMessage);
    }
    if (opts.asSelf) {
      log('member.telegram_linked', { agentId: opts.agentId, channelUserId: req.id, absorbed });
    } else {
      log('member.owner_self_claim', { agentId: opts.agentId, channelUserId: req.id });
    }
    return {
      userId: agent.ownerId,
      displayName: 'You', // the owner seat is rendered as "You", never a name
      channelUserId: req.id,
      alreadyMember: true,
    };
  }

  // Re-approval for someone already admitted (e.g. after a rebuild reset the
  // runtime's pairing state) must not mint a second membership.
  const existing = store.getActiveMembershipByChannelUser(opts.agentId, req.id);
  if (existing) {
    return {
      userId: existing.userId,
      displayName: existing.displayName ?? existing.userId,
      channelUserId: req.id,
      alreadyMember: true,
      username: req.meta?.username,
    };
  }

  const displayName =
    ([req.meta?.firstName, req.meta?.lastName].filter(Boolean).join(' ') ||
      req.meta?.username ||
      `Member ${req.id}`).slice(0, 64);
  const userId = `member-${randomUUID()}`;
  store.insertMembership({
    id: randomUUID(),
    agentId: opts.agentId,
    userId,
    role: 'user',
    displayName,
    channelUserId: req.id,
    status: 'active',
    joinedAt: new Date().toISOString(),
  });
  log('member.admitted', { agentId: opts.agentId, userId, channelUserId: req.id, displayName });

  // Welcome + disclosure. Best-effort: the membership is already real, and
  // they'll see the agent respond to their held message either way.
  // Always said: an agent has one memory, reachable from every conversation
  // (it was said only for "shared" agents, and "private" ones were not private).
  const disclosure = ' Heads up: this is a shared agent — things you tell it may be remembered and shared with the other people who use it.';
  const welcome = `You're in! You're now a member of ${opts.agentName}.${disclosure} Say hi whenever you're ready.`;
  const sent = await provider
    .exec(opts.runtimeRef, [
      'message',
      'send',
      '--channel',
      'telegram',
      '--account',
      opts.accountId,
      '--target',
      req.id,
      '-m',
      welcome,
    ])
    .catch(() => ({ code: 1, stdout: '', stderr: 'exec failed' }));
  if (sent.code !== 0) {
    log('member.welcome_failed', { agentId: opts.agentId, userId, stderr: sent.stderr });
  }

  return { userId, displayName, channelUserId: req.id, alreadyMember: false, username: req.meta?.username };
}

/**
 * admitMember for Slack and Discord. Same shape as Telegram's, with the
 * identity kept in member_identities. There is no account-level link for
 * these yet, so the owner is recognised only by "That's me".
 */
/**
 * The requests waiting at the agent's door, read strictly: a read that failed
 * said "That request is no longer pending. Ask them to message again." of a
 * request that was there all along (HB-1050).
 */
async function pendingRequests(provider: RevokeDeps['provider'], runtimeRef: string, accountId: string, kind: ChannelKind) {
  try { return await listPairingRequests(provider, runtimeRef, accountId, kind, { strict: true }); }
  catch { throw new AdmitError(REQUESTS_UNREAD, 502); }
}
/** What letting in or turning away says when the agent's waiting requests could not be read (HB-1050). */
export const REQUESTS_UNREAD = "Couldn't read the requests waiting at the agent's door just now — try again in a moment.";

async function admitOtherChannel(deps: RevokeDeps, opts: AdmitOptions & { kind: Exclude<ChannelKind, 'telegram'> }): Promise<AdmitResult> {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});
  const { kind } = opts;
  const before = store.getAgent(opts.agentId);
  if (!before) throw new AdmitError('The agent is no longer available.');

  const requests = await pendingRequests(provider, opts.runtimeRef, opts.accountId, kind);
  if (!admissionAgentUnchanged(store, before)) throw new AdmitError('The agent changed while reading requests. Refresh and try again.');
  const req = requests.find((r) => r.code === opts.code);
  if (!req) throw new AdmitError('That request is no longer pending. Ask them to message again.');
  const owner = store.getAgent(opts.agentId);
  if (owner && opts.asSelf && !store.canBindMemberIdentity(opts.agentId, owner.ownerId, kind, req.id)) {
    throw new AdmitError('You are already linked to a different account on this channel.');
  }
  if (!(await approvePairing(provider, opts.runtimeRef, opts.accountId, opts.code, kind))) {
    throw new AdmitError("Couldn't approve the request — try again.");
  }
  if (!admissionAgentUnchanged(store, before)) {
    return refuseApprovedIdentity(deps, opts, req.id, 'The agent changed while approving. Refresh and try again.');
  }

  // Their rooms too, not just their DMs: OpenClaw's approval writes only the
  // DM allow store (2026-09-30).
  try {
    if (!(await grantRoomAccess(deps, { agentId: opts.agentId, runtimeRef: opts.runtimeRef, kind, channelUserId: req.id }))) {
      throw new AdmitError('Adding access to the rooms failed.');
    }
  } catch {
    return refuseApprovedIdentity(deps, opts, req.id, 'Adding access to the rooms failed. Refresh and try again.');
  }
  if (!admissionAgentUnchanged(store, before)) {
    return refuseApprovedIdentity(deps, opts, req.id, 'The agent changed while approving. Refresh and try again.');
  }

  const agent = store.getAgent(opts.agentId);
  if (agent && opts.asSelf) {
    if (!store.bindMemberIdentity(opts.agentId, agent.ownerId, kind, req.id)) {
      return refuseApprovedIdentity(deps, opts, req.id, 'You are already linked to a different account on this channel.');
    }
    log('member.owner_self_claim', { agentId: opts.agentId, kind, channelUserId: req.id });
    return { userId: agent.ownerId, displayName: 'You', channelUserId: req.id, alreadyMember: true };
  }

  const existing = store.getMemberByIdentity(opts.agentId, kind, req.id);
  if (existing) {
    const m = store.listMemberships(opts.agentId).find((x) => x.userId === existing.userId);
    return { userId: existing.userId, displayName: m?.displayName ?? existing.userId, channelUserId: req.id, alreadyMember: true };
  }

  const displayName =
    ([req.meta?.firstName, req.meta?.lastName].filter(Boolean).join(' ') ||
      req.meta?.username ||
      `Member ${req.id}`).slice(0, 64);
  const userId = `member-${randomUUID()}`;
  store.insertMembership({
    id: randomUUID(), agentId: opts.agentId, userId, role: 'user', displayName,
    status: 'active', joinedAt: new Date().toISOString(),
  });
  store.bindMemberIdentity(opts.agentId, userId, kind, req.id);
  log('member.admitted', { agentId: opts.agentId, userId, kind, channelUserId: req.id, displayName });

  const disclosure = ' Heads up: this is a shared agent — things you tell it may be remembered and shared with the other people who use it.';
  const sent = await provider
    .exec(opts.runtimeRef, [
      'message', 'send', '--channel', kind, '--account', opts.accountId, '--target', `user:${req.id}`,
      '-m', `You're in! You're now a member of ${opts.agentName}.${disclosure} Say hi whenever you're ready.`,
    ])
    .catch(() => ({ code: 1, stdout: '', stderr: 'exec failed' }));
  if (sent.code !== 0) log('member.welcome_failed', { agentId: opts.agentId, userId, kind, stderr: sent.stderr });
  return { userId, displayName, channelUserId: req.id, alreadyMember: false };
}

/**
 * Tell everyone in the agent's chat something — one DM per active member with
 * a bound Telegram identity (bots have no broadcast). Best-effort throughout:
 * an announcement must never fail the operation it documents. Used for bot
 * renames, so the chat itself records "this bot is now called X" instead of
 * the label silently changing under people.
 */
export async function announceToMembers(
  deps: RevokeDeps,
  opts: { agentId: string; runtimeRef: string; accountId: string; text: string; kind?: ChannelKind },
): Promise<number> {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});
  const kind = opts.kind ?? 'telegram';
  // Telegram identities sit on the seat; Slack and Discord ones beside it.
  const targets = store
    .listMemberships(opts.agentId)
    .filter((m) => m.status === 'active')
    .map((m) => (kind === 'telegram' ? m.channelUserId : store.memberIdentities(opts.agentId, m.userId)[kind]))
    .filter((id): id is string => !!id);
  let sent = 0;
  for (const id of targets) {
    const res = await provider
      .exec(opts.runtimeRef, [
        'message', 'send', '--channel', kind,
        '--account', opts.accountId, '--target', kind === 'telegram' ? id : `user:${id}`, '-m', opts.text,
      ])
      .catch(() => ({ code: 1, stdout: '', stderr: 'exec failed' }));
    if (res.code === 0) sent++;
  }
  log('members.announced', { agentId: opts.agentId, kind, sent, of: targets.length });
  return sent;
}

export interface DenyOptions {
  agentId: string;
  runtimeRef: string;
  /** OpenClaw pairing code of the pending request being turned away. */
  code: string;
  /** Which channel the request came in on. Telegram when absent. */
  kind?: ChannelKind;
}

/**
 * Turn a pending pairing request away. OpenClaw's CLI has approve/list but NO
 * deny verb (verified against 2026.7.1), so — exactly like revokeMember's
 * allowlist scrub — this is a small atomic surgery on the pairing store that
 * lives on the agent's volume (credentials/telegram-pairing.json), run in a
 * one-shot container so it works on a stopped agent too.
 *
 * This drops the pending REQUEST; it is not a ban. If they message the bot
 * again OpenClaw records a fresh request — which is the honest behaviour for a
 * "not now", and callers word it that way.
 */
export async function denyPairing(
  deps: RevokeDeps,
  opts: DenyOptions,
): Promise<{ denied: boolean }> {
  const { provider } = deps;
  const log = deps.log ?? (() => {});
  // Defence in depth: the code is embedded via JSON.stringify below, but never
  // let anything but a plain pairing code near the script in the first place.
  if (!/^[A-Za-z0-9]{4,16}$/.test(opts.code)) {
    throw new AdmitError('That pairing code looks wrong.');
  }
  const script = `node -e '
    const fs = require("fs");
    const f = ${JSON.stringify(pairingStorePath(opts.kind ?? 'telegram'))};
    ${WRITE_JSON_ATOMIC_JS}
    let n = 0;
    // 2026.9: the request is a row in the state database. Both stores, as the
    // list reads both: a 2026.7 file left on a 2026.9 volume (HB-0033).
    if (fs.existsSync(${JSON.stringify(PAIRING_DB)})) {
      ${PAIRING_DB_JS.open(false)}
      try { n += db.prepare("delete from channel_pairing_requests where channel_key = ? and code = ?").run(${JSON.stringify(opts.kind ?? 'telegram')}, ${JSON.stringify(opts.code)}).changes; }
      catch (e) { if (!fs.existsSync(f)) throw e; }
    }
    let d = null;
    try { d = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { if (fs.existsSync(f) && !fs.existsSync(${JSON.stringify(PAIRING_DB)})) throw e; }
    if (d) {
      const before = Array.isArray(d.requests) ? d.requests.length : 0;
      d.requests = (Array.isArray(d.requests) ? d.requests : [])
        .filter((r) => String(r && r.code) !== ${JSON.stringify(opts.code)});
      if (d.requests.length !== before) {
        writeAtomic(f, d);
      }
      n += before - d.requests.length;
    }
    console.log(String(n));'`;
  const res = await provider.execShellOnVolume(opts.runtimeRef, script);
  if (res.volumeMissing) throw new AdmitError(VOLUME_GONE);
  if (res.code !== 0) {
    throw new AdmitError('Turning that request away failed — try again in a moment.');
  }
  const denied = Number(res.stdout.trim()) > 0;
  log('pairing.denied', { agentId: opts.agentId, code: opts.code, denied });
  return { denied };
}

/**
 * Add a channel identity to an agent's LIVE allowlist, without a pairing
 * request — the mirror of the scrub in revokeMember, and the reason someone
 * you already know never has to do the pairing dance twice.
 *
 * Both on-volume files the runtime unions are written (verified against
 * OpenClaw 2026.6.11): the credentials allowFrom where approvals land, and the
 * config the next rebuild seeds from. The gateway re-reads per message, so it
 * takes effect immediately — no rebuild.
 */
export async function grantChannelAccess(
  deps: RevokeDeps,
  opts: {
    agentId: string; runtimeRef: string; kind: ChannelKind; accountId: string; channelUserId: string;
    /**
     * Whether they are still to be let in, asked in the grant's turn: false,
     * nothing is written ('skipped'). A grant asked for while their removal
     * scrubbed waited for it, and wrote them back after the flip (HB-1554).
     */
    onlyIf?: () => boolean;
  },
): Promise<'granted' | 'skipped'> {
  const log = deps.log ?? (() => {});
  if (!ID_SHAPE[opts.kind].test(opts.channelUserId) || !/^[A-Za-z0-9_]{1,64}$/.test(opts.accountId)) {
    throw new AdmitError('That chat id has an unexpected shape, so the allowlist was not touched.');
  }
  const target = {
    channel: opts.kind,
    acct: opts.accountId,
    id: opts.channelUserId,
    cred: `/home/node/.openclaw/credentials/${opts.kind}-${opts.accountId.toLowerCase()}-allowFrom.json`,
  };
  const script = `node -e '
    const fs = require("fs");
    ${WRITE_JSON_ATOMIC_JS}
    const t = ${JSON.stringify(target)};
    const add = (arr) => {
      const a = Array.isArray(arr) ? arr.slice() : [];
      if (!a.some((x) => String(x) === t.id)) a.push(t.id);
      return a;
    };
    // 2026.9: approvals are rows in the state database, not a file. A file
    // there too (from 2026.7, or one a 2026.9 migration left in place) gets the
    // id as well: written to the file alone, a 2026.9 gateway never saw it (HB-0033).
    let inDb = false;
    if (fs.existsSync(${JSON.stringify(PAIRING_DB)})) {
      try {
        ${PAIRING_DB_JS.open(false)}
        const next = db.prepare("select coalesce(max(sort_order), -1) + 1 as n from channel_pairing_allow_entries where channel_key = ? and lower(account_id) = lower(?)").get(t.channel, t.acct).n;
        db.prepare("insert or ignore into channel_pairing_allow_entries (channel_key, account_id, entry, sort_order, updated_at) values (?, ?, ?, ?, ?)").run(t.channel, t.acct, t.id, next, Date.now());
        inDb = true;
      } catch (e) { if (!fs.existsSync(t.cred)) throw e; }
    }
    if (fs.existsSync(t.cred) || !inDb) {
      const d = fs.existsSync(t.cred) ? JSON.parse(fs.readFileSync(t.cred, "utf8")) : {};
      d.allowFrom = add(d.allowFrom);
      writeAtomic(t.cred, d);
    }
    const cfgPath = "/home/node/.openclaw/openclaw.json";
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const acc = cfg.channels && cfg.channels[t.channel] && cfg.channels[t.channel].accounts
        && cfg.channels[t.channel].accounts[t.acct];
      let changed = false;
      if (acc) { acc.allowFrom = add(acc.allowFrom); changed = true; }
      ${ROOM_USERS_ADD_JS}
      if (changed) writeAtomic(cfgPath, cfg);
    }'`;
  const res = await inChannelConfigTurn(deps.store, opts.agentId, async () => {
    if (opts.onlyIf && !opts.onlyIf()) return undefined;
    forgetDmPolicy(opts.agentId); // the config's allowFrom is being written
    return deps.provider.execShellOnVolume(opts.runtimeRef, script);
  });
  if (!res) {
    log('member.grant_skipped', { agentId: opts.agentId, kind: opts.kind, what: 'door' });
    return 'skipped';
  }
  if (res.volumeMissing) throw new AdmitError(VOLUME_GONE);
  if (res.code !== 0) {
    throw new AdmitError('Adding them to the bot allowlist failed — try again in a moment.');
  }
  log('member.allowlist_granted', { agentId: opts.agentId, kind: opts.kind });
  return 'granted';
}

/**
 * Slack channels and Discord servers carry their own `users` list, written
 * only at a build — so somebody admitted today was ignored in every room
 * until the next rebuild, though the app said rooms answer "people you
 * admitted" (2026-09-30). This adds `t.id` to each room Hatchabot wrote (a
 * NON-empty list: an empty one means "anyone" to OpenClaw, and a room with
 * nobody admitted yet is written closed, not empty — that one still waits for
 * a rebuild). Needs `cfg`, `t` ({channel, id}) and a `changed` flag in scope;
 * the mirror of allowlistScrubScript's room handling.
 */
const ROOM_USERS_ADD_JS = `
      const chRooms = cfg.channels && cfg.channels[t.channel];
      if (chRooms && t.channel !== "telegram") {
        for (const key of ["channels", "guilds"]) {
          const rooms = chRooms[key];
          if (!rooms || typeof rooms !== "object") continue;
          for (const r of Object.values(rooms)) {
            if (!r || !Array.isArray(r.users) || !r.users.length) continue;
            if (!r.users.some((x) => String(x) === t.id)) { r.users.push(t.id); changed = true; }
          }
        }
      }`;

/**
 * Let somebody just admitted on Slack or Discord into the rooms too, live.
 * The DM door is OpenClaw's own approval (or grantChannelAccess); the rooms
 * are config only this writes. Best effort: a failure is logged, and the next
 * rebuild writes the rooms from the member list anyway. False: not added (the
 * write failed, or `onlyIf` said no in its turn, logged as
 * `member.grant_skipped`).
 */
export async function grantRoomAccess(
  deps: RevokeDeps,
  opts: {
    agentId: string; runtimeRef: string; kind: ChannelKind; channelUserId: string;
    /**
     * Whether they are still to be let in, asked in the grant's turn: false,
     * nothing is written. A grant asked for while their removal scrubbed
     * waited for it, and put them back in the rooms after the flip (HB-1554).
     * admitOtherChannel gives none: it grants before their row exists, and a
     * grant it makes ends with a member listed or its approval taken back.
     */
    onlyIf?: () => boolean;
  },
): Promise<boolean> {
  if (opts.kind === 'telegram' || !ID_SHAPE[opts.kind].test(opts.channelUserId)) return false;
  const t = { channel: opts.kind, id: opts.channelUserId };
  const script = `node -e '
    const fs = require("fs");
    const t = ${JSON.stringify(t)};
    ${WRITE_JSON_ATOMIC_JS}
    const cfgPath = "/home/node/.openclaw/openclaw.json";
    if (!fs.existsSync(cfgPath)) process.exit(0);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    let changed = false;
    ${ROOM_USERS_ADD_JS}
    if (changed) writeAtomic(cfgPath, cfg);
    console.log(changed ? "added" : "unchanged");'`;
  const res = await inChannelConfigTurn(deps.store, opts.agentId, async () => (
    opts.onlyIf && !opts.onlyIf() ? undefined : deps.provider.execShellOnVolume(opts.runtimeRef, script)
  )).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  if (!res) {
    deps.log?.('member.grant_skipped', { agentId: opts.agentId, kind: opts.kind, what: 'rooms' });
    return false;
  }
  if (res.code !== 0) {
    deps.log?.('member.room_grant_failed', { agentId: opts.agentId, kind: opts.kind });
    return false;
  }
  if (res.stdout.trim() === 'added') deps.log?.('member.room_granted', { agentId: opts.agentId, kind: opts.kind });
  return true;
}

/**
 * Forget everyone a channel had admitted, on the volume, when the channel is
 * removed from the agent. The rebuild rewrites the CONFIG allowlist from
 * memberships, but OpenClaw also unions in its own approval store (the
 * 2026.9 allow rows, the 2026.7 credentials file), and that outlived a
 * detach: the next bot attached under the same account key (`hatchabot` for
 * every Discord and Slack bot) admitted the people the owner had dropped,
 * with no membership to show for it (2026-09-25). Best effort by contract:
 * the caller logs a failure; the rebuild that follows still writes the
 * config from scratch.
 */
export async function scrubChannelAllowlist(
  deps: RevokeDeps,
  opts: { agentId: string; runtimeRef: string; kind: ChannelKind; accountId: string },
): Promise<boolean> {
  const log = deps.log ?? (() => {});
  if (!ACCOUNT_SHAPE.test(opts.accountId)) return false;
  const t = { channel: opts.kind, acct: opts.accountId, cred: `/home/node/.openclaw/credentials/${opts.kind}-${opts.accountId.toLowerCase()}-allowFrom.json` };
  const script = `node -e '
    const fs = require("fs");
    const t = ${JSON.stringify(t)};
    let n = 0;
    if (fs.existsSync(t.cred)) { fs.unlinkSync(t.cred); n++; }
    if (fs.existsSync(${JSON.stringify(PAIRING_DB)})) {
      ${PAIRING_DB_JS.open(false)}
      n += db.prepare("delete from channel_pairing_allow_entries where channel_key = ? and lower(account_id) = lower(?)").run(t.channel, t.acct).changes;
      n += db.prepare("delete from channel_pairing_requests where channel_key = ? and lower(account_id) = lower(?)").run(t.channel, t.acct).changes;
    }
    console.log(String(n));'`;
  const res = await inChannelConfigTurn(deps.store, opts.agentId, () => {
    forgetDmPolicy(opts.agentId);
    return deps.provider.execShellOnVolume(opts.runtimeRef, script);
  });
  if (res.code !== 0) {
    log('channel.allowlist_scrub_failed', { agentId: opts.agentId, kind: opts.kind });
    return false;
  }
  log('channel.allowlist_scrubbed', { agentId: opts.agentId, kind: opts.kind, removed: Number(res.stdout.trim()) || 0 });
  return true;
}

/**
 * Flip an agent's DM policy on its volume, live.
 *
 * `allowlist` is the resting state: OpenClaw drops a DM from anyone not on
 * the list without a word. `pairing` answers a stranger with "access not
 * configured" and a pairing code — useful for exactly as long as we are
 * waiting for somebody specific, and a standing invitation to poke the rest
 * of the time. The gateway reads the config per message, so this takes effect
 * immediately; the next rebuild reseeds the same value from provision.
 */
export async function setDmPolicy(deps: RevokeDeps, opts: DmPolicyTarget): Promise<boolean> {
  const out = await writeDmPolicy(deps, opts);
  return out === 'set' || out === 'unchanged';
}

/** Which agent, app, account and door setDmPolicy writes. */
export interface DmPolicyTarget {
  agentId: string; runtimeRef: string; kind: ChannelKind; accountId: string;
  policy: 'allowlist' | 'pairing';
  /**
   * Who the config itself must admit. A fresh agent is written with NO
   * allowFrom key at all (configWriter only writes one when there is
   * somebody to write), and approving a pairing request adds the id to
   * OpenClaw's own credentials store — not to the config. Flipping the
   * policy alone therefore switched the door to "admit the empty list",
   * and the owner's messages were dropped in silence (a Mac, 2026-09-21).
   *
   * As the caller read it from the store (listAllowedChannelUserIds). Only
   * the ones the store still admits in the write's turn are written: one
   * removed while the write waited is never put back (HB-1554).
   */
  allowFrom?: string[];
  /** An owner's press: its longest wait for the agent's turn (PRESS_WAIT_MS), then refused with ChannelConfigBusyError. */
  waitMs?: number;
  /** Whether it is still wanted, asked in the write's turn: false, nothing is written ('unchanged'). */
  onlyIf?: () => boolean;
}

/**
 * What a door write found: written; already so; no such account (or no
 * config at all) on the volume, so nothing there to change, as when the
 * agent's image has no plugin for that app and its build left it out
 * (provision.ts); or a write that failed. setDmPolicy is this as a yes or
 * no; a caller that must tell "nothing to change" from "refused" asks this
 * (HB-0995).
 */
export type DmPolicyOutcome = 'set' | 'unchanged' | 'no-account' | 'no-config' | 'failed';

/** setDmPolicy, answering what it found (DmPolicyOutcome). */
export async function writeDmPolicy(deps: RevokeDeps, opts: DmPolicyTarget): Promise<DmPolicyOutcome> {
  const log = deps.log ?? (() => {});
  if (!/^[A-Za-z0-9_]{1,64}$/.test(opts.accountId)) return 'failed';
  const asked = (opts.allowFrom ?? []).filter((id) => ID_SHAPE[opts.kind].test(id));
  return inChannelConfigTurn(deps.store, opts.agentId, () => writeDmPolicyInTurn(deps, opts, asked, log), { waitMs: opts.waitMs });
}

/**
 * writeDmPolicy in the agent's turn (channelConfigTurns), deciding there who
 * it admits. A rest asked for while a removal's scrub ran read the person as
 * still active, and its write, landing after the scrub, put their id back in
 * the config's allowFrom: they could message the agent until its next
 * rebuild (HB-1554). The scrub and the flip of their row are one turn, so a
 * write in a later turn finds them revoked.
 */
async function writeDmPolicyInTurn(
  deps: RevokeDeps, opts: DmPolicyTarget, asked: string[], log: (event: string, detail: Record<string, unknown>) => void,
): Promise<DmPolicyOutcome> {
  if (opts.onlyIf && !opts.onlyIf()) return 'unchanged';
  const admitted = new Set(asked.length ? deps.store.listAllowedChannelUserIds(opts.agentId, opts.kind) : []);
  const admit = asked.filter((id) => admitted.has(id));
  // Nobody on the list now: the door is left as it is, as every rest leaves
  // one with nobody on it (an allowlist of nobody admits nobody, the owner too).
  if (opts.policy === 'allowlist' && asked.length && !admit.length) return 'unchanged';
  // Already asserted, and nothing since could have changed it: no container (review, 2026-09-29).
  if (dmPolicyAsserted(opts, opts.policy, admit)) return 'unchanged';
  const target = { channel: opts.kind, acct: opts.accountId, policy: opts.policy, admit };
  const script = `node -e '
    const fs = require("fs");
    const t = ${JSON.stringify(target)};
    ${WRITE_JSON_ATOMIC_JS}
    const cfgPath = "/home/node/.openclaw/openclaw.json";
    if (!fs.existsSync(cfgPath)) { console.log("no-config"); process.exit(0); }
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const acc = cfg.channels && cfg.channels[t.channel] && cfg.channels[t.channel].accounts
      && cfg.channels[t.channel].accounts[t.acct];
    if (!acc) { console.log("no-account"); process.exit(0); }
    const have = Array.isArray(acc.allowFrom) ? acc.allowFrom.map(String) : [];
    const missing = t.admit.filter((id) => !have.includes(String(id)));
    if (acc.dmPolicy === t.policy && !missing.length) { console.log("unchanged"); process.exit(0); }
    acc.dmPolicy = t.policy;
    // The config must carry the list it is about to enforce: an allowlist with
    // nobody in it admits nobody, including the owner.
    if (t.admit.length) acc.allowFrom = [...have, ...missing];
    writeAtomic(cfgPath, cfg);
    console.log("set");'`;
  const finish = beginDmPolicyAssertion(opts);
  try {
    const res = await deps.provider.execShellOnVolume(opts.runtimeRef, script);
    const out = res.stdout.trim();
    // A sweep re-asserts the policy every few minutes; "unchanged" is not news
    // (it filled one agent's Setup log, 2026-09-24).
    if (!(res.code === 0 && out === 'unchanged')) log('channel.dm_policy', { agentId: opts.agentId, policy: opts.policy, result: res.code === 0 ? out : `failed:${res.code}` });
    const ok = res.code === 0 && (out === 'set' || out === 'unchanged');
    if (finish() && ok) rememberDmPolicy(opts, opts.policy, admit);
    if (res.code !== 0) return 'failed';
    return out === 'set' || out === 'unchanged' || out === 'no-account' || out === 'no-config' ? out : 'failed';
  } finally { finish(); }
}

export async function revokeMember(
  deps: RevokeDeps,
  agentId: string,
  userId: string,
): Promise<void> {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});

  const member = store.getMembership(agentId, userId);
  if (!member) throw new RevokeError('No such member.');
  if (member.role === 'owner') throw new RevokeError("The owner can't be removed.");
  // 'revoked' now means fully revoked INCLUDING the scrub — the status is
  // flipped only after the scrub succeeds, so this early-return is safe and a
  // failed revoke (still 'active') genuinely re-runs when retried.
  if (member.status === 'revoked') return;

  // Every channel they are known on: Telegram (on the membership row) plus
  // Slack and Discord (member_identities). None → flip the row; nothing admits them.
  const ids = store.memberIdentities(agentId, userId);
  if (!Object.keys(ids).length) {
    store.revokeMembership(agentId, userId);
    log('member.revoked', { agentId, userId });
    return;
  }

  const agent = store.getAgent(agentId);
  if (!agent?.runtimeRef) {
    // No runtime to scrub (mid-provision). Flip the row so the NEXT rebuild's
    // config drops them; there is no live allowlist yet.
    store.revokeMembership(agentId, userId);
    log('member.revoked', { agentId, userId });
    return;
  }

  // Scrub BEFORE flipping the DB row, so a failure is retryable (the row stays
  // 'active' and "remove them again" actually re-runs this). The runtime
  // admits the UNION of two on-volume files (verified against OpenClaw
  // 2026.6.11), and both survive rebuilds, so BOTH must be scrubbed, on every
  // channel the member is known on:
  //   - credentials/<channel>-<acct>-allowFrom.json  (where pairing approvals land)
  //   - openclaw.json channels.<channel>.accounts.<acct>.allowFrom  (what rebuild seeds)
  // Scrubbing only the credentials file left a member baked into config at the
  // last rebuild still admitted — the exact hole "Revoke for real" missed.
  // The credentials FILENAME is lowercased (OpenClaw's on-disk convention);
  // the config KEY keeps the case configWriter seeded.
  type Target = { channel: string; acct: string; id: string; cred: string };
  const targetsOf = (now: Partial<Record<ChannelKind, string>>): Target[] => {
    const out: Target[] = [];
    for (const kind of Object.keys(now) as ChannelKind[]) {
      const id = now[kind]!;
      const channel = store.getChannelForAgent(agentId, kind);
      // A Telegram bot that is gone takes its account key with it (a restore
      // gets a different bot). Discord and Slack always use one account key, and
      // an archived agent gets the same bot back on restore with the volume's
      // approvals intact — so scrub those even with no channel row (night review).
      if (!channel && kind === 'telegram') continue;
      const acct = kind === 'telegram' ? channel!.accountId : CHANNEL_ACCOUNT;
      // Identities and account names only ever reach the script if they are the
      // plain shapes the platforms issue.
      if (!ID_SHAPE[kind].test(id) || !/^[A-Za-z0-9_]{1,64}$/.test(acct)) {
        throw new RevokeError(
          'That member has an unexpected chat id, so the bot allowlist was not touched and they ' +
            'may still be able to chat. Delete the agent to be certain.',
        );
      }
      out.push({ channel: kind, acct, id, cred: `/home/node/.openclaw/credentials/${kind}-${acct.toLowerCase()}-allowFrom.json` });
    }
    return out;
  };
  // Each identity they are known by scrubbed, then the row flipped with no
  // wait between the last look and the flip. One bound while a scrub ran (a
  // window that opened for them meanwhile, its approval landing on their
  // seat, still active) was on no scrub's list: let in for good, the row
  // revoked (HB-1522 review). It is scrubbed in a round of its own. Once the
  // row is revoked nothing binds to it, and an approval that lands then is
  // taken back by its watch (claim.ts). A seat still gaining ids after three
  // rounds stays a member, to be removed again: a guard only, not reached
  // (three apps, and a bind only fills an empty one), so no test drives it.
  // The rounds and the flip in one turn at the agent's chat-app access
  // (channelConfigTurns), so no door write or grant lands in the middle: a
  // rest asked for meanwhile read them as still active, and its write,
  // landing after the scrub, put their id back on the agent's allowFrom
  // (HB-1554). One asked for before runs first, and the scrub takes out
  // what it wrote; one asked for after finds the row revoked.
  const scrubbed = new Set<string>();
  const channels: string[] = [];
  const runtimeRef = agent.runtimeRef;
  await inChannelConfigTurn(store, agentId, async () => {
    for (let round = 0; ; round++) {
      const targets = targetsOf(store.memberIdentities(agentId, userId)).filter((t) => !scrubbed.has(`${t.channel}:${t.id}`));
      if (!targets.length) break;
      if (round === 3) {
        throw new RevokeError(
          'They were let in again on a chat app while being removed, so they are still a member and may ' +
            'still be able to chat. Remove them again to retry.',
        );
      }
      const script = allowlistScrubScript(targets);
      forgetDmPolicy(agentId);
      const res = await provider.execShellOnVolume(runtimeRef, script);
      if (res.volumeMissing) {
        // No retry helps, and it may only be on another machine: never read as removed.
        throw new RevokeError(`${VOLUME_GONE} They stay a member until the agent has its files back or is deleted.`);
      }
      if (res.code !== 0) {
        // The row is still 'active' (we haven't flipped it), so "remove them
        // again" genuinely retries the scrub. A rebuild would NOT help — both
        // files live on the volume and a rebuild re-seeds config from members.
        throw new RevokeError(
          'Updating the bot allowlist failed, so they are still a member and may still be able to ' +
            'chat. Remove them again to retry.',
        );
      }
      for (const t of targets) { scrubbed.add(`${t.channel}:${t.id}`); if (!channels.includes(t.channel)) channels.push(t.channel); }
    }

    store.revokeMembership(agentId, userId);
  });
  log('member.revoked', { agentId, userId });
  if (channels.length) log('member.allowlist_scrubbed', { agentId, userId, channels });
}


/**
 * Everyone removed from this agent, as scrub targets on the chat apps it has
 * now. A restore from a nightly backup brings back that night's approvals, so
 * the people Hatchabot has since removed must be removed again (review,
 * 2026-09-29). An odd-shaped id is left out rather than failing the restore:
 * it never reaches a script.
 */
export function revokedScrubTargets(store: Store, agentId: string): {
  targets: Array<{ channel: string; acct: string; id: string; cred: string }>;
  people: Array<{ userId: string; name: string; ids: string[] }>;
} {
  const targets: Array<{ channel: string; acct: string; id: string; cred: string }> = [];
  const people: Array<{ userId: string; name: string; ids: string[] }> = [];
  for (const mem of store.listMemberships(agentId)) {
    if (mem.status !== 'revoked') continue;
    const ids = store.memberIdentities(agentId, mem.userId);
    const mine: string[] = [];
    for (const kind of Object.keys(ids) as ChannelKind[]) {
      const id = ids[kind]!;
      const channel = store.getChannelForAgent(agentId, kind);
      if (!channel && kind === 'telegram') continue;
      const acct = kind === 'telegram' ? channel!.accountId : CHANNEL_ACCOUNT;
      if (!ID_SHAPE[kind].test(id) || !/^[A-Za-z0-9_]{1,64}$/.test(acct)) continue;
      targets.push({ channel: kind, acct, id, cred: `/home/node/.openclaw/credentials/${kind}-${acct.toLowerCase()}-allowFrom.json` });
      mine.push(id);
    }
    if (mine.length) people.push({ userId: mem.userId, name: mem.displayName ?? 'someone', ids: mine });
  }
  return { targets, people };
}

/**
 * What a restored volume admits and which bots its config names, read before
 * Hatchabot puts its current settings back: the restore can then say what the
 * backup had that was undone. Read-only; prints JSON.
 */
export const RESTORED_ACCESS_SCRIPT = `node -e '
  const fs = require("fs"); const path = require("path");
  const out = { ids: [], telegramAccounts: [] };
  const add = (x) => { if (x !== undefined && x !== null) out.ids.push(String(x)); };
  try {
    const cfg = JSON.parse(fs.readFileSync("/home/node/.openclaw/openclaw.json", "utf8"));
    const ch = (cfg && cfg.channels) || {};
    for (const k of Object.keys(ch)) for (const a of Object.values((ch[k] && ch[k].accounts) || {})) for (const x of ((a && a.allowFrom) || [])) add(x);
    out.telegramAccounts = Object.keys((ch.telegram && ch.telegram.accounts) || {});
  } catch {}
  const cd = "/home/node/.openclaw/credentials";
  try { for (const f of fs.readdirSync(cd)) if (f.endsWith("-allowFrom.json")) { try { for (const x of (JSON.parse(fs.readFileSync(path.join(cd, f), "utf8")).allowFrom || [])) add(x); } catch {} } } catch {}
  try {
    if (fs.existsSync(${JSON.stringify(PAIRING_DB)})) {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(${JSON.stringify(PAIRING_DB)}, { readOnly: true });
      for (const r of db.prepare("select entry from channel_pairing_allow_entries").all()) add(r.entry);
    }
  } catch {}
  process.stdout.write(JSON.stringify(out));'`;

/**
 * Drop every Telegram bot from a restored config except the one the agent has
 * now (none: all of them). The fallback when a full re-apply can't run, so a
 * swapped-away bot is never polled by two agents (review #5, 2026-09-29).
 */
export function keepOnlyTelegramAccountScript(accountId: string | undefined): string {
  if (accountId !== undefined && !/^[A-Za-z0-9_]{1,64}$/.test(accountId)) throw new Error('unexpected account id');
  return `node -e '
    const fs = require("fs"); const f = "/home/node/.openclaw/openclaw.json";
    ${WRITE_JSON_ATOMIC_JS}
    if (!fs.existsSync(f)) process.exit(0);
    const cfg = JSON.parse(fs.readFileSync(f, "utf8"));
    const tg = cfg.channels && cfg.channels.telegram;
    if (!tg || !tg.accounts) process.exit(0);
    const keep = ${JSON.stringify(accountId ?? null)};
    for (const k of Object.keys(tg.accounts)) if (k !== keep) delete tg.accounts[k];
    if (!Object.keys(tg.accounts).length) tg.enabled = false;
    writeAtomic(f, cfg);'`;
}

/**
 * Turn Slack and Discord off in a restored config and empty their accounts —
 * what a build writes for a channel the agent no longer has. The fallback
 * when a full re-apply can't run, beside keepOnlyTelegramAccountScript: a
 * restored Slack or Discord token can't be checked against the current one
 * from here (both live under one account key), so neither runs until the next
 * build writes the current ones back (B023).
 */
export const DROP_CHAT_ACCOUNTS_SCRIPT = `node -e '
    const fs = require("fs"); const f = "/home/node/.openclaw/openclaw.json";
    ${WRITE_JSON_ATOMIC_JS}
    if (!fs.existsSync(f)) process.exit(0);
    const cfg = JSON.parse(fs.readFileSync(f, "utf8"));
    let n = 0;
    for (const k of ["slack", "discord"]) {
      const c = cfg.channels && cfg.channels[k];
      if (!c) continue;
      if (c.enabled !== false) { c.enabled = false; n++; }
      if (c.accounts && Object.keys(c.accounts).length) { c.accounts = {}; n++; }
    }
    if (n) writeAtomic(f, cfg);'`;

/**
 * The on-volume scrub of chat ids from an agent's allowlists: the approval
 * credentials file, the 2026.9 approval rows, the config's allowFrom and
 * groupAllowFrom (the account's and the whole app's), and every Slack
 * channel's / Discord server's users (a room left with nobody
 * is removed — an empty list means "anyone"). Shared by member removal and by
 * unlinking an account's identity (regression review, 2026-09-28).
 */
export function allowlistScrubScript(targets: Array<{ channel: string; acct: string; id: string; cred: string }>): string {
  return `node -e '
    const fs = require("fs");
    ${WRITE_JSON_ATOMIC_JS}
    const targets = ${JSON.stringify(targets)};
    const cfgPath = "/home/node/.openclaw/openclaw.json";
    const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : null;
    let cfgChanged = false;
    // 2026.9: approvals are rows in the state database — scrub them there too,
    // or a removed member stays admitted by the store the gateway unions in.
    let db = null;
    if (fs.existsSync(${JSON.stringify(PAIRING_DB)})) { const { DatabaseSync } = require("node:sqlite"); db = new DatabaseSync(${JSON.stringify(PAIRING_DB)}); db.exec("PRAGMA busy_timeout=5000"); }
    for (const t of targets) {
      // OpenClaw reads an entry as the id with or without the app as a prefix ("telegram:<id>").
      const drop = (arr) => (Array.isArray(arr) ? arr.filter((x) => String(x) !== t.id && String(x) !== t.channel + ":" + t.id) : arr);
      if (fs.existsSync(t.cred)) {
        const d = JSON.parse(fs.readFileSync(t.cred, "utf8"));
        d.allowFrom = drop(d.allowFrom || []);
        writeAtomic(t.cred, d);
      }
      // Legacy migration can preserve a channel prefix when its adapter is
      // unavailable. Match the same two forms in the database as in the files.
      if (db) db.prepare("delete from channel_pairing_allow_entries where channel_key = ? and lower(account_id) = lower(?) and entry in (?, ?)").run(t.channel, t.acct, t.id, t.channel + ":" + t.id);
      const acc = cfg && cfg.channels && cfg.channels[t.channel] && cfg.channels[t.channel].accounts
        && cfg.channels[t.channel].accounts[t.acct];
      if (acc && Array.isArray(acc.allowFrom)) { acc.allowFrom = drop(acc.allowFrom); cfgChanged = true; }
      // OpenClaw also admits ids listed for the whole app (channels.<app>.allowFrom
      // and groupAllowFrom, on every account) and the groupAllowFrom of the account
      // (its groups): the access overview reads them all, and a removed member listed
      // there was still let in. Only their id goes; the rest of each list stays.
      const lists = [cfg && cfg.channels && cfg.channels[t.channel], acc];
      for (const o of lists) {
        if (!o || typeof o !== "object") continue;
        for (const f of ["allowFrom", "groupAllowFrom"]) {
          if (o === acc && f === "allowFrom") continue; // above
          if (!Array.isArray(o[f])) continue;
          const had = o[f].length;
          o[f] = drop(o[f]);
          if (o[f].length !== had) cfgChanged = true;
        }
      }
      // Never a command owner once removed (2026-09-29).
      const owners = cfg && cfg.commands && cfg.commands.ownerAllowFrom;
      if (Array.isArray(owners)) {
        const kept = owners.filter((x) => String(x) !== t.channel + ":" + t.id);
        if (kept.length !== owners.length) { cfg.commands.ownerAllowFrom = kept.length ? kept : [t.channel + ":0"]; cfgChanged = true; }
      }
      // And every room: Slack channels and Discord servers carry their own
      // users list, and a removed member could still @mention the bot there
      // until some later rebuild (night review, 2026-09-28).
      const chCfg = cfg && cfg.channels && cfg.channels[t.channel];
      if (chCfg && t.channel !== "telegram") {
        for (const key of ["channels", "guilds"]) {
          const rooms = chCfg[key];
          if (!rooms || typeof rooms !== "object") continue;
          // An EMPTY users list means "no restriction" to OpenClaw: a room
          // left with nobody is removed, never opened to everyone (regression review).
          for (const [rk, r] of Object.entries(rooms)) {
            if (!r || !Array.isArray(r.users)) continue;
            const had = r.users.length;
            r.users = drop(r.users);
            if (r.users.length !== had) cfgChanged = true;
            if (had && !r.users.length) delete rooms[rk];
          }
        }
      }
    }
    if (cfgChanged) writeAtomic(cfgPath, cfg);'`;
}
