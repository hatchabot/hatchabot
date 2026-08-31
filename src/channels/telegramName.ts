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
  /** The request never reached Telegram — worth retrying, unlike a refusal. */
  transport?: boolean;
};

export async function setTelegramDisplayName(
  token: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
  /** Waits between retries. Injectable so tests don't sleep for real. */
  backoffMs: readonly number[] = [1000, 3000],
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
      // `fetch failed` on its own names nothing — the reason (DNS, refused,
      // connect timeout) is on .cause, and dropping it is why a live failure
      // took a second round of diagnosis.
      const cause = (err as { cause?: unknown } | undefined)?.cause;
      return { ok: false, error: cause ? `${String(err)} (${String(cause)})` : String(err), transport: true };
    }
  };

  // Transport failures are retried; a REFUSAL from Telegram is not (except a
  // short rate limit). The live case that forced this: a bot renamed during
  // provisioning failed with a bare `TypeError: fetch failed` and stayed named
  // "AgentClaw (unassigned)", while the same call 49 seconds earlier had
  // succeeded — the box was churning docker networking at that moment. One
  // attempt was never going to be enough on a machine that is also starting
  // containers.
  let last = await attempt();
  for (const wait of backoffMs) {
    if (last.ok) return last;
    const shortLimit = last.retryAfter !== undefined && last.retryAfter <= 10;
    if (!last.transport && !shortLimit) return last; // a real refusal — stop asking
    await new Promise((r) => setTimeout(r, shortLimit ? (last.retryAfter! + 1) * 1000 : wait));
    last = await attempt();
  }
  return last;
}
