import type { ChannelKind } from '../domain/types.js';
import type { RuntimeProvider } from '../providers/provider.js';
import type { Store } from '../store/store.js';

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
  /** How long to keep watching for the owner's first message. */
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/** Where OpenClaw keeps pending Telegram pairing requests, on the volume. */
export const PAIRING_STORE = '/home/node/.openclaw/credentials/telegram-pairing.json';
/** The same store for any channel: OpenClaw names it `<channel>-pairing.json`. */
export const pairingStorePath = (kind: ChannelKind = 'telegram') => `/home/node/.openclaw/credentials/${kind}-pairing.json`;

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
): Promise<PairingRequest[]> {
  const res = await provider.execShell(runtimeRef, `cat ${JSON.stringify(pairingStorePath(kind))} 2>/dev/null || true`);
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
 * Watches for the owner's first contact and binds it. Resolves with the
 * claimed telegram user id, or null when the window closes unclaimed (the
 * agent stays reachable — later senders just wait for manual approval).
 */
export async function claimFirstContact(
  deps: ClaimDeps,
  opts: ClaimOptions,
): Promise<string | null> {
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  // An OPEN DOOR for as long as we are watching: while this window stands, a
  // DM from a stranger is the person we are expecting, so an invite-only agent
  // lets it through to be claimed. Closed again the moment we stop watching.
  deps.store.openPairingWindow(opts.agentId, new Date(deadline).toISOString(), opts.forUserId);

  while (Date.now() < deadline) {
    // The watcher runs detached from the provision task, so the agent can be
    // deleted, failed, or removed underneath it. Abandon only when there is
    // genuinely nothing to claim; a transient STOPPED/REBUILDING/PROVISIONING
    // (a routine rebuild two minutes into an invitee's 30-min window) means
    // "wait", not "give up" — giving up there stranded the invitee in
    // manual-approval limbo with no error anywhere.
    const agent = deps.store.getAgent(opts.agentId);
    if (!agent || agent.state === 'DELETING' || agent.state === 'DELETED' || agent.state === 'FAILED') {
      log('claim.window_abandoned', { agentId: opts.agentId, state: agent?.state });
      deps.store.closePairingWindow(opts.agentId);
      return null;
    }
    // The membership we're binding for was already claimed (e.g. by an earlier
    // window, or pair-once seeded it) — nothing left to do.
    const kind = opts.kind ?? 'telegram';
    const bound = kind === 'telegram'
      ? deps.store.getMembership(opts.agentId, opts.forUserId)?.channelUserId
      : deps.store.memberIdentities(opts.agentId, opts.forUserId)[kind];
    if (bound) { deps.store.closePairingWindow(opts.agentId); return bound; }

    if (agent.state === 'RUNNING') {
      const requests = await listPairingRequests(deps.provider, opts.runtimeRef, opts.accountId, kind);
      // Skip requests whose sender already belongs to another membership on
      // this agent: a concurrent window may have just bound them, and binding
      // that id here would swap two people's identities.
      const claimable = requests.filter((r) => (kind === 'telegram'
        ? !deps.store.getActiveMembershipByChannelUser(opts.agentId, r.id)
        : !deps.store.getMemberByIdentity(opts.agentId, kind, r.id)));
      const first = claimable[0];
      if (first) {
        const ok = await approvePairing(deps.provider, opts.runtimeRef, opts.accountId, first.code, kind);
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
          deps.store.closePairingWindow(opts.agentId);
          return first.id;
        }
        log('claim.approve_failed', { agentId: opts.agentId, code: first.code });
      }
    }
    await sleep(pollIntervalMs);
  }
  log('claim.window_closed', { agentId: opts.agentId });
  deps.store.closePairingWindow(opts.agentId);
  return null;
}

/**
 * Tolerant parser for `openclaw pairing list --json`. Verified 2026.6.11 shape
 * (from credentials/telegram-pairing.json): {version, requests: [{id, code,
 * meta}]}. Also accepts a bare array in case the CLI wraps differently.
 */
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
    .map((r: any) => ({ id: String(r.id), code: r.code, meta: r.meta }));
}
