/**
 * "Unread" for an agent icon: the agent said something you could only have
 * read in Hatchabot's console, after you last had that console open.
 *
 * OpenClaw keeps one record per conversation in sessions.json. A Telegram DM
 * and the web console share the agent's main conversation, and the record
 * remembers which way the last exchange went. Telegram shows its own unread
 * mark, so an exchange that went there is not ours to flag.
 */
export interface SessionEntry {
  updatedAt?: number;
  lastInteractionAt?: number;
  lastTo?: string;
  lastChannel?: string;
  origin?: { from?: string; provider?: string };
}

const WEB = new Set(['', 'webchat', 'web', 'internal', 'cli']);

/** Newest activity (ms since epoch) that was not delivered to a messaging app; 0 if none. */
export function consoleActivity(sessions: Record<string, SessionEntry> | undefined, opts: { webOnly: boolean }): number {
  let newest = 0;
  for (const [key, s] of Object.entries(sessions ?? {})) {
    if (!s || typeof s !== 'object') continue;
    // Scheduled runs on an agent with a bot are delivered there. Only a
    // web-only agent's scheduled output has nowhere else to be read.
    if (key.includes(':cron:') && !opts.webOnly) continue;
    const to = String(s.lastTo ?? s.origin?.from ?? '');
    const channel = String(s.lastChannel ?? (to.includes(':') ? to.split(':')[0] : '') ?? s.origin?.provider ?? '').toLowerCase();
    if (!WEB.has(channel)) continue;
    const at = Math.max(Number(s.updatedAt) || 0, Number(s.lastInteractionAt) || 0);
    if (at > newest) newest = at;
  }
  return newest;
}
