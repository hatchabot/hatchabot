import type { ChannelKind } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import { expectedHandle, normalizeHandle, Store } from '../../store/store.js';
import { ACCOUNT_SHAPE, ID_SHAPE } from '../channels/channelIds.js';
import { forgetDmPolicy } from '../channels/dmPolicyMemo.js';

/**
 * First-contact claim (the §12.4 owner-lockout fix), built on OpenClaw's
 * native DM pairing:
 *
 *   1. Fresh agents provision with dmPolicy: "pairing".
 *   2. Owner taps the deep link and messages the bot; OpenClaw records a
 *      pairing request (id = telegram user id, plus a code).
 *   3. We watch `openclaw pairing list --json` and auto-approve the FIRST
 *      request that arrives inside the claim window, binding that telegram id
 *      to the owner's membership. OpenClaw then allowlists the sender itself.
 *
 * Auto-approving the first contact is safe-enough for a personal agent: the
 * window opens the moment the owner is shown the deep link, and the link is
 * shown only to them. Anyone who arrives later goes through normal pairing,
 * which stays pending until explicitly approved via the app.
 */

export interface PairingRequest {
  /** Telegram user id of the requester. */
  id: string;
  code: string;
  meta?: { username?: string; firstName?: string; lastName?: string; accountId?: string };
}

export interface ClaimDeps {
  store: Store;
  provider: RuntimeProvider;
  /** Each machine's provider: the door is put back on the machine an agent moved to while its window waited (HB-0468, sixth review). */
  providerFor?: (hostId: string) => RuntimeProvider;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface ClaimOptions {
  agentId: string;
  runtimeRef: string;
  accountId: string;
  /** Membership (hatchabot user id) the next pairing request binds to —
   *  the owner on first provision, an invitee after a join (§12.3). */
  forUserId: string;
  /** Which channel to watch. Telegram when absent. */
  kind?: ChannelKind;
  /** How long to keep watching for the owner's first message, counted while the agent is up. */
  timeoutMs?: number;
  /** How long to wait for an agent that is down before the window ends (a week). */
  maxDownMs?: number;
  /**
   * When the window first opened, for one watched again after a restart (a
   * join kept for an agent that was not running, HB-0992): the hour a window
   * open to anyone may run, and the week it waits for an agent that is down,
   * count from then, not from the restart. Down at the first look, it counts
   * as down since then. The time counted while the agent is up starts again.
   */
  openedAt?: number;
  /**
   * Told when this window ends because a later watcher took its seat over
   * (Reopen, Telegram attached again, the same seat joined again): its person
   * is that watcher's now, and nothing of theirs is this one's to let go of.
   */
  onSuperseded?: () => void;
  /** Ids that must never be claimed for this seat even when nothing else is
   *  known about them: the people who chatted with a recycled bot's previous
   *  agent (they were just told "this bot is now X", right as the window
   *  opens). */
  excludeIds?: string[];
  /**
   * The `excludeIds` are not this window's knock either: written on its row,
   * the knocks never show one of them as the one it waits for (a join's: who
   * had written to a sleeping agent's bot before it, invitations.ts, HB-1221
   * review). Otherwise they are only never claimed, and knock as anyone does:
   * an imported agent's previous owner may be the owner importing it, and was
   * turned away from their own agent.
   */
  excludeKnocks?: boolean;
  /** Who this window is for — a Telegram @handle or numeric id. Set, only a
   *  matching knock is ever claimed. */
  expect?: string;
  pollIntervalMs?: number;
  /**
   * The caller keeps this window in the store itself, and watches it again at
   * the next start (a join: invitations.ts, HB-0992). Otherwise the watch is
   * kept here while it runs (`first-contact`), and the next start watches it
   * again (resumeFirstContacts, HB-0838).
   */
  kept?: boolean;
  /**
   * With `kept`: told where the watch stands each time it would have kept
   * that itself (as it opens, goes down and comes up), for the caller's own
   * record: its window's generation, and the up-time it has left, as of
   * `at`; `down` then, that time is not running (HB-0838).
   */
  onKept?: (time: WatchTime) => void;
}

/** Where OpenClaw keeps pending Telegram pairing requests, on the volume. */
export const PAIRING_STORE = '/home/node/.openclaw/credentials/telegram-pairing.json';
/** The same store for any channel: OpenClaw names it `<channel>-pairing.json`. */
export const pairingStorePath = (kind: ChannelKind = 'telegram') => `/home/node/.openclaw/credentials/${kind}-pairing.json`;
/**
 * OpenClaw 2026.9 keeps pairing requests and approvals in its state database
 * instead of the credentials files (tables `channel_pairing_requests` and
 * `channel_pairing_allow_entries`); the files are simply absent. Every read
 * or surgery below tries the file first, then the database — a missing file
 * is not "nothing there" (one agent's Discord knock was invisible, and the
 * owner's own first message was never claimed, 2026-09-24).
 */
export const PAIRING_DB = '/home/node/.openclaw/state/openclaw.sqlite';
/** JS for the on-volume scripts (no single quotes: they sit inside `node -e '…'`). */
export const PAIRING_DB_JS = {
  // A read waits for OpenClaw's write too: without it a busy database read as
  // no requests at all (HB-1050).
  open: (readOnly: boolean) => `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(PAIRING_DB)}${readOnly ? ', { readOnly: true }' : ''}); db.exec("PRAGMA busy_timeout=${readOnly ? 3000 : 5000}");`,
};

/**
 * The shell that prints a channel's pending requests in the file's JSON shape:
 * the database's rows first, then the file's not already listed. Both, not
 * whichever exists: 2026.7 creates the tables but keeps requests in the file,
 * and a 2026.9 volume can keep a 2026.7 file its migration left in place
 * (unreadable, say), which used to hide every request in the database (HB-0033).
 * An unreadable file or database adds nothing, and is named in `unread`: a
 * store that is there but could not be read is not "nobody knocking" (HB-1050).
 * A query the database's tables do not fit (SQLITE_ERROR from prepare: no
 * such table, no such column) is not this version's store, as a missing one
 * is not, and is not unread: a 2026.7 volume whose table has other columns
 * keeps its requests in the file, and failing on it failed every strict read
 * there. Busy, damaged, not a database or not openable stays unread.
 * Only the columns scripts/candidate-gate.sh checks before a version is
 * promoted are read (request_id, code, meta_json, and channel_key): any
 * other renamed in a later OpenClaw would make the query not fit, and every
 * knock on every upgraded agent read as nobody knocking, with no gate to
 * catch it. Nothing used created_at or last_seen_at.
 * Neither store found (no table the query fits, no file) is said as `none`:
 * an agent with no knock yet, or a migration between its steps, its table
 * gone for a moment (HB-1369). Nobody is knocking there, as far as a read
 * can tell, but the sweep does not take it for its told knocks gone.
 */
export function pairingListShell(kind: ChannelKind): string {
  const node = [
    'const fs = require("fs"); const out = []; const seen = new Set(); const unread = []; let found = false;',
    `try { if (fs.existsSync(${JSON.stringify(PAIRING_DB)})) { ${PAIRING_DB_JS.open(true)}`,
    'let q = null; try { q = db.prepare("select request_id, code, meta_json from channel_pairing_requests where channel_key = ?"); }',
    'catch (e) { if (!(e && (e.errcode === 1 || /no such (table|column)/i.test(String(e.message))))) throw e; }',
    `if (q) for (const r of q.all(${JSON.stringify(kind)})) {`,
    'let meta = {}; try { meta = JSON.parse(r.meta_json || "{}"); } catch (e) {} seen.add(String(r.code)); out.push({ id: r.request_id, code: r.code, meta }); }',
    'if (q) found = true; } }',
    'catch (e) { unread.push("db"); }',
    `try { const d = JSON.parse(fs.readFileSync(${JSON.stringify(pairingStorePath(kind))}, "utf8")); found = true; for (const r of (d && Array.isArray(d.requests) ? d.requests : [])) { if (r && !seen.has(String(r.code))) { seen.add(String(r.code)); out.push(r); } } }`,
    'catch (e) { if (!e || e.code !== "ENOENT") unread.push("file"); }',
    'process.stdout.write(JSON.stringify(unread.length ? { version: 1, requests: out, unread } : found ? { version: 1, requests: out } : { version: 1, requests: out, none: true }));',
  ].join(' ');
  return `node -e '${node}' 2>/dev/null || true`;
}

/**
 * Read pending pairing requests by reading the store FILE, not by running
 * `openclaw pairing list`.
 *
 * This is polled for every running agent on a timer, and booting the OpenClaw
 * Node CLI inside a container costs ~2s each — measured 7.7s of wall time and
 * 26 concurrent `docker exec`s per sweep on a 26-agent fleet, which made every
 * button press in the app 6x slower while it ran. Reading the file is ~0.04s,
 * and it is the same JSON the CLI would print (`{version, requests:[…]}`);
 * denyPairing already edits this exact file.
 *
 * Approving still goes through the CLI — that mutates state and updates the
 * allowlist, which is the CLI's job, not ours.
 */
export async function listPairingRequests(
  provider: RuntimeProvider,
  runtimeRef: string,
  accountId: string,
  kind: ChannelKind = 'telegram',
  opts: { strict?: boolean; needsStore?: boolean } = {},
): Promise<PairingRequest[]> {
  const res = await provider.execShell(runtimeRef, pairingListShell(kind));
  // The shell always prints {version, requests} when it ran. `strict`: a read
  // that did not run (an exec that failed, no output, not that shape), or
  // found a store it could not read, throws, rather than answering "nobody
  // is knocking" (HB-1050). Otherwise it is what could be read.
  // `needsStore` (the knock sweep): one that found no store at all throws
  // too, so the knocks it told are kept as told (HB-1369).
  if (opts.strict) {
    const a = pairingListAnswer(res.code, res.stdout);
    // The database unread (busy past its wait, damaged) is a failed read. The
    // file is one when the database had none: with the database's rows, a
    // file that cannot be read is the 2026.7 one a 2026.9 upgrade left, and
    // failing on it would hide those rows every sweep (HB-0033).
    const failed = !a ? `exit ${res.code}${res.stdout.trim() ? '' : ', no output'}`
      : a.unread.includes('db') ? 'its database could not be read'
      : a.unread.includes('file') && !a.requests.length ? 'its file could not be read'
      : a.none && opts.needsStore ? 'no store of them was found' : '';
    if (failed) throw new Error(`the pairing requests could not be read (${failed})`);
  }
  if (res.code !== 0 || !res.stdout.trim()) return [];
  // The file holds every account's requests for this agent; the CLI filtered by
  // --account, so keep that behaviour where the entry says which one it is.
  return parsePairingList(res.stdout).filter(
    (r) => !r.meta?.accountId || r.meta.accountId.toLowerCase() === accountId.toLowerCase(),
  );
}

export async function approvePairing(
  provider: RuntimeProvider,
  runtimeRef: string,
  accountId: string,
  code: string,
  kind: ChannelKind = 'telegram',
): Promise<boolean> {
  const res = await provider.exec(runtimeRef, [
    'pairing',
    'approve',
    kind,
    code,
    '--account',
    accountId,
  ]);
  return res.code === 0;
}

/**
 * Take back an approval nobody's membership holds: the same on-volume scrub a
 * member removal runs (credentials file, 2026.9 approval rows, config).
 */
async function scrubApproval(
  deps: ClaimDeps,
  opts: ClaimOptions,
  kind: ChannelKind,
  id: string,
  log: (event: string, detail: Record<string, unknown>) => void,
): Promise<void> {
  if (!ID_SHAPE[kind].test(id) || !ACCOUNT_SHAPE.test(opts.accountId)) return;
  const { allowlistScrubScript, inChannelConfigTurn } = await import('./members.js');
  const script = allowlistScrubScript([{
    channel: kind, acct: opts.accountId, id,
    cred: `/home/node/.openclaw/credentials/${kind}-${opts.accountId.toLowerCase()}-allowFrom.json`,
  }]);
  // In the agent's turn at its chat apps, as every other write of them: a
  // door write landing in its middle wrote back what it took out (HB-1554).
  const res = await inChannelConfigTurn(deps.store, opts.agentId, () => {
    forgetDmPolicy(opts.agentId);
    return deps.provider.execShellOnVolume(opts.runtimeRef, script);
  }).catch(() => undefined);
  log(res?.code === 0 ? 'claim.unbound_approval_scrubbed' : 'claim.unbound_approval_scrub_failed', { agentId: opts.agentId, kind });
}

/** How long a window waits for a stopped agent to start before it ends (HB-0468). */
const MAX_DOWN_MS = 7 * 24 * 3_600_000;
/**
 * A window that names nobody ("the first knock wins": a new bot's owner) lasts
 * at most this long from when it opened, down time and all: left waiting for
 * days, whoever wrote to the bot first would become its owner, and get the
 * owner's recovery links (HB-0468 review). Only a window that names its person
 * waits for a stopped agent.
 */
const ANYONE_WINDOW_MAX_MS = 60 * 60_000;
/**
 * A window watched again after a restart (a kept join, HB-0992) with no time
 * left: one open to anyone an hour after it first opened, one that names its
 * person a week after (down all along, as far as anyone knows).
 */
export const windowRanOut = (openedAt: number, named: boolean, now = Date.now()): boolean =>
  now - openedAt >= (named ? MAX_DOWN_MS : ANYONE_WINDOW_MAX_MS);
/** How often a window looks at an agent that is down. */
const DOWN_POLL_MS = 15_000;
/** How far past a down agent's next look its stored window reaches: it must not lapse in between (HB-0468 review). */
const DOWN_SLACK_MS = 15_000;

/**
 * A watch for a first message, kept in the store while it runs (the agent's
 * `first-contact` hold, one entry per seat), so that the next start watches
 * it again (HB-0838): it lived only in memory, and a restart left its window
 * stored with nothing to claim the message it was for, which then showed as
 * a stranger's knock. Kept with it is what its window needs and the window's
 * row does not say, or says only while it is open: the ids it never claims (a
 * recycled bot's earlier chatters, an imported agent's previous owner; never
 * on the row, which names only a join's, excludeKnocks), when it first opened (the
 * hour a window open to anyone may run, and the week it waits for an agent
 * that is down, count from then), and the time it had left, as of `at`: down
 * then, that time was not running.
 */
interface KeptWatch extends WatchTime {
  seat: string; forUserId: string; kind: ChannelKind; accountId: string;
  expect?: string; excludeIds: string[]; openedAt: number;
}
/** Where a watch stands: its window's generation, and the up-time it has left as of `at` (not running while `down`). */
export interface WatchTime { generation: string; left: number; down: boolean; at: number }
/** The up-time a kept watch has left now: what it had at its last look, less the time since, unless the agent was down then. */
export const watchTimeLeft = (t: Pick<WatchTime, 'left' | 'down' | 'at'>, now = Date.now()): number => (t.down ? t.left : t.left - (now - t.at));
const keptWatches = (store: Store, agentId: string): KeptWatch[] => {
  try {
    const list: unknown = JSON.parse(store.agentHold(agentId, 'first-contact') ?? '[]');
    return Array.isArray(list)
      ? list.filter((w): w is KeptWatch => typeof w?.seat === 'string' && typeof w?.generation === 'string' && typeof w?.forUserId === 'string'
        && typeof w?.kind === 'string' && typeof w?.accountId === 'string' && Array.isArray(w?.excludeIds)
        && typeof w?.openedAt === 'number' && typeof w?.left === 'number' && typeof w?.at === 'number')
      : [];
  } catch { return []; }
};
const keepWatch = (store: Store, agentId: string, watch: KeptWatch): void => {
  store.setAgentHold(agentId, 'first-contact', JSON.stringify([...keptWatches(store, agentId).filter((w) => w.seat !== watch.seat), watch]));
};
/** This watch's entry goes; a later watch of the seat keeps its own. */
const letWatchGo = (store: Store, agentId: string, seat: string, generation: string): void => {
  const all = keptWatches(store, agentId);
  const rest = all.filter((w) => !(w.seat === seat && w.generation === generation));
  if (rest.length === all.length) return;
  if (rest.length) store.setAgentHold(agentId, 'first-contact', JSON.stringify(rest));
  else store.clearAgentHold(agentId, 'first-contact');
};

/**
 * Watches for the owner's first contact and binds it. Resolves with the
 * claimed telegram user id, or null when the window closes unclaimed (the
 * agent stays reachable — later senders just wait for manual approval).
 * Kept in the store while it runs (KeptWatch, unless `kept`): once it has
 * ended, claimed or not, or its seat is another watch's, its entry goes; one
 * that threw keeps it, for the next start.
 */
export async function claimFirstContact(
  deps: ClaimDeps,
  opts: ClaimOptions,
): Promise<string | null> {
  const mine: { generation?: string } = {};
  const bound = await watchFirstContact(deps, opts, mine);
  if (mine.generation && !opts.kept) letWatchGo(deps.store, opts.agentId, Store.pairingSeat(opts.kind ?? 'telegram', opts.forUserId), mine.generation);
  return bound;
}

/**
 * At the start, after the first reconcile: each window a watch of the last
 * process was waiting on is watched again (HB-0838), as it was started: its
 * seat, whom it names, the ids it never claims, when it first opened, and
 * the time it had left (counted from its last look, or, down then, from
 * there on). One whose time ran out meanwhile ended unclaimed, as it would
 * have: its window closes, and the pairing sweep puts the door back to rest.
 * One taken over or closed since, or for an agent gone or without that app
 * now, is let go.
 */
export function resumeFirstContacts(deps: {
  store: Store;
  providerFor: (hostId: string) => RuntimeProvider;
  trace: (agentId: string) => (event: string, detail: Record<string, unknown>) => void;
  logError: (obj: Record<string, unknown>, msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): void {
  const { store } = deps;
  for (const { agentId } of store.agentHolds('first-contact')) {
    const watches = keptWatches(store, agentId);
    if (!watches.length) store.clearAgentHold(agentId, 'first-contact');
    const agent = store.getAgent(agentId);
    for (const w of watches) {
      const ours = store.pairingWindows(agentId, new Date(0)).find((r) => r.seat === w.seat)?.generation === w.generation;
      const left = watchTimeLeft(w);
      const live = !!agent?.runtimeRef && agent.state !== 'DELETING' && agent.state !== 'DELETED' && agent.state !== 'FAILED'
        && !!store.getChannelForAgent(agentId, w.kind);
      if (!agent || !ours || !live || left <= 0 || windowRanOut(w.openedAt, !!expectedHandle(w.expect))) {
        letWatchGo(store, agentId, w.seat, w.generation);
        if (ours) {
          store.closePairingWindow(agentId, w.seat);
          deps.trace(agentId)('claim.window_closed', { agentId, afterRestart: true });
        }
        continue;
      }
      void claimFirstContact(
        { store, provider: deps.providerFor(agent.hostId), providerFor: deps.providerFor, log: deps.trace(agentId), ...(deps.sleep ? { sleep: deps.sleep } : {}) },
        {
          agentId, runtimeRef: agent.runtimeRef!, accountId: w.accountId, forUserId: w.forUserId, kind: w.kind,
          ...(w.expect ? { expect: w.expect } : {}), excludeIds: w.excludeIds, timeoutMs: left, openedAt: w.openedAt,
        },
      ).catch((err) => deps.logError({ err, agentId }, 'first-contact watch after a restart failed'));
    }
  }
}

async function watchFirstContact(
  deps: ClaimDeps,
  opts: ClaimOptions,
  mine: { generation?: string },
): Promise<string | null> {
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 3_000;
  // The window's time runs only while the agent is up: a Telegram attached to a
  // stopped agent, or a rebuild mid-window, moves the deadline on by the time it
  // was down, so the person gets the whole window to write once it runs (HB-0468).
  const openedAt = Date.now();
  /** When it first opened: now, or before a restart (opts.openedAt). */
  const firstOpened = Math.min(opts.openedAt ?? openedAt, openedAt);
  /** The latest a window open to anyone may run (ANYONE_WINDOW_MAX_MS); none for a named one. */
  const anyoneEnds = expectedHandle(opts.expect) ? undefined : firstOpened + Math.max(timeoutMs, ANYONE_WINDOW_MAX_MS);
  let deadline = Math.min(openedAt + timeoutMs, anyoneEnds ?? Infinity);
  const until = new Date(deadline).toISOString();
  /** The deadline this watcher last stored; renewal preserves its generation. */
  let written = until;
  // An OPEN DOOR for as long as we are watching — and a narrow one when the
  // owner said WHO the invite is for: only a knock from that @handle or id is
  // ever claimed, so an open window is not "whoever messages first wins".
  //
  // Deliberately NOT ignoring requests that were already pending: the owner
  // who messages the bot before the app gets round to watching, and the
  // request that survived a rebuild, are both normal — refusing them would
  // strand the very person we are waiting for.
  const kindHere = opts.kind ?? 'telegram';
  // This window is one seat's: the owner's first contact and an invitee's
  // run side by side, and closing one must not close the other (30th audit).
  const seat = Store.pairingSeat(kindHere, opts.forUserId);
  /** The ids its row says it never takes as its knock: a join's only (excludeKnocks). */
  const rowExcludes = opts.excludeKnocks ? opts.excludeIds : undefined;
  /** This window's generation, written as it opens (below). */
  let generation = '';
  /** This watch in the store, as of now (KeptWatch): down or up, and the time it has left. */
  const keep = (down: boolean): void => {
    const now = Date.now();
    const time: WatchTime = { generation, left: deadline - now, down, at: now };
    if (opts.kept) { opts.onKept?.(time); return; }
    keepWatch(deps.store, opts.agentId, {
      seat, forUserId: opts.forUserId, kind: kindHere, accountId: opts.accountId,
      ...(opts.expect ? { expect: opts.expect } : {}), excludeIds: opts.excludeIds ?? [], openedAt: firstOpened, ...time,
    });
  };
  // The window and where its watch stands, in one write: written apart, a
  // process in a deploy's overlap that read between them found this one's
  // window over its own, and its join still naming its own generation, and
  // let go of the join this watch had just taken up (HB-1520). Down as it
  // opens (a join to a stopped agent, a bot attached to one): its time does
  // not run yet.
  deps.store.transact(() => {
    generation = deps.store.openPairingWindow(opts.agentId, until, opts.forUserId, { expect: opts.expect, kind: kindHere, excludeIds: rowExcludes });
    keep(deps.store.getAgent(opts.agentId)?.state !== 'RUNNING');
  });
  mine.generation = generation;
  /**
   * This seat's stored window, expired or not. The owner's Reopen, or Telegram attached
   * again, starts another watcher for the same seat, which renews the one row: the later
   * watcher owns the deadline, and this one must not close its window or shut the door
   * when its own time is up (review R22, 2026-10-23; as holdDoorForKnocks does).
   */
  const storedWindow = () => deps.store.pairingWindows(opts.agentId, new Date(0)).find((w) => w.seat === seat);
  const superseded = (): boolean => {
    const w = storedWindow();
    return !!w && w.generation !== generation;
  };
  /** Ends here, the seat another watcher's: said in the trail, and to the caller. */
  const tookOver = (): void => {
    log('claim.window_superseded', { agentId: opts.agentId, kind: kindHere });
    opts.onSuperseded?.();
  };
  const windowLost = (): boolean => {
    if (superseded()) { tookOver(); return true; }
    if (!storedWindow()) { log('claim.window_gone', { agentId: opts.agentId, kind: kindHere }); return true; }
    return false;
  };
  /**
   * Down time moves the deadline on, and the stored window follows, so the
   * build that brings the agent up still finds it and opens the door. While
   * down it reaches past the next look and a little more (downLead), so it
   * never lapses between two looks; written at most every renewEvery. Once up
   * (`exact`), it is the deadline itself, so its last stretch is listed too and
   * another seat's restoreDoor does not shut the door on this one's person
   * (HB-0468 review).
   */
  const renewEvery = Math.min(60_000, Math.max(1, Math.floor(timeoutMs / 2)));
  const downLead = Math.max(pollIntervalMs, DOWN_POLL_MS) + DOWN_SLACK_MS;
  const followDeadline = (exact: boolean): void => {
    const w = Date.parse(written);
    const cap = (t: number) => Math.min(t, anyoneEnds ?? t);
    if (exact ? w === deadline : w >= cap(deadline + downLead)) return;
    if (!storedWindow()) return; // closed by someone else: not reopened here
    written = new Date(exact ? deadline : cap(deadline + downLead + renewEvery)).toISOString();
    deps.store.openPairingWindow(opts.agentId, written, opts.forUserId, { expect: opts.expect, kind: kindHere, generation, excludeIds: rowExcludes });
    keep(!exact);
  };
  let downSince: number | undefined; // when it was last seen down, while it still is
  let downFrom: number | undefined; // when this stretch of down time began
  let firstLook = true; // down at it: down since the window first opened
  // One given that names nobody matches no one: never none, which is anyone (HB-1439 review).
  const expect = expectedHandle(opts.expect);
  const excluded = new Set(opts.excludeIds ?? []);
  // The agent rests in `allowlist`, where a stranger's DM is dropped in
  // silence. Somebody we are waiting for is not yet on the list, so the door
  // has to be `pairing` for as long as the window stands — and no longer.
  const { setDmPolicy } = await import('./members.js');
  const policyDeps = { store: deps.store, provider: deps.provider, log: deps.log };
  await setDmPolicy(policyDeps, {
    agentId: opts.agentId, runtimeRef: opts.runtimeRef, kind: kindHere,
    accountId: opts.accountId, policy: 'pairing',
  }).catch(() => false);
  // The machine it watches: the one the agent was on when the window opened.
  const hostAtStart = deps.store.getAgent(opts.agentId)?.hostId;
  /**
   * Back to silence, unless the owner wants this agent open to anyone — or
   * another window is still waiting for its person. On the machine the agent
   * is on now: one that moved while its window waited has its door there
   * (HB-0468, sixth review), and nothing is done on one it left.
   */
  const restoreDoor = async (): Promise<void> => {
    forgetDmPolicy(opts.agentId); // a window closing re-asserts the door for real
    const agent = deps.store.getAgent(opts.agentId);
    if (!agent || agent.allowKnocks) return;
    // Only this chat app's windows hold its door: a Discord guest's window
    // kept the Telegram door open after the owner's claim (review, 2026-10-22).
    if (deps.store.pairingWindows(opts.agentId).some((w) => w.seat !== seat && w.seat.startsWith(`${kindHere}:`))) return;
    const admit = deps.store.listAllowedChannelUserIds(opts.agentId, kindHere);
    if (!admit.length) return; // nobody yet: stay reachable
    let provider = deps.provider;
    if (hostAtStart !== undefined && agent.hostId !== hostAtStart) {
      if (!deps.providerFor) return;
      try { provider = deps.providerFor(agent.hostId); } catch { return; }
    }
    const door = { agentId: opts.agentId, runtimeRef: agent.runtimeRef ?? opts.runtimeRef, kind: kindHere, accountId: opts.accountId };
    await setDmPolicy({ ...policyDeps, provider }, { ...door, policy: 'allowlist', allowFrom: admit }).catch(() => false);
    // A press of Copy, a Reopen or Allow knocks during that write opened the
    // door, and its write may have landed first: shut again by this one, the
    // window stood open with its door shut for its half hour (HB-1521). As
    // closeKnockWindow does since HB-1372: the door as the store says it is now.
    await doorAsItIs({ store: deps.store, provider, log: deps.log }, { ...door, hostId: agent.hostId }, 'allowlist');
  };
  let readFailed = false; // said once a window, not every round
  for (;;) {
    // Before any close or renewal too: even an expired replacement is not
    // this watcher's window, and identical deadlines can be different invites.
    if (windowLost()) return null;
    const now = Date.now();
    if (downSince !== undefined) { deadline += now - downSince; downSince = now; }
    if (anyoneEnds !== undefined && deadline > anyoneEnds) deadline = anyoneEnds;
    if (now >= deadline) {
      // Open to anyone, and its hour ran out with the agent down: it ends here.
      // When the agent comes up its door is as it rests, and the owner opens
      // a new window to be let in.
      if (downSince !== undefined && anyoneEnds !== undefined && now >= anyoneEnds) {
        log('claim.window_abandoned', { agentId: opts.agentId, reason: 'open-to-anyone' });
        deps.store.closePairingWindow(opts.agentId, seat);
        await restoreDoor();
        return null;
      }
      break;
    }
    // The watcher runs detached from the provision task, so the agent can be
    // deleted, failed, or removed underneath it. Abandon only when there is
    // genuinely nothing to claim; a transient STOPPED/REBUILDING/PROVISIONING
    // (a routine rebuild two minutes into an invitee's 30-min window) means
    // "wait", not "give up" — giving up there stranded the invitee in
    // manual-approval limbo with no error anywhere.
    const agent = deps.store.getAgent(opts.agentId);
    if (!agent || agent.state === 'DELETING' || agent.state === 'DELETED' || agent.state === 'FAILED') {
      log('claim.window_abandoned', { agentId: opts.agentId, state: agent?.state });
      deps.store.closePairingWindow(opts.agentId, seat);
      await restoreDoor();
      return null;
    }
    // A later watcher took this seat over (Reopen, a re-attach): the window
    // and the door are its now, on whichever machine the agent is on. Asked
    // before a move is decided: one reopened as a move ends is not closed here.
    if (superseded()) {
      tookOver();
      return null;
    }
    // A move under way writes the new machine and ref on the record before
    // it has succeeded, and puts the old ones back if it is undone: it is
    // waited out like a rebuild, and nothing is decided meanwhile (HB-0468,
    // sixth review).
    const moving = deps.store.activeOperationFor(opts.agentId)?.kind === 'move-host';
    // Up and settled on another machine: this watcher's provider and runtime
    // are the old machine's, and it would watch and open a door there for
    // days. The window ends, and the door on the machine it is on now is put
    // back to rest; the owner opens a new window there (HB-0468, fifth review).
    const moved = (hostAtStart !== undefined && agent.hostId !== hostAtStart) || (!!agent.runtimeRef && agent.runtimeRef !== opts.runtimeRef);
    if (moved && !moving && agent.state === 'RUNNING') {
      log('claim.window_abandoned', { agentId: opts.agentId, reason: 'moved' });
      deps.store.closePairingWindow(opts.agentId, seat);
      await restoreDoor();
      return null;
    }
    // The membership we're binding for was already claimed (e.g. by an earlier
    // window, or pair-once seeded it) — nothing left to do.
    const kind = opts.kind ?? 'telegram';
    const bound = kind === 'telegram'
      ? deps.store.getMembership(opts.agentId, opts.forUserId)?.channelUserId
      : deps.store.memberIdentities(opts.agentId, opts.forUserId)[kind];
    if (bound) { deps.store.closePairingWindow(opts.agentId, seat); await restoreDoor(); return bound; }

    const down = moving || moved || agent.state === 'STOPPED' || agent.state === 'REBUILDING' || agent.state === 'PROVISIONING';
    if (down) {
      downSince ??= now;
      downFrom ??= firstLook ? firstOpened : now;
      // Stopped for good, as far as a window goes: it ends, and Reopen starts another.
      if (now - downFrom > (opts.maxDownMs ?? MAX_DOWN_MS)) {
        log('claim.window_abandoned', { agentId: opts.agentId, state: agent.state });
        deps.store.closePairingWindow(opts.agentId, seat);
        await restoreDoor();
        return null;
      }
      // Closed by someone else meanwhile (its person let in by hand): nothing
      // to wait for, and the door was theirs to set. Not days of looking.
      if (!storedWindow()) {
        log('claim.window_gone', { agentId: opts.agentId, kind: kindHere });
        return null;
      }
      followDeadline(false);
    } else {
      if (downFrom !== undefined) {
        followDeadline(true);
        // Up again, and still waiting: the door is open, whatever the build
        // that brought it up made of it (HB-0468 review).
        if (storedWindow()) {
          forgetDmPolicy(opts.agentId);
          await setDmPolicy(policyDeps, {
            agentId: opts.agentId, runtimeRef: opts.runtimeRef, kind: kindHere,
            accountId: opts.accountId, policy: 'pairing',
          }).catch(() => false);
        }
      }
      downSince = undefined;
      downFrom = undefined;
    }
    firstLook = false;

    if (!down && agent.state === 'RUNNING') {
      // A read that fails (a docker exec that threw or exited non-zero, a
      // store there that could not be read: strictly read, HB-1050) is tried
      // again next round: thrown out of the loop, it ended the watcher with
      // its window still stored, and the knock it waited for was never
      // claimed (review, 2026-10-22).
      let requests: PairingRequest[];
      try { requests = await listPairingRequests(deps.provider, opts.runtimeRef, opts.accountId, kind, { strict: true }); }
      catch (e) {
        if (!readFailed) log('claim.read_failed', { agentId: opts.agentId, kind, error: String((e as Error)?.message ?? e).slice(0, 200) });
        readFailed = true;
        await sleep(pollIntervalMs);
        continue;
      }
      // Reopen/Close may have landed while Docker was reading the requests.
      if (windowLost()) return null;
      // Skip requests whose sender already belongs to another membership on
      // this agent: a concurrent window may have just bound them, and binding
      // that id here would swap two people's identities.
      const claimable = requests.filter((r) => {
        if (expect && normalizeHandle(r.id) !== expect && normalizeHandle(r.meta?.username) !== expect) return false;
        // Only a shape the platform issues is ever bound: a malformed id would
        // be a member the door never admits and the scrub refuses to touch.
        if (!ID_SHAPE[kind].test(r.id)) return false;
        if (excluded.has(r.id)) return false;
        // An OWNER seat with no named handle is "the first knock": the person
        // a brand-new bot's username was given to. It must never be an id this
        // machine already knows as somebody — a member of another agent, a
        // different owner's link, the previous agent's regulars — or a
        // stranger's first message would become the owner's identity, seed
        // every later agent, and receive the owner's recovery links
        // (2026-09-25).
        if (!expect && deps.store.channelUserBoundAnywhere(kind, r.id)) return false;
        return kind === 'telegram'
          ? !deps.store.getActiveMembershipByChannelUser(opts.agentId, r.id)
          : !deps.store.getMemberByIdentity(opts.agentId, kind, r.id);
      });
      const first = claimable[0];
      // The seat must still be there to bind: approving first let a knock in
      // after the invitee was removed, with no member row to remove them by
      // (night review, 2026-09-28). The window closes instead.
      if (first && !deps.store.listMemberships(opts.agentId).some((m) => m.userId === opts.forUserId && m.status === 'active')) {
        log('claim.seat_gone', { agentId: opts.agentId, kind });
        deps.store.closePairingWindow(opts.agentId, seat);
        await restoreDoor();
        return null;
      }
      if (first) {
        const ok = await approvePairing(deps.provider, opts.runtimeRef, opts.accountId, first.code, kind).catch(() => false);
        if (windowLost()) {
          // The runtime accepted an obsolete invite while the approval was
          // in flight. Remove it unless a current member legitimately owns it.
          if (ok && !deps.store.listAllowedChannelUserIds(opts.agentId, kind).includes(first.id)) {
            await scrubApproval(deps, opts, kind, first.id, log);
          }
          return null;
        }
        const didBind = ok && (kind === 'telegram'
          ? deps.store.bindMembershipChannelUser(opts.agentId, opts.forUserId, first.id)
          : deps.store.bindMemberIdentity(opts.agentId, opts.forUserId, kind, first.id));
        if (didBind) {
          log('claim.bound', {
            agentId: opts.agentId,
            kind,
            channelUserId: first.id,
            username: first.meta?.username,
          });
          deps.store.closePairingWindow(opts.agentId, seat);
          await restoreDoor();
          // Slack/Discord rooms carry their own users list: let them in there
          // now, not at the next rebuild (2026-09-30).
          if (kind !== 'telegram') {
            const { grantRoomAccess } = await import('./members.js');
            // Their seat, and the id on it, looked at again in the grant's turn:
            // asked for while their removal scrubbed, it waited for it, and put
            // them back in the rooms after the flip (HB-1554); an id unlinked
            // meanwhile is not let in either.
            const seatActive = () => deps.store.listMemberships(opts.agentId).some((m) => m.userId === opts.forUserId && m.status === 'active');
            const stillTheirs = () => seatActive() && deps.store.memberIdentities(opts.agentId, opts.forUserId)[kind] === first.id;
            await grantRoomAccess(policyDeps, { agentId: opts.agentId, runtimeRef: opts.runtimeRef, kind, channelUserId: first.id, onlyIf: stillTheirs });
            // Removed while the grant was on its way: the removal's last scrub
            // ran before it landed, and the id stayed in the rooms' users lists
            // until the next build. Taken out again, rooms and all, unless the
            // id is somebody else's here (HB-1522 review).
            if (!deps.store.listMemberships(opts.agentId).some((m) => m.userId === opts.forUserId && m.status === 'active')) {
              if (!deps.store.listAllowedChannelUserIds(opts.agentId, kind).includes(first.id)) await scrubApproval(deps, opts, kind, first.id, log);
              log('claim.seat_gone', { agentId: opts.agentId, kind });
              return null;
            }
          }
          // Say something. OpenClaw answered their first message with the
          // pairing challenge rather than a reply, so an approval that lands
          // in silence reads as "still broken" and the person types "hi"
          // again — which is what it took on a Mac, 2026-09-21. One line from
          // the agent, straight away, ends the exchange properly.
          const agentNow = deps.store.getAgent(opts.agentId);
          const first_name = first.meta?.firstName;
          const hello = opts.forUserId === agentNow?.ownerId
            ? `Connected${first_name ? `, ${first_name}` : ''} — that's you. Ask me anything.`
            : `You're in${first_name ? `, ${first_name}` : ''}. Say what you need whenever you're ready.`;
          await deps.provider
            .exec(opts.runtimeRef, [
              'message', 'send', '--channel', kind, '--account', opts.accountId,
              '--target', `user:${first.id}`, '-m', hello,
            ])
            .catch(() => undefined);
          return first.id;
        }
        if (ok) {
          // Approved but not bound: the seat was removed (or someone else's
          // window took the id) while the approval was in flight. OpenClaw's
          // pairing store now admits a person with no member row to remove
          // them by, so take the approval back unless the id is somebody
          // else's on this agent (A088).
          if (!deps.store.listAllowedChannelUserIds(opts.agentId, kind).includes(first.id)) {
            await scrubApproval(deps, opts, kind, first.id, log);
          }
          if (!deps.store.listMemberships(opts.agentId).some((m) => m.userId === opts.forUserId && m.status === 'active')) {
            log('claim.seat_gone', { agentId: opts.agentId, kind });
            deps.store.closePairingWindow(opts.agentId, seat);
            await restoreDoor();
            return null;
          }
        }
        log('claim.approve_failed', { agentId: opts.agentId, code: first.code });
      }
    }
    // Down, there is nothing to read: a slower look, for what can be days.
    await sleep(downSince !== undefined ? Math.max(pollIntervalMs, DOWN_POLL_MS) : pollIntervalMs);
  }
  // Renewed during the last round's sleep: the later watcher closes it when ITS time is up.
  if (superseded()) {
    tookOver();
    return null;
  }
  log('claim.window_closed', { agentId: opts.agentId });
  deps.store.closePairingWindow(opts.agentId, seat);
  await restoreDoor();
  return null;
}

/**
 * A door held open to be LOOKED AT, never walked through on its own
 * (2026-09-30).
 *
 * The invite dialog promised "send them the Telegram link; when they message
 * it you get a 'wants to join' prompt" — but an agent rests in `allowlist`,
 * where a stranger's DM is dropped without a word, so the prompt never came.
 * Copying or sharing the Telegram invite now opens one window like this: the
 * door is `pairing` for 30 minutes, a knock that fits it (the invite's
 * @handle when it named one, anyone otherwise) is SHOWN under "Alerts" as
 * wanting to join, and nothing is admitted until the owner taps "Let them
 * in". Unlike claimFirstContact there is no watcher binding the first knock:
 * the window is only what expectedKnock and the rest-door rules read.
 *
 * One window per invite (`key`): pressing Copy again refreshes its deadline
 * rather than stacking another. It closes itself when the time is up, and
 * the door goes back to silence unless something else still holds it open.
 */
export async function holdDoorForKnocks(
  deps: ClaimDeps,
  opts: {
    agentId: string; runtimeRef: string; accountId: string;
    /** The invite this window belongs to. */
    key: string;
    /** Who the invite named — a Telegram @handle — if anyone. */
    expect?: string;
    kind?: ChannelKind;
    timeoutMs?: number;
    /** Tests: skip the timer that closes the window. */
    noTimer?: boolean;
    /** An owner's press: its door write's longest wait for the agent's turn at its chat apps (PRESS_WAIT_MS), then KnockWindowError('busy'). */
    waitMs?: number;
  },
): Promise<{ seat: string; until: string }> {
  const kind = opts.kind ?? 'telegram';
  const openedFor = knockSeatFor(opts.key);
  const seat = Store.pairingSeat(kind, openedFor);
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const until = new Date(Date.now() + timeoutMs).toISOString();
  // A window's close, half a second after it ends: pressed again meanwhile,
  // the later press owns the deadline. Closed already (its person let in, or
  // another timer of the same window, as a window a failed press put back
  // has two: its own and the first press's), the door was put back by that
  // close: written again here, it was one more door write, and one that can
  // land after a later press's (HB-1365).
  const closeAt = (end: string) => {
    if (opts.noTimer) return;
    setTimeout(() => {
      const rows = deps.store.pairingWindows(opts.agentId, new Date(0)).filter((w) => w.seat === seat);
      if (!rows.length || rows.some((w) => Date.parse(w.until) > Date.now() + 1000)) return;
      void closeKnockWindow(deps, opts.agentId, seat, kind).catch(() => {});
    }, Math.max(0, Date.parse(end) - Date.now()) + 500).unref?.();
  };
  // The window first, so a door rest meanwhile leaves the door it opens.
  const before = deps.store.pairingWindows(opts.agentId).find((w) => w.seat === seat);
  const mine = deps.store.openPairingWindow(opts.agentId, until, openedFor, { expect: opts.expect, kind });
  const { ChannelConfigBusyError, writeDmPolicy } = await import('./members.js');
  let busy = '';
  const out = await writeDmPolicy({ store: deps.store, provider: deps.provider, log: deps.log }, {
    agentId: opts.agentId, runtimeRef: opts.runtimeRef, kind, accountId: opts.accountId, policy: 'pairing', waitMs: opts.waitMs,
  }).catch((err: unknown) => {
    // Waited as long as a press may for a slow write ahead of it (HB-1554): nothing of it was written.
    if (err instanceof ChannelConfigBusyError) busy = err.userMessage;
    return 'failed' as const;
  });
  if (out !== 'set' && out !== 'unchanged') {
    // The door did not open: this press holds nothing open, and says so. The
    // window is put back as it was (an earlier press's, still counting down,
    // or none), or it said "open" for half an hour that nobody could knock in,
    // and the door rest left it alone (HB-0953). Only while the window is
    // still the one this press wrote: a second press of the invite meanwhile
    // read this one's window as its own `before`, and its window, which it
    // may have said is open, is not this press's to undo. (Put back with its
    // generation, an earlier press still under way finds its own window, and
    // undoes it if its write fails too.)
    // A window put back closes at its own end, on a timer of its own: the
    // press that opened it may never have set one (its write failed too), or
    // its timer fired during this press's write, saw this window and stood
    // down. One whose time is already up is closed now, its door at rest.
    const now = deps.store.pairingWindows(opts.agentId, new Date(0)).find((w) => w.seat === seat);
    if (now?.generation === mine) {
      if (before && Date.parse(before.until) > Date.now()) {
        deps.store.openPairingWindow(opts.agentId, before.until, openedFor, { expect: before.expect, kind, generation: before.generation, excludeIds: before.excludeIds });
        closeAt(before.until);
      } else if (before && busy) {
        // Refused for its wait (HB-1554): the close would wait as long again, so it goes on by itself.
        void closeKnockWindow(deps, opts.agentId, seat, kind).catch(() => {});
      } else if (before) await closeKnockWindow(deps, opts.agentId, seat, kind).catch(() => {});
      else deps.store.closePairingWindow(opts.agentId, seat);
    }
    deps.log?.('invite.knock_window_failed', { agentId: opts.agentId, kind, result: busy ? 'busy' : out });
    throw new KnockWindowError(busy ? 'busy' : out, busy || undefined);
  }
  deps.log?.('invite.knock_window', { agentId: opts.agentId, kind, named: !!opts.expect, until });
  closeAt(until);
  return { seat, until };
}

/**
 * holdDoorForKnocks could not open the door: the write failed, the volume has
 * no such app to open, or a press waited too long for its turn (`busy`, with
 * the words for the owner) (`outcome`).
 */
export class KnockWindowError extends Error {
  constructor(readonly outcome: 'failed' | 'no-account' | 'no-config' | 'busy', words?: string) {
    super(words ?? (outcome === 'failed' ? 'the door could not be written' : 'the agent\'s container has no such app set up'));
    this.name = 'KnockWindowError';
  }
}

/** The `opened_for` of a knock window: never a user id, so no claim ever binds to it. */
export const knockSeatFor = (key: string): string => `knock:${key}`;
/** Is this window one that only shows knocks (holdDoorForKnocks), not a claim? */
export const isKnockWindow = (w: { openedFor?: string }): boolean => !!w.openedFor?.startsWith('knock:');

/**
 * Close a knock window and put the door back to silence when nothing else
 * holds it open. Read afresh: 30 minutes on, the container may have been
 * rebuilt (a new runtimeRef) or stopped (the next build writes the door).
 */
export async function closeKnockWindow(deps: ClaimDeps, agentId: string, seat: string, kind: ChannelKind = 'telegram'): Promise<void> {
  deps.store.closePairingWindow(agentId, seat);
  forgetDmPolicy(agentId);
  const agent = deps.store.getAgent(agentId);
  if (!agent || agent.allowKnocks || agent.state !== 'RUNNING' || !agent.runtimeRef) return;
  if (deps.store.pairingWindows(agentId).some((w) => w.seat.startsWith(`${kind}:`))) return;
  const admit = deps.store.listAllowedChannelUserIds(agentId, kind);
  if (!admit.length) return; // nobody yet: stay reachable
  const ch = deps.store.getChannelForAgent(agentId, kind);
  if (!ch) return;
  // The machine it is on now: moved while its window was open, the provider
  // the window was opened with is the old machine's, which would be handed
  // the new container's name and the door there left open (HB-0649).
  let provider = deps.provider;
  if (deps.providerFor) {
    try { provider = deps.providerFor(agent.hostId); } catch { return; }
  }
  const { setDmPolicy } = await import('./members.js');
  const { CHANNEL_ACCOUNT } = await import('../../openclaw/configWriter.js');
  const door = { agentId, runtimeRef: agent.runtimeRef, kind, accountId: kind === 'telegram' ? ch.accountId : CHANNEL_ACCOUNT };
  await setDmPolicy({ store: deps.store, provider, log: deps.log }, { ...door, policy: 'allowlist', allowFrom: admit }).catch(() => false);
  // A press of Copy that landed during that write opened its window, and
  // wrote its door open; door writes are not in order, and this one, landing
  // after, left that window open with its door shut for its half hour
  // (HB-1372). So too when the agent was opened to anyone during the write
  // (Allow knocks): its own write of the door open may have landed first,
  // and the sweep's restDoor leaves such an agent alone. The door is written
  // again as the store says it is now (doorAsItIs), on the container it was
  // written on.
  await doorAsItIs({ store: deps.store, provider, log: deps.log }, { ...door, hostId: agent.hostId }, 'allowlist');
}

/**
 * After a write of an agent's door on one app, the door as the store says it
 * is now, on the container it was written on (HB-1372, HB-1521). Door writes
 * are not in order, and each writer chose what to write before it waited for
 * the machine: a window opened, or the agent opened to anyone, during a write
 * of the door to rest, and its own write of it open landed first, so the door
 * stood shut with the window open for its half hour; a window closed during a
 * write of it open (this look's own), and its write to rest landed first, so
 * the door stood in `pairing` with no window until the next sweep. So the
 * writer looks again once its write has landed, and writes what the store
 * says while that differs from what it wrote, at most three times (changes
 * still coming then are the next sweep's restDoor's). Open while a window on
 * the app waits or anyone may knock; at rest with somebody on the list;
 * nobody on it, left as it is, as every rest leaves it. Stopped, rebuilt or
 * moved since, nothing: its next start or build writes the door.
 *
 * Since HB-1554 one process's door writes take turns, so in one process the
 * look again finds nothing to do; it stays for two processes overlapping at
 * a deploy. `waitMs`: an owner's press, each write's longest wait for the
 * agent's turn (PRESS_WAIT_MS); refused, the look again goes on by itself,
 * with no limit, and the press is answered.
 */
export async function doorAsItIs(
  deps: { store: Store; provider: RuntimeProvider; log?: ClaimDeps['log'] },
  door: { agentId: string; runtimeRef: string; hostId: string; kind: ChannelKind; accountId: string },
  wrote: 'allowlist' | 'pairing',
  opts: { waitMs?: number } = {},
): Promise<void> {
  const { ChannelConfigBusyError, setDmPolicy } = await import('./members.js');
  for (let round = 0; round < 3; round++) {
    const now = deps.store.getAgent(door.agentId);
    if (!now || now.state !== 'RUNNING' || now.runtimeRef !== door.runtimeRef || now.hostId !== door.hostId) return;
    const open = !!now.allowKnocks || deps.store.pairingWindows(door.agentId).some((w) => w.seat.startsWith(`${door.kind}:`));
    const admit = open ? [] : deps.store.listAllowedChannelUserIds(door.agentId, door.kind);
    if (!open && !admit.length) return; // nobody yet: stay reachable
    const want = open ? 'pairing' : 'allowlist';
    if (want === wrote) return;
    forgetDmPolicy(door.agentId);
    let busy = false;
    await setDmPolicy(deps, {
      agentId: door.agentId, runtimeRef: door.runtimeRef, kind: door.kind, accountId: door.accountId,
      policy: want, ...(want === 'allowlist' ? { allowFrom: admit } : {}), waitMs: opts.waitMs,
    }).catch((err: unknown) => { busy = err instanceof ChannelConfigBusyError; return false; });
    if (busy) {
      void doorAsItIs(deps, door, wrote).catch(() => {});
      return;
    }
    wrote = want;
  }
}

/**
 * Tolerant parser for `openclaw pairing list --json`. Verified 2026.6.11 shape
 * (from credentials/telegram-pairing.json): {version, requests: [{id, code,
 * meta}]}. Also accepts a bare array in case the CLI wraps differently.
 */
/** The pairing list shell's answer ({version, requests: […], unread?, none?}), or undefined when it did not run. */
function pairingListAnswer(code: number, stdout: string): { requests: unknown[]; unread: string[]; none: boolean } | undefined {
  if (code !== 0 || !stdout.trim()) return undefined;
  try {
    const j = JSON.parse(stdout) as { requests?: unknown; unread?: unknown; none?: unknown } | unknown[];
    // A bare list is an answer too, as parsePairingList reads one.
    if (Array.isArray(j)) return { requests: j, unread: [], none: false };
    if (!j || typeof j !== 'object' || !Array.isArray(j.requests)) return undefined;
    return { requests: j.requests, unread: Array.isArray(j.unread) ? j.unread.map(String) : [], none: j.none === true };
  } catch { return undefined; }
}

export function parsePairingList(stdout: string): PairingRequest[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as any).requests)
      ? (parsed as any).requests
      : [];
  return arr
    .filter((r: any) => r && typeof r.id !== 'undefined' && typeof r.code === 'string')
    // Discord's meta says `tag`/`name` where Telegram's says `username`/`firstName`; the app reads the latter.
    .map((r: any) => ({ id: String(r.id), code: r.code, meta: r.meta && typeof r.meta === 'object' ? { ...r.meta, username: r.meta.username ?? r.meta.tag, firstName: r.meta.firstName ?? r.meta.name } : r.meta }));
}
