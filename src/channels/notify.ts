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
        // Only a message Telegram accepted counts: a 403 (they blocked the
        // bot) or a 429 is not "told" (night review, 2026-09-27).
        .then(async (res) => {
          const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
          if (res.ok && body.ok === true) sent++;
        })
        .catch(() => {}),
    ),
  );
  return sent;
}

export type ChatApp = 'telegram' | 'discord' | 'slack';
export interface OwnerRoute { via: string; kind: ChatApp; to: string }
export interface OwnerChatDeps {
  store: Store;
  secrets: SecretStore;
  /** The connector's direct message, for the apps that have one. */
  dmFor(kind: 'discord' | 'slack'): ((secret: string, userId: string, text: string) => Promise<boolean>) | undefined;
  fetchImpl?: typeof fetch;
}

/**
 * The ways a message can reach this owner personally, best first: from their
 * Hatchabot agent's bot, then from `agentId`'s own; on each, Telegram (their
 * known id), Discord, Slack (their linked id there). Never a member's chat.
 * Empty: no chat app reaches them, and the page must say so where an alarm is set.
 */
export function ownerChatRoutes(deps: OwnerChatDeps, ownerId: string, agentId?: string): OwnerRoute[] {
  const { store } = deps;
  const manager = store.listAllActiveAgents().find((a) => a.ownerId === ownerId && a.ops);
  const telegram = store.knownChannelUserId(ownerId);
  const routes: OwnerRoute[] = [];
  for (const via of new Set([manager?.id, agentId])) {
    if (!via) continue;
    if (telegram && store.getChannelForAgent(via, 'telegram')) routes.push({ via, kind: 'telegram', to: telegram });
    const ids = store.memberIdentities(via, ownerId);
    for (const kind of ['discord', 'slack'] as const) {
      const to = ids[kind];
      if (to && store.getChannelForAgent(via, kind) && deps.dmFor(kind)) routes.push({ via, kind, to });
    }
  }
  return routes;
}

/**
 * Tell the owner something (a budget, a spike, a loop) by the first route that
 * takes it. True only when a chat app accepted it: the caller keeps it due
 * otherwise. Telegram alone left an owner on Discord or Slack unwarned (HB-0403).
 */
export async function tellOwner(deps: OwnerChatDeps, ownerId: string, agentId: string, text: string): Promise<boolean> {
  for (const r of ownerChatRoutes(deps, ownerId, agentId)) {
    if (r.kind === 'telegram') {
      const opts = { chatIds: [r.to], ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) };
      if ((await notifyAgentChat(deps.store, deps.secrets, r.via, text, opts).catch(() => 0)) > 0) return true;
      continue;
    }
    const row = deps.store.getChannelForAgent(r.via, r.kind);
    const secret = row && await deps.secrets.get(row.secretRef).catch(() => undefined);
    if (secret && await deps.dmFor(r.kind)?.(secret, r.to, text).catch(() => false)) return true;
  }
  return false;
}
