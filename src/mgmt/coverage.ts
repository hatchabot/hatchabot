/**
 * Which management-chat tool covers each route that changes something, or
 * why the chat deliberately can't. A test (mgmtCoverage.test.ts) reads every
 * POST/PUT/PATCH/DELETE route in src/api and fails if one is missing here, or
 * if a named tool doesn't exist, so the chat can't quietly fall behind the app.
 *
 * `app:` entries are choices, not gaps. The categories:
 *  - secret: the request carries a credential (AI key, bot token, env value,
 *    password, OAuth client). Secrets never pass through a model.
 *  - fleet-wide/irreversible: kept to a deliberate click in the app.
 *  - browser: needs the person's own browser (sign-in, OAuth consent, files).
 *  - internal: plumbing for other components, not an owner action.
 *  - later: reasonable for the chat, not wired yet.
 */
export const COVERAGE: Record<string, string> = {
  // ---- agents: lifecycle ----
  'POST /v1/agents': 'create_agent',
  'DELETE /v1/agents/:id': 'app: fleet-wide/irreversible — deleting an agent erases its memory; a typed-name confirm in the app',
  'POST /v1/agents/:id/start': 'start_agent',
  'POST /v1/agents/:id/stop': 'stop_agent',
  'POST /v1/agents/:id/rebuild': 'rebuild_agent',
  'POST /v1/agents/:id/provision': 'app: later — retry a failed provision',
  'POST /v1/agents/:id/archive': 'archive_agent',
  'POST /v1/agents/:id/restore': 'restore_agent',
  'POST /v1/agents/:id/clone': 'clone_agent',
  'POST /v1/agents/:id/derive': 'app: later — new child from a template master',
  'PATCH /v1/agents/:id': 'rename_agent, set_group, set_source, pin_image, update_definition (persona/fields); embedMode: app: later',
  'POST /v1/agents/:id/model': 'set_model',
  'POST /v1/agents/:id/class': 'set_class',
  'POST /v1/agents/:id/move': 'set_group',
  'POST /v1/agents/icons/auto': 'app: internal — the home screen fills in icons',
  'POST /v1/agents/:id/checkpoint': 'checkpoint_memory',
  'POST /v1/agents/:id/recover-context': 'app: later — restore earlier conversations',
  'DELETE /v1/agents/:id/context-reset': 'app: browser — dismissing the "its chat was reset" notice',
  'POST /v1/agents/:id/move-host': 'app: later — move to another runner',
  'POST /v1/agents/:id/rehost': 'app: fleet-wide/irreversible — moves the agent to another Hatchabot server',
  'POST /v1/agents/:id/send': 'app: later — send a copy to another account',
  'POST /v1/agents/:id/bot-name/sync': 'app: later — rename the Telegram or Discord bot to match',
  'POST /v1/agents/:id/adopt-workspace': 'app: browser — adopting a hand-built OpenClaw workspace from host paths',
  'POST /v1/agents/import': 'app: browser — uploading a .hatchabot file',
  'POST /v1/agents/restore': 'app: browser — uploading a backup file',
  'POST /v1/agents/preflight': 'app: internal — cross-server move check',
  'POST /v1/agents/:id/message': 'app: internal — agent-to-agent consult',
  'POST /v1/agents/:id/seen': 'app: internal — opening a console marks its messages read',
  'POST /v1/agents/:id/console/approve': 'app: internal — the console panel approves its own browser',
  'POST /v1/agents/:id/push-definition': 'app: later — push a master definition to its children',
  'POST /v1/agents/:id/distill': 'app: later — a child proposes a lesson to its master',
  'POST /v1/agents/:id/proposals/:pid/resolve': 'app: later — accept/reject a child’s proposal',

  // ---- agents: definition & memory ----
  'PUT /v1/agents/:id/files/:name': 'update_definition (SOUL.md / AGENTS.md; never MEMORY.md)',
  'PUT /v1/agents/:id/fs/file': 'app: browser — a file from the owner\'s own computer (the Files tab)',
  'PUT /v1/agents/:id/params': 'app: later — setup values of a template copy',
  'POST /v1/agents/:id/snapshots': 'snapshot_agent',
  'POST /v1/agents/:id/snapshots/:snapId/restore': 'restore_snapshot',
  'DELETE /v1/agents/:id/snapshots/:snapId': 'app: later — delete a snapshot',

  // ---- agents: data, connections, env ----
  'POST /v1/agents/:id/data-sources': 'app: browser — host folders need the machine owner’s eye; repos need a deploy key added by hand',
  'PATCH /v1/agents/:id/data-sources/:dsId': 'app: browser — see data-sources',
  'DELETE /v1/agents/:id/data-sources/:dsId': 'app: later — detach a data source',
  'POST /v1/agents/:id/connections/attach': 'app: later — attach a connected Google account',
  'POST /v1/agents/:id/connections/detach': 'app: later — detach a Google account',
  'DELETE /v1/agents/:id/connections/:email': 'app: later — detach a Google account',
  'POST /v1/agents/:id/env': 'app: secret — environment values are credentials',
  'DELETE /v1/agents/:id/env/:envId': 'app: later — remove an environment variable',

  // ---- agents: people & reach ----
  'POST /v1/agents/:id/telegram': 'add_telegram (pool bot only; a pasted token stays in the app)',
  'DELETE /v1/agents/:id/telegram': 'remove_telegram',
  'POST /v1/agents/:id/channel-token': 'app: secret — a BotFather token',
  'POST /v1/agents/:id/channels/:kind': 'app: secret — Slack and Discord tokens',
  'PATCH /v1/agents/:id/channels/:kind': 'app: later — which Slack channel or Discord server the agent answers in',
  'POST /v1/agents/:id/channels/:kind/recheck': 'app: browser — a re-check with the platform from the Discord tab; nothing for the manager to decide',
  'POST /v1/discord-bots': 'app: secret — parking a Discord bot takes its token',
  'POST /v1/slack-apps': 'app: secret — parking a Slack app takes its tokens',
  'POST /v1/slack-apps/:id/recheck': 'app: browser — a re-check with Slack from the pool view; nothing for the manager to decide',
  'DELETE /v1/slack-apps/:id': 'app: secret — discards stored app tokens; the pool view is where that is done on purpose',
  'POST /v1/discord-bots/:id/recheck': 'app: browser — a re-check with Discord from the pool view; nothing for the manager to decide',
  'DELETE /v1/discord-bots/:id': 'app: secret — discards a stored bot token; the pool view is where that is done on purpose',
  'DELETE /v1/agents/:id/channels/:kind': 'remove_channel',
  'POST /v1/agents/:id/invites': 'create_invite',
  'POST /v1/agents/:id/pairing/approve': 'approve_member',
  'POST /v1/agents/:id/pairing/deny': 'app: later — turn a join request away',
  'DELETE /v1/agents/:id/members/:userId': 'remove_member',
  'PUT /v1/agents/:id/peers': 'set_peers',
  'POST /v1/agent-peers/mesh': 'set_peers (one agent at a time)',

  // ---- agents: scheduled tasks ----
  'POST /v1/agents/:id/crons': 'add_cron',
  'PATCH /v1/agents/:id/crons/:jobId': 'set_cron_enabled',
  'POST /v1/agents/:id/crons/:jobId/run': 'run_cron',
  'POST /v1/agents/:id/ask': 'app: browser — the owner talking to their agent is the console (and `hatchabot ask`); the management agent consults peers instead',
  'DELETE /v1/agents/:id/crons/:jobId': 'remove_cron',

  // ---- groups, classes, plans ----
  'POST /v1/groups/sort': 'app: later — sort a group A→Z',
  'POST /v1/groups/rename': 'app: browser — renaming a section of the home screen',
  'POST /v1/agents/:id/resources/clear': 'app: browser — forgetting a peak reading on the Resources view',
  'POST /v1/resources/clear': 'app: browser — forgetting every peak reading on the Resources view',
  'POST /v1/groups/move': 'app: later — reorder groups',
  'POST /v1/agent-classes': 'app: later — define a class',
  'PUT /v1/agent-classes/:id': 'app: later — edit a class',
  'DELETE /v1/agent-classes/:id': 'app: later — delete a class',
  'POST /v1/agent-todos': 'app: later — plan an agent',
  'DELETE /v1/agent-todos/:id': 'app: later — drop a planned agent',

  // ---- images ----
  'POST /v1/images': 'build_image',
  'POST /v1/images/:name/rebuild': 'rebuild_image',
  'DELETE /v1/images/:name': 'remove_image',
  'POST /v1/runtime/build': 'build_base_candidate (candidates only)',
  'POST /v1/runtime/images/promote': 'app: fleet-wide/irreversible — promoting a base image moves every agent',
  'DELETE /v1/runtime/images/:tag': 'delete_base_image',
  'POST /v1/hosts/:id/install-image': 'app: later — copy the runtime image to a runner',

  // ---- AI sources ----
  'POST /v1/ai-profiles': 'app: secret — adding a source takes its key or token',
  'PATCH /v1/ai-profiles/:id': 'app: later — rename/share a source, change its default model',
  'DELETE /v1/ai-profiles/:id': 'app: fleet-wide/irreversible — deleting a source strands its agents',
  'POST /v1/agents/:id/members/:userId/reopen': 'app: later — holding the door open is a live decision the owner makes',
  'POST /v1/agents/:id/members/known': 'app: later — admitting a person is something only the owner does',
  'POST /v1/tailscale/use-for-links': 'app: later — it edits the .env the service reads',
  'POST /v1/local-accounts/recover': 'app: secret — it sends a one-time sign-in link, and is used signed out',
  'POST /v1/local-accounts/:id/reset-link': 'app: secret — it mints a one-time sign-in link for another person',
  'POST /v1/auth/family-accounts': 'app: secret — it takes a new password, and cannot be undone',
  'POST /v1/tailscale/serve': 'app: later — putting the app on the tailnet is a decision for whoever runs the machine',
  'POST /v1/agents/:id/channel/swap': 'app: fleet-wide/irreversible — it hands the agent a new identity and ends every conversation on the old one',
  'POST /v1/agents/:id/channels/:kind/swap': 'app: fleet-wide/irreversible — it hands the agent a new Discord or Slack identity and ends every conversation on the old one',
  'POST /v1/agents/:id/allow-knocks': 'app: later — who may reach an agent is a setting, not a change to run',
  'POST /v1/ai-profiles/:id/move': 'app: browser — the order the owner wants their sources listed in',
  'POST /v1/ai-profiles/:id/adopt-agents': 'set_source (one agent at a time)',
  'POST /v1/ai-profiles/:id/migrate-agents': 'set_source (one agent at a time)',
  'POST /v1/ai-profiles/:id/apply-default-model': 'set_model (one agent at a time)',
  'POST /v1/ai-profiles/usage/sample': 'app: internal — the usage view refreshes itself',
  'PUT /v1/media-key': 'app: secret — the Gemini key',
  'PUT /v1/embed-default': 'app: later — which memory search engine new agents get (Status → Tools, or hatchabot embedder default)',
  'POST /v1/embed/move-all': 'app: later — move every agent to a memory search engine (Status → Tools, or hatchabot embedder move-all)',
  'POST /v1/agents/:id/hibernate': 'app: later — put an idle agent to sleep (hatchabot hibernate)',
  'POST /v1/agents/:id/wake': 'app: later — wake a sleeping agent (hatchabot wake); a message or its console wakes it too',
  'POST /v1/embedder/start': 'app: later — the machine\'s embedding service (Settings → Hosts, or hatchabot embedder start)',
  'POST /v1/embedder/stop': 'app: later — the machine\'s embedding service (Settings → Hosts, or hatchabot embedder stop)',
  'POST /v1/embedder/restart': 'app: later — the machine\'s embedding service (Settings → Hosts, or hatchabot embedder restart)',
  'POST /v1/embedder/guests': 'app: secret — a guest key is shown once (hatchabot embedder guest-add)',
  'DELETE /v1/embedder/guests/:name': 'app: later — remove a guest key (hatchabot embedder guest-rm)',
  'PUT /v1/rebuild-policy': 'app: later — the machine\'s rebuild policy (Settings → Images → Automatic rebuilds, or hatchabot rebuild-policy)',
  'PUT /v1/rebuild-concurrency': 'app: later — how many rebuilds run at once (Settings → Images → Automatic rebuilds, or hatchabot rebuild-policy --at-once N)',
  'DELETE /v1/media-key': 'app: later — remove the Gemini key',
  'PUT /v1/search-key': 'app: secret — the Brave key',
  'DELETE /v1/search-key': 'app: later — remove the Brave key',

  // ---- Telegram bots ----
  'POST /v1/pool': 'app: secret — adding a bot takes its token',
  'DELETE /v1/pool/:username': 'app: later — discard a pooled bot',
  'POST /v1/pool/:username/recheck': 'app: browser — a re-check with Telegram from the pool view; nothing for the manager to decide',

  // ---- machines & servers ----
  'POST /v1/hosts': 'app: secret — a runner address and SSH setup',
  'DELETE /v1/hosts/:id': 'app: fleet-wide/irreversible — removing a runner',
  'POST /v1/hosts/:id/drain': 'app: fleet-wide/irreversible — moves every agent off a runner',
  'POST /v1/peers': 'app: secret — another server’s access token',
  'DELETE /v1/peers/:id': 'app: later — forget another server',
  'POST /v1/workspaces/inspect': 'app: browser — reading host paths for adoption',
  'POST /v1/workspaces/scan-paths': 'app: browser — scanning host paths for adoption',
  'POST /v1/openclaw/quiesce': 'app: internal — adoption stops a hand-built instance',

  // ---- backups ----
  'POST /v1/backups/run': 'run_backup',
  'POST /v1/backups/restore': 'app: fleet-wide/irreversible — restoring from a backup set',
  'DELETE /v1/backups/:date': 'app: later — delete a backup set',

  // ---- people, accounts, sign-in ----
  'POST /v1/local-accounts': 'app: secret — account creation and invitations',
  'POST /v1/local-accounts/:id/password': 'app: secret — a password',
  'DELETE /v1/local-accounts/:id': 'app: fleet-wide/irreversible — removing an account',
  'POST /v1/local-accounts/bootstrap': 'app: browser — first sign-in',
  'POST /v1/local-accounts/claim': 'app: browser — claiming an invitation',
  'POST /v1/local-accounts/me/recovery-code': 'app: secret — it returns a recovery code, and needs the current password',
  'POST /v1/local-accounts/recover-with-code': 'app: secret — a recovery code and a new password, used signed out',
  'POST /v1/login': 'app: browser — signing in to this machine',
  'POST /v1/logout': 'app: browser — signing out of this machine',
  'POST /v1/session': 'app: browser — Google sign-in',
  'POST /v1/join': 'app: browser — someone joining an agent',
  'POST /v1/cli-tokens': 'app: secret — mints an access token',
  'DELETE /v1/cli-tokens/:id': 'app: later — revoke an access token',
  'DELETE /v1/account/telegram': 'app: later — unlink your Telegram',
  'DELETE /v1/account/discord': 'app: later — unlink your Discord',
  'PUT /v1/operator-profile': 'app: later — "about you"',
  'POST /v1/inbox/:id/accept': 'app: later — accept an agent sent to you',
  'POST /v1/inbox/:id/dismiss': 'app: later — dismiss an agent sent to you',

  // ---- Google ----
  'PUT /v1/google-oauth/client': 'app: secret — the OAuth client secret',
  'DELETE /v1/google-oauth/client': 'app: later — remove the OAuth client',
  'POST /v1/connections/google/start': 'app: browser — Google consent',
  'DELETE /v1/connections/:id': 'app: later — disconnect a Google account',

  // ---- the management agent itself ----
  'POST /v1/ops-agent': 'app: browser — setting up the account’s own management agent',
  'POST /v1/ops-agent/suggest': 'app: browser — asking the management agent what agents to add',
  'POST /v1/proposals/:id/:verb': 'app: internal — pressing Confirm or Cancel on a proposal',
};
