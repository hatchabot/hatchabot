import type Database from 'better-sqlite3';
import type { SecretStore } from '../secrets/secretStore.js';
import { setTelegramDisplayName } from './telegramName.js';
import type {
  ChannelProvisioner,
  ChannelProvisionRequest,
  ProvisionedChannel,
} from './channel.js';

/**
 * Telegram has no API for creating bots — BotFather is a bot you talk to as a
 * human, and the Bot API cannot mint new bots. So "the user never sees
 * BotFather" (§9.6 / §11.1.3) has to be bought some other way.
 *
 * This provisioner buys it with a **pre-minted pool**: bots are created by hand
 * in advance and leased to agents on demand. Fully within Telegram's ToS, and
 * from the user's side it is instant — tap +, and a real bot is already waiting.
 * The ceiling is however many bots we have minted, which is why
 * TelegramManualProvisioner exists as the unbounded fallback.
 */
export class TelegramPoolProvisioner implements ChannelProvisioner {
  readonly kind = 'telegram' as const;

  constructor(
    private readonly db: Database.Database,
    private readonly secrets: SecretStore,
    private readonly opts: {
      fetchImpl?: typeof fetch;
      /** Rename outcomes go here — see #applyDisplayName for why. */
      log?: (event: string, detail: Record<string, unknown>) => void;
    } = {},
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_pool (
        username TEXT PRIMARY KEY,
        secret_ref TEXT NOT NULL,
        leased_to TEXT,
        leased_at TEXT
      )
    `);
    // A bot token is PERSONALLY owned: whoever minted it at BotFather can
    // rename, revoke, or delete the bot at will — so another user's agent
    // must never silently build on it. owner_id scopes each pool bot to one
    // AgentClaw user; NULL = a "house bot" the admin explicitly shares.
    try {
      this.db.exec(`ALTER TABLE telegram_pool ADD COLUMN owner_id TEXT`);
    } catch (err) {
      if (!/duplicate column/i.test(String(err))) throw err;
    }
  }

  /**
   * Add a hand-minted bot. `ownerId` scopes who may lease it; null/undefined
   * = shared house bot (the admin script's default, and an explicit checkbox
   * in the app).
   */
  async addToPool(username: string, botToken: string, ownerId?: string | null): Promise<void> {
    username = username.toLowerCase(); // Telegram @handles are case-insensitive
    const secretRef = `telegram/bot/${username}`;
    await this.secrets.put(secretRef, botToken);
    this.db
      .prepare(
        `INSERT INTO telegram_pool (username, secret_ref, owner_id) VALUES (?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET secret_ref = excluded.secret_ref, owner_id = excluded.owner_id`,
      )
      .run(username, secretRef, ownerId ?? null);
  }

  /** True when this username came from the pool (vs a user-supplied bot).
   *  Case-insensitive: Telegram @handles are, and an adopt-sourced accountId
   *  differing only in case must not create a second row for the same bot
   *  (two rows → two leases → two pollers). */
  owns(username: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM telegram_pool WHERE username = ? COLLATE NOCASE`)
      .get(username);
  }

  /** Bots leasable BY THIS USER: their own plus shared house bots. Without an
   *  ownerId (admin script), counts everything unleased. */
  availableCount(ownerId?: string): number {
    const row = (ownerId === undefined
      ? this.db.prepare(`SELECT COUNT(*) AS n FROM telegram_pool WHERE leased_to IS NULL`).get()
      : this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM telegram_pool
             WHERE leased_to IS NULL AND (owner_id IS NULL OR owner_id = ?)`,
          )
          .get(ownerId)) as { n: number };
    return row.n;
  }

  /**
   * Remove an UNLEASED bot from the pool, scrubbing its stored token. A leased
   * bot is refused — it is some agent's live identity; delete that agent (or
   * let it release) first.
   */
  async removeFromPool(username: string): Promise<void> {
    const row = this.db
      .prepare(`SELECT username, secret_ref, leased_to FROM telegram_pool WHERE username = ? COLLATE NOCASE`)
      .get(username) as { username: string; secret_ref: string; leased_to: string | null } | undefined;
    if (!row) throw new Error(`@${username} is not in the pool.`);
    if (row.leased_to) throw new Error(`@${username} is leased to an agent — delete that agent first.`);
    await this.secrets.delete(row.secret_ref).catch(() => {});
    this.db.prepare(`DELETE FROM telegram_pool WHERE username = ?`).run(row.username);
  }

  /** Every pool bot with its lease state and token ref — for the bot audit. */
  list(): Array<{ username: string; secretRef: string; leasedTo?: string; ownerId?: string }> {
    return (
      this.db
        .prepare(`SELECT username, secret_ref, leased_to, owner_id FROM telegram_pool ORDER BY username`)
        .all() as Array<{ username: string; secret_ref: string; leased_to: string | null; owner_id: string | null }>
    ).map((r) => ({
      username: r.username,
      secretRef: r.secret_ref,
      leasedTo: r.leased_to ?? undefined,
      ownerId: r.owner_id ?? undefined,
    }));
  }

  async provision(req: ChannelProvisionRequest): Promise<ProvisionedChannel> {
    // Idempotent: a retry after a partial failure finds the existing lease.
    const existing = this.db
      .prepare(`SELECT username, secret_ref FROM telegram_pool WHERE leased_to = ?`)
      .get(req.agentId) as { username: string; secret_ref: string } | undefined;
    if (existing) return this.#toChannel(existing.username, existing.secret_ref);

    // Ownership scoping: a user leases only their OWN bots plus shared house
    // bots (owner_id NULL). Another person's token is never touched — its
    // minter can revoke it at BotFather any time, and only they should hold
    // that risk. Own bots first, so house stock is preserved for newcomers.
    const free = this.db
      .prepare(
        `SELECT username, secret_ref FROM telegram_pool
         WHERE leased_to IS NULL AND (owner_id IS NULL OR owner_id = ?)
         ORDER BY (owner_id IS NULL) ASC, username LIMIT 1`,
      )
      .get(req.ownerId ?? '') as { username: string; secret_ref: string } | undefined;
    if (!free) {
      throw new PoolExhaustedError();
    }

    const claimed = this.db
      .prepare(
        `UPDATE telegram_pool SET leased_to = ?, leased_at = ?
         WHERE username = ? AND leased_to IS NULL`,
      )
      .run(req.agentId, new Date().toISOString(), free.username);
    if (claimed.changes === 0) {
      // Lost a race with a concurrent provision — retry once.
      return this.provision(req);
    }

    // Pool bots are OURS, serving one agent after another — on lease, point
    // the bot's DISPLAY name at the agent it now serves so a recycled bot's
    // chat header reads correctly (the @username can't change via API).
    // Best-effort and bounded: a rename is cosmetic; Telegram rate-limits
    // setMyName, and neither a limit nor an outage may block provisioning.
    await this.#applyDisplayName(free.secret_ref, free.username, req.agentName);
    // A recycled bot may still be sitting in someone's Telegram list with the
    // previous agent's conversation above. We can't clear that (a bot can only
    // delete its own recent messages, and chats are per-user), so mark the seam
    // for anyone who returns to it.
    await this.#announceReassignment(free.secret_ref, free.username, req.agentName);

    return this.#toChannel(free.username, free.secret_ref);
  }

  /**
   * Point the bot's display name at `name`, and SAY WHAT HAPPENED. This was
   * silent, and the day a lease left a bot still calling itself
   * "AgentClaw (unassigned)" there was nothing in the log to say whether the
   * call had failed or never been made. Still never throws: a rename is
   * cosmetic and must not cost anyone their agent.
   */
  async #applyDisplayName(secretRef: string, username: string, name: string): Promise<void> {
    try {
      const token = await this.secrets.get(secretRef);
      const res = await setTelegramDisplayName(token, name, this.opts.fetchImpl ?? fetch);
      this.opts.log?.('channel.named', { username, name, ...res });
    } catch (err) {
      this.opts.log?.('channel.named', { username, name, ok: false, error: String(err) });
    }
  }

  /**
   * Re-apply the agent's name to a bot we already lease. Runs on rebuild, so a
   * rename that lost a race with Telegram's limiter heals itself instead of
   * leaving the bot mislabelled until the agent is deleted.
   */
  async syncDisplayName(accountId: string, agentName: string): Promise<void> {
    const row = this.db
      .prepare(`SELECT username, secret_ref FROM telegram_pool WHERE username = ? COLLATE NOCASE`)
      .get(accountId) as { username: string; secret_ref: string } | undefined;
    if (!row) return; // not ours — a hand-minted bot is the owner's to name
    await this.#applyDisplayName(row.secret_ref, row.username, agentName);
  }

  /**
   * Tell anyone who previously chatted with this bot that it now serves someone
   * else. Only fires for a bot that has served before — a never-used one has no
   * stale history to disown.
   */
  async #announceReassignment(secretRef: string, username: string, agentName: string): Promise<void> {
    try {
      const prior = this.db
        .prepare(
          `SELECT DISTINCT m.channel_user_id AS id FROM memberships m
             JOIN channels c ON c.agent_id = m.agent_id
            WHERE c.account_id = ? COLLATE NOCASE AND m.channel_user_id IS NOT NULL`,
        )
        .all(username) as Array<{ id: string }>;
      if (!prior.length) return; // fresh bot: nothing above to explain
      const token = await this.secrets.get(secretRef);
      const text =
        `— this bot is now "${agentName}" —\n\n` +
        'It has been reassigned to a different agent. Anything above this line ' +
        'was a previous agent and no longer applies.';
      for (const { id } of prior) {
        if (!/^\d{1,32}$/.test(id)) continue;
        await (this.opts.fetchImpl ?? fetch)(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: id, text }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      }
    } catch {
      /* cosmetic — never blocks a lease */
    }
  }

  /** What an unleased pool bot calls itself — never a departed agent's name. */
  static readonly IDLE_NAME = 'AgentClaw (unassigned)';

  async release(accountId: string): Promise<void> {
    const row = this.db
      .prepare(`SELECT secret_ref, leased_to FROM telegram_pool WHERE username = ? COLLATE NOCASE`)
      .get(accountId) as { secret_ref?: string; leased_to?: string } | undefined;

    // The bot goes back in the pool. We do NOT delete the token — the bot still
    // exists on Telegram's side and can serve the next agent.
    this.db
      .prepare(`UPDATE telegram_pool SET leased_to = NULL, leased_at = NULL WHERE username = ? COLLATE NOCASE`)
      .run(accountId);

    if (!row?.secret_ref) return;
    // Say goodbye BEFORE renaming, while the bot still looks like the agent the
    // members knew. Telegram chats are per-user and a bot cannot clear history,
    // so the honest thing is to mark the end of the conversation: anything above
    // belongs to an agent that no longer exists, and if this bot comes back as
    // something else, that history is not its own.
    if (row.leased_to) await this.#farewell(row.secret_ref, row.leased_to);
    // Then drop the old identity, so a bot sitting in the pool doesn't advertise
    // a deleted agent (a free bot was still calling itself "Julio & Mich").
    await this.#applyDisplayName(row.secret_ref, accountId, TelegramPoolProvisioner.IDLE_NAME);
  }

  /** Final message to the departing agent's members. Best-effort by design. */
  async #farewell(secretRef: string, agentId: string): Promise<void> {
    try {
      const token = await this.secrets.get(secretRef);
      const ids = this.db
        .prepare(
          `SELECT channel_user_id AS id FROM memberships
           WHERE agent_id = ? AND status = 'active' AND channel_user_id IS NOT NULL`,
        )
        .all(agentId) as Array<{ id: string }>;
      const text =
        '— end of this agent —\n\n' +
        'This agent has been removed, so it will not reply here any more. ' +
        'This bot may be reassigned to a different agent later; if it starts ' +
        'answering again, everything above belongs to the old one.';
      for (const { id } of ids) {
        if (!/^\d{1,32}$/.test(id)) continue;
        await (this.opts.fetchImpl ?? fetch)(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: id, text }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      }
    } catch {
      /* cosmetic — never blocks a release */
    }
  }

  #toChannel(username: string, secretRef: string): ProvisionedChannel {
    return {
      accountId: username,
      secretRef,
      deepLink: `https://t.me/${username}`,
    };
  }
}

export class PoolExhaustedError extends Error {
  readonly userMessage =
    'We are out of ready-made bots right now. You can connect your own in about a minute instead.';
  constructor() {
    super('Telegram bot pool exhausted');
    this.name = 'PoolExhaustedError';
  }
}
