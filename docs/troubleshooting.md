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

## Sign-in and accounts

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

## AI sources and Claude login

### An agent answers "Your model provider needs a new login" or "Not logged in · Please run /login", while the same source works for other agents
- **Check:** the agent's Setup log has `runtime.pins_cleared` after the fix, or, inside the container, `openclaw gateway call sessions.list` shows its sessions pinned to the `claude-cli` runtime.
- **Cause:** OpenClaw pins a runtime per conversation. Agents that once ran through the Claude Code CLI kept that pin after switching to a setup token, and the CLI has no login in the container.
- **Fix:** upgrade, then start or rebuild the agent: pins to runtimes its settings no longer name are cleared at rebuild, start, wake and boot. Do not replace tokens first.
- **Fixed in:** `v2.86.1`
- **Code:** `src/orchestrator/runtimePins.ts` — `clearStaleRuntimePins`; `src/orchestrator/eventLabels.ts` — `runtime.pins_cleared`

### Every message fails with "LLM request failed (request format rejected, HTTP 400)" after switching to a newer Claude model
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
- **Cause:** the agent needs a bot and none is available in the pool.
- **Fix:** paste a token from @BotFather, or choose **Continue without Telegram** (`hatchabot skip-telegram <agent>`); a bot can be attached later.
- **Fixed in:** `v2.44.1`
- **Code:** `src/cli.ts` — `skip-telegram`

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

## Agents, builds and rebuilds

### A rebuild or setup fails with `seed failed at "<step>": …`
- **Check:** the agent's Setup log (`rebuild.failed` / `provision.failed`) names the step, then the tail of stderr and stdout.
- **Cause:** one step of the workspace seed failed; the step named is the cause (older releases printed the last output of an earlier, optional step instead, such as "Plugin llama-cpp is not associated with a tracked package install").
- **Fix:** read the named step's output; Retry/Rebuild after fixing its cause. A first Discord attach on OpenClaw 2026.9 failed this way before v2.72.3: upgrade.
- **Fixed in:** `v2.72.3`
- **Code:** `src/providers/localDockerProvider.ts` — `SEED_STEP_MARK`, `seedFailure`

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

### A runner agent shows as running although its container stopped or is gone
- **Check:** `docker ps -a` on the runner against the app's state.
- **Cause:** the two-minute health sweep looked providers up by name and skipped every runner agent.
- **Fix:** upgrade.
- **Fixed in:** `v2.134.0`
- **Code:** `src/orchestrator/reconcile.ts` — `Providers`

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
