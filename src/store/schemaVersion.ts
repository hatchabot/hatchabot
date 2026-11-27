import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { APP_VERSION } from '../domain/appVersion.js';

/**
 * The database's schema number, and the numbered steps that bring an older
 * database up to this release's (HB-0813).
 *
 * The number is SQLite's `PRAGMA user_version`: the number of the newest
 * step the database has had. Each step runs once, in order, and is recorded
 * in `schema_steps` with whether it is additive and the release that ran
 * it. That record is what lets an OLDER release judge a database a newer
 * one has changed (an upgrade that rolls back leaves the database as the
 * newer release made it; HB-0813):
 *
 *   - newer by additive steps only: it logs one warning and runs;
 *   - newer by a step that is not additive: it refuses to start, and names
 *     the release to install (`SchemaTooNewError`).
 *
 * Tables are still made by the `CREATE TABLE IF NOT EXISTS` block in
 * `Store`, and one-time changes to data are still the named steps in
 * `store_migrations` (`runOnce`). This list is for a change to a table that
 * already exists.
 *
 * A change to data that a rollback can undo is not one-time: what an older
 * release writes after a rollback, a one-time step never sees again. Such a
 * change is a check at every start instead. One so far: the agents an older
 * release made, marked as ones whose adopted tasks may be unrecorded
 * (`adopt_carried_tasks`, HB-0985).
 */
export interface SchemaStep {
  /** Its number: its place in the list, counted from 1. */
  readonly n: number;
  /**
   * true: a release from before this step still works on a database that
   * has had it (a new column that is nullable or has a default). false: it
   * does not (a column dropped or renamed, a table rebuilt under another
   * key, values that now mean something else), and such a release will
   * refuse to start on that database.
   */
  readonly additive: boolean;
  /** What it runs. One `ALTER TABLE … ADD COLUMN …` when it adds a column. */
  readonly sql: string;
}

/**
 * ADDING A STEP: append it at the END, with the next number. Never edit,
 * reorder or remove a step that is here: a database that has run step 37
 * will never run it again, so a changed step 37 reaches new installs only.
 * To undo or correct a step, append another.
 *
 *   - A new column goes in one place: a step here, and not the table's
 *     `CREATE TABLE` in `Store`. A new database runs every step too, in
 *     order, so it comes to the schema an older one does, column for column
 *     and in the same order. test/schemaVersion.test.ts holds a new
 *     database to v2.190.0's schema with the steps since run on it: a
 *     column put in the `CREATE TABLE` as well fails it. (A step that finds
 *     its column already there is recorded as done: older databases had
 *     some of steps 1 to 112 before the schema had a number.)
 *   - A new table needs no step: its `CREATE TABLE IF NOT EXISTS` in
 *     `Store` makes it on every database. Name it in the test's
 *     TABLES_SINCE_2_190.
 *   - Mark it `additive: false` when a release without the step cannot run
 *     on a database that has had it. That stops every older release from
 *     starting there, which is what a rollback then meets: say so in the
 *     CHANGELOG's Upgrading section.
 *   - test/schemaVersion.test.ts holds a fingerprint of every step. It
 *     fails when a step was changed, and prints the line to add for a new one.
 *
 * Steps 1 to 112 are the `ALTER TABLE` list that ran on every start before
 * the schema had a number, in its order.
 */
export const SCHEMA_STEPS: readonly SchemaStep[] = [
  { n: 1, additive: true, sql: `ALTER TABLE pairing_windows ADD COLUMN generation TEXT` },
  { n: 2, additive: true, sql: `ALTER TABLE agents ADD COLUMN shared_memory INTEGER NOT NULL DEFAULT 0` },
  { n: 3, additive: true, sql: `ALTER TABLE agent_cost_days ADD COLUMN unpriced_tokens REAL NOT NULL DEFAULT 0` },
  // When a removal was first recorded: one pending for over a day is an Alerts line (access overview).
  { n: 4, additive: true, sql: `ALTER TABLE connection_removals ADD COLUMN created_at TEXT` },
  { n: 5, additive: true, sql: `ALTER TABLE agents ADD COLUMN pending_action TEXT` },
  { n: 6, additive: true, sql: `ALTER TABLE memberships ADD COLUMN display_name TEXT` },
  { n: 7, additive: true, sql: `ALTER TABLE ai_profiles ADD COLUMN models TEXT` },
  { n: 8, additive: true, sql: `ALTER TABLE ai_profiles ADD COLUMN base_url TEXT` },
  { n: 9, additive: true, sql: `ALTER TABLE cli_tokens ADD COLUMN expires_at TEXT` },
  { n: 10, additive: true, sql: `ALTER TABLE cli_tokens ADD COLUMN scope TEXT` },
  { n: 11, additive: true, sql: `ALTER TABLE agents ADD COLUMN applied_profile_id TEXT` },
  { n: 12, additive: true, sql: `ALTER TABLE agents ADD COLUMN applied_model TEXT` },
  // When the applied source last changed, and from which: usage before
  // that instant is the old source's (sourceUsage.ts).
  { n: 13, additive: true, sql: `ALTER TABLE agents ADD COLUMN applied_profile_prev TEXT` },
  { n: 14, additive: true, sql: `ALTER TABLE agents ADD COLUMN applied_profile_at TEXT` },
  { n: 15, additive: true, sql: `ALTER TABLE agents ADD COLUMN migrated_to TEXT` },
  { n: 16, additive: true, sql: `ALTER TABLE agents ADD COLUMN shared_paths TEXT` },
  { n: 17, additive: true, sql: `ALTER TABLE agents ADD COLUMN gateway_port INTEGER` },
  { n: 18, additive: true, sql: `ALTER TABLE agents ADD COLUMN gateway_token TEXT` },
  { n: 19, additive: true, sql: `ALTER TABLE ai_profiles ADD COLUMN shared INTEGER NOT NULL DEFAULT 0` },
  // The management bot's LLM rides this source (single-select per owner).
  { n: 20, additive: true, sql: `ALTER TABLE ai_profiles ADD COLUMN mgmt_llm INTEGER NOT NULL DEFAULT 0` },
  // Optional per-agent model override (cloud only). NULL = follow the
  // profile's default model.
  { n: 21, additive: true, sql: `ALTER TABLE agents ADD COLUMN model TEXT` },
  // Owner-defined organization: an optional group label and a manual order.
  { n: 22, additive: true, sql: `ALTER TABLE agents ADD COLUMN group_name TEXT` },
  { n: 23, additive: true, sql: `ALTER TABLE agents ADD COLUMN image TEXT` },
  { n: 24, additive: true, sql: `ALTER TABLE agents ADD COLUMN sort_order INTEGER` },
  // Bind an adopted agent's folder at its original host path, so existing
  // absolute-path references resolve unchanged.
  { n: 25, additive: true, sql: `ALTER TABLE data_sources ADD COLUMN mount_at_host_path INTEGER NOT NULL DEFAULT 0` },
  // Last git clone/refresh result, so a repo that never cloned (usually its
  // deploy key isn't on the host yet) is visible on the card instead of
  // only in the audit log.
  { n: 26, additive: true, sql: `ALTER TABLE data_sources ADD COLUMN sync_error TEXT` },
  { n: 27, additive: true, sql: `ALTER TABLE data_sources ADD COLUMN synced_at TEXT` },
  // Setup fields this agent's shares/templates ask the importer to fill
  // (JSON array of TemplateParam; sharing Phase 2a).
  { n: 28, additive: true, sql: `ALTER TABLE agents ADD COLUMN params TEXT` },
  // A configured template copy's editable state: the values applied and
  // the raw placeholder-bearing layer they render into (JSON) — what lets
  // setup values be edited or reset later without a re-import.
  { n: 29, additive: true, sql: `ALTER TABLE agents ADD COLUMN param_values TEXT` },
  { n: 30, additive: true, sql: `ALTER TABLE agents ADD COLUMN param_files TEXT` },
  // Telegram group-chat access (domain/types.ts GroupAccess), JSON.
  { n: 31, additive: true, sql: `ALTER TABLE agents ADD COLUMN group_access TEXT` },
  // Lineage: the master this agent was derived from (same installation).
  { n: 32, additive: true, sql: `ALTER TABLE agents ADD COLUMN parent_agent_id TEXT` },
  // Telegram rich formatting: NULL = managed default (on), 0 = opt-out.
  { n: 33, additive: true, sql: `ALTER TABLE agents ADD COLUMN rich_messages INTEGER` },
  { n: 34, additive: true, sql: `ALTER TABLE agents ADD COLUMN files_max_mb INTEGER` },
  { n: 35, additive: true, sql: `ALTER TABLE agents ADD COLUMN cron_triggers INTEGER` },
  { n: 36, additive: true, sql: `ALTER TABLE agents ADD COLUMN curated_skills TEXT` },
  { n: 37, additive: true, sql: `ALTER TABLE agents ADD COLUMN applied_curated_skills TEXT` },
  // Its own browser (src/orchestrator/console/browser.ts): off unless switched on.
  { n: 38, additive: true, sql: `ALTER TABLE agents ADD COLUMN browser INTEGER` },
  // Memory search engine: baked (NULL) or the machine's shared service.
  { n: 39, additive: true, sql: `ALTER TABLE agents ADD COLUMN embed_mode TEXT` },
  { n: 40, additive: true, sql: `ALTER TABLE agents ADD COLUMN applied_embed_mode TEXT` },
  { n: 41, additive: true, sql: `ALTER TABLE agents ADD COLUMN embed_indexed_at TEXT` },
  { n: 42, additive: true, sql: `ALTER TABLE agents ADD COLUMN embed_index_error TEXT` },
  // The key a build re-mints joins the old one until the build is accepted.
  { n: 43, additive: true, sql: `ALTER TABLE embed_tokens ADD COLUMN prev_token_hash TEXT` },
  // The machine whose memory search service the key is for (null: this one, minted before runners had one).
  { n: 44, additive: true, sql: `ALTER TABLE embed_tokens ADD COLUMN host_id TEXT` },
  // An "application" class = model + source + runtime image.
  { n: 45, additive: true, sql: `ALTER TABLE agent_classes ADD COLUMN image TEXT` },
  // Template-carried schedules awaiting the gateway (applied on RUNNING).
  { n: 46, additive: true, sql: `ALTER TABLE agents ADD COLUMN pending_schedules TEXT` },
  // Which agent a share was cut from — lets an accepted copy record lineage.
  { n: 47, additive: true, sql: `ALTER TABLE agent_shares ADD COLUMN source_agent_id TEXT` },
  // Per-agent and per-class memory cap (memoryCap.ts); the baseline hides cap hits from before the last change.
  { n: 48, additive: true, sql: `ALTER TABLE agents ADD COLUMN memory_cap TEXT` },
  { n: 49, additive: true, sql: `ALTER TABLE agents ADD COLUMN memory_cap_baseline INTEGER` },
  // …and when the container it was read from started: a later start is a new counter (HB-0234).
  { n: 50, additive: true, sql: `ALTER TABLE agents ADD COLUMN memory_cap_baseline_started TEXT` },
  // "Clear peaks" on Status → Resources: the peak the kernel keeps is
  // since the container started and root's to reset, so the app keeps
  // its own high-water mark from when the owner last cleared it.
  { n: 51, additive: true, sql: `ALTER TABLE agents ADD COLUMN memory_peak_since INTEGER` },
  { n: 52, additive: true, sql: `ALTER TABLE agents ADD COLUMN memory_peak_cleared_at TEXT` },
  // Hibernation (hibernate.ts): when the idle sweep put it to sleep, and an agent's opt-out.
  { n: 53, additive: true, sql: `ALTER TABLE agents ADD COLUMN hibernated_at TEXT` },
  { n: 54, additive: true, sql: `ALTER TABLE agents ADD COLUMN hibernate TEXT` },
  // The wake time and the bedtime mark must survive a restart: kept in memory,
  // a deploy forgot every wake and the next sweep put woken agents straight back (2026-09-26).
  { n: 55, additive: true, sql: `ALTER TABLE agents ADD COLUMN woken_at TEXT` },
  // A copy of the agent was downloaded while it stood stopped (transfer.ts): cleared when it runs again.
  { n: 56, additive: true, sql: `ALTER TABLE agents ADD COLUMN exported_at TEXT` },
  // Moved while stopped: its rebuild hook runs at its next start (moveHost.ts), set when that became due.
  { n: 57, additive: true, sql: `ALTER TABLE agents ADD COLUMN rebuild_hook_due TEXT` },
  // A change only a new container picks up, made while it stood stopped or asleep: its next start is a rebuild (HB-0411).
  { n: 58, additive: true, sql: `ALTER TABLE agents ADD COLUMN rebuild_on_start TEXT` },
  // A restore, clone, child or import: with no bot free it goes on web-only, at a Retry too (HB-0415). Cleared once it runs.
  { n: 59, additive: true, sql: `ALTER TABLE agents ADD COLUMN web_only_if_no_bot INTEGER` },
  { n: 60, additive: true, sql: `ALTER TABLE agents ADD COLUMN hibernate_mark INTEGER` },
  { n: 61, additive: true, sql: `ALTER TABLE agent_classes ADD COLUMN memory_cap TEXT` },
  // Compressed swap (swap.ts): an agent's or a class's allowance on top of its memory cap; "off" or a size, NULL = inherit.
  { n: 62, additive: true, sql: `ALTER TABLE agents ADD COLUMN swap_allowance TEXT` },
  { n: 63, additive: true, sql: `ALTER TABLE agent_classes ADD COLUMN swap_allowance TEXT` },
  // "Clear from Alerts": the fingerprint of what was flagged when the owner cleared it.
  { n: 64, additive: true, sql: `ALTER TABLE agents ADD COLUMN attention_ack TEXT` },
  // The message a managed task was made with, so a new release's wording reaches it (modelReview.ts).
  { n: 65, additive: true, sql: `ALTER TABLE managed_crons ADD COLUMN message_hash TEXT` },
  // Installation-wide default AI source for NEW agents (single-select):
  // preselected in the create form and preferred by importTemplate's
  // silent fallback — the "household default" once per-member profiles
  // are retired. Only applies where the profile is visible (own/shared).
  { n: 66, additive: true, sql: `ALTER TABLE ai_profiles ADD COLUMN default_source INTEGER NOT NULL DEFAULT 0` },
  // The order the owner put their sources in (⚙ Settings → AI, ▲▼). A
  // local model that is rarely picked belongs at the bottom of every list
  // it appears in, and the default belongs at the top. Nullable like
  // agents.sort_order, so the backfill below runs once.
  { n: 67, additive: true, sql: `ALTER TABLE ai_profiles ADD COLUMN sort_order INTEGER` },
  // Who may reach this agent on a messaging app: 0 (the default, fleet-wide)
  // admits only people you invited or already know; 1 lets anyone who finds
  // the bot knock and wait for approval, which is how every agent behaved
  // before 2026-09-20.
  { n: 68, additive: true, sql: `ALTER TABLE agents ADD COLUMN allow_knocks INTEGER NOT NULL DEFAULT 0` },
  // Who an invite is FOR, when the owner said so: a Telegram @handle. The
  // claim window it opens then admits only that person.
  { n: 69, additive: true, sql: `ALTER TABLE invites ADD COLUMN expect_handle TEXT` },
  // Chat on the web (2026-09-29): a member the owner trusts to talk to the
  // agent from this app, and the invite that grants it. Off by default —
  // a web turn runs as the owner, so it is given, never assumed.
  { n: 70, additive: true, sql: `ALTER TABLE memberships ADD COLUMN web_chat INTEGER NOT NULL DEFAULT 0` },
  { n: 71, additive: true, sql: `ALTER TABLE invites ADD COLUMN web_chat INTEGER NOT NULL DEFAULT 0` },
  // The app a redeemed invite was used for (2026-09-30): "Let them in
  // again" reopens that one only. It opened a window on every app they
  // were not linked on, and on a big Slack or Discord without a named
  // handle the first stranger to message took the seat.
  { n: 72, additive: true, sql: `ALTER TABLE invites ADD COLUMN redeemed_via TEXT` },
  // …and the window the redeemed invite opens carries it. CREATE TABLE IF
  // NOT EXISTS does nothing to a table that already exists, so a column
  // added to one after it shipped needs this line or every read of it
  // throws on an upgraded install (it did: v2.14.0, caught 2026-09-21).
  { n: 73, additive: true, sql: `ALTER TABLE pairing_window ADD COLUMN expect TEXT` },
  // The day's own use, summed from counter rises (a lifetime total that
  // came back after an agent was away counted as that day's use; night review).
  { n: 74, additive: true, sql: `ALTER TABLE usage_snapshots ADD COLUMN used_tokens INTEGER` },
  // The doorman's own key, beside the manager's (30th audit).
  { n: 75, additive: true, sql: `ALTER TABLE ops_tokens ADD COLUMN doorman_key TEXT` },
  // A parked Discord bot: whom it last wrote to (told "this bot is now X"
  // when reused), and which archived agent it is kept for (restore takes
  // it back if nobody else did).
  { n: 76, additive: true, sql: `ALTER TABLE discord_bots ADD COLUMN prior_chat_ids TEXT` },
  { n: 77, additive: true, sql: `ALTER TABLE discord_bots ADD COLUMN archived_for TEXT` },
  // The same pool holds parked Slack apps (their two tokens in one secret).
  { n: 78, additive: true, sql: `ALTER TABLE discord_bots ADD COLUMN kind TEXT NOT NULL DEFAULT 'discord'` },
  // The account's linked Telegram identity ("That's me" on a pairing card):
  // the durable, account-level form of what knownChannelUserId used to
  // infer from membership rows — survives deleting every agent, and lets a
  // FRESH account link on its very first approval.
  { n: 79, additive: true, sql: `ALTER TABLE accounts ADD COLUMN telegram_user_id TEXT` },
  // Connection health/provenance: when an agent was first attached to a
  // connection, and when it last materialized (pulled) that connection's
  // token into its container. materialized_at < the connection's
  // created_at (last consent) means the agent is running a STALE token —
  // e.g. the account was reconnected but the agent never re-attached.
  // Which Google OAuth client issued a connection's refresh token: a
  // token only works with the client that issued it, so replacing the
  // installation's client breaks every connection made with the old one.
  // NULL = made before this was recorded.
  { n: 80, additive: true, sql: `ALTER TABLE connections ADD COLUMN client_id TEXT` },
  { n: 81, additive: true, sql: `ALTER TABLE connections ADD COLUMN client_secret_at TEXT` },
  { n: 82, additive: true, sql: `ALTER TABLE agent_connections ADD COLUMN attached_at TEXT` },
  { n: 83, additive: true, sql: `ALTER TABLE agent_connections ADD COLUMN materialized_at TEXT` },
  // An agent-scoped cli-token: when set, this token authenticates a CALLER
  // AGENT (not a user) to the agent-to-agent /message endpoint.
  { n: 84, additive: true, sql: `ALTER TABLE cli_tokens ADD COLUMN agent_id TEXT` },
  // The peer set (sorted csv of peer ids) that was live when this agent was
  // last provisioned/rebuilt — the call-agent tool is installed on rebuild,
  // so a grant that differs from this needs a rebuild to take effect.
  { n: 85, additive: true, sql: `ALTER TABLE agents ADD COLUMN applied_peers TEXT` },
  // The agent class (model/source tier) this agent belongs to, if any.
  { n: 86, additive: true, sql: `ALTER TABLE local_accounts ADD COLUMN claim_code TEXT` },
  { n: 87, additive: true, sql: `ALTER TABLE local_accounts ADD COLUMN claim_expires TEXT` },
  // A recovery code: the way back in for someone with no Telegram and no
  // one else to send them a reset link — the host owner, above all.
  { n: 88, additive: true, sql: `ALTER TABLE local_accounts ADD COLUMN recovery_hash TEXT` },
  { n: 89, additive: true, sql: `ALTER TABLE local_accounts ADD COLUMN recovery_salt TEXT` },
  { n: 90, additive: true, sql: `ALTER TABLE local_accounts ADD COLUMN recovery_created TEXT` },
  { n: 91, additive: true, sql: `ALTER TABLE agent_peers ADD COLUMN allow_actions INTEGER NOT NULL DEFAULT 0` },
  { n: 92, additive: true, sql: `ALTER TABLE agents ADD COLUMN class_id TEXT` },
  // Home-screen icon: an emoji and a #rrggbb tint (ui v2). Cosmetic.
  { n: 93, additive: true, sql: `ALTER TABLE agents ADD COLUMN icon TEXT` },
  { n: 94, additive: true, sql: `ALTER TABLE agents ADD COLUMN icon_color TEXT` },
  // No Telegram bot: reached only through Hatchabot itself.
  { n: 95, additive: true, sql: `ALTER TABLE agents ADD COLUMN web_only INTEGER NOT NULL DEFAULT 0` },
  { n: 96, additive: true, sql: `ALTER TABLE agents ADD COLUMN ops INTEGER NOT NULL DEFAULT 0` },
  // Slack/Discord: room access and display details, as JSON.
  { n: 97, additive: true, sql: `ALTER TABLE channels ADD COLUMN settings TEXT` },
  // The Hatchabot version this agent's runtime was last built against. A
  // management agent reads its tool list once, when its gateway starts, so
  // an upgrade that adds a tool needs it restarted before it can see one.
  { n: 98, additive: true, sql: `ALTER TABLE agents ADD COLUMN applied_app_version TEXT` },
  // Whose Brave key its container was built with: own, fleet or none
  // (HB-0578 review). NULL: built before it was recorded.
  { n: 99, additive: true, sql: `ALTER TABLE agents ADD COLUMN applied_search_key TEXT` },
  // Budgets (v2.124.0): "switch to a cheaper model" at the limit, and the
  // one reply a paused agent's bot sends each chat.
  { n: 100, additive: true, sql: `ALTER TABLE budget_pauses ADD COLUMN kind TEXT NOT NULL DEFAULT 'pause'` },
  { n: 101, additive: true, sql: `ALTER TABLE budget_pauses ADD COLUMN from_model TEXT` },
  { n: 102, additive: true, sql: `ALTER TABLE budget_pauses ADD COLUMN to_model TEXT` },
  { n: 103, additive: true, sql: `ALTER TABLE budget_pauses ADD COLUMN replies TEXT` },
  // A spike warning the owner cleared from Usage (v2.125.1): kept, not shown.
  { n: 104, additive: true, sql: `ALTER TABLE usage_alerts ADD COLUMN dismissed_at TEXT` },
  // A spike whose message a loop's message covered (v2.158.0): one cause, one message.
  { n: 105, additive: true, sql: `ALTER TABLE usage_alerts ADD COLUMN covered TEXT` },
  // Which source last_ok was a success on (v2.160.0): an agent's success
  // before a source switch is not one on its new source.
  { n: 106, additive: true, sql: `ALTER TABLE usage_cursor ADD COLUMN last_ok_profile TEXT` },
  // A snapshot's setup-values layer (v2.160.0, JSON; the text 'null' = the
  // agent had none, NULL = taken before it was recorded): a restore puts
  // it back with the files, or the next value edit re-renders what was undone.
  { n: 107, additive: true, sql: `ALTER TABLE snapshots ADD COLUMN params TEXT` },
  // A pause recorded on an agent the budget did NOT stop (stopped by hand when the
  // limit came, v2.166.0): it closes on the 1st or a raise, and the budget never
  // starts the agent — before, it started every hand-stopped agent on the 1st.
  { n: 108, additive: true, sql: `ALTER TABLE budget_pauses ADD COLUMN already_stopped INTEGER NOT NULL DEFAULT 0` },
  // The removed git source's address (v2.167.0): its clone is deleted only
  // when the folder still holds that repo. NULL (older removals): key only.
  { n: 109, additive: true, sql: `ALTER TABLE data_source_removals ADD COLUMN repo_url TEXT` },
  // Which request a waiting app install is (v2.170.0): the run that finishes
  // drops or marks only the one it ran, never a newer one saved meanwhile
  // (HB-0256). NULL: saved before it was recorded.
  { n: 110, additive: true, sql: `ALTER TABLE agent_app_pending ADD COLUMN gen TEXT` },
  // Keep its logins (HB-0680, docs/browser.md): the id of the browser
  // profile it keeps, NULL when it keeps none. Forget gives it a new one,
  // so a profile forgotten is never mounted again; the sweep removes it.
  { n: 111, additive: true, sql: `ALTER TABLE agents ADD COLUMN browser_logins TEXT` },
  // The sites opened in its sign-in panel while it keeps that profile, JSON.
  { n: 112, additive: true, sql: `ALTER TABLE agents ADD COLUMN browser_sites TEXT` },
  // A share's template's setup fields, JSON, kept when it is sent (HB-0960):
  // the inbox lists them without inflating every file. NULL (sent before):
  // read once from its file, then kept.
  { n: 113, additive: true, sql: `ALTER TABLE agent_shares ADD COLUMN parameters TEXT` },
  // rate_hits pruned by time (HB-0836): every bucket's rows an hour past
  // their `at` go, and without this a prune read the whole table. An index
  // an older release does not know it has, and never needs.
  { n: 114, additive: true, sql: `CREATE INDEX IF NOT EXISTS rate_hits_at ON rate_hits (at)` },
  // A derived image's base packages (HB-0986): what an import lays on the
  // base here before the owner's lines, because the base it came from had
  // them and this one does not. Kept apart from the lines, so the lines'
  // 8000-character cap is the owner's alone. Space-separated; '' for none.
  // Additive: an older release still runs on it, but a Rebuild there builds
  // the lines without these packages, as it does not know them.
  { n: 115, additive: true, sql: `ALTER TABLE derived_images ADD COLUMN base_packages TEXT NOT NULL DEFAULT ''` },
  // The ids a join's window passes over, on its row (JSON: the window's
  // generation and the list; NULL for none): the knocks read the row, and a
  // knock from one of them was shown to the owner as the one the window was
  // waiting for (HB-1221 review). Additive: an older release never writes or
  // reads it, and its windows then admit, and show, any knock as before; one
  // it writes again keeps the column, under another generation, which reads
  // as none here.
  { n: 116, additive: true, sql: `ALTER TABLE pairing_windows ADD COLUMN exclude_ids TEXT` },
  // What a carried task's source task held when an adopt carried it, and
  // the copy it became (HB-1200; cronImport.ts carriedFingerprint): an
  // adopt again says how many changed in the old workspace since. NULL:
  // carried before it was kept, never counted as changed. Additive: an
  // older release never reads it; a copy it records keeps the old value,
  // which names another copy, and is read as none.
  { n: 117, additive: true, sql: `ALTER TABLE adopt_carried_tasks ADD COLUMN fingerprint TEXT` },
  // The account a deleted AI source belonged to (HB-1179): the removal of
  // that account takes the source's tombstone with it. NULL: deleted before
  // it was kept, and pruned with its readings only. Additive: an older
  // release never reads it, and a tombstone it writes has none.
  { n: 118, additive: true, sql: `ALTER TABLE ai_profile_tombstones ADD COLUMN owner_id TEXT` },
  // A task Hatchabot made on an agent, recorded after the copy its volume
  // was replaced by (HB-1317): it may be in the copy all the same (found by
  // its name when it was recorded, renamed by hand since), so the next build
  // looks for it by its id before it makes one. 0: as recorded. Additive: an
  // older release never reads it, and takes such a record for one the copy
  // holds, as before HB-1123.
  { n: 119, additive: true, sql: `ALTER TABLE managed_crons ADD COLUMN after_copy INTEGER NOT NULL DEFAULT 0` },
  // When the vault's pass gave up asking Google to end a deleted
  // connection's token (HB-1336): the row then stays, its token deleted, as
  // the Connections page's notice to remove the access by hand, until its
  // owner marks it done. NULL: still being asked. Additive: an older
  // release reads such a row as still to end, finds no token under it, and
  // settles it at its next pass.
  { n: 120, additive: true, sql: `ALTER TABLE connection_cleanups ADD COLUMN given_up_at TEXT` },
  // The calls a practice run's source refused (a rate limit), which answered
  // nothing (HB-1497): the source's request counts add them as refused. 0:
  // none, or a row from before. Additive: an older release never reads it,
  // and a row it writes has none.
  { n: 121, additive: true, sql: `ALTER TABLE practice_usage ADD COLUMN refused INTEGER NOT NULL DEFAULT 0` },
  // ↑ Append the next step above this line, with the next number. Then run
  //   test/schemaVersion.test.ts: it prints the fingerprint line to record.
];

/** The newest step this release has: the schema number it brings a database to. */
export const SCHEMA_VERSION = SCHEMA_STEPS.length;

/** Where a database stands against a step list. */
export interface SchemaStanding {
  /**
   * current: at this release's number. behind: older (0: never numbered, a
   * new database or one from before HB-0813), and the next start brings it
   * up. newer: a newer release has run steps this one does not have.
   */
  kind: 'current' | 'behind' | 'newer';
  /** The database's schema number. */
  db: number;
  /** This release's. */
  code: number;
  /** newer: this release must not run on it. */
  refused?: boolean;
  /** newer: the release that ran the database's newest step, when it is recorded. */
  writtenBy?: string;
  /** newer: the steps past this release's that are recorded as not additive. */
  notAdditive?: number[];
  /** newer: the steps past this release's with no record at all, so nothing says they are safe. */
  unrecorded?: number[];
}

/** A database a newer release changed in a way this one cannot work with. */
export class SchemaTooNewError extends Error {
  constructor(readonly standing: SchemaStanding, message: string) {
    super(message);
    this.name = 'SchemaTooNewError';
  }
}

function userVersion(db: Database.Database): number {
  const n = Number(db.pragma('user_version', { simple: true }));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** The recorded steps past `after`, in order. None when the table is not there. */
function recordedAfter(db: Database.Database, after: number): Array<{ step: number; additive: number; release: string | null }> {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_steps'`).get()) return [];
  return db.prepare(`SELECT step, additive, release FROM schema_steps WHERE step > ? ORDER BY step`).all(after) as Array<{ step: number; additive: number; release: string | null }>;
}

/**
 * Where this database stands. Reads only, so `hatchabot doctor` asks it of
 * a read-only connection. The usual start costs one `PRAGMA user_version`.
 */
export function schemaStanding(db: Database.Database, steps: readonly SchemaStep[] = SCHEMA_STEPS): SchemaStanding {
  const code = steps.length;
  const numbered = userVersion(db);
  if (numbered === code) return { kind: 'current', db: numbered, code };
  // The record counts too when the number is behind: a copy made by dumping
  // and reloading the database keeps the table and loses user_version.
  const past = recordedAfter(db, code);
  const at = Math.max(numbered, past.at(-1)?.step ?? 0);
  if (at <= code) return { kind: 'behind', db: numbered, code };
  const notAdditive: number[] = [];
  const unrecorded: number[] = [];
  const byStep = new Map(past.map((r) => [r.step, r]));
  for (let n = code + 1; n <= at; n++) {
    const r = byStep.get(n);
    if (!r) unrecorded.push(n);
    else if (r.additive !== 1) notAdditive.push(n);
  }
  const newest = past.at(-1);
  const writtenBy = newest?.step === at && newest.release ? newest.release : undefined;
  return { kind: 'newer', db: at, code, refused: notAdditive.length > 0 || unrecorded.length > 0, ...(writtenBy ? { writtenBy } : {}), notAdditive, unrecorded };
}

/** "step 114", "steps 113 and 114", "steps 113 to 115", "steps 113, 115 and 117". */
export function stepsText(ns: readonly number[]): string {
  if (ns.length === 1) return `step ${ns[0]}`;
  if (ns.length > 2 && ns.every((n, i) => i === 0 || n === ns[i - 1]! + 1)) return `steps ${ns[0]} to ${ns.at(-1)}`;
  return `steps ${ns.slice(0, -1).join(', ')} and ${ns.at(-1)}`;
}

/** `v2.195.0`, or the word for a release with no version (a checkout with no package.json). */
const named = (release: string): string => (/^\d/.test(release) ? `v${release}` : release);

/** "a newer Hatchabot (v2.195.0, schema 115) than this one (v2.191.0, schema 112)". */
function newerThanThis(s: SchemaStanding, release: string): string {
  return `a newer Hatchabot (${s.writtenBy ? `${named(s.writtenBy)}, ` : ''}schema ${s.db}) than this one (${named(release)}, schema ${s.code})`;
}

/** The release to install, as the start's message and the doctor's fix name it. */
export function schemaInstallAdvice(s: SchemaStanding): string {
  return s.writtenBy && /^\d/.test(s.writtenBy)
    ? `Install ${named(s.writtenBy)} or newer (hatchabot upgrade ${named(s.writtenBy)})`
    : 'Install the release that wrote it, or newer (hatchabot upgrade)';
}

/**
 * What a start says of a database newer than this release: the message it
 * refuses with, or the one warning it logs. undefined when it is not newer.
 */
export function schemaNewerMessage(s: SchemaStanding, release: string = APP_VERSION): string | undefined {
  if (s.kind !== 'newer') return undefined;
  const past = Array.from({ length: s.db - s.code }, (_, i) => s.code + 1 + i);
  if (!s.refused) {
    const one = past.length === 1;
    return `This database was written by ${newerThanThis(s, release)}. Schema ${stepsText(past)} only add${one ? 's' : ''} to it, so this release runs; what ${one ? 'it' : 'they'} added goes unused until the newer release is back. ${schemaInstallAdvice(s)} to use it.`;
  }
  const why = s.notAdditive?.length
    ? `schema ${stepsText(s.notAdditive)} changed it in a way this release cannot work with`
    : `nothing in it records what schema ${stepsText(s.unrecorded?.length ? s.unrecorded : past)} did, so this release cannot tell that it is safe to run`;
  return `This database was written by ${newerThanThis(s, release)}, and ${why}. Hatchabot is not starting, and has changed nothing in the database. ${schemaInstallAdvice(s)}.`;
}

/**
 * The check a start makes before it touches the database: throws
 * `SchemaTooNewError` on a database this release must not run on, and logs
 * one warning on one that is newer by additive steps only.
 */
export function checkSchemaVersion(db: Database.Database, steps: readonly SchemaStep[] = SCHEMA_STEPS,
  opts: { release?: string; warn?: (message: string) => void } = {}): SchemaStanding {
  const standing = schemaStanding(db, steps);
  const message = schemaNewerMessage(standing, opts.release ?? APP_VERSION);
  if (!message) return standing;
  if (standing.refused) throw new SchemaTooNewError(standing, message);
  (opts.warn ?? ((m: string) => console.warn(`[store] ${m}`)))(message);
  return standing;
}

/** One `ALTER TABLE … ADD COLUMN …`, and nothing after it. */
const ADD_COLUMN = /^\s*ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\s+\w+[^;]*;?\s*$/i;

/**
 * Run the steps a database has not had, in order, and record each: one
 * transaction, so it is brought up whole or left as it was. Returns how
 * many it ran. Does nothing on a database at this number or past it.
 *
 * A database from before the schema had a number (0) starts at step 1,
 * like a new one: each step that finds its column already there is
 * recorded as done, which is what every start did before, so nothing in
 * it changes but the columns it was missing. That is also why a column
 * already there stays an accepted outcome: a new database has it from its
 * `CREATE TABLE`. Any other failure stops the start.
 */
export function applySchemaSteps(db: Database.Database, steps: readonly SchemaStep[] = SCHEMA_STEPS, release: string = APP_VERSION): number {
  steps.forEach((s, i) => {
    if (s.n !== i + 1) throw new Error(`Schema step ${i + 1} is numbered ${s.n}: steps are numbered by their place and only ever appended (src/store/schemaVersion.ts).`);
  });
  if (userVersion(db) >= steps.length) return 0;
  return db.transaction((): number => {
    // Read again under the write lock: another process may have just done this.
    const from = userVersion(db);
    if (from >= steps.length) return 0;
    db.exec(`CREATE TABLE IF NOT EXISTS schema_steps (step INTEGER PRIMARY KEY, additive INTEGER NOT NULL, release TEXT NOT NULL, at TEXT NOT NULL)`);
    // OR IGNORE: a step recorded before (the number was lost, not the record) keeps the release that first ran it.
    const record = db.prepare(`INSERT OR IGNORE INTO schema_steps (step, additive, release, at) VALUES (?, ?, ?, ?)`);
    const at = new Date().toISOString();
    for (const step of steps.slice(from)) {
      try {
        db.exec(step.sql);
      } catch (e) {
        // Only "column already exists", and only for a step that adds one
        // column: a malformed step (a typo, a missing table) must surface.
        if (!(ADD_COLUMN.test(step.sql) && /duplicate column name/i.test(String((e as Error)?.message ?? e)))) throw e;
      }
      record.run(step.n, step.additive ? 1 : 0, release, at);
    }
    db.pragma(`user_version = ${steps.length}`);
    return steps.length - from;
  }).immediate();
}

/**
 * A fingerprint per step, each chained to the one before it, so a change to
 * step 37 changes every fingerprint from 37 on. test/schemaVersion.test.ts
 * keeps the recorded list.
 */
export function stepFingerprints(steps: readonly SchemaStep[] = SCHEMA_STEPS): string[] {
  const out: string[] = [];
  let prev = '';
  for (const s of steps) {
    prev = createHash('sha256').update(`${prev}\n${s.n}\n${s.additive ? 'additive' : 'not additive'}\n${s.sql}`).digest('hex').slice(0, 12);
    out.push(prev);
  }
  return out;
}
