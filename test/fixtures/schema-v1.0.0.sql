-- The database Hatchabot v1.0.0 makes on its first start, as that release's
-- own Store wrote it: every table, index and row, and no schema number
-- (user_version 0), since v1.0.0 is from before the schema had one (HB-0813).
-- test/schemaVersion.test.ts opens it with today's Store. Never edit it: it
-- is what installs of that release have on disk.
CREATE TABLE ai_profiles (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
        vendor TEXT NOT NULL, kind TEXT NOT NULL, model TEXT NOT NULL,
        secret_ref TEXT, created_at TEXT NOT NULL
      , models TEXT, base_url TEXT, shared INTEGER NOT NULL DEFAULT 0, mgmt_llm INTEGER NOT NULL DEFAULT 0, default_source INTEGER NOT NULL DEFAULT 0);
CREATE TABLE agent_classes (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
        model TEXT, ai_profile_id TEXT, created_at TEXT NOT NULL
      );
CREATE UNIQUE INDEX agent_classes_owner_name ON agent_classes (owner_id, name);
CREATE TABLE operator_profile (
        owner_id TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL
      );
CREATE TABLE agent_todos (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
        note TEXT, created_at TEXT NOT NULL
      );
CREATE INDEX agent_todos_owner ON agent_todos (owner_id);
CREATE TABLE hosts (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL,
        provider TEXT NOT NULL, name TEXT NOT NULL, settings TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE TABLE agents (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
        slug TEXT NOT NULL, state TEXT NOT NULL, state_reason TEXT,
        ai_profile_id TEXT NOT NULL, host_id TEXT NOT NULL, runtime_ref TEXT,
        persona TEXT NOT NULL, shared_memory INTEGER NOT NULL DEFAULT 0,
        pending_action TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      , applied_profile_id TEXT, applied_model TEXT, migrated_to TEXT, shared_paths TEXT, gateway_port INTEGER, gateway_token TEXT, model TEXT, group_name TEXT, image TEXT, sort_order INTEGER, params TEXT, param_values TEXT, param_files TEXT, group_access TEXT, parent_agent_id TEXT, rich_messages INTEGER, cron_triggers INTEGER, pending_schedules TEXT, applied_peers TEXT, class_id TEXT);
CREATE UNIQUE INDEX agents_owner_slug ON agents (owner_id, slug);
CREATE TABLE channels (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL,
        account_id TEXT NOT NULL, secret_ref TEXT NOT NULL, deep_link TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE INDEX channels_agent ON channels (agent_id);
CREATE TABLE memberships (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, user_id TEXT NOT NULL,
        role TEXT NOT NULL, channel_user_id TEXT, status TEXT NOT NULL,
        invited_by TEXT, joined_at TEXT
      , display_name TEXT);
CREATE UNIQUE INDEX memberships_agent_user
        ON memberships (agent_id, user_id);
CREATE TABLE snapshots (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, label TEXT NOT NULL,
        reason TEXT NOT NULL, files TEXT NOT NULL, created_at TEXT NOT NULL
      );
CREATE INDEX snapshots_agent ON snapshots (agent_id, created_at);
CREATE TABLE cli_tokens (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT,
        expires_at TEXT
      , agent_id TEXT);
CREATE INDEX cli_tokens_owner ON cli_tokens (owner_id);
CREATE TABLE mgmt_heartbeat (
        owner_id TEXT PRIMARY KEY, bot_username TEXT NOT NULL,
        mode TEXT NOT NULL, llm TEXT, allowlisted INTEGER NOT NULL,
        seen_at TEXT NOT NULL
      );
CREATE TABLE agent_proposals (
        id TEXT PRIMARY KEY, master_agent_id TEXT NOT NULL,
        child_agent_id TEXT NOT NULL, child_name TEXT NOT NULL,
        text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
CREATE INDEX proposals_master ON agent_proposals (master_agent_id, status);
CREATE TABLE connections (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL,
        email TEXT NOT NULL, services TEXT, secret_ref TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE UNIQUE INDEX connections_owner_email
        ON connections (owner_id, kind, email);
CREATE TABLE agent_connections (
        agent_id TEXT NOT NULL, connection_id TEXT NOT NULL,
        gmail_no_send INTEGER NOT NULL DEFAULT 0, attached_at TEXT, materialized_at TEXT,
        PRIMARY KEY (agent_id, connection_id)
      );
CREATE TABLE agent_peers (
        agent_id TEXT NOT NULL, peer_id TEXT NOT NULL,
        PRIMARY KEY (agent_id, peer_id)
      );
CREATE INDEX agent_peers_peer ON agent_peers (peer_id);
CREATE TABLE usage_snapshots (
        owner_id TEXT NOT NULL, day TEXT NOT NULL,
        total_tokens INTEGER NOT NULL, by_billing TEXT NOT NULL,
        cost_low REAL, cost_high REAL, captured_at TEXT NOT NULL,
        PRIMARY KEY (owner_id, day)
      );
CREATE TABLE posture_snapshots (
        owner_id TEXT NOT NULL, day TEXT NOT NULL,
        risk_keys TEXT NOT NULL, captured_at TEXT NOT NULL,
        PRIMARY KEY (owner_id, day)
      );
CREATE TABLE peers (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
        url TEXT NOT NULL, secret_ref TEXT NOT NULL, created_at TEXT NOT NULL
      );
CREATE INDEX peers_owner ON peers (owner_id);
CREATE TABLE agent_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL, at TEXT NOT NULL,
        event TEXT NOT NULL, detail TEXT
      );
CREATE INDEX agent_events_at ON agent_events (agent_id, id DESC);
CREATE TABLE invites (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, code TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL, redeemed_at TEXT, redeemed_by TEXT
      );
CREATE TABLE data_sources (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
        kind TEXT NOT NULL, access TEXT NOT NULL, mount_name TEXT NOT NULL,
        host_path TEXT, repo_url TEXT, secret_ref TEXT, pub_key TEXT,
        created_at TEXT NOT NULL
      , mount_at_host_path INTEGER NOT NULL DEFAULT 0, sync_error TEXT, synced_at TEXT);
CREATE TABLE agent_env (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
        name TEXT NOT NULL, secret_ref TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(agent_id, name)
      );
CREATE TABLE agent_group_order (
        owner_id TEXT NOT NULL, group_name TEXT NOT NULL, sort_order INTEGER NOT NULL,
        PRIMARY KEY (owner_id, group_name)
      );
CREATE TABLE agent_seed (
        agent_id TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL,
        PRIMARY KEY (agent_id, name)
      );
CREATE INDEX data_sources_agent ON data_sources (agent_id);
CREATE TABLE accounts (
        owner_id TEXT PRIMARY KEY,
        email TEXT,
        last_seen TEXT NOT NULL
      , telegram_user_id TEXT);
CREATE INDEX accounts_email ON accounts (email);
CREATE TABLE agent_shares (
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
      , source_agent_id TEXT);
CREATE INDEX shares_to_owner ON agent_shares (to_owner, status);
CREATE INDEX shares_to_email ON agent_shares (to_email, status);
CREATE INDEX accounts_email_nocase ON accounts (email COLLATE NOCASE);
CREATE INDEX shares_to_email_nocase ON agent_shares (to_email COLLATE NOCASE, status);
CREATE INDEX channels_account_nocase ON channels (account_id COLLATE NOCASE);
CREATE INDEX invites_agent ON invites (agent_id);
CREATE TABLE derived_images (
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
CREATE INDEX agents_image ON agents (image);
CREATE INDEX agent_connections_conn ON agent_connections (connection_id);
CREATE UNIQUE INDEX ai_profiles_mgmt_llm_one
         ON ai_profiles (owner_id) WHERE mgmt_llm = 1;
CREATE UNIQUE INDEX ai_profiles_default_one
         ON ai_profiles (default_source) WHERE default_source = 1;
CREATE INDEX agents_class ON agents (class_id);
