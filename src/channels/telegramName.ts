/**
 * Keep a bot's DISPLAY name in step with the agent it serves.
 *
 * Telegram has two names: the immutable `@username` chosen at BotFather, and a
 * display name that shows in the chat header and contact list. Only the second
 * can change, so this is what makes a recycled pool bot — or an agent the owner
 * renamed — read correctly in Telegram instead of keeping whatever it was
 * called when the token was minted.
 *
 * Always best-effort: a rename is cosmetic, Telegram rate-limits `setMyName`
 * (repeated renames legitimately fail), and neither a limit nor an outage may
 * block provisioning or an agent rename.
 */
export async function setTelegramDisplayName(
  token: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) return false;
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/setMyName`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: trimmed.slice(0, 64) }), // Telegram's cap
      signal: AbortSignal.timeout(5000),
    });
    // A non-JSON body (outage page) must not throw — this is decorative.
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}
