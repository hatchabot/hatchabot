import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  Agent,
  AgentState,
  AIProfile,
  Channel,
  Host,
  Membership,
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

      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, code TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL, redeemed_at TEXT, redeemed_by TEXT
      );
    `);
    // Additive dev migrations for databases created before these columns
    // existed. Harmless when the column is already there.
    for (const alter of [
      `ALTER TABLE agents ADD COLUMN shared_memory INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE agents ADD COLUMN pending_action TEXT`,
      `ALTER TABLE memberships ADD COLUMN display_name TEXT`,
      `ALTER TABLE ai_profiles ADD COLUMN models TEXT`,
      `ALTER TABLE agents ADD COLUMN gateway_port INTEGER`,
      `ALTER TABLE agents ADD COLUMN gateway_token TEXT`,
    ]) {
      try {
        this.db.exec(alter);
      } catch {
        /* column exists */
      }
    }
  }

  // ---- AI profiles -------------------------------------------------------

  insertAIProfile(p: AIProfile): void {
    this.db
      .prepare(
        `INSERT INTO ai_profiles (id, owner_id, name, vendor, kind, model, models, secret_ref, created_at)
         VALUES (@id, @ownerId, @name, @vendor, @kind, @model, @models, @secretRef, @createdAt)`,
      )
      .run({ secretRef: null, ...p, models: p.models ? JSON.stringify(p.models) : null });
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
    const rows = this.db
      .prepare(`SELECT * FROM ai_profiles WHERE owner_id = ? ORDER BY created_at`)
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
    const rows = this.db
      .prepare(`SELECT id FROM hosts WHERE owner_id = ? ORDER BY created_at`)
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
                             host_id, runtime_ref, persona, shared_memory, pending_action,
                             created_at, updated_at)
         VALUES (@id, @ownerId, @name, @slug, @state, @stateReason, @aiProfileId,
                 @hostId, @runtimeRef, @persona, @sharedMemory, @pendingAction,
                 @createdAt, @updatedAt)`,
      )
      .run({
        stateReason: null,
        runtimeRef: null,
        ...a,
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
      .prepare(`SELECT * FROM agents WHERE owner_id = ? AND state != 'DELETED' ORDER BY created_at`)
      .all(ownerId) as any[];
    return rows.map(rowToAgent);
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

  setMembershipDisplayName(agentId: string, userId: string, name: string): void {
    this.db
      .prepare(`UPDATE memberships SET display_name = ? WHERE agent_id = ? AND user_id = ?`)
      .run(name, agentId, userId);
  }

  /** Records which telegram identity the first-contact claim bound (§12.4). */
  bindMembershipChannelUser(agentId: string, userId: string, channelUserId: string): void {
    this.db
      .prepare(
        `UPDATE memberships SET channel_user_id = ?, joined_at = COALESCE(joined_at, ?)
         WHERE agent_id = ? AND user_id = ?`,
      )
      .run(channelUserId, new Date().toISOString(), agentId, userId);
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
    pendingAction: r.pending_action ? JSON.parse(r.pending_action) : undefined,
    gatewayPort: r.gateway_port ?? undefined,
    gatewayToken: r.gateway_token ?? undefined,
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
    secretRef: r.secret_ref ?? undefined,
    createdAt: r.created_at,
  };
}
