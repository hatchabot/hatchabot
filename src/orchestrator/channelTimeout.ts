/**
 * How long OpenClaw lets a chat-app message take to get going before it gives
 * up on that attempt and retries it (docs/features.md, "Token steward").
 *
 * OpenClaw 2026.9.6 claims each Telegram update from its ingress queue and
 * waits OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS (default 300000, 5
 * minutes) for the turn to be adopted. A /compact on a 446K conversation
 * spends that long summarising before any turn starts, so it was aborted and
 * retried every ~5 minutes for hours (2026-10-04, one agent): OpenClaw only
 * dead-letters an event after 8 attempts AND 24 hours. Hatchabot gives every
 * agent 30 minutes instead, in the container's environment (applies at the
 * next rebuild; the agent's own Environment value wins).
 *
 * Slack and Discord use the same ingress drain with the same 5 minutes, but
 * their 2026.9.6 plugins pass no limit and read no variable: there is nothing
 * to set for them.
 */

const HOUR = 3_600_000;

/** The handler time limit Hatchabot gives every agent's chat-app messages (OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS). */
export const CHANNEL_HANDLER_TIMEOUT_DEFAULT_MS = 1_800_000;
/** OpenClaw's own, before Hatchabot raised it (2026.9.6: DEFAULT_INGRESS_ADOPTION_STALL_MS). */
export const OPENCLAW_HANDLER_TIMEOUT_MS = 300_000;
/**
 * The fleet's chat-app handler limit, from HATCHABOT_CHANNEL_HANDLER_TIMEOUT_MS
 * (minutes are not accepted: milliseconds, as OpenClaw takes them). 0 or "off"
 * leaves OpenClaw's own 5 minutes.
 */
export function channelHandlerTimeoutMs(raw = process.env.HATCHABOT_CHANNEL_HANDLER_TIMEOUT_MS): number | undefined {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return CHANNEL_HANDLER_TIMEOUT_DEFAULT_MS;
  if (['off', '0', 'false', 'no'].includes(v)) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 60_000 ? Math.min(Math.round(n), 6 * HOUR) : CHANNEL_HANDLER_TIMEOUT_DEFAULT_MS;
}
/**
 * The env Hatchabot puts in every agent's container for it. Telegram is the
 * one channel with a knob: Slack and Discord (their 2026.9.6 plugins) use
 * OpenClaw's ingress drain with its built-in 5 minutes and read no variable.
 */
export function channelTimeoutEnv(ms: number | null | undefined = channelHandlerTimeoutMs()): Record<string, string> {
  return ms ? { OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS: String(ms) } : {};
}
