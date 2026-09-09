import type { Store } from '../store/store.js';
import type { SecretStore } from '../secrets/secretStore.js';

/**
 * Post a short message into an agent's Telegram chat via that agent's OWN bot —
 * the same primitive archive's goodbye uses (telegramPool #farewell), but
 * without releasing the bot. The token is resolved through getChannelForAgent,
 * so it works for both pool and pasted bots.
 *
 * Best-effort: a missing bot/token or a Telegram hiccup is swallowed, so a
 * caller's real work is never blocked by a cosmetic notification. Returns how
 * many chats were successfully messaged.
 */
export async function notifyAgentChat(
  store: Store,
  secrets: SecretStore,
  agentId: string,
  text: string,
  opts: { chatIds?: string[]; fetchImpl?: typeof fetch } = {},
): Promise<number> {
  const row = store.getChannelForAgent(agentId);
  if (!row) return 0; // no bot attached — nothing to post to
  const token = await secrets.get(row.secretRef).catch(() => null);
  if (!token) return 0;
  // Default audience = every active member (the same set #farewell messages);
  // callers can narrow it (e.g. just the owner who triggered the action).
  const ids = (opts.chatIds ?? store.listAllowedChannelUserIds(agentId)).filter((id) => /^\d{1,32}$/.test(id));
  const fetchImpl = opts.fetchImpl ?? fetch;
  let sent = 0;
  await Promise.all(
    ids.map((id) =>
      fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: id, text }),
        signal: AbortSignal.timeout(5000),
      })
        .then(() => { sent++; })
        .catch(() => {}),
    ),
  );
  return sent;
}
