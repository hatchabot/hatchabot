/**
 * Keep a bot's DISPLAY name in step with the agent it serves.
 *
 * Telegram has two names: the immutable `@username` chosen at BotFather, and a
 * display name that shows in the chat header and contact list. Only the second
 * can change, so this is what makes a recycled pool bot — or an agent the owner
 * renamed — read correctly in Telegram instead of keeping whatever it was
 * called when the token was minted.
 *
 * Always best-effort: a rename is cosmetic, and neither a Telegram limit nor an
 * outage may block provisioning or an agent rename. But best-effort used to
 * mean SILENT, and a lease that quietly left a bot advertising
 * "AgentClaw (unassigned)" was indistinguishable from one that was never
 * attempted — so the outcome is reported, and the caller logs it.
 */
export type RenameResult = {
  ok: boolean;
  /** Telegram's own description, or the transport failure. Absent on success. */
  error?: string;
  /** Seconds Telegram asked us to wait, when it rate-limited the change. */
  retryAfter?: number;
};

export async function setTelegramDisplayName(
  token: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RenameResult> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'empty name' };

  const attempt = async (): Promise<RenameResult> => {
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/setMyName`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: trimmed.slice(0, 64) }), // Telegram's cap
        signal: AbortSignal.timeout(5000),
      });
      // A non-JSON body (outage page) must not throw — this is decorative.
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        description?: string;
        parameters?: { retry_after?: number };
      };
      if (body.ok === true) return { ok: true };
      return {
        ok: false,
        error: body.description ?? `HTTP ${res.status}`,
        retryAfter: body.parameters?.retry_after,
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  };

  const first = await attempt();
  // One retry, and only for a limit short enough to wait out inline. Telegram
  // rate-limits name changes, and a lease that renames a bot moments after the
  // release that renamed it is exactly the case that trips it.
  if (!first.ok && first.retryAfter !== undefined && first.retryAfter <= 10) {
    await new Promise((r) => setTimeout(r, (first.retryAfter! + 1) * 1000));
    return attempt();
  }
  return first;
}
