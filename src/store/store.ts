import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  Agent,
  AgentEnvVar,
  AgentState,
  AIProfile,
  Channel,
  DataSource,
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
      // Optional per-agent model override (cloud only). NULL = follow the
      // profile's default model.
      `ALTER TABLE agents ADD COLUMN model TEXT`,
      // Owner-defined organization: an optional group label and a manual order.
      `ALTER TABLE agents ADD COLUMN group_name TEXT`,
      `ALTER TABLE agents ADD COLUMN sort_order INTEGER`,
      // Bind an adopted agent's folder at its original host path, so existing
      // absolute-path references resolve unchanged.
      `ALTER TABLE data_sources ADD COLUMN mount_at_host_path INTEGER NOT NULL DEFAULT 0`,
    ]) {
      try {
        this.db.exec(alter);
      } catch {
        /* column exists */
      }
    }
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

  getHost(id: string): Host | undefined {
    const r = this.db.prepare(`SELECT * FROM hosts WHERE id = ?`).get(id) as any;
    if (!r) return undefined;
    return {
      id: r.id,
      ownerId: r.owner_id,
      kind: r.kind,
      provider: r.provider,
      name: r.name,
      settings: JSON.parse(r.settings),
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
        sortOrder: a.sortOrder ?? this.nextSortOrder(a.ownerId, a.group ?? null),
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
      // different range (docker publishes these on the shared loopback).
      const base = Number(process.env.AGENTCLAW_GATEWAY_PORT_BASE ?? 19100);
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
        `SELECT a.id FROM channels c JOIN agents a ON a.id = c.agent_id
         WHERE c.account_id = ? AND a.state != 'DELETED' LIMIT 1`,
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
      const files = JSON.parse(r.files) as Record<string, string>;
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
      files: JSON.parse(r.files),
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
  expireInvitesFor(agentId: string): void {
    this.db
      .prepare(
        `UPDATE invites SET redeemed_at = ?, redeemed_by = 'agent-deleted'
         WHERE agent_id = ? AND redeemed_at IS NULL`,
      )
      .run(new Date().toISOString(), agentId);
  }

  listMemberships(agentId: string): Array<{
    userId: string;
    role: string;
    displayName?: string;
    channelUserId?: string;
    status: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT user_id, role, display_name, channel_user_id, status
         FROM memberships WHERE agent_id = ? ORDER BY joined_at`,
      )
      .all(agentId) as any[];
    return rows.map((r) => ({
      userId: r.user_id,
      role: r.role,
      displayName: r.display_name ?? undefined,
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

  setAgentMigratedTo(id: string, note: string | null): void {
    this.db.prepare(`UPDATE agents SET migrated_to = ? WHERE id = ?`).run(note, id);
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
  clearStaleAgentModels(profileId: string, validModels: string[]): number {
    // NULL out where model IS NOT NULL and NOT in the valid set. Build the IN
    // list with placeholders — validModels is a small, owner-controlled menu.
    const placeholders = validModels.map(() => '?').join(',');
    const notInMenu = validModels.length ? `AND model NOT IN (${placeholders})` : '';
    return this.db
      .prepare(
        `UPDATE agents SET model = NULL, updated_at = ?
         WHERE ai_profile_id = ? AND model IS NOT NULL ${notInMenu}`,
      )
      .run(new Date().toISOString(), profileId, ...validModels).changes;
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

  setMembershipDisplayName(agentId: string, userId: string, name: string): void {
    this.db
      .prepare(`UPDATE memberships SET display_name = ? WHERE agent_id = ? AND user_id = ?`)
      .run(name, agentId, userId);
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
    const r = this.db
      .prepare(
        `SELECT channel_user_id FROM memberships
         WHERE user_id = ? AND channel_user_id IS NOT NULL AND status = 'active'
         ORDER BY joined_at DESC LIMIT 1`,
      )
      .get(userId) as { channel_user_id: string } | undefined;
    return r?.channel_user_id;
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
    pendingAction: r.pending_action ? JSON.parse(r.pending_action) : undefined,
    migratedTo: r.migrated_to ?? undefined,
    sharedPaths: r.shared_paths ? JSON.parse(r.shared_paths) : undefined,
    appliedProfileId: r.applied_profile_id ?? undefined,
    appliedModel: r.applied_model ?? undefined,
    gatewayPort: r.gateway_port ?? undefined,
    gatewayToken: r.gateway_token ?? undefined,
    group: r.group_name ?? undefined,
    sortOrder: r.sort_order ?? undefined,
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
    models: r.models ? JSON.parse(r.models) : undefined,
    baseUrl: r.base_url ?? undefined,
    secretRef: r.secret_ref ?? undefined,
    shared: !!r.shared,
    createdAt: r.created_at,
  };
}
