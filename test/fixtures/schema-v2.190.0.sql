-- The database Hatchabot v2.190.0 makes on its first start, as that release's
-- own Store wrote it: every table, index and row, and no schema number
-- (user_version 0), since v2.190.0 is from before the schema had one (HB-0813).
-- test/schemaVersion.test.ts opens it with today's Store. Never edit it: it
-- is what installs of that release have on disk.
CREATE TABLE ai_profiles (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
        vendor TEXT NOT NULL, kind TEXT NOT NULL, model TEXT NOT NULL,
        secret_ref TEXT, created_at TEXT NOT NULL
      , models TEXT, base_url TEXT, shared INTEGER NOT NULL DEFAULT 0, mgmt_llm INTEGER NOT NULL DEFAULT 0, default_source INTEGER NOT NULL DEFAULT 0, sort_order INTEGER);
CREATE TABLE agent_classes (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
        model TEXT, ai_profile_id TEXT, created_at TEXT NOT NULL
      , image TEXT, memory_cap TEXT, swap_allowance TEXT);
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
      , applied_profile_id TEXT, applied_model TEXT, applied_profile_prev TEXT, applied_profile_at TEXT, migrated_to TEXT, shared_paths TEXT, gateway_port INTEGER, gateway_token TEXT, model TEXT, group_name TEXT, image TEXT, sort_order INTEGER, params TEXT, param_values TEXT, param_files TEXT, group_access TEXT, parent_agent_id TEXT, rich_messages INTEGER, files_max_mb INTEGER, cron_triggers INTEGER, curated_skills TEXT, applied_curated_skills TEXT, browser INTEGER, embed_mode TEXT, applied_embed_mode TEXT, embed_indexed_at TEXT, embed_index_error TEXT, pending_schedules TEXT, memory_cap TEXT, memory_cap_baseline INTEGER, memory_cap_baseline_started TEXT, memory_peak_since INTEGER, memory_peak_cleared_at TEXT, hibernated_at TEXT, hibernate TEXT, woken_at TEXT, exported_at TEXT, rebuild_hook_due TEXT, rebuild_on_start TEXT, web_only_if_no_bot INTEGER, hibernate_mark INTEGER, swap_allowance TEXT, attention_ack TEXT, allow_knocks INTEGER NOT NULL DEFAULT 0, applied_peers TEXT, class_id TEXT, icon TEXT, icon_color TEXT, web_only INTEGER NOT NULL DEFAULT 0, ops INTEGER NOT NULL DEFAULT 0, applied_app_version TEXT, applied_search_key TEXT, browser_logins TEXT, browser_sites TEXT);
CREATE UNIQUE INDEX agents_owner_slug ON agents (owner_id, slug);
CREATE TABLE channels (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL,
        account_id TEXT NOT NULL, secret_ref TEXT NOT NULL, deep_link TEXT NOT NULL,
        created_at TEXT NOT NULL
      , settings TEXT);
CREATE INDEX channels_agent ON channels (agent_id);
CREATE TABLE memberships (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, user_id TEXT NOT NULL,
        role TEXT NOT NULL, channel_user_id TEXT, status TEXT NOT NULL,
        invited_by TEXT, joined_at TEXT
      , display_name TEXT, web_chat INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX memberships_agent_user
        ON memberships (agent_id, user_id);
CREATE TABLE snapshots (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, label TEXT NOT NULL,
        reason TEXT NOT NULL, files TEXT NOT NULL, created_at TEXT NOT NULL
      , params TEXT);
CREATE INDEX snapshots_agent ON snapshots (agent_id, created_at);
CREATE TABLE cli_tokens (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT,
        expires_at TEXT
      , scope TEXT, agent_id TEXT);
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
      , client_id TEXT, client_secret_at TEXT);
CREATE UNIQUE INDEX connections_owner_email
        ON connections (owner_id, kind, email);
CREATE TABLE connection_removals (
        agent_id TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT, PRIMARY KEY (agent_id, email)
      );
CREATE TABLE access_checks (
        agent_id TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL,
        present INTEGER, detail TEXT, checked_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, kind, subject)
      );
CREATE TABLE agent_connections (
        agent_id TEXT NOT NULL, connection_id TEXT NOT NULL,
        gmail_no_send INTEGER NOT NULL DEFAULT 0, attached_at TEXT, materialized_at TEXT,
        PRIMARY KEY (agent_id, connection_id)
      );
CREATE TABLE agent_peers (
        agent_id TEXT NOT NULL, peer_id TEXT NOT NULL,
        -- A consult is normally framed as UNTRUSTED input the peer must not act
        -- on: without that, anything able to steer one agent (an injected email,
        -- a household member) reaches through A2A into another agent's mail,
        -- files and calendar. This flag is the owner saying "these two are both
        -- mine and one drives the other on purpose" — a QA agent resetting the
        -- system under test is the case it exists for. Off unless asked for.
        allow_actions INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, peer_id)
      );
CREATE INDEX agent_peers_peer ON agent_peers (peer_id);
CREATE TABLE usage_snapshots (
        owner_id TEXT NOT NULL, day TEXT NOT NULL,
        total_tokens INTEGER NOT NULL, by_billing TEXT NOT NULL,
        cost_low REAL, cost_high REAL, captured_at TEXT NOT NULL, used_tokens INTEGER,
        PRIMARY KEY (owner_id, day)
      );
CREATE TABLE model_call_hours (
        agent_id TEXT NOT NULL, profile_id TEXT, hour TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 0, limited INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
        -- profile_id is PART OF THE KEY: an agent can move between sources
        -- mid-hour, and the counts already recorded belong to the source that
        -- served them. Keying on (agent_id, hour) alone let the later upsert
        -- retag the whole bucket — and since a source can be SHARED across
        -- accounts, that moved one account's counts onto another's dashboard
        -- (audit 2026-09-16).
        PRIMARY KEY (agent_id, profile_id, hour)
      );
CREATE INDEX model_call_hours_profile ON model_call_hours (profile_id, hour);
CREATE TABLE model_call_slots (
        agent_id TEXT NOT NULL, profile_id TEXT, slot TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 0, limited INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, profile_id, slot)
      );
CREATE INDEX model_call_slots_profile ON model_call_slots (profile_id, slot);
CREATE TABLE search_hours (
        agent_id TEXT NOT NULL, hour TEXT NOT NULL, provider TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, hour, provider)
      );
CREATE INDEX search_hours_hour ON search_hours (hour);
CREATE TABLE discord_bots (
        application_id TEXT PRIMARY KEY, bot_user_id TEXT, bot_name TEXT, secret_ref TEXT NOT NULL,
        owner_id TEXT, servers TEXT, warnings TEXT, add_to_server_url TEXT, checked_at TEXT, added_at TEXT NOT NULL
      , prior_chat_ids TEXT, archived_for TEXT, kind TEXT NOT NULL DEFAULT 'discord');
CREATE TABLE usage_cursor (
        agent_id TEXT PRIMARY KEY, last_ts TEXT NOT NULL, last_ok TEXT, last_limited TEXT, last_ok_profile TEXT
      );
CREATE TABLE limit_hits (
        agent_id TEXT NOT NULL, profile_id TEXT, at TEXT NOT NULL, model TEXT, log_key TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (agent_id, at, log_key)
      );
CREATE INDEX limit_hits_profile ON limit_hits (profile_id, at);
CREATE TABLE token_samples (
        agent_id TEXT NOT NULL, profile_id TEXT, at TEXT NOT NULL, total INTEGER NOT NULL,
        PRIMARY KEY (agent_id, at)
      );
CREATE TABLE token_samples_source (source TEXT NOT NULL);
CREATE TABLE usage_calls_through (agent_id TEXT PRIMARY KEY, slot TEXT NOT NULL);
CREATE TABLE applied_source_changes (
        agent_id TEXT NOT NULL, at TEXT NOT NULL, from_profile TEXT NOT NULL, to_profile TEXT NOT NULL,
        PRIMARY KEY (agent_id, at)
      );
CREATE TABLE store_migrations (name TEXT PRIMARY KEY, at TEXT NOT NULL);
CREATE TABLE usage_alerts (
        agent_id TEXT NOT NULL, owner_id TEXT NOT NULL, at TEXT NOT NULL,
        tokens INTEGER NOT NULL, usual INTEGER NOT NULL, told INTEGER NOT NULL, dismissed_at TEXT, covered TEXT,
        PRIMARY KEY (agent_id, at)
      );
CREATE TABLE recommendation_dismissals (
        owner_id TEXT NOT NULL, item_id TEXT NOT NULL, fingerprint TEXT NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY (owner_id, item_id)
      );
CREATE TABLE agent_token_rates (
        agent_id TEXT PRIMARY KEY, usd_per_token REAL NOT NULL, partial INTEGER NOT NULL, at TEXT NOT NULL
      );
CREATE TABLE agent_model_profiles (
        agent_id TEXT PRIMARY KEY, profile TEXT NOT NULL, at TEXT NOT NULL
      );
CREATE TABLE model_changes (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        from_model TEXT, to_model TEXT NOT NULL, profile_id TEXT,
        at TEXT NOT NULL,
        by TEXT NOT NULL, via TEXT NOT NULL, source TEXT NOT NULL,
        why TEXT, proposal_id TEXT, approx INTEGER NOT NULL DEFAULT 0,
        before TEXT, after TEXT,
        outcome TEXT NOT NULL DEFAULT 'pending', outcome_at TEXT, reasons TEXT,
        guard_proposal_id TEXT
      );
CREATE INDEX model_changes_agent ON model_changes (agent_id, at);
CREATE INDEX model_changes_owner ON model_changes (owner_id, at);
CREATE TABLE managed_crons (
        agent_id TEXT NOT NULL, name TEXT NOT NULL, job_id TEXT, at TEXT NOT NULL, message_hash TEXT,
        PRIMARY KEY (agent_id, name)
      );
CREATE TABLE adopt_pending (
        agent_id TEXT PRIMARY KEY, path TEXT NOT NULL, at TEXT NOT NULL
      );
CREATE TABLE cron_quieted (
        agent_id TEXT NOT NULL, job_id TEXT NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY (agent_id, job_id)
      );
CREATE TABLE cron_notes (
        agent_id TEXT NOT NULL, job_id TEXT NOT NULL, since_ms INTEGER NOT NULL, seen_run_ms INTEGER,
        PRIMARY KEY (agent_id, job_id)
      );
CREATE TABLE agent_token_health (
        agent_id TEXT PRIMARY KEY, health TEXT NOT NULL, at TEXT NOT NULL
      );
CREATE TABLE agent_loop_marks (
        agent_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, at TEXT NOT NULL,
        ms INTEGER, channel TEXT,
        PRIMARY KEY (agent_id, kind, key, at)
      );
CREATE TABLE token_incidents (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        kind TEXT NOT NULL, key TEXT NOT NULL,
        opened_at TEXT NOT NULL, updated_at TEXT NOT NULL, cleared_at TEXT, told_at TEXT,
        count INTEGER NOT NULL, first_at TEXT, last_at TEXT, text TEXT NOT NULL, fix TEXT
      );
CREATE INDEX token_incidents_agent ON token_incidents (agent_id, kind, key);
CREATE TABLE agent_context_caps (
        agent_id TEXT PRIMARY KEY, tokens INTEGER, applied_model TEXT, applied_at TEXT, set_at TEXT NOT NULL
      );
CREATE TABLE token_actions (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, owner_id TEXT NOT NULL, kind TEXT NOT NULL,
        at TEXT NOT NULL, by TEXT NOT NULL, via TEXT NOT NULL, why TEXT, proposal_id TEXT,
        detail TEXT, outcome TEXT NOT NULL
      );
CREATE INDEX token_actions_owner ON token_actions (owner_id, at);
CREATE TABLE budgets (
        scope TEXT PRIMARY KEY, owner_id TEXT NOT NULL, usd REAL NOT NULL,
        at_limit TEXT NOT NULL DEFAULT 'warn', set_at TEXT NOT NULL, set_by TEXT
      );
CREATE TABLE agent_cost_days (
        agent_id TEXT NOT NULL, day TEXT NOT NULL, usd REAL NOT NULL,
        unpriced_tokens REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, day)
      );
CREATE TABLE budget_marks (
        scope TEXT NOT NULL, month TEXT NOT NULL, level INTEGER NOT NULL, usd REAL NOT NULL,
        at TEXT NOT NULL, told_at TEXT,
        PRIMARY KEY (scope, month, level, usd)
      );
CREATE TABLE problem_reports (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, created_at TEXT NOT NULL, by TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, agent_id TEXT, sent_at TEXT
      );
CREATE TABLE spend_alerts (
        scope TEXT PRIMARY KEY, owner_id TEXT NOT NULL, step_usd REAL NOT NULL, set_at TEXT NOT NULL, set_by TEXT
      );
CREATE TABLE spend_alert_state (
        scope TEXT NOT NULL, month TEXT NOT NULL, step_usd REAL NOT NULL, k_told INTEGER NOT NULL, told_at TEXT,
        PRIMARY KEY (scope, month)
      );
CREATE TABLE budget_pauses (
        agent_id TEXT NOT NULL, month TEXT NOT NULL, scope TEXT NOT NULL,
        paused_at TEXT NOT NULL, resumed_at TEXT, resumed_by TEXT, kind TEXT NOT NULL DEFAULT 'pause', from_model TEXT, to_model TEXT, replies TEXT, already_stopped INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, month)
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
CREATE TABLE agent_app_pending (
        agent_id TEXT PRIMARY KEY, source TEXT NOT NULL, ref TEXT NOT NULL, vals TEXT NOT NULL,
        created_at TEXT NOT NULL, error TEXT
      , gen TEXT);
CREATE TABLE agent_apps (
        agent_id TEXT PRIMARY KEY, app TEXT NOT NULL, source TEXT NOT NULL, ref TEXT NOT NULL,
        sha TEXT NOT NULL, manifest TEXT NOT NULL, previous_sha TEXT, previous_manifest TEXT,
        installed_at TEXT NOT NULL, test_ok INTEGER
      );
CREATE TABLE invites (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, code TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL, redeemed_at TEXT, redeemed_by TEXT
      , expect_handle TEXT, web_chat INTEGER NOT NULL DEFAULT 0, redeemed_via TEXT);
CREATE TABLE data_sources (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
        kind TEXT NOT NULL, access TEXT NOT NULL, mount_name TEXT NOT NULL,
        host_path TEXT, repo_url TEXT, secret_ref TEXT, pub_key TEXT,
        created_at TEXT NOT NULL
      , mount_at_host_path INTEGER NOT NULL DEFAULT 0, sync_error TEXT, synced_at TEXT);
CREATE TABLE data_source_removals (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
        mount_name TEXT, secret_ref TEXT, created_at TEXT NOT NULL
      , repo_url TEXT);
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
CREATE TABLE pairing_window (
        agent_id TEXT PRIMARY KEY, until TEXT NOT NULL, opened_for TEXT,
        -- Who the window is FOR, when the owner said so when inviting: a
        -- Telegram @handle or numeric id. Only a knock that matches is
        -- claimed, so an open window is not "whoever messages first wins".
        expect TEXT
      );
CREATE TABLE pairing_windows (
        agent_id TEXT NOT NULL, seat TEXT NOT NULL, until TEXT NOT NULL, opened_for TEXT, expect TEXT, generation TEXT,
        PRIMARY KEY (agent_id, seat)
      );
CREATE TABLE agent_seed (
        agent_id TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL,
        PRIMARY KEY (agent_id, name)
      );
CREATE INDEX data_sources_agent ON data_sources (agent_id);
CREATE TABLE local_accounts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT,
        pw_hash TEXT NOT NULL,
        pw_salt TEXT NOT NULL,
        host_owner INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        -- An account the host owner created but nobody has claimed yet: no
        -- usable password until the person opens the claim link and sets one,
        -- so the owner never has to invent a password and send it over
        -- WhatsApp. Cleared on claim.
        claim_code TEXT,
        claim_expires TEXT
      , recovery_hash TEXT, recovery_salt TEXT, recovery_created TEXT);
CREATE UNIQUE INDEX local_accounts_username_ci ON local_accounts (lower(username));
CREATE TABLE accounts (
        owner_id TEXT PRIMARY KEY,
        email TEXT,
        last_seen TEXT NOT NULL
      , telegram_user_id TEXT);
CREATE INDEX accounts_email ON accounts (email);
CREATE TABLE owner_prefs (
        owner_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_id, key)
      );
CREATE TABLE telegram_unlinks (
        owner_id TEXT NOT NULL,
        channel_user_id TEXT NOT NULL,
        unlinked_at TEXT NOT NULL,
        PRIMARY KEY (owner_id, channel_user_id)
      );
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
CREATE TABLE mgmt_proposals (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        record TEXT NOT NULL,
        status TEXT NOT NULL,
        outcome TEXT,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER
      );
CREATE TABLE embed_tokens (
        agent_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        prev_token_hash TEXT
      , host_id TEXT);
CREATE TABLE ops_tokens (
        agent_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      , doorman_key TEXT);
CREATE INDEX mgmt_proposals_owner ON mgmt_proposals (owner_id, status);
CREATE TABLE member_identities (
        agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        channel_user_id TEXT NOT NULL,
        bound_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, user_id, kind)
      );
CREATE TABLE agent_seen (
        owner_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        seen_at INTEGER NOT NULL,
        PRIMARY KEY (owner_id, agent_id)
      );
CREATE TABLE agent_context_reset (
        agent_id TEXT PRIMARY KEY,
        reset_at TEXT NOT NULL,
        lost_messages INTEGER NOT NULL,
        found_at TEXT NOT NULL,
        dismissed_at TEXT
      );
CREATE TABLE session_epochs (
        owner_id TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL,
        bumped_at TEXT NOT NULL
      );
CREATE TABLE agent_disk (
        agent_id TEXT PRIMARY KEY,
        bytes INTEGER NOT NULL,
        measured_at TEXT NOT NULL
      );
CREATE TABLE agent_recent (
        agent_id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        agent_id TEXT,
        host_id TEXT,
        kind TEXT NOT NULL,
        requested_by TEXT,
        requested_at TEXT NOT NULL,
        params TEXT NOT NULL,
        step TEXT,
        step_at TEXT,
        status TEXT NOT NULL,
        outcome TEXT,
        recovery TEXT,
        boot_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );
CREATE INDEX operations_agent ON operations (agent_id, requested_at DESC);
CREATE INDEX operations_status ON operations (status);
CREATE TABLE move_receipts (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        op_id TEXT,
        outcome TEXT,
        boot_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE rate_hits (
        bucket TEXT NOT NULL,
        at INTEGER NOT NULL
      );
CREATE INDEX rate_hits_bucket_at ON rate_hits (bucket, at);
CREATE TABLE signin_links (
        nonce TEXT PRIMARY KEY,
        sub TEXT NOT NULL,
        used_at TEXT NOT NULL,
        keep_until INTEGER NOT NULL
      );
CREATE TABLE second_factors (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT,
        credential_id TEXT,
        rp_id TEXT,
        data TEXT NOT NULL,
        sign_count INTEGER NOT NULL DEFAULT 0,
        last_step INTEGER,
        created_at TEXT NOT NULL,
        confirmed_at TEXT,
        last_used_at TEXT
      );
CREATE INDEX second_factors_owner ON second_factors (owner_id, kind);
CREATE UNIQUE INDEX second_factors_credential ON second_factors (credential_id) WHERE credential_id IS NOT NULL;
CREATE TABLE known_devices (
        owner_id TEXT NOT NULL,
        device_hash TEXT NOT NULL,
        label TEXT,
        source TEXT,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        PRIMARY KEY (owner_id, device_hash)
      );
CREATE TABLE security_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        owner_id TEXT,
        detail TEXT
      );
CREATE INDEX security_log_at ON security_log (at);
CREATE TABLE security_notices (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        about_owner TEXT,
        text TEXT NOT NULL,
        seen_at TEXT
      );
CREATE INDEX security_notices_owner ON security_notices (owner_id, seen_at);
CREATE TABLE public_pass_revocations (
        id TEXT PRIMARY KEY,
        until INTEGER NOT NULL
      );
CREATE TABLE second_factor_generations (
        owner_id TEXT PRIMARY KEY,
        gen INTEGER NOT NULL,
        bumped_at TEXT NOT NULL
      );
CREATE TABLE first_account (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner_id TEXT NOT NULL,
        at TEXT NOT NULL,
        done_at TEXT
      );
CREATE INDEX agents_image ON agents (image);
CREATE UNIQUE INDEX channels_agent_kind ON channels (agent_id, kind);
CREATE UNIQUE INDEX channels_kind_account ON channels (kind, account_id);
CREATE UNIQUE INDEX channels_kind_account_ci ON channels (kind, account_id COLLATE NOCASE);
CREATE INDEX agent_connections_conn ON agent_connections (connection_id);
CREATE UNIQUE INDEX ai_profiles_mgmt_llm_one
         ON ai_profiles (owner_id) WHERE mgmt_llm = 1;
CREATE UNIQUE INDEX ai_profiles_default_one
         ON ai_profiles (default_source) WHERE default_source = 1;
CREATE INDEX agents_class ON agents (class_id);
INSERT INTO token_samples_source (source) VALUES ('transcripts-archives');
INSERT INTO store_migrations (name, at) VALUES ('2026-09-29-memory-always-shared', '2026-11-01T00:00:00.000Z');
INSERT INTO store_migrations (name, at) VALUES ('2026-10-22-budget-cheaper-reopen', '2026-11-01T00:00:00.000Z');
INSERT INTO store_migrations (name, at) VALUES ('2026-10-25-applied-source-changes', '2026-11-01T00:00:00.000Z');
INSERT INTO store_migrations (name, at) VALUES ('2026-10-26-budget-pause-already-stopped', '2026-11-01T00:00:00.000Z');
INSERT INTO store_migrations (name, at) VALUES ('2026-09-29-dm-policy-unchanged', '2026-11-01T00:00:00.000Z');
INSERT INTO store_migrations (name, at) VALUES ('legacy-owner-leftovers-v1', '2026-11-01T00:00:00.000Z');
