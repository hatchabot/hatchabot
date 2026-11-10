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
- `src/domain/processAlive.ts` — `processAlive`: whether a pid runs on this machine; used by `sweepOneShots`, the backup lock (`lockHeld`) and the embedder's `clearStaleParts`.
- `src/secrets/localSecretStore.ts` — `LocalSecretStore`: encrypted secrets (bot tokens, keys) in the database, keyed by HATCHABOT_SECRET_KEY.
- `deploy/hatchabot.service` — `ExecStart`: the systemd user unit that runs the service.

## Install and upgrade

The one-line installer downloads a prebuilt bundle (its own Node and
dependencies) where one exists for the platform, and otherwise clones the
repository and installs natively. Release channels (stable, beta) are named in
`channels.json`. Upgrades check out another release and restart the service;
the doctor command prints what is wrong with an install.

- `install.sh` — `install_bundle`, `install_native`, `bundle_room`, `remember_named`, `newest_release`, `in_docker_group`: the one-line installer (`mf_fetch`, `mf_paths`, `mf_matches`: the bundle checked against the release's release-manifest.json, the .sha256 only for releases made before manifests).
- `scripts/release-manifest.sh` — `get`, `asset`, `image`, `load`, `data_dir`, `mf_required`: what a release vouches for — its release-manifest.json, checked and kept in the data directory (release-manifests/), and refused when missing from a release that must have one (v2.159.0 on); the same reader as `install.sh`.
- `channels.json` — `stable`, `beta`: which release each channel points at.
- `scripts/build-bundle.sh` — `PLATFORM`, `linux-arm64`, `darwin-arm64`: builds the per-platform release bundle.
- `.github/workflows/release.yml` — `check`, `attest`, `publish`, `--tagged`: the only way a release is made, on the public repo when the publisher pushes its tag (the tag's commit checked, bundles and image built read-only, manifest, attestation, a checked draft, then publish); `scripts/release.sh` — `refs/tags/$TAG`, `HATCHABOT_PUBLIC_REMOTE`: tags the version commit in the dev repo (`hbt release`); publish.toml (how the publish kit publishes it) and scripts/private-values (its private values; never published); `scripts/release-check.sh` — `newest`, `--wait-ci`, `--tagged`, `--public`: may this commit be released as this version; `scripts/release-manifest.mjs` — `buildManifest`, `validateManifest`, `collectAssets`, `checkAssets`, `openclawFromDockerfile`: `release-manifest.json`; `scripts/oci-index.mjs` — `describeLayout`, `mergeDescriptions`: the runtime image's index digest before anything is pushed.
- `scripts/kit_checks.py` — `load_config`, `OSV_VERSION`, `OPENGREP_VERSION`, `RULES_COMMIT`: the publish kit's dependency and code checks (an unchanged copy of the kit's `checks/kit_checks.py`), run on each pull request by `.github/workflows/kit-checks.yml` (dev repo only); `kit-checks.toml` — `lock_files`, `vuln_exceptions`, `code_exceptions`: what it reads and the exceptions (docs/releasing.md, "The kit checks").
- `.github/workflows/bundles.yml` — `workflow_call`: builds the bundles (artifacts only); `.github/workflows/runtime-image-build.yml` — `workflow_call`, `HATCHABOT_RELEASE`: builds the runtime image (artifacts only); `.github/workflows/runtime-image.yml` — `openclaw_version`: a candidate image; `.github/workflows/promote-images.yml` — `image-aliases`, `allow_backwards`, `plan`: moves `:latest`/`:beta`/`:stable` by a release manifest's digest, on the public repo: `plan` reads which channels a fast-lane push of `channels.json` moved (`scripts/promote.sh` — `fast_lane`: asks the publisher for it).
- `scripts/sqlite-driver.sh` — `better-sqlite3`, `--compile`: makes sure the database driver loads on this machine.
- `scripts/setup-host.sh` — `say`, `launchd`: clone-based setup of a fresh host (dependencies, .env, the service; launchd on macOS).
- `scripts/launchd-plist.sh` — `xml`, `service`, `backup`: the macOS launchd jobs setup-host.sh installs (paths XML-escaped, the install dir an argument); `install.sh`, `scripts/uninstall.sh` — `plist_dir`: read the install dir back out of one.
- `scripts/install-service.sh` — `sed_escape`, `systemctl`: installs the systemd user service on Linux.
- `scripts/systemd-quote.sh` — `systemd_quoted`, `systemd_arg`, `systemd_path`: how a value goes into a systemd unit; sourced by every unit writer: `scripts/install-service.sh`, `scripts/follow-channel.sh`, `scripts/follow-latest.sh` and `scripts/privacy-sync.sh`.
- `scripts/ensure-deps.sh` — `npm ci`, `ABI_STAMP`: installs dependencies only when the lockfile moved; checks the database driver again when Node changes.
- `scripts/upgrade.sh` — `rollback`, `back_to_cur`, `restore_deps`, `restore_prev`, `not_ours`, `remember_channel`, `put_line`, `put_dir`, `link_end`, `put_failed`, `lock_short`, `REDO`, `pin_named`, `unpin`, `PIN_RECORD`, `disk_full`, `no_stage`, `machine_short`, `disk_words`, `said_kind`, `said_path`, `disk_short`, `step_tee`, `step_tail`, `new_step_log`, `own_place`, `step_short`, `change_failed`, `put_rec`, `vernewer`, `lock_left_over`, `take_lock`, `lock_in_way`, `run_step`, `swap_failed`, `rollback_bundle`, `find_target`, `RECHECK`: the upgrade command (a channel or a tag), with rollback on failure; the release is looked for (`find_target`) before the lock is taken, and the channel it was looked for by (or the timer's, or one named) read again under it (`RECHECK`); a bundle install's next bundle is checked by release-manifest.sh asset, and a bundle swap cut off part-way (its `.swapping` record) is put back at the next start, the previous `scripts/` through `.rollback-scripts` beside it. A git install's upgrade cut off part-way (its `FROM_FILE` beside the lock) is put back the same way (`repair_tree`, and `clear_own_index_lock` for a `.git/index.lock` its `checkout_recorded` shows is its own); a signal ends it through `finish`, which puts the old release back at once. The upgrade lock names its holder; `scripts/deploy-release.sh` takes the same lock. Exit 5 (the machine's disk or permissions, never counted against the release) only through `machine_short`; `finish` reads any other 5 as 3.
- `scripts/follow-channel.sh` — `--install`, `--uninstall`, `MAX_TRIES`, `REMEMBERED`, `PINNED`, `repair_due`, `set_aside`: optional timer that keeps an install on the channel chosen last (its `data/channel`; retries a failing install less often, then sets it aside, `set_aside` the same text in `scripts/follow-latest.sh`; a pin is left alone unless an upgrade was killed part-way).
- `scripts/follow-tries.sh` — `tries_open`, `tries_waiting`, `tries_put`, `note_try`, `forget_tries`, `HELD`, `MAX_TRIES`: the try record both timers keep (three fields, as older timers read it; the disk's count beside it in `<record>.disk`; `tries_waiting` doubles the wait by the release's own tries, and by the disk's to an hour at most when it has none) (sourced by `scripts/follow-channel.sh` and `scripts/follow-latest.sh` when readable, with stand-ins that count nothing when not, so a tick still reaches the repair; a test holds them to it): the wait that doubles after each failure, the set-aside count that a full disk never adds to, and the runtime folder that holds a try the full disk could not record.
- `scripts/deploy-release.sh` — `checkout_recorded`, `clear_own_index_lock`, `repair_tree`, `rollback`, `change_failed`, `put_rec`, `machine_short`: a tagged release into the production checkout, and the repair of one killed part-way; exit 5 for the machine's disk as `scripts/upgrade.sh` (its `machine_short`, `free_mb`, `take_lock`, `lock_short`, `lock_in_way`, `disk_words`, `said_kind`, `said_path`, `own_place`, `disk_short`, `step_tee`, `step_tail`, `run_step`, `step_short`, `put_rec`, `change_failed`, `link_end`, `put_line`, `put_dir` and `put_failed` are copies, not a sourced file: it runs from a temporary copy while the checkout changes scripts/; a test holds them equal, so the deploy names its tree `DIR`, its tag `TARGET` and what a person runs `REDO`); 5 only to a caller that sets `HATCHABOT_FOLLOW_KNOWS_5=1` (`finish`), else 3. `scripts/follow-latest.sh` — `verify_release`, `repair_cut`, `CUT_FROM`, `FOLLOW_LATEST_HOME`, `TRIES_HELPER`, `note_try`, `disk_stop`, `disk_waiting`, `disk_words`: the timer that deploys the newest tag (passing `HATCHABOT_FOLLOW_KNOWS_5=1` to the deploy and to `repair_cut`'s), and repairs a killed deploy by the deploy script of the release it came from when the newest tag cannot be run or is behind; a repair waits only on the disk's tries (`disk_waiting`), and git's words are read with a copy of `scripts/upgrade.sh`'s `disk_words` (a test holds it equal).
- `scripts/promote.sh` — `ci_gate`, `public_ci_note`: asks CI on the dev repo (a gate) and reads the public repo's (said, not a gate).
- `scripts/uninstall.sh` — `--purge`, `--installed`, `volumes`, `other_installs`, `runner_agents`, `drill_is_mine`: removes the install it lives in (or, with `--installed`, the one the service runs), keeping data unless asked; a purge refuses while agents run on a runner (`--forget-runners`).
- `scripts/upgrade-check.sh` — `CREATE TABLE IF NOT EXISTS`: checks that databases from older releases still open.
- `bin/hatchabot.mjs` — `tsx`, `process.argv`: the hatchabot command; runs the CLI under tsx.
- `src/cli.ts` — `parseArgs`, `matchAgent`, `'upgrade'`, `'doctor'`, `'reach'`: every CLI command, dispatched by name. `pickProfile` (the ⭐ default unless `--profile`, which takes an id or a name only one source has; create, app create, adopt, switch-source `--to`), `saveTarget` (`backup`/`get`: the destination made ready before the server is asked, replaced only once the download is complete; `renameRefused`: a file it could not replace), `agentsFilter` (`--agents`: given and empty is refused), `pairingTargets` (the agents a bare `hatchabot pairing` asks), `doLogin` and `writeConfigValues` (`login` saves the server chosen with one credential, in one write), `archivedBotLine` (`archive` prints where the server says the bot went).
- `src/doctor.ts` — `gatherFacts`, `backupFacts`, `doctorReport`, `publicAccessLines`, `swapLine`: what `hatchabot doctor` checks and prints (the newest backup set is this install's own, by `ownerMark`). `serviceUrl` and `servicePort` (the listener the `.env` describes), `doctorTarget` (`--url`, or a saved URL only when it is another machine's; `addressesOf` resolves a saved name, bounded), `serviceDockerEnv` (the `.env`'s `DOCKER_*` over the shell's), `probeControlPlane` (one deadline for the whole answer).
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
- `src/util/safeEqual.ts` — `safeEqual`: every secret, signature and password compare (constant time, by bytes).
- `src/api/signinLink.ts` — `registerSigninLink`, `verifySigninToken`: one-time sign-in links.
- `src/api/secondFactor.ts` — `registerSecondFactorRoutes`, `'/v1/second-factor/challenge'`, `'/v1/second-factor/passkey'`: second factor enrolment and checks.
- `src/api/totp.ts` — `totpVerify`, `newBackupCode`: code-app and backup-code maths.
- `src/api/webauthn.ts` — `verifyRegistration`, `verifyAssertion`: passkeys.
- `src/api/principal.ts` — `principalOf`, `ownerIdOf`, `LOCAL_OWNER`: who a request is.
- `src/api/firstAccount.ts` — `firstAccountAdoption`: the first real account to sign in takes over what password mode owned (`src/store/store.ts` — `adoptLocalOwnerData`, `OWNER_COLUMNS`: every owner column and what happens to it); one that failed is tried again, with waits that double up to an hour, and only for the account that tried first (`pinFirstAccount`; `mayTakeOverInstall`; `localOwnerHasAnything` before, `localOwnerHasData` after; `accountExists` for the log's advice); what is unique per owner is settled first (`#settleOwnerClashes`), and rows about an agent that stays behind stay with it; once done, the old guard holds again, and a re-made local host goes to `installOwner`.
- `src/api/requestOrigin.ts` — `registerOriginCheck`: refuses cross-site writes.
- `src/api/routes.ts` — `'/v1/auth/family-accounts'`, `'/v1/local-accounts/recover'`, `'/v1/cli-tokens'`, `'/v1/accounts'`, `'/v1/account'`: switching to accounts, Telegram recovery, CLI tokens, the account menu.
- `src/store/store.ts` — `local_accounts`, `accounts`, `session_epochs`, `second_factors`, `signin_links`, `cli_tokens`: where it is stored.
- `web/index.html` — `showLogin`, `acctSignIn`, `pageSignedIn`, `pageSessionEnded`, `pagePersonIs`, `pageClearLast`, `pageReloadWhenQuiet`, `pageHold` and `pageSigningIn` (another account reloads the page, once no second-factor step is under way), `pageSecretsPutAway` and `pageSecretsBack` (one-time codes wait for their own person across a sign-in), `forgotPassword`, `askSecondFactor`, `loadAccounts`, `turnOnFamilyAccounts`, `showRecoveryCode`: the sign-in screen and account management.

## AI sources and Claude login

An AI source (an "AI profile" in code) is a Claude plan via a setup token, an
API key, or a local model server. Each agent uses one source and one model.
Credentials are stored encrypted and written into the agent at provision or
rebuild; a model change on the same source applies live, a source change needs
a rebuild. "Not logged in" after a source switch is usually a session pinned
to the old runtime (runtimePins).

- `src/api/routes.ts` — `'/v1/ai-profiles'`, `'/v1/ai-profiles/:id'`, `'/v1/ai-profiles/:id/migrate-agents'`, `'/v1/ai-profiles/:id/available-models'`, `'/v1/agents/:id/model'`, `'/v1/agents/:id/model-check'`, `applyModelToRuntime`, `finalModelCheck`, `modelChoiceProblem`, `subscriptionRuntimeProblem`, `applyClassToAgent`, `switchAgentToSource`: sources and model changes (by hand, from a class, in bulk or from the manager's card). `finalModelCheck` is the one check of what an agent will run once a change is stored: its source, model and image together. Model applies run one at a time per agent and class changes one at a time per class (`inQueue`, `inClassQueue`). Every change of an agent's class goes through `setAgentClassIf` (`src/store/store.ts`), in one transaction with the model, source and image it writes, so a change made by another path meanwhile stands (`changedSince`, from `sinceOf`), and each member's model change goes in the ledger on its own. `detachClassIfDrifted` takes the class off an agent that no longer runs what its class sets (`driftedFrom`) and, when that class set limits, puts the limits that apply on its container, after a rebuild under way (`limitsAfterDetach`); every class path puts limits on and tells the budget through `limitsTold`; while that class has a change applying, it decides in the class's queue once the change is done, off the request (`detached: 'pending'`). Class changes check each agent's machine before the class's queue (`checkClassFor`, with `classWriteRefusal`; an edit's settings read by `classEditPlan`; three tries that never fit: `classChangedThrice`), write records in it (`writeClassEdit`, `applyClassToAgent`) and change containers after it (`classStep`; a member's model by `classModelOn`, applyClassToAgent's `finish`). An answer's kept limits carry their parts beside the sentence (`keptSaid`: `limitsKept`), which the app and the manager word. `applyCurrentLimits` is the one change of a container's memory limits, in the agent's turn (`inLimitsTurn`), reading them as stored: every class path goes through `limitsTold` (which leaves an agent with its own cap and swap alone), and bulk switches start each agent's and wait for them together (`limitsSaid`); `setMemoryCap` and `setSwapAllowance` hand it the agent's own, which PATCH stores in its one transaction in that same turn unless the container's docker refuses it on a machine that answers (`refused`, a 502), and a PATCH that stops after a docker call moved the limits (a refusal at its write, a swap refused after the cap) puts them back as stored through it. `tellMemoryBudget` rewrites only the memory budget in AGENTS.md (`syncMemoryBudget`, `src/orchestrator/provision.ts`), off both queues, staged, checked and renamed in the turn a save of AGENTS.md takes (`withAgentsMdTurn`, `writeFileInAgent`). `modelGeneration` (`src/store/store.ts`) counts model writes, so the budget's switch down undoes only its own. `holdSource`, `withSourceHold`: a switch holds the source it goes to, and while it does (`sourceHeld`, ten minutes at most), deleting that source is refused with "try again in a moment" (HB-0570); PATCH stores its writes in one transaction, judged again there (the agent or the source gone, busy, moved to a runner); `switchAgentToSource` takes that hold itself, and a class edit or join holds the source it moves agents to from its first check until its write, which judges each agent again (`applyClassToAgent`); an import is not held, and the store refuses its agent instead; `src/store/store.ts` — `insertAgentOnSource`, `SourceGoneError`: a new agent is refused on a source that is gone.
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

- `src/api/routes.ts` — `'/v1/agents'`, `'/v1/agents/:id/rebuild'`, `'/v1/agents/:id/provision'`, `'/v1/agents/:id/start'`, `'/v1/agents/:id/stop'`, `kickProvision`, `kickRebuild`, `rebuildSweep`, `rebuildOrOwe`, `oweRebuild`, `operationRefuses`, `startStopped`, `pinNotRunYet`: create, retry, rebuild, start and stop. A change that needs a new container rebuilds a running agent; a stopped or sleeping one keeps it for its next start (`rebuildOnStart`, cleared by `recordApplied` with the spec of a container made in `src/orchestrator/provision.ts`; a wake goes through `rebuildOnWake` in `src/orchestrator/hibernate.ts`); under a long operation it is refused (`operationRefuses`).
- `src/orchestrator/provision.ts` — `createAgentRecord`, `provisionAgent`, `runProvisionSteps`, `rebuildAgent`, `finishRebuild`, `finishInterruptedRebuild`, `buildRuntimeSpec`, `waitForHealthy`: the provisioning pipeline (a rebuild's steps after health in one place, run again for a rebuild a restart cut off after its container came up).
- `src/providers/localDockerProvider.ts` — `provision`, `SEED_STEP_MARK`, `seedFailure`, `seedStepLabel`: the seed script and how its failure is reported.
- `src/openclaw/configWriter.ts` — `buildConfigCommands`, `batchConfigCommands`, `seedInvocation`, `skipIf`: the OpenClaw config steps; skipIf and markers skip steps already done.
- `src/openclaw/workspace.ts` — `buildWorkspaceSeed`, `memoryPolicySection`, `dataSourcesSection`, `scheduledResultsSection`: the SOUL.md, AGENTS.md and MEMORY.md written on first provision, and the managed sections refreshed on rebuild (`syncDataSourceDocs` in `src/orchestrator/provision.ts`; "Scheduled results" only for an agent in no chat app). `replaceSection`, `removeSection`, `extractSection` (`readSection` also says when it was left alone): one managed section, found by `managedSection` under both readings of the code fences (`fenceMask`, read once per text by `readFences`, which `syncDataSourceDocs` passes to each of them), left alone where they disagree (HB-0520); `removeSectionEverywhere` (a template export's `stripManagedSections` in `src/orchestrator/template.ts`) takes out every copy either reading calls real; `unsureSections` names the sections left alone and `fenceDisagreement` the line to fix, which `syncDataSourceDocs` traces as `agentsmd.section_unsure` once per version of the file.
- Where an agent learns to install tools: `src/openclaw/workspace.ts` — `installConventionsSection`, `withInstallSection` (AGENTS.md, since OpenClaw 2026.9 does not read TOOLS.md), `toolsMdWithoutInstallSection`; `src/orchestrator/provision.ts` — `syncDataSourceDocs`, `syncInstallDocs` (takes the old copy out of TOOLS.md).
- `src/orchestrator/busy.ts` — `whileBusy`, `AgentBusyError`, `busyDone`: one operation per agent at a time; `busyDone` settles once the agent is free.
- `src/orchestrator/buildFailure.ts` — `buildFailureReason`: turns a build error into a plain reason.
- `src/orchestrator/rebuildPolicy.ts` — `rebuildNeed`, `pickAutoRebuilds`, `inQuietHours`: when an agent needs a rebuild and automatic rebuilds.
- `src/orchestrator/template.ts` — `exportTemplate`, `importTemplate`: templates (a trained copy for someone else); also behind clone.
- `src/orchestrator/provision.ts` — `applyPendingSchedules`, `retryPendingSchedules`, `retryPendingSchedulesWhenUp`: a template's scheduled tasks, parked at import, added once the gateway runs (by setup, and again for any still parked by each rebuild, a start or wake once the gateway answers — `clearPinsWhenUp` in `src/api/routes.ts` — and the Schedule tab's Try again, `'/v1/agents/:id/crons/waiting'`); each one still parked keeps why. The Schedule tab lists them (`waitingTasks`; `cronWaitingRows`, `retryWaitingCrons` in `web/index.html`).
- `src/orchestrator/adopt.ts` — `inspectWorkspace`, `packWorkspace`, `applyWorkspace`: adopting an existing OpenClaw workspace (the copy is exactly the files the preview lists; links are named and left out).
- `src/orchestrator/openclawImport.ts` — `discoverOpenclawAgents`, `quiesceOpenclawBots`: finding OpenClaw agents already on the machine.
- `src/orchestrator/quiesce.ts` — `stopAndConfirm`: stops and observes runtimes before snapshots and bot handoffs; unknown is refused.
- `src/orchestrator/archive.ts` — `archiveAgent`, `resumeArchive`, `finishArchive`, `parkOtherChannels`: archiving (stops the agent and gives its bot back); after a restart, finished once the bot was given back, undone before. Its Discord and Slack bots are parked by the finish (`parkArchivedChannels` in `src/api/routes.ts`), a restart's included.
- `src/api/routes.ts` — `'/v1/agents/:id/archive'`, `'/v1/agents/:id/restore'`, `archiving`, `progressOf`: archive (the `archiving` marker the list shows while the conversation is saved first) and unarchive.
- `src/orchestrator/provision.ts` — `provisionChannelOrGoWebOnly`, `webOnlyIfNoBot`: no pool bot free on an unarchive, clone, derive or template import → the agent goes on web-only instead of waiting for a token (create still asks).
- `src/orchestrator/timezone.ts` — `agentTimeZone`: the time zone every agent gets (`HATCHABOT_TIMEZONE`, else the machine's): OpenClaw's `userTimezone` at seed (`buildConfigCommands` in `src/openclaw/configWriter.ts`), the container's `TZ` (`buildRuntimeSpec`), and set live on running agents by `retargetCronSweep` in `src/api/routes.ts`.
- `src/store/store.ts` — `agents`, `agent_classes`, `agent_env`, `data_sources`, `agent_seed`: agent records, classes, per-agent secrets, data sources, and template files to seed at first provision.
- `web/index.html` — `createAgent`, `agentTelegramChanged`, `rebuild`, `rebuildAll`, `rebuildPlan`, `rebuildOrMark` (Rebuild all's and Bulk Rebuild's one rule and one way: running ones rebuilt, stopped ones a rebuild would change marked for their next start, one never built or moved to another machine skipped, a 409 'busy'), `reasonFor`, `reasonsSaid` (the failures named, for both), `openFleetActions`, `faApply`, `faResultLine` (its result line, part by part), `openSetupLog`, `openAdoptDlg`, `archiveAgent`, `confirmArchive`, `archivingHere`, `restoreAgent`: the create dialog (Telegram off unless ticked; the API's own default is a bot, for the CLI), rebuild buttons, bulk actions, archiving (its tile shows "Archiving…" from the click) and the Setup log.

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

- `src/orchestrator/gitSource.ts` — `normalizeGitUrl`, `buildGitSyncScript`, `buildPublicGitSyncScript`: the accepted URL shapes, and the idempotent clone scripts for the private (deploy key) and public (https) cases. `hostKeyTrustLine`: the git host's SSH key is trusted on first sync only, never replaced. `probeGitSource`: the Test button's `git ls-remote` from this machine with the source's key (the key in a private temp dir for the one command), and its one-sentence answers.
- `src/api/routes.ts` — `'/v1/agents/:id/data-sources/:dsId/check'`: the Test button (a folder checked here; a repo through `probeGitSource`; a folder of an agent on a runner answered `remote`). `folders_stay_here`: the move-host refusal for an agent with folders.
- `web/index.html` — `renderDataList`, `checkDataSource`, `showDeployKeyForSource`: the Data tab's rows (Make writable / Make read-only, where each lands, Test), and the deploy key box above the repo list.
- `src/orchestrator/provision.ts` — `syncGitDataSources`, `datasource.git_synced`: where each repo is cloned during provisioning, and the event it logs (`datasource.git_sync_failed` carries git's own error).
- `src/orchestrator/provision.ts` — `scrubRemovedDataSources`, `datasource.key_left`, `inGitAccessTurn`: a removed source's deploy key (with any .pub beside it) and its clone taken off the volume, and the key out of the secret store, retried at start, wake and rebuild until confirmed (`data_source_removals` in the store), never while a sync is writing a key (one at a time per agent); the script is `buildGitRemovalScript` in `src/orchestrator/gitSource.ts`.
- `src/openclaw/workspace.ts` — `dataSourcesSection`, `DATA_SOURCES_HEADING`: the AGENTS.md section that tells the agent each path.
- `src/api/routes.ts` — `'/v1/agents/:id/data-sources'`, `'/v1/agents/:id/data-sources/:dsId'`, `addingSources`: add, change and remove a source; a name being added is held until its row is saved.
- `src/orchestrator/dataSourceLimits.ts` — `MAX_DATA_SOURCES`: the most sources one agent may hold, the same number a template and a full copy carry.
- `web/index.html` — `addGitSource`: the agent sheet's "add a repo" form.
- `docs/data-sources.md`: the design.

## Google connections and what each agent can reach

A Google account is connected once (the OAuth consent), kept in the vault,
attached to agents, and imported into each agent's own `gog` with
`gog auth import`. A detach or a deleted connection is recorded in
`connection_removals` first and cleared only when `gog auth list` shows the
account gone (issues #11, #16). The access overview (docs/access-overview-design.md)
records what Hatchabot last found inside each running agent in `access_checks`
and compares it with what it intends; mismatches become an Alerts line.

- `src/orchestrator/googleConnections.ts` — `materializeConnection`, `materializeConnections`, `dematerializeConnection`, `gogAccounts`, `recordGoogleSeen`, `syncConnections`, `withConnectionLock`, `offAgainIfDetached`: import, removal, the per-agent turn, and the checks they record.
- `src/orchestrator/googleConnections.ts` — `testGmail`, `gmailFailure`; `src/api/routes.ts` — `'/v1/agents/:id/connections/:email/test'`; `web/index.html` — `testAgentGmail`: Test Gmail on an agent's Connections.
- What an agent is told about its accounts: `src/openclaw/workspace.ts` — `googleAccountsSection`; `src/orchestrator/googleConnections.ts` — `attachedGoogleAccounts`; `src/orchestrator/provision.ts` — `syncDataSourceDocs`; `src/api/routes.ts` — `syncGoogleDocs`
- `src/orchestrator/accessOverview.ts` — `verifyAgentAccess`, `accessProbeScript`, `accessOverview`, `accessAlertOf`, `agentsWithAccessFindings`: Verify now (read-only), the overview, and its Alerts line.
- `src/store/store.ts` — `access_checks`, `recordAccessCheck`, `connectionRemovalsSince`, `countConnectionsFromOtherClient`: the records, and which OAuth client issued each connection (`client_id`).
- `src/api/routes.ts` — `'/v1/google-oauth/client'`, `'/v1/agents/:id/connections/:email'`: the installation's OAuth client (a different client ID is confirmed first), and an agent's Disconnect (detaches an attached account).
- `src/api/routes.ts` — `pushClientSecret`, `deliverClientSecret`, `deliverSecretTo`, `clientSecretSweep` (also on the handle `registerRoutes` returns, for tests); `src/store/store.ts` — `connectionsOwedClientSecret`, `connectionOwedClientSecret`; `src/orchestrator/googleConnections.ts` — `materializeConnections`: a new client secret reaches the agents holding the old one (an agent's owed accounts in one exec, a status line each), and the 10-minute pass asks again those that were busy or failed, backing off one that keeps failing (HB-0463). The Connections page's `secretPending` reads the same query, for its caller's accounts; it brings what each agent is judged by (its state, runtime and move).
- `src/api/routes.ts` — `'/v1/connections'`, `'/v1/agents/:id/connections/attach'`, `'/v1/agents/:id/connections/detach'`, `'/v1/access'`, `'/v1/agents/:id/access'`, `'/v1/agents/:id/access/verify'`, `accessAlert`: the vault, attach and detach, the overview and Verify now, the agent list's Alerts field.
- `web/index.html` — `v2LoadAccess`, `v2VerifyAccess`, `loadAccessMap`, `accessRowsHTML`: the Sharing tab's Access row and Settings → Security → What your agents can reach.

## The runtime provider and Docker (local and runners)

Every agent is a Docker container plus one named volume holding its OpenClaw
home (memory, config, sessions). The provider interface hides whether Docker is
local, rootless, or a runner (another machine reached over SSH or TCP). Agents
sit on an isolated Docker network. Memory caps and compressed swap are applied
per container.

- `src/providers/provider.ts` — `RuntimeProvider`, `RuntimeSpec`, `ProviderError`: the interface every provider implements.
- `src/providers/localDockerProvider.ts` — `LocalDockerProvider`, `provision`, `execShell`, `exportState`, `exportStateToFile`, `importState`, `importStateFromFile`, `execShellOnVolume`, `streamFromVolume`, `rootless`, `sshTarget`, `tcpReachable`: Docker commands for local and remote daemons. `sweepOneShots`, `ONESHOT_PROCESS_LABEL`: leftover one-shots, told apart at boot by the process that made them.
- `src/providers/volumeCopy.ts` — `STATE_CACHE_EXCLUDES`: the caches a copy of an agent's volume leaves out (the nightly backup's list).
- `src/providers/dockerNames.ts` — `dockerNames`, `DEFAULT_PREFIX`, `LEGACY_PREFIXES`: an agent's container and volume names from its runtime ref, a pre-slug ref's old `agentclaw-vol-<short>` included; the one rule the provider, `agentArchiveName` and the backup script's `vol` follow.
- `src/providers/resolveProvider.ts` — `resolveProvider`, `pingRunner`: picks the provider for a host; checks a runner's Docker.
- `src/providers/runnerEndpoint.ts` — `dockerConnArgs`, `tcpTlsProblem`: how the docker client is pointed at a runner (a `tcp://` one over verified TLS only, refused without a client certificate).
- `src/providers/mockProvider.ts` — `MockProvider`: the in-memory provider used by tests.
- `src/orchestrator/runnerSetup.ts` — `ensureRunnerKey`, `runnerSetupSnippet`, `installRuntimeImage`: adding a runner machine (a runner on another CPU pulls the published image by the digest in the release's manifest, `publishedRuntimeImage`).
- `scripts/runner-scenarios.mjs` — `scenario`, `recalls`: real moves between this machine and a runner on a live install (old and new images, memory recalled by meaning).
- `scripts/live.mjs` — `LIVE_TESTS`, `dueFor`, `touches`, `committedRuns`, `readRuns`, `resultOf`, `endedOn`: the live tests' register, what is due for a release (`touches`: a change to a big shared file counts only near the test's own routes), the record (the gate reads the committed one), and a clean install counting only when it ended on the release under test (`docs/live-tests.md`, `docs/live-test-runs.md`); `scripts/promote.sh` — `live_gate`.
- `scripts/clean-install-test.sh` — `vm_stopped`, `vm_failed`, `save_vm_log`, `net_why`: the clean install in a fresh LXD VM; a VM that stops or never gets ready is reported as the VM's or the machine's failure, and "no internet" says what was found (tested with shims in `test/cleanInstallTest.test.ts`).
- `scripts/privacy-check.mjs` — `privateValues`, `tailnetValues`, `seenMachinesFile`, `load`, `scan`, `mask`, `ACCEPTED_HISTORY`, `ACCEPTED_PULL_HEADS`, `hookStatus`: the privacy check (the household's private values read from the live install, and the machine names `tailscale status` listed before, kept in `~/.config/hatchabot/privacy-machines.json`; what it could not read makes the result incomplete, exit 3; the pre-push hook and tag guard, `--check-hook`, `--text` for release notes, `--public` for the `privacy` live test, `allowedHere` for the owner's identities, `syncCi`/`exportDigests` for GitHub's copy); `scripts/privacy-ignore.txt` (generic words); `scripts/privacy-identity.txt` (the maintainer's public author identities). `scripts/privacy-ci.mjs` — `buildFingerprints`, `parseFingerprints`, `scanLine`, `decodedViews` (a line decoded: percent, HTML, base64; both checks), `scanAcross` (a value across a line break), `scanRange`, `rangeOf`, `allowedIdentities`, `withoutOwnTrailers`, `watchMain`, `textInside` (the text inside binary files, for both checks): the privacy check GitHub runs on keyed fingerprints (CI's `privacy` job, `.github/workflows/privacy-watch.yml`); `scripts/privacy-sync.sh`: the daily sync timer. `.gitleaks.toml` (exact fixture exceptions) and `scripts/gitleaks-regression.sh`: the CI secret scan. `scripts/make-debian-test-image.sh`: the local Debian 12 VM image for `clean-install-debian-12`.
- `src/orchestrator/moveHost.ts` — `moveAgentToHost`, `completeOnTarget`, `putBack`, `keepPin`, `resumeMoveHost`, `recoverMoveHost`, `settleOrphan`: moving an agent between this install's machines, finishing or undoing one a restart cut off, and the held choices when its copy on the other machine could not be removed. An undone move puts back the record of what the source runs (`appliedBefore`, `restoreAgentApplied` in `src/store/store.ts`) and a dropped image pin (`droppedImage`); a removed repo still to be scrubbed is scrubbed on the copied volume before the agent starts there, and recorded done only once the move is settled, so an undone move leaves it to the source's next start (`scrubRemovedDataSources` in `src/orchestrator/provision.ts`, its `settle` option); one made while stopped owes its rebuild hook to the next start (`setRebuildHookDue`; `runOwedRebuildHook` in `src/orchestrator/provision.ts`, run by `clearPinsWhenUp` in `src/api/routes.ts`).
- `src/orchestrator/migrate.ts` — `migrateAgent`, `preflight`, `destinationHasAgent`, `resumeMigrate`, `recoverMigrate`: moving an agent to another Hatchabot; after a lost answer or a restart, asking that server whether it arrived. `MOVE_HEADER`, `receiveMove`, `moveState` (`src/api/routes.ts` — `'/v1/moves/:id'`; table `move_receipts`): the destination records each move's id before its import awaits anything and answers for that move, to that account only; a peer's rehost token reads it (`src/api/auth.ts` — `REHOST_MOVE_RECEIPT`).
- `src/api/peerAddress.ts` — `allowedPeerAddress`: peer URL protocol and loopback/link-local checks, including IPv6 literals. `pinnedPeerFetch`, `allowedPeerIp`: every call to another server (registration probe, migration, consolidated `/v1/bots`) checks the address the socket dials and refuses redirects.
- `src/orchestrator/transfer.ts` — `exportAgent`, `importAgent`, `rollbackImport`, `resumeImport`, `stateAllowance`, `tooLarge`, `NO_ROOM_BYTES`: the whole-agent archive behind download, moving to another Hatchabot, and restore from a download (the agent's setup fields, app record and switches with it: `ExportManifest`); an import a restart cut off is undone. `importProfile`: the AI source an arriving agent goes on, which the move's `preflight` names too. `ExportedDataSource`: the repos (deploy key included) and folders (declarations) that travel with it; `import.folders_not_here` names the folders the destination does not have. `src/store/store.ts` — `setAgentExportedAt`: a downloaded copy exists, so delete and archive do not park the bot, nor free a pool bot (`src/orchestrator/archive.ts` — `copyElsewhere`, `leaveBotToCopy`). `src/providers/provider.ts` — `runtimeRefFor`: the ref a failed provision would have had, so its volume is destroyed by the rollback (an import's, and a first setup's in `src/orchestrator/provision.ts` — `runProvisionSteps`).
- `src/orchestrator/hibernate.ts` — `hibernateSweep`, `wakeSweep`, `wakeAgent`, `hibernateBlocker`: idle agents sleep and wake on demand (off unless HATCHABOT_HIBERNATE_AFTER is set).
- `src/orchestrator/memoryCap.ts` — `effectiveMemoryCap`, `parseMemoryCap`: per-agent memory limits.
- `src/orchestrator/swap.ts` — `effectiveSwapAllowance`, `limitsDrift`, `parseSwapProbe`: compressed swap and the limits check.
- `src/orchestrator/agentFiles.ts` — `listShell`, `tarArgv`, `uploadAllowed`, `RUNTIME_STATE_FILES`: the Files pane (browse, download, upload; never over OpenClaw's live database or logins, a list adopt.ts shares).
- `src/api/routes.ts` — `'/v1/hosts'`, `'/v1/runner-setup'`, `'/v1/hosts/:id/install-image'`, `'/v1/agents/:id/move-host'`, `'/v1/agents/:id/rehost'`, `'/v1/agents/:id/fs'`, `'/v1/resources'`: hosts, moves, files and resources.
- `web/index.html` — `loadHosts`, `addHost`, `showRunnerSetup`, `moveHostAgent`, `rehostAgent`, `v2LoadFiles`, `openFleetResources`: the matching screens. Other Hatchabot servers (`renderPeers`, `addPeer`) sit in Settings → Advanced (`SETTINGS_ADV`, `settingsAdvUnfold`; old links go through `V2_SETTINGS_ALIAS`).

## Apps in agents

A codebase with a `hatchabot.json`, installed into an agent (docs/apps-in-agents.md).

- `src/orchestrator/apps.ts` — `parseManifest`, `parseSource`, `repoFor`, `resolveRelease`: the manifest and the source, read on the host (a folder, or a git address mirrored beside the database).
- `src/orchestrator/apps.ts` — `installRelease`, `mergeConfig`, `appChat`, `syncTasks`, `switchTo`, `removeTasks`, `clearStaging`: inside the agent (releases under `~/.openclaw/apps/<app>/`, its config, its tests before the switch, its scheduled commands).
- `src/orchestrator/appOperations.ts` — `resumeAppOperation`, `recoverAppOperation`, `appChoices`: an install, update or roll back cut off by a restart, or whose put-back failed (the `current` link, the staged config and the tasks compared with the record; held with "Use the new release" / "Go back to the previous one").
- `src/orchestrator/apps.ts` — `outcome`; `src/api/routes.ts` — `appFail`, `appOpFailed`: how a failed change left the agent (`unchanged`, or `held` for a choice), which the page repeats.
- `src/api/routes.ts` — `'/v1/apps/inspect'`, `'/v1/agents/:id/app'`, `'/v1/agents/:id/app/update'`, `'/v1/agents/:id/app/rollback'`, `appTarget`: the routes (machine owner only).
- `src/store/store.ts` — `agent_apps`, `getAgentApp`, `setAgentApp`: which app, source, commit and previous commit.
- `src/api/routes.ts` — `'/v1/agents/:id/app/pending'`, `runPendingApp`, `runPendingOnce`, `installFromSource`: a new agent from a repo installs its app when provisioning finishes (one run per agent at a time; a request saved while one runs goes in after it; a direct install or Stop app retires a waiting one).
- `src/orchestrator/appPending.ts` — `stashPendingSecrets`, `resolvePendingValues`, `dropAppPending`, `onePendingChange`: a waiting install's `secret` values live in the secret store, the row keeps only where; dropped once it goes in (only the request that ran: each saved request has its own `gen`), or on archive or delete. `stashOldPendingSecrets` (at boot, before serving; `src/index.ts`) moves the plain-text secrets of rows written before v2.160.0.
- `src/api/routes.ts` — `sharedAppConflicts`, `appAccountsOf`, `sharedConfigCheck`, `oneAppAtATime`: one copy of an app per account (409 unless `allowShared`), judged on the config it would run with (and the other copy's own config), one install per app and account at a time.
- `web/index.html` — `v2LoadApp`, `v2AppUpdate`, `v2AppRollback`, `openAppDlg`, `appRead`, `appConnPicked`, `appGo`: the agent page's App row and the "run an app from a repo" dialog.
- `src/cli.ts` — `app inspect`, `app install`, `app create`: the `hatchabot app …` commands (also update, rollback, status, remove); `appSourceArg`: a git address goes as typed, a folder is made absolute from where the command ran.

## Telegram and other chat apps

Each agent may have a Telegram bot, from the shared bot pool or pasted by hand,
and optionally Discord or Slack. Strangers get silence: only members, or people
already known to the owner's agents, are let in; an invite link opens a short
window in which a new person's first message is paired. The bot's settings are
written into OpenClaw by the seed, so channel changes usually need a rebuild.

- `src/channels/telegramPool.ts` — `TelegramPoolProvisioner`, `PoolExhaustedError`, `retryPendingNames`: leasing bots from the pool and renaming them. `ownBotsOnly` (the request): only the person's own bots are offered or counted.
- `src/store/store.ts` — `owner_prefs`, `ownerPrefs`, `setOwnerPref`: a person's own choices (own bots only); `src/api/routes.ts` — `'/v1/account/prefs'`: saving one; `web/index.html` — `setPoolOwnOnly`: the tick in Settings → Messaging → Telegram.
- `src/channels/telegramManual.ts` — `TelegramManualProvisioner`, `verifyBotToken`: a bot token pasted by hand (checked with Telegram within `VERIFY_DEADLINE_MS`; only a 401 or 404 "no" is a wrong token, anything else is `TelegramUnavailableError`, a 503 "try again"). The pasted token waits in memory and on disk (`pendingRef`, `waitingFor`; `heldBot` and `sameToken` tell a post sent again by its hash) until setup takes it; the bot-token step stays, marked `received`, until then, and setup clears it (`runProvisionSteps`). `src/api/routes.ts` — `provisionWhenFree`: setup for an answered step, now or after the setup or rebuild under way; at boot for one answered before a restart.
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
- `web/join.html` — `postJoin`, `joinWeb`, `joinWebAccount`, `initWebChat`: the page an invite link opens.
- `src/api/publicAccess.ts` — `factorRefusal`: what `/v1/join` says to a good sign-in refused for want of a second factor.
- `web/index.html` — `v2LoadChans`, `v2AddTelegram`, `chanConnect`, `openChanSetup`, `loadPool`, `addPoolBot`, `invite`, `renderEditMembers`, `approve`, `denyPair`: the Messaging pane, pool and members. Settings → Messaging (`V2_SETTINGS`, `showTab`) holds the spare bots of Telegram (`loadPool`), Slack and Discord (`loadPoolPane`), one at a time: `v2SettingsShown` picks the pane (the one a link names, else the last shown) and `#v2MsgApp` is the list that changes it.

## Web chat and the OpenClaw console

The app embeds each agent's own OpenClaw console (Control UI) through a proxy
under the agent's /ui path; HTTP and WebSocket traffic is forwarded to the
agent's gateway with the signed-in person's identity. The owner gets full
rights; guests (members using web chat) get a restricted role and only their
own sessions. A simpler chat route runs one turn inside the container.

- `src/api/routes.ts` — `'/v1/agents/:id/ui'`, `'/v1/agents/:id/ui/*'`, `'/v1/agents/:id/console/access'`, `'/v1/agents/:id/console/approve'`, `gatewayAddr`, `consoleHeaders`, `revalidateConsoleSockets`: the console proxy and its WebSocket upgrade handler.
- `src/api/consoleProxy.ts` — `withConsoleIdentity`, `guestRequestVerdict`, `spliceGuest`, `scrubForGuest`, `GuestReplies`, `Outbox`, `GUEST_METHODS`: what a guest may do through the proxy, how replies are matched to requests, and what waits to be sent to each side.
- `src/api/consoleWorkerStub.ts` — `CONSOLE_WORKER_STUB`: the stand-in service worker the proxy answers each console's `sw.js` with (keeps nothing, clears OpenClaw's caches, unregisters); OpenClaw's own cached one copy of the console per agent and filled the browser's storage.
- `src/api/controlUiRebase.ts` — `rebaseControlUi`: rewrites the console page to live under the proxy path.
- `src/api/consoleSockets.ts` — `ConsoleSockets`: open console WebSockets, closed when rights change.
- `src/openclaw/consoleIdentity.ts` — `consoleGatewayRoles`, `consoleGatewayAuth`, `GUEST_SCOPES`: the trusted-proxy roles written into the gateway.
- `src/orchestrator/consoleAccess.ts` — `ConsoleAccess`, `consoleSyncBatch`, `gatewayCallAs`, `trackGuest`, `promiseRoom`: keeps the gateway's allowed users in step with members, and counts each guest's open consoles.
- `src/api/webChat.ts` — `registerWebChatRoutes`, `webChatNeedsRebuild`, `'/v1/agents/:id/chat'`: the simple web chat routes.
- `src/orchestrator/webChat.ts` — `runWebChatTurn`, `webChatHistory`, `webChatSessionKey`: a web chat turn inside the container.
- `web/index.html` — `openGateway`, `openWebChat`, `openGuestConsole`, `openWebChatPanel`, `webChatSend`, `approveConsoleBrowser`: opening the console and chat. `webChatCanSend` (one message at a time; Send does not wait for the conversation to load), `webChatOfferUnsure` and `webChatAnswered`: a message that may not have arrived, counted against the read before it and given back; one sent with no read before it is counted by its time, in the server's (`serverAheadMs`, from a quick answer's Date header in `api`, read as its headers come: `SERVER_CLOCK_TRIP_MS`), and the same words sent after the read join it.

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
- `src/orchestrator/webSearch.ts` — `createSearchWatch`, `probeBrave`, `probeDuckDuckGo`, `duckDuckGoTurnedAway`, `braveAdvice`, `applySearchScript`, `searchProviderFor`, `readAgentSearchTest`: which search the fleet uses, testing it, and moving agents off Brave when it runs out. `src/api/routes.ts` — `'/v1/web-search'`, `'/v1/web-search/check'`, `'/v1/agents/:id/search-test'`.
- `src/orchestrator/searchUsage.ts` — `searchUsageReport`, `searchPeriod`, `monthBefore`, `readSearchPrice`, `saveSearchPrice`: the month's Brave searches, what is left, per day, per agent, and the cost (HB-0532). Counted by `USAGE_READER_SCRIPT` (`src/orchestrator/usage.ts`) from the transcripts and stored by `sampleAgentUsage` (`src/orchestrator/sourceUsage.ts`; `storeSearchHours` keeps each hour at the larger of its stored count and the reading's, never lower), which files an agent's searches on its own Brave key as `OWN_BRAVE` (`attributeBrave`, HB-0578); `src/store/store.ts` — `setSearchHours`, `addSearch`, `searchHours` (table `search_hours`); `src/api/routes.ts` — `'/v1/web-search/usage'`; `web/index.html` — `loadSearchUsage`, `renderSearchUsage`, `searchUsageHTML`, `saveSearchPrice`.
- `src/ops/push.ts` — `createOpsPush`: Telegram messages to the owner when a card waits.
- `src/channels/notify.ts` — `tellOwner`, `ownerChatRoutes`: a budget's, spike's or loop's message to the owner, by Telegram, Discord or Slack; `src/api/routes.ts` — `tellUsageSpike`, `chatNoteOf`.
- `src/ops/notify.ts` — `createOpsNotifier`: posts outcomes back into the manager's conversation.
- `src/openclaw/configWriter.ts` — `OPS_TOOLS_ALLOW`, `OPS_TOOLS_DENY`: the manager's OpenClaw tool lockdown.
- `src/api/routes.ts` — `'/v1/ops-agent'`, `'/v1/ops-agent/suggest'`, `opsPeerOk`, `runOpsTurn`: creating the manager and asking it things.
- `src/store/store.ts` — `mgmt_proposals`, `ops_tokens`: cards and door keys.
- `web/index.html` — `v2SetupOps`, `mgmtProposalCard`, `loadProposals`, `askOpsSuggest`: setting it up and the confirm cards.

## An agent's own browser

Off by default; one Chromium container per agent that has it on, in the
agent's network namespace (docs/browser.md).

- `src/orchestrator/browser.ts` — `browserSweep`, `browserImage`, `BROWSER_CDP_URL`, `containerOf`: keeping the browsers in step with the agents, each beside its agent's container as the provider names it.
- `src/providers/localDockerProvider.ts` — `ensureBrowser`, `stopBrowser`, `listBrowsers`, `containerName`: the containers.
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

- `src/orchestrator/snapshots.ts` — `CORE_FILES`, `readCoreFile`, `captureSnapshot`, `autoSnapshot`, `restoreSnapshot`, `restoreParamLayer`, `writeCoreFile`, `resumeSnapshotRestore`, `recoverSnapshotRestore`, `snapshotsInUse`: snapshots and safe edits of the core files; a restore cut off part-way is held with "Finish" / "Revert to the copy taken before", and the snapshots it needs are kept from pruning and from delete.
- `src/api/routes.ts` — `withCoreFilesTurn`: a snapshot taken by hand and a change that writes several core files (setup values, a pushed definition, a restore) take turns on an agent, and each reads the agent again when its turn comes; one waits two minutes at most, then is refused and never runs (HB-0566).
- `src/orchestrator/provision.ts` — `checkpointMemory`, `reindexMemoryIfSwitched`, `memoryIndexIncomplete`: saving memory before risky steps; re-indexing.
- `src/orchestrator/transcript.ts` — `recoverContext`, `contextStats`, `exportTranscript`: recovering context after a reset; chat history download.
- `src/orchestrator/inspect.ts` — `readInspectableFile`, `readTranscript`, `TRANSCRIPT_TAIL_SCRIPT`: reading an archived agent's files and its main conversation.
- `src/embedder/embedder.ts` — `EmbedderService`, `bootStartEmbedder`, `scheduleEmbedderBoot` (the boot start and health loop timers), `embedDefault`, `EMBED_MODEL_ALIAS`, `syncKeysNow`: the shared embedding container (a runner's keeps its state under `embed-hosts/<host id>` and copies its keys there; `remove` when the runner is removed).
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

- `scripts/backup-owner.sh` — `key_owner`, `set_owner`: the mark of an install's key that its backup sets (`.backup-owner`) and drill records (`owner`) carry, as `ownerMark` in `src/orchestrator/backups.ts` makes it, and whose a set is, as `foreignSet` reads it; sourced by `scripts/backup-volumes.sh`, `scripts/restore-drill.sh` and `scripts/uninstall.sh`.
- `scripts/backup-volumes.sh` — `write_status`, `json_list`, `earlier_captured`, `add_captured`, `ROOTLESS`, `KEEP_DAYS`, `release_lock`, `lock_busy`, `pid_alive`, `reap_oneshot`, `tls_args`: the backup run itself (an archive this user cannot read back fails the set; a later run of the day keeps what an earlier one wrote whole; one run per set, a dead run's lock taken over one run at a time, another user's run never taken for dead; each archive container, here or on a runner, named and removed when its client fails; a tcp:// runner over verified TLS; retention keeps each agent's newest copy).
- `deploy/hatchabot-backup.timer` — `OnCalendar`: when it runs.
- `deploy/hatchabot-backup.service` — `Type=oneshot`, `ExecStart`: what the timer starts (the backup script).
- `src/orchestrator/backups.ts` — `listBackups`, `startBackup`, `pruneBackup`, `restoreAgentFromBackup`, `resumeBackupRestore`, `recoverBackupRestore`, `agentsMissingFromSet`, `keepDays`, `restoreSafetyDir`, `agentArchiveName`: reading and acting on backup sets. `foreignSet`: a set made by another install that shares the folder, or by this one under an earlier key (its `.backup-owner`, read through `setOwner`, which keeps each set's answer until its files change): listed only with `others`, labelled `foreign`; never deleted from here; restored only with the owner's `otherKey` (`RestoreError` code `other_key`). A restore writes its copy of how the agent was to `restoreSafetyDir` before the volume is replaced (removed once the restore ends either way; kept when its undo failed, or while a restore cut off by a restart is held for "Finish the restore" / "Put back the copy from before").
- `scripts/restore-drill.sh` — `set_state`, `foreign_owner`, `RECORD_OWNER`, `DRILL_BY`, `take_lock`, `lock_busy`, `write_record`, `cleanup`, `prune_records`, `finish`: proves a backup set (the newest complete one of this install's by default) restores — every archive read, each restored into a throwaway volume with no network, limits and only that archive mounted — and writes its record to `<backups>/drills/`, named for the install whose set it was, keeping the newest 30 of each install's.
- `src/api/routes.ts` — `'/v1/backups'`, `'/v1/backups/run'`, `'/v1/backups/restore'`, `'/v1/agents/:id/backup'`, `'/v1/agents/restore'`: the backup panel, one-agent download and restore from a download.
- `web/index.html` — `loadBackups`, `runBackupNow`, `pruneBackup`, `restoreFromBackup`, `downloadAgent`: the Backups panel.

Recovery readiness (docs/recovery-readiness-design.md): per agent, the newest
usable backup, the sets that left it out and why, the last drill that checked
it, one status; restore drills recorded, and opt-in on a schedule.

- `src/orchestrator/recoveryReadiness.ts` — `computeReadiness`, `usableFor`, `setAgeDays`: the readiness of each agent from the sets' records and the drill records (and the Alerts fold). The status reads this install's own sets only; another install's (`BackupSet.foreign`) are restore choices, `otherKey` in `restorable` (this install's own kept first, then the others' newest, 14 in all) and `latestUsable`; `ownLatest` is this install's newest, which `v2RecoveryToggle` (web) chooses first.
- `src/orchestrator/drills.ts` — `listDrills`, `drillEvery`, `drillDue`, `startDrill`, `drillRunState`: the drill records (this install's newest 30, by their `owner` mark), the schedule (`HATCHABOT_DRILL_EVERY`) and running the drill from the app.
- `src/api/routes.ts` — `'/v1/backups/readiness'`, `'/v1/backups/drill'`, `'/v1/backups/drill-schedule'`, `runDrill`, `drillSweep`: the API, the `restore-drill` operation and the 15-minute schedule check.
- `web/index.html` — `v2LoadReadiness`, `v2PaintRecovery`, `v2RecoveryToggle`, `v2RecoveryGo`, `loadReadiness`, `renderDrillRun`, `runDrillNow`, `setDrillEvery`, `v2BackupWarn`, `v2MachineAlerts`: the agent sheet's Recovery row and guided restore, the table and drill controls in Settings → Backups, and the Alerts.

## Health, reconcile and the event log

The database says what each agent should be; reconcile compares that with
Docker at boot and on a timer and mends the recorded state (it never starts or
removes containers). A health check asks the agent's own gateway whether it is
really working. Every notable step is recorded as an agent event, shown in the
Setup log and Activity.

- `src/orchestrator/reconcile.ts` — `reconcileAgents`, `startReconcileLoop`, `reconcileEventLog`: registry versus Docker; its findings about an agent go to that agent's timeline too. It leaves alone an agent whose operation is not over (`activeOperationFor`).

### Durable operations (long changes that survive a restart)

A long change records itself in the `operations` table as it goes: what was
asked, the last step done, the outcome, and what the owner may do next. An
agent whose operation is running, was interrupted by a restart, or is held for
a choice is busy on disk: Start, Rebuild, Archive, Move, Delete, Wake and Retry
refuse with its line. At boot, after the first reconcile, each interrupted one
is finished, undone or held by its kind's rule (docs/operations-and-one-interface-design.md, docs/moving-agents.md).

Kinds: move-host, migrate, import (v2.154.0); restore-backup, restore-snapshot,
archive, rebuild, provision, app-install / app-update / app-rollback,
install-image and backup-run (v2.155.0); restore-drill (v2.157.0). A rebuild or a setup is recorded
(`queued` while it waits its turn) but its guard stays in memory
(`BACKGROUND_KINDS`): it refuses nothing on disk until a restart cuts it off.
An image copy, Back up now and a restore drill are a machine's operations (no agent): the
Activity list reads them from the table (`listMachineOperations`).

In the background (v2.156.0): a move (`move-host`), a move to another
Hatchabot (`rehost`), a full-copy import, a backup restore and a snapshot
restore answer `202 { operation }` once validated and begun (`runInBackground`;
a move to another Hatchabot after its preflight), and go on after the answer.
`?wait=1` keeps the old answer. `POST /v1/agents/restore` stays synchronous
unless `?async=1`: the other Hatchabot's migrate reads the agent from its
answer. The page and the CLI follow `GET /v1/operations/:id`; Activity shows
one row per operation (its op.* lines and what it logged meanwhile left out of
the feed, kept in the agent's own timeline).

- `src/orchestrator/operations.ts` — `beginOperation`, `STEPS`, `BACKGROUND_KINDS`, `operationRefusal`, `activeOperation`, `markInterrupted`, `publicOperation`, `currentBootId`: the record, each kind's steps, and the on-disk busy check.
- `src/orchestrator/operations.ts` — `runInBackground`, `operationTitles`, `operationSummary`, `spanWords`, `STATUS_EVENT`: a long change answered at once and run on; its words ("Moving to Laptop runner", "Moved to Laptop runner · 3 min").
- `src/orchestrator/operationsResume.ts` — `resumeOperations`, `resumeBackground`, `recoverOperation`, `retryHeldOperations`, `startOperationRetryLoop`: settling interrupted operations at boot (a queued rebuild queued again; a setup or rebuild whose container is up and answering has its remaining steps run; otherwise reconcile's rules), the owner's choices (run under the agent's busy flag, so the restart rule does not take it again: `busyHeld`), and the 10-minute pass.
- `src/orchestrator/reconcile.ts` — `applyReconcileRule`: reconcile's rules for one agent, also how an interrupted rebuild or setup is settled.
- `src/orchestrator/provision.ts` — `reapplyCurrentSettings`: this installation's settings over a restored volume (a backup restore, and its finish after a restart).
- `src/store/store.ts` — `operations`, `insertOperation`, `updateOperation`, `activeOperationFor`, `listMachineOperations`, `listAppPendingAgents`, `pruneOperations`: the table (kept 90 days, at least 50 per agent).
- `src/store/store.ts` — `eventsForOperation`, `withoutOps`: an operation's own steps (the Activity row that opens), and the feed without them.
- `src/api/routes.ts` — `'/v1/operations'`, `'/v1/operations/:id'`, `'/v1/operations/:id/recover'`, `busyNow`, `startRefusal`, `kickRebuild`, `kickProvision`, `'/v1/hosts/:id/install-image'`, `'/v1/backups/run'`, `'/v1/events'`: the API, the guards, the recorded queue, and a machine's operations in Activity.
- `src/api/routes.ts` — `waitAsked`, `accepted`, `backgroundError`, `'/v1/agents/:id/move-host'`, `'/v1/agents/:id/rehost'`, `'/v1/agents/import'`, `'/v1/agents/restore'`, `'/v1/backups/restore'`, `'/v1/agents/:id/snapshots/:snapId/restore'`: the routes that answer 202 and run on.
- `src/cli.ts` — `followOperation`, `startedOperation`, `opsTable`, `'ops'`, `'move'`, `'backups'`: `hatchabot ops [agent]`, `ops recover`, `move`, `backups restore`, and following an operation a command started.
- `src/mgmt/broker.ts` — `followOperation`: the Hatchabot agent's tools wait for an operation they started to end.
- `src/mgmt/restTools.ts` — `list_operations`, `recover_operation`: the Hatchabot agent's tools for them.
- `web/index.html` — `opNotice`, `recoverOp`, `agentAttention`: a held operation in the sheet's Overview and under Alerts.
- `web/index.html` — `v2OpLine`, `v2FollowOp`, `v2WatchOps`, `v2OpTick`, `v2ActOpRow`, `v2ToggleActOp`, `v2ViewKey`: Working on and the ring read the operation, the page follows it (2 s) and toasts its end, Activity's row per operation, Alerts' "Waiting for your choice" bin first.
- `src/orchestrator/health.ts` — `agentHealth`, `aiSourceHealth`, `doctorLint`: the live health check and OpenClaw config lint.
- `src/orchestrator/posture.ts` — `computePosture`, `runPostureSweep`, `measureAgentDisks`: the daily security and disk posture.
- `src/orchestrator/eventLabels.ts` — `eventLabel`: plain words for event names.
- `src/orchestrator/tokenWatch.ts` — `runTokenWatch`: loop incidents (see costs below).
- `src/api/routes.ts` — `'/healthz'`, `'/v1/agents/:id/health'`, `'/v1/agents/:id/logs'`, `'/v1/agents/:id/events'`, `'/v1/events'`, `'/v1/security/posture'`, `diskSweep`, `limitsCheck`: health, logs, events and posture.
- `src/store/store.ts` — `agent_events`, `recordEvent`, `listEvents`, `posture_snapshots`: where it is stored.
- `web/index.html` — `v2InlineHealth`, `loadHealth`, `renderHealth`, `openLogs`, `openSetupLog`, `openAudit`: health and logs on screen (an agent's Overview → Checks).
- `web/index.html` — `v2CheckAll`, `v2HealthProblems`, `v2PaintCheckAll`: Check all on the home screen (every running agent, results as Alerts and a line above the agents).

## Costs, usage, budgets and the token steward

A background pass every ten minutes reads each agent's model calls (from its
transcripts and gateway log), stores per-hour figures, and then runs, in order:
the model-change guard, the token steward (loop incidents), spike alerts (after
the loops, so a loop told in the pass covers its spike) and budgets. Their
advice comes together in one ranked list, Recommended. Every dollar figure is tokens priced at list API prices. Right-size
(the model steward) keeps a ledger of model changes and judges each one later.

- `src/api/routes.ts` — `runUsageSample`, `runTokenSteward`, `runBudgetPass`, `runModelGuard`: the background pass.
- `src/orchestrator/usage.ts` — `agentUsage`, `USAGE_READER_SCRIPT`: tokens per model summed from transcripts. `partial`: rows the read could not decode; the sampler (`src/orchestrator/sourceUsage.ts` — `usage.sample_partial`) then writes no total from that read.
- `src/orchestrator/tokenHealth.ts` — `windowK`: the model's context window from the agent's OpenClaw config; `web/index.html` — `loadContextNow`: the Context now table at the top of Usage.
- `src/orchestrator/sourceUsage.ts` — `sampleSourceUsage`, `summarizeSourceUsage`, `parseModelCalls`: per-source requests, tokens and rate limits. `src/store/store.ts` — `appliedSourceChanges` (table `applied_source_changes`, written by `setAgentApplied`): every change of the source an agent's container runs, so each call is filed under the source that made it.
- `src/orchestrator/fleetUsage.ts` — `computeUsagePeriod`, `snapshotDailyUsage`: the Usage view by period.
- `src/orchestrator/agentCosts.ts` — `costsFor`, `agentCost`, `spendSeries`, `priceParts`, `isSpendRange`, `isCostPeriod`: cost badges and the spend chart (its `unpriced` tokens), and the ranges and windows the routes accept.
- `src/orchestrator/pricing.ts` — `MODEL_PRICES`, `estimateCost`, `priceList`: the price list.
- `src/orchestrator/budgets.ts` — `runBudgets`, `budgetView`, `stepView`, `pausedReplySweep`, `dailyCosts`, `priceGapNote`: monthly budgets, step alerts and the pause, and what a dollar limit cannot see on a model with no known price.
- `src/orchestrator/usageAlerts.ts` — `runUsageAlerts`, `findUsageSpikes`: "much more than usual" warnings.
- `src/orchestrator/tokenHealth.ts` — `buildTokenHealth`, `loopSignals`, `THRESHOLDS`: the token steward's evidence. `injectedSize`, `promptFiles`: the instruction files that go in every turn, in characters (`TOOLS.md` only before OpenClaw 2026.9.6, read from the reader's `ocv`).
- `src/orchestrator/tokenWatch.ts` — `runTokenWatch`, `incidentMessage`, `loopCovering`: open and clear loop incidents; one cause, one message a day.
- `src/orchestrator/recommendations.ts` — `buildRecommendations`, `agentRecommendations`, `isCostCard`, `GROUP`: the Recommended list (one item per cause, ranked, with its action).
- `src/api/routes.ts` — `'/v1/recommendations'`, `'/v1/agents/:id/recommendations'`, `'/v1/recommendations/:id/dismiss'`, `ledgerMeta`: the list, Not now, and via "recommendation" in the ledger.
- `src/orchestrator/loopLines.ts` — `parseLoopLines`: loop lines in the gateway log.
- `src/orchestrator/compaction.ts` — `compactAgent`, `syncContextCap`: compaction and the conversation cap.
- `src/orchestrator/compactionState.ts` — `compactingNow`: the compactions running in this process; `src/orchestrator/tokenHealth.ts` — `tokenHealthRow` reads it and the latest one in the ledger (`lastMainCompactions` in `src/store/store.ts`), so the advice to compact catches up with a compaction.
- `src/orchestrator/modelLedger.ts` — `recordChange`, `evaluateModelChanges`, `rightSizeSavings`, `fileGuardProposals`: the model-change ledger and quality guard.
- `src/orchestrator/modelScorecard.ts` — `buildScorecard`: the weekly review's evidence.
- `src/orchestrator/modelReview.ts` — `syncModelReviewCron`: the manager's weekly review task.
- `src/api/routes.ts` — `'/v1/costs'`, `'/v1/usage'`, `'/v1/usage/spend'`, `'/v1/agents/:id/usage'`, `'/v1/ai-profiles/usage'`, `'/v1/budgets'`, `'/v1/agents/:id/budget'`, `'/v1/token-health'`, `'/v1/token-incidents'`, `'/v1/agents/:id/compact'`, `'/v1/model-changes'`, `'/v1/model-prices'`: the routes behind the views.
- `src/store/store.ts` — `agent_model_profiles`, `token_samples`, `model_call_hours`, `agent_cost_days`, `budgets`, `budget_pauses`, `spend_alerts`, `token_incidents`, `agent_token_health`, `model_changes`, `usage_alerts`: where it is stored.
- `web/index.html` — `openUsage`, `openFleetUsage`, `renderFleetUsage`, `loadSpendCharts`, `openBudgets`, `v2LoadCosts`, `openModelPrices`, `savedByModels`: the Usage, Cost and Budgets screens.
- `web/index.html` — `loadRecommended`, `recItemHTML`, `recAct`, `recNotNow`, `v2OpenRec`, `agentAttention`: Recommended on Usage and the agent's Usage tab, and the Alerts lines that link to it.

## Images

Agents run from a runtime image built locally from the repository's
Dockerfile, tagged with its OpenClaw version and promoted to latest. An owner
can try a candidate base image on chosen agents before promoting it, and can
build derived images (the base plus extra packages) for particular agents.

- `docker/Dockerfile.runtime` — `OPENCLAW_VERSION`: the runtime image.
- `docker/entrypoint.sh` — `PYTHONPATH`: container start-up.
- `scripts/build-runtime-image.sh` — `NO_LATEST`, `use_pulled`, `legacy_published`: builds and tags the image, or pulls the one the release's manifest names by digest (`legacy_published`: by tag, for releases made before manifests).
- `src/orchestrator/releaseManifest.ts` — `releaseManifest`, `parseReleaseManifest`, `publishedRuntimeImage`, `manifestRequired`: the app's reading of its release's manifest; the published image by digest for the provider's ensureBaseImage and a runner's Install image.
- `src/orchestrator/derivedImage.ts` — `buildDerivedImage`, `renderDockerfile`, `removeDerivedImage`, `dockerfileProblem`: derived images (the lines that may go into one).
- `src/orchestrator/imageRecipe.ts` — `ensureImageOn`, `buildRecipeOn`: rebuilding an image on another machine from its recipe.
- `src/orchestrator/runtimeCaps.ts` — `probeImageCapabilities`: what an image can do.
- `src/providers/provider.ts` — `parseEmbedEngineLabel`, `parseChannelsLabel`: image labels read at build time.
- `src/providers/localDockerProvider.ts` — `imagesInUse`: containers per image id, for what blocks a delete.
- `src/api/routes.ts` — `imageBlockers`: everything that stops an image tag being deleted, behind Used by and both deletes; `'/v1/runtime'`, `'/v1/runtime/images'`, `'/v1/runtime/build'`, `'/v1/runtime/images/promote'`, `'/v1/images'`, `'/v1/images/:name/rebuild'`, `'/v1/rebuild-policy'`, `buildBaseImage`: images and the automatic rebuild policy.
- `src/store/store.ts` — `derived_images`: where it is stored.
- `web/index.html` — `loadRuntimeImages`, `pollBaseBuild`, `runTryOnAgents`, `promoteImage`, `loadDerivedImages`, `initSettingsAdvanced`, `loadRebuildSection`: Settings → Advanced → Runtime images and Derived images, and Hosts → Automatic rebuilds (building a newer OpenClaw is the Hatchabot agent's job; the panel shows one line while a build runs).

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

- `src/orchestrator/problemReport.ts` — `buildReport`, `redactForPublic` (`maskPaths`, `judgePath`, `systemKeep`, `afterSpace`, `maskQueryValue`, `maskAddress`, `maskName`, `maskSshWords`, `maskCredentialForms`, `maskQuotedPassAndKey`, `maskDockerAuth`, `maskCredentialsField`, `maskWords`, `maskUsers`, `maskPeople`, `isDefaultName`), `endpointIdentity`, `issueUrl`, `searchSource`, `SEARCH_WORKER`, `SEARCH_LIMITS`, `readSource`, `sourcePath`, `realInside`: facts, masking, the link, and the source the manager may read (links checked by where they lead; searches bounded in a worker).
- `src/api/routes.ts` — `'/v1/problem-reports'`, `'/v1/problem-reports/:id'`, `'/v1/diagnostics'`, `'/v1/source'`, `'/v1/source/search'`, `reportFacts`, `reportRedaction`: drafts, diagnostics and source routes; the private names and known credentials a draft is masked with.
- `src/mgmt/restTools.ts` — `'get_diagnostics'`, `'search_source'`, `'read_source'`, `'prepare_problem_report'`: the manager's tools for it.
- `src/ops/opsAgent.ts` — `Settings questions, and reporting a bug in Hatchabot`: the manager's instructions for it.
- `src/domain/redact.ts` — `redactSecrets`, `redactCredentialFields`, `maskKnownValues`: key masking shared with logs; `quotedFieldMasker`: a quoted name's value in any quoting, read in code; `maskKeyMaterial` (`keyRunEnd`, `isKeyLine`, `maskPuttyKeys`, `ppkBlock`, `prefixShape`): whole key blocks, PuTTY key files and base64, for a public report only; `isShellFolder`: `PWD=` holds a folder, not a password.
- `src/store/store.ts` — `problem_reports`, `ProblemReportRow`: where drafts are stored.
- `web/index.html` — `openReport`, `reportCreate`, `reportOpenIssue`, `reportFromHash`: the review panel.

## The web app's main screens

One page, `web/index.html`, served at the root with the version injected. The
only look is the icon home screen (a "v2" prefix in function names; the
classic card look was removed in v2.155.0). Clicking an icon opens the
agent sheet, whose tabs are rendered by v2Pane. All data comes from the /v1
API through one fetch helper.

- `web/index.html` — `v2LoadFiles`, `v2FilesSortBy`, `v2FilesOrder`, `v2OpenFile`: the Files tab's list, its sorting (folders first; remembered as `hb-files-sort`) and the in-tab viewer with ← Back (text, images, sound, video and PDF — `v2ShownHere`; the rest only downloads). At the public address a PDF, Open in a tab (`sfOpen`), and a picture, sound or video whose load failed first ask the file route whether it may be read: `src/api/routes.ts` — `req.query.check` (`check=1`) answers 204 once the second-factor gate has passed and the download's own checks (`fsReadable`: there, a file, not too big) have, without reading the file.
- `web/index.html` — `openGateway`, `consoleCoverSay`, `autoApproveConsole`: opening an agent's console: the panel opens at once with the spinner, which stays until the console's frame has loaded.
- `web/index.html` — `initV2`, `renderV2`, `refresh`, `api`: start-up, the home grid, the periodic reload and the fetch helper.
- `web/index.html` — `openV2Agent`, `v2Open`, `v2Pane`, `v2RenderSheet`, `v2RenderSheetBar`: the agent sheet; v2Pane's tabs are overview, personality, ai, messaging, knowledge, sharing, usage, schedule, files and advanced. On a phone (≤640px) the sheet stops 44px short of the top, so a tap on the home screen above it closes it, and its bar has ‹ Back (`.v2sback`) in place of the ✕ (`.v2sclose`).
- `web/index.html` — `v2RefreshSheet`, `v2SheetNotes`, `v2SheetSaving`, `v2SheetBaseline`, `v2SheetUnsaved`, `agentPrefix`, `forAgent`: the sheet's tabs of edit sections redraw when the agent's state changes, unless a control in their forms differs from its baseline (its value when filled or last saved). Every fill or render helper calls `v2SheetBaseline` on what it fills; a save that does not draw its controls again notes what it sent, for its own agent only and only where no fill came after the press (`v2SheetSaving`, `v2SheetFills`); the notes are one agent's (`v2EmbedPanes` clears them when another opens, on any tab); notes of controls drawn over go when `v2SheetUnsaved` checks, and all go when the sheet closes. A control counts, and is baselined, unless its change saves it, marked `data-saves`, or it is a task's own switch (`v2SheetEdits`, used by `v2SheetCounts` and `v2SheetControlsOf`). On a tab drawn again, a menu filled from the record keeps a choice not saved yet (`v2KeepsChoice`: the image, memory search, memory cap and swap menus). `agentPrefix` puts an agent's name before what is said about one not shown. Every save in the edit forms answers through `forAgent(forId)`: `draw` only while the forms are still that agent's, `say` a toast with its name when it is not the one shown, `fail` under the forms only while they are on screen (`shown`), else as `say`.
- `src/orchestrator/agentIcons.ts` — `pickIcons`, `suggestIcons`, `keywordIcon`, `validIcon`: agents' icons. The management AI picks one for each agent without one (`src/api/routes.ts` — `'/v1/agents/icons/auto'`) and gives ideas to choose from in the icon dialog, never repeating what it showed (`'/v1/agents/:id/icons/suggest'`; nothing is saved there); the keyword table stands in without an AI, and every answer is cut down to one emoji and a palette colour (`replyArrays` reads a reply's entries one by one; `replyShape` is what the log gets of it, never its text). `web/index.html` — `openV2Icon`, `v2IconIdeas`, `v2MaybeAutoIcons`: the icon dialog with its ✨ Ideas, and the home screen asking for the missing icons.
- `web/index.html` — `v2SetView`, `v2SetSort`, `v2LoadRecent`, `agentAttention`, `v2LoadMachine`: View by, sorting, Activity, Alerts and the machine line (its backup part from `GET /v1/backups?latest=1`: the newest set and who it leaves out, never every set).
- `web/index.html` — `v2PlannedHTML`, `loadTodos`, `createFromTodo`, `retireMadeTodos`: the Planned group (ghost tiles; the plans are the agent-todos routes).
- `web/index.html` — `v2PlaceInGroup`, `v2MoveInGroup`, `v2DropTarget`, `sortGroup`: My order — drag within a group, Move earlier / later, a group's kept A→Z (the agent move and group sort routes).
- `web/index.html` — `v2TabKeys`, `v2AcctItems`: arrow keys for the View by and sheet tabs and the account menu.
- `web/index.html` — `setupSteps`, `renderSetup`, `openSetupGuide`: the first-run guide.
- `web/index.html` — `renderCrons`, `openInspect`, `openGallery`, `openInbox`: scheduled tasks, archived-agent inspector, templates, shared agents.
- `web/index.html` — `importAgentFile`, `peekImportTemplate`, `collectParamValues`, `submitParamForm`, `paramYes`: Import of a `.hatchabot` file (a full copy or a template); the bounded peek that tells them apart in the tab (the first bytes, at most `IMPORT_PEEK_BYTES`), the template's setup form (a default cleared is sent empty; a yes/no default read as the server reads it), and its answers sent in the body ahead of the file (`IMPORT_WITH_VALUES`; the route reads the line up to `IMPORT_HEAD_MAX_BYTES`, and `?values=` from older callers); the CLI's `uploadAgentFile` (`src/cli.ts`) sends them the same way).
- `web/index.html` — `takeClassicChoice`, `v2DismissClassicMap`: the one-time map for a browser that had the classic look (`hb-ui`), and a `?ui=` dropped from the address.
- `web/index.html` — `agentNotices`, `prepareEdit`, `prepareCrons`: the notices and the editDlg / cronDlg sections the agent sheet borrows. A task's Edit stays one across the same agent's tabs while the sheet is open (`endCronEdit` on close); its Save sends only what differs from what Edit put in the form (`cronEditFilled`, `cronFormOf`). `clearCronForm` is the one reset of the form (another agent, the sheet closed, a task saved).
- `src/api/routes.ts` — `'/'`, `'/v1/config'`, `'/v1/agents'`, `'/v1/agents/:id'`, `'/v1/recent'`, `'/v1/agents/:id/crons'`, `indexPage`: the page itself and the main reads behind it.
- `src/orchestrator/recent.ts` — `RecentTracker`, `orderRecent`, `previewLine`: the Activity view and tile previews.
- `src/orchestrator/crons.ts` — `listCrons`, `addCron`, `editCron`, `setCronEnabled`, `runCronNow`: scheduled tasks inside the agent.
- `src/orchestrator/taskNotes.ts` — `dueTaskNotes`, `taskNoteText`, `TASK_NOTES_PER_HOUR`: a note on the owner's phone each time a task they ticked has run (HB-0537), seen in the quick pass's read of the task store (`readCronStore`) and sent by `noteFinishedTasks` in `src/api/routes.ts` through the Hatchabot agent's bot (`createOpsPush`, a budget of its own); `src/store/store.ts` — `cronNotes`, `setCronNote`, `markCronNoted` (table `cron_notes`); `web/index.html` — `cronNoteBox`, `setCronNote`, `cronNoteHint`.
- `src/orchestrator/crons.ts` — `cronTargetFor`, `retargetImplicitCrons`, `pendingRetarget`, `readCronStore`, `retargetDue`, `cronStoreReadShell`: where a task's result goes (the owner's chat, or the web-chat conversation of an agent in no chat app), and re-pointing tasks with no recipient or aimed at a chat app the agent has left (`namesRemovedApp`); `src/api/routes.ts` runs `retargetCronSweep` after a start and daily, and `quickCronRetarget` every 5 minutes (one read of the task store per agent, the CLI only for a task that needs changing).
- `web/sw.js` — `fetch`: the service worker for the installable app.
- `scripts/check-web.mjs` — `checkHandlers`: static checks on the page (run by the tests).
- `scripts/ui-clickthrough.mjs` — `--headless`: the click-through UI test (headless Chrome against the real page). Under its virtual time Chrome draws no frames: no `requestAnimationFrame` callback runs, no ResizeObserver reports and no dialog's close event fires. `window.__frame` (in `RECORDER`) stands in for a frame: the waiting callbacks run, then each ResizeObserver hears of its boxes that changed size.
- `web/index.html` — `phoneQuery`, `isPhone`, `.phone-stack`, `.phone-wrap`, `.phone-flow`, `mpRow`, `mpHead`, `spendChartWidth`, `spendChartFit`, `spendChartResized`, `spendChartsRefit`, `spendChartSVG`, `spendChartWords`, `spendChartsPrune`, `.v2classicmap`: on a phone (640 px wide or less: one media query, `phoneQuery`, read by `isPhone`) rows are laid out for the width: a row of words and buttons (`.pair` with its words in `.grow`) wraps when its words would be squeezed, the buttons under them (one rule, beside `.phone-stack`, which a task row keeps to put all its buttons under its words), one marked `.phone-wrap` puts its first item (a dropdown or a text box) on a line of its own, a label marked `.phone-flow` keeps its dropdown beside it when they fit and under it when not, more rules sit after `.v2classicmap`; a wide table (`.mp-tbl`, built with `mpHead` and `mpRow`) is a card per row with each value named after its column (an empty cell unnamed); the cost chart is drawn at the inside width of its card, at most 640, wherever it is (`spendChartWidth`; 640 while its box is hidden); its picture alone (`spendChartSVG`, the agent picker and range buttons kept) is drawn again a frame after its box's width changes (`spendChartFit`, a ResizeObserver, answers with `spendChartResized`, which hands the boxes that changed to `spendChartsRefit`, which reads every width before it draws); a chart hidden then is fitted when it shows; charts gone from the page, or in a dialog that closed and is still closed, are let go (`spendChartsPrune`, at each drawing and refit, and as a dialog closes; a closed dialog's charts go back to "Loading…" until it draws them anew). The tables' alignments are `mpLeft` and `mpNum`. `scripts/ui-clickthrough.mjs` — `phoneEveryScreenFits`: opens every screen at 360 and 390 px with fuller made-up data and fails on anything past the edge, spilling, squeezed, a dropdown cut short beside other things, or chart text under 10 px.
