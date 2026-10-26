import type { SecretStore } from '../secrets/secretStore.js';
import type { Store } from '../store/store.js';
import { exportAgent, importProfile, TransferError } from './transfer.js';
import { existsSync } from 'node:fs';
import type { ProvisionDeps } from './provision.js';
import { whileBusy } from './busy.js';
import { beginOperation, currentBootId, handleFor, rethrowIfCrash, stepReached, type OpHandle } from './operations.js';
import { randomUUID } from 'node:crypto';
import { pinnedPeerFetch, type PeerFetch, type PeerRequestInit } from '../api/peerAddress.js';

/**
 * Move an agent to another Hatchabot installation in one action.
 *
 * The hard constraint is that a Telegram bot token may only be polled by ONE
 * runtime — two live copies flip-flop messages between them. So the order is
 * chosen so that at every instant the agent is running on at most one side:
 *
 *   1. preflight   — ask the destination if it *would* accept, changing nothing
 *   2. export      — snapshots and STOPS the source (now nobody is polling)
 *   3. import      — destination provisions and starts (now it is the only one)
 *   4. verify      — destination reports RUNNING, or we undo
 *
 * When the destination definitely refuses, or confirms nothing landed, the
 * source is restarted and the destination has already rolled itself back —
 * so a failed migration leaves exactly the state you began with. When the
 * answer is lost (a dropped connection, a proxy's 502/503/504, any 5xx) and
 * the destination can't confirm either way, the source stays STOPPED: a
 * second live poller is the one outcome that can't be undone. The source is deliberately left STOPPED
 * rather than deleted: an automatic delete would make a wrong migration
 * unrecoverable, and the archive is not kept.
 */

export interface Peer {
  id: string;
  name: string;
  url: string;
  secretRef: string;
}

export interface MigrateDeps extends ProvisionDeps {
  secrets: SecretStore;
  /** How the other server is called: pinnedPeerFetch unless a test stubs it. */
  peerFetch?: PeerFetch;
}

export class MigrateError extends Error {
  constructor(
    readonly userMessage: string,
    /** The destination's source of the agent's vendor, when it would pass one over: the owner may move onto it. */
    readonly sourceChoice?: SourceChoice,
  ) {
    super(userMessage);
    this.name = 'MigrateError';
  }
}

/** A source on the destination a move may name instead of the one it would get. */
export interface SourceChoice {
  id: string;
  name: string;
  vendor: string;
  model: string;
}

export interface PreflightAnswer {
  ok: boolean;
  /** Why not, in words the owner can act on. */
  reasons: string[];
  /** Machine-readable tags for refusals the owner may want to override. */
  warnings?: string[];
  /** What the destination would use, so the owner can sanity-check it. */
  hostName?: string;
  aiProfileName?: string;
  aiModel?: string;
  /**
   * When the agent would land on a source of another vendor while this server
   * has one of its own vendor: that one, so the owner can move it onto it
   * (the move names it as `aiProfileId`, the restore as `?aiProfileId=`).
   */
  sourceChoice?: SourceChoice;
}

/**
 * Answer "would I accept this agent?" without changing anything. Every reason
 * here is a failure the import would otherwise hit halfway through.
 */
/**
 * Dotted-version compare for OpenClaw image versions (e.g. "2026.7.1-2").
 * Lexicographic string compare lies ("2026.10" < "2026.7"), so compare each
 * numeric segment. After the release, a number ("-2") is a later build of
 * it, but a word ("-rc.1", "-beta.2") is a prerelease that comes BEFORE it:
 * read as numbers, "2026.9.6-rc.1" was ahead of 2026.9.6 (#158). True when
 * `a` is strictly behind `b`.
 */
export function versionBehind(a: string, b: string): boolean {
  return compareVersions(a, b) < 0;
}

function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const i = v.indexOf('-');
    const main = (i < 0 ? v : v.slice(0, i)).split('.').map((s) => Number.parseInt(s, 10) || 0);
    const tail = i < 0 ? '' : v.slice(i + 1);
    // 0 = a prerelease, 1 = the release itself, 2 = a later build of it.
    const rank = !tail ? 1 : /^\d+([.-]\d+)*$/.test(tail) ? 2 : 0;
    return { main, tail: tail.split(/[.-]/), rank };
  };
  const [x, y] = [split(a), split(b)];
  for (let i = 0; i < Math.max(x.main.length, y.main.length); i++) {
    const d = (x.main[i] ?? 0) - (y.main[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.rank !== y.rank) return x.rank - y.rank;
  if (x.rank === 1) return 0;
  // Same kind of suffix: identifier by identifier, numbers as numbers (rc.2 < rc.10).
  for (let i = 0; i < Math.max(x.tail.length, y.tail.length); i++) {
    const [p, q] = [x.tail[i], y.tail[i]];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    const d = pn && qn ? Number(p) - Number(q) : pn !== qn ? (pn ? -1 : 1) : p < q ? -1 : p > q ? 1 : 0;
    if (d !== 0) return d;
  }
  return 0;
}

export function preflight(
  store: Store,
  ownerId: string,
  req: {
    slug: string;
    accountId: string;
    vendor?: string;
    sharedPaths?: string[];
    /** The SOURCE's runtime-image OpenClaw version, for skew detection. */
    openclawVersion?: string;
    /** A source here the owner chose for the agent (SourceChoice), instead of the one the import would pick. */
    aiProfileId?: string;
  },
  /** Facts about THIS box the route supplies (async to gather, so not read here). */
  local: { openclawVersion?: string } = {},
): PreflightAnswer {
  const reasons: string[] = [];

  if (store.listAllActiveAgents().some((a) => a.slug === req.slug)) {
    reasons.push(`An agent with id "${req.slug}" already lives here.`);
  }

  // A volume written by a newer OpenClaw landing on an older runtime is the
  // documented hazard (the config schema moves between releases) — refuse the
  // DOWNGRADE direction; same-or-newer here is fine. Only when both sides
  // actually know their version: absence must not block a move.
  if (
    req.openclawVersion &&
    local.openclawVersion &&
    versionBehind(local.openclawVersion, req.openclawVersion)
  ) {
    reasons.push(
      `This server's runtime image is OpenClaw ${local.openclawVersion}, older than the agent's ` +
        `${req.openclawVersion} — its config may not load there. Upgrade that server's image first ` +
        `(hatchabot upgrade-image).`,
    );
  }
  if (store.findAgentUsingAccount(req.accountId)) {
    reasons.push(`Bot @${req.accountId} is already wired to an agent here.`);
  } else if (store.telegramPoolHas(req.accountId)) {
    reasons.push(`Bot @${req.accountId} is a spare bot in this machine's pool; remove it from the pool first.`);
  }

  const hosts = store.listHosts(ownerId);
  const host = hosts.find((h) => h.kind === 'local') ?? hosts[0];
  if (!host) reasons.push('No host is configured here to run it.');

  // The source the import itself will pick (importProfile), so the preview
  // names what the agent would actually run on (and bill). This used to pick
  // its own way — a vendor match first — and promised a source the import
  // then passed over for the ⭐ Default (audit #001). A source the owner chose
  // (the move's "Move onto …") is the one the restore is told to use.
  const visible = store.listAIProfiles(ownerId);
  const chosen = req.aiProfileId ? visible.find((p) => p.id === req.aiProfileId) : undefined;
  if (req.aiProfileId && !chosen) reasons.push('The AI source chosen for it is not on this server any more.');
  const profile = req.aiProfileId ? chosen : importProfile(store, ownerId, req.vendor);
  if (!profile && !req.aiProfileId) reasons.push('No AI source is configured here.');

  // A vendor mismatch is not a collision, but it IS a surprise: an agent
  // running on a local model would silently start billing an API, and one on
  // a subscription would need a credential this machine may not have. Refuse,
  // and let the owner set up a matching source or accept the change knowingly.
  // Judged on the source the import would use, not on whether one exists.
  const warnings: string[] = [];
  let sourceChoice: SourceChoice | undefined;
  if (profile && req.vendor && profile.vendor !== req.vendor) {
    const passedOver = chosen ? undefined : visible.find((p) => p.vendor === req.vendor);
    if (passedOver) sourceChoice = { id: passedOver.id, name: passedOver.name, vendor: passedOver.vendor, model: passedOver.model };
    const detail = chosen
      ? `it runs on "${req.vendor}", and the source chosen for it here, ${chosen.name}, is ` +
        `${chosen.vendor}/${chosen.model}.`
      : passedOver
      ? `it runs on "${req.vendor}", and an agent arriving here goes on ` +
        `${profile.defaultSource ? 'the ⭐ Default source' : 'your own source'}, ${profile.name} ` +
        `(${profile.vendor}/${profile.model}), not ${passedOver.name}. Move it onto ${passedOver.name} instead.`
      : req.vendor === 'local'
        ? `it runs on a local model, and this machine has no local model server configured — ` +
          `it would fall back to ${profile.name} (${profile.model}).`
        : `it runs on "${req.vendor}", and this machine only offers ${profile.name} ` +
          `(${profile.vendor}/${profile.model}).`;
    reasons.push(`No matching AI source: ${detail}`);
    warnings.push('vendor-mismatch');
  }

  // Folder shares are host paths. Say so rather than let the agent arrive
  // quietly blind to the data it was built around.
  const missingPaths = (req.sharedPaths ?? []).filter((p) => !existsSync(p));
  if (missingPaths.length) {
    reasons.push(
      `It reads ${missingPaths.length} folder(s) that do not exist here (${missingPaths
        .slice(0, 2)
        .join(', ')}). Create them, or re-share different folders after the move.`,
    );
    warnings.push('missing-shared-paths');
  }

  return {
    ok: reasons.length === 0,
    reasons,
    warnings,
    hostName: host?.name,
    aiProfileName: profile?.name,
    aiModel: profile?.model,
    ...(sourceChoice ? { sourceChoice } : {}),
  };
}

/** The other server's sourceChoice, as far as it is one: shown to the owner and sent back, so bounded. */
function sourceChoiceFrom(v: unknown): SourceChoice | undefined {
  const c = v as Partial<SourceChoice> | undefined;
  const ok = (x: unknown, max: number) => typeof x === 'string' && x.length > 0 && x.length <= max;
  return c && ok(c.id, 64) && ok(c.name, 120) && ok(c.vendor, 32) && ok(c.model, 120)
    ? { id: c.id!, name: c.name!, vendor: c.vendor!, model: c.model! }
    : undefined;
}

async function peerFetch(
  deps: Pick<MigrateDeps, 'secrets' | 'peerFetch'>,
  peer: Peer,
  path: string,
  init: PeerRequestInit,
): Promise<Response> {
  const token = await deps.secrets.get(peer.secretRef);
  // Pinned and redirect-refusing: the registration check judged the URL's
  // text, not what its name resolves to now or where a redirect points.
  return (deps.peerFetch ?? pinnedPeerFetch)(`${peer.url.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

/**
 * The header a move's restore request carries: an id the destination records
 * from the request's first moment (receiveMove), so the mover can later ask
 * about THAT import (GET /v1/moves/:id) instead of reading the agent list.
 * The list says nothing until the import has made its agent row, which comes
 * after it has looked at the image — so an empty list was taken for "it rolled
 * back" while the import was still on its way to RUNNING (issue #19, 2026-10-09).
 */
export const MOVE_HEADER = 'x-hatchabot-move';

/** A move id as the header may carry it; anything else is ignored, never refused. */
export function moveIdFrom(v: unknown): string | undefined {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(v) ? v : undefined;
}

export type MoveState = 'running' | 'landed' | 'failed' | 'unknown';

/**
 * Destination side: record an announced move before the import awaits
 * anything (a store write is synchronous), then follow the import to its end.
 * Without an id (an older Hatchabot sending) it records nothing.
 *
 * The receipt is its first request's account's, and bound to it (audit #002):
 * a request from another account naming the same id writes nothing — its
 * failure used to read as the first one's. A repeat from the same account (a
 * proxy resending the POST) is not refused, since its mover would take a
 * refusal as "undo" while the first import runs on. It may attach its
 * operation when none is attached yet (the one that lands is then found), but
 * an outcome it reaches without one is not written over the first request's.
 */
export function receiveMove(store: Store, moveId: string | undefined, ownerId: string) {
  const reserved = !!moveId && store.insertMoveReceipt({ id: moveId, ownerId, bootId: currentBootId() });
  const sameOwner = reserved || (!!moveId && store.getMoveReceipt(moveId)?.ownerId === ownerId);
  let attached = false;
  return {
    /** The import's operation, once its agent row exists. */
    operation: (opId: string) => {
      if (!sameOwner || (!reserved && store.getMoveReceipt(moveId!)?.opId)) return;
      store.updateMoveReceipt(moveId!, { opId });
      attached = true;
    },
    finished: (outcome: 'landed' | 'failed') => { if (reserved || attached) store.updateMoveReceipt(moveId!, { outcome }); },
  };
}

/**
 * Destination side: what became of an announced move, definitively where it
 * can be. `running` is the only answer that is not one: the import is still
 * on its way (or its own undo is held), so the mover keeps waiting.
 *  - its operation decides once there is one: done → landed; undone → failed,
 *    but only when its agent row is really gone;
 *  - before that: the request's own outcome (refused before any row → failed);
 *  - neither, and the process that took it is gone: a restart cut it off
 *    before any row, so nothing was made and nothing will be → failed;
 *  - never received (or someone else's): unknown.
 */
export function moveState(store: Store, moveId: string, ownerId: string): MoveState {
  const r = store.getMoveReceipt(moveId);
  if (!r || r.ownerId !== ownerId) return 'unknown';
  const op = r.opId ? store.getOperation(r.opId) : undefined;
  if (op) {
    if (op.status === 'succeeded') return 'landed';
    if (op.status === 'rolled_back' || op.status === 'failed') {
      const a = op.agentId ? store.getAgent(op.agentId) : undefined;
      return !a || a.state === 'DELETED' ? 'failed' : 'running';
    }
    return 'running';
  }
  if (r.outcome) return r.outcome;
  // An operation that existed and was pruned (90 days) would have left an outcome.
  return r.bootId === currentBootId() && !r.opId ? 'running' : 'failed';
}

/** Source side: ask the destination about our move. undefined: no answer; 'unsupported': an older Hatchabot. */
async function askAboutMove(
  deps: Pick<MigrateDeps, 'secrets' | 'peerFetch'>,
  peer: Peer,
  moveId: string,
): Promise<MoveState | 'unsupported' | undefined> {
  try {
    const res = await peerFetch(deps, peer, `/v1/moves/${encodeURIComponent(moveId)}`, { method: 'GET', signal: AbortSignal.timeout(20_000) });
    // The route answers every id it is asked about, so a 404 is a server without it.
    if (res.status === 404) return 'unsupported';
    if (!res.ok) return undefined;
    const state = ((await res.json()) as { state?: unknown })?.state;
    return state === 'running' || state === 'landed' || state === 'failed' || state === 'unknown' ? state : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Did the agent actually arrive at the destination? Consulted only when the
 * import call itself gave no answer. Three-state on purpose, like
 * botPollState: "couldn't ask" must never read as "it isn't there".
 *
 * With a move id the destination answers about that import itself
 * (moveState): landed → yes, failed → no, running → wait. Its agent list is
 * the fallback (an older Hatchabot, or an id it never received): a slug
 * RUNNING there is yes, PROVISIONING is wait — and an ABSENT slug is no
 * answer at all, because the import makes its row only after it has looked
 * at the image (issue #19). It is "no" only for an id the destination says it
 * never received, asked twice 15 s apart (or on a later re-ask), and with the
 * slug not in its list: the request never reached its import.
 */
export async function destinationHasAgent(
  deps: Pick<MigrateDeps, 'secrets' | 'sleep' | 'peerFetch'>,
  peer: Peer,
  slug: string,
  attempts = 12,
  moveId?: string,
): Promise<'yes' | 'no' | 'unknown'> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let neverReceived = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(15_000);
    const told = moveId ? await askAboutMove(deps, peer, moveId) : 'unsupported';
    if (told === 'landed') return 'yes';
    if (told === 'failed') return 'no';
    // Its import still under way: the receipt decides, not the list. A slug
    // RUNNING there may be another agent made meanwhile, and was taken for
    // this one's arrival (audit #091).
    if (told === 'running') continue;
    // Otherwise its list too (an older Hatchabot, an id it never got, no answer).
    let agents: Array<{ slug?: string; state?: string }>;
    try {
      // Bounded: a server that is down must not hold the question (or a
      // restart's recovery) for a whole TCP timeout.
      const res = await peerFetch(deps, peer, '/v1/agents', { method: 'GET', signal: AbortSignal.timeout(20_000) });
      if (!res.ok) continue;
      agents = (await res.json()) as Array<{ slug?: string; state?: string }>;
    } catch {
      continue;
    }
    const found = agents.find((a) => a.slug === slug);
    if (found?.state === 'RUNNING') return 'yes';
    // Mid-import — keep waiting for its own success-or-rollback to resolve.
    if (found) continue;
    if (told === 'unknown' && (++neverReceived >= 2 || attempts === 1)) return 'no';
    // Absent from an older Hatchabot's list: maybe not made YET. Keep asking.
  }
  return 'unknown';
}

/**
 * The statuses a refused import can come back with, and nothing else. Each is
 * either what our restore route, its auth or its body parser sends when it
 * says no before anything is committed (400 bad file / TransferError, 401/403
 * token, 404 no such route, 409 image decision, 413 too big, 415 wrong type,
 * 422 validation, 429 cap reached) or what a proxy sends INSTEAD of passing
 * the request on, so either way nothing reached the import. A timeout (408,
 * nginx's 499), 421, 425 or any other status is not on the list: a proxy
 * sends those while the import may still be running over there. A positive
 * list rather than "any 4xx", because a proxy's JSON timeout carries an
 * `error` string too and was taken for a refusal (issue #15, 2026-10-09).
 * Status only, no new marker, so older destinations keep working.
 */
const REFUSAL_STATUSES = new Set([400, 401, 403, 404, 409, 413, 415, 422, 429]);

/**
 * Is this failed import a definite "no" from Hatchabot itself? Only a refusal
 * status (above) carrying Hatchabot's own JSON error body is: the restore
 * route sends those when it refuses, after its own rollback, so nothing is
 * left over there. Anything else — a proxy's 502/503/504 page, any 5xx, a 408
 * or 499 from something in between, with or without a JSON body — may come
 * while (or after) the destination commits the agent, so the caller must ask
 * before restarting the source.
 */
export function isDefiniteRefusal(
  status: number,
  body: unknown,
): body is { error: string; code?: string; problem?: string } {
  return (
    REFUSAL_STATUSES.has(status) &&
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { error?: unknown }).error === 'string'
  );
}

export interface MigrateResult {
  movedTo: string;
  remoteAgentId: string;
  /** The source is left stopped, not deleted — deleting it is the owner's call. */
  sourceState: string;
  /** The operation that recorded it (GET /v1/operations/:id). */
  operation?: string;
}

export interface MigrateOptions {
  allowDroppedPin?: boolean;
  /** A source on the destination to run on (its preflight's sourceChoice), instead of the one its import picks. */
  aiProfileId?: string;
  requestedBy?: string;
  onOperation?: (id: string) => void;
}

export async function migrateAgent(
  deps: MigrateDeps,
  agentId: string,
  peer: Peer,
  opts: MigrateOptions = {},
): Promise<MigrateResult> {
  // Busy for the whole move: between export stopping the source and the
  // tombstone landing, the agent looks like an ordinary STOPPED agent — a
  // Start, Rebuild or Delete in that window boots or purges the copy whose
  // bot is about to belong elsewhere. (Routes check isBusy; this also stops
  // reconcile from judging the stopped source mid-move.) The operation's row
  // (operations.ts) keeps that true across a restart.
  return whileBusy(agentId, () => migrateAgentInner(deps, agentId, peer, opts));
}

/** What a move to another Hatchabot records, and what a restart needs. Never a secret. */
interface MigrateParams {
  peerId: string;
  peerName: string;
  ownerId: string;
  slug: string;
  accountId: string;
  wasRunning: boolean;
  runtimeRef: string;
  slept?: { at: string; mark?: number };
  /**
   * Sent with the restore (MOVE_HEADER) so the other server can be asked
   * about this import itself. Absent on a move begun before 2026-10-09: that
   * one was never announced, so only its agent list can be read.
   */
  moveId?: string;
}

/** Put the source back as it was found: asleep again, or started if it ran. */
async function undoSource(
  deps: Pick<MigrateDeps, 'store' | 'log'>,
  provider: MigrateDeps['provider'],
  agentId: string,
  p: Pick<MigrateParams, 'wasRunning' | 'runtimeRef' | 'slept'>,
  why: string,
): Promise<boolean> {
  const { store } = deps;
  const log = deps.log ?? (() => {});
  log('migrate.rolled_back', { agentId, why });
  if (p.slept && store.getAgent(agentId)?.state === 'STOPPED') store.setHibernated(agentId, p.slept.at, p.slept.mark);
  if (!p.wasRunning) return true;
  try {
    await provider.start(p.runtimeRef);
    if (store.getAgent(agentId)?.state !== 'RUNNING') store.setAgentState(agentId, 'RUNNING');
    return true;
  } catch (err) {
    log('migrate.restart_failed', { agentId, error: String(err) });
    return false;
  }
}

/** The bot moved with the agent: tombstone this copy, and take a pool bot out of the pool here. */
async function settleArrived(deps: MigrateDeps, agentId: string, peerName: string, accountId: string): Promise<void> {
  const { store } = deps;
  const log = deps.log ?? (() => {});
  // Tombstone the source. Without this nothing stops a later Start, Rebuild
  // or Retry from resurrecting a copy whose bot now belongs elsewhere — which
  // is exactly how a "successful" move ends with two live pollers.
  store.setAgentMigratedTo(agentId, `${peerName} (${new Date().toISOString().slice(0, 10)})`);
  // If the moved bot was a pool bot, retire it locally: its token now lives on
  // the peer, so the local pool row must not linger leased-forever (a slot
  // leak) NOR be freed for re-lease (which would hand the same token to a new
  // local agent — two pollers). Removing scrubs the local copy and frees the
  // count. Best-effort: the migrate already succeeded; never fail it over this.
  const pool = (deps.channel as { pool?: { owns(u: string): boolean; removeFromPool(u: string, o?: { leasedTo?: string }): Promise<void> } } | undefined)?.pool;
  if (pool?.owns(accountId)) {
    try {
      // Quietly (no "this agent has been removed" through a bot now answering
      // on the peer), and in one statement while it is still this agent's: a
      // release first freed it for a lease to take before the remove (HB-0065).
      await pool.removeFromPool(accountId, { leasedTo: agentId });
    } catch (err) {
      log('migrate.pool_retire_failed', { agentId, accountId, error: String(err) });
    }
  }
}

const unsettledChoices = (peerName: string, canAsk: boolean) => ({
  actions: [
    ...(canAsk ? [{ action: 'retry', label: `Ask ${peerName} again` }] : []),
    { action: 'arrived', label: `It is running on ${peerName} — keep this copy stopped` },
    { action: 'start-here', label: `It is not on ${peerName} — keep it here` },
  ],
  recommended: canAsk ? 'retry' : undefined,
});

async function migrateAgentInner(
  deps: MigrateDeps,
  agentId: string,
  peer: Peer,
  opts: MigrateOptions = {},
): Promise<MigrateResult> {
  const { store } = deps;
  const agent = store.getAgent(agentId);
  if (!agent?.runtimeRef) throw new MigrateError('This agent has no runtime to move.');
  if (agent.state !== 'RUNNING' && agent.state !== 'STOPPED') {
    throw new MigrateError(`Can't move an agent while it is ${agent.state}.`);
  }
  // A pinned image travels as its recipe (inside the export). The destination
  // uses its own copy, or builds it — only if our token is its owner's; if
  // not, it refuses (after our export, which undo reverses) and says why. --drop-pin: run that
  // server's default image instead, a stated choice.
  const imageChoice = agent.image ? (opts.allowDroppedPin ? 'drop' : 'build') : undefined;
  const channel = store.getChannelForAgent(agentId);
  if (!channel) throw new MigrateError(agent.webOnly
    ? 'This agent has no Telegram bot, and moving to another server needs one. Download a copy (Advanced → Download copy) and import it there instead, or add a bot first.'
    : 'This agent has no messaging identity to move.');
  const profile = store.getAIProfile(agent.aiProfileId);

  // The export wakes nothing but clears a sleeping agent's hibernation (so
  // the wake poll here leaves the bot alone); undo puts it back, or a failed
  // move left the agent plain STOPPED, never to wake on a message again
  // (review, 2026-09-29).
  const slept = agent.hibernatedAt ? { at: agent.hibernatedAt, mark: agent.hibernateMark } : undefined;
  const p: MigrateParams = {
    peerId: peer.id, peerName: peer.name, ownerId: agent.ownerId, slug: agent.slug, accountId: channel.accountId,
    wasRunning: agent.state === 'RUNNING', runtimeRef: agent.runtimeRef, ...(slept ? { slept } : {}),
    moveId: randomUUID(),
  };
  const op = beginOperation(store, 'migrate', agentId, { ...p }, { requestedBy: opts.requestedBy });
  opts.onOperation?.(op.id);
  try {
    return await migrateSteps(deps, op, agent, peer, p, channel.accountId, profile?.vendor, imageChoice, opts.aiProfileId);
  } catch (err) {
    rethrowIfCrash(err);
    if (op.get().status === 'running') op.fail(err);
    throw err;
  }
}

async function migrateSteps(
  deps: MigrateDeps,
  op: OpHandle,
  agent: NonNullable<ReturnType<MigrateDeps['store']['getAgent']>>,
  peer: Peer,
  p: MigrateParams,
  accountId: string,
  vendor: string | undefined,
  imageChoice: 'drop' | 'build' | undefined,
  aiProfileId: string | undefined,
): Promise<MigrateResult> {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});
  const agentId = agent.id;

  // The OpenClaw version the agent runs rides along so the destination can
  // refuse a DOWNGRADE (its image older than that — the config-schema
  // hazard). The agent's own container, as the export's manifest and Move
  // read it: this machine's default image may be newer than an agent not
  // rebuilt since, and was refused as a downgrade it is not (audit #090).
  // Best-effort: an unknown version must not block the move.
  const sourceVersion = agent.runtimeRef
    ? await provider.info(agent.runtimeRef).then((i) => i.openclawVersion, () => undefined)
    : undefined;

  // 1. Preflight — nothing has changed yet, so a refusal is free.
  let answer: PreflightAnswer;
  try {
    const res = await peerFetch(deps, peer, '/v1/agents/preflight', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: agent.slug,
        accountId,
        vendor,
        // Every folder it reads: the legacy shares AND the Data tab's folders. The
        // latter were left out, so the documented refusal ("the agent never arrives
        // blind") was dead for every folder added since Slice A (audit, 2026-10-23).
        sharedPaths: [...new Set([...(agent.sharedPaths ?? []), ...deps.store.listDataSources(agent.id).filter((d) => d.kind === 'folder' && d.hostPath).map((d) => d.hostPath!)])],
        openclawVersion: sourceVersion,
        ...(aiProfileId ? { aiProfileId } : {}),
      }),
    });
    if (res.status === 401) throw new MigrateError(`${peer.name} rejected our access token.`);
    if (!res.ok) throw new MigrateError(`${peer.name} answered ${res.status} to the preflight check.`);
    answer = (await res.json()) as PreflightAnswer;
  } catch (err) {
    rethrowIfCrash(err);
    if (err instanceof MigrateError) throw err;
    throw new MigrateError(`Couldn't reach ${peer.name} at ${peer.url}.`);
  }
  if (!answer.ok) {
    throw new MigrateError(`${peer.name} can't accept this agent: ${answer.reasons.join(' ')}`, sourceChoiceFrom(answer.sourceChoice));
  }
  log('migrate.preflight_ok', { agentId, peer: peer.name });
  op.step('preflight-ok');

  // 2. Export — this STOPS the source, so from here nothing is polling the bot.
  const { data } = await exportAgent(deps, agentId);
  log('migrate.exported', { agentId, bytes: data.length });
  // From here a restart asks the other server before anything is started
  // again here (resumeMigrate): the two-pollers case.
  op.step('exported');

  /** Put the source back exactly as we found it. */
  const undo = async (why: string) => { await undoSource(deps, provider, agentId, p, why); };

  /**
   * The import gave no definite answer. The import takes minutes (volume
   * restore + health wait); a dropped connection or a proxy timeout can lose
   * the response AFTER the destination committed and started polling.
   * Restarting the source on that guess is how a "failed" migration ends
   * with two live pollers. Ask the destination before undoing.
   *
   * `status` is the HTTP status the owner should see, when there was one;
   * without it the wording is the lost-connection one.
   */
  const settleUnanswered = async (why: string, status?: string): Promise<never> => {
    const landed = await destinationHasAgent(deps, peer, agent.slug, 12, p.moveId);
    if (landed === 'no') {
      await undo(`transfer failed: ${why}`);
      const e = new MigrateError(
        `The transfer to ${peer.name} failed${status ? ` (it answered ${status})` : ''}. Your agent is unchanged.`,
      );
      op.rolledBack(e.userMessage);
      throw e;
    }
    if (landed === 'yes') {
      log('migrate.landed_despite_error', { agentId, peer: peer.name, error: why });
      await settleArrived(deps, agentId, peer.name, accountId);
      const e = new MigrateError(
        `${status ? `${peer.name} answered ${status}` : `The connection to ${peer.name} dropped`}, but the ` +
          `agent DID arrive and is running there. This copy stays stopped and marked as moved.`,
      );
      op.done(e.userMessage);
      throw e;
    }
    // Can't tell. Leaving the source stopped is recoverable; starting it next
    // to a live copy is not. Held on disk: Start is refused until the other
    // server answers (asked again every 10 minutes) or the owner says.
    log('migrate.outcome_unknown', { agentId, peer: peer.name, error: why });
    const e = new MigrateError(
      `The transfer to ${peer.name} failed${status ? ` (it answered ${status})` : ''} and we couldn't ` +
        `confirm whether the agent arrived there. This copy is left stopped to be safe — check ` +
        `${peer.name}, then say on this agent's page (Alerts) whether it arrived; Hatchabot also asks ` +
        `${peer.name} again every 10 minutes.`,
    );
    op.hold(
      `The move to ${peer.name} could not be confirmed. This copy stays stopped so two copies never answer the same bot; Hatchabot asks ${peer.name} again every 10 minutes.`,
      unsettledChoices(peer.name, true),
    );
    throw e;
  };

  // 3. Import on the destination. Its own rollback guarantees it leaves
  //    nothing behind when it REFUSES, so then we only have to undo our side.
  let res: Response;
  try {
    const query = new URLSearchParams({ ...(imageChoice ? { image: imageChoice } : {}), ...(aiProfileId ? { aiProfileId } : {}) }).toString();
    res = await peerFetch(deps, peer, `/v1/agents/restore${query ? `?${query}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', ...(p.moveId ? { [MOVE_HEADER]: p.moveId } : {}) },
      body: new Uint8Array(data),
    });
  } catch (err) {
    rethrowIfCrash(err);
    // NO answer from the destination — which is not the same as "it failed".
    return settleUnanswered(String(err));
  }
  const body = (await res.json().catch(() => undefined)) as any;
  if (!res.ok) {
    const status = `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
    if (!isDefiniteRefusal(res.status, body)) {
      // A 502/503/504 is usually a proxy giving up while the destination is
      // still importing, and a 5xx from Hatchabot itself may come after the
      // agent was committed. Neither proves a rollback (issue #1); nor does a
      // 408 or 499 timeout, even one with a JSON error body (issue #15).
      return settleUnanswered(`HTTP ${status}`, status);
    }
    // A real answer from the destination: it refused and rolled back.
    op.step('answered');
    await undo(`import rejected: ${body.error}`);
    const e = body.code === 'image_decision'
      ? new MigrateError(
        `${peer.name} doesn't have the image ${agent.image} and won't build it for this move` +
          `${body.problem ? ` (${body.problem})` : " (only that server's owner may build images there)"}. ` +
          'Your agent is unchanged. Move it on that server\'s default image (CLI: --drop-pin), or Download a copy and import it there as its owner.',
      )
      : new MigrateError(`${peer.name} couldn't import it: ${body.error}. Your agent is unchanged.`);
    op.rolledBack(e.userMessage);
    throw e;
  }
  if (!body || typeof body.state !== 'string') {
    // A success status with no agent in it (a proxy's page, a cut-off body):
    // the import may have committed, so this is no answer either.
    return settleUnanswered(`HTTP ${res.status} without an agent in the body`, `${res.status} with no agent in the reply`);
  }
  const remote = body as { id: string; state: string; name: string };
  // Its id there is what the caller is told once it is done (publicOperation's result).
  op.step('answered', typeof remote.id === 'string' ? { remoteAgentId: remote.id.slice(0, 64) } : undefined);

  // 4. Verify it actually came up there before we consider this done.
  if (remote.state !== 'RUNNING') {
    await undo(`remote state ${remote.state}`);
    const e = new MigrateError(
      `${peer.name} accepted the agent but it is ${remote.state} there. Your agent is unchanged — ` +
        `check that server before trying again.`,
    );
    op.rolledBack(e.userMessage);
    throw e;
  }

  await settleArrived(deps, agentId, peer.name, accountId);
  log('migrate.done', { agentId, peer: peer.name, remoteAgentId: remote.id });
  op.done(`Moved to ${peer.name}. This copy stays stopped, marked as moved.`);
  return {
    movedTo: peer.name,
    remoteAgentId: remote.id,
    sourceState: store.getAgent(agentId)!.state,
    operation: op.id,
  };
}

/**
 * A move to another Hatchabot that a restart cut off (the design's table,
 * migrate rows):
 *  - before the export finished: nothing was sent — failed; a source the
 *    export had stopped is started again (nothing can be running elsewhere);
 *  - exported, no answer recorded: ask the other server. Yes → tombstone and
 *    retire the bot; no → start the source if it ran; unknown → hold (Start
 *    refused), asked again every 10 minutes (operationsResume.ts).
 * `attempts`: how many times to ask (15 s apart) before calling it unknown.
 */
export async function resumeMigrate(deps: MigrateDeps, opId: string, attempts = 12): Promise<void> {
  const { store } = deps;
  const op = handleFor(store, opId);
  const row = op.get();
  const p = row.params as unknown as MigrateParams;
  const agent = row.agentId ? store.getAgent(row.agentId) : undefined;
  if (!agent || agent.state === 'DELETED') { op.fail('The agent is gone.'); return; }
  if (agent.migratedTo) { op.done(`Moved to ${agent.migratedTo}.`); return; }
  if (!stepReached(row.kind, row.step, 'exported')) {
    const back = await undoSource(deps, deps.provider, agent.id, p, 'interrupted before anything was sent');
    op.fail(
      `The move to ${p.peerName} was interrupted by a restart before anything was sent` +
        (p.wasRunning ? (back ? '; it was started here again.' : ', and it did not start here again — Start it.') : '.'),
    );
    return;
  }
  const peer = store.getPeer(p.ownerId, p.peerId);
  if (!peer) {
    op.hold(
      `The move to ${p.peerName} was interrupted, and ${p.peerName} is no longer among this machine's servers, so it can't be asked whether the agent arrived. This copy stays stopped.`,
      unsettledChoices(p.peerName, false),
    );
    return;
  }
  const landed = await destinationHasAgent(deps, peer, p.slug, attempts, p.moveId);
  if (landed === 'yes') {
    await settleArrived(deps, agent.id, peer.name, p.accountId);
    deps.log?.('migrate.done', { agentId: agent.id, peer: peer.name, afterRestart: true });
    op.done(`Moved to ${peer.name} (a restart interrupted it; ${peer.name} says it is running there). This copy stays stopped, marked as moved.`);
    return;
  }
  if (landed === 'no') {
    const back = await undoSource(deps, deps.provider, agent.id, p, `interrupted; not on ${peer.name}`);
    op.rolledBack(
      `The move to ${peer.name} was interrupted by a restart and it did not arrive there — it stays here` +
        (p.wasRunning ? (back ? ' and is running again.' : ', but it did not start again — Start it.') : '.'),
    );
    return;
  }
  op.hold(
    `The move to ${peer.name} was interrupted by a restart, and ${peer.name} hasn't said whether it arrived. This copy stays stopped so two copies never answer the same bot; Hatchabot asks ${peer.name} again every 10 minutes.`,
    unsettledChoices(peer.name, true),
  );
}

/** The owner's choice on a held move to another Hatchabot. */
export async function recoverMigrate(deps: MigrateDeps, opId: string, action: string): Promise<void> {
  const { store } = deps;
  const op = handleFor(store, opId);
  const row = op.get();
  const p = row.params as unknown as MigrateParams;
  const agentId = row.agentId!;
  if (action === 'retry') return resumeMigrate(deps, opId, 1);
  if (action === 'arrived') {
    await settleArrived(deps, agentId, p.peerName, p.accountId);
    op.done(`Marked as moved to ${p.peerName} (you said it is running there). This copy stays stopped.`);
    return;
  }
  if (action === 'start-here') {
    const back = await undoSource(deps, deps.provider, agentId, p, 'the owner said it is not on the other server');
    op.rolledBack(`Kept here (you said it is not on ${p.peerName})${p.wasRunning ? (back ? ' and running again.' : ', but it did not start — Start it.') : '.'}`);
    return;
  }
  throw new MigrateError(`"${action}" is not one of this operation's choices.`);
}

export { TransferError };
