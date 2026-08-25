import type Database from 'better-sqlite3';
import type { SecretStore } from '../secrets/secretStore.js';
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
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_pool (
        username TEXT PRIMARY KEY,
        secret_ref TEXT NOT NULL,
        leased_to TEXT,
        leased_at TEXT
      )
    `);
  }

  /** Adds a hand-minted bot to the pool. Called by an admin script, not the app. */
  async addToPool(username: string, botToken: string): Promise<void> {
    const secretRef = `telegram/bot/${username}`;
    await this.secrets.put(secretRef, botToken);
    this.db
      .prepare(
        `INSERT INTO telegram_pool (username, secret_ref) VALUES (?, ?)
         ON CONFLICT(username) DO UPDATE SET secret_ref = excluded.secret_ref`,
      )
      .run(username, secretRef);
  }

  /** True when this username came from the pool (vs a user-supplied bot). */
  owns(username: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM telegram_pool WHERE username = ?`)
      .get(username);
  }

  availableCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM telegram_pool WHERE leased_to IS NULL`)
      .get() as { n: number };
    return row.n;
  }

  /**
   * Remove an UNLEASED bot from the pool, scrubbing its stored token. A leased
   * bot is refused — it is some agent's live identity; delete that agent (or
   * let it release) first.
   */
  async removeFromPool(username: string): Promise<void> {
    const row = this.db
      .prepare(`SELECT secret_ref, leased_to FROM telegram_pool WHERE username = ?`)
      .get(username) as { secret_ref: string; leased_to: string | null } | undefined;
    if (!row) throw new Error(`@${username} is not in the pool.`);
    if (row.leased_to) throw new Error(`@${username} is leased to an agent — delete that agent first.`);
    await this.secrets.delete(row.secret_ref).catch(() => {});
    this.db.prepare(`DELETE FROM telegram_pool WHERE username = ?`).run(username);
  }

  /** Every pool bot with its lease state and token ref — for the bot audit. */
  list(): Array<{ username: string; secretRef: string; leasedTo?: string }> {
    return (
      this.db
        .prepare(`SELECT username, secret_ref, leased_to FROM telegram_pool ORDER BY username`)
        .all() as Array<{ username: string; secret_ref: string; leased_to: string | null }>
    ).map((r) => ({ username: r.username, secretRef: r.secret_ref, leasedTo: r.leased_to ?? undefined }));
  }

  async provision(req: ChannelProvisionRequest): Promise<ProvisionedChannel> {
    // Idempotent: a retry after a partial failure finds the existing lease.
    const existing = this.db
      .prepare(`SELECT username, secret_ref FROM telegram_pool WHERE leased_to = ?`)
      .get(req.agentId) as { username: string; secret_ref: string } | undefined;
    if (existing) return this.#toChannel(existing.username, existing.secret_ref);

    const free = this.db
      .prepare(`SELECT username, secret_ref FROM telegram_pool WHERE leased_to IS NULL LIMIT 1`)
      .get() as { username: string; secret_ref: string } | undefined;
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

    return this.#toChannel(free.username, free.secret_ref);
  }

  async release(accountId: string): Promise<void> {
    // The bot goes back in the pool. We do NOT delete the token — the bot still
    // exists on Telegram's side and can serve the next agent.
    this.db
      .prepare(`UPDATE telegram_pool SET leased_to = NULL, leased_at = NULL WHERE username = ?`)
      .run(accountId);
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
