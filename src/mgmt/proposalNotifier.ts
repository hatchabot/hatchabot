import type { BotTransport } from './bot.js';

/**
 * Approvals from Telegram, for changes the account's management AGENT
 * prepared. The agent can't be allowed to collect its own approvals: it
 * controls its own conversation and could fake a button. This bot is a separate
 * process with its own token, which the agent has no way to speak as.
 *
 * Polls the owner's "Waiting for you" list, sends each new agent-prepared
 * proposal with Confirm/Cancel, and a tap goes to the same server route the
 * home screen uses — so it executes as the bot's owner, once, wherever it was
 * pressed first.
 */
export interface WebProposal { confirmId: string; summary: string; source?: string; note?: string; risk?: string; createdAtMs?: number }
export interface ProposalSource {
  listProposals(): Promise<{ pending: WebProposal[] }>;
  resolveProposal(id: string, verb: 'confirm' | 'cancel'): Promise<{ text: string }>;
}

export const PROPOSAL_PREFIX = 'prp';

export function proposalCardText(p: WebProposal): string {
  const risk = p.risk === 'careful' ? '⚠️ Read carefully\n' : p.risk === 'disruptive' ? '↻ Restarts or interrupts something\n' : '';
  return `🐣 Your Hatchabot agent prepared a change:\n${risk}\n${p.summary.slice(0, 3000)}` +
    (p.note ? `\n\nIts reason: “${p.note.slice(0, 400)}”` : '');
}

export function createProposalNotifier(api: ProposalSource, tx: BotTransport, allowlist: number[], opts: { intervalMs?: number; now?: () => number; log?: (e: string, d: Record<string, unknown>) => void } = {}) {
  const seen = new Set<string>();
  const startedAt = (opts.now ?? Date.now)();
  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const { pending } = await api.listProposals();
      const live = new Set(pending.map((p) => p.confirmId));
      for (const k of [...seen]) if (!live.has(k)) seen.delete(k);
      for (const p of pending) {
        if (seen.has(p.confirmId)) continue;
        seen.add(p.confirmId);
        if (p.source !== 'agent') continue; // the web chat's own cards are already in front of the person
        if ((p.createdAtMs ?? 0) < startedAt - 60_000) continue; // don't re-announce old ones after a bot restart
        for (const chatId of allowlist) {
          await tx.sendMessage(chatId, proposalCardText(p), [[
            { text: '✅ Confirm', data: `${PROPOSAL_PREFIX}:${p.confirmId}:y` },
            { text: '✖ Cancel', data: `${PROPOSAL_PREFIX}:${p.confirmId}:n` },
          ]]).catch((e) => opts.log?.('mgmt.proposal_notify_failed', { error: String((e as Error).message ?? e) }));
        }
      }
    } catch (e) {
      opts.log?.('mgmt.proposal_poll_failed', { error: String((e as Error).message ?? e) });
    } finally {
      inFlight = false;
    }
  };
  let timer: NodeJS.Timeout | undefined;
  return {
    tick,
    start() { timer = setInterval(() => void tick(), opts.intervalMs ?? 15_000); timer.unref(); },
    stop() { if (timer) clearInterval(timer); },
  };
}
