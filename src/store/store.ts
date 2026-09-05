import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  Agent,
  AgentEnvVar,
  AgentState,
  AIProfile,
  Channel,
  DataSource,
  DerivedImage,
  DerivedImageStatus,
  GroupAccess,
  TemplateParam,
  Host,
  Membership,
  MemberRole,
} from '../domain/types.js';
import { assertTransition } from '../domain/stateMachine.js';

/**
 * SQLite for the MVP; the interface is narrow enough that swapping in Postgres
 * is one file. Every write that changes agent state goes through
 * `setAgentState`, which enforces the §11.4 transition table — there is no
 * other way to move an agent between states.
 */
export class Store {
  constructor(private readonly db: Database.Database) {
    this.#migrate();
  }

  #migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS ai_profiles (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
        vendor TEXT NOT NULL, kind TEXT NOT NULL, model TEXT NOT NULL,
        secret_ref TEXT, created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hosts (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL,
        provider TEXT NOT NULL, name TEXT NOT NULL, settings TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
        slug TEXT NOT NULL, state TEXT NOT NULL, state_reason TEXT,
        ai_profile_id TEXT NOT NULL, host_id TEXT NOT NULL, runtime_ref TEXT,
        persona TEXT NOT NULL, shared_memory INTEGER NOT NULL DEFAULT 0,
        pending_action TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS agents_owner_slug ON agents (owner_id, slug);

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL,
        account_id TEXT NOT NULL, secret_ref TEXT NOT NULL, deep_link TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS channels_agent ON channels (agent_id);

      CREATE TABLE IF NOT EXISTS memberships (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, user_id TEXT NOT NULL,
        role TEXT NOT NULL, channel_user_id TEXT, status TEXT NOT NULL,
        invited_by TEXT, joined_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS memberships_agent_user
        ON memberships (agent_id, user_id);

      -- Point-in-time copies of an agent's core files. Small (KBs) and cheap,
      -- so they can be taken automatically before anything risky.
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, label TEXT NOT NULL,
        reason TEXT NOT NULL, files TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS snapshots_agent ON snapshots (agent_id, created_at);

      -- Long-lived tokens for non-browser clients (the CLI, scripts, a future
      -- phone app). Stored hashed: a database leak must not yield usable
      -- credentials. Independent of how the owner signs in, so Google-only
      -- accounts get CLI access too.
      CREATE TABLE IF NOT EXISTS cli_tokens (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS cli_tokens_owner ON cli_tokens (owner_id);

      -- Last heartbeat from the (separate-process) management bot, so the web
      -- UI can show that it exists, is alive, and how it's armed. One row per
      -- owner; staleness is derived from seen_at, never stored.
      CREATE TABLE IF NOT EXISTS mgmt_heartbeat (
        owner_id TEXT PRIMARY KEY, bot_username TEXT NOT NULL,
        mode TEXT NOT NULL, llm TEXT, allowlisted INTEGER NOT NULL,
        seen_at TEXT NOT NULL
      );

      -- Child→master distillation proposals (lineage flows): a child's
      -- generalized learning awaiting the owner's review on the master.
      CREATE TABLE IF NOT EXISTS agent_proposals (
        id TEXT PRIMARY KEY, master_agent_id TEXT NOT NULL,
        child_agent_id TEXT NOT NULL, child_name TEXT NOT NULL,
        text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS proposals_master ON agent_proposals (master_agent_id, status);

      -- Platform-managed external-service connections (Phase 2 of
      -- docs/connections-design.md): the refresh token is a credential, so
      -- only its SecretStore ref is here. Per-owner; attached to agents via
      -- agent_connections and materialized onto the volume at provision.
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL,
        email TEXT NOT NULL, services TEXT, secret_ref TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS connections_owner_email
        ON connections (owner_id, kind, email);
      CREATE TABLE IF NOT EXISTS agent_connections (
        agent_id TEXT NOT NULL, connection_id TEXT NOT NULL,
        gmail_no_send INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, connection_id)
      );

      -- Other AgentClaw installations this owner can move agents to. The
      -- access token is a credential, so it lives in the SecretStore and only
      -- its ref is here.
      CREATE TABLE IF NOT EXISTS peers (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
        url TEXT NOT NULL, secret_ref TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS peers_owner ON peers (owner_id);

      -- What has happened to each agent. The orchestrators already emit these
      -- as log lines; persisting them is what turns "it broke on Tuesday" from
      -- unanswerable into a card the owner can read.
      CREATE TABLE IF NOT EXISTS agent_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL, at TEXT NOT NULL,
        event TEXT NOT NULL, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS agent_events_at ON agent_events (agent_id, id DESC);

      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, code TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL, redeemed_at TEXT, redeemed_by TEXT
      );

      -- Everything an agent can access, unified across kinds (folder, git, …)
      -- so "what data does this agent have?" is one query. Legacy read-only
      -- folders still live on agents.shared_paths; these are the richer sources.
      CREATE TABLE IF NOT EXISTS data_sources (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
        kind TEXT NOT NULL, access TEXT NOT NULL, mount_name TEXT NOT NULL,
        host_path TEXT, repo_url TEXT, secret_ref TEXT, pub_key TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_env (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
        name TEXT NOT NULL, secret_ref TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(agent_id, name)
      );
      -- Manual ordering of group SECTIONS, per viewer (each account orders its
      -- own list). Absent groups fall back to alphabetical.
      CREATE TABLE IF NOT EXISTS agent_group_order (
        owner_id TEXT NOT NULL, group_name TEXT NOT NULL, sort_order INTEGER NOT NULL,
        PRIMARY KEY (owner_id, group_name)
      );
      -- Verbatim workspace files a template import wants seeded at first provision
      -- (its trained SOUL.md / AGENTS.md). Read by buildRuntimeSpec; the seed
      -- script only writes files that don't already exist, so it's a one-time seed.
      CREATE TABLE IF NOT EXISTS agent_seed (
        agent_id TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL,
        PRIMARY KEY (agent_id, name)
      );
      CREATE INDEX IF NOT EXISTS data_sources_agent ON data_sources (agent_id);

      -- Who has signed in, so a share can be addressed by email. Email is
      -- mutable, so owner_id (the stable subject) is the key; email is the
      -- lookup. Refreshed on every sign-in.
      CREATE TABLE IF NOT EXISTS accounts (
        owner_id TEXT PRIMARY KEY,
        email TEXT,
        last_seen TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS accounts_email ON accounts (email);

      -- An agent handed to another user in-app: a secret-free TEMPLATE blob
      -- waiting in their inbox. to_owner is bound once the recipient email is
      -- a known account (possibly on their first sign-in). status:
      -- pending | accepted | dismissed.
      CREATE TABLE IF NOT EXISTS agent_shares (
        id TEXT PRIMARY KEY,
        from_owner TEXT NOT NULL,
        from_email TEXT,
        to_email TEXT NOT NULL,
        to_owner TEXT,
        agent_name TEXT NOT NULL,
        message TEXT,
        blob BLOB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS shares_to_owner ON agent_shares (to_owner, status);
      CREATE INDEX IF NOT EXISTS shares_to_email ON agent_shares (to_email, status);

      -- NOCASE variants: the email/account lookups query with COLLATE NOCASE,
      -- which a binary-collated index cannot serve (full scan). Tiny today;
      -- structurally wrong forever (audit 2026-09-02).
      CREATE INDEX IF NOT EXISTS accounts_email_nocase ON accounts (email COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS shares_to_email_nocase ON agent_shares (to_email COLLATE NOCASE, status);
      CREATE INDEX IF NOT EXISTS channels_account_nocase ON channels (account_id COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS invites_agent ON invites (agent_id);

      -- Runtime images an owner built FROM the base + their own Dockerfile lines
      -- (system packages a volume install can't provide). The dockerfile is kept
      -- so the image can be rebuilt against a newer base. Host-scoped, not
      -- owner-partitioned: an image is a machine-level artifact (like the base),
      -- and building/pinning is already host-owner gated at the API. status:
      -- BUILDING | READY | FAILED.
      CREATE TABLE IF NOT EXISTS derived_images (
        name TEXT PRIMARY KEY,
        tag TEXT NOT NULL,
        base TEXT NOT NULL,
        dockerfile TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'BUILDING',
        error TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        built_at TEXT
      );
    `);
    // Additive dev migrations for databases created before these columns
    // existed. Harmless when the column is already there.
    for (const alter of [
      `ALTER TABLE agents ADD COLUMN shared_memory INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE agents ADD COLUMN pending_action TEXT`,
      `ALTER TABLE memberships ADD COLUMN display_name TEXT`,
      `ALTER TABLE ai_profiles ADD COLUMN models TEXT`,
      `ALTER TABLE ai_profiles ADD COLUMN base_url TEXT`,
      `ALTER TABLE cli_tokens ADD COLUMN expires_at TEXT`,
      `ALTER TABLE agents ADD COLUMN applied_profile_id TEXT`,
      `ALTER TABLE agents ADD COLUMN applied_model TEXT`,
      `ALTER TABLE agents ADD COLUMN migrated_to TEXT`,
      `ALTER TABLE agents ADD COLUMN shared_paths TEXT`,
      `ALTER TABLE agents ADD COLUMN gateway_port INTEGER`,
      `ALTER TABLE agents ADD COLUMN gateway_token TEXT`,
      `ALTER TABLE ai_profiles ADD COLUMN shared INTEGER NOT NULL DEFAULT 0`,
      // The management bot's LLM rides this source (single-select per owner).
      `ALTER TABLE ai_profiles ADD COLUMN mgmt_llm INTEGER NOT NULL DEFAULT 0`,
      // Optional per-agent model override (cloud only). NULL = follow the
      // profile's default model.
      `ALTER TABLE agents ADD COLUMN model TEXT`,
      // Owner-defined organization: an optional group label and a manual order.
      `ALTER TABLE agents ADD COLUMN group_name TEXT`,
      `ALTER TABLE agents ADD COLUMN image TEXT`,
      `ALTER TABLE agents ADD COLUMN sort_order INTEGER`,
      // Bind an adopted agent's folder at its original host path, so existing
      // absolute-path references resolve unchanged.
      `ALTER TABLE data_sources ADD COLUMN mount_at_host_path INTEGER NOT NULL DEFAULT 0`,
      // Last git clone/refresh result, so a repo that never cloned (usually its
      // deploy key isn't on the host yet) is visible on the card instead of
      // only in the audit log.
      `ALTER TABLE data_sources ADD COLUMN sync_error TEXT`,
      `ALTER TABLE data_sources ADD COLUMN synced_at TEXT`,
      // Setup fields this agent's shares/templates ask the importer to fill
      // (JSON array of TemplateParam; sharing Phase 2a).
      `ALTER TABLE agents ADD COLUMN params TEXT`,
      // A configured template copy's editable state: the values applied and
      // the raw placeholder-bearing layer they render into (JSON) — what lets
      // setup values be edited or reset later without a re-import.
      `ALTER TABLE agents ADD COLUMN param_values TEXT`,
      `ALTER TABLE agents ADD COLUMN param_files TEXT`,
      // Telegram group-chat access (domain/types.ts GroupAccess), JSON.
      `ALTER TABLE agents ADD COLUMN group_access TEXT`,
      // Lineage: the master this agent was derived from (same installation).
      `ALTER TABLE agents ADD COLUMN parent_agent_id TEXT`,
      // Telegram rich formatting: NULL = managed default (on), 0 = opt-out.
      `ALTER TABLE agents ADD COLUMN rich_messages INTEGER`,
      // Template-carried schedules awaiting the gateway (applied on RUNNING).
      `ALTER TABLE agents ADD COLUMN pending_schedules TEXT`,
      // Which agent a share was cut from — lets an accepted copy record lineage.
      `ALTER TABLE agent_shares ADD COLUMN source_agent_id TEXT`,
      // Installation-wide default AI source for NEW agents (single-select):
      // preselected in the create form and preferred by importTemplate's
      // silent fallback — the "household default" once per-member profiles
      // are retired. Only applies where the profile is visible (own/shared).
      `ALTER TABLE ai_profiles ADD COLUMN default_source INTEGER NOT NULL DEFAULT 0`,
      // The account's linked Telegram identity ("That's me" on a pairing card):
      // the durable, account-level form of what knownChannelUserId used to
      // infer from membership rows — survives deleting every agent, and lets a
      // FRESH account link on its very first approval.
      `ALTER TABLE accounts ADD COLUMN telegram_user_id TEXT`,
    ]) {
      try {
        this.db.exec(alter);
      } catch (e) {
        // Swallow only "column already exists" — a genuinely malformed ALTER
        // (typo, missing table) must surface, not run against a broken schema.
        if (!/duplicate column name/i.test(String((e as Error)?.message ?? e))) throw e;
      }
    }
    // Indexes on ALTER-added columns must come AFTER the additive loop — on a
    // fresh DB the CREATE TABLE block doesn't have the column yet.
    this.db.exec(`CREATE INDEX IF NOT EXISTS agents_image ON agents (image)`);
    // The one-management-source-per-owner invariant, enforced by the schema
    // instead of living only in setAIProfileMgmtLlm's clear-then-set.
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ai_profiles_mgmt_llm_one
         ON ai_profiles (owner_id) WHERE mgmt_llm = 1`,
    );
    // One installation-wide default source, schema-enforced like mgmt_llm.
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ai_profiles_default_one
         ON ai_profiles (default_source) WHERE default_source = 1`,
    );

    // Backfill order for agents created before sort_order existed: rowid is the
    // insertion sequence, so this preserves the old created-at order. Runs once
    // (new agents get an explicit sort_order); idempotent via the NULL guard.
    this.db.exec(`UPDATE agents SET sort_order = rowid WHERE sort_order IS NULL`);

    // Agents provisioned before applied-tracking existed were configured with
    // whatever profile they still point at. Backfill, so the "will switch on
    // rebuild" badge doesn't fire spuriously for every pre-existing agent.
    this.db.exec(`
      UPDATE agents SET
        applied_profile_id = ai_profile_id,
        applied_model = (SELECT model FROM ai_profiles WHERE id = agents.ai_profile_id)
      WHERE applied_profile_id IS NULL AND state != 'DELETED'
    `);

    // CLI tokens minted before expires_at existed carry NULL — which
    // ownerForCliToken treats as ETERNAL, contradicting the bounded-lifetime
    // design (a pre-migration token was found live in prod, audit 2026-09-02).
    // Bound them to 90 days from now: long enough that whoever depends on one
    // sees it working while they rotate, finite so it can't outlive everyone.
    this.db
      .prepare(`UPDATE cli_tokens SET expires_at = ? WHERE expires_at IS NULL`)
      .run(new Date(Date.now() + 90 * 86400000).toISOString());

    // Tombstone hygiene: DELETED agents are kept as rows (slug bookkeeping),
    // but must not retain credential material or member PII. Older deletes
    // left gateway tokens and memberships behind (13 tokens / 24 membership
    // rows found in prod, audit 2026-09-02); scrub them here once, and the
    // delete path now scrubs going forward (scrubAgentResidue).
    this.db.exec(`
      UPDATE agents SET gateway_token = NULL, gateway_port = NULL
        WHERE state = 'DELETED' AND (gateway_token IS NOT NULL OR gateway_port IS NOT NULL);
      DELETE FROM memberships WHERE agent_id IN (SELECT id FROM agents WHERE state = 'DELETED');
      DELETE FROM invites     WHERE agent_id IN (SELECT id FROM agents WHERE state = 'DELETED');
      DELETE FROM data_sources WHERE agent_id IN (SELECT id FROM agents WHERE state = 'DELETED');
      DELETE FROM agent_env   WHERE agent_id IN (SELECT id FROM agents WHERE state = 'DELETED');
      DELETE FROM agent_seed  WHERE agent_id IN (SELECT id FROM agents WHERE state = 'DELETED');
      DELETE FROM agent_proposals WHERE master_agent_id IN (SELECT id FROM agents WHERE state = 'DELETED');
    `);
  }

  /**
   * Remove everything a tombstone must not keep: gateway credentials and the
   * child rows (memberships hold Telegram user IDs = PII; source/env/seed rows
   * would dangle). Secrets themselves are deleted by the caller first — this
   * only clears rows and refs. Idempotent; also re-run for ALL tombstones by
   * the migration above, so pre-fix deletes get cleaned too.
   */
  scrubAgentResidue(agentId: string): void {
    this.db
      .prepare(`UPDATE agents SET gateway_token = NULL, gateway_port = NULL WHERE id = ?`)
      .run(agentId);
    for (const t of ['memberships', 'invites', 'data_sources', 'agent_env', 'agent_seed'] as const) {
      this.db.prepare(`DELETE FROM ${t} WHERE agent_id = ?`).run(agentId);
    }
    // Proposals addressed TO a deleted master are unreachable (no route can
    // list or resolve them) and hold up to 20KB of model-written text about
    // the household — same tombstone-hygiene rule as the rows above. Child-
    // side rows stay: a live master's owner can still review them.
    this.db.prepare(`DELETE FROM agent_proposals WHERE master_agent_id = ?`).run(agentId);
    this.db.prepare(`DELETE FROM agent_connections WHERE agent_id = ?`).run(agentId);
  }

  /**
   * Delete telegram bot-token secrets no table references anymore. A failed
   * best-effort pool release on agent delete leaks exactly this way (2 live
   * orphaned tokens found in prod, audit 2026-09-02). Only 'telegram/bot/*'
   * refs are eligible — fixed-ref secrets (media key) and per-channel/env/
   * source secrets have their own lifecycles. The referencing tables span
   * modules (channels here, telegram_pool/peers elsewhere in the same DB), so
   * call this AFTER all stores are constructed; missing tables abort silently.
   */
  sweepOrphanBotSecrets(): string[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT ref FROM secrets
           WHERE ref LIKE 'telegram/bot/%'
             AND ref NOT IN (SELECT secret_ref FROM channels)
             AND ref NOT IN (SELECT secret_ref FROM telegram_pool)
             AND ref NOT IN (SELECT secret_ref FROM peers)`,
        )
        .all() as Array<{ ref: string }>;
      if (rows.length) {
        const del = this.db.prepare(`DELETE FROM secrets WHERE ref = ?`);
        for (const { ref } of rows) del.run(ref);
      }
      return rows.map((r) => r.ref);
    } catch {
      return []; // a table doesn't exist yet (fresh install mid-boot) — skip
    }
  }

  // ---- AI profiles -------------------------------------------------------

  insertAIProfile(p: AIProfile): void {
    this.db
      .prepare(
        `INSERT INTO ai_profiles (id, owner_id, name, vendor, kind, model, models, base_url,
                                  secret_ref, shared, created_at)
         VALUES (@id, @ownerId, @name, @vendor, @kind, @model, @models, @baseUrl,
                 @secretRef, @shared, @createdAt)`,
      )
      .run({
        secretRef: null,
        baseUrl: null,
        ...p,
        models: p.models ? JSON.stringify(p.models) : null,
        shared: p.shared ? 1 : 0,
      });
  }

  setAIProfileShared(id: string, shared: boolean): void {
    this.db.prepare(`UPDATE ai_profiles SET shared = ? WHERE id = ?`).run(shared ? 1 : 0, id);
  }

  /** Single-select per owner: which source backs the management bot's LLM.
   *  Pass null to clear the owner's pick entirely. One transaction: a clear
   *  followed by a failed set (stale/foreign id) must not silently drop the
   *  existing pick. */
  setAIProfileMgmtLlm(ownerId: string, profileId: string | null): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE ai_profiles SET mgmt_llm = 0 WHERE owner_id = ?`).run(ownerId);
      if (profileId) {
        const set = this.db
          .prepare(`UPDATE ai_profiles SET mgmt_llm = 1 WHERE id = ? AND owner_id = ?`)
          .run(profileId, ownerId);
        // Roll the clear back too — a stale/foreign id must not eat the pick.
        if (set.changes !== 1) throw new Error(`No AI profile ${profileId} owned by ${ownerId}`);
      }
    })();
  }

  /** Single-select installation-wide: the default source for NEW agents.
   *  Pass null to clear. Same transactional clear-then-set as mgmt_llm. */
  setAIProfileDefault(profileId: string | null): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE ai_profiles SET default_source = 0 WHERE default_source = 1`).run();
      if (profileId) {
        const set = this.db
          .prepare(`UPDATE ai_profiles SET default_source = 1 WHERE id = ?`)
          .run(profileId);
        if (set.changes !== 1) throw new Error(`No AI profile ${profileId}`);
      }
    })();
  }

  setAIProfileModel(id: string, model: string): void {
    this.db.prepare(`UPDATE ai_profiles SET model = ? WHERE id = ?`).run(model, id);
  }

  deleteAIProfile(id: string): void {
    this.db.prepare(`DELETE FROM ai_profiles WHERE id = ?`).run(id);
  }

  setAIProfileModels(id: string, models: string[] | undefined): void {
    this.db
      .prepare(`UPDATE ai_profiles SET models = ? WHERE id = ?`)
      .run(models ? JSON.stringify(models) : null, id);
  }

  getAIProfile(id: string): AIProfile | undefined {
    const r = this.db.prepare(`SELECT * FROM ai_profiles WHERE id = ?`).get(id) as any;
    return r ? rowToAIProfile(r) : undefined;
  }

  listAIProfiles(ownerId: string): AIProfile[] {
    // Own profiles plus any another account deliberately shared with the
    // installation (see AIProfile.shared) — the shared-host counterpart for
    // credentials, opt-in instead of automatic because it is shared spend.
    const rows = this.db
      .prepare(`SELECT * FROM ai_profiles WHERE owner_id = ? OR shared = 1 ORDER BY created_at`)
      .all(ownerId) as any[];
    return rows.map(rowToAIProfile);
  }

  // ---- Hosts -------------------------------------------------------------

  insertHost(h: Host): void {
    this.db
      .prepare(
        `INSERT INTO hosts (id, owner_id, kind, provider, name, settings, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(h.id, h.ownerId, h.kind, h.provider, h.name, JSON.stringify(h.settings), h.createdAt);
  }

  listHosts(ownerId: string): Host[] {
    // A local host IS this machine — an installation resource, not one
    // account's possession. Every signed-in account may run agents on it
    // (the row's owner_id still records who set the server up; see the
    // subscription-profile guard in routes.ts for where that distinction
    // matters). Cloud hosts, when they exist, stay strictly per-owner.
    const rows = this.db
      .prepare(`SELECT id FROM hosts WHERE owner_id = ? OR kind = 'local' ORDER BY created_at`)
      .all(ownerId) as { id: string }[];
    return rows.map((r) => this.getHost(r.id)!).filter(Boolean);
  }

  deleteHost(id: string): void {
    this.db.prepare(`DELETE FROM hosts WHERE id = ?`).run(id);
  }

  getHost(id: string): Host | undefined {
    const r = this.db.prepare(`SELECT * FROM hosts WHERE id = ?`).get(id) as any;
    if (!r) return undefined;
    return {
      id: r.id,
      ownerId: r.owner_id,
      kind: r.kind,
      provider: r.provider,
      name: r.name,
      settings: safeJson(r.settings, {}),
      createdAt: r.created_at,
    };
  }

  // ---- Agents ------------------------------------------------------------

  insertAgent(a: Agent): void {
    this.db
      .prepare(
        `INSERT INTO agents (id, owner_id, name, slug, state, state_reason, ai_profile_id,
                             host_id, runtime_ref, persona, shared_memory, model, pending_action,
                             group_name, sort_order, created_at, updated_at)
         VALUES (@id, @ownerId, @name, @slug, @state, @stateReason, @aiProfileId,
                 @hostId, @runtimeRef, @persona, @sharedMemory, @model, @pendingAction,
                 @group, @sortOrder, @createdAt, @updatedAt)`,
      )
      .run({
        stateReason: null,
        runtimeRef: null,
        model: null,
        group: null,
        ...a,
        // Land new agents strictly last in their section. A per-owner max+1
        // avoids the ties a wall-clock stamp produced when two agents were
        // created in the same millisecond — which made "move up/down" (a swap)
        // a silent no-op.
        sortOrder: a.sortOrder ?? this.firstSortOrder(a.ownerId, a.group ?? null),
        sharedMemory: a.sharedMemory ? 1 : 0,
        pendingAction: a.pendingAction ? JSON.stringify(a.pendingAction) : null,
      });
  }

  setAgentPendingAction(id: string, action: Agent['pendingAction'] | null): void {
    this.db
      .prepare(`UPDATE agents SET pending_action = ?, updated_at = ? WHERE id = ?`)
      .run(action ? JSON.stringify(action) : null, new Date().toISOString(), id);
  }

  getAgent(id: string): Agent | undefined {
    const r = this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as any;
    return r ? rowToAgent(r) : undefined;
  }

  /** Every non-deleted agent regardless of owner — reconcile and ops sweeps. */
  listAllActiveAgents(): Agent[] {
    const rows = this.db
      .prepare(`SELECT * FROM agents WHERE state != 'DELETED' ORDER BY created_at`)
      .all() as any[];
    return rows.map(rowToAgent);
  }

  listAgents(ownerId: string): Agent[] {
    const rows = this.db
      // Ungrouped first, then groups (order applied in JS), each by sort_order.
      .prepare(`SELECT * FROM agents WHERE owner_id = ? AND state != 'DELETED' ORDER BY group_name, sort_order, created_at`)
      .all(ownerId) as any[];
    return this.orderByGroup(rows.map(rowToAgent), ownerId);
  }

  /** The viewer's manual section order: group_name → rank. */
  private groupOrder(ownerId: string): Map<string, number> {
    const rows = this.db
      .prepare(`SELECT group_name, sort_order FROM agent_group_order WHERE owner_id = ?`)
      .all(ownerId) as Array<{ group_name: string; sort_order: number }>;
    return new Map(rows.map((r) => [r.group_name, r.sort_order]));
  }

  /**
   * Stable-reorder a group_name-sorted agent list so SECTIONS follow the viewer's
   * manual order: ungrouped first, then ranked groups, then any unranked group
   * alphabetically. Within a group the incoming (sort_order) order is preserved.
   */
  private orderByGroup(agents: Agent[], ownerId: string): Agent[] {
    const rank = this.groupOrder(ownerId);
    const key = (a: Agent): [number, number, string] => {
      const g = a.group ?? null;
      if (g === null) return [0, 0, '']; // ungrouped first
      if (rank.has(g)) return [1, rank.get(g)!, g]; // ranked
      return [2, 0, g]; // unranked → after ranked, alphabetical
    };
    return agents.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      if (ka[0] !== kb[0]) return ka[0] - kb[0];
      if (ka[1] !== kb[1]) return ka[1] - kb[1];
      if (ka[2] !== kb[2]) return ka[2] < kb[2] ? -1 : 1;
      return 0; // same section — keep the incoming (within-group) order
    });
  }

  /**
   * Move a group section one place up/down in the viewer's list, by rewriting
   * the whole section order after the swap. Returns false at the boundary.
   */
  moveGroup(ownerId: string, groupName: string, dir: 'up' | 'down'): boolean {
    const groups = [
      ...new Set(this.listVisibleAgents(ownerId).map((a) => a.group).filter((g): g is string => !!g)),
    ];
    const i = groups.indexOf(groupName);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= groups.length) return false;
    [groups[i], groups[j]] = [groups[j]!, groups[i]!];
    const upsert = this.db.prepare(
      `INSERT INTO agent_group_order (owner_id, group_name, sort_order) VALUES (?, ?, ?)
       ON CONFLICT(owner_id, group_name) DO UPDATE SET sort_order = excluded.sort_order`,
    );
    this.db.transaction(() => groups.forEach((g, idx) => upsert.run(ownerId, g, idx)))();
    return true;
  }

  // ---- Template seed files (one-time, at first provision) -----------------

  setAgentSeed(agentId: string, files: Record<string, string>): void {
    const ins = this.db.prepare(
      `INSERT INTO agent_seed (agent_id, name, content) VALUES (?, ?, ?)
       ON CONFLICT(agent_id, name) DO UPDATE SET content = excluded.content`,
    );
    this.db.transaction(() => {
      for (const [name, content] of Object.entries(files)) ins.run(agentId, name, content);
    })();
  }

  getAgentSeed(agentId: string): Record<string, string> {
    const rows = this.db
      .prepare(`SELECT name, content FROM agent_seed WHERE agent_id = ?`)
      .all(agentId) as Array<{ name: string; content: string }>;
    return Object.fromEntries(rows.map((r) => [r.name, r.content]));
  }

  /**
   * Agents this account can see: the ones it owns, plus the ones it is an
   * active member of (docs/identity.md phase 4 — a family member logs in and
   * sees the shared agent, not an empty page).
   */
  listVisibleAgents(userId: string): Agent[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT a.* FROM agents a
         LEFT JOIN memberships m ON m.agent_id = a.id AND m.user_id = ? AND m.status = 'active'
         WHERE a.state != 'DELETED' AND (a.owner_id = ? OR m.user_id IS NOT NULL)
         ORDER BY a.group_name, a.sort_order, a.created_at`,
      )
      .all(userId, userId) as any[];
    return this.orderByGroup(rows.map(rowToAgent), userId);
  }

  /**
   * What this account may do with an agent: 'owner' (everything), 'admin',
   * 'user' (chat-level), or undefined (no access at all).
   */
  accessRole(agentId: string, userId: string): MemberRole | undefined {
    const agent = this.getAgent(agentId);
    if (!agent || agent.state === 'DELETED') return undefined;
    if (agent.ownerId === userId) return 'owner';
    const m = this.getMembership(agentId, userId);
    if (!m || m.status !== 'active') return undefined;
    return m.role as MemberRole;
  }

  /** The only path that changes agent state. Enforces the §11.4 transitions. */
  setAgentState(id: string, next: AgentState, reason?: string): Agent {
    const agent = this.getAgent(id);
    if (!agent) throw new Error(`No such agent: ${id}`);
    if (agent.state !== next) assertTransition(agent.state, next);
    this.db
      .prepare(`UPDATE agents SET state = ?, state_reason = ?, updated_at = ? WHERE id = ?`)
      .run(next, reason ?? null, new Date().toISOString(), id);
    return this.getAgent(id)!;
  }

  /**
   * Debug access to the agent's own OpenClaw Control UI: a host port and a
   * gateway auth token, allocated once and stable across rebuilds. Ports
   * start at 19100 and count up per installation. Allocation runs in a
   * transaction — two concurrent provisions must not get the same port.
   */
  ensureGatewayAccess(id: string): { port: number; token: string } {
    const alloc = this.db.transaction((agentId: string) => {
      const agent = this.getAgent(agentId);
      if (!agent) throw new Error(`No such agent: ${agentId}`);
      if (agent.gatewayPort && agent.gatewayToken) {
        return { port: agent.gatewayPort, token: agent.gatewayToken };
      }
      const row = this.db
        .prepare(`SELECT MAX(gateway_port) AS p FROM agents`)
        .get() as { p: number | null };
      // Base is configurable so a second installation on the same host uses a
      // different range (docker publishes these on the shared loopback). A
      // non-numeric override would poison Math.max with NaN, so validate it.
      const envBase = Number(process.env.AGENTCLAW_GATEWAY_PORT_BASE);
      const base = Number.isInteger(envBase) && envBase > 0 && envBase < 65536 ? envBase : 19100;
      const port = Math.max(base - 1, row.p ?? 0) + 1;
      const token = randomBytes(16).toString('hex');
      this.db
        .prepare(`UPDATE agents SET gateway_port = ?, gateway_token = ? WHERE id = ?`)
        .run(port, token, agentId);
      return { port, token };
    });
    return alloc(id);
  }

  setAgentRuntimeRef(id: string, runtimeRef: string): void {
    this.db
      .prepare(`UPDATE agents SET runtime_ref = ?, updated_at = ? WHERE id = ?`)
      .run(runtimeRef, new Date().toISOString(), id);
  }

  /** Reassign which host runs the agent — the Move-to-host flow only. The
   *  caller (moveHost.ts) owns the invariant that the runtime actually follows:
   *  flip, provision there, and on failure flip back. */
  setAgentHost(id: string, hostId: string): void {
    this.db
      .prepare(`UPDATE agents SET host_id = ?, updated_at = ? WHERE id = ?`)
      .run(hostId, new Date().toISOString(), id);
  }

  // ---- Channels ----------------------------------------------------------

  insertChannel(c: Channel): void {
    this.db
      .prepare(
        `INSERT INTO channels (id, agent_id, kind, account_id, secret_ref, deep_link, created_at)
         VALUES (@id, @agentId, @kind, @accountId, @secretRef, @deepLink, @createdAt)`,
      )
      .run(c);
  }

  getChannelForAgent(agentId: string): Channel | undefined {
    const r = this.db.prepare(`SELECT * FROM channels WHERE agent_id = ? LIMIT 1`).get(agentId) as any;
    if (!r) return undefined;
    return {
      id: r.id,
      agentId: r.agent_id,
      kind: r.kind,
      accountId: r.account_id,
      secretRef: r.secret_ref,
      deepLink: r.deep_link,
      createdAt: r.created_at,
    };
  }

  /**
   * The live agent (if any) already bound to this messaging identity. Guards
   * against wiring one bot token into two agents — Telegram delivers each
   * message to exactly one poller, so a double-use flip-flops between them.
   */
  findAgentUsingAccount(accountId: string): Agent | undefined {
    const row = this.db
      .prepare(
        // Telegram usernames are case-insensitive — match that way so this
        // two-poller guard can't be evaded by a differently-cased accountId
        // (e.g. one read verbatim from a hand-edited OpenClaw config).
        `SELECT a.id FROM channels c JOIN agents a ON a.id = c.agent_id
         WHERE c.account_id = ? COLLATE NOCASE AND a.state != 'DELETED' LIMIT 1`,
      )
      .get(accountId) as { id: string } | undefined;
    return row ? this.getAgent(row.id) : undefined;
  }

  deleteChannelForAgent(agentId: string): void {
    this.db.prepare(`DELETE FROM channels WHERE agent_id = ?`).run(agentId);
  }

  // ---- Memberships -------------------------------------------------------

  insertMembership(m: Membership): void {
    this.db
      .prepare(
        `INSERT INTO memberships (id, agent_id, user_id, role, display_name, channel_user_id,
                                  status, invited_by, joined_at)
         VALUES (@id, @agentId, @userId, @role, @displayName, @channelUserId, @status,
                 @invitedBy, @joinedAt)`,
      )
      .run({ channelUserId: null, invitedBy: null, joinedAt: null, displayName: null, ...m });
  }

  /**
   * docs/identity.md phase 3. A password-mode installation owns everything as
   * the single LOCAL_OWNER; the first person to sign in with a real account
   * adopts it. Guarded so it can only ever happen once: if any real account
   * already owns data here, this is a no-op and the caller gets nothing.
   *
   * Returns the number of rows re-keyed (0 = nothing to adopt).
   */
  /**
   * Run a synchronous unit of work atomically. better-sqlite3 transactions
   * are synchronous, so the callback must not await — used for multi-statement
   * invariants like "burn the invite AND create the membership, or neither".
   */
  transact<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- accounts (email <-> owner, for addressing shares) ------------------

  /** Record/refresh a signed-in account so shares can be addressed by email. */
  recordAccount(ownerId: string, email?: string): void {
    this.db
      .prepare(
        `INSERT INTO accounts (owner_id, email, last_seen) VALUES (?, ?, ?)
         ON CONFLICT(owner_id) DO UPDATE SET
           email = COALESCE(excluded.email, accounts.email),
           last_seen = excluded.last_seen`,
      )
      .run(ownerId, email ?? null, new Date().toISOString());
  }

  /** The owner behind an email, if that email has ever signed in. Case-insensitive. */
  ownerForEmail(email: string): string | undefined {
    const r = this.db
      .prepare(`SELECT owner_id FROM accounts WHERE email = ? COLLATE NOCASE`)
      .get(email.trim()) as { owner_id: string } | undefined;
    return r?.owner_id;
  }

  /** Known accounts other than `exceptOwner` — the recipient picker for a share. */
  listAccounts(exceptOwner?: string): Array<{ ownerId: string; email?: string }> {
    return (
      this.db
        .prepare(`SELECT owner_id, email FROM accounts WHERE email IS NOT NULL ORDER BY email`)
        .all() as Array<{ owner_id: string; email: string | null }>
    )
      .filter((r) => r.owner_id !== exceptOwner)
      .map((r) => ({ ownerId: r.owner_id, email: r.email ?? undefined }));
  }

  // ---- agent shares (the inbox) -------------------------------------------

  insertShare(s: {
    id: string;
    fromOwner: string;
    fromEmail?: string;
    toEmail: string;
    toOwner?: string;
    agentName: string;
    message?: string;
    blob: Buffer;
    createdAt: string;
    /** Lineage: which agent this share was cut from (same installation). */
    sourceAgentId?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO agent_shares
           (id, from_owner, from_email, to_email, to_owner, agent_name, message, blob, status, created_at, source_agent_id)
         VALUES (@id, @fromOwner, @fromEmail, @toEmail, @toOwner, @agentName, @message, @blob, 'pending', @createdAt, @sourceAgentId)`,
      )
      .run({
        id: s.id, fromOwner: s.fromOwner, fromEmail: s.fromEmail ?? null,
        toEmail: s.toEmail, toOwner: s.toOwner ?? null, agentName: s.agentName,
        message: s.message ?? null, blob: s.blob, createdAt: s.createdAt,
        sourceAgentId: s.sourceAgentId ?? null,
      });
  }

  /** Pending shares addressed to this owner (by bound owner OR their email). */
  listInbox(ownerId: string, email?: string): Array<{
    id: string; fromEmail?: string; agentName: string; message?: string; createdAt: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, from_email, agent_name, message, created_at FROM agent_shares
         WHERE status = 'pending' AND (to_owner = ? OR (to_owner IS NULL AND to_email = ? COLLATE NOCASE))
         ORDER BY created_at DESC`,
      )
      .all(ownerId, email ?? '\u0000') as Array<any>;
    return rows.map((r) => ({
      id: r.id, fromEmail: r.from_email ?? undefined, agentName: r.agent_name,
      message: r.message ?? undefined, createdAt: r.created_at,
    }));
  }

  /** A share the given owner may act on (theirs by owner or unclaimed email). */
  getShareFor(
    id: string,
    ownerId: string,
    email?: string,
  ): { blob: Buffer; agentName: string; sourceAgentId?: string } | undefined {
    const r = this.db
      .prepare(
        `SELECT blob, agent_name, to_owner, to_email, status, source_agent_id FROM agent_shares WHERE id = ?`,
      )
      .get(id) as any;
    if (!r || r.status !== 'pending') return undefined;
    const mine = r.to_owner === ownerId || (r.to_owner == null && email && r.to_email?.toLowerCase() === email.toLowerCase());
    return mine
      ? { blob: r.blob as Buffer, agentName: r.agent_name, sourceAgentId: r.source_agent_id ?? undefined }
      : undefined;
  }

  setShareStatus(id: string, status: 'accepted' | 'dismissed', ownerId: string): void {
    this.db
      .prepare(`UPDATE agent_shares SET status = ?, to_owner = COALESCE(to_owner, ?) WHERE id = ?`)
      .run(status, ownerId, id);
  }

  /** On sign-in, bind any email-addressed pending shares to this owner. */
  claimSharesForEmail(ownerId: string, email: string): number {
    return this.db
      .prepare(
        `UPDATE agent_shares SET to_owner = ?
         WHERE to_owner IS NULL AND status = 'pending' AND to_email = ? COLLATE NOCASE`,
      )
      .run(ownerId, email.trim()).changes;
  }

  adoptLocalOwnerData(newOwnerId: string, localOwner = 'dev-owner'): number {
    if (newOwnerId === localOwner) return 0;
    const adopt = this.db.transaction((owner: string) => {
      const claimed = this.db
        .prepare(`SELECT COUNT(*) AS n FROM agents WHERE owner_id != ?`)
        .get(localOwner) as { n: number };
      const claimedProfiles = this.db
        .prepare(`SELECT COUNT(*) AS n FROM ai_profiles WHERE owner_id != ?`)
        .get(localOwner) as { n: number };
      if (claimed.n > 0 || claimedProfiles.n > 0) return 0; // already adopted
      let rows = 0;
      for (const sql of [
        `UPDATE agents SET owner_id = ? WHERE owner_id = ?`,
        `UPDATE ai_profiles SET owner_id = ? WHERE owner_id = ?`,
        `UPDATE hosts SET owner_id = ? WHERE owner_id = ?`,
        `UPDATE memberships SET user_id = ? WHERE user_id = ?`,
        // Every column that keys off the owner id, or the row silently
        // orphans under dev-owner: peer servers (else migration targets
        // vanish on first sign-in), and the two membership/invite back-refs.
        `UPDATE memberships SET invited_by = ? WHERE invited_by = ?`,
        `UPDATE peers SET owner_id = ? WHERE owner_id = ?`,
        `UPDATE invites SET created_by = ? WHERE created_by = ?`,
        `UPDATE invites SET redeemed_by = ? WHERE redeemed_by = ?`,
        // Without this a CLI token keeps working as the old owner and returns
        // an EMPTY fleet — "all my agents are gone" instead of "log in again".
        `UPDATE cli_tokens SET owner_id = ? WHERE owner_id = ?`,
      ]) {
        rows += this.db.prepare(sql).run(owner, localOwner).changes;
      }
      return rows;
    });
    return adopt(newOwnerId);
  }

  // ---- Events --------------------------------------------------------------

  /** Keep the newest `keep` events per agent; older ones are pruned on write. */
  recordEvent(agentId: string, event: string, detail?: Record<string, unknown>, keep = 200): void {
    // A timer firing after deletion (claim windows, notifiers) must not write
    // onto a tombstone — the residue class the v0.90 scrub cleaned up
    // (audit 2026-09-04 #7). Unknown agents are refused for the same reason.
    const state = (this.db.prepare(`SELECT state FROM agents WHERE id = ?`).get(agentId) as any)?.state;
    if (!state || state === 'DELETED') return;
    // Never let a log line become a way to store secrets or unbounded data.
    // Truncation must stay valid JSON: one raw .slice() mid-string made every
    // listEvents() call throw until the row aged out — the activity feed
    // bricking itself exactly when a long docker error was worth reading.
    let safe = detail ? JSON.stringify(detail) : null;
    if (safe && safe.length > 2000) {
      // Slice conservatively: wrapping the sliced JSON as a string value
      // re-escapes it (quotes/backslashes ~double), so 900 raw chars keeps
      // the STORED value under the 2000 bound rather than overshooting it.
      safe = JSON.stringify({ truncated: true, detail: safe.slice(0, 900) });
    }
    this.db
      .prepare(`INSERT INTO agent_events (agent_id, at, event, detail) VALUES (?, ?, ?, ?)`)
      .run(agentId, new Date().toISOString(), event.slice(0, 64), safe);
    this.db
      .prepare(
        `DELETE FROM agent_events WHERE agent_id = ? AND id NOT IN (
           SELECT id FROM agent_events WHERE agent_id = ? ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(agentId, agentId, keep);
  }

  /** Newest first, across every agent this owner can see. */
  listEvents(agentIds: string[], limit = 60): Array<{
    agentId: string;
    at: string;
    event: string;
    detail?: Record<string, unknown>;
  }> {
    if (agentIds.length === 0) return [];
    const marks = agentIds.map(() => '?').join(',');
    return (
      this.db
        .prepare(
          `SELECT agent_id, at, event, detail FROM agent_events
           WHERE agent_id IN (${marks}) ORDER BY id DESC LIMIT ?`,
        )
        .all(...agentIds, limit) as any[]
    ).map((r) => ({
      agentId: r.agent_id,
      at: r.at,
      event: r.event,
      // Rows written before truncation kept JSON valid may still be torn —
      // one bad row must not take the whole timeline down with it.
      detail: r.detail ? safeParse(r.detail) : undefined,
    }));
  }

  deleteEventsFor(agentId: string): void {
    this.db.prepare(`DELETE FROM agent_events WHERE agent_id = ?`).run(agentId);
  }

  // ---- Peers (other AgentClaw servers) ------------------------------------

  insertPeer(p: {
    id: string;
    ownerId: string;
    name: string;
    url: string;
    secretRef: string;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO peers (id, owner_id, name, url, secret_ref, created_at)
         VALUES (@id, @ownerId, @name, @url, @secretRef, @createdAt)`,
      )
      .run(p);
  }

  listPeers(ownerId: string): Array<{ id: string; name: string; url: string; secretRef: string }> {
    return (
      this.db
        .prepare(`SELECT id, name, url, secret_ref FROM peers WHERE owner_id = ? ORDER BY created_at`)
        .all(ownerId) as any[]
    ).map((r) => ({ id: r.id, name: r.name, url: r.url, secretRef: r.secret_ref }));
  }

  getPeer(ownerId: string, id: string):
    | { id: string; name: string; url: string; secretRef: string }
    | undefined {
    const r = this.db
      .prepare(`SELECT id, name, url, secret_ref FROM peers WHERE id = ? AND owner_id = ?`)
      .get(id, ownerId) as any;
    return r ? { id: r.id, name: r.name, url: r.url, secretRef: r.secret_ref } : undefined;
  }

  deletePeer(ownerId: string, id: string): boolean {
    return (
      this.db.prepare(`DELETE FROM peers WHERE id = ? AND owner_id = ?`).run(id, ownerId).changes === 1
    );
  }

  // ---- CLI tokens --------------------------------------------------------

  /** Returns the token exactly once; only its hash is persisted. */
  createCliToken(
    ownerId: string,
    label: string,
    ttlDays = 90,
  ): { id: string; token: string; expiresAt: string } {
    const raw = randomBytes(32).toString('base64url');
    const token = `agentclaw_${raw}`;
    const id = randomUUID();
    // Bounded lifetime: an eternal bearer token outlives a disabled account,
    // since a cliBearer request never re-consults the identity provider.
    const expiresAt = new Date(Date.now() + ttlDays * 86_400_000).toISOString();
    this.db
      .prepare(
        `INSERT INTO cli_tokens (id, owner_id, token_hash, label, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ownerId,
        hashToken(token),
        label.trim().slice(0, 64) || 'CLI',
        new Date().toISOString(),
        expiresAt,
      );
    return { id, token, expiresAt };
  }

  /** The owner this token belongs to, or undefined. Records the use. */
  ownerForCliToken(token: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT id, owner_id FROM cli_tokens
         WHERE token_hash = ? AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(hashToken(token), new Date().toISOString()) as
      | { id: string; owner_id: string }
      | undefined;
    if (!row) return undefined;
    this.db
      .prepare(`UPDATE cli_tokens SET last_used_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), row.id);
    return row.owner_id;
  }

  listCliTokens(
    ownerId: string,
  ): Array<{ id: string; label: string; createdAt: string; lastUsedAt?: string; expiresAt?: string }> {
    return (
      this.db
        .prepare(`SELECT id, label, created_at, last_used_at, expires_at FROM cli_tokens WHERE owner_id = ? ORDER BY created_at DESC`)
        .all(ownerId) as any[]
    ).map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at ?? undefined,
      expiresAt: r.expires_at ?? undefined,
    }));
  }

  revokeCliToken(ownerId: string, id: string): boolean {
    return (
      this.db.prepare(`DELETE FROM cli_tokens WHERE id = ? AND owner_id = ?`).run(id, ownerId).changes === 1
    );
  }

  // ---- Management-bot heartbeat ------------------------------------------

  upsertMgmtHeartbeat(
    ownerId: string,
    hb: { botUsername: string; mode: string; llm?: string; allowlisted: number },
  ): void {
    this.db
      .prepare(
        `INSERT INTO mgmt_heartbeat (owner_id, bot_username, mode, llm, allowlisted, seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_id) DO UPDATE SET bot_username = excluded.bot_username,
           mode = excluded.mode, llm = excluded.llm,
           allowlisted = excluded.allowlisted, seen_at = excluded.seen_at`,
      )
      .run(ownerId, hb.botUsername, hb.mode, hb.llm ?? null, hb.allowlisted, new Date().toISOString());
  }

  getMgmtHeartbeat(
    ownerId: string,
  ): { botUsername: string; mode: string; llm?: string; allowlisted: number; seenAt: string } | undefined {
    const r = this.db
      .prepare(`SELECT bot_username, mode, llm, allowlisted, seen_at FROM mgmt_heartbeat WHERE owner_id = ?`)
      .get(ownerId) as any;
    if (!r) return undefined;
    return {
      botUsername: r.bot_username,
      mode: r.mode,
      llm: r.llm ?? undefined,
      allowlisted: r.allowlisted,
      seenAt: r.seen_at,
    };
  }

  // ---- Snapshots ---------------------------------------------------------

  insertSnapshot(s: {
    id: string;
    agentId: string;
    label: string;
    reason: string;
    files: Record<string, string>;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO snapshots (id, agent_id, label, reason, files, created_at)
         VALUES (@id, @agentId, @label, @reason, @files, @createdAt)`,
      )
      .run({ ...s, files: JSON.stringify(s.files) });
  }

  listSnapshots(agentId: string): Array<{
    id: string;
    label: string;
    reason: string;
    createdAt: string;
    bytes: number;
    files: string[];
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, label, reason, files, created_at FROM snapshots
         WHERE agent_id = ? ORDER BY created_at DESC`,
      )
      .all(agentId) as any[];
    return rows.map((r) => {
      const files = safeJson<Record<string, string>>(r.files, {});
      return {
        id: r.id,
        label: r.label,
        reason: r.reason,
        createdAt: r.created_at,
        bytes: Object.values(files).reduce((n, v) => n + v.length, 0),
        files: Object.keys(files),
      };
    });
  }

  getSnapshot(agentId: string, id: string):
    | { id: string; label: string; reason: string; createdAt: string; files: Record<string, string> }
    | undefined {
    const r = this.db
      .prepare(`SELECT * FROM snapshots WHERE id = ? AND agent_id = ?`)
      .get(id, agentId) as any;
    if (!r) return undefined;
    return {
      id: r.id,
      label: r.label,
      reason: r.reason,
      createdAt: r.created_at,
      files: safeJson(r.files, {}),
    };
  }

  deleteSnapshot(agentId: string, id: string): boolean {
    return (
      this.db.prepare(`DELETE FROM snapshots WHERE id = ? AND agent_id = ?`).run(id, agentId)
        .changes === 1
    );
  }

  /** Keep the newest `keep` automatic snapshots; named ones are never pruned. */
  pruneAutoSnapshots(agentId: string, keep: number): number {
    return this.db
      .prepare(
        `DELETE FROM snapshots WHERE agent_id = ? AND reason != 'manual' AND id NOT IN (
           SELECT id FROM snapshots WHERE agent_id = ? AND reason != 'manual'
           ORDER BY created_at DESC LIMIT ?
         )`,
      )
      .run(agentId, agentId, keep).changes;
  }

  deleteSnapshotsFor(agentId: string): void {
    this.db.prepare(`DELETE FROM snapshots WHERE agent_id = ?`).run(agentId);
  }

  // ---- Invites -----------------------------------------------------------

  insertInvite(i: {
    id: string;
    agentId: string;
    code: string;
    role: string;
    createdBy: string;
    createdAt: string;
    expiresAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO invites (id, agent_id, code, role, created_by, created_at, expires_at)
         VALUES (@id, @agentId, @code, @role, @createdBy, @createdAt, @expiresAt)`,
      )
      .run(i);
  }

  getInviteByCode(code: string):
    | {
        id: string;
        agentId: string;
        code: string;
        role: string;
        expiresAt: string;
        redeemedAt?: string;
      }
    | undefined {
    const r = this.db.prepare(`SELECT * FROM invites WHERE code = ?`).get(code) as any;
    if (!r) return undefined;
    return {
      id: r.id,
      agentId: r.agent_id,
      code: r.code,
      role: r.role,
      expiresAt: r.expires_at,
      redeemedAt: r.redeemed_at ?? undefined,
    };
  }

  /** Atomically claims a single-use invite. Returns false if already used. */
  markInviteRedeemed(code: string, redeemedBy: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE invites SET redeemed_at = ?, redeemed_by = ?
         WHERE code = ? AND redeemed_at IS NULL`,
      )
      .run(new Date().toISOString(), redeemedBy, code);
    return res.changes === 1;
  }

  /** Burn every outstanding invite for an agent (used on delete). */
  /** `by` records WHY the link died — delete and archive both kill invites,
   *  and "agent-deleted" on an agent that is merely archived reads as a lie. */
  expireInvitesFor(agentId: string, by = 'agent-deleted'): void {
    this.db
      .prepare(
        `UPDATE invites SET redeemed_at = ?, redeemed_by = ?
         WHERE agent_id = ? AND redeemed_at IS NULL`,
      )
      .run(new Date().toISOString(), by, agentId);
  }

  listMemberships(agentId: string): Array<{
    userId: string;
    role: string;
    displayName?: string;
    channelUserId?: string;
    status: string;
    joinedAt?: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT user_id, role, display_name, channel_user_id, status, joined_at
         FROM memberships WHERE agent_id = ? ORDER BY joined_at`,
      )
      .all(agentId) as any[];
    return rows.map((r) => ({
      userId: r.user_id,
      role: r.role,
      displayName: r.display_name ?? undefined,
      joinedAt: r.joined_at ?? undefined,
      channelUserId: r.channel_user_id ?? undefined,
      status: r.status,
    }));
  }

  getMembership(agentId: string, userId: string):
    | { userId: string; role: string; channelUserId?: string; status: string }
    | undefined {
    const r = this.db
      .prepare(
        `SELECT user_id, role, channel_user_id, status FROM memberships
         WHERE agent_id = ? AND user_id = ?`,
      )
      .get(agentId, userId) as any;
    if (!r) return undefined;
    return {
      userId: r.user_id,
      role: r.role,
      channelUserId: r.channel_user_id ?? undefined,
      status: r.status,
    };
  }

  /**
   * DELETED rows are kept as history but still hold UNIQUE(owner_id, slug).
   * Rename theirs out of the way so a new agent (e.g. an import of the same
   * agent after a delete) can take the slug back.
   */
  releaseDeletedSlug(ownerId: string, slug: string): void {
    this.db
      .prepare(
        `UPDATE agents SET slug = slug || '-deleted-' || substr(id, 1, 8)
         WHERE owner_id = ? AND slug = ? AND state = 'DELETED'`,
      )
      .run(ownerId, slug);
  }

  setAgentName(id: string, name: string): void {
    this.db
      .prepare(`UPDATE agents SET name = ?, updated_at = ? WHERE id = ?`)
      .run(name, new Date().toISOString(), id);
  }

  /** The one-line description shown on the agent's card (its stored persona
   *  summary). Cosmetic — does not touch the running SOUL.md. */
  setAgentPersona(id: string, persona: string): void {
    this.db
      .prepare(`UPDATE agents SET persona = ?, updated_at = ? WHERE id = ?`)
      .run(persona, new Date().toISOString(), id);
  }

  /**
   * Record what the runtime was last actually configured with. The agent row
   * carries the *desired* profile; this is the *applied* one, and the gap
   * between them is what "Rebuild to apply" means.
   */
  /**
   * Record that this agent now lives on another server. Starting it again
   * would put two runtimes on one bot token — so this is a tombstone that
   * lifecycle routes refuse to act on until it is explicitly cleared.
   */
  /** Host folders this agent may read. Applied on its next rebuild. */
  setAgentSharedPaths(id: string, paths: string[]): void {
    this.db
      .prepare(`UPDATE agents SET shared_paths = ?, updated_at = ? WHERE id = ?`)
      .run(paths.length ? JSON.stringify(paths) : null, new Date().toISOString(), id);
  }

  // ---- data sources (richer than the legacy shared_paths folders) ----

  listDataSources(agentId: string): DataSource[] {
    return (
      this.db
        .prepare(`SELECT * FROM data_sources WHERE agent_id = ? ORDER BY created_at`)
        .all(agentId) as any[]
    ).map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      kind: r.kind,
      access: r.access,
      mountName: r.mount_name,
      hostPath: r.host_path ?? undefined,
      mountAtHostPath: !!r.mount_at_host_path,
      repoUrl: r.repo_url ?? undefined,
      secretRef: r.secret_ref ?? undefined,
      pubKey: r.pub_key ?? undefined,
      syncError: r.sync_error ?? undefined,
      syncedAt: r.synced_at ?? undefined,
      createdAt: r.created_at,
    }));
  }

  getDataSource(agentId: string, id: string): DataSource | undefined {
    return this.listDataSources(agentId).find((d) => d.id === id);
  }

  insertDataSource(d: DataSource): void {
    this.db
      .prepare(
        `INSERT INTO data_sources (id, agent_id, kind, access, mount_name, host_path, mount_at_host_path, repo_url, secret_ref, pub_key, created_at)
         VALUES (@id, @agentId, @kind, @access, @mountName, @hostPath, @mountAtHostPath, @repoUrl, @secretRef, @pubKey, @createdAt)`,
      )
      .run({
        hostPath: null,
        repoUrl: null,
        secretRef: null,
        pubKey: null,
        ...d,
        mountAtHostPath: d.mountAtHostPath ? 1 : 0,
      });
  }

  /** Record the outcome of a git clone/refresh. `error` undefined = success,
   *  which also clears any previous failure. */
  setDataSourceSync(agentId: string, id: string, error?: string): void {
    this.db
      .prepare(`UPDATE data_sources SET sync_error = ?, synced_at = ? WHERE agent_id = ? AND id = ?`)
      .run(error ?? null, new Date().toISOString(), agentId, id);
  }

  /** Flip a source between read-only and writable. Applies on the next rebuild
   *  (a folder's bind mount is fixed for the life of the container). */
  setDataSourceAccess(agentId: string, id: string, access: 'ro' | 'rw'): boolean {
    return (
      this.db
        .prepare(`UPDATE data_sources SET access = ? WHERE agent_id = ? AND id = ?`)
        .run(access, agentId, id).changes > 0
    );
  }

  deleteDataSource(agentId: string, id: string): boolean {
    return (
      this.db.prepare(`DELETE FROM data_sources WHERE agent_id = ? AND id = ?`).run(agentId, id)
        .changes > 0
    );
  }

  // ---- Per-agent environment variables (values live in the SecretStore) ---

  listAgentEnv(agentId: string): AgentEnvVar[] {
    return (
      this.db
        .prepare(`SELECT * FROM agent_env WHERE agent_id = ? ORDER BY name`)
        .all(agentId) as any[]
    ).map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      name: r.name,
      secretRef: r.secret_ref,
      createdAt: r.created_at,
    }));
  }

  getAgentEnv(agentId: string, id: string): AgentEnvVar | undefined {
    return this.listAgentEnv(agentId).find((e) => e.id === id);
  }

  insertAgentEnv(e: AgentEnvVar): void {
    this.db
      .prepare(
        `INSERT INTO agent_env (id, agent_id, name, secret_ref, created_at)
         VALUES (@id, @agentId, @name, @secretRef, @createdAt)`,
      )
      .run(e);
  }

  deleteAgentEnv(agentId: string, id: string): boolean {
    return (
      this.db.prepare(`DELETE FROM agent_env WHERE agent_id = ? AND id = ?`).run(agentId, id)
        .changes > 0
    );
  }

  /** A configured copy's editable state: current values + the raw template
   *  layer they render into. Set at import; values updated on later edits. */
  insertProposal(p: { id: string; masterAgentId: string; childAgentId: string; childName: string; text: string }): void {
    this.db
      .prepare(
        `INSERT INTO agent_proposals (id, master_agent_id, child_agent_id, child_name, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.masterAgentId, p.childAgentId, p.childName, p.text, new Date().toISOString());
  }

  listProposals(masterAgentId: string): Array<{ id: string; childAgentId: string; childName: string; text: string; createdAt: string }> {
    return (
      this.db
        .prepare(`SELECT * FROM agent_proposals WHERE master_agent_id = ? AND status = 'pending' ORDER BY created_at`)
        .all(masterAgentId) as any[]
    ).map((r) => ({ id: r.id, childAgentId: r.child_agent_id, childName: r.child_name, text: r.text, createdAt: r.created_at }));
  }

  resolveProposal(masterAgentId: string, id: string, status: 'merged' | 'dismissed'): boolean {
    return (
      this.db
        .prepare(`UPDATE agent_proposals SET status = ? WHERE id = ? AND master_agent_id = ? AND status = 'pending'`)
        .run(status, id, masterAgentId).changes === 1
    );
  }

  // ---- platform-managed connections (Google via gog) ----------------------

  insertConnection(c: { id: string; ownerId: string; kind: string; email: string; services: string[]; secretRef: string }): void {
    this.db
      .prepare(
        `INSERT INTO connections (id, owner_id, kind, email, services, secret_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_id, kind, email) DO UPDATE
           SET services = excluded.services, secret_ref = excluded.secret_ref`,
      )
      .run(c.id, c.ownerId, c.kind, c.email, JSON.stringify(c.services), c.secretRef, new Date().toISOString());
  }

  getConnection(id: string): { id: string; ownerId: string; kind: string; email: string; services: string[]; secretRef: string; createdAt: string } | undefined {
    const r = this.db.prepare(`SELECT * FROM connections WHERE id = ?`).get(id) as any;
    if (!r) return undefined;
    return {
      id: r.id, ownerId: r.owner_id, kind: r.kind, email: r.email,
      services: JSON.parse(r.services ?? '[]'), secretRef: r.secret_ref, createdAt: r.created_at,
    };
  }

  /** A re-connect of the same account upserts — this finds the surviving row. */
  findConnection(ownerId: string, kind: string, email: string): { id: string; secretRef: string } | undefined {
    const r = this.db
      .prepare(`SELECT id, secret_ref FROM connections WHERE owner_id = ? AND kind = ? AND email = ?`)
      .get(ownerId, kind, email) as any;
    return r ? { id: r.id, secretRef: r.secret_ref } : undefined;
  }

  listConnections(ownerId: string): Array<{ id: string; kind: string; email: string; services: string[]; createdAt: string }> {
    return (this.db.prepare(`SELECT * FROM connections WHERE owner_id = ? ORDER BY email`).all(ownerId) as any[]).map((r) => ({
      id: r.id, kind: r.kind, email: r.email, services: JSON.parse(r.services ?? '[]'), createdAt: r.created_at,
    }));
  }

  deleteConnection(id: string): void {
    this.db.prepare(`DELETE FROM agent_connections WHERE connection_id = ?`).run(id);
    this.db.prepare(`DELETE FROM connections WHERE id = ?`).run(id);
  }

  attachConnection(agentId: string, connectionId: string, gmailNoSend: boolean): void {
    this.db
      .prepare(
        `INSERT INTO agent_connections (agent_id, connection_id, gmail_no_send) VALUES (?, ?, ?)
         ON CONFLICT(agent_id, connection_id) DO UPDATE SET gmail_no_send = excluded.gmail_no_send`,
      )
      .run(agentId, connectionId, gmailNoSend ? 1 : 0);
  }

  detachConnection(agentId: string, connectionId: string): void {
    this.db.prepare(`DELETE FROM agent_connections WHERE agent_id = ? AND connection_id = ?`).run(agentId, connectionId);
  }

  listAgentConnections(agentId: string): Array<{ connectionId: string; gmailNoSend: boolean }> {
    return (this.db.prepare(`SELECT * FROM agent_connections WHERE agent_id = ?`).all(agentId) as any[]).map((r) => ({
      connectionId: r.connection_id, gmailNoSend: !!r.gmail_no_send,
    }));
  }

  /** Which agents a connection is attached to — the vault list shows reach. */
  listAgentsForConnection(connectionId: string): string[] {
    return (this.db.prepare(`SELECT agent_id FROM agent_connections WHERE connection_id = ?`).all(connectionId) as any[]).map((r) => r.agent_id);
  }

  /** Undo a merge claim whose file write failed — the proposal must stay
   *  reviewable, not vanish as "merged" without its text landing anywhere. */
  reopenProposal(masterAgentId: string, id: string): void {
    this.db
      .prepare(`UPDATE agent_proposals SET status = 'pending' WHERE id = ? AND master_agent_id = ? AND status = 'merged'`)
      .run(id, masterAgentId);
  }

  setPendingSchedules(id: string, schedules: unknown[] | null): void {
    this.db
      .prepare(`UPDATE agents SET pending_schedules = ? WHERE id = ?`)
      .run(schedules ? JSON.stringify(schedules) : null, id);
  }

  getPendingSchedules(id: string): Array<{ name: string; message: string; cron?: string; everyMs?: number; tz?: string }> {
    const r = this.db.prepare(`SELECT pending_schedules FROM agents WHERE id = ?`).get(id) as any;
    return r?.pending_schedules ? (safeJson(r.pending_schedules, []) as any[]) : [];
  }

  setAgentParent(id: string, parentAgentId: string | null): void {
    this.db
      .prepare(`UPDATE agents SET parent_agent_id = ? WHERE id = ?`)
      .run(parentAgentId, id);
  }

  /** Live children derived from this master (same installation). */
  listChildren(parentAgentId: string): Agent[] {
    return (
      this.db
        .prepare(`SELECT * FROM agents WHERE parent_agent_id = ? AND state != 'DELETED'`)
        .all(parentAgentId) as any[]
    ).map(rowToAgent);
  }

  setAgentGroupAccess(id: string, ga: GroupAccess | null): void {
    this.db
      .prepare(`UPDATE agents SET group_access = ?, updated_at = ? WHERE id = ?`)
      .run(ga ? JSON.stringify(ga) : null, new Date().toISOString(), id);
  }

  /** null = back to the managed default (rich ON). */
  setAgentRichMessages(id: string, on: boolean | null): void {
    this.db
      .prepare(`UPDATE agents SET rich_messages = ?, updated_at = ? WHERE id = ?`)
      .run(on === null ? null : on ? 1 : 0, new Date().toISOString(), id);
  }

  setAgentParamState(
    id: string,
    values: Record<string, string> | null,
    files?: { soul?: string; agents?: string; persona?: string } | null,
  ): void {
    if (files !== undefined) {
      this.db
        .prepare(`UPDATE agents SET param_values = ?, param_files = ?, updated_at = ? WHERE id = ?`)
        .run(values ? JSON.stringify(values) : null, files ? JSON.stringify(files) : null,
          new Date().toISOString(), id);
    } else {
      this.db
        .prepare(`UPDATE agents SET param_values = ?, updated_at = ? WHERE id = ?`)
        .run(values ? JSON.stringify(values) : null, new Date().toISOString(), id);
    }
  }

  /** Declare (or clear, with null) the agent's template setup fields. */
  setAgentParameters(id: string, params: TemplateParam[] | null): void {
    this.db
      .prepare(`UPDATE agents SET params = ?, updated_at = ? WHERE id = ?`)
      .run(params?.length ? JSON.stringify(params) : null, new Date().toISOString(), id);
  }

  /** Pin (or clear, with null) the agent's runtime image. Takes effect on rebuild. */
  setAgentImage(id: string, image: string | null): void {
    this.db
      .prepare(`UPDATE agents SET image = ?, updated_at = ? WHERE id = ?`)
      .run(image, new Date().toISOString(), id);
  }

  setAgentMigratedTo(id: string, note: string | null): void {
    this.db.prepare(`UPDATE agents SET migrated_to = ? WHERE id = ?`).run(note, id);
  }

  // --- Derived runtime images (docs/embedding-and-images.md → derived images) ---

  #mapDerivedImage = (r: any): DerivedImage => ({
    name: r.name,
    tag: r.tag,
    base: r.base,
    dockerfile: r.dockerfile,
    status: r.status as DerivedImageStatus,
    error: r.error ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    builtAt: r.built_at ?? null,
  });

  /**
   * Create or replace a derived image record, resetting it to BUILDING. Same
   * name = same tag, so a re-derive under an existing name rebuilds in place
   * (and the agents pinned to that tag pick up the new build on next rebuild).
   */
  upsertDerivedImage(rec: {
    name: string;
    tag: string;
    base: string;
    dockerfile: string;
    createdBy: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO derived_images (name, tag, base, dockerfile, status, error, created_by, created_at, built_at)
         VALUES (@name, @tag, @base, @dockerfile, 'BUILDING', NULL, @createdBy, @now, NULL)
         ON CONFLICT(name) DO UPDATE SET
           tag = excluded.tag, base = excluded.base, dockerfile = excluded.dockerfile,
           status = 'BUILDING', error = NULL`,
      )
      .run({ ...rec, now: new Date().toISOString() });
  }

  getDerivedImage(name: string): DerivedImage | undefined {
    const r = this.db.prepare(`SELECT * FROM derived_images WHERE name = ?`).get(name);
    return r ? this.#mapDerivedImage(r) : undefined;
  }

  listDerivedImages(): DerivedImage[] {
    return this.db
      .prepare(`SELECT * FROM derived_images ORDER BY name`)
      .all()
      .map(this.#mapDerivedImage);
  }

  /** Mark a build's outcome. On READY, stamp built_at; on FAILED, keep the error. */
  setDerivedImageStatus(name: string, status: DerivedImageStatus, error?: string | null): void {
    this.db
      .prepare(
        `UPDATE derived_images SET status = ?, error = ?, built_at = CASE WHEN ? = 'READY' THEN ? ELSE built_at END WHERE name = ?`,
      )
      .run(status, error ?? null, status, new Date().toISOString(), name);
  }

  deleteDerivedImage(name: string): boolean {
    return this.db.prepare(`DELETE FROM derived_images WHERE name = ?`).run(name).changes > 0;
  }

  /** Agents currently pinned to this image tag — used to refuse a delete. */
  agentsPinnedToImage(tag: string): Agent[] {
    return (
      this.db
        .prepare(`SELECT * FROM agents WHERE image = ? AND state != 'DELETED'`)
        .all(tag) as any[]
    ).map(rowToAgent);
  }

  setAgentApplied(id: string, aiProfileId: string, model: string): void {
    this.db
      .prepare(`UPDATE agents SET applied_profile_id = ?, applied_model = ? WHERE id = ?`)
      .run(aiProfileId, model, id);
  }

  setAgentAIProfile(id: string, aiProfileId: string): void {
    this.db
      .prepare(`UPDATE agents SET ai_profile_id = ?, updated_at = ? WHERE id = ?`)
      .run(aiProfileId, new Date().toISOString(), id);
  }

  /** Per-agent model override; null clears it (agent follows the profile default). */
  setAgentModel(id: string, model: string | null): void {
    this.db
      .prepare(`UPDATE agents SET model = ?, updated_at = ? WHERE id = ?`)
      .run(model, new Date().toISOString(), id);
  }

  /** One past the current max order in an owner's section (1 if empty), so a
   *  new or freshly-regrouped agent sorts strictly last there. */
  /** END of a section — where a DELIBERATELY MOVED agent belongs (setAgentGroup). */
  private nextSortOrder(ownerId: string, group: string | null): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM agents
         WHERE owner_id = ? AND state != 'DELETED'
           AND ((group_name IS NULL AND ? IS NULL) OR group_name = ?)`,
      )
      .get(ownerId, group, group) as { n: number };
    return row.n;
  }

  /**
   * TOP of a section — where a NEW agent belongs.
   *
   * You watch the thing you just made: it provisions, it may want a bot token,
   * it may fail. Appending it meant scrolling past the whole fleet to find it.
   * Order ascends, so "first" is one below the current minimum; negatives are
   * fine since only relative order matters. This is deliberately NOT what
   * setAgentGroup uses — moving an agent into a section is a considered act and
   * still lands it at the end.
   */
  private firstSortOrder(ownerId: string, group: string | null): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MIN(sort_order), 0) - 1 AS n FROM agents
         WHERE owner_id = ? AND state != 'DELETED'
           AND ((group_name IS NULL AND ? IS NULL) OR group_name = ?)`,
      )
      .get(ownerId, group, group) as { n: number };
    return row.n;
  }

  /** Set (or clear, with null) the agent's group label. Moving to a different
   *  section also drops the agent at the END of that section — otherwise its
   *  stale order value would land it at an arbitrary spot among strangers. */
  setAgentGroup(id: string, group: string | null): void {
    const agent = this.getAgent(id);
    if (!agent) return;
    if ((agent.group ?? null) === group) return; // no change — leave order alone
    this.db
      .prepare(`UPDATE agents SET group_name = ?, sort_order = ?, updated_at = ? WHERE id = ?`)
      .run(group, this.nextSortOrder(agent.ownerId, group), new Date().toISOString(), id);
  }

  /**
   * Move an agent one place up or down WITHIN its group section, by swapping
   * sort_order with the adjacent sibling. Returns false at the section boundary
   * (or if the agent is gone). Group membership never changes here.
   */
  moveAgent(id: string, dir: 'up' | 'down'): boolean {
    const agent = this.getAgent(id);
    if (!agent) return false;
    const g = agent.group ?? null;
    const siblings = this.db
      .prepare(
        `SELECT id, sort_order FROM agents
         WHERE owner_id = ? AND state != 'DELETED'
           AND ((group_name IS NULL AND ? IS NULL) OR group_name = ?)
         ORDER BY sort_order, created_at`,
      )
      .all(agent.ownerId, g, g) as Array<{ id: string; sort_order: number }>;
    const i = siblings.findIndex((s) => s.id === id);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= siblings.length) return false;
    const a = siblings[i]!;
    const b = siblings[j]!;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const upd = this.db.prepare(`UPDATE agents SET sort_order = ?, updated_at = ? WHERE id = ?`);
      upd.run(b.sort_order, now, a.id);
      upd.run(a.sort_order, now, b.id);
    })();
    return true;
  }

  /**
   * Drop any per-agent model pin on `profileId` that is no longer on the given
   * menu — called when a source's model list is edited, so a pin the source can
   * no longer serve doesn't linger in stored state (and misreport in the UI).
   * `effectiveModel` already refuses to run a stale pin; this keeps the row
   * honest too. Returns how many agents were cleared.
   */
  /** `ownerId` scopes the sweep to one account's agents — required on a SHARED
   *  profile, where another owner's valid pin is not ours to clear. */
  clearStaleAgentModels(profileId: string, validModels: string[], ownerId?: string): number {
    // NULL out where model IS NOT NULL and NOT in the valid set. Build the IN
    // list with placeholders — validModels is a small, owner-controlled menu.
    const placeholders = validModels.map(() => '?').join(',');
    const notInMenu = validModels.length ? `AND model NOT IN (${placeholders})` : '';
    return this.db
      .prepare(
        `UPDATE agents SET model = NULL, updated_at = ?
         WHERE ai_profile_id = ? ${ownerId ? 'AND owner_id = ?' : ''}
           AND model IS NOT NULL ${notInMenu}`,
      )
      .run(
        new Date().toISOString(),
        profileId,
        ...(ownerId ? [ownerId] : []),
        ...validModels,
      ).changes;
  }

  setAgentSharedMemory(id: string, shared: boolean): void {
    this.db
      .prepare(`UPDATE agents SET shared_memory = ?, updated_at = ? WHERE id = ?`)
      .run(shared ? 1 : 0, new Date().toISOString(), id);
  }

  /** Active membership already bound to this channel identity, if any. */
  getActiveMembershipByChannelUser(
    agentId: string,
    channelUserId: string,
  ): { userId: string; role: string; displayName?: string } | undefined {
    const r = this.db
      .prepare(
        `SELECT user_id, role, display_name FROM memberships
         WHERE agent_id = ? AND channel_user_id = ? AND status = 'active'`,
      )
      .get(agentId, channelUserId) as any;
    if (!r) return undefined;
    return { userId: r.user_id, role: r.role, displayName: r.display_name ?? undefined };
  }

  /** Hard delete — used by import rollback, not by revoke (which tombstones). */
  deleteMemberships(agentId: string): void {
    this.db.prepare(`DELETE FROM memberships WHERE agent_id = ?`).run(agentId);
  }

  revokeMembership(agentId: string, userId: string): void {
    this.db
      .prepare(`UPDATE memberships SET status = 'revoked' WHERE agent_id = ? AND user_id = ?`)
      .run(agentId, userId);
  }

  /**
   * Re-admit a previously revoked member (a fresh invite they redeem again).
   * Clears the old bound telegram id so they claim first contact anew — the
   * person behind the account may have changed, and pairing re-binds it.
   */
  reactivateMembership(agentId: string, userId: string, displayName: string): void {
    this.db
      .prepare(
        `UPDATE memberships
           SET status = 'active', display_name = ?, channel_user_id = NULL,
               joined_at = ?
         WHERE agent_id = ? AND user_id = ?`,
      )
      .run(displayName, new Date().toISOString(), agentId, userId);
  }

  /**
   * Bind the telegram identity a first-contact claim approved (§12.4).
   * Conditional and reported: refuses to overwrite a membership that is
   * already bound, and refuses to bind an id that already belongs to ANOTHER
   * active membership on this agent. Concurrent claim windows (owner's 10-min
   * + an invitee's 30-min) otherwise raced to bind requests[0] and could swap
   * two people's identities across memberships. Returns true only if this call
   * actually made the binding.
   */
  bindMembershipChannelUser(agentId: string, userId: string, channelUserId: string): boolean {
    const holder = this.getActiveMembershipByChannelUser(agentId, channelUserId);
    if (holder && holder.userId !== userId) return false; // belongs to someone else
    const res = this.db
      .prepare(
        `UPDATE memberships SET channel_user_id = ?, joined_at = COALESCE(joined_at, ?)
         WHERE agent_id = ? AND user_id = ? AND status = 'active'
           AND (channel_user_id IS NULL OR channel_user_id = ?)`,
      )
      .run(channelUserId, new Date().toISOString(), agentId, userId, channelUserId);
    return res.changes > 0;
  }

  /**
   * The Telegram identity this user is already known by, from any of their
   * agents. Once one first-contact claim has bound it, every LATER agent can
   * trust the same person from birth — creating agent #5 should not make the
   * owner pair with their own bot a fifth time.
   */
  knownChannelUserId(userId: string): string | undefined {
    // The explicit account-level link wins; the membership scan remains as the
    // fallback for accounts that bound an agent before linking existed.
    const linked = (
      this.db.prepare(`SELECT telegram_user_id FROM accounts WHERE owner_id = ?`).get(userId) as
        | { telegram_user_id: string | null }
        | undefined
    )?.telegram_user_id;
    if (linked) return linked;
    const r = this.db
      .prepare(
        `SELECT channel_user_id FROM memberships
         WHERE user_id = ? AND channel_user_id IS NOT NULL AND status = 'active'
         ORDER BY joined_at DESC LIMIT 1`,
      )
      .get(userId) as { channel_user_id: string } | undefined;
    return r?.channel_user_id;
  }

  /**
   * Link (or with null, unlink) the account's Telegram identity. Upserts: a
   * password-mode owner has no sign-in-created accounts row, and linking must
   * still work there.
   */
  setAccountTelegram(ownerId: string, channelUserId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO accounts (owner_id, telegram_user_id, last_seen) VALUES (?, ?, ?)
         ON CONFLICT(owner_id) DO UPDATE SET telegram_user_id = excluded.telegram_user_id`,
      )
      .run(ownerId, channelUserId, new Date().toISOString());
  }

  /** The account's linked Telegram id, if the explicit link has been made. */
  accountTelegram(ownerId: string): string | undefined {
    const r = this.db
      .prepare(`SELECT telegram_user_id FROM accounts WHERE owner_id = ?`)
      .get(ownerId) as { telegram_user_id: string | null } | undefined;
    return r?.telegram_user_id ?? undefined;
  }

  /**
   * After a link: on every agent this owner has, bind their (unbound) owner
   * seat to the linked Telegram id and absorb any duplicate MEMBER row that
   * carries the same id — the "same person listed twice" a fresh account's
   * first approval used to mint. Returns how many duplicates were absorbed.
   */
  absorbOwnerTelegram(ownerId: string, channelUserId: string): number {
    this.db
      .prepare(
        `UPDATE memberships SET channel_user_id = ?
         WHERE user_id = ? AND role = 'owner' AND channel_user_id IS NULL
           AND agent_id IN (SELECT id FROM agents WHERE owner_id = ? AND state != 'DELETED')`,
      )
      .run(channelUserId, ownerId, ownerId);
    return this.db
      .prepare(
        `DELETE FROM memberships
         WHERE channel_user_id = ? AND role != 'owner' AND user_id != ?
           AND agent_id IN (SELECT id FROM agents WHERE owner_id = ? AND state != 'DELETED')`,
      )
      .run(channelUserId, ownerId, ownerId).changes;
  }

  /** Active members' channel ids — this is what becomes the bot allowlist. */
  listAllowedChannelUserIds(agentId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT channel_user_id FROM memberships
         WHERE agent_id = ? AND status = 'active' AND channel_user_id IS NOT NULL`,
      )
      .all(agentId) as { channel_user_id: string }[];
    return rows.map((r) => r.channel_user_id);
  }
}

/** Tokens are compared by hash, never stored in the clear. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function safeParse(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return { unparseable: text };
  }
}

/**
 * JSON.parse that survives a torn/corrupt value. These run inside the row
 * mappers under listAgents/listVisibleAgents — before this guard, ONE invalid
 * JSON value in one row threw and took down every fleet endpoint at once. Same
 * lesson agent_events.detail already learned (see the safeParse there).
 */
function safeJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToAgent(r: any): Agent {
  return {
    id: r.id,
    ownerId: r.owner_id,
    name: r.name,
    slug: r.slug,
    state: r.state,
    stateReason: r.state_reason ?? undefined,
    aiProfileId: r.ai_profile_id,
    hostId: r.host_id,
    runtimeRef: r.runtime_ref ?? undefined,
    persona: r.persona,
    sharedMemory: !!r.shared_memory,
    model: r.model ?? undefined,
    pendingAction: r.pending_action ? safeJson(r.pending_action, undefined) : undefined,
    migratedTo: r.migrated_to ?? undefined,
    image: r.image ?? undefined,
    sharedPaths: r.shared_paths ? safeJson(r.shared_paths, undefined) : undefined,
    appliedProfileId: r.applied_profile_id ?? undefined,
    appliedModel: r.applied_model ?? undefined,
    gatewayPort: r.gateway_port ?? undefined,
    gatewayToken: r.gateway_token ?? undefined,
    group: r.group_name ?? undefined,
    sortOrder: r.sort_order ?? undefined,
    parameters: r.params ? safeJson(r.params, undefined) : undefined,
    paramValues: r.param_values ? safeJson(r.param_values, undefined) : undefined,
    paramFiles: r.param_files ? safeJson(r.param_files, undefined) : undefined,
    groupAccess: r.group_access ? safeJson(r.group_access, undefined) : undefined,
    richMessages: r.rich_messages === null || r.rich_messages === undefined ? undefined : !!r.rich_messages,
    parentAgentId: r.parent_agent_id ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToAIProfile(r: any): AIProfile {
  return {
    id: r.id,
    ownerId: r.owner_id,
    name: r.name,
    vendor: r.vendor,
    kind: r.kind,
    model: r.model,
    models: r.models ? safeJson(r.models, undefined) : undefined,
    baseUrl: r.base_url ?? undefined,
    secretRef: r.secret_ref ?? undefined,
    shared: !!r.shared,
    mgmtLlm: !!r.mgmt_llm,
    defaultSource: !!r.default_source,
    createdAt: r.created_at,
  };
}
