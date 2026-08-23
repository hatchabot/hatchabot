/**
 * A Telegram-bot census for one AgentClaw install. Telegram has no API to list
 * the bots an account owns — @BotFather is the only complete list — so the way
 * to find abandoned bots is to enumerate the ones we KNOW we're using and let
 * the owner subtract that from @BotFather's /mybots. This builds the "in use"
 * side of that subtraction, classified so idle slots stand out.
 */
import { botPollState } from './adopt.js';
import type { SecretStore } from '../secrets/secretStore.js';
import type { Store } from '../store/store.js';
import type { TelegramPoolProvisioner } from '../channels/telegramPool.js';

export type BotClass =
  | 'in-use' // a RUNNING agent owns it — keep
  | 'reclaimable' // a stopped/failed agent, or a free/orphaned pool bot — a slot doing nothing
  | 'dead'; // Telegram no longer recognises the token — the slot is already gone

export interface BotRow {
  username: string;
  source: 'agent' | 'pool';
  agentId?: string;
  agentName?: string;
  /** owning agent's lifecycle state, when source === 'agent' */
  state?: string;
  pooled: boolean;
  cls: BotClass;
  /** live getMe result, present only when the audit ran with live checks */
  valid?: boolean;
  /** live poll probe, only run for idle bots so a live poller is never disturbed */
  polling?: 'busy' | 'quiet' | 'unknown';
}

export interface HostBots {
  host: string;
  bots: BotRow[];
  /** whether a management bot has been set up here (its token lives outside the DB) */
  mgmtBotConfigured: boolean;
  /** set instead of bots when a peer couldn't be reached */
  error?: string;
}

async function getMe(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; username?: string }> {
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`);
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { username?: string } };
    return body?.ok ? { ok: true, username: body.result?.username } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export interface AuditDeps {
  store: Store;
  secrets: SecretStore;
  pool: TelegramPoolProvisioner;
  hostName: string;
  fetchImpl?: typeof fetch;
}

/**
 * Census this install's bots for one owner. With `live`, each bot is checked
 * against Telegram: getMe for validity (read-only, always safe) and — for idle
 * bots only — a poll probe, so a RUNNING agent's real poller is never nudged.
 */
export async function auditBots(
  deps: AuditDeps,
  ownerId: string,
  opts: { live?: boolean } = {},
): Promise<HostBots> {
  const { store, secrets, pool } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const rows: BotRow[] = [];
  const seen = new Set<string>();

  // Machine-level census: every bot on this install regardless of which owner's
  // agent holds it — the point is to find slots to reclaim across the whole box.
  for (const agent of store.listAllActiveAgents()) {
    const ch = store.getChannelForAgent(agent.id);
    if (!ch || ch.kind !== 'telegram') continue;
    seen.add(ch.accountId);
    const row: BotRow = {
      username: ch.accountId,
      source: 'agent',
      agentId: agent.id,
      agentName: agent.name,
      state: agent.state,
      pooled: pool.owns(ch.accountId),
      cls: agent.state === 'RUNNING' ? 'in-use' : 'reclaimable',
    };
    if (opts.live) await checkLive(row, ch.secretRef);
    rows.push(row);
  }

  // Pool bots not already shown via an agent: free ones (a slot held for later)
  // and any leased to an agent that no longer exists (orphaned).
  for (const p of pool.list()) {
    if (seen.has(p.username)) continue;
    const row: BotRow = {
      username: p.username,
      source: 'pool',
      pooled: true,
      cls: 'reclaimable',
    };
    if (opts.live) await checkLive(row, p.secretRef);
    rows.push(row);
  }

  const mgmtBotConfigured = store.listCliTokens(ownerId).some((t) => t.label === 'mgmt-bot');
  return { host: deps.hostName, bots: rows, mgmtBotConfigured };

  async function checkLive(row: BotRow, secretRef: string): Promise<void> {
    let token: string | undefined;
    try {
      token = await secrets.get(secretRef);
    } catch {
      /* token unreadable — treat as unknown validity below */
    }
    if (!token) {
      row.valid = false;
      row.cls = 'dead';
      return;
    }
    const me = await getMe(token, fetchImpl);
    row.valid = me.ok;
    if (!me.ok) {
      row.cls = 'dead';
      return;
    }
    // Only probe idle bots — never risk a transient 409 on a live poller.
    if (row.cls !== 'in-use') row.polling = await botPollState(token, fetchImpl);
  }
}
