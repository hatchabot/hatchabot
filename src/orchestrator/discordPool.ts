/**
 * Spare Discord bots: parked tokens, ready for the next agent.
 *
 * Making a Discord bot is a manual trip through the developer portal, and a
 * bot has an identity people already know (its name, the servers it is in).
 * Until now removing Discord from an agent threw the token away, so moving a
 * bot to another agent meant Reset Token and paste again. A parked bot keeps
 * its token (under `discord-pool/<applicationId>`), its servers and its
 * warnings, and an agent's Set up… offers it before asking for a token.
 * Parked under the agent's owner unless donated to the house (owner_id null),
 * like the Telegram pool (Chris, 2026-09-25).
 */
import type { Channel } from '../domain/types.js';
import type { SecretStore } from '../secrets/secretStore.js';
import type { Store } from '../store/store.js';

export const discordPoolRef = (applicationId: string) => `discord-pool/${applicationId}`;

export interface DiscordBotRow {
  applicationId: string;
  botUserId?: string;
  botName?: string;
  secretRef: string;
  /** null = shared with everyone on this machine. */
  ownerId: string | null;
  servers: Array<{ id: string; name: string }>;
  warnings: string[];
  addToServerUrl?: string;
  checkedAt?: string;
  addedAt: string;
  /** Whom the bot wrote to for its previous agent — told "this bot is now X" on reuse. */
  priorChatIds?: string[];
  /** The archived agent this bot is kept for: restore takes it back unless someone else did. */
  archivedFor?: string;
}

/**
 * Park an agent's Discord bot: its token moves from the agent's secret to the
 * pool's, and the row remembers what the last check knew. Best-effort by
 * contract — a caller that cannot park still removes the channel — but a
 * failure is thrown so the caller can fall back to deleting the token.
 */
export async function parkDiscordBot(
  deps: { store: Store; secrets: SecretStore },
  ownerId: string,
  row: Channel,
  opts: { archivedFor?: string } = {},
): Promise<DiscordBotRow> {
  const st = (row.settings ?? {}) as Record<string, unknown>;
  // Whom it served: the people linked to the departing agent on Discord, so
  // the next agent's lease can mark the seam for them (Telegram's rule).
  const priorChatIds = deps.store
    .listMemberships(row.agentId)
    .filter((m) => m.status === 'active')
    .map((m) => deps.store.memberIdentities(row.agentId, m.userId).discord)
    .filter((id): id is string => !!id)
    .slice(0, 64);
  const token = await deps.secrets.get(row.secretRef);
  const ref = discordPoolRef(row.accountId);
  await deps.secrets.put(ref, token);
  // Taken from the shared pool → returned to it. Without this, a house bot
  // became the private bot of whoever used it last (2026-09-25).
  const fromShared = st.pooledShared === true;
  const parked: DiscordBotRow = {
    applicationId: row.accountId,
    botUserId: typeof st.botUserId === 'string' ? st.botUserId : undefined,
    botName: typeof st.botName === 'string' ? st.botName : undefined,
    secretRef: ref,
    ownerId: fromShared ? null : ownerId,
    servers: Array.isArray(st.servers) ? (st.servers as DiscordBotRow['servers']) : [],
    warnings: Array.isArray(st.warnings) ? (st.warnings as string[]) : [],
    addToServerUrl: typeof st.addToServerUrl === 'string' ? st.addToServerUrl : undefined,
    checkedAt: typeof st.checkedAt === 'string' ? st.checkedAt : undefined,
    addedAt: new Date().toISOString(),
    priorChatIds,
    archivedFor: opts.archivedFor,
  };
  deps.store.upsertDiscordBot(parked);
  if (row.secretRef !== ref) await deps.secrets.delete(row.secretRef).catch(() => {});
  return parked;
}

/** What the app may see of a parked bot: never the token. */
export function publicDiscordBot(b: DiscordBotRow, viewerId: string) {
  return {
    applicationId: b.applicationId,
    botName: b.botName,
    servers: b.servers,
    warnings: b.warnings,
    addToServerUrl: b.addToServerUrl,
    checkedAt: b.checkedAt,
    addedAt: b.addedAt,
    shared: b.ownerId === null,
    mine: b.ownerId === viewerId,
  };
}
