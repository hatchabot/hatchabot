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
  meta?: { username?: string; firstName?: string; lastName?: string };
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
  ownerId: string;
  /** How long to keep watching for the owner's first message. */
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export async function listPairingRequests(
  provider: RuntimeProvider,
  runtimeRef: string,
  accountId: string,
): Promise<PairingRequest[]> {
  const res = await provider.exec(runtimeRef, [
    'pairing',
    'list',
    'telegram',
    '--account',
    accountId,
    '--json',
  ]);
  if (res.code !== 0) return [];
  return parsePairingList(res.stdout);
}

export async function approvePairing(
  provider: RuntimeProvider,
  runtimeRef: string,
  accountId: string,
  code: string,
): Promise<boolean> {
  const res = await provider.exec(runtimeRef, [
    'pairing',
    'approve',
    'telegram',
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

  while (Date.now() < deadline) {
    const requests = await listPairingRequests(deps.provider, opts.runtimeRef, opts.accountId);
    const first = requests[0];
    if (first) {
      const ok = await approvePairing(deps.provider, opts.runtimeRef, opts.accountId, first.code);
      if (ok) {
        deps.store.bindMembershipChannelUser(opts.agentId, opts.ownerId, first.id);
        log('claim.bound', {
          agentId: opts.agentId,
          channelUserId: first.id,
          username: first.meta?.username,
        });
        return first.id;
      }
      log('claim.approve_failed', { agentId: opts.agentId, code: first.code });
    }
    await sleep(pollIntervalMs);
  }
  log('claim.window_closed', { agentId: opts.agentId });
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
