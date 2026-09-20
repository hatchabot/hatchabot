import type Database from 'better-sqlite3';
import type { SecretStore } from '../secrets/secretStore.js';
import { setTelegramDisplayName } from './telegramName.js';
import type {
  ChannelProvisioner,
  ChannelProvisionRequest,
  ProvisionedChannel,
  ReleaseOptions,
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
/**
 * How long a released bot keeps the departing agent's name before the sweep
 * changes it to the idle one. Long enough that an archive→restore round trip
 * (or a rollback) costs no rename at all; short enough that a bot genuinely
 * left in the pool isn't advertising a dead agent for long.
 */
const IDLE_RENAME_DELAY_MS = Number(process.env.HATCHABOT_IDLE_RENAME_MS ?? 15 * 60_000);

/** Telegram errors that no retry can fix: the token is not a token any more. */
export function permanentTelegramFailure(error: unknown): boolean {
  return /unauthorized|bot was deleted|not found|invalid token/i.test(String(error ?? ''));
}

export class TelegramPoolProvisioner implements ChannelProvisioner {
  readonly kind = 'telegram' as const;

  constructor(
    private readonly db: Database.Database,
    private readonly secrets: SecretStore,
    private readonly opts: {
      fetchImpl?: typeof fetch;
      /** Rename outcomes go here — see #applyDisplayName for why. */
      log?: (event: string, detail: Record<string, unknown>) => void;
      /** Retry waits for renames; tests pass zeros. */
      renameBackoffMs?: readonly number[];
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
    // Hatchabot user; NULL = a "house bot" the admin explicitly shares.
    try {
      this.db.exec(`ALTER TABLE telegram_pool ADD COLUMN owner_id TEXT`);
    } catch (err) {
      if (!/duplicate column/i.test(String(err))) throw err;
    }
    // A rename that failed leaves the bot wearing the WRONG name — the last
    // agent's, or "unassigned" — and nothing used to remember that it should
    // have changed, so it stayed wrong until the next rebuild. Parking the
    // name we wanted turns that into something a timer can finish.
    try {
      this.db.exec(`ALTER TABLE telegram_pool ADD COLUMN desired_name TEXT`);
    } catch (err) {
      if (!/duplicate column/i.test(String(err))) throw err;
    }
    // Parked bots named before the rename keep asking Telegram for the old
    // brand until their desired name is corrected; the repair loop then
    // renames them at the next allowed moment.
    this.db.exec(`UPDATE telegram_pool SET desired_name = replace(desired_name, 'AgentClaw', 'Hatchabot') WHERE desired_name LIKE '%AgentClaw%'`);
    // Telegram rate-limits setMyName by HOURS (observed: retry_after 11942s —
    // 3h19m). Retrying every two minutes against that is pointless and rude, so
    // the deadline it hands back is stored and respected.
    try {
      this.db.exec(`ALTER TABLE telegram_pool ADD COLUMN rename_after TEXT`);
    } catch (err) {
      if (!/duplicate column/i.test(String(err))) throw err;
    }
    // When a rename actually landed. A rename can be pending for hours, so the
    // moment it succeeds is worth reporting — otherwise the only signal is a
    // warning quietly disappearing, which reads like it was never real.
    try {
      this.db.exec(`ALTER TABLE telegram_pool ADD COLUMN renamed_at TEXT`);
    } catch (err) {
      if (!/duplicate column/i.test(String(err))) throw err;
    }
    // Who had chatted with this bot, captured AT RELEASE (JSON array of
    // Telegram user ids). The re-lease announcement used to look prior
    // chatters up through the departed agent's membership/channel rows — but
    // delete scrubs memberships and archive unlinks the channel, so by lease
    // time the list was empty and nobody learned the bot had a new life
    // (Chris found his recycled bot buried in Telegram's Archived folder).
    try {
      this.db.exec(`ALTER TABLE telegram_pool ADD COLUMN prior_chat_ids TEXT`);
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

  /**
   * A rename Telegram has not accepted yet, if any — the name the bot SHOULD
   * carry and when we may next try. Telegram's setMyName quota is measured in
   * hours, so this window is long enough that the owner deserves to be told
   * rather than left wondering why the chat header is wrong.
   */
  pendingName(accountId: string): { name: string; retryAt?: string } | undefined {
    const row = this.db
      .prepare(`SELECT desired_name, rename_after FROM telegram_pool WHERE username = ? COLLATE NOCASE`)
      .get(accountId) as { desired_name: string | null; rename_after: string | null } | undefined;
    if (!row?.desired_name) return undefined;
    return { name: row.desired_name, ...(row.rename_after ? { retryAt: row.rename_after } : {}) };
  }

  /** The most recent rename that Telegram actually accepted, if any. */
  lastRenamed(accountId: string): { name: string; at: string } | undefined {
    const row = this.db
      .prepare(`SELECT renamed_at FROM telegram_pool WHERE username = ? COLLATE NOCASE`)
      .get(accountId) as { renamed_at: string | null } | undefined;
    return row?.renamed_at ? { name: accountId, at: row.renamed_at } : undefined;
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
    // Prefer a bot we can still RENAME. Telegram's setMyName quota is per bot
    // and measured in hours, so a bot that was just renamed cannot take the new
    // agent's name — and a bot serving "Tax Advisor" while Telegram still calls
    // it "Condo Adviser" is worse than a bot with a plain name. When every free
    // bot is rate-limited this changes nothing; there is simply no better pick.
    const free = this.db
      .prepare(
        `SELECT username, secret_ref FROM telegram_pool
         WHERE leased_to IS NULL AND (owner_id IS NULL OR owner_id = ?)
         ORDER BY (rename_after IS NOT NULL AND rename_after > ?) ASC,
                  (owner_id IS NULL) ASC, username LIMIT 1`,
      )
      .get(req.ownerId ?? '', new Date().toISOString()) as
      | { username: string; secret_ref: string }
      | undefined;
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
    this.#park(free.username, req.agentName, 0);
    await this.#applyDisplayName(free.secret_ref, free.username, req.agentName);
    // A recycled bot may still be sitting in someone's Telegram list with the
    // previous agent's conversation above. We can't clear that (a bot can only
    // delete its own recent messages, and chats are per-user), so mark the seam
    // for anyone who returns to it.
    await this.#announceReassignment(free.secret_ref, free.username, req.agentName);
    // And shed the previous life's API-settable surface (description, command
    // menu) — BotFather-only settings survive; the Group-chats panel reports
    // those live via getMe.
    await this.#resetBotSurface(free.secret_ref);

    return this.#toChannel(free.username, free.secret_ref);
  }

  /**
   * Point the bot's display name at `name`, and SAY WHAT HAPPENED. This was
   * silent, and the day a lease left a bot still calling itself
   * "Hatchabot (unassigned)" there was nothing in the log to say whether the
   * call had failed or never been made. Still never throws: a rename is
   * cosmetic and must not cost anyone their agent.
   */
  /** Record the name this bot SHOULD have, and the earliest we may try. */
  #park(username: string, name: string, delayMs: number): void {
    this.db
      .prepare(`UPDATE telegram_pool SET desired_name = ?, rename_after = ? WHERE username = ? COLLATE NOCASE`)
      .run(name, new Date(Date.now() + delayMs).toISOString(), username);
  }

  async #applyDisplayName(secretRef: string, username: string, name: string): Promise<void> {
    let res: { ok: boolean; error?: string; retryAfter?: number };
    try {
      const token = await this.secrets.get(secretRef);
      // getMe is cheap and NOT rate-limited the way setMyName is, so ask before
      // spending a rename. After a deferred release this is usually a hit: the
      // bot still carries the very name we want, and the round trip costs zero
      // of the quota.
      const fetchImpl = this.opts.fetchImpl ?? fetch;
      const me = (await fetchImpl(`https://api.telegram.org/bot${token}/getMe`, {
        signal: AbortSignal.timeout(5000),
      })
        .then((r) => r.json())
        .catch(() => null)) as { result?: { first_name?: string } } | null;
      if (me?.result?.first_name === name.trim()) {
        this.opts.log?.('channel.named', { username, name, ok: true, skipped: 'already correct' });
        this.#clearParked(username);
        return;
      }
      res = await setTelegramDisplayName(token, name, fetchImpl, this.opts.renameBackoffMs);
    } catch (err) {
      res = { ok: false, error: String(err) };
    }
    this.opts.log?.('channel.named', { username, name, ...res });
    if (res.ok) {
      this.#clearParked(username);
      this.db
        .prepare(`UPDATE telegram_pool SET renamed_at = ? WHERE username = ? COLLATE NOCASE`)
        .run(new Date().toISOString(), username);
      return;
    }
    // A token Telegram no longer accepts is not a rate limit: the bot was
    // deleted or its token revoked at BotFather, and no amount of waiting
    // fixes it. Stop parking the name — one dead pool bot was renaming itself
    // every five minutes, forever (seen live 2026-09-19). The live census
    // (Settings → Telegram) is where a dead token gets dealt with.
    if (permanentTelegramFailure(res.error)) {
      this.opts.log?.('channel.name_abandoned', { username, name, error: String(res.error).slice(0, 120) });
      this.#clearParked(username);
      return;
    }
    // Keep the name parked, and respect the deadline Telegram gave us. Without
    // this the sweep retried a three-hour limit every two minutes.
    const waitMs = (res.retryAfter ?? 300) * 1000;
    this.#park(username, name, waitMs);
  }

  #clearParked(username: string): void {
    this.db
      .prepare(`UPDATE telegram_pool SET desired_name = NULL, rename_after = NULL WHERE username = ? COLLATE NOCASE`)
      .run(username);
  }

  /**
   * Finish renames that didn't land. Cheap by construction: only rows that
   * failed carry a desired_name, so a healthy pool does no work and makes no
   * Telegram calls. Called on a timer — the failure this exists for was a
   * transport error during provisioning, which the in-call retries can lose
   * if the whole window is bad.
   */
  async retryPendingNames(): Promise<number> {
    const rows = this.db
      .prepare(
        `SELECT username, secret_ref, desired_name FROM telegram_pool
         WHERE desired_name IS NOT NULL AND (rename_after IS NULL OR rename_after <= ?)`,
      )
      .all(new Date().toISOString()) as Array<{ username: string; secret_ref: string; desired_name: string }>;
    let fixed = 0;
    for (const r of rows) {
      await this.#applyDisplayName(r.secret_ref, r.username, r.desired_name);
      const still = this.db
        .prepare(`SELECT desired_name FROM telegram_pool WHERE username = ?`)
        .get(r.username) as { desired_name: string | null } | undefined;
      if (!still?.desired_name) fixed++;
    }
    return fixed;
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
   * stale history to disown. Recipients come from `prior_chat_ids`, captured at
   * RELEASE while the departed agent's rows still existed (the live
   * membership-join returned nothing by lease time: delete scrubs memberships,
   * archive unlinks the channel). The message also surfaces the chat out of
   * Telegram's Archived folder for anyone who hasn't muted it — the folder is
   * per-user client state no bot API can touch directly.
   */
  async #announceReassignment(secretRef: string, username: string, agentName: string): Promise<void> {
    try {
      const row = this.db
        .prepare(`SELECT prior_chat_ids FROM telegram_pool WHERE username = ? COLLATE NOCASE`)
        .get(username) as { prior_chat_ids?: string | null } | undefined;
      let prior: string[] = [];
      try {
        prior = JSON.parse(row?.prior_chat_ids ?? '[]');
      } catch { /* malformed → none */ }
      if (!prior.length) return; // fresh bot: nothing above to explain
      const token = await this.secrets.get(secretRef);
      // Telegram gives a bot no way to clear a conversation: deleteMessage(s)
      // only reaches messages under 48 hours old, and nothing resets a chat.
      // So the honest move is to say so and point at the one control the
      // PERSON has — clearing their own copy.
      const text =
        `— this bot is now "${agentName}" —\n\n` +
        'It has been reassigned to a different agent. Anything above this line ' +
        'was a previous agent and no longer applies.\n\n' +
        "Telegram doesn't let a bot delete an old conversation. If you'd rather " +
        'not keep it, open this chat\'s menu and choose Clear history — that ' +
        'removes your copy.\n\n' +
        'If you had archived this chat, this message just brought it back — ' +
        'unarchive it to keep the new agent handy.';
      // Sends run CONCURRENTLY: this is on the awaited lease/provision path,
      // and up to 64 sequential 5s-timeout sends could stall a rebuild for
      // minutes during a Telegram slowdown (audit 2026-09-06). Parallel bounds
      // the worst case to one timeout; each is already best-effort.
      const send = (this.opts.fetchImpl ?? fetch);
      await Promise.all(
        prior.filter((id) => /^\d{1,32}$/.test(id)).map((id) =>
          send(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: id, text }),
            signal: AbortSignal.timeout(5000),
          }).catch(() => {}),
        ),
      );
      // Consumed: the next release captures a fresh list for the next lease.
      this.db
        .prepare(`UPDATE telegram_pool SET prior_chat_ids = NULL WHERE username = ? COLLATE NOCASE`)
        .run(username);
    } catch {
      /* cosmetic — never blocks a lease */
    }
  }

  /**
   * Clear the per-bot state the Bot API CAN reset on a recycle: description,
   * short description, and the command menu — all set by (or for) the previous
   * agent and otherwise inherited by the next one. BotFather-only settings
   * (group privacy, inline mode) survive by Telegram's design; getMe reports
   * them and the Group-chats panel shows that state live.
   */
  async #resetBotSurface(secretRef: string): Promise<void> {
    try {
      const token = await this.secrets.get(secretRef);
      const f = this.opts.fetchImpl ?? fetch;
      // Concurrent, same lease-path reasoning as #announceReassignment.
      await Promise.all(([
        ['setMyDescription', { description: '' }],
        ['setMyShortDescription', { short_description: '' }],
        ['deleteMyCommands', {}],
      ] as const).map(([method, body]) =>
        f(`https://api.telegram.org/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {})));
    } catch {
      /* cosmetic — never blocks a lease */
    }
  }

  /** What an unleased pool bot calls itself — never a departed agent's name. */
  static readonly IDLE_NAME = 'Hatchabot (unassigned)';

  async release(accountId: string, opts: ReleaseOptions = {}): Promise<void> {
    const row = this.db
      .prepare(`SELECT secret_ref, leased_to FROM telegram_pool WHERE username = ? COLLATE NOCASE`)
      .get(accountId) as { secret_ref?: string; leased_to?: string } | undefined;

    // Whose members to say goodbye to. Usually the lease, but a PASTED bot is
    // parked in the pool just before release (delete and archive both do this,
    // so the token stays reusable) and has no lease to read — the caller names
    // the agent instead. Without this those members got no goodbye at all.
    const departing = opts.agentId ?? row?.leased_to;

    // Capture who had chatted with this bot NOW, while the departing agent's
    // membership rows still exist — the re-lease announcement reads this list
    // (delete scrubs memberships and archive unlinks the channel, so a lease-
    // time lookup finds nothing).
    if (departing) {
      try {
        const prior = (
          this.db
            .prepare(
              `SELECT DISTINCT channel_user_id AS id FROM memberships
                WHERE agent_id = ? AND channel_user_id IS NOT NULL`,
            )
            .all(departing) as Array<{ id: string }>
        ).map((r) => r.id).filter((id) => /^\d{1,32}$/.test(id)).slice(0, 64);
        if (prior.length) {
          this.db
            .prepare(`UPDATE telegram_pool SET prior_chat_ids = ? WHERE username = ? COLLATE NOCASE`)
            .run(JSON.stringify(prior), accountId);
        }
      } catch { /* no memberships table (isolated harness) → nothing to capture */ }
    }

    // The bot goes back in the pool. We do NOT delete the token — the bot still
    // exists on Telegram's side and can serve the next agent.
    this.db
      .prepare(`UPDATE telegram_pool SET leased_to = NULL, leased_at = NULL WHERE username = ? COLLATE NOCASE`)
      .run(accountId);

    if (!row?.secret_ref) return;
    // Say goodbye BEFORE renaming, while the bot still looks like the agent the
    // members knew. Telegram chats are per-user and a bot cannot clear history,
    // so the honest thing is to mark the end of the conversation: anything above
    // belongs to an agent that no longer has this bot, and if it comes back as
    // something else, that history is not its own.
    if (departing) await this.#farewell(row.secret_ref, departing, opts.reason ?? 'deleted');
    // The idle name is PARKED, not applied now. Renames are the scarce thing
    // here — Telegram grants roughly one per bot every few hours — and an
    // archive followed by a restore used to spend two of them: one to
    // "unassigned", one back to the same agent. That is how a live agent's bot
    // ended up called "Hatchabot (unassigned)" for three hours. Deferring means
    // a bot re-leased before the sweep runs spends NONE, while one that really
    // is sitting free still stops advertising a departed agent.
    this.#park(accountId, TelegramPoolProvisioner.IDLE_NAME, IDLE_RENAME_DELAY_MS);
  }

  /**
   * Final message to the departing agent's members. Best-effort by design.
   *
   * The two endings are genuinely different and must not be blurred. A deleted
   * agent is gone: nothing is coming back. An ARCHIVED one is intact — memory,
   * settings, everything — and only gave up its bot; when it returns it will
   * be on a DIFFERENT bot, because this one may be serving someone else by
   * then. That last part is the bit people need told, since a new bot cannot
   * message them first: somebody has to hand them the new link.
   */
  async #farewell(
    secretRef: string,
    agentId: string,
    reason: 'deleted' | 'archived' | 'detached',
  ): Promise<void> {
    try {
      const token = await this.secrets.get(secretRef);
      const ids = this.db
        .prepare(
          `SELECT channel_user_id AS id FROM memberships
           WHERE agent_id = ? AND status = 'active' AND channel_user_id IS NOT NULL`,
        )
        .all(agentId) as Array<{ id: string }>;
      const text =
        reason === 'archived'
          ? '— archived —\n\n' +
            'This agent has been put away for now. Nothing was lost: it keeps ' +
            'everything you taught it. It just gave up this bot so another ' +
            'agent could use it, so it will not reply here any more. If it is ' +
            'brought back it will be on a NEW bot — ask whoever runs it for the ' +
            'new link. This bot may start answering as a different agent.'
          : reason === 'detached'
          ? '— moved off Telegram —\n\n' +
            'This agent no longer uses Telegram; its owner talks to it in ' +
            'Hatchabot now. Nothing was lost, but it will not reply here any ' +
            'more. This bot may start answering as a different agent later.'
          : '— end of this agent —\n\n' +
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
