# Architecture map

Where the code for each part of Hatchabot lives, so a diagnosis can go
straight to the right file. Two files are very large: `src/api/routes.ts`
(every HTTP route of the app, 12k lines) and `web/index.html` (the whole web
app, 14k lines). Do not read them top to bottom: search them for the route
string or function name listed below, then read around the hit.

Conventions used here:

- `src/api/routes.ts` — `'/v1/backups/run'`: routes are written as they appear in this file, quotes included, so a literal search finds the handler.
- Web functions are names of functions in `web/index.html`; search for "function name(" to find one.
- Tests live in the test folder, usually named after the module: `test/budgets.test.ts` covers src/orchestrator/budgets.ts.
- `docs/features.md` explains what each feature does for a person.
- `docs/field-reports.md` explains Report a problem and field reports.
- On each bullet, the names after the path are literal strings in that file: functions, route strings, table names or tool names.

## The service and startup

Hatchabot is one Node process (Fastify, run with tsx) that serves the web app
and the /v1 API, owns a SQLite database, and drives Docker. At start it opens
the database, builds the runtime providers, reconciles every agent's state with
what Docker reports, registers sign-in, then all routes, then starts its timers.
Almost every route and background loop is registered inside one function,
registerRoutes, in `src/api/routes.ts`.

- `src/index.ts` — `startReconcileLoop`, `registerAuth`, `registerRoutes`, `ensureOpsServer`, `syncEnvFile`: the boot order; also the TLS options, bind address and the daily posture sweep.
- `src/envCompat.ts` — `applyLegacyEnv`, `defaultDbPath`, `defaultBackupsDir`: old AGENTCLAW_* settings are aliased to HATCHABOT_*; default data locations.
- `src/config/envCatalog.ts` — `ENV_SETTINGS`, `ENV_GROUPS`: every setting in .env, its default and its one-line meaning.
- `src/config/envFile.ts` — `syncEnvFile`, `renderEnv`: rewrites .env into the catalog's layout at start-up, keeping a backup.
- `src/api/routes.ts` — `registerRoutes`, `ApiDeps`, `providerFor`, `ownedAgent`, `ownsLocalHost`, `capProblem`: the route registry; ownership checks and the per-person agent cap.
- `src/api/errorHandler.ts` — `installErrorHandler`: how thrown errors become JSON replies.
- `src/store/store.ts` — `Store`, `agents`, `hosts`, `ai_profiles`, `agent_events`, `store_migrations`: the whole SQLite data layer (one class); tables are created and migrated by its constructor.
- `src/domain/types.ts` — `Agent`, `AgentState`, `AIProfile`, `Host`, `Channel`: the shared record types.
- `src/domain/stateMachine.ts` — `canTransition`, `assertTransition`: the legal agent state changes (PROVISIONING, RUNNING, STOPPED, ARCHIVED, FAILED, ...).
- `src/secrets/localSecretStore.ts` — `LocalSecretStore`: encrypted secrets (bot tokens, keys) in the database, keyed by HATCHABOT_SECRET_KEY.
- `deploy/hatchabot.service` — `ExecStart`: the systemd user unit that runs the service.

## Install and upgrade

The one-line installer downloads a prebuilt bundle (its own Node and
dependencies) where one exists for the platform, and otherwise clones the
repository and installs natively. Release channels (stable, beta) are named in
`channels.json`. Upgrades check out another release and restart the service;
the doctor command prints what is wrong with an install.

- `install.sh` — `install_bundle`, `install_native`, `newest_release`, `in_docker_group`: the one-line installer.
- `channels.json` — `stable`, `beta`: which release each channel points at.
- `scripts/build-bundle.sh` — `PLATFORM`, `linux-arm64`, `darwin-arm64`: builds the per-platform release bundle.
- `scripts/sqlite-driver.sh` — `better-sqlite3`, `--compile`: makes sure the database driver loads on this machine.
- `scripts/setup-host.sh` — `say`, `launchd`: clone-based setup of a fresh host (dependencies, .env, the service; launchd on macOS).
- `scripts/install-service.sh` — `sed_escape`, `systemctl`: installs the systemd user service on Linux.
- `scripts/ensure-deps.sh` — `npm ci`: installs dependencies only when the lockfile moved.
- `scripts/upgrade.sh` — `rollback`, `restore_deps`, `vernewer`: the upgrade command (a channel or a tag), with rollback on failure.
- `scripts/follow-channel.sh` — `--install`, `--uninstall`, `MAX_TRIES`: optional timer that keeps an install on its channel (retries a failing install less often, then sets it aside).
- `scripts/uninstall.sh` — `--purge`, `--installed`, `volumes`, `other_installs`: removes the install it lives in (or, with `--installed`, the one the service runs), keeping data unless asked.
- `scripts/upgrade-check.sh` — `CREATE TABLE IF NOT EXISTS`: checks that databases from older releases still open.
- `bin/hatchabot.mjs` — `tsx`, `process.argv`: the hatchabot command; runs the CLI under tsx.
- `src/cli.ts` — `parseArgs`, `matchAgent`, `'upgrade'`, `'doctor'`, `'reach'`: every CLI command, dispatched by name.
- `src/doctor.ts` — `gatherFacts`, `doctorReport`, `publicAccessLines`, `swapLine`: what `hatchabot doctor` checks and prints.
- `src/ops/autoUpgrade.ts` — `autoUpgradeStatus`: whether automatic upgrades are set up (used by doctor).
- `src/domain/appVersion.ts` — `APP_VERSION`: the running version.

## Sign-in and accounts

Three modes, chosen by HATCHABOT_AUTH: accounts (local usernames and
passwords, the installer default), password (one shared password) and identity
(Google sign-in). A session is a cookie; the CLI uses tokens. Each person has a
recovery code, and an owner can send a reset link. A second factor (code app,
passkey, backup codes) is required of owners before public access can be on.

- `src/api/auth.ts` — `registerAuth`, `authModeFromEnv`, `bindHostFor`, `throttled`, `sessionTtlMs`: the auth hook on every request, login throttling, `'/v1/login'`, `'/v1/logout'`.
- `src/api/routedPath.ts` — `routedPath`: the path as the router sees it (cut at `?` and `#`), for every check that decides on a path; exemptions use the matched route (`req.routeOptions.url`).
- `src/api/accountsAuth.ts` — `registerAccountRoutes`, `hashPassword`, `newRecoveryCode`, `setupCode`, `'/v1/local-accounts/claim'`, `'/v1/local-accounts/recover-with-code'`: local accounts, first-account claim and recovery.
- `src/api/identity.ts` — `IdentityVerifier`, `identityConfigFromEnv`: Google ID-token checks for identity mode.
- `src/api/sessionCookie.ts` — `setSessionCookie`, `readSessionCookie`, `SESSION_COOKIE`: the session cookie.
- `src/api/signinLink.ts` — `registerSigninLink`, `verifySigninToken`: one-time sign-in links.
- `src/api/secondFactor.ts` — `registerSecondFactorRoutes`, `'/v1/second-factor/challenge'`, `'/v1/second-factor/passkey'`: second factor enrolment and checks.
- `src/api/totp.ts` — `totpVerify`, `newBackupCode`: code-app and backup-code maths.
- `src/api/webauthn.ts` — `verifyRegistration`, `verifyAssertion`: passkeys.
- `src/api/principal.ts` — `principalOf`, `ownerIdOf`, `LOCAL_OWNER`: who a request is.
- `src/api/requestOrigin.ts` — `registerOriginCheck`: refuses cross-site writes.
- `src/api/routes.ts` — `'/v1/auth/family-accounts'`, `'/v1/local-accounts/recover'`, `'/v1/cli-tokens'`, `'/v1/accounts'`, `'/v1/account'`: switching to accounts, Telegram recovery, CLI tokens, the account menu.
- `src/store/store.ts` — `local_accounts`, `accounts`, `session_epochs`, `second_factors`, `signin_links`, `cli_tokens`: where it is stored.
- `web/index.html` — `showLogin`, `acctSignIn`, `forgotPassword`, `askSecondFactor`, `loadAccounts`, `turnOnFamilyAccounts`, `showRecoveryCode`: the sign-in screen and account management.

## AI sources and Claude login

An AI source (an "AI profile" in code) is a Claude plan via a setup token, an
API key, or a local model server. Each agent uses one source and one model.
Credentials are stored encrypted and written into the agent at provision or
rebuild; a model change on the same source applies live, a source change needs
a rebuild. "Not logged in" after a source switch is usually a session pinned
to the old runtime (runtimePins).

- `src/api/routes.ts` — `'/v1/ai-profiles'`, `'/v1/ai-profiles/:id'`, `'/v1/ai-profiles/:id/migrate-agents'`, `'/v1/ai-profiles/:id/available-models'`, `'/v1/agents/:id/model'`, `applyModelToRuntime`, `switchAgentToSource`: sources and model changes.
- `src/orchestrator/provision.ts` — `buildRuntimeSpec`, `effectiveModel`, `prefixedModelRef`, `claudeAuthDir`: how a source becomes the agent's environment and model reference.
- `src/openclaw/configWriter.ts` — `buildConfigCommands`, `setup-token`: the OpenClaw config commands that set auth and model inside the container.
- `src/orchestrator/runtimePins.ts` — `listRuntimePins`, `clearStaleRuntimePins`, `clearStaleRuntimePinsWhenUp`: clears sessions pinned to a runtime the agent no longer uses.
- `src/orchestrator/modelOptions.ts` — `MODEL_CATALOG`, `modelOptionsFor`, `sourceModels`: which models each source offers.
- `src/orchestrator/runtimeModels.ts` — `runtimeModels`, `parseRuntimeModels`: the models a running OpenClaw reports.
- `src/config/claudePlan.ts` — `claudePlanAllowed`, `CLAUDE_PLAN_HOSTED`: Claude plan sources are refused on hosted installs.
- `src/api/mgmtLlm.ts` — `pickMgmtProfile`, `runMgmtCompletion`: Hatchabot's own small model calls (for example auto icons).
- `src/store/store.ts` — `ai_profiles`, `getAIProfile`: where sources are stored.
- `web/index.html` — `openAiDlg`, `addAiProfile`, `renderAiList`, `switchProfile`, `switchModel`, `openApplyModel`, `moveAgentsToSource`: the AI sources panel and model picker.

## Creating, provisioning and rebuilding agents

Creating an agent writes its record, then a background task provisions it: a
bot is leased, a runtime spec is built, and the provider runs a one-shot "seed"
script against the agent's volume (OpenClaw config commands, workspace files),
then starts the container and waits for it to be healthy. Rebuild re-runs the
same seed against the existing volume, so memory survives. A seed failure names
the step that failed.

- `src/api/routes.ts` — `'/v1/agents'`, `'/v1/agents/:id/rebuild'`, `'/v1/agents/:id/provision'`, `'/v1/agents/:id/start'`, `'/v1/agents/:id/stop'`, `kickProvision`, `kickRebuild`, `rebuildSweep`: create, retry, rebuild, start and stop.
- `src/orchestrator/provision.ts` — `createAgentRecord`, `provisionAgent`, `runProvisionSteps`, `rebuildAgent`, `buildRuntimeSpec`, `waitForHealthy`: the provisioning pipeline.
- `src/providers/localDockerProvider.ts` — `provision`, `SEED_STEP_MARK`, `seedFailure`, `seedStepLabel`: the seed script and how its failure is reported.
- `src/openclaw/configWriter.ts` — `buildConfigCommands`, `batchConfigCommands`, `seedInvocation`, `skipIf`: the OpenClaw config steps; skipIf and markers skip steps already done.
- `src/openclaw/workspace.ts` — `buildWorkspaceSeed`, `memoryPolicySection`, `dataSourcesSection`: the SOUL.md, AGENTS.md and MEMORY.md written on first provision, and the managed sections refreshed on rebuild.
- `src/orchestrator/busy.ts` — `whileBusy`, `AgentBusyError`: one operation per agent at a time.
- `src/orchestrator/buildFailure.ts` — `buildFailureReason`: turns a build error into a plain reason.
- `src/orchestrator/rebuildPolicy.ts` — `rebuildNeed`, `pickAutoRebuilds`, `inQuietHours`: when an agent needs a rebuild and automatic rebuilds.
- `src/orchestrator/template.ts` — `exportTemplate`, `importTemplate`: templates (a trained copy for someone else); also behind clone.
- `src/orchestrator/adopt.ts` — `inspectWorkspace`, `applyWorkspace`: adopting an existing OpenClaw workspace.
- `src/orchestrator/openclawImport.ts` — `discoverOpenclawAgents`, `quiesceOpenclawBots`: finding OpenClaw agents already on the machine.
- `src/orchestrator/archive.ts` — `archiveAgent`: archiving (stops the agent and gives its bot back).
- `src/api/routes.ts` — `'/v1/agents/:id/archive'`, `'/v1/agents/:id/restore'`, `archiving`, `progressOf`: archive (the `archiving` marker the list shows while the conversation is saved first) and unarchive.
- `src/orchestrator/provision.ts` — `provisionChannelOrGoWebOnly`, `webOnlyIfNoBot`: no pool bot free on an unarchive, clone, derive or template import → the agent goes on web-only instead of waiting for a token (create still asks).
- `src/orchestrator/timezone.ts` — `agentTimeZone`: the time zone every agent gets (`HATCHABOT_TIMEZONE`, else the machine's): OpenClaw's `userTimezone` at seed (`buildConfigCommands` in `src/openclaw/configWriter.ts`), the container's `TZ` (`buildRuntimeSpec`), and set live on running agents by `retargetCronSweep` in `src/api/routes.ts`.
- `src/store/store.ts` — `agents`, `agent_classes`, `agent_env`, `data_sources`, `agent_seed`: agent records, classes, per-agent secrets, data sources, and template files to seed at first provision.
- `web/index.html` — `createAgent`, `rebuild`, `rebuildAll`, `openFleetActions`, `faApply`, `openSetupLog`, `openAdoptDlg`, `archiveAgent`, `confirmArchive`, `archivingHere`, `restoreAgent`: the create dialog, rebuild buttons, bulk actions, archiving (its tile shows "Archiving…" from the click) and the Setup log.

## Data sources: git repos and folders

An agent's data sources are listed under "## Data sources" in its AGENTS.md, by
exact path. A **git repo** is never a mount of your disk: it is cloned onto the
agent's own volume at `/home/node/.openclaw/<name>` (`<name>` is the repo's
name by default). A public repo is cloned over https with no credentials and
pushing is disabled; a private or writable one uses a deploy key Hatchabot
generates, which you add to the repo. The clone is made at provision and
rebuild, and only when it is missing: after that, the agent updates it with
`git pull`. A **folder** is a live, read-only (or writable) view of a path on
the host.

- `src/orchestrator/gitSource.ts` — `normalizeGitUrl`, `buildGitSyncScript`, `buildPublicGitSyncScript`: the accepted URL shapes, and the idempotent clone scripts for the private (deploy key) and public (https) cases.
- `src/orchestrator/provision.ts` — `syncGitDataSources`, `datasource.git_synced`: where each repo is cloned during provisioning, and the event it logs (`datasource.git_sync_failed` carries git's own error).
- `src/openclaw/workspace.ts` — `dataSourcesSection`, `DATA_SOURCES_HEADING`: the AGENTS.md section that tells the agent each path.
- `src/api/routes.ts` — `'/v1/agents/:id/data-sources'`, `'/v1/agents/:id/data-sources/:dsId'`: add, change and remove a source.
- `web/index.html` — `addGitSource`: the agent sheet's "add a repo" form.
- `docs/data-sources.md`: the design.

## The runtime provider and Docker (local and runners)

Every agent is a Docker container plus one named volume holding its OpenClaw
home (memory, config, sessions). The provider interface hides whether Docker is
local, rootless, or a runner (another machine reached over SSH or TCP). Agents
sit on an isolated Docker network. Memory caps and compressed swap are applied
per container.

- `src/providers/provider.ts` — `RuntimeProvider`, `RuntimeSpec`, `ProviderError`: the interface every provider implements.
- `src/providers/localDockerProvider.ts` — `LocalDockerProvider`, `provision`, `execShell`, `exportState`, `importState`, `rootless`, `sshTarget`, `tcpReachable`: Docker commands for local and remote daemons.
- `src/providers/resolveProvider.ts` — `resolveProvider`, `pingRunner`: picks the provider for a host; checks a runner's Docker.
- `src/providers/mockProvider.ts` — `MockProvider`: the in-memory provider used by tests.
- `src/orchestrator/runnerSetup.ts` — `ensureRunnerKey`, `runnerSetupSnippet`, `installRuntimeImage`: adding a runner machine.
- `scripts/runner-scenarios.mjs` — `scenario`, `recalls`: real moves between this machine and a runner on a live install (old and new images, memory recalled by meaning).
- `scripts/live.mjs` — `LIVE_TESTS`, `dueFor`, `touches`, `committedRuns`, `readRuns`, `resultOf`: the live tests' register, what is due for a release (`touches`: a change to a big shared file counts only near the test's own routes), and the record (the gate reads the committed one) (`docs/live-tests.md`, `docs/live-test-runs.md`); `scripts/promote.sh` — `live_gate`.
- `scripts/privacy-check.mjs` — `privateValues`, `scan`, `mask`, `ACCEPTED_HISTORY`: the privacy check (the household's private values read from the live install; the pre-push hook and tag guard, `--text` for release notes, `--public` for the `privacy` live test); `scripts/privacy-ignore.txt` (generic words). `scripts/make-debian-test-image.sh`: the local Debian 12 VM image for `clean-install-debian-12`.
- `src/orchestrator/moveHost.ts` — `moveAgentToHost`, `completeOnTarget`, `putBack`, `resumeMoveHost`, `recoverMoveHost`: moving an agent between this install's machines, and finishing or undoing one a restart cut off.
- `src/orchestrator/migrate.ts` — `migrateAgent`, `preflight`, `destinationHasAgent`, `resumeMigrate`, `recoverMigrate`: moving an agent to another Hatchabot; after a restart, asking that server whether it arrived.
- `src/orchestrator/transfer.ts` — `exportAgent`, `importAgent`, `rollbackImport`, `resumeImport`: the whole-agent archive behind download, moving to another Hatchabot, and restore from a download; an import a restart cut off is undone.
- `src/orchestrator/hibernate.ts` — `hibernateSweep`, `wakeSweep`, `wakeAgent`, `hibernateBlocker`: idle agents sleep and wake on demand (off unless HATCHABOT_HIBERNATE_AFTER is set).
- `src/orchestrator/memoryCap.ts` — `effectiveMemoryCap`, `parseMemoryCap`: per-agent memory limits.
- `src/orchestrator/swap.ts` — `effectiveSwapAllowance`, `limitsDrift`, `parseSwapProbe`: compressed swap and the limits check.
- `src/orchestrator/agentFiles.ts` — `listShell`, `tarArgv`, `uploadAllowed`: the Files pane (browse, download, upload).
- `src/api/routes.ts` — `'/v1/hosts'`, `'/v1/runner-setup'`, `'/v1/hosts/:id/install-image'`, `'/v1/agents/:id/move-host'`, `'/v1/agents/:id/rehost'`, `'/v1/agents/:id/fs'`, `'/v1/resources'`: hosts, moves, files and resources.
- `web/index.html` — `loadHosts`, `addHost`, `showRunnerSetup`, `moveHostAgent`, `rehostAgent`, `v2LoadFiles`, `openFleetResources`: the matching screens.

## Apps in agents

A codebase with a `hatchabot.json`, installed into an agent (docs/apps-in-agents.md).

- `src/orchestrator/apps.ts` — `parseManifest`, `parseSource`, `repoFor`, `resolveRelease`: the manifest and the source, read on the host (a folder, or a git address mirrored beside the database).
- `src/orchestrator/apps.ts` — `installRelease`, `mergeConfig`, `syncTasks`, `switchTo`, `removeTasks`: inside the agent (releases under `~/.openclaw/apps/<app>/`, its config, its tests before the switch, its scheduled commands).
- `src/api/routes.ts` — `'/v1/apps/inspect'`, `'/v1/agents/:id/app'`, `'/v1/agents/:id/app/update'`, `'/v1/agents/:id/app/rollback'`, `appTarget`: the routes (machine owner only).
- `src/store/store.ts` — `agent_apps`, `getAgentApp`, `setAgentApp`: which app, source, commit and previous commit.
- `src/api/routes.ts` — `'/v1/agents/:id/app/pending'`, `runPendingApp`, `installFromSource`: a new agent from a repo installs its app when provisioning finishes.
- `src/api/routes.ts` — `sharedAppConflicts`: one copy of an app per account (409 unless `allowShared`).
- `web/index.html` — `v2LoadApp`, `v2AppUpdate`, `v2AppRollback`, `openAppDlg`, `appRead`, `appConnPicked`, `appGo`: the agent page's App row and the "run an app from a repo" dialog.
- `src/cli.ts` — `app inspect`, `app install`, `app create`: the `hatchabot app …` commands (also update, rollback, status, remove).

## Telegram and other chat apps

Each agent may have a Telegram bot, from the shared bot pool or pasted by hand,
and optionally Discord or Slack. Strangers get silence: only members, or people
already known to the owner's agents, are let in; an invite link opens a short
window in which a new person's first message is paired. The bot's settings are
written into OpenClaw by the seed, so channel changes usually need a rebuild.

- `src/channels/telegramPool.ts` — `TelegramPoolProvisioner`, `PoolExhaustedError`, `retryPendingNames`: leasing bots from the pool and renaming them.
- `src/channels/telegramManual.ts` — `TelegramManualProvisioner`, `verifyBotToken`: a bot token pasted by hand.
- `src/channels/composite.ts` — `CompositeTelegramProvisioner`: pool first, then a manual bot.
- `src/channels/telegramName.ts` — `setTelegramDisplayName`: the bot's display name.
- `src/channels/connector.ts` — `ChannelConnector`, `ConnectorError`: the Discord/Slack connector interface.
- `src/channels/discord.ts` — `discordConnector`, `discordAddToServerUrl`: Discord bots.
- `src/channels/slack.ts` — `slackConnector`, `slackManifest`: Slack apps.
- `src/orchestrator/members.ts` — `admitMember`, `revokeMember`, `setDmPolicy`, `grantChannelAccess`: who may talk to an agent.
- `src/orchestrator/invite.ts` — `createInvite`, `redeemInvite`: invite links and codes.
- `src/orchestrator/claim.ts` — `claimFirstContact`, `approvePairing`, `listPairingRequests`, `isKnockWindow`: pairing a new person's first message.
- `src/orchestrator/channelTimeout.ts` — `channelHandlerTimeoutMs`, `channelTimeoutEnv`: how long a chat turn may run before the chat app gives up.
- `src/orchestrator/bots.ts` — `auditBots`: the bots census.
- `src/openclaw/configWriter.ts` — `channelPluginDir`, `CHANNEL_ACCOUNT`: channel settings written into OpenClaw.
- `src/api/routes.ts` — `'/v1/agents/:id/telegram'`, `'/v1/agents/:id/channels/:kind'`, `'/v1/pool'`, `'/v1/bot-inventory'`, `'/v1/agents/:id/invites'`, `'/v1/join'`, `'/v1/agents/:id/pairing/approve'`, `'/v1/agents/:id/members'`, `sweepPendingPairings`: channels, pool, invites and members.
- `src/store/store.ts` — `channels`, `discord_bots`, `memberships`, `member_identities`, `invites`, `pairing_windows`: where it is stored.
- `web/join.html` — `postJoin`, `joinWeb`, `initWebChat`: the page an invite link opens.
- `web/index.html` — `v2LoadChans`, `v2AddTelegram`, `chanConnect`, `openChanSetup`, `loadPool`, `addPoolBot`, `invite`, `renderEditMembers`, `approve`, `denyPair`: the Messaging pane, pool and members.

## Web chat and the OpenClaw console

The app embeds each agent's own OpenClaw console (Control UI) through a proxy
under the agent's /ui path; HTTP and WebSocket traffic is forwarded to the
agent's gateway with the signed-in person's identity. The owner gets full
rights; guests (members using web chat) get a restricted role and only their
own sessions. A simpler chat route runs one turn inside the container.

- `src/api/routes.ts` — `'/v1/agents/:id/ui'`, `'/v1/agents/:id/ui/*'`, `'/v1/agents/:id/console/access'`, `'/v1/agents/:id/console/approve'`, `gatewayAddr`, `consoleHeaders`, `revalidateConsoleSockets`: the console proxy and its WebSocket upgrade handler.
- `src/api/consoleProxy.ts` — `withConsoleIdentity`, `guestRequestVerdict`, `spliceGuest`, `scrubForGuest`, `GUEST_METHODS`: what a guest may do through the proxy.
- `src/api/controlUiRebase.ts` — `rebaseControlUi`: rewrites the console page to live under the proxy path.
- `src/api/consoleSockets.ts` — `ConsoleSockets`: open console WebSockets, closed when rights change.
- `src/openclaw/consoleIdentity.ts` — `consoleGatewayRoles`, `consoleGatewayAuth`, `GUEST_SCOPES`: the trusted-proxy roles written into the gateway.
- `src/orchestrator/consoleAccess.ts` — `ConsoleAccess`, `consoleSyncBatch`, `gatewayCallAs`: keeps the gateway's allowed users in step with members.
- `src/api/webChat.ts` — `registerWebChatRoutes`, `webChatNeedsRebuild`, `'/v1/agents/:id/chat'`: the simple web chat routes.
- `src/orchestrator/webChat.ts` — `runWebChatTurn`, `webChatHistory`, `webChatSessionKey`: a web chat turn inside the container.
- `web/index.html` — `openGateway`, `openWebChat`, `openGuestConsole`, `openWebChatPanel`, `webChatSend`, `approveConsoleBrowser`: opening the console and chat.

## The Hatchabot agent (manager) and its tools

The manager is an ordinary OpenClaw agent with special wiring: it runs in a
network jail, reaches Hatchabot only through the "ops door" (an MCP server on
a separate port, behind a small doorman container), and holds a propose-only
key. Reads run at once; every change becomes a card the owner confirms in the
app, executed with the owner's rights by the broker. It can also read the
installed source and docs to diagnose problems.

- `src/ops/opsAgent.ts` — `OPS_AGENTS_MD`, `OPS_SOUL`, `OPS_MANAGED_HEADINGS`, `opsSection`: the manager's instructions.
- `src/ops/opsServer.ts` — `ensureOpsServer`, `createOpsServer`, `setOpsHandlers`, `opsPort`: the ops door (MCP over HTTP, plus an allowlisting HTTPS proxy).
- `src/ops/doorman.ts` — `doormanScript`, `doormanRoutes`, `DOORMAN_DOOR_PORT`: the forwarder container that connects the jail to the door.
- `src/ops/opsTools.ts` — `opsDoorTools`, `opsToolsFingerprint`: the tool list the door serves; a changed fingerprint restarts the manager.
- `src/mgmt/broker.ts` — `Broker`, `riskOf`, `summarize`: resolves agent names, runs reads, turns changes into confirmation cards.
- `src/mgmt/tools.ts` — `MANIFEST`, `toolDef`, `'list_agents'`, `'rebuild_agent'`, `'set_model'`: the core tool definitions.
- `src/mgmt/restTools.ts` — `REST_TOOLS`, `'get_diagnostics'`, `'compact_agent'`, `'set_budget'`, `'run_backup'`: tools that are one /v1 call each.
- `src/mgmt/coverage.ts` — `COVERAGE`: which app actions the manager can and cannot do, and why.
- `src/mgmt/pendingStore.ts` — `PendingStore`: server-stored, single-use confirmation cards.
- `src/mgmt/apiClient.ts` — `HttpApiClient`: how the broker calls the /v1 API.
- `src/api/mgmtChat.ts` — `registerMgmtChat`, `'/v1/proposals'`, `'/v1/proposals/:id/:verb'`: wiring of the door to the broker; confirming and dropping cards.
- `src/ops/opsDrift.ts` — `checkOpsDrift`, `lockdownProblem`: suspends the manager's key if its tool lockdown was loosened.
- `src/ops/opsWeb.ts` — `makeOpsWeb`, `OPS_WEB_TOOLS`: web search done by Hatchabot for the jailed manager.
- `src/ops/push.ts` — `createOpsPush`: Telegram messages to the owner when a card waits.
- `src/ops/notify.ts` — `createOpsNotifier`: posts outcomes back into the manager's conversation.
- `src/mgmt/mcpServer.mjs` — `HATCHABOT_TURN_TOKEN`: the same tools as an MCP server for the Claude CLI.
- `src/openclaw/configWriter.ts` — `OPS_TOOLS_ALLOW`, `OPS_TOOLS_DENY`: the manager's OpenClaw tool lockdown.
- `src/api/routes.ts` — `'/v1/ops-agent'`, `'/v1/ops-agent/suggest'`, `opsPeerOk`, `runOpsTurn`: creating the manager and asking it things.
- `src/store/store.ts` — `mgmt_proposals`, `ops_tokens`: cards and door keys.
- `web/index.html` — `v2SetupOps`, `mgmtProposalCard`, `loadProposals`, `askOpsSuggest`: setting it up and the confirm cards.

## An agent's own browser

Off by default; one Chromium container per agent that has it on, in the
agent's network namespace (docs/browser.md).

- `src/orchestrator/browser.ts` — `browserSweep`, `browserImage`, `BROWSER_CDP_URL`: keeping the browsers in step with the agents.
- `src/providers/localDockerProvider.ts` — `ensureBrowser`, `stopBrowser`, `listBrowsers`: the containers.
- `src/openclaw/configWriter.ts` — `browser.enabled`: OpenClaw's attach-only profile, or the tool off.
- `src/api/routes.ts` — `'/v1/agents/:id/browser'`, `browsersNow`: the switch (PATCH `browser`), its state, the sweep.
- `web/index.html` — `v2SetBrowser`, `v2LoadBrowser`: the Advanced tab's Browser row.
- `docker/Dockerfile.browser`: its image.

## Memory and the memory search service

An agent's memory is its workspace files (SOUL.md, AGENTS.md, MEMORY.md and
memory notes) on its volume, plus OpenClaw's session transcripts. Every edit
from the app takes a snapshot first. Memory search uses embeddings, normally
from one shared embedder container on each machine (this one, and each runner
its own since 2.147); switching embedder, or moving machine, means a re-index.

- `src/orchestrator/snapshots.ts` — `CORE_FILES`, `captureSnapshot`, `autoSnapshot`, `restoreSnapshot`, `writeCoreFile`: snapshots and safe edits of the core files.
- `src/orchestrator/provision.ts` — `checkpointMemory`, `reindexMemoryIfSwitched`, `memoryIndexIncomplete`: saving memory before risky steps; re-indexing.
- `src/orchestrator/transcript.ts` — `recoverContext`, `contextStats`, `exportTranscript`: recovering context after a reset; chat history download.
- `src/orchestrator/inspect.ts` — `readInspectableFile`, `readTranscript`: reading an archived agent's files.
- `src/embedder/embedder.ts` — `EmbedderService`, `bootStartEmbedder`, `embedDefault`, `EMBED_MODEL_ALIAS`, `syncKeysNow`: the shared embedding container (a runner's keeps its state under `embed-hosts/<host id>` and copies its keys there; `remove` when the runner is removed).
- `src/orchestrator/moveHost.ts` — `moveAgentToHost`: a move that rolls back puts the agent's memory search key back (`embedTokenRow`, `restoreEmbedToken` in `src/store/store.ts`).
- `src/providers/localDockerProvider.ts` — `ensureEmbedder`, `pushEmbedKeys`, `removeEmbedder`: the containers; on a runner, the model and keys go into volumes there (removed with the runner).
- `src/embedder/door.ts` — `doorScript`: the keyed door agents use to reach the embedder.
- `src/openclaw/configWriter.ts` — `EMBED_PLUGIN_DIR`, `memoryKeyPrefix`: memory-search settings written into each agent.
- `src/api/routes.ts` — `'/v1/agents/:id/files/:name'`, `'/v1/agents/:id/snapshots'`, `'/v1/agents/:id/checkpoint'`, `'/v1/agents/:id/recover-context'`, `'/v1/embedder'`, `embedderFor`, `'/v1/embed-default'`, `'/v1/embed/move-all'`: memory files and the embedder (`?host=` for a runner's).
- `src/store/store.ts` — `snapshots`, `embed_tokens`, `agent_context_reset`: where it is stored.
- `web/index.html` — `openEdit`, `loadEditFile`, `saveEditFile`, `loadSnapshots`, `revertSnapshot`, `loadEmbedder`, `loadHostEmbedder`, `embedderAction`, `recoverContext`: the Personality and Knowledge panes and the embedder panel.

## Backups and restore

A nightly systemd timer runs a shell script that writes one dated directory
per run: a copy of the database, the secret key, and one archive per agent
volume. The app only reads metadata about those sets, can start a run, prune a
set, or restore one agent's volume from a set.

- `scripts/backup-volumes.sh` — `write_status`, `json_list`, `release_lock`: the backup run itself (one run per set; retention keeps each agent's newest copy).
- `deploy/hatchabot-backup.timer` — `OnCalendar`: when it runs.
- `deploy/hatchabot-backup.service` — `Type=oneshot`, `ExecStart`: what the timer starts (the backup script).
- `src/orchestrator/backups.ts` — `listBackups`, `startBackup`, `pruneBackup`, `restoreAgentFromBackup`, `agentsMissingFromSet`, `keepDays`, `restoreSafetyDir`: reading and acting on backup sets (`restoreSafetyDir` is where a restore that could not be undone keeps the pre-restore copy).
- `scripts/restore-drill.sh` — `set_state`, `cleanup`: proves a backup set (the newest complete one by default) restores, without touching the live system.
- `src/api/routes.ts` — `'/v1/backups'`, `'/v1/backups/run'`, `'/v1/backups/restore'`, `'/v1/agents/:id/backup'`, `'/v1/agents/restore'`: the backup panel, one-agent download and restore from a download.
- `web/index.html` — `loadBackups`, `runBackupNow`, `pruneBackup`, `restoreFromBackup`, `downloadAgent`: the Backups panel.

## Health, reconcile and the event log

The database says what each agent should be; reconcile compares that with
Docker at boot and on a timer and mends the recorded state (it never starts or
removes containers). A health check asks the agent's own gateway whether it is
really working. Every notable step is recorded as an agent event, shown in the
Setup log and Activity.

- `src/orchestrator/reconcile.ts` — `reconcileAgents`, `startReconcileLoop`, `reconcileEventLog`: registry versus Docker; its findings about an agent go to that agent's timeline too. It leaves alone an agent whose operation is not over (`activeOperationFor`).

### Durable operations (moves and imports that survive a restart)

A long change records itself in the `operations` table as it goes: what was
asked, the last step done, the outcome, and what the owner may do next. An
agent whose operation is running, was interrupted by a restart, or is held for
a choice is busy on disk: Start, Rebuild, Archive, Move, Delete, Wake and Retry
refuse with its line. At boot, after the first reconcile, each interrupted one
is finished, undone or held by its kind's rule (docs/operations-and-one-interface-design.md, docs/moving-agents.md).

- `src/orchestrator/operations.ts` — `beginOperation`, `STEPS`, `operationRefusal`, `activeOperation`, `markInterrupted`, `publicOperation`, `currentBootId`: the record, each kind's steps, and the on-disk busy check.
- `src/orchestrator/operationsResume.ts` — `resumeOperations`, `recoverOperation`, `retryHeldOperations`, `startOperationRetryLoop`: settling interrupted operations at boot, the owner's choices, and the 10-minute question to another Hatchabot.
- `src/store/store.ts` — `operations`, `insertOperation`, `updateOperation`, `activeOperationFor`, `pruneOperations`: the table (kept 90 days, at least 50 per agent).
- `src/api/routes.ts` — `'/v1/operations'`, `'/v1/operations/:id'`, `'/v1/operations/:id/recover'`, `busyNow`, `startRefusal`: the API and the guards.
- `src/mgmt/restTools.ts` — `list_operations`, `recover_operation`: the Hatchabot agent's tools for them.
- `web/index.html` — `opNotice`, `recoverOp`, `agentAttention`: a held operation in the sheet's Overview and under Alerts.
- `src/orchestrator/health.ts` — `agentHealth`, `aiSourceHealth`, `doctorLint`: the live health check and OpenClaw config lint.
- `src/orchestrator/posture.ts` — `computePosture`, `runPostureSweep`, `measureAgentDisks`: the daily security and disk posture.
- `src/orchestrator/eventLabels.ts` — `eventLabel`: plain words for event names.
- `src/orchestrator/tokenWatch.ts` — `runTokenWatch`: loop incidents (see costs below).
- `src/api/routes.ts` — `'/healthz'`, `'/v1/agents/:id/health'`, `'/v1/agents/:id/logs'`, `'/v1/agents/:id/events'`, `'/v1/events'`, `'/v1/security/posture'`, `diskSweep`, `limitsCheck`: health, logs, events and posture.
- `src/store/store.ts` — `agent_events`, `recordEvent`, `listEvents`, `posture_snapshots`: where it is stored.
- `web/index.html` — `openHealth`, `runFleetHealthChecks`, `openLogs`, `openSetupLog`, `openAudit`, `v2InlineHealth`: health and logs on screen.
- `web/index.html` — `v2CheckAll`, `v2HealthProblems`, `v2PaintCheckAll`: Check all on the home screen (every running agent, results as Alerts and a line above the agents).

## Costs, usage, budgets and the token steward

A background pass every ten minutes reads each agent's model calls (from its
transcripts and gateway log), stores per-hour figures, and then runs, in order:
spike alerts, the model-change guard, the token steward (loop incidents) and
budgets. Every dollar figure is tokens priced at list API prices. Right-size
(the model steward) keeps a ledger of model changes and judges each one later.

- `src/api/routes.ts` — `runUsageSample`, `runTokenSteward`, `runBudgetPass`, `runModelGuard`: the background pass.
- `src/orchestrator/usage.ts` — `agentUsage`, `USAGE_READER_SCRIPT`: tokens per model summed from transcripts.
- `src/orchestrator/sourceUsage.ts` — `sampleSourceUsage`, `summarizeSourceUsage`, `parseModelCalls`: per-source requests, tokens and rate limits.
- `src/orchestrator/fleetUsage.ts` — `computeUsagePeriod`, `snapshotDailyUsage`: the Usage view by period.
- `src/orchestrator/agentCosts.ts` — `costsFor`, `agentCost`, `spendSeries`, `priceParts`: cost badges and the spend chart.
- `src/orchestrator/pricing.ts` — `MODEL_PRICES`, `estimateCost`, `priceList`: the price list.
- `src/orchestrator/budgets.ts` — `runBudgets`, `budgetView`, `stepView`, `pausedReplySweep`: monthly budgets, step alerts and the pause.
- `src/orchestrator/usageAlerts.ts` — `runUsageAlerts`, `findUsageSpikes`: "much more than usual" warnings.
- `src/orchestrator/tokenHealth.ts` — `buildTokenHealth`, `loopSignals`, `THRESHOLDS`: the token steward's evidence.
- `src/orchestrator/tokenWatch.ts` — `runTokenWatch`, `incidentMessage`: open and clear loop incidents.
- `src/orchestrator/loopLines.ts` — `parseLoopLines`: loop lines in the gateway log.
- `src/orchestrator/compaction.ts` — `compactAgent`, `syncContextCap`: compaction and the conversation cap.
- `src/orchestrator/modelLedger.ts` — `recordChange`, `evaluateModelChanges`, `rightSizeSavings`, `fileGuardProposals`: the model-change ledger and quality guard.
- `src/orchestrator/modelScorecard.ts` — `buildScorecard`: the weekly review's evidence.
- `src/orchestrator/modelReview.ts` — `syncModelReviewCron`: the manager's weekly review task.
- `src/api/routes.ts` — `'/v1/costs'`, `'/v1/usage'`, `'/v1/usage/spend'`, `'/v1/agents/:id/usage'`, `'/v1/ai-profiles/usage'`, `'/v1/budgets'`, `'/v1/agents/:id/budget'`, `'/v1/token-health'`, `'/v1/token-incidents'`, `'/v1/agents/:id/compact'`, `'/v1/model-changes'`, `'/v1/model-prices'`: the routes behind the views.
- `src/store/store.ts` — `agent_model_profiles`, `token_samples`, `model_call_hours`, `agent_cost_days`, `budgets`, `budget_pauses`, `spend_alerts`, `token_incidents`, `agent_token_health`, `model_changes`, `usage_alerts`: where it is stored.
- `web/index.html` — `openUsage`, `openFleetUsage`, `renderFleetUsage`, `loadSpendCharts`, `openBudgets`, `v2LoadCosts`, `openModelPrices`, `savedByModels`: the Usage, Cost and Budgets screens.

## Images

Agents run from a runtime image built locally from the repository's
Dockerfile, tagged with its OpenClaw version and promoted to latest. An owner
can try a candidate base image on chosen agents before promoting it, and can
build derived images (the base plus extra packages) for particular agents.

- `docker/Dockerfile.runtime` — `OPENCLAW_VERSION`: the runtime image.
- `docker/entrypoint.sh` — `PYTHONPATH`: container start-up.
- `scripts/build-runtime-image.sh` — `NO_LATEST`: builds and tags the image.
- `src/orchestrator/derivedImage.ts` — `buildDerivedImage`, `renderDockerfile`, `removeDerivedImage`: derived images.
- `src/orchestrator/imageRecipe.ts` — `ensureImageOn`, `buildRecipeOn`: rebuilding an image on another machine from its recipe.
- `src/orchestrator/runtimeCaps.ts` — `probeImageCapabilities`: what an image can do.
- `src/providers/provider.ts` — `parseEmbedEngineLabel`, `parseChannelsLabel`: image labels read at build time.
- `src/api/routes.ts` — `'/v1/runtime'`, `'/v1/runtime/images'`, `'/v1/runtime/build'`, `'/v1/runtime/images/promote'`, `'/v1/images'`, `'/v1/images/:name/rebuild'`, `'/v1/rebuild-policy'`, `buildBaseImage`: images and the automatic rebuild policy.
- `src/store/store.ts` — `derived_images`: where it is stored.
- `web/index.html` — `loadRuntimeImages`, `startBaseBuild`, `runTryOnAgents`, `promoteImage`, `loadDerivedImages`: the Images panel.

## Reaching Hatchabot from elsewhere: Tailscale and public access

Off the machine, Hatchabot is reached over Tailscale (Serve gives the app an
HTTPS address on the tailnet). Public access (a Tailscale Funnel to the open
internet) is optional and refuses to serve until its safeguards pass: a sign-in
per person, a second factor for everyone with owner rights, invited people only,
a separate port, sign-in limits and automatic upgrades on the stable channel.

- `src/ops/tailnet.ts` — `tailnetInfo`, `enableServe`, `funnelOn`, `funnelOff`, `funnelStatus`: Tailscale commands.
- `src/api/publicAccess.ts` — `registerPublicAccess`, `publicCsp`: the public listener and its gate.
- `src/api/safeguards.ts` — `evaluateSafeguards`, `failingSafeguards`: the conditions for serving publicly.
- `src/api/publicRoutes.ts` — `PUBLIC_RULES`, `publicRuleFor`: which routes the public side may use.
- `src/api/trust.ts` — `isPublic`, `publicClientAddress`: telling public requests from local ones.
- `src/api/reachRoutes.ts` — `registerReachRoutes`, `'/v1/public-access'`, `'/v1/public-access/on'`, `'/v1/security/devices'`: turning it on and off, devices and the security log.
- `src/ops/publicIntent.ts` — `writePublicIntent`, `readPublicIntent`: remembers the intent across restarts.
- `src/api/routes.ts` — `'/v1/tailscale'`, `'/v1/tailscale/serve'`, `'/v1/tailscale/use-for-links'`, `appUrlFor`: Tailscale status and link addresses.
- `src/store/store.ts` — `known_devices`, `security_log`, `public_pass_revocations`, `second_factor_generations`: where it is stored.
- `web/index.html` — `tailnetStepBody`, `turnOnServe`, `loadReach`, `reachTurnOn`, `reachTurnOff`: the screens.

## Report a problem

The person describes the problem; Hatchabot gathers facts (version, install
kind, platform, doctor output, recent failures, the agent's state and log
tail), masks private details, and builds a GitHub issue link. Nothing is sent by
Hatchabot. The manager can read the installed source to diagnose first and save
a draft. See `docs/field-reports.md`.

- `src/orchestrator/problemReport.ts` — `buildReport`, `redactForPublic`, `issueUrl`, `searchSource`, `readSource`, `sourcePath`: facts, masking, the link, and the source the manager may read.
- `src/api/routes.ts` — `'/v1/problem-reports'`, `'/v1/problem-reports/:id'`, `'/v1/diagnostics'`, `'/v1/source'`, `'/v1/source/search'`, `reportFacts`: drafts, diagnostics and source routes.
- `src/mgmt/restTools.ts` — `'get_diagnostics'`, `'search_source'`, `'read_source'`, `'prepare_problem_report'`: the manager's tools for it.
- `src/ops/opsAgent.ts` — `Settings questions, and reporting a bug in Hatchabot`: the manager's instructions for it.
- `src/domain/redact.ts` — `redactSecrets`: key masking shared with logs.
- `src/store/store.ts` — `problem_reports`, `ProblemReportRow`: where drafts are stored.
- `web/index.html` — `openReport`, `reportCreate`, `reportOpenIssue`, `reportFromHash`: the review panel.

## The web app's main screens

One page, `web/index.html`, served at the root with the version injected. The
default look is the icon home screen (a "v2" prefix in function names); the
classic look is behind the classic query option. Clicking an icon opens the
agent sheet, whose tabs are rendered by v2Pane. All data comes from the /v1
API through one fetch helper.

- `web/index.html` — `initV2`, `renderV2`, `refresh`, `api`: start-up, the home grid, the periodic reload and the fetch helper.
- `web/index.html` — `openV2Agent`, `v2Open`, `v2Pane`, `v2RenderSheet`: the agent sheet; v2Pane's tabs are overview, personality, ai, messaging, knowledge, sharing, usage, schedule, files and advanced.
- `web/index.html` — `v2SetView`, `v2SetSort`, `v2LoadRecent`, `agentAttention`, `v2LoadMachine`: View by, sorting, Activity, Alerts and the machine line.
- `web/index.html` — `v2PlannedHTML`, `loadTodos`, `createFromTodo`, `retireMadeTodos`: the Planned group (ghost tiles; the plans are the agent-todos routes).
- `web/index.html` — `v2PlaceInGroup`, `v2MoveInGroup`, `v2DropTarget`, `sortGroup`: My order — drag within a group, Move earlier / later, a group's kept A→Z (the agent move and group sort routes).
- `web/index.html` — `v2TabKeys`, `v2AcctItems`: arrow keys for the View by and sheet tabs and the account menu.
- `web/index.html` — `setupSteps`, `renderSetup`, `openSetupGuide`: the first-run guide.
- `web/index.html` — `openCrons`, `renderCrons`, `openInspect`, `openGallery`, `openInbox`: scheduled tasks, archived-agent inspector, templates, shared agents.
- `web/index.html` — `renderAgents`, `agentCard`: the classic look.
- `src/api/routes.ts` — `'/'`, `'/v1/config'`, `'/v1/agents'`, `'/v1/agents/:id'`, `'/v1/recent'`, `'/v1/agents/:id/crons'`, `indexPage`: the page itself and the main reads behind it.
- `src/orchestrator/recent.ts` — `RecentTracker`, `orderRecent`, `previewLine`: the Activity view and tile previews.
- `src/orchestrator/crons.ts` — `listCrons`, `addCron`, `setCronEnabled`, `runCronNow`: scheduled tasks inside the agent.
- `web/sw.js` — `fetch`: the service worker for the installable app.
- `scripts/check-web.mjs` — `checkHandlers`: static checks on the page (run by the tests).
- `scripts/ui-clickthrough.mjs` — `--headless`: the click-through UI test (headless Chrome against the real page).
