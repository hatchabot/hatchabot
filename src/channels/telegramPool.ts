import type Database from 'better-sqlite3';
import type { SecretStore } from '../secrets/secretStore.js';
import { setTelegramDisplayName } from './telegramName.js';
import { keyedLock } from '../util/queues.js';
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

/**
 * How long a farewell may spend waiting out Telegram's rate limit, in all.
 * Release is awaited by delete and archive, so the wait is bounded; members
 * it could not reach are counted in the log.
 */
const FAREWELL_WAIT_MS = 30_000;

/**
 * How long a farewell may take in all, its sends included. Each send may
 * take five seconds, one member after another: with Telegram timing out, 64
 * members held a delete or archive (and its lifecycle lock) for over five
 * minutes, and a longer list had no bound at all (HB-0989). Members it has
 * no time left for are counted as not told.
 */
const FAREWELL_DEADLINE_MS = 60_000;

/**
 * How long a lease waits, in all, for a spare held only while its farewell
 * goes out: the farewell's own bound, and a little for its token's read.
 * Not waited for, a create, an attach or a Change bot in that window was
 * told there were no spare bots, or went on web-only (HB-1266).
 */
const GOODBYE_WAIT_MS = FAREWELL_DEADLINE_MS + 10_000;

/**
 * How often a lease looks again for a bot this process let go of while the
 * channel row of the agent it left still names it: the release's caller
 * removes that row a moment after the release (a detach, a delete, an
 * archive), and the bot is a spare from then (#releasedFrom).
 */
const ROW_GONE_POLL_MS = 50;

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
      /** The wait a farewell honours on a 429; tests pass an instant one. */
      sleep?: (ms: number) => Promise<void>;
      /** The clock a farewell's deadline is read on; tests pass a fake one. */
      now?: () => number;
      /** How long a lease waits for a bot saying goodbye (GOODBYE_WAIT_MS); tests pass a short one. */
      goodbyeWaitMs?: number;
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
    // Whom the last release's farewell has told, and for which agent and
    // why (JSON {agent, reason, ids}), written as each one is told. A
    // release run again for the same agent (Delete pressed again after a
    // restart cut the first one off) tells only the rest: it told them all
    // a second time (HB-1267). A table the pool makes is not one the
    // numbered schema steps can reach (src/store/schemaVersion.ts), so its
    // column is added here, as the ones above are.
    try {
      this.db.exec(`ALTER TABLE telegram_pool ADD COLUMN farewell_told TEXT`);
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
    const asGiven = username;
    username = username.toLowerCase(); // Telegram @handles are case-insensitive
    const secretRef = `telegram/bot/${username}`;
    await this.secrets.put(secretRef, botToken);
    // A pasted bot's token was stored under the case getMe gave (@MyBot);
    // parked here under the lower-case ref, that first copy outlived every
    // removal and showed up as an orphan anyone on the box could reveal
    // (night review, 2026-09-27). One copy only.
    if (asGiven !== username) await this.secrets.delete(`telegram/bot/${asGiven}`).catch(() => {});
    this.db
      .prepare(
        `INSERT INTO telegram_pool (username, secret_ref, owner_id) VALUES (?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET secret_ref = excluded.secret_ref, owner_id = excluded.owner_id`,
      )
      .run(username, secretRef, ownerId ?? null);
    this.#aSpareFreed();
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
  /** Whose pool bot this is: an account id, null for a shared house bot, undefined when it is not a pool bot. */
  ownerOf(username: string): string | null | undefined {
    const r = this.db.prepare(`SELECT owner_id FROM telegram_pool WHERE username = ? COLLATE NOCASE`).get(username) as { owner_id: string | null } | undefined;
    return r ? r.owner_id : undefined;
  }
  owns(username: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM telegram_pool WHERE username = ? COLLATE NOCASE`)
      .get(username);
  }

  /** Bots leasable BY THIS USER: their own plus shared house bots. Without an
   *  ownerId (admin script), counts everything unleased. A bot still saying
   *  goodbye is counted: a lease waits for its farewell (HB-1266). One a
   *  live agent's channel row names is not, unless this process let it go
   *  from that agent and the row is about to go (#spareState). */
  availableCount(ownerId?: string, ownOnly = false): number {
    const connected = this.#connectedTo();
    const rows = (ownerId === undefined
      ? this.db.prepare(`SELECT username, ${connected} AS connected_to FROM telegram_pool WHERE leased_to IS NULL`).all()
      : ownOnly
        ? this.db.prepare(`SELECT username, ${connected} AS connected_to FROM telegram_pool WHERE leased_to IS NULL AND owner_id = ?`).all(ownerId)
        : this.db
          .prepare(
            `SELECT username, ${connected} AS connected_to FROM telegram_pool
             WHERE leased_to IS NULL AND (owner_id IS NULL OR owner_id = ?)`,
          )
          .all(ownerId)) as Array<{ username: string; connected_to: string | null }>;
    return rows.filter((r) => this.#spareState(r) !== 'connected').length;
  }

  /**
   * SQL for the live agent whose channel row names this pool bot
   * (`telegram_pool.username`), or NULL: the same rule as the clash check
   * (Store.findAgentUsingAccount). Such a bot is that agent's live identity,
   * free in the pool only because a detach, a delete or an archive let it go
   * and a restart cut it off before its row went: leased again, the lease
   * renamed it, told its people "this bot is now …" and was then refused as
   * "already belongs to"; and Remove deleted the token the agent runs on.
   * A database with no channels table (a harness of the pool alone) has
   * none.
   */
  #connectedTo(): string {
    if (!this.#hasChannels) {
      const n = (this.db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('channels', 'agents')`).get() as { n: number }).n;
      if (n < 2) return 'NULL';
      this.#hasChannels = true;
    }
    return `(SELECT c.agent_id FROM channels c JOIN agents a ON a.id = c.agent_id
              WHERE c.kind = 'telegram' AND c.account_id = telegram_pool.username COLLATE NOCASE AND a.state != 'DELETED' LIMIT 1)`;
  }
  #hasChannels = false;

  /**
   * An unleased pool bot, as a lease sees it: free; going (saying goodbye
   * here, or let go here from the agent whose row still names it, which
   * its release's caller is about to remove), so worth waiting for; or
   * connected, a live agent's bot, never offered.
   */
  #spareState(r: { username: string; connected_to: string | null }): 'free' | 'going' | 'connected' {
    const key = r.username.toLowerCase();
    if (this.#sayingGoodbye.has(key)) return 'going';
    if (!r.connected_to) return 'free';
    const from = this.#releasedFrom.get(key);
    return from?.agent === r.connected_to && Date.now() - from.at < (this.opts.goodbyeWaitMs ?? GOODBYE_WAIT_MS) ? 'going' : 'connected';
  }

  /**
   * Which agent this process let each pool bot go from (by lower-cased
   * @handle), and when (the let-go, or its farewell's end), until the bot is
   * leased again or removed. The release's caller removes that agent's
   * channel row a moment after: until then a lease waits for the row to go
   * rather than call the bot connected. Only for as long as a lease waits
   * (GOODBYE_WAIT_MS): a caller that failed between the release and the
   * row left the bot "going" for as long as the process ran, and every
   * lease that found only it waited its whole bound. A restart loses it,
   * and the bot is then connected, as the row says, until that Detach or
   * Delete is run again.
   */
  readonly #releasedFrom = new Map<string, { agent: string; at: number }>();

  /**
   * The bots saying goodbye for the agent they served, by lower-cased
   * @handle: free, but not leased until the farewell is out. Leased again
   * first, the new agent's "this bot is now …" came before the farewell,
   * which then told the same chats it would not reply any more (HB-1048).
   * Held here, not on the lease: held on the lease, a restart part way left
   * the bot the departing agent's, and an archive's finish read that as a bot
   * never given back and undid the archive. A new process has no farewell
   * under way, and the bot is free as the release left it.
   *
   * A count per bot, not a mark: two releases of one bot at once (two
   * agents' rows naming it) each hold it, and the first to finish let go of
   * the other's hold too, so the bot was leased while a farewell was still
   * out (HB-1265). `over` settles when the last of them ends: a lease that
   * finds only bots saying goodbye waits for it (HB-1266).
   */
  readonly #sayingGoodbye = new Map<string, { holds: number; over: Promise<void>; end: () => void }>();

  /** Hold this bot while a farewell goes out; what it returns lets go of this hold (once). */
  #holdForGoodbye(key: string): () => void {
    let held = this.#sayingGoodbye.get(key);
    if (!held) {
      let end!: () => void;
      const over = new Promise<void>((r) => { end = r; });
      held = { holds: 0, over, end };
      this.#sayingGoodbye.set(key, held);
    }
    held.holds++;
    const mine = held;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--mine.holds > 0) return;
      if (this.#sayingGoodbye.get(key) === mine) this.#sayingGoodbye.delete(key);
      mine.end();
      this.#aSpareFreed();
    };
  }

  /**
   * Settles when a bot may have become a spare (added, given back unused,
   * let go, its farewell out): a lease waiting for a bot on its way out
   * looks again then, and takes whichever is free first (HB-1266 review:
   * one added during the wait was not looked at).
   */
  #spareFreed = signal();

  #aSpareFreed(): void {
    const was = this.#spareFreed;
    this.#spareFreed = signal();
    was.tell();
  }

  /**
   * Remove an UNLEASED bot from the pool, scrubbing its stored token. A leased
   * bot is refused — it is some agent's live identity; delete that agent (or
   * let it release) first. `leasedTo` also takes it while leased to that one
   * agent: a bot leaving with it (a move, a downloaded copy) goes in one
   * statement, where a release and then a remove let a lease take it between
   * the two (HB-0065).
   */
  async removeFromPool(username: string, opts: { leasedTo?: string } = {}): Promise<void> {
    const row = this.db
      .prepare(`SELECT username, secret_ref, leased_to FROM telegram_pool WHERE username = ? COLLATE NOCASE`)
      .get(username) as { username: string; secret_ref: string; leased_to: string | null } | undefined;
    if (!row) throw new Error(`@${username} is not in the pool.`);
    if (row.leased_to && row.leased_to !== opts.leasedTo) throw new Error(`@${username} is leased to an agent — delete that agent first.`);
    // Free in the pool, but a live agent's bot still (a detach or a delete a
    // restart cut off): its token is the one that agent runs on.
    const on = (this.db.prepare(`SELECT ${this.#connectedTo()} AS connected_to FROM telegram_pool WHERE username = ?`).get(row.username) as { connected_to: string | null }).connected_to;
    if (on && on !== opts.leasedTo) throw new Error(`@${username} is still connected to an agent — detach it on that agent's card first.`);
    // The row goes first, and only while still unleased: a lease taken while the
    // secret store answered would have lost its bot (review R14, 2026-10-23).
    const gone = this.db.prepare(`DELETE FROM telegram_pool WHERE username = ? AND (leased_to IS NULL OR leased_to = ?)`).run(row.username, opts.leasedTo ?? null);
    if (gone.changes === 0) throw new Error(`@${username} was leased to an agent just now — delete that agent first.`);
    this.#releasedFrom.delete(row.username.toLowerCase());
    await this.secrets.delete(row.secret_ref).catch(() => {});
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

  provision(req: ChannelProvisionRequest): Promise<ProvisionedChannel> {
    return this.#lease(req, Date.now() + (this.opts.goodbyeWaitMs ?? GOODBYE_WAIT_MS));
  }

  /** provision(), waiting until `waitUntil` at most for a bot saying goodbye. */
  async #lease(req: ChannelProvisionRequest, waitUntil: number): Promise<ProvisionedChannel> {
    // Idempotent: a retry after a partial failure finds the existing lease.
    const existing = this.db
      .prepare(`SELECT username, secret_ref FROM telegram_pool WHERE leased_to = ?`)
      .all(req.agentId) as Array<{ username: string; secret_ref: string }>;
    const excluded = new Set((req.exclude ?? []).map((u) => u.toLowerCase()));
    const kept = existing.find((r) => !excluded.has(r.username.toLowerCase()));
    if (kept) return this.#toChannel(kept.username, kept.secret_ref);

    // Ownership scoping: a user leases only their OWN bots plus shared house
    // bots (owner_id NULL). Another person's token is never touched — its
    // minter can revoke it at BotFather any time, and only they should hold
    // that risk. Own bots first, so house stock is preserved for newcomers.
    // Prefer a bot we can still RENAME. Telegram's setMyName quota is per bot
    // and measured in hours, so a bot that was just renamed cannot take the new
    // agent's name — and a bot serving "Budget Tracker" while Telegram still calls
    // it "HOA Helper" is worse than a bot with a plain name. When every free
    // bot is rate-limited this changes nothing; there is simply no better pick.
    // ownBotsOnly (Settings → Messaging → Telegram): the person asked never to put one of
    // their agents on a shared house bot, so only their own are offered.
    // A live agent's bot (its channel row names it) is never offered
    // (#connectedTo).
    const candidates = (
      this.db
        .prepare(
          `SELECT username, secret_ref, ${this.#connectedTo()} AS connected_to FROM telegram_pool
           WHERE leased_to IS NULL AND (${req.ownBotsOnly ? 'owner_id = ?' : 'owner_id IS NULL OR owner_id = ?'})
           ORDER BY (rename_after IS NOT NULL AND rename_after > ?) ASC,
                    (owner_id IS NULL) ASC, username`,
        )
        .all(req.ownerId ?? '', new Date().toISOString()) as Array<{ username: string; secret_ref: string; connected_to: string | null }>
    ).filter((r) => !excluded.has(r.username.toLowerCase()) && this.#spareState(r) !== 'connected');
    const free = candidates.find((r) => this.#spareState(r) === 'free');
    if (!free) {
      // Only bots on their way out (a farewell, or the row of the agent it
      // left): the first to be out is free, so wait for it, then look again
      // (another lease may take it first), rather than call the pool empty
      // (HB-1266). Bounded: a farewell is, in all. A row the release's
      // caller is about to remove is looked for every ROW_GONE_POLL_MS:
      // leased while it was there, the attach was told the bot "already
      // belongs to" the agent it left.
      const goodbyes = candidates.flatMap((r) => this.#sayingGoodbye.get(r.username.toLowerCase())?.over ?? []);
      const rowsToGo = candidates.some((r) => !this.#sayingGoodbye.has(r.username.toLowerCase()));
      // Any spare freed meanwhile (#spareFreed) is looked at too, and once
      // the time is up the pool is looked at once more, without waiting:
      // a spare that came in unannounced was not.
      const left = waitUntil - Date.now();
      if (candidates.length && left > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          ...goodbyes,
          this.#spareFreed.at,
          new Promise<void>((r) => {
            timer = setTimeout(r, rowsToGo ? Math.min(ROW_GONE_POLL_MS, left) : left);
            timer.unref?.();
          }),
        ]).finally(() => clearTimeout(timer));
        return this.#lease(req, waitUntil);
      }
      throw new PoolExhaustedError();
    }

    // A new life: whom the last one's farewell told is its own no more.
    const claimed = this.db
      .prepare(
        `UPDATE telegram_pool SET leased_to = ?, leased_at = ?, farewell_told = NULL
         WHERE username = ? AND leased_to IS NULL`,
      )
      .run(req.agentId, new Date().toISOString(), free.username);
    if (claimed.changes === 0) {
      // Lost a race with a concurrent provision — retry once.
      return this.#lease(req, waitUntil);
    }
    this.#releasedFrom.delete(free.username.toLowerCase());

    // Pool bots are OURS, serving one agent after another — on lease, point
    // the bot's DISPLAY name at the agent it now serves so a recycled bot's
    // chat header reads correctly (the @username can't change via API).
    // Best-effort and bounded: a rename is cosmetic; Telegram rate-limits
    // setMyName, and neither a limit nor an outage may block provisioning.
    // First, forget what was sent to the bot's previous life: Telegram keeps
    // unconfirmed updates for a day, and the new agent's gateway would read
    // them as messages to it (HB-0051).
    await this.#dropWaitingUpdates(free.secret_ref, free.username);
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
  /**
   * Record the name this bot SHOULD have, and the earliest we may try.
   * `whileFree`: only if no agent leases it, and no live agent's channel row
   * names it but `except`'s (the agent a release let it go from, whose row
   * goes next): the idle name queued on a live agent's bot renamed it
   * "unassigned" (#connectedTo).
   */
  #park(username: string, name: string, delayMs: number, onlyIf?: string, whileFree?: { except?: string }): void {
    const connected = whileFree ? this.#connectedTo() : 'NULL';
    this.db
      .prepare(`UPDATE telegram_pool SET desired_name = ?, rename_after = ? WHERE username = ? COLLATE NOCASE AND (? IS NULL OR desired_name IS ?)${whileFree ? ` AND leased_to IS NULL AND (${connected} IS NULL OR ${connected} IS ?)` : ''}`)
      .run(name, new Date(Date.now() + delayMs).toISOString(), username, onlyIf ?? null, onlyIf ?? null, ...(whileFree ? [whileFree.except ?? null] : []));
  }

  /**
   * One name write per bot at a time, in the order they were asked for: the
   * sweep's idle name, still waiting on Telegram when an agent took the bot,
   * landed after the agent's name and left the serving bot called
   * "unassigned" with nothing queued to put it right (HB-1035). Keyed by the
   * lower-cased @handle; an entry goes once its last write ends.
   */
  readonly #nameTurns = keyedLock();

  #applyDisplayName(secretRef: string, username: string, name: string, fromSweep = false): Promise<void> {
    return this.#nameTurns.run(username.toLowerCase(), () => this.#writeDisplayName(secretRef, username, name, fromSweep));
  }

  /** From the sweep: is `name` still the one queued for this bot? A lease or a sync may have queued its own while it waited. */
  #stillQueued(username: string, name: string): boolean {
    const row = this.db.prepare(`SELECT desired_name FROM telegram_pool WHERE username = ? COLLATE NOCASE`).get(username) as { desired_name: string | null } | undefined;
    return row?.desired_name === name;
  }

  async #writeDisplayName(secretRef: string, username: string, name: string, fromSweep: boolean): Promise<void> {
    // Its turn came after a lease's: that one named the bot, and this is stale.
    if (fromSweep && !this.#stillQueued(username, name)) return;
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
        this.#clearParked(username, fromSweep ? name : undefined);
        return;
      }
      // Asked again after the wait on getMe: a lease meanwhile queued the
      // agent's name, and writes it once this turn ends (HB-1035).
      if (fromSweep && !this.#stillQueued(username, name)) return;
      res = await setTelegramDisplayName(token, name, fetchImpl, this.opts.renameBackoffMs);
    } catch (err) {
      res = { ok: false, error: String(err) };
    }
    this.opts.log?.('channel.named', { username, name, ...res });
    if (res.ok) {
      this.#clearParked(username, fromSweep ? name : undefined);
      this.db
        .prepare(`UPDATE telegram_pool SET renamed_at = ? WHERE username = ? COLLATE NOCASE`)
        .run(new Date().toISOString(), username);
      return;
    }
    // A token Telegram no longer accepts is not a rate limit: the bot was
    // deleted or its token revoked at BotFather, and no amount of waiting
    // fixes it. Stop parking the name — one dead pool bot was renaming itself
    // every five minutes, forever (seen live 2026-09-19). The live census
    // (Settings → Messaging → Telegram) is where a dead token gets dealt with.
    if (permanentTelegramFailure(res.error)) {
      this.opts.log?.('channel.name_abandoned', { username, name, error: String(res.error).slice(0, 120) });
      this.#clearParked(username, fromSweep ? name : undefined);
      return;
    }
    // Keep the name parked, and respect the deadline Telegram gave us. Without
    // this the sweep retried a three-hour limit every two minutes. From the
    // sweep, only while it is still the name queued: a lease meanwhile queued
    // its own, and the failed old one replaced it (review R15, 2026-10-23).
    const waitMs = (res.retryAfter ?? 300) * 1000;
    this.#park(username, name, waitMs, fromSweep ? name : undefined);
  }

  /**
   * Clear the queued name. From the retry sweep, only if it is still the name
   * the sweep applied: a lease may have queued another meanwhile (night
   * review). A lease or a sync names the bot with authority and clears any.
   */
  #clearParked(username: string, onlyIf?: string): void {
    this.db
      .prepare(`UPDATE telegram_pool SET desired_name = NULL, rename_after = NULL WHERE username = ? COLLATE NOCASE AND (? IS NULL OR desired_name IS ?)`)
      .run(username, onlyIf ?? null, onlyIf ?? null);
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
      // Each rename can take ~25 s when Telegram is flaky; a lease during the
      // sweep queues (and applies) its own name. Only what is queued NOW.
      const now = this.db
        .prepare(`SELECT desired_name, rename_after FROM telegram_pool WHERE username = ?`)
        .get(r.username) as { desired_name: string | null; rename_after: string | null } | undefined;
      if (now?.desired_name !== r.desired_name || (now.rename_after && now.rename_after > new Date().toISOString())) continue;
      await this.#applyDisplayName(r.secret_ref, r.username, r.desired_name, true);
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

  /** Whom a pool bot wrote to about its previous agent (empty for a fresh bot). */
  priorChatIds(username: string): string[] {
    const row = this.db
      .prepare(`SELECT prior_chat_ids FROM telegram_pool WHERE username = ? COLLATE NOCASE`)
      .get(username) as { prior_chat_ids?: string | null } | undefined;
    try { const v = JSON.parse(row?.prior_chat_ids ?? '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
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
      // Kept (not cleared): the owner claim that follows this lease must know
      // whom the bot just wrote to, so none of them is taken for the new
      // owner's first message. The next release overwrites the list.
    } catch {
      /* cosmetic — never blocks a lease */
    }
  }

  /**
   * Confirm every update waiting on a bot being leased, so none reaches the
   * agent it is leased to. A negative offset makes Telegram forget every
   * update before the newest; the second call confirms that one too. Runs
   * before the new agent's gateway exists, so it never competes with a
   * poller of its own; a 409 means the previous agent's is still polling.
   * Best-effort like the rest of the lease, but logged when it fails.
   */
  async #dropWaitingUpdates(secretRef: string, username: string): Promise<void> {
    try {
      const token = await this.secrets.get(secretRef);
      const f = this.opts.fetchImpl ?? fetch;
      const ask = async (offset: number) => {
        const res = await f(`https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&limit=1&timeout=0`, { signal: AbortSignal.timeout(5000) });
        return (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: Array<{ update_id?: unknown }> };
      };
      const newest = await ask(-1);
      if (newest.ok !== true) {
        this.opts.log?.('pool.updates_not_dropped', { username, error: String(newest.description ?? 'no answer').slice(0, 160) });
        return;
      }
      const id = Number(newest.result?.[0]?.update_id);
      if (!Number.isSafeInteger(id)) return; // nothing was waiting
      const confirmed = await ask(id + 1);
      this.opts.log?.(confirmed.ok === true ? 'pool.updates_dropped' : 'pool.updates_not_dropped', { username, ...(confirmed.ok === true ? {} : { error: String(confirmed.description ?? 'no answer').slice(0, 160) }) });
    } catch (err) {
      this.opts.log?.('pool.updates_not_dropped', { username, error: String((err as Error)?.message ?? err).slice(0, 160) });
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
      .prepare(`SELECT secret_ref, leased_to, farewell_told FROM telegram_pool WHERE username = ? COLLATE NOCASE`)
      .get(accountId) as { secret_ref?: string; leased_to?: string; farewell_told?: string | null } | undefined;

    // Another agent's lease is not the departing one's to end. A pasted bot
    // parked a moment before is free, and a create may lease it before this
    // release runs: clearing that lease listed a live agent's bot as spare,
    // and Remove then deleted the token it runs on (audit #089).
    if (opts.agentId && row?.leased_to && row.leased_to !== opts.agentId) {
      this.opts.log?.('pool.release_skipped', { accountId, leasedTo: row.leased_to, departing: opts.agentId });
      return;
    }

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
        // Always written, empty included: the previous life's list must not
        // outlive it and be announced (or excluded) again after this one.
        this.db
          .prepare(`UPDATE telegram_pool SET prior_chat_ids = ? WHERE username = ? COLLATE NOCASE`)
          .run(prior.length ? JSON.stringify(prior) : null, accountId);
      } catch { /* no memberships table (isolated harness) → nothing to capture */ }
    }

    // Whether its members are told it ended (below), and whom a farewell
    // for this very release told already: the same agent and reason, the
    // lease let go before (Delete pressed again after a restart cut the
    // first one off), goes on from where that one was, so nobody is told
    // twice (HB-1267). Any other is a farewell of its own, recorded from
    // the let-go.
    const reason = opts.reason ?? 'deleted';
    const saysGoodbye = !!row?.secret_ref && !!departing && reason !== 'moved' && reason !== 'swapped' && reason !== 'setup-failed';
    let told: string[] | undefined;
    if (saysGoodbye) {
      const was = parseTold(row?.farewell_told);
      told = !row?.leased_to && was?.agent === departing && was.reason === reason ? was.ids : [];
    }

    // The bot goes back in the pool. We do NOT delete the token — the bot still
    // exists on Telegram's side and can serve the next agent.
    this.db
      .prepare(`UPDATE telegram_pool SET leased_to = NULL, leased_at = NULL${told ? ', farewell_told = ?' : ''} WHERE username = ? COLLATE NOCASE`)
      .run(...(told ? [JSON.stringify({ agent: departing, reason, ids: told })] : []), accountId);
    // Let go from this agent, whose row its caller removes next (#releasedFrom).
    if (row && departing) this.#releasedFrom.set(accountId.toLowerCase(), { agent: departing, at: Date.now() });
    if (row) this.#aSpareFreed();

    if (!row?.secret_ref) return;
    // Say goodbye BEFORE renaming, while the bot still looks like the agent the
    // members knew. Telegram chats are per-user and a bot cannot clear history,
    // so the honest thing is to mark the end of the conversation: anything above
    // belongs to an agent that no longer has this bot, and if it comes back as
    // something else, that history is not its own.
    // A moved bot is live on the other machine under the same agent: no
    // farewell, and no idle name queued for it (the caller retires the row).
    if (opts.reason === 'moved') return;
    if (saysGoodbye && departing && told) {
      // Not offered to another agent until it is out, a pasted bot parked a
      // moment ago included (#sayingGoodbye, HB-1048). Set in the same step
      // as the lease is let go, so no lease comes between.
      const letGo = this.#holdForGoodbye(accountId.toLowerCase());
      try { await this.#farewell(accountId, row.secret_ref, departing, reason as 'deleted' | 'archived' | 'detached', new Set(told)); }
      finally {
        // Its row goes once the farewell is out: from then on, as from a let-go.
        const from = this.#releasedFrom.get(accountId.toLowerCase());
        if (from?.agent === departing) from.at = Date.now();
        letGo();
      }
    }
    // The idle name is PARKED, not applied now. Renames are the scarce thing
    // here — Telegram grants roughly one per bot every few hours — and an
    // archive followed by a restore used to spend two of them: one to
    // "unassigned", one back to the same agent. That is how a live agent's bot
    // ended up called "Hatchabot (unassigned)" for three hours. Deferring means
    // a bot re-leased before the sweep runs spends NONE, while one that really
    // is sitting free still stops advertising a departed agent.
    // The bot is free here: no lease was given while its farewell went out,
    // and none can come between that and this, the same step. (A lease taken
    // during the farewell once had its new name parked over, concurrency
    // review 2026-10-09; the farewell's hold is what stops that now.)
    // And only while it is free, whatever let a lease in: parked over a
    // lease, the sweep renamed a serving bot "unassigned" (HB-1265).
    this.#park(accountId, TelegramPoolProvisioner.IDLE_NAME, IDLE_RENAME_DELAY_MS, undefined, { except: departing });
  }

  /**
   * A lease taken for an agent that then did not connect the bot (refused as
   * busy, or gone meanwhile), handed back: free again, its idle name queued
   * (the lease named the bot for that agent), and no farewell, since it
   * served nobody there. Whom it wrote to before stays its list: release()
   * put the refused agent's people there, and the next lease told them, not
   * the bot's own chats, that it had changed hands (HB-1131 review). Only
   * while the lease is that agent's, or nobody's.
   */
  returnUnused(username: string, agentId: string): void {
    const freed = this.db
      .prepare(`UPDATE telegram_pool SET leased_to = NULL, leased_at = NULL WHERE username = ? COLLATE NOCASE AND (leased_to IS NULL OR leased_to = ?)`)
      .run(username, agentId);
    // Not on a live agent's bot: a lease that found the bot taken by a row
    // meanwhile gives it back here, and the idle name renamed that agent's
    // bot "unassigned" (#connectedTo).
    if (freed.changes) {
      this.#park(username, TelegramPoolProvisioner.IDLE_NAME, IDLE_RENAME_DELAY_MS, undefined, {});
      this.#aSpareFreed();
    }
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
  /** One member told by the farewell recorded for this agent and reason (release: `farewell_told`); another release's since is left alone. */
  #noteTold(username: string, agentId: string, reason: string, id: string): void {
    const row = this.db.prepare(`SELECT farewell_told FROM telegram_pool WHERE username = ? COLLATE NOCASE`).get(username) as { farewell_told?: string | null } | undefined;
    const rec = parseTold(row?.farewell_told);
    if (!rec || rec.agent !== agentId || rec.reason !== reason || rec.ids.includes(id)) return;
    this.db.prepare(`UPDATE telegram_pool SET farewell_told = ? WHERE username = ? COLLATE NOCASE`)
      .run(JSON.stringify({ ...rec, ids: [...rec.ids, id] }), username);
  }

  async #farewell(
    username: string,
    secretRef: string,
    agentId: string,
    reason: 'deleted' | 'archived' | 'detached',
    told: ReadonlySet<string>,
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
      // One at a time, and a 429 is waited out (its retry_after) and tried
      // again, up to FAREWELL_WAIT_MS in all: sent in a plain loop, a large
      // membership ran into the rate limit and the rest were never told
      // where the agent went (HB-0039).
      // And all of it within FAREWELL_DEADLINE_MS, sends included (HB-0989).
      const send = this.opts.fetchImpl ?? fetch;
      const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const now = this.opts.now ?? Date.now;
      const deadline = now() + FAREWELL_DEADLINE_MS;
      let sent = 0, failed = 0, outOfTime = 0, already = 0, waitLeft = FAREWELL_WAIT_MS;
      for (const { id } of ids) {
        if (!/^\d{1,32}$/.test(id)) continue;
        // Told by this release's farewell before a restart cut it off (HB-1267).
        if (told.has(id)) { already++; continue; }
        if (deadline - now() <= 0) { failed++; outOfTime++; continue; }
        let ok = false;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          const left = deadline - now();
          if (left <= 0) break;
          const res = await send(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: id, text }),
            signal: AbortSignal.timeout(Math.min(5000, left)),
          }).catch(() => undefined);
          const body = (await res?.json().catch(() => ({}))) as { ok?: boolean; parameters?: { retry_after?: unknown } } | undefined;
          ok = body?.ok === true;
          const wait = res?.status === 429 ? Number(body?.parameters?.retry_after) * 1000 : NaN;
          if (ok || !(wait >= 0) || wait > waitLeft || wait >= deadline - now()) break;
          waitLeft -= wait;
          await sleep(wait);
        }
        if (ok) { sent++; this.#noteTold(username, agentId, reason, id); } else failed++;
      }
      this.opts.log?.('pool.farewell', { agentId, reason, sent, failed, ...(outOfTime ? { outOfTime } : {}), ...(already ? { alreadyTold: already } : {}) });
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

/** A promise that settles once told, and its telling. */
function signal(): { at: Promise<void>; tell: () => void } {
  let tell!: () => void;
  const at = new Promise<void>((r) => { tell = r; });
  return { at, tell };
}

/** A farewell's record (`farewell_told`), or undefined when there is none or it does not parse. */
function parseTold(raw: string | null | undefined): { agent: string; reason: string; ids: string[] } | undefined {
  try {
    const v = JSON.parse(raw ?? 'null') as { agent?: unknown; reason?: unknown; ids?: unknown } | null;
    return v && typeof v.agent === 'string' && typeof v.reason === 'string' && Array.isArray(v.ids)
      ? { agent: v.agent, reason: v.reason, ids: v.ids.map(String) } : undefined;
  } catch { return undefined; }
}

export class PoolExhaustedError extends Error {
  readonly userMessage =
    'We are out of ready-made bots right now. You can connect your own in about a minute instead.';
  constructor() {
    super('Telegram bot pool exhausted');
    this.name = 'PoolExhaustedError';
  }
}
