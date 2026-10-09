# Troubleshooting

Known problems, as the person running Hatchabot sees them, with what causes them and how they were fixed.
Search this file for the exact text you see (an error, a `hatchabot doctor` line, a tile or log message).
Each entry says how to **confirm** it before acting: run that check first, since several symptoms share their wording.
**Fixed in** names the release that fixed it in code: on an older install the fix is to upgrade (`hatchabot upgrade`); `—` means a setting or the machine.
**Code** names the file to read to go deeper.

## Install and upgrade

### Linux: every agent fails with "Could not create the agent volume", while your terminal runs `docker` fine
- **Check:** `hatchabot doctor` prints "Service running, but it cannot use Docker — it started before your user joined the docker group".
- **Cause:** the service runs under your systemd user manager, whose groups are fixed when it starts; joining the docker group and logging back in quickly (or `newgrp`) leaves the old manager running without the group.
- **Fix:** `sudo systemctl restart user@$(id -u)` (or reboot). Since v2.132.0 the service starts through `sg docker`, so this does not recur (doctor has named it since v2.34.7).
- **Fixed in:** `v2.132.0`
- **Code:** `src/doctor.ts` — `serviceDockerDenied`; `scripts/with-docker.sh` — `sg docker`

### `hatchabot doctor`: "Docker is installed but not reachable" or "Docker is not installed"
- **Check:** the doctor line itself; `docker info` in a terminal.
- **Cause:** the Docker daemon is not running (Docker Desktop closed on a Mac), or on Linux your user is not in the docker group.
- **Fix:** start Docker. On Linux: `sudo usermod -aG docker $USER`, then log out and in (and see the entry above).
- **Fixed in:** —
- **Code:** `src/doctor.ts` — `doctorReport`

### "I upgraded but nothing changed"
- **Check:** `hatchabot doctor` prints "Checkout has local changes (…) — the installer refuses to upgrade over them", or "Running vX, but vY is available locally".
- **Cause:** a git-checkout install will not move over local edits, and an upgrade that was refused leaves the old release running.
- **Fix:** `git -C <install dir> stash` (or commit the changes), then `hatchabot upgrade`. A bundle install has no checkout and never shows this.
- **Fixed in:** —
- **Code:** `src/doctor.ts` — `checkoutFacts`

### After an upgrade, agents still run the old OpenClaw version
- **Check:** `hatchabot doctor` "Runtime image: OpenClaw …" against the release notes; the agent's sheet shows "newer image available" or not.
- **Cause:** before v2.80.1, `hatchabot upgrade` updated only the app and never fetched the release's runtime image.
- **Fix:** upgrade; the upgrade now pulls the release's image and makes it the default. Then rebuild agents when convenient (memory is kept). `HATCHABOT_UPGRADE_IMAGE=0` skips the image step.
- **Fixed in:** `v2.80.1`
- **Code:** `scripts/upgrade.sh` — `HATCHABOT_UPGRADE_IMAGE`

### `hatchabot doctor`: "Runtime image hatchabot-runtime:latest is missing — agents cannot start"
- **Check:** `docker image ls hatchabot-runtime`.
- **Cause:** the image was removed (a `docker system prune -a`, say) or never downloaded.
- **Fix:** `./scripts/build-runtime-image.sh` in the install directory: it pulls the published image and builds only if that fails.
- **Fixed in:** —
- **Code:** `src/doctor.ts` — `runtimeImage`; `scripts/build-runtime-image.sh`

### uninstall.sh says "The service runs from …, but this script is in …"
- **Check:** `grep WorkingDirectory ~/.config/systemd/user/hatchabot.service` names a different folder from the one you ran it in.
- **Cause:** the service belongs to another checkout. Uninstall now refuses rather than remove that other install's service and agents (before v2.153.0 it purged it).
- **Fix:** run `<that folder>/scripts/uninstall.sh`, or add `--installed`. To drop only the clone, `rm -rf` it.
- **Fixed in:** `v2.153.0`
- **Code:** `scripts/uninstall.sh` — `--installed`

### The channel timer says a release "will not be retried", or the service restarts every ten minutes
- **Check:** `journalctl --user -u hatchabot-follow-channel` (or `-u hatchabot-follow-latest`); `cat ~/.local/state/hatchabot/follow-channel-failed follow-channel-tries`.
- **Cause:** before v2.153.0 a network failure counted as "release failed", so a release was set aside without being tried. An install that always failed rolled back and restarted the service on every tick.
- **Fix:** upgrade by hand (`hatchabot upgrade stable`), then `rm ~/.local/state/hatchabot/follow-channel-failed`. From v2.153.0 a failing install is retried with growing waits, set aside after 8 failures in a row, and never restarts the service.
- **Fixed in:** `v2.153.0`
- **Code:** `scripts/follow-channel.sh` — `MAX_TRIES`; `scripts/upgrade.sh` — `rollback`

### `hatchabot upgrade beta` is undone: the channel file says stable again
- **Check:** `cat ~/.config/hatchabot/channel` against `systemctl --user cat hatchabot-follow-channel` (its ExecStart channel).
- **Cause:** the timer's own upgrade saved its channel over the one chosen by hand.
- **Fix:** upgrade, then run `hatchabot upgrade beta` again (or reinstall the timer with `follow-channel.sh --install beta`).
- **Fixed in:** `v2.153.0`
- **Code:** `scripts/upgrade.sh` — `HATCHABOT_UPGRADE_BY_TIMER`

### The installer stops with no message, or installs a newer release than stable
- **Check:** run it again with `HATCHABOT_DRY_RUN=1`. Check `getconf GNU_LIBC_VERSION` (fails on musl/Alpine) and `curl -fsSL https://raw.githubusercontent.com/hatchabot/hatchabot/main/channels.json` (an HTML page means a captive portal).
- **Cause:** under pipefail, a failed fetch or getconf ended it silently, and a portal's page was read as "stable is not named", which gave the newest release.
- **Fix:** sign in to the network, or name a version (`… | bash -s -- vX.Y.Z`). From v2.153.0 it says what is wrong.
- **Fixed in:** `v2.153.0`
- **Code:** `install.sh` — `OFFLINE`; `scripts/release-target.sh` — `is_channels`

### Service setup stops right after writing the units (rootless Docker / Podman)
- **Check:** `getent group docker` prints nothing, or `echo $USER` is empty.
- **Cause:** `getent` found no docker group (or `$USER` was unset) and set -e/pipefail ended `install-service.sh`, so the CLI was never linked.
- **Fix:** upgrade, then re-run `scripts/install-service.sh`. On older releases, run `groupadd docker` or export USER.
- **Fixed in:** `v2.153.0`
- **Code:** `scripts/install-service.sh` — `DOCKER_GID`

### Re-running the installer on a clone install left it on a release it cannot run
- **Check:** `git -C ~/hatchabot describe --tags` shows the new tag, but the service fails on import, or `node_modules` is missing.
- **Cause:** the installer checked out and installed in place, with no lock and no rollback.
- **Fix:** `hatchabot upgrade <previous tag>`. From v2.153.0 re-running the installer goes through `upgrade.sh`.
- **Fixed in:** `v2.153.0`
- **Code:** `install.sh` — `native-existing`

## Sign-in and accounts

### Password mode: requests to the app's address were served without the password
- **Check:** the install signs in with one shared password (`HATCHABOT_AUTH=password`) and runs a version before v2.152.1; the log shows requests whose path ends in `#/message` with no sign-in.
- **Cause:** the sign-in hooks exempted the agent-to-agent call by testing the raw URL, while the router stops at `#`: a hand-made request for `/v1/agents/<id>#/message` skipped the sign-in check and was served as `/v1/agents/<id>`, as the local owner, which in password mode is the owner. With accounts or Google sign-in the local owner owns nothing, so the same request found nothing.
- **Fix:** upgrade to v2.152.1 or later. If the address was reachable by others, change the password and the agents' sensitive settings (Telegram tokens, API keys) as a precaution.
- **Fixed in:** `v2.152.1`
- **Code:** `src/api/auth.ts` — `isAgentMessageRoute`; `src/api/routedPath.ts` — `routedPath`

### Google sign-in asks you to sign in again about every hour
- **Check:** the install uses `HATCHABOT_AUTH=identity`; it happens on a release before v2.98.0, or when you switch between addresses (LAN address, localhost, the public one).
- **Cause:** the session ended with Google's own token (about an hour). Each address also keeps its own cookie, so a different address always asks again.
- **Fix:** upgrade (sessions last 14 days, `HATCHABOT_SESSION_DAYS`), and always open Hatchabot at the same address, ideally `HATCHABOT_PUBLIC_URL`.
- **Fixed in:** `v2.98.0`
- **Code:** `src/api/auth.ts` — `sessionTtlMs`, `HATCHABOT_SESSION_DAYS`

### Creating the first account asks for a "setup code"
- **Check:** you are on the first-run page from another device than the Hatchabot machine (or under rootless Docker).
- **Cause:** by design: before any account exists, only someone on the machine itself, or holding the code printed at start-up, may create the owner account.
- **Fix:** use the link the installer printed (it carries the code after `#setup=`), or find "first-run setup code" in the server log, or run `hatchabot accounts create <you> --host-owner` on the machine.
- **Fixed in:** —
- **Code:** `src/index.ts` — `first-run setup code`; `src/api/accountsAuth.ts` — `first-run setup code`; `scripts/first-run-link.sh` — `setup=`

### Sign-in refuses after several wrong passwords
- **Check:** the sign-in answers "Too many failed attempts — try again later." (HTTP 429).
- **Cause:** the sign-in throttle: 10 failures per 15 minutes per address (`HATCHABOT_LOGIN_FAILS_PER_WINDOW`). Before v2.97.1, ten wrong guesses in password mode could lock out everyone.
- **Fix:** wait 15 minutes; a forgotten password is reset as in the next entry.
- **Fixed in:** `v2.97.1`
- **Code:** `src/api/auth.ts` — `HATCHABOT_LOGIN_FAILS_PER_WINDOW`, `FAIL_WINDOW_MS`

### The owner is locked out of the app
- **Check:** "Forgot password?" is unavailable (no Telegram linked) and the recovery code is lost.
- **Cause:** a forgotten password with no other way back.
- **Fix:** on the machine: `hatchabot accounts reset-password <username>` (it prompts). Before v2.38.0 this command could not find the database on installs that keep data outside the checkout.
- **Fixed in:** `v2.38.0`
- **Code:** `src/cli.ts` — `reset-password`

### The CLI says "login failed (401) — check HATCHABOT_PASSWORD"
- **Check:** the install runs family accounts (`HATCHABOT_AUTH=accounts`), so there is no shared password.
- **Cause:** a stale password (from an older install or a copied laptop) was sent instead of a token.
- **Fix:** `hatchabot login` once (or Settings → Security → New token, then paste it). Newer releases say exactly that.
- **Fixed in:** `v2.33.3`
- **Code:** `src/cli.ts` — `uses per-person accounts`

### Two accounts both have owner rights after first-run setup
- **Check:** Settings → Accounts (or `GET /v1/local-accounts`) lists more than one host owner, all created within seconds of each other on a fresh install.
- **Cause:** before v2.153.0, two first-account requests sent at the same moment both passed the "no accounts yet" check while their passwords were being hashed, and both became host owners.
- **Fix:** upgrade. Then, as the owner you mean to keep, remove the extra account (or run `hatchabot accounts disable <user>`) and check the security record for what it did.
- **Fixed in:** `v2.153.0`
- **Code:** `src/api/accountsAuth.ts` — `'/v1/local-accounts/bootstrap'`

### A recovery code reset the password twice, or the password you just chose does not work
- **Check:** two "account.recovered_with_code" log lines for one account at nearly the same time, or two pages each showed a new recovery code.
- **Cause:** before v2.153.0, the code was spent in a separate step after the new password was stored, so two requests with the same code could both succeed; the later one's password and recovery code won.
- **Fix:** upgrade. Then sign in with the password from the page that answered last (or use the newest recovery code shown), and make a new recovery code under "Your account".
- **Fixed in:** `v2.153.0`
- **Code:** `src/api/accountsAuth.ts` — `'/v1/local-accounts/recover-with-code'`; `src/store/store.ts` — `recoverLocalAccount`

### After a second-factor reset, an old sign-in at the public address works again without the new factor
- **Check:** after the owner reset someone's factors (`hatchabot second-factor reset <user>`) and that person added a new one, a browser or copied cookie signed in before the reset reaches the public address, or opens a console there, without being asked for the new factor.
- **Cause:** before v2.153.0, the public pass's "second factor given" mark was not tied to the person's set of factors; resetting closed open consoles but the mark counted again once any factor existed.
- **Fix:** upgrade. Passes now carry a factor generation that a reset, a removed factor or a replaced authenticator app moves on, so older proofs ask for the new factor. On an older version, "Sign out on every device" for that person ends the old sign-ins.
- **Fixed in:** `v2.153.0`
- **Code:** `src/api/publicAccess.ts` — `factorAt`, `secondFactorsChanged`; `src/store/store.ts` — `second_factor_generations`

## AI sources and Claude login

### An agent answers "Your model provider needs a new login" or "Not logged in · Please run /login", while the same source works for other agents
- **Check:** the agent's Setup log has `runtime.pins_cleared` after the fix, or, inside the container, `openclaw gateway call sessions.list` shows its sessions pinned to the `claude-cli` runtime.
- **Cause:** OpenClaw pins a runtime per conversation. Agents that once ran through the Claude Code CLI kept that pin after switching to a setup token, and the CLI has no login in the container.
- **Fix:** upgrade, then start or rebuild the agent: pins to runtimes its settings no longer name are cleared at rebuild, start, wake and boot. Do not replace tokens first.
- **Fixed in:** `v2.86.1`
- **Code:** `src/orchestrator/runtimePins.ts` — `clearStaleRuntimePins`; `src/orchestrator/eventLabels.ts` — `runtime.pins_cleared`

### Every message fails with "LLM request failed (request format rejected, HTTP 400)" after switching to a newer Claude model (claude-opus-5-5)
- **Check:** the agent's gateway log (`docker logs <container>`) has `claude_code_version_too_old` and "Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required"; the agent runs on a Claude subscription source.
- **Cause:** on a subscription, OpenClaw presents itself to Anthropic as a fixed Claude Code version, and the newest models refuse an old one. OpenClaw 2026.9.6 says 2.1.278; 2026.9.7 and later say 2.1.280. Measured on 2026.9.6: Opus 5.5 is refused; Sonnet 5.5, Fable 5.1 and Sonnet 5 answer. An API-key source is not affected.
- **Fix:** switch the conversation back to a model the source accepts (Sonnet 5 or Opus 4.8) in the chat's model menu, or set the agent's model in Hatchabot. To use the newer model: an agent on OpenClaw 2026.9.7 or later (Settings → Images: try a newer image on that agent), or an API-key source. Since v2.137.0 Hatchabot refuses that model for such an agent and says why; a choice in OpenClaw's own chat menu still fails this way.
- **Fixed in:** —
- **Code:** `docker/Dockerfile.runtime` — `OPENCLAW_VERSION`; `src/orchestrator/modelOptions.ts` — `SUBSCRIPTION_MIN_OPENCLAW`, `subscriptionModelProblem`

### An AI source shows "rate-limited" hours after the plan's limit reset
- **Check:** Settings → AI sources shows the source limited with no refused call since.
- **Cause:** a refusal counted as current until some agent called again.
- **Fix:** upgrade: a refusal now counts only within the limit's own window (5 hours for a Claude plan, 15 minutes for an API key).
- **Fixed in:** `v2.80.4`
- **Code:** `src/orchestrator/sourceUsage.ts` — `stillCounts`

### Several agents on one AI source stop answering at about the same time
- **Check:** Usage's top line "Requests that did not go through" (refused = rate limits), the source's status in Settings → AI sources, and which agents made the most calls in the last 5 hours.
- **Cause:** usually the plan's limit was reached, often because one agent loops (a frequent scheduled task, two agents consulting each other, a huge conversation). A setup token can also expire.
- **Fix:** find and calm the heaviest agent (pause its task, compact its conversation, move it to another source). An expired token: run `claude setup-token` again and paste it into the source. The exact plan percentage is only shown in the Claude app: setup tokens cannot read it.
- **Fixed in:** —
- **Code:** `src/orchestrator/sourceUsage.ts` — `user:profile`, `limitedSince`

### An AI source cannot be deleted: it says agents still use it
- **Check:** the source's row counts your agents and other accounts' agents on it.
- **Cause:** an agent still points at it or its container still runs on it (a switch without a rebuild). Before v2.89.2 an archived agent also counted forever.
- **Fix:** move the agents (or, as the machine owner, "↪ Migrate all off…"), rebuild switched agents, then delete.
- **Fixed in:** `v2.89.2`
- **Code:** `src/api/routes.ts` — `appliedProfileId`; `web/index.html` — `openMigrate`

### A local model source: "points at this machine's loopback, which an agent container cannot reach" or "Couldn't reach a model server"
- **Check:** the message when saving the source; `curl http://<docker bridge address>:11434/api/tags` from the machine (`docker network inspect bridge` shows the address).
- **Cause:** inside a container "localhost" is the container itself, and Ollama listens on loopback only by default.
- **Fix:** set the source's address to the docker bridge (the address the error message suggests, port 11434, path `/v1`) and make Ollama listen beyond loopback (`OLLAMA_HOST=0.0.0.0:11434`).
- **Fixed in:** —
- **Code:** `src/api/routes.ts` — `checkLocalServer`, `OLLAMA_HOST`

## Telegram, Discord and Slack

### The agent welcomes its owner, then every later message is dropped without a word
- **Check:** the agent's config has `dmPolicy` "allowlist" with no `allowFrom` entries; the gateway log shows no turn for those messages.
- **Cause:** closing the door switched the policy to allowlist before the list held anyone.
- **Fix:** upgrade, then rebuild the agent: the policy and its list are now written together.
- **Fixed in:** `v2.21.1`
- **Code:** `src/orchestrator/provision.ts` — `doorFor`

### On OpenClaw 2026.9, someone who messages the bot gets only a pairing code; no request appears in the app
- **Check:** the agent runs OpenClaw 2026.8 or newer; no knock card under the agent's chat-app card.
- **Cause:** 2026.8+ keeps pairing requests in its state database; the old credentials files Hatchabot read are absent there.
- **Fix:** upgrade: requests, approvals and removals now use the database when the files are gone.
- **Fixed in:** `v2.69.0`
- **Code:** `src/orchestrator/claim.ts` — `pairingListShell`, `PAIRING_DB`

### Two agents answer on one bot, or messages to a bot go missing
- **Check:** two running containers carry the same bot token (the bot was moved, swapped, or is also used by a hand-built OpenClaw).
- **Cause:** two pollers on one Telegram bot take each other's messages, silently. Before v2.68.0 a bot removed from an agent stayed in its config on the volume.
- **Fix:** upgrade and rebuild the agent that should no longer have the bot. When reusing a bot from another OpenClaw, disable it there first.
- **Fixed in:** `v2.68.0`
- **Code:** `src/openclaw/configWriter.ts` — `channels.telegram.enabled`

### An agent falls silent on Telegram after `/compact` or a very long turn; its tile says "Stuck: Telegram message retried N times since HH:MM"
- **Check:** the alert on the agent's tile (🔁); the gateway log shows "applying retry policy (handler-timeout)" for one event id again and again.
- **Cause:** OpenClaw gives a Telegram message 5 minutes, then retries it (up to 8 tries and 24 hours), burning tokens while nothing appears in the chat.
- **Fix:** upgrade (30 minutes by default, `HATCHABOT_CHANNEL_HANDLER_TIMEOUT_MS`) and rebuild; or set `OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS=1800000` in the agent's Environment and rebuild. The Hatchabot agent's `compact_agent` card compacts it. Do not edit OpenClaw's queue by hand.
- **Fixed in:** `v2.120.0`
- **Code:** `src/orchestrator/channelTimeout.ts` — `CHANNEL_HANDLER_TIMEOUT_DEFAULT_MS`; `src/orchestrator/tokenHealth.ts` — `Stuck: `; `src/orchestrator/loopLines.ts` — `applying retry policy`

### A file the agent sent is missing on Slack or Discord
- **Check:** the file was over 5 MB; the agent's Slack/Discord card shows the file limit.
- **Cause:** OpenClaw capped outgoing media at 5 MB on every app and dropped bigger files silently.
- **Fix:** upgrade and rebuild: each app gets its own ceiling (Telegram 50 MB, Discord 10 MB, Slack 100 MB).
- **Fixed in:** `v2.88.5`
- **Code:** `src/openclaw/configWriter.ts` — `mediaMaxMb`

### A new agent sits on "Waiting on you"
- **Check:** the agent's sheet asks for a Telegram bot token; Settings → Telegram shows no spare bot.
- **Cause:** the agent needs a bot and none is available in the pool. Only a new agent made with Telegram on asks this (the create form ticks "No Telegram" by itself when the pool is empty); an unarchived, cloned or imported one goes on web-only (next entry).
- **Fix:** paste a token from @BotFather, or choose **Continue without Telegram** (`hatchabot skip-telegram <agent>`); a bot can be attached later.
- **Fixed in:** `v2.44.1`
- **Code:** `src/cli.ts` — `skip-telegram`

### `hatchabot app install` or `update` stops: "Its tests failed, so … was not switched on"
- **Check:** the output printed with the error (the last lines of the app's own tests), and `app.test_failed` in the agent's Setup log.
- **Cause:** the app's `test` command (in its `hatchabot.json`) failed inside the agent on the new commit. The running version is untouched: nothing switches until the tests pass.
- **Fix:** fix the app (run its tests where you develop it), commit, and run `hatchabot app update <agent>` again; `hatchabot app status <agent>` shows what is running.
- **Fixed in:** —
- **Code:** `src/orchestrator/apps.ts` — `installRelease`

### A failed app update changed the running app's settings (mailbox, mode)
- **Check:** after an Update that failed (its tests failed, or "Could not switch to …"), `docker exec <agent> cat ~/.openclaw/apps/<app>/data/config.json` shows the values given to the failed update, while the App row still shows the old commit.
- **Cause:** before v2.152.0 the new configuration was written to the live `data/config.json` before the new release's tests ran, and was not put back when the update failed.
- **Fix:** upgrade. The new configuration is staged and the tests run against it; it replaces the live file only when the release switches on, and a failed switch restores the old file exactly. On an older version, edit `data/config.json` back by hand, or run Update again with the old values.
- **Fixed in:** `v2.152.0`
- **Code:** `src/orchestrator/apps.ts` — `installRelease`

### An app's scheduled commands are missing or doubled after a failed update or rollback
- **Check:** after an Update or Roll back that failed with "Could not schedule <app>-<task>", `openclaw cron list --json` in the agent lacks some `<app>-…` jobs or has two of one, or `readlink ~/.openclaw/apps/<app>/current` names another commit than the App row.
- **Cause:** before v2.152.0 an install switched `current` first, then removed the app's old jobs before adding the new ones; a job that could not be added left the new code live, the old jobs gone, and the record describing the old release.
- **Fix:** upgrade. New jobs are added before old ones come off, and any failure takes the new ones off, re-adds the old ones from the previous release's `hatchabot.json` and points `current` back. On an older version, run Update again; if it keeps failing, Roll back, or Stop app and install again.
- **Fixed in:** `v2.152.0`
- **Code:** `src/orchestrator/apps.ts` — `syncTasks`

### An app's task fails every run, flagged as a loop: "OAuth client credentials missing"
- **Check:** the agent's Alerts ("Scheduled task \"<app>-tick\" failed 3 runs in a row") and the app's own status (`python3 -m <app> status` in the agent, or its page → App): the error names the missing login.
- **Cause:** the app needs a Google account and none is attached to this agent (made before 2.146.0, the dialog only said to attach one).
- **Fix:** first make sure no other agent runs the same app on that account (two copies both answer every email), then attach it: the agent's settings → Knowledge → Connections. From 2.146.0 the "run an app from a repo" dialog picks and attaches it.
- **Fixed in:** `v2.146.0`
- **Code:** `web/index.html` — `appConnPicked`, `appGo`

### Installing an app is refused: "… already runs … on the same account"
- **Check:** the message names the other agent; its page → App shows the app.
- **Cause:** the same app on one account (one mailbox) in two live agents would answer every email twice.
- **Fix:** stop the app on the other agent (its page → App → Stop app) or use another account; or confirm in the dialog (`allowShared`) if you really want both.
- **Fixed in:** —
- **Code:** `src/api/routes.ts` — `sharedAppConflicts`

### A new agent's page says "Its app could not be installed"
- **Check:** the message under it on the agent's page (App), and `app.install_failed` in its Setup log.
- **Cause:** the app made for it from a repo failed to install once the agent was running: its tests failed, a value it needs was missing, or the repo could not be read.
- **Fix:** fix the cause (the message says which), then press **Try again** on the agent's page; or install it by hand with `hatchabot app install <agent> <dir|url>`.
- **Fixed in:** —
- **Code:** `src/api/routes.ts` — `runPendingApp`; `web/index.html` — `v2LoadApp`

### `hatchabot app install` says "Needs a value for: …"
- **Check:** `hatchabot app inspect <dir|url>` lists what the app asks for.
- **Cause:** a required setting in the app's manifest has no value yet (and none in its existing config).
- **Fix:** pass it as `key=value` after the source, e.g. `hatchabot app install <agent> ~/myapp mailbox=<its address>`.
- **Fixed in:** —
- **Code:** `src/orchestrator/apps.ts` — `mergeConfig`

### Promoting a newer OpenClaw is refused: "… cannot read the data of agents already on 2026.8 or newer"
- **Check:** the agents it names run OpenClaw 2026.7 (`hatchabot list`), not 2026.8 or newer.
- **Cause:** before 2.146.1 the promote check was inverted: it refused moving the fleet UP across 2026.8 over agents still on 2026.7 (the normal path; their volume is healed on rebuild), instead of refusing a move DOWN below 2026.8 over agents already migrated.
- **Fix:** update to 2.146.1. `hatchabot image promote 2026.9.8` (a bare version now means that base image, not a derived image's name).
- **Fixed in:** `v2.146.1`
- **Code:** `src/api/routes.ts` — `'/v1/runtime/images/promote'`; `src/openclaw/configWriter.ts` — `needsPortHeal`

### An agent's times are hours off (it thinks it is in UTC)
- **Check:** `openclaw config get agents.defaults.userTimezone` in the agent (unset before 2.143.0); `date` in its container says UTC.
- **Cause:** OpenClaw falls back to the process's zone, and containers run on UTC.
- **Fix:** update to 2.143.0: every agent gets this machine's zone (or `HATCHABOT_TIMEZONE`); running agents take it within a day, or at once after a restart of Hatchabot; `TZ` at the next rebuild.
- **Fixed in:** `v2.143.0`
- **Code:** `src/orchestrator/timezone.ts` — `agentTimeZone`; `src/api/routes.ts` — `retargetCronSweep`

### An agent I just archived came back ("restoring", or waiting for a bot token)
- **Check:** its Setup log: "archived", then minutes later a restore; Hatchabot's log shows `POST /v1/agents/<id>/restore` from a browser (nothing restores on its own).
- **Cause:** a Restore click. Before 2.142.0 an archived agent's page put 📤 Restore where 💬 Chat sits on a running one, and closing its console after archiving landed on that page.
- **Fix:** archive it again (if it is waiting for a bot token, `hatchabot skip-telegram <agent>` first, then archive). From 2.142.0 archiving closes its console and page, and Restore… is not the main button.
- **Fixed in:** `v2.142.0`
- **Code:** `web/index.html` — `confirmArchive`, `restoreAgent`

### An unarchived agent hangs in PROVISIONING: "waiting for a bot token"
- **Check:** after Restore (`hatchabot unarchive`), the Setup log ends with "waiting for a bot token" and Settings → Telegram shows no spare bot. From 2.142.0 the same situation shows instead as an Alerts line on a running agent: "No Telegram bot was free — it is running in the web app; attach a bot later".
- **Cause:** coming back means leasing a new bot, and none was free. Before 2.142.0 unarchive, clone, derive and template import then parked on the paste-a-token step, though nobody had been asked about Telegram.
- **Fix:** on an older install, `hatchabot skip-telegram <agent>` (or **Continue without Telegram** on its sheet) finishes it web-only, or paste a @BotFather token. From 2.142.0 it goes on web-only by itself; attach a bot when one is free under its settings → Messaging → Telegram (archive or detach another agent to free one, or paste a token).
- **Fixed in:** `v2.142.0`
- **Code:** `src/orchestrator/provision.ts` — `provisionChannelOrGoWebOnly`, `webOnlyIfNoBot`; `src/store/store.ts` — `telegramSkippedForNoBot`; `src/api/routes.ts` — `telegramSkipped`

### @BotFather will not create another bot
- **Check:** count the bots on that Telegram account (@BotFather `/mybots`; Settings → Telegram lists the spares).
- **Cause:** Telegram allows about 20 bots per account, one per agent.
- **Fix:** reuse bots: Detach/Remove parks a bot in the pool for the next agent; `hatchabot adopt <dir> <name> --reuse-bot` keeps an existing OpenClaw bot. Or use a second Telegram account, or put the agent in no chat app.
- **Fixed in:** —
- **Code:** `src/orchestrator/archive.ts` — `~20`; `src/cli.ts` — `reuse-bot`

### A member could schedule tasks, restart the agent or change its settings over Telegram, and the owner could not
- **Check:** `commands.ownerAllowFrom` in the agent's openclaw.json does not hold the owner's chat id.
- **Cause:** with no owner named, OpenClaw makes the first person approved by pairing its command owner.
- **Fix:** upgrade: every build names the owner's chat ids, and a daily sweep sets it live on older agents.
- **Fixed in:** `v2.109.1`
- **Code:** `src/openclaw/configWriter.ts` — `commands.ownerAllowFrom`

### Two agents answer on one Telegram bot after "Change bot", or the new agent's bot gets no messages
- **Check:** the agent's trail has `channel.stop_failed` near `channel.swapped`, or two agents' containers both poll the same `@bot` (Telegram 409 Conflict in the gateway log).
- **Cause:** the swap put a pasted bot back in the pool before the agent stopped, and swapped the row even when the stop failed; a Start could also boot the old container before its rebuild.
- **Fix:** upgrade. Then stop the agent still holding the old bot and rebuild it.
- **Fixed in:** `v2.153.0`
- **Code:** `src/api/routes.ts` — `rebuildAfterHandover`, `'/v1/agents/:id/channel/swap'`

### After "Change bot" the agent stays stopped
- **Check:** the trail shows `rebuild.skipped` with why "stopped by its owner" right after `channel.swapped`.
- **Cause:** a rebuild already queued skipped itself once the swap had stopped the agent, and no new one was started.
- **Fix:** upgrade, or press Rebuild.
- **Fixed in:** `v2.153.0`
- **Code:** `src/api/routes.ts` — `rebuildAfterHandover`

### A removed member can still message the agent
- **Check:** the member was removed while the agent was moving, rebuilding or being restored (the trail shows `member.revoked` inside that operation).
- **Cause:** the removal scrubbed a volume that the move had already copied, or that the rebuild or restore then rewrote.
- **Fix:** upgrade, then remove them again.
- **Fixed in:** `v2.153.0`
- **Code:** `src/orchestrator/members.ts` — `revokeMember`

### A pool bot serving an agent is renamed "Hatchabot (unassigned)"
- **Check:** in Settings → Telegram, the bot is leased but its pending name is "Hatchabot (unassigned)".
- **Cause:** the release parked the idle name after another agent had already leased the bot.
- **Fix:** upgrade, then Sync name on the agent.
- **Fixed in:** `v2.153.0`
- **Code:** `src/channels/telegramPool.ts` — `release`

## Agents, builds and rebuilds

### A rebuild or setup fails with `seed failed at "<step>": …`
- **Check:** the agent's Setup log (`rebuild.failed` / `provision.failed`) names the step, then the tail of stderr and stdout.
- **Cause:** one step of the workspace seed failed; the step named is the cause (older releases printed the last output of an earlier, optional step instead, such as "Plugin llama-cpp is not associated with a tracked package install").
- **Fix:** read the named step's output; Retry/Rebuild after fixing its cause. A first Discord attach on OpenClaw 2026.9 failed this way before v2.72.3: upgrade.
- **Fixed in:** `v2.72.3`
- **Code:** `src/providers/localDockerProvider.ts` — `SEED_STEP_MARK`, `seedFailure`

### Archive seems to do nothing: the tile stays "Ready" for about 20 seconds
- **Check:** the archive dialog had "save the conversation to memory first" ticked, and the Setup log shows "conversation written to memory" (or "could not be written") and then "archived" some seconds after the click.
- **Cause:** that save is a whole agent turn, run before the state changes; before 2.142.0 nothing marked the agent meanwhile, so the click looked lost.
- **Fix:** wait: it archives, and says so if the save failed ("Archived, but couldn't save the conversation…"). Upgrade: from 2.142.0 the tile spins with "Archiving — saving its conversation to memory" from the click, `hatchabot list` says ARCHIVING, and a second tap is refused.
- **Fixed in:** `v2.142.0`
- **Code:** `src/api/routes.ts` — `archiving`, `progressOf`, `'/v1/agents/:id/archive'`; `web/index.html` — `archivingHere`, `confirmArchive`

### A working agent was left STOPPED and FAILED after a rebuild that could not start
- **Check:** the Setup log says the rebuild was refused at render time (an engine-free image with the memory service off, an un-shared source, a missing secret).
- **Cause:** before v2.91.0 the old container was stopped before the refusal.
- **Fix:** upgrade: a refused rebuild keeps the agent running and says why; fix the named cause, then rebuild.
- **Fixed in:** `v2.91.0`
- **Code:** `src/orchestrator/provision.ts` — `renderRefused`

### An agent restarts on its own: "its OpenClaw process quit on its own — killed for memory (exit 137)"
- **Check:** the ↻ note on the agent and `runtime.self_restarted` in its Setup log; Resources shows cap hits for its container.
- **Cause:** the container reached its memory cap. An OpenClaw 2026.9 gateway idles near 1 GB and peaks well above.
- **Fix:** give the agent more memory (its sheet → Runtime → Memory cap, applied at once, or `hatchabot memory <agent> <cap>`), or the machine default (`HATCHABOT_AGENT_MEMORY`, 3g).
- **Fixed in:** —
- **Code:** `src/orchestrator/eventLabels.ts` — `runtime.self_restarted`; `src/config/envCatalog.ts` — `HATCHABOT_AGENT_MEMORY`

### An agent's tooltip says "Restarted by itself once … (last exit 135: a memory fault)"
- **Check:** the tile's tooltip (its runtime part) and `runtime.self_restarted` with `exitCode: 135` in its Setup log; the container log stops with no error just before.
- **Cause:** OpenClaw's process got SIGBUS. Seen once each on two new agents within 15 minutes of their first start (OpenClaw 2026.9.6), during first-day database maintenance; Docker starts it again and nothing is lost. A chat turn in progress is restarted, and may end without a reply.
- **Fix:** none needed if it doesn't recur; resend a message that got no answer. If it keeps happening, note what ran just before (a scheduled command, a model call) and rebuild the agent.
- **Fixed in:** —
- **Code:** `web/index.html` — `v2RuntimeLines`; `src/api/routes.ts` — `lastExitCode`

### A new agent ignores what you wrote in "What is it for?"; its SOUL.md is OpenClaw's generic "SOUL.md - Who You Are"
- **Check:** open the agent's SOUL.md in Files.
- **Cause:** on OpenClaw 2026.9 the first build let OpenClaw's own scaffold files win over Hatchabot's.
- **Fix:** upgrade; for an agent already made, paste the description into SOUL.md (or recreate it).
- **Fixed in:** `v2.112.1`
- **Code:** `src/orchestrator/provision.ts` — `replaceScaffold`

### `hatchabot doctor`: "N running agents are still on the shared network"
- **Check:** the doctor line.
- **Cause:** those agents were made before agents got their own isolated network, which applies at a rebuild.
- **Fix:** `hatchabot rebuild --outdated`, or wait: unless the rebuild policy is manual, the machine rebuilds each once it is idle.
- **Fixed in:** —
- **Code:** `src/doctor.ts` — `sharedNetwork`

### A detached or deleted Google account still works in an agent
- **Check:** in the agent, `gog auth list --json` still names the account after it was detached, or after its connection was deleted under ⚙ Settings → Connections; the trail may show `connection.remove_failed`.
- **Cause:** before v2.153.0, removing an account from an agent was fire-and-forget: a failed `gog auth remove` was logged as removed and its pending record cleared, and a detach while the agent was stopped saved no record, so deleting the connection afterwards lost the only note of the email. A connection sync running during a detach could also import the account again from a list read before it.
- **Fix:** upgrade. Removals are now recorded before anything is deleted and retried at every start, wake or rebuild until gog confirms the account is gone. On an older version, run `~/.local/bin/gog auth remove --force -- "<email>"` in the agent's shell; to cut access everywhere, also revoke the app at myaccount.google.com → Security → Third-party access.
- **Fixed in:** `v2.153.0`
- **Code:** `src/orchestrator/googleConnections.ts` — `dematerializeConnection`, `removeQueuedNow`, `syncConnections`

### An archived agent is still running (or a pooled bot answers as two agents)
- **Check:** the agent shows Archived but `docker ps` still lists its container, or a new agent leased from the pool gets replies from two gateways; its trail has `agent.archived` just after a Start or a wake.
- **Cause:** Start, Stop and wake did not hold the agent's lifecycle lock, so an Archive pressed during a Start or wake stopped the container and gave the bot back, and then the start brought the container up again. Telegram detach had the same gap.
- **Fix:** upgrade. Then stop the leftover container (`docker stop` on the archived agent's container) and Rebuild any agent that now shares that bot. A clashing request now gets "Another operation is already running on this agent."
- **Fixed in:** `v2.153.0`
- **Code:** `src/api/routes.ts` — `startStopped`, `startRefusal`; `src/orchestrator/hibernate.ts` — `wakeAgent`

### Agent-to-agent consults always fail with an unauthorized caller
- **Check:** the agent has peers, yet `/message` calls from it are refused; the stored `agent-call-token/<id>` secret does not match the live hash.
- **Cause:** the token's hash was saved before its secret; a failed write or two grants at once left them different, and nothing repaired it.
- **Fix:** upgrade, change the agent's peers once (that mints a fresh token), then rebuild it.
- **Fixed in:** `v2.153.0`
- **Code:** `src/api/routes.ts` — `ensureAgentCallToken`

### An agent's browser keeps disappearing, or a test install removed it
- **Check:** another Hatchabot (a second install, or a smoke test with its own `HATCHABOT_PREFIX`) uses the same Docker, and the Setup log shows "its browser removed".
- **Cause:** each install's sweep listed every browser on the daemon and removed those it didn't know.
- **Fix:** upgrade both installs; the sweep starts the browser again within a minute.
- **Fixed in:** `v2.153.0`
- **Code:** `src/providers/localDockerProvider.ts` — `listBrowsers`

### "its browser did not start" every minute for every agent
- **Check:** the Setup log repeats "browser image build failed".
- **Cause:** every sweep tried the build again for every agent, and slow builds overlapped.
- **Fix:** upgrade (one sweep per machine, with back-off), then fix what the build error names, such as disk space or network.
- **Fixed in:** `v2.153.0`
- **Code:** `src/orchestrator/browser.ts` — `browserSweep`

### `hbt import --no-telegram` brought the agent's bot back
- **Check:** the file was a full copy (a Download); the CLI said "restored".
- **Cause:** "no Telegram" applies only to templates and was silently ignored for full copies.
- **Fix:** a full copy always brings its bot. For a new agent with no bot, export a template and import that.
- **Fixed in:** `v2.153.0`
- **Code:** `src/api/routes.ts` — `'/v1/agents/import'`

### "New agent from a repo" says the name is taken after a failed first try
- **Check:** an agent with the app's name exists and is still being made or has failed, with no app installed (its App row is empty, or shows a pending install).
- **Cause:** the agent was created, a later step (model, account, install) failed, and the half-made agent kept the name.
- **Fix:** upgrade. Until then, delete the half-made agent and try again.
- **Fixed in:** `v2.153.0`
- **Code:** `web/index.html` — `appGo`

### A failed app install or update shows no test output
- **Check:** the error says the tests failed, but no output appears under it.
- **Cause:** `api()` dropped the server's `test.output`.
- **Fix:** upgrade, or run `hbt app status` / `hbt app update` on the machine to see the output.
- **Fixed in:** `v2.153.0`
- **Code:** `web/index.html` — `api`, `appGo`, `v2AppUpdate`

### A deleted agent reappears for a few seconds on the home screen
- **Check:** right after deleting or archiving, the tile comes back and then goes away again.
- **Cause:** two overlapping refreshes, with the older answer arriving last.
- **Fix:** upgrade. Otherwise it corrects itself on the next refresh.
- **Fixed in:** `v2.153.0`
- **Code:** `web/index.html` — `refresh`, `refreshNow`

### After a failed move ("couldn't import it: proxy timed out"), the agent runs on both machines
- **Check:** both servers list the agent RUNNING after a move that said "couldn't import it … Your agent is unchanged"; the error text is a proxy's timeout, not a Hatchabot reason; messages to the bot are answered twice, or the two copies alternate.
- **Cause:** the import's reply was a proxy's 408 or 499 timeout with a JSON `error` body. It was read as the other server refusing, so the source restarted without asking whether the import had finished.
- **Fix:** stop and delete one copy (usually the source). Upgrade so later moves ask the other server first.
- **Fixed in:** `v2.153.1`
- **Code:** `src/orchestrator/migrate.ts` — `isDefiniteRefusal`

### An agent can still use a Google account right after it was attached and detached
- **Check:** `gog auth list --json` in the agent still lists the account, but the agent's page shows no attachment and nothing is pending; an attach and a detach (or a delete) were done within a few seconds of each other.
- **Cause:** the detach or delete ran while the attach was still importing the account: the removal ran first and cleared its record, then the import put the credential back.
- **Fix:** upgrade. Then attach the account and detach it again, or rebuild the agent.
- **Fixed in:** `v2.153.1`
- **Code:** `src/orchestrator/googleConnections.ts` — `withConnectionLock`, `offAgainIfDetached`

### An app update failed with "Its tasks are as they were", but its scheduled task no longer runs
- **Check:** in the agent's console, `openclaw cron list` shows no job named `<app>-<task>` for the app, though its release is the previous one, and the update error mentioned "Could not take off the old task …" (often a timeout).
- **Cause:** a removal of the old task took effect, but its reply was lost or timed out. The rollback trusted the reply, so it never re-added the task, and still reported the tasks as unchanged.
- **Fix:** upgrade, then run **Update** again (or **Roll back**) so the tasks are synced again. From v2.153.1 the rollback checks the agent's actual jobs; if it can't confirm them, the error says "Its scheduled tasks could not be confirmed" and names what to check.
- **Fixed in:** `v2.153.1`
- **Code:** `src/orchestrator/apps.ts` — `syncTasks`

### A move to another Hatchabot "could not be confirmed"; the agent stays stopped and Start is refused
- **Check:** `GET /v1/operations?agentId=<id>` shows `kind: "migrate"`, `status: "held"`.
- **Cause:** the import's answer was lost (a restart, a dropped connection, a proxy timeout) and the other server hasn't said whether the agent arrived; starting this copy could leave two copies polling one bot.
- **Fix:** wait (it asks again every 10 minutes), or check the other server and choose "It is running on … — keep this copy stopped" or "It is not on … — keep it here".
- **Fixed in:** `v2.154.0`
- **Code:** `src/orchestrator/migrate.ts` — `resumeMigrate`, `recoverMigrate`

### After a restart, an agent you were importing is gone: "Import interrupted — import the file again"
- **Check:** the agent's operation is `kind: "import"`, `status: "rolled_back"`.
- **Cause:** the restart cut the import off before the agent was running; a half-imported agent is removed, never started.
- **Fix:** import the same file again.
- **Fixed in:** `v2.154.0`
- **Code:** `src/orchestrator/transfer.ts` — `resumeImport`, `rollbackImport`

### "I used the classic look — where is X?" (no card, no ⋯ menu, no jump legend)
- **Check:** the version is v2.155.0 or later, and the account menu has no "Classic look".
- **Cause:** v2.155.0 removed the classic card view; its controls moved into each agent's page.
- **Fix:** click the agent's icon. Settings → the page's tabs; Tasks → Schedule; Invite and members → Sharing; Clone, Share, Send, Proposals → Sharing → Copy or share; Sync name and Telegram Web → Telegram; Chat → Memory and Recover context → Personality → Memory; History → Data → History; Wake, Start, Retry, Restore → the bar at the top of the page; Rebuild, Group and order → Overview; Stop, Health and Logs → Overview → Checks; Move, Download copy, Archive and Delete → Advanced. Header items: Health (all) → Bulk actions → ❤️ Check all; Sources and the Jump legend → View by; Import and Templates → New. The one-time map on the home screen shows the same list.
- **Fixed in:** `v2.155.0`
- **Code:** `web/index.html` — `takeClassicChoice`, `v2DismissClassicMap`

### "Restoring … was interrupted by a restart part-way through its files"
- **Check:** a held `restore-snapshot` operation on the agent.
- **Cause:** a restart while a snapshot's core files were being written; some are the snapshot's and some are not.
- **Fix:** **Finish**, or **Revert to the copy taken before**. The agent must be running.
- **Fixed in:** `v2.155.0`
- **Code:** `src/orchestrator/snapshots.ts` — `resumeSnapshotRestore`

### An app's page waits for a choice: "The … change to … was interrupted by a restart part-way through the switch"
- **Check:** a held `app-install`, `app-update` or `app-rollback` operation; the agent's `apps/<app>/current` differs from the app record.
- **Cause:** a restart during or after the switch, before Hatchabot recorded it.
- **Fix:** **Use the new release** or **Go back to the previous one**; either leaves the release, its config, its scheduled tasks and the record in agreement.
- **Fixed in:** `v2.155.0`
- **Code:** `src/orchestrator/appOperations.ts` — `resumeAppOperation`, `recoverAppOperation`

### Alerts listed general alerts above failed agents, and people knocking near the bottom
- **Check:** View by → Alerts; the order of its sections.
- **Cause:** the view sorted its sections by label, so the emoji decided the order.
- **Fix:** upgrade; the sections sort most urgent first, with "Waiting for your choice" at the top.
- **Fixed in:** `v2.156.0`
- **Code:** `web/index.html` — `v2ViewKey`

## Memory and conversations

### After a quiet night the agent says it has no context ("this is a fresh session")
- **Check:** the session folder holds a `<uuid>.jsonl.reset.<time>` file; nothing was rebuilt.
- **Cause:** OpenClaw's idle reset started a new conversation after about a day without messages.
- **Fix:** upgrade and rebuild: the idle window is 30 days and the agent is told to read memory before claiming it has none. The old conversation is still on the volume.
- **Fixed in:** `v0.114.0`
- **Code:** `src/openclaw/configWriter.ts` — `idleMinutes`

### Something one person told an agent comes up in another person's chat with it
- **Check:** both people use the same agent.
- **Cause:** by design: an agent has one memory, loaded into every conversation. The old "Keep memory private" switch never made it private and was removed.
- **Fix:** for something private, give that person their own agent.
- **Fixed in:** —
- **Code:** `src/api/routes.ts` — `always shared with everyone who talks to it`

### A fresh install's first agent fails: "the memory search service is not turned on (Settings → Hosts)"
- **Check:** Settings → Hosts shows the memory search service off; the image is engine-free (every image since OpenClaw 2026.9).
- **Cause:** engine-free images need the machine's shared memory search service, and before v2.79.1 nothing turned it on for a new install.
- **Fix:** turn the service on in Settings → Hosts (`hatchabot embedder start`), then Retry. Newer releases turn an untouched service on for the owner (`embed.auto_started`); one the owner stopped stays stopped.
- **Fixed in:** `v2.79.1`
- **Code:** `src/api/routes.ts` — `is not turned on (Settings → Hosts)`; `src/orchestrator/eventLabels.ts` — `embed.auto_started`

### Memory search stops working for an agent after a stop and start, or after a failed rebuild (401 at the memory door)
- **Check:** the agent's memory search errors with 401; it was stopped and started without a rebuild, or a rebuild failed.
- **Cause:** the door's key file listed only running agents, and a rebuild replaced the key before the new container existed.
- **Fix:** upgrade; then rebuild the agent once.
- **Fixed in:** `v2.43.0`
- **Code:** `src/orchestrator/provision.ts` — `commitEmbedToken`

### The memory search engine is killed at its memory limit, and some agents come up without an index
- **Check:** Resources shows the engine (`-embedder`) at its cap; it happened while many agents were rebuilt or moved at once.
- **Cause:** a re-index storm grew the engine's memory; older releases also let it creep upward.
- **Fix:** upgrade; on a machine moving many agents, raise `HATCHABOT_EMBEDDER_MEMORY` (2g default) and run fewer rebuilds at once.
- **Fixed in:** `v2.60.2`
- **Code:** `src/providers/localDockerProvider.ts` — `MALLOC_ARENA_MAX`; `src/config/envCatalog.ts` — `HATCHABOT_EMBEDDER_MEMORY`

### Recover context started (or Share saved) although I pressed Cancel
- **Check:** after Cancel or Esc on the second question, the job started or the file was saved anyway.
- **Cause:** the second question was a `confirm()` whose Cancel meant "the other option".
- **Fix:** upgrade. The question now has its own Cancel.
- **Fixed in:** `v2.153.0`
- **Code:** `web/index.html` — `askChoice`, `recoverContext`, `shareTemplate`

## Console and web chat

### The console says "Control UI did not start"
- **Check:** the agent runs OpenClaw 2026.9; the page's script links start with `/assets/`.
- **Cause:** 2026.9 serves its page with root-absolute links, which pointed at Hatchabot's own root through the console proxy.
- **Fix:** upgrade; no rebuild needed.
- **Fixed in:** `v2.60.3`
- **Code:** `src/api/controlUiRebase.ts` — `data-openclaw-control-ui-base-path`

### The console sits on OpenClaw's "Approve this browser" screen
- **Check:** the agent runs OpenClaw 2026.8 or newer.
- **Cause:** those versions keep browser pairing requests in a database, not in `devices/pending.json`, and a missing file was read as "nobody waiting".
- **Fix:** upgrade.
- **Fixed in:** `v2.60.4`
- **Code:** `src/orchestrator/pairing.ts` — `device_pairing_pending`

### "OpenClaw's console needs a secure context — this tab is on plain http."
- **Check:** the app is open at `http://<address>:8080` from another device.
- **Cause:** the console's device identity uses WebCrypto, which browsers allow only over https or on localhost.
- **Fix:** open Hatchabot at its https address (with Tailscale: the setup guide's **Turn on HTTPS**), or at `http://localhost` on the machine itself.
- **Fixed in:** —
- **Code:** `web/index.html` — `isSecureContext`, `openGateway`

### Opening an agent's console: "The agent's gateway did not answer."
- **Check:** is the agent asleep, or on a runner?
- **Cause:** a sleeping agent's gateway is stopped (before v2.83.1 the console did not wake it); before v2.34.6 a runner agent's console was looked for on this machine.
- **Fix:** upgrade; the console now wakes a sleeper ("Waking it up — about a minute…") and reaches runner agents through the runner's SSH connection.
- **Fixed in:** `v2.83.1`
- **Code:** `src/api/routes.ts` — `The agent's gateway did not answer.`; `web/index.html` — `Waking it up`

### Adopting an OpenClaw agent stops at "This agent needs a bot", or the agent is greyed out in the list
- **Check:** the workspace has no Telegram bot of its own, and the bot pool is empty (or you would rather not use a bot slot).
- **Cause:** before v2.149.0 adopting always gave the agent a Telegram bot: its own, one from the pool, or a pasted token. The web console was not offered as the way to talk to it.
- **Fix:** upgrade, then adopt without Telegram: `hatchabot adopt <workspace> "<name>" --no-telegram`, or tick **No Telegram for now** in the web adopt flow. Talk to it from its icon; a bot can be attached later.
- **Fixed in:** `v2.149.0`
- **Code:** `src/cli.ts` — `--no-telegram`; `web/index.html` — `adoptWebChanged`

### A build fails: "The memory search service's port … is taken", or "embed door failed … port is already allocated"
- **Check:** `docker ps --format '{{.Names}} {{.Ports}}' | grep 8093` shows another Hatchabot's `…-embed-door` holding the port.
- **Cause:** two Hatchabots on one Docker (a second install, a test server) each start a memory search service on the same port, 8093 by default. From OpenClaw 2026.8 every agent needs that service.
- **Fix:** give the second one its own port: `HATCHABOT_EMBED_PORT=<another port>` in its `.env`, then restart it. Before v2.149.0 the message only said the door could not start.
- **Fixed in:** `v2.149.0`
- **Code:** `src/providers/localDockerProvider.ts` — `port is already allocated`

### Web chat: Send stays greyed out after switching to another agent
- **Check:** one agent's reply is still "…thinking", and in the other agent's chat Send is disabled.
- **Cause:** a single sending lock was shared by every agent.
- **Fix:** upgrade, or wait for the first reply. A reply that arrived after you switched is in that agent's chat when you reopen it.
- **Fixed in:** `v2.153.0`
- **Code:** `web/index.html` — `webChatSend`, `openWebChatPanel`

## Runners

### A runner agent's tile: "Its machine isn't answering — it may be asleep or offline"
- **Check:** Resources lists the runner as not answering; `ssh <user>@<runner> docker version`.
- **Cause:** the runner (often a laptop) is asleep, off or off the network. Older releases showed `{"error":"No debug gateway for this agent."}` or hung on "Loading…".
- **Fix:** wake the runner. Its agents come back by themselves; nothing is marked failed.
- **Fixed in:** `v2.123.0`
- **Code:** `src/providers/localDockerProvider.ts` — `isn't answering`; `src/api/routes.ts` — `No debug gateway`

### The runner works from your terminal but the app says it is unreachable
- **Check:** `env -i HOME=$HOME docker -H ssh://<user>@<runner> version` on the Hatchabot machine.
- **Cause:** your shell has an ssh-agent (or a PATH) the service does not; on a Mac the runner's non-interactive PATH often lacks Docker.
- **Fix:** re-run the runner setup snippet (it writes a managed `~/.ssh/config` block with `IdentitiesOnly`); check no older hand-made `Host` block shadows it. See docs/runner-setup.md.
- **Fixed in:** —
- **Code:** `src/orchestrator/runnerSetup.ts` — `IdentitiesOnly`

### Moving an agent to a runner fails with "pull access denied for hatchabot-runtime"
- **Check:** the agent is pinned to an image the runner does not have.
- **Cause:** before v2.33.3 the move found out only after stopping the agent.
- **Fix:** upgrade: the move checks first and offers to move on the runner's default image (its extra packages are then missing). Or install the image on the runner.
- **Fixed in:** `v2.33.3`
- **Code:** `src/api/routes.ts` — `dropPin`

### A runner agent cannot move to OpenClaw 2026.8 or newer, or a current agent cannot move to a runner: "has no embedding engine and the shared service is unavailable: it runs on a runner"
- **Check:** the error names a runner; or the agent's engine row says "built on its own engine — it runs on a runner"; Settings → Hosts → Check on the runner shows an older OpenClaw than this machine.
- **Cause:** from OpenClaw 2026.8 an image carries no memory search engine of its own, and before v2.147.0 the one memory search service was on the main machine, out of a runner's reach. Runner agents stayed on 2026.7 images, and no 2026.8+ agent could be built on a runner. The move check across the 2026.8 line was also inverted (it refused moving up and let a move down through).
- **Fix:** upgrade. Each runner runs its own memory search service, which starts with the first agent built there (or Settings → Hosts → the runner's Memory search → Start; `hatchabot embedder start --host <runner>`). To move a runner agent to the current OpenClaw: Settings → Hosts → Check on the runner → **Update image** (a few minutes), then rebuild the agent. The first build there copies the model over, which takes a minute or two.
- **Fixed in:** `v2.147.0`
- **Code:** `src/api/routes.ts` — `embedderFor`; `src/providers/localDockerProvider.ts` — `pushEmbedKeys`; `src/openclaw/configWriter.ts` — `moveCrossesDown`

### Install image fails after 15 minutes: "Timed out copying the image to the runner", or the button says it failed while the copy goes on
- **Check:** Tailscale relays instead of connecting directly (`tailscale ping <runner>` says "via DERP"); the image is over 2 GB (`docker image ls hatchabot-runtime`).
- **Cause:** before v2.147.1 the copy was one web request with a fixed 15-minute limit, and it was sent uncompressed. A relayed link moves 2 GB more slowly than that, and a browser or proxy can drop a request held open that long while the copy carries on.
- **Fix:** upgrade. The copy is compressed and runs in the background; the runner's row shows how far it has come. It is stopped only when nothing has moved for 3 minutes. A direct Tailscale connection (both machines on the same network, or UDP allowed) is much faster.
- **Fixed in:** `v2.147.1`
- **Code:** `src/orchestrator/runnerSetup.ts` — `installRuntimeImage`, `stallMs`; `web/index.html` — `followImageCopy`

### A runner's agents run, but Check says "runtime image missing" (a rebuild there would fail)
- **Check:** `docker -H <runner> image inspect hatchabot-runtime:latest` fails, while `docker -H <runner> ps` shows the agents' containers on an image with no such tag.
- **Cause:** something on the runner moved or removed the `hatchabot-runtime:latest` tag. A known way: installing Hatchabot itself on the runner's Docker and uninstalling it again. The install points `:latest` at its own image, and the uninstall removes that tag as its own.
- **Fix:** Settings → Hosts → Check → **Install image**. Or put back the tag the agents were built on: `docker -H <runner> tag <their image id> hatchabot-runtime:latest`. Don't install a second Hatchabot on a machine that is already a runner.
- **Fixed in:** —
- **Code:** `scripts/uninstall.sh` — `keeping $img`; `src/providers/resolveProvider.ts` — `pingRunner`

### A runner agent shows as running although its container stopped or is gone
- **Check:** `docker ps -a` on the runner against the app's state.
- **Cause:** the two-minute health sweep looked providers up by name and skipped every runner agent.
- **Fix:** upgrade.
- **Fixed in:** `v2.134.0`
- **Code:** `src/orchestrator/reconcile.ts` — `Providers`

### After "Move to another Hatchabot" failed with a gateway or server error (502, 503, 504), the agent runs on both machines, or two agents answer on one bot
- **Check:** the move's error named an HTTP status such as "Gateway Timeout" and said "Your agent is unchanged", yet the other Hatchabot lists the agent RUNNING, and this one runs it too.
- **Cause:** before v2.152.0 any error answer to the other Hatchabot's import was taken as proof it had rolled back, and the agent was restarted here at once. A proxy in front of it answers 502/503/504 when a long import outlasts its timeout, while the import goes on to finish and poll the same Telegram bot.
- **Fix:** stop one of the two copies now (keep the one that is healthy there, then delete this one), and upgrade. Since v2.152.0 only a refusal from Hatchabot itself restarts the agent here; any other failure asks the other Hatchabot first: restarted only when the agent is confirmed absent there, left stopped and marked moved when it arrived, and left stopped with "couldn't confirm whether the agent arrived" otherwise.
- **Fixed in:** `v2.152.0`
- **Code:** `src/orchestrator/migrate.ts` — `isDefiniteRefusal`, `migrateAgent`

### "The agent runtime is missing — tap Retry to rebuild it." right after a move to another machine
- **Check:** the agent was just moved, its container runs on the new machine, but it shows failed with that message; its trail has `reconcile.runtime_missing` just after the move finished.
- **Cause:** a reconcile sweep asked the old machine for the agent's status, and the move finished while that question was pending; the old machine's "not here" was taken as current.
- **Fix:** upgrade. On an older version the agent is fine on its new machine: Retry or Rebuild clears it.
- **Fixed in:** `v2.153.0`
- **Code:** `src/orchestrator/reconcile.ts` — `reconcileAgents`

### A move or snapshot "succeeded" but the agent's memory is empty
- **Check:** the agent's volume on the machine it was exported from does not exist (`docker volume inspect <slug>-vol`).
- **Cause:** exporting a missing volume created an empty one and copied that.
- **Fix:** upgrade; restore from a snapshot or backup.
- **Fixed in:** `v2.153.0`
- **Code:** `src/providers/localDockerProvider.ts` — `exportState`; `src/orchestrator/moveHost.ts` — `moveInner`

### Memory search returns 401 for an agent after a failed move
- **Check:** the move said "rolled back", and the agent's recall or memory index fails with 401 from the memory search door.
- **Cause:** the move made keys for the target machine, and the rollback restarted the source container with its old key, which the source's door no longer listed.
- **Fix:** upgrade; until then, rebuild the agent.
- **Fixed in:** `v2.153.0`
- **Code:** `src/orchestrator/moveHost.ts` — `moveAgentToHost`

### Agents built on a runner die with "exec format error" after Install image
- **Check:** `docker info --format '{{.Architecture}}'` differs between this machine and the runner.
- **Cause:** Install image copied this machine's image, built for its own CPU, to a runner with a different CPU.
- **Fix:** upgrade and run Install image again; the runner pulls the published multi-arch image. If no image is published for that version, update OpenClaw to a released version first.
- **Fixed in:** `v2.153.0`
- **Code:** `src/orchestrator/runnerSetup.ts` — `installRuntimeImage`

### Install image fails with "The copy stopped moving" near the end
- **Check:** the progress had reached about the full size before the failure.
- **Cause:** the 3-minute stall timer kept running while the runner unpacked the last layers after the send ended.
- **Fix:** upgrade, then Install image again.
- **Fixed in:** `v2.153.0`
- **Code:** `src/orchestrator/runnerSetup.ts` — `installRuntimeImage`

### After removing a runner, its containers are still running on it
- **Check:** `docker ps` on that machine shows `<prefix>-embedder`, `<prefix>-embed-door` or `…-browser`.
- **Cause:** before this fix, removing a runner only deleted its record. Now it cleans up when the runner answers, and warns when it can't.
- **Fix:** on that machine, `docker rm -f` those containers, then `docker volume rm <prefix>-embed-model <prefix>-embed-keys` and `docker network rm <prefix>-embed`.
- **Fixed in:** `v2.153.0`
- **Code:** `src/api/routes.ts` — `'/v1/hosts/:id'`

### Runner agents can't reach the embedding server set in HATCHABOT_EMBED_URL
- **Check:** `HATCHABOT_EMBED_URL` is set and memory search fails only on runner agents.
- **Cause:** runner agents were handed this machine's external server address.
- **Fix:** upgrade and rebuild them; they use the runner's own service.
- **Fixed in:** `v2.153.0`
- **Code:** `src/api/routes.ts` — `embedderForProvision`

### Start says "… was interrupted, and … isn't answering. Choose what to do on its page first (Alerts)."
- **Check:** the agent is under Alerts with ⏸; `GET /v1/operations?agentId=<id>` shows an operation with `status: "held"`.
- **Cause:** a move to another machine was cut off by a restart after the agent was recorded on the target, and the target didn't answer when Hatchabot came back. It won't guess with a machine it can't see.
- **Fix:** bring the other machine back and press "Try again when … is back", or press "Put it back on …" (refused while the copy there may already be running).
- **Fixed in:** `v2.154.0`
- **Code:** `src/orchestrator/moveHost.ts` — `resumeMoveHost`, `recoverMoveHost`

### An agent's Setup log says "moved to another host" instead of the machine's name
- **Check:** the `agent.moved` event has `to` but no `toName`.
- **Cause:** the label read `toHost`, which the event never carried.
- **Fix:** upgrade; moves made from v2.154.0 on name the machine. Older lines still say "another host".
- **Fixed in:** `v2.154.0`
- **Code:** `src/orchestrator/eventLabels.ts` — `eventLabel`

### A runner's image copy shows "interrupted by a restart"
- **Check:** `GET /v1/hosts/<id>/install-image` returns `interrupted: true`.
- **Cause:** Hatchabot restarted while copying the image; the copy's processes ended with it.
- **Fix:** click **Install image** (or **Update image**) on the runner's row again; copying is repeatable.
- **Fixed in:** `v2.155.0`
- **Code:** `src/orchestrator/operationsResume.ts` — `resumeOperations`

### `hatchabot move`/`rehost`/`restore` (or the page) says the move started, then nothing seems to happen
- **Check:** `hatchabot ops <agent>` (or the agent's tile and Working on line) shows it running with step n of m; `GET /v1/operations/<id>`.
- **Cause:** since v2.156.0 these run on the server in the background; the request answers as soon as the operation begins.
- **Fix:** wait and watch it there; one that waits for you needs `hatchabot ops recover <op-id> <action>` or the button under Alerts. Scripts that need the old blocking answer add `?wait=1`.
- **Fixed in:** `v2.156.0`
- **Code:** `src/orchestrator/operations.ts` — `runInBackground`

## Backups and restore

### `hatchabot doctor`: "No backup set in … yet", "Last backup set is N days old", or "… is incomplete"
- **Check:** `journalctl --user -u hatchabot-backup -n 30` (macOS: the backup job's log); the set's own record names failed volumes.
- **Cause:** the nightly job did not run or failed. A known case: a backup unit without `EnvironmentFile=` looks for the database in the wrong place after the data directory moved.
- **Fix:** re-render the units with `./scripts/install-service.sh`, run `systemctl --user start hatchabot-backup` once, and check a new set appears. `scripts/restore-drill.sh` proves a set restores.
- **Fixed in:** —
- **Code:** `src/doctor.ts` — `readSetStatus`; `deploy/hatchabot-backup.service` — `EnvironmentFile`

### The backup alert says an agent is "not in it", naming a runner
- **Check:** the backup set's record lists it under `skipped`.
- **Cause:** before v2.133.0 only this machine's volumes were backed up. Now a runner that does not answer is skipped and named.
- **Fix:** upgrade; keep the runner awake at backup time (03:30) or accept the skip.
- **Fixed in:** `v2.133.0`
- **Code:** `src/orchestrator/backups.ts` — `agentsMissingFromSet`; `scripts/backup-volumes.sh` — `skipped_list`

### After restoring an agent from a nightly backup, removed people are back in, or its old bot runs on two agents
- **Check:** the restore restored the whole volume (a release before v2.105.0).
- **Cause:** the backup carries the agent's settings of that night.
- **Fix:** upgrade: a restore now takes memory and files from the backup and puts back the current bot, members and model. To bring someone back, add them again.
- **Fixed in:** `v2.105.0`
- **Code:** `src/orchestrator/backups.ts` — `restoreAgentFromBackup`, `revokedScrubTargets`

### A backup set says incomplete: an agent's volume is missing
- **Check:** the newest set's `backup-status.json` lists the volume under `missing` (and in `failedVolumes`), and the run's log says an agent on this machine uses it but Docker has no volume by that name; `docker volume ls` does not show it.
- **Cause:** an agent on this machine has no Docker volume under its expected name: removed by hand, or `HATCHABOT_PREFIX` differs from the one the volumes were made with. Before v2.152.0 such a run reported complete and pruned that agent's older backup sets.
- **Fix:** find the volume (`docker volume ls`) and correct `HATCHABOT_PREFIX` in `.env`; if it is gone, restore the agent from its newest backup set (nothing prunes while the volume is missing) or delete the agent; then run `scripts/backup-volumes.sh` again. An agent whose first start failed (no volume) is noted, not counted.
- **Fixed in:** `v2.152.0`
- **Code:** `scripts/backup-volumes.sh` — `missing_list`

### Backups stop with "no hatchabot-* volumes found" when every agent is on a runner
- **Check:** all agents live on runners, this machine has no `hatchabot-*` volumes, and the nightly run stops with "HATCHABOT_PREFIX mismatch? — refusing to prune"; no runner archives are in the set.
- **Cause:** before v2.152.0 the script counted every agent, runner agents included, when this machine had none of their volumes, and stopped before backing up the runners.
- **Fix:** upgrade: runner agents are archived over their connections; a runner that is asleep is skipped and named in `skipped`.
- **Fixed in:** `v2.152.0`
- **Code:** `scripts/backup-volumes.sh` — `registry`

### "Restore failed … and putting it back as it was failed too": agent marked failed after a backup restore
- **Check:** the agent shows failed with "A restore from the YYYY-MM-DD backup failed and could not be undone…"; the log shows `restore.left_failed`; a file `restore-safety/<container>-vol-before-restore-<time>.tgz` exists in the backups folder.
- **Cause:** a restore overwrote the agent's volume, then failed, and putting back the copy taken just before also failed (usually a full disk). Before v2.153.0 the agent was restarted on the half-written volume and the message said "left as it was".
- **Fix:** free disk space (`df -h`, `docker system df`). Then restore a backup again from Settings → Backups (allowed on a failed agent), or put the kept copy back by hand while the agent is stopped: `docker run --rm -i -v <container>-vol:/vol alpine sh -c 'find /vol -mindepth 1 -delete && tar xz -C /vol && chown -R 1000:1000 /vol' < <kept file>`. Then tap Retry. Keep the `restore-safety` file until the agent works; Hatchabot never deletes it.
- **Fixed in:** `v2.153.0`
- **Code:** `src/orchestrator/backups.ts` — `restoreAgentFromBackup`, `restoreSafetyDir`

### A backup set says incomplete: a runner agent's volume failed or is missing
- **Check:** the set's `backup-status.json` lists the volume in `failedVolumes` (and in `missing` if the runner has no volume by that name); the run's log says "on <runner> failed (exit N)" or "that runner has no volume by that name".
- **Cause:** the runner answered but its archive failed (tar error, torn gzip, no `alpine` image), or the agent's volume is not on that runner. Before v2.153.0 the first was recorded as skipped and the set said complete; the second made an empty archive and an empty volume on the runner.
- **Fix:** check the runner (`docker -H <host> volume ls`, `docker -H <host> pull alpine`), then run `scripts/backup-volumes.sh` again. If the volume is gone, restore the agent from its newest set (nothing is pruned while it is missing).
- **Fixed in:** `v2.153.0`
- **Code:** `scripts/backup-volumes.sh` — `failed_list`, `missing_list`

### An old backup set is still there past the retention ("kept <date> past N days")
- **Check:** the run's log says "kept <date> past N days: the newest copy of <volume>"; that agent's runner was skipped (asleep) in the newer sets.
- **Cause:** since v2.153.0 a set is kept while it holds the newest copy of an active agent's volume. Before that, an agent on a runner that was always asleep at backup time lost every backup once the sets aged out.
- **Fix:** keep the runner awake at 03:30 (or run a backup while it is up). The old set goes once a newer set holds that agent.
- **Fixed in:** `v2.153.0`
- **Code:** `scripts/backup-volumes.sh` — `newer_vols`

### A backup run stops with "Another backup run (pid N) is writing …"
- **Check:** `ps -p N`; `<backup dir>/<today>/.backup-lock/pid`.
- **Cause:** the nightly run and "Back up now" (or two installs sharing one backups folder) ran at once. Before v2.153.0 both wrote the same files.
- **Fix:** wait for the other run to finish; its record says how it went. A lock left by a killed run is taken over by the next run. Give each install its own `HATCHABOT_BACKUP_DIR`.
- **Fixed in:** `v2.153.0`
- **Code:** `scripts/backup-volumes.sh` — `release_lock`

### Others lost access to a shared backups folder (NAS) after a backup run
- **Check:** `ls -ld "$HATCHABOT_BACKUP_DIR"` shows `drwx------` on a folder others use.
- **Cause:** before v2.153.0 every run chmod'ed the base folder to 700.
- **Fix:** upgrade, then put the folder's mode back (e.g. `chmod 755`). Each dated set stays 700.
- **Fixed in:** `v2.153.0`
- **Code:** `scripts/backup-volumes.sh` — `BASE`

### A restore rolled an agent that lives on a runner back to the day it moved
- **Check:** this machine still has a `hatchabot-<agent>-vol` volume although the agent lives on a runner; backup sets from before v2.153.0 hold that copy under the agent's name.
- **Cause:** a move whose clean-up failed left the old volume here, and the nightly run archived it under the agent's name.
- **Fix:** upgrade; the run now names it as a leftover ("its agent lives on another machine now"). Remove it after a look (`docker volume rm <name>`); restore from a set taken on v2.153.0 or later.
- **Fixed in:** `v2.153.0`
- **Code:** `scripts/backup-volumes.sh` — `orphans`

### `restore-drill.sh` fails with only "find: … No such file or directory", or passes on a partial set
- **Check:** `ls "$HATCHABOT_BACKUP_DIR"`; the newest set's `backup-status.json` state.
- **Cause:** before v2.153.0 the drill ran find on a missing folder under pipefail, and drilled the newest set even when its run was incomplete.
- **Fix:** upgrade; it now says there is no backups folder, and drills the newest complete set, naming those it passes over.
- **Fixed in:** `v2.153.0`
- **Code:** `scripts/restore-drill.sh` — `set_state`

### Agent stopped after a restart: "The restore from the … backup was interrupted by a restart"
- **Check:** the agent's page or Alerts shows a held "Restore from a backup"; `GET /v1/operations?agentId=…` returns status `held`, kind `restore-backup`.
- **Cause:** Hatchabot restarted (an upgrade, a crash, a reboot) after the copy of how the agent was had been saved but before the restore finished, so its memory may be half-restored.
- **Fix:** choose **Finish the restore** (that night's copy, with today's members and bot) or **Put back the copy from before**. The copy stays in `restore-safety/` beside the backups until you choose.
- **Fixed in:** `v2.155.0`
- **Code:** `src/orchestrator/backups.ts` — `resumeBackupRestore`, `recoverBackupRestore`

## Usage, costs and budgets

### Usage shows small, flat token numbers for an agent that is busy all day
- **Check:** a release before v2.100.0.
- **Cause:** OpenClaw's `totalTokens` is the size of the last call's context, not a running total.
- **Fix:** upgrade: tokens are summed call by call from each agent's transcripts; the last 8 days are filled in at the first reading.
- **Fixed in:** `v2.100.0`
- **Code:** `src/orchestrator/usage.ts` — `USAGE_READER_SCRIPT`

### Telegram: "⚠️ Hatchabot: "<agent>" used N tokens in the last 24 hours"
- **Check:** the agent's Usage tab by the hour; `get_token_health` for its context size and scheduled tasks.
- **Cause:** a spike warning: the last 24 hours against its usual day. The usual causes are a frequent scheduled task, a very large conversation, or two agents consulting each other.
- **Fix:** slow or pause the task, compact the conversation (or set a context cap), or set a budget. Clear the warning in Usage.
- **Fixed in:** —
- **Code:** `src/orchestrator/usageAlerts.ts` — `usageSpikeText`

### An agent's tile: "Paused — its monthly budget is used up"
- **Check:** the agent's Usage tab → Monthly budget, or Settings → AI sources → Budgets.
- **Cause:** its budget (or the machine's) was set to pause at the limit.
- **Fix:** raise the budget, or start the agent by hand (it then runs until the 1st). It starts again on its own on the 1st.
- **Fixed in:** —
- **Code:** `src/orchestrator/budgets.ts` — `WARN_AT`; `web/index.html` — `monthly budget is used up`

## Scheduled tasks

### A scheduled task runs "ok" every day but its result reaches nobody
- **Check:** the agent runs OpenClaw 2026.9; the task's delivery names no chat or recipient ("Refusing implicit isolated cron delivery" in the gateway log).
- **Cause:** 2026.9 refuses to deliver a result that names no chat.
- **Fix:** upgrade: new tasks name the owner's chat, and older ones are pointed at it after each start.
- **Fixed in:** `v2.109.0`
- **Code:** `src/orchestrator/crons.ts` — `implicit isolated cron delivery`

### Every run of a task on an agent with no chat app fails: "Channel is required (no configured channels detected)"
- **Check:** the agent has no Telegram, Discord or Slack.
- **Cause:** the task did its work, then tried to deliver to a channel that does not exist.
- **Fix:** upgrade and re-create the task (older tasks keep their old setting). Read results with `hatchabot tasks <agent> runs`; on OpenClaw 2026.9 they also land in the agent's console conversation.
- **Fixed in:** `v2.33.1`
- **Code:** `src/orchestrator/crons.ts` — `--no-deliver`

## Tailscale and public access

### The https address the setup guide gave does not open
- **Check:** `curl <the https address>/healthz`; Tailscale admin console → DNS → HTTPS certificates.
- **Cause:** HTTPS certificates were never enabled for the tailnet, a certificate is still being issued, or the Mac App Store build of Tailscale is in use.
- **Fix:** enable HTTPS certificates in the Tailscale admin console, wait a minute, run **Turn on HTTPS** again. Newer releases check the address answers before saying so.
- **Fixed in:** `v2.26.0`
- **Code:** `src/ops/tailnet.ts` — `healthz`, `tailnetInfo`

### Invite links and the install QR code point at `localhost`
- **Check:** `hatchabot doctor` prints "HATCHABOT_PUBLIC_URL not set — invite links and OAuth redirects use localhost".
- **Cause:** no public address is set and none could be found on a tailnet.
- **Fix:** set `HATCHABOT_PUBLIC_URL` to the address others use (with Tailscale: the machine's https tailnet address), or the setup guide's **Use this address for links**, then restart.
- **Fixed in:** `v2.27.0`
- **Code:** `src/doctor.ts` — `HATCHABOT_PUBLIC_URL`

### `hatchabot doctor`: "Tailscale Funnel publishes the PRIVATE port to the internet"
- **Check:** `tailscale funnel status`.
- **Cause:** someone ran `tailscale funnel` on the app's own port, putting it on the internet with none of the public safeguards.
- **Fix:** `tailscale funnel reset`; for a public address use `hatchabot reach on`, which serves a separate, guarded listener.
- **Fixed in:** —
- **Code:** `src/doctor.ts` — `funnel reset`

### `hatchabot doctor`: "Public access is ON …, but N safeguards are off: the public address answers 503"
- **Check:** the doctor lists each safeguard with ✓/✗ under that line.
- **Cause:** public access refuses to serve until every safeguard holds (second factor for admins, automatic upgrades, invited-only, and the rest).
- **Fix:** fix each ✗ line as it says, or `hatchabot reach off`.
- **Fixed in:** —
- **Code:** `src/doctor.ts` — `publicAccessLines`; `src/api/safeguards.ts` — `evaluateSafeguards`

### At the public address, Download / Import / Share a copy / Upload fails with "second factor required"
- **Check:** the page is opened at the public address, and the toast or upload note says "second factor required" (an HTTP 401 with `secondFactor: "step-up"`).
- **Cause:** these file transfers used plain `fetch()`, which skipped the second-factor prompt that every other action shows.
- **Fix:** upgrade. Until then, do these from the private address, or do any other sensitive action first (it asks for the factor, which then counts for 10 minutes).
- **Fixed in:** `v2.153.0`
- **Code:** `web/index.html` — `sfFetch`, `sfLink`

## The Hatchabot agent

### The Hatchabot agent reports "LLM request failed: network connection error" right after it starts
- **Check:** the server log shows `ops.peer_refused` for its own doorman; common on Docker Desktop (Mac).
- **Cause:** its tools and AI pass through its doorman, and the door refused the doorman's address (Docker Desktop forwards from another address; a rebuilt doorman got a new one).
- **Fix:** upgrade, then rebuild the Hatchabot agent.
- **Fixed in:** `v2.21.0`
- **Code:** `src/ops/opsServer.ts` — `ops.peer_refused`; `src/ops/doorman.ts` — `doormanRoutes`

### "Your Hatchabot agent did not answer: …"
- **Check:** the reason after the colon: it is mid-turn already, the AI source is rate-limited, or the turn ran long.
- **Cause:** the agent's own turn failed or is busy.
- **Fix:** wait for its current turn; if the source is limited, see "Several agents on one AI source stop answering".
- **Fixed in:** `v2.15.3`
- **Code:** `src/api/routes.ts` — `Your Hatchabot agent did not answer`

### "The Hatchabot agent can't use a local model"
- **Check:** the source chosen for it is a local model.
- **Cause:** by design: its locked-down network reaches only internet AI services.
- **Fix:** pick a Claude, OpenAI or Gemini source for it.
- **Fixed in:** —
- **Code:** `src/api/routes.ts` — `OPS_NO_LOCAL`

## Docker, disk and memory

### `hatchabot doctor`: "Only N GB free — each agent volume grows; the image is ~2 GB"
- **Check:** `df -h` on the disk holding Docker and the backups.
- **Cause:** agent volumes, runtime images and nightly backup sets fill the disk.
- **Fix:** `docker system prune`; remove old backup sets; move backups to a NAS (`HATCHABOT_BACKUP_DIR`).
- **Fixed in:** —
- **Code:** `src/doctor.ts` — `diskFreeGb`

### `hatchabot doctor`: "Limits check …: N agents' swap limits had drifted (systemd reload) and were restored"
- **Check:** the doctor line; if it says "could NOT be restored", `hatchabot events <agent>` shows `runtime.swap_reassert_failed`.
- **Cause:** a systemd reload (a snap refresh, a package upgrade) resets a container's swap limit behind Docker's back.
- **Fix:** nothing when restored: the app checks every ten minutes. When it could not be restored, rebuild that agent.
- **Fixed in:** —
- **Code:** `src/doctor.ts` — `limitsCheckLine`

### The control plane stops by itself while an agent is stopped, restarting, or on a machine that is down
- **Check:** the service log ends with an uncaught stack overflow; it restarts and runs again.
- **Cause:** a call to a gateway that could not connect closed its socket in a loop until the stack ran out.
- **Fix:** upgrade.
- **Fixed in:** `v2.132.3`
- **Code:** `src/orchestrator/consoleAccess.ts` — `gatewayCallAs`, `settled`
