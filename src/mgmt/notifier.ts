import type { BotTransport } from './bot.js';
import type { PendingJoin } from './broker.js';

/**
 * Background approval-push: polls the control plane for pending "wants to join"
 * requests across the owner's fleet and DMs the owner a one-tap Approve card the
 * moment a new one appears — so nobody has to open the web UI (and cross the
 * tailnet) to notice that an invitee messaged the bot.
 *
 * Deliberately transport- and client-agnostic (fakes drive it in tests). The
 * one-tap approve is handled back in bot.onCallback via the `apr:` / `apx:`
 * callback data this emits.
 */

export interface PendingSource {
  listAllPending(): Promise<PendingJoin[]>;
}

export interface NotifierOptions {
  intervalMs?: number;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

/** Human label for a requester, tolerant of missing name/username. */
export function joinerLabel(p: PendingJoin): string {
  const name = [p.firstName, p.lastName].filter(Boolean).join(' ').trim();
  if (name && p.username) return `${name} (@${p.username})`;
  return name || (p.username ? `@${p.username}` : 'Someone');
}

export const APPROVE_PREFIX = 'apr';
/** Turns the request away for real (not just closing the card) — see denyPairing. */
export const DENY_PREFIX = 'apd';

/**
 * Start polling. Sends each newly-seen request once to every allowlisted admin
 * (in a private chat the chat id equals the user id, so no chat id needs
 * storing). Returns a stop handle. `tick` is exposed for tests to drive one
 * pass deterministically without the timer.
 */
export function createPairingNotifier(
  api: PendingSource,
  tx: BotTransport,
  allowlist: number[],
  opts: NotifierOptions = {},
) {
  const log = opts.log ?? (() => {});
  const seen = new Set<string>();
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) return; // never overlap a slow poll with the next tick
    inFlight = true;
    try {
      const pending = await api.listAllPending();
      const live = new Set(pending.map((p) => `${p.agentId}:${p.code}`));
      // Forget requests that are no longer pending (approved elsewhere / expired)
      // so the set can't grow without bound and a recycled code can re-notify.
      for (const k of [...seen]) if (!live.has(k)) seen.delete(k);
      for (const p of pending) {
        const key = `${p.agentId}:${p.code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const text = `👤 ${joinerLabel(p)} wants to join "${p.agentName}".\nLet them in?`;
        const buttons = [[
          { text: '✅ Approve', data: `${APPROVE_PREFIX}:${p.agentId}:${p.code}` },
          { text: '🚫 Not now', data: `${DENY_PREFIX}:${p.agentId}:${p.code}` },
        ]];
        for (const uid of allowlist) {
          try {
            await tx.sendMessage(uid, text, buttons);
          } catch (e) {
            log('notify.send_failed', { uid, error: String((e as Error).message ?? e) });
          }
        }
        log('notify.pending', { agentId: p.agentId, code: p.code });
      }
    } catch (e) {
      log('notify.poll_failed', { error: String((e as Error).message ?? e) });
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), opts.intervalMs ?? 20_000);
  (timer as { unref?: () => void }).unref?.();
  // Note: no immediate tick here — the caller kicks the first pass explicitly
  // (index.ts does), which keeps this deterministic to drive in tests.

  return { tick, stop: () => clearInterval(timer) };
}
